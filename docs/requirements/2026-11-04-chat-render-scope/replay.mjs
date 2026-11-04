// Offline routing experiment. Live CI never loads these historical boundaries.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { determineScope, verifiedBaseline } from '../../../scripts/ci-scope.mjs';

const samples = [[497,'b56e277e'],[495,'e866a044'],[493,'60882de7'],[486,'54c104fb'],[481,'bd251525'],
  [470,'1198ca0c'],[465,'c1b3a9a2'],[461,'e1dec75e'],[464,'6198839a'],[454,'b784f5a4'],
  [401,'42598c27'],[393,'1492ec87'],[388,'c3fa0761']];

// Partition source bytes identically on both sides of every merge. Unmatched
// code stays in its original file, including the body that mutates reply state.
const boundaries = {
  'src/app.ts': [
    ['src/lib/chat-composer-render.ts', /(?<=^      this\.composerDraftVersion \+= 1;\n)(?:^      [^\n]*\n)+?(?=^      this\.uiPreferences\.composerDraft = textarea\.value;)/m],
    ['src/lib/chat-composer-render.ts', /^      if \((?:replyTarget && )?this\.replyTarget === replyTarget\) \{(?=\n        this\.replyTarget = null;\n        this\.renderReplyDraft\(\);)/m],
    ['src/lib/chat-timeline-days.ts', /^      const appendDate = \(sentAt: string\) => \{\n[\s\S]*?^      \};/m],
  ],
  'src/lib/message-date.ts': [['src/lib/chat-timeline-days.ts', /^export function messageLocalDay\([^\n]*\{\n[\s\S]*?^\}/m]],
  'src/lib/chat-visuals.ts': [['src/lib/chat-bubble-gradient.ts', /^export function syncChatBubbleGradient\([^\n]*\{\n[\s\S]*?^\}/m]],
  'tests/mobile-settings-chat-fixes.e2e.mjs': [['tests/helpers/chat-render-gradient.mjs',
    /^  const gradient=await page\.evaluate\(\(\)=>\{\n[\s\S]*?^  await page\.evaluate\(\(\)=>fixture\.app\.chatViewportMotion\.suspend\(\)\);/m]],
};
const scratch = mkdtempSync(path.join(tmpdir(), 'quiet-room-chat-render-replay-'));
const read = (args, options) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
try {
  const objects = read(['rev-parse','--path-format=absolute','--git-path','objects']).trim();
  read(['init','-q','--bare',scratch]);
  const env = { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
  const git = (args, input) => read(['--git-dir',scratch,...args], { env, input });
  const project = (revision, parent, records) => {
    git(['read-tree',revision]);
    const blobs = new Map();
    const listing = git(['ls-tree','-z',revision,'--',...Object.keys(boundaries),...records]);
    for (const entry of listing.split('\0').filter(Boolean)) {
      const match = /^100644 blob (\w+)\t(.+)$/.exec(entry);
      if (!match) continue;
      const [, hash, file] = match;
      let source = git(['cat-file','blob',hash]);
      for (const [destination, span] of boundaries[file] ?? []) {
        source = source.replace(span, block => {
          blobs.set(destination, (blobs.get(destination) ?? '') + block + '\n');
          return '/* moved to ' + destination + ' */';
        });
      }
      if (records.includes(file)) source += '\n回归专项：chat-render\n';
      blobs.set(file, source);
    }
    for (const [file, content] of blobs) {
      const blob = git(['hash-object','-w','--stdin'], content).trim();
      git(['update-index','--add','--cacheinfo','100644',blob,file]);
    }
    const tree = git(['write-tree']).trim();
    return git(['-c','user.name=Replay','-c','user.email=replay@localhost','commit-tree',tree,
      ...(parent ? ['-p',parent] : []),'-m','Temporary path projection']).trim();
  };
  const classify = (base, head) => {
    git(['update-ref','HEAD',head]);
    return determineScope({ eventName: 'pull_request', runGit: git,
      event: { pull_request: { base: { sha: base }, head: { sha: head } } } });
  };
  const eligible = [];
  for (const [number, ref] of samples) {
    const head = git(['rev-parse',ref]).trim();
    const base = git(['rev-parse',head + '^1']).trim();
    const raw = classify(base, head);
    const records = git(['diff','--name-only',base,head]).split('\n')
      .filter(file => /^docs\/requirements\/[^/]+\/README\.md$/.test(file));
    const projectedBase = project(base, null, []);
    const projectedHead = project(head, projectedBase, records);
    const result = classify(projectedBase, projectedHead);
    console.log('#' + number, raw.mode, '->', result.profile ?? result.mode);
    assert.equal(raw.mode, 'full');
    if (result.mode === 'focused') eligible.push(number);
    else assert.equal(result.mode, 'full');
    const queue = determineScope({eventName: 'merge_group', runGit: git, event: {
      merge_group: {base_ref: 'refs/heads/main', base_sha: projectedBase, head_sha: projectedHead}
    }});
    assert.equal(queue.mode, result.mode);
    if (result.mode === 'focused') {
      assert.equal(result.profile, 'chat-render');
      console.log(git(['diff','--name-only',projectedBase,projectedHead]).trim());
      // The projected tree did not exist on GitHub. Check the original main
      // parent, never pretend the synthetic SHA itself has historical CI.
      if (process.argv.includes('--verify-main')) {
        const main = determineScope({eventName: 'push', runGit: git,
          event: {ref: 'refs/heads/main', before: projectedBase, after: projectedHead},
          checkBaseline: () => verifiedBaseline(base, read)});
        assert.equal(main.profile, 'chat-render', main.reason);
        console.log(main.reason);
      }
    }
  }
  assert.deepEqual(eligible, [495]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
