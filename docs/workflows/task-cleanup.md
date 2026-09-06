# 任务资源清理脚本

固定入口：`npm run tasks:cleanup -- --plan /绝对路径/plan.json`。默认只检查；执行 agent 审阅检查结果后，使用相同计划加 `--apply` 执行。用户不需要手写计划、执行 Git 命令或逐项重复授权。脚本只处理计划显式列出的任务工作树和分支，不调用生产、备份或发布入口，不自动调整模型。

## 交接与信任边界

执行 agent 在精确发布回执、独立回读和知识库对账完成后，核对任务归属、会话/进程已结束、证据已保存，以及远端 PR 已合并且没有后续依赖，生成计划。计划是 agent 审阅后的输入，不是从任意文件内容自动推导的删除授权。不能从分支名、时间或工作树干净推断这些事实。

脚本独立核验 Git 和文件状态。发布/回读/对账布尔值与 ownerReleased、evidenceSaved、remoteReviewed 是调用方确认项，不是脚本从生产取回的事实；证据摘要用于检测文件变化，不认证内容真伪。不得把一份自行填写的 JSON 当成已经完成生产验证。没有审阅证据不能填 true。

`lsof` 用于检查可见的打开文件和进程；不可用、超时或有诊断警告时保留。它不能证明其他机器、不可见进程或空闲会话已经结束，因此仍必须核对 ownerReleased。脚本锁只协调本脚本的并发执行，不能禁止编辑器在检查之后重新写入；使用期间必须保持目标任务停止。

## 计划格式

以下 SHA、时间、路径是格式示例，由执行 agent 替换为本批真实值。计划与脱敏证据必须保存到目标工作树及其专属 Git 管理目录之外的持久位置。reviewedAt 有效期为 24 小时；超时重新审阅。

```json
{
  "version": 1,
  "repository": "/absolute/path/to/coordinator-worktree",
  "releaseSha": "1111111111111111111111111111111111111111",
  "reviewedAt": "2026-09-06T10:00:00.000Z",
  "releaseVerified": true,
  "readbackVerified": true,
  "contextSynced": true,
  "evidence": {
    "path": "/absolute/durable/path/reviewed-release-evidence.json",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "items": [
    {
      "path": "/absolute/path/to/completed-worktree",
      "branch": "codex/example-task",
      "head": "2222222222222222222222222222222222222222",
      "ownerReleased": true,
      "evidenceSaved": true,
      "remote": false
    }
  ]
}
```

- repository 是协调清理的工作树，不得列为目标；脚本也保护仓库主工作树、公共 Git 目录、当前执行目录、脚本自身与证据所在目录。
- branch 只接受 `codex/`、`fix/`、`docs/` 下的精确任务分支；其他命名保留。path 使用真实绝对路径，不使用符号链接别名。head 必须是审阅的完整 40 位 SHA。
- 普通合并要求 head 是 releaseSha 的祖先。squash/cherry-pick 可额外提供 integratedCommit：它必须是 releaseSha 的祖先，且它的完整文件树与 head 完全相同。遇到冲突解决或其他并行改动导致树不同，首版保留，不以模糊补丁匹配授权删除。
- 只有需要删除远端任务分支才设置 remote: true，同时提供 remoteReviewed: true。agent 必须事先核对已合并 PR 与无依赖事实。脚本验证 origin 的 fetch/push 地址相同且只有一个、远端 head 精确匹配，并以显式 lease 删除。默认 remote: false 不触碰远端任务分支。
- 脚本只读查询 origin/main，不自动 fetch。releaseSha 必须是实时远端 main 的祖先，且相关对象本地可用；远端不可达或缺少对象时阻塞，由 agent 在协调目录完成必要获取后重试。

## 检查、执行、回执

```sh
npm run tasks:cleanup -- --plan /absolute/durable/path/plan.json
npm run tasks:cleanup -- --plan /absolute/durable/path/plan.json --apply
```

只检查不会写清理回执或删除文件，但会查询 Git 远端和本机进程。执行前重新核对证据、远端 main、分支、工作树和进程；每项独立返回结果，一项被保留不影响其他符合条件的项。

- `eligible`：本次检查满足条件，尚未删除。
- `cleaned`：执行并回查清理成功。
- `absent`：目标工作树和所需引用已不存在。
- `retained`：未全部清理，reason 给出阻塞原因；worktreeRemoved 表示是否已移除工作树，不能把 retained 理解成所有资源都未变化。
- 全局 `blocked`：计划或公共前提不成立。

退出码：0 表示检查/执行无保留项；2 表示有保留项；1 表示全局阻塞或输入错误。检查模式返回 0 不等于已经清理。

执行回执写入公共 Git 目录下 `quiet-room-task-cleanup/<计划内容摘要>.json`，记录计划摘要、证据引用、releaseSha 和逐项进度，不记录凭据、文件内容或原始 Git 错误输出。首次删除前必须能保存回执；每次移除工作树后保存进度，使用写入临时文件后原子替换的方式保留整批检查点。公共目录 `quiet-room-task-cleanup.lock` 阻止本工具同时执行；异常退出留下锁时先核实运行状态，不能自动解锁。

同一有效计划可重复运行。分支删除失败时，只在存在同计划的工作树移除回执后允许继续删除剩余分支；无回执的失踪目录会保留。中断导致回执损坏或计划过期时先由 agent 对账，不通过更改 head 或忽略失败强行续跑。清理失败不重发、不回滚。

## 保留边界

脏目录、任何未跟踪或忽略文件、子模块、未知工作树 Git 元数据、锁定/陈旧登记、活动资源、移动的引用、非本仓库或非登记路径都保留。首版连 node_modules/dist 等忽略缓存也保留，不自动判断其中是否夹带用户材料；不自动调用 git clean、rm -rf 或强制 worktree remove。Git 的正常管理文件和空 refs 目录允许通过，额外回执和工作树本地引用保留。

实际执行采用正常 worktree remove、拒绝符号分支并以 --no-deref 执行本地引用旧 SHA 条件删除、远端显式 force-with-lease 条件删除，随后回查。即使使用条件删除，也不能替代交接归属与停止写入要求。

验证入口：`npx vitest run tests/cleanup-task-resources.test.ts`，在临时仓库与本地裸远端中验证正常删除、保护条件、squash 映射、引用竞态、远端 lease 和部分失败续跑，不操作真实任务资源。
