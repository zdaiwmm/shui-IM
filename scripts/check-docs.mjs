import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lightweightDocs } from './ci-scope.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function markdownOutsideFences(source, report) {
  let fence;
  return source.split('\n').map((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return '';
    }
    if (/^(<{7}|={7}|>{7})(?: |$)/.test(line)) report(index + 1, 'Unresolved merge conflict marker.');
    return fence ? '' : line;
  }).join('\n') + (fence ? (report(1, 'Unclosed fenced code block.'), '') : '');
}

function headingAnchors(source) {
  const anchors = new Set();
  const counts = new Map();
  const body = markdownOutsideFences(source, () => {});
  for (const heading of body.matchAll(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)) {
    const base = heading[1].replace(/<[^>]*>/g, '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, '').replace(/ /g, '-');
    const count = counts.get(base) ?? 0;
    anchors.add(count ? `${base}-${count}` : base);
    counts.set(base, count + 1);
  }
  for (const anchor of body.matchAll(/<(?:a|[a-z][a-z\d]*)\b[^>]*\b(?:id|name)=["']([^"']+)["'][^>]*>/gi)) anchors.add(anchor[1]);
  return anchors;
}

export function checkDocumentation({ cwd = root, files } = {}) {
  const listing = spawnSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  if (listing.error || listing.signal || listing.status !== 0) throw new Error('Tracked documentation paths are unavailable.');
  const tracked = new Set(listing.stdout.split('\0').filter(Boolean));
  const selected = files ?? ['AGENTS.md', ...lightweightDocs].filter(file => tracked.has(file));
  if (!selected.length) throw new Error('No documentation was available to check.');
  const issues = [];
  const contentCache = new Map();
  const readMarkdown = file => {
    if (!tracked.has(file)) throw new Error('Link does not reference a tracked file.');
    const absolute = path.resolve(cwd, file);
    if (path.relative(cwd, absolute).startsWith('..') || path.isAbsolute(path.relative(cwd, absolute))) throw new Error('Path escapes the repository.');
    const components = file.split('/');
    for (let index = 1; index <= components.length; index++) {
      if (lstatSync(path.join(cwd, ...components.slice(0, index))).isSymbolicLink()) throw new Error('Documentation may not follow symlinks.');
    }
    if (!contentCache.has(file)) contentCache.set(file, readFileSync(absolute, 'utf8'));
    return contentCache.get(file);
  };
  for (const file of selected) {
    const report = (line, message) => issues.push(`${file}:${line}: ${message}`);
    let source;
    try { source = readMarkdown(file); } catch { report(1, 'Document is missing, untracked, or not a regular repository file.'); continue; }
    if (!source.endsWith('\n')) report(1, 'Document must end with a newline.');
    if (/\r|[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(source)) report(1, 'Unexpected control character or invalid UTF-8; use LF line endings.');
    const body = markdownOutsideFences(source, report);
    // Check inline links and reference definitions, without visiting remote URLs.
    const destinations = [
      ...body.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g),
      ...body.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/gm),
    ];
    for (const match of destinations) {
      const line = body.slice(0, match.index).split('\n').length;
      let destination = match[1].replace(/^<|>$/g, '');
      if (/^(?:https?:|mailto:|tel:)/i.test(destination)) continue;
      if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(destination)) { report(line, 'Local links must use repository-relative paths.'); continue; }
      try { destination = decodeURIComponent(destination); } catch { report(line, 'Link contains invalid percent encoding.'); continue; }
      const [pathname, fragment] = destination.split('#', 2);
      const target = pathname ? path.posix.normalize(path.posix.join(path.posix.dirname(file), pathname.split('?')[0])) : file;
      if (target === '..' || target.startsWith('../') || path.posix.isAbsolute(target)) { report(line, 'Link escapes the repository.'); continue; }
      const directory = target.replace(/\/$/, '');
      if (!tracked.has(target) && ![...tracked].some(entry => entry.startsWith(`${directory}/`))) { report(line, `Local link target is missing: ${target}`); continue; }
      if (fragment && target.endsWith('.md')) {
        try {
          if (!headingAnchors(readMarkdown(target)).has(fragment)) report(line, `Markdown heading anchor is missing: ${target}#${fragment}`);
        } catch { report(line, `Markdown link target is unreadable: ${target}`); }
      }
    }
  }
  return { checked: selected.length, issues };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.length !== 2) throw new Error('The documentation checker takes no arguments.');
    const result = checkDocumentation();
    if (result.issues.length) throw new Error(result.issues.join('\n'));
    console.log(`Documentation checks passed (${result.checked} files; local links, heading anchors, fences, and text format).`);
  } catch (error) {
    console.error(`DOCS_BLOCKED: ${error.message}`);
    process.exitCode = 1;
  }
}
