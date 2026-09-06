# Quiet Room 项目地图

更新时间：2026-09-07。本页用于按任务定位，不复制完整产品说明或目录树。相对路径均从仓库根目录计算。

## 一分钟认识项目

- 技术栈：原生 TypeScript/DOM + Vite 前端，Node.js ESM 服务端，SQLite 和文件系统密文存储，Vitest 与 Playwright 测试。
- 运行要求：Node.js 24 或以上；服务端使用内置 `node:sqlite`。
- 前端启动：`src/main.ts` 加载样式、实例化 `QuietRoomApp`，并在生产环境注册 Service Worker。
- 主要编排：`src/app.ts` 管理页面、会话、生命周期、消息、附件、相册和通话接入。项目不是 React 应用。
- 服务入口：`server/index.mjs` 提供 HTTP/WebSocket、认证、安全头与资源限制；`server/storage.mjs` 管理 SQLite、序号、设备历史边界及密文附件状态。
- 正式来源：`https://ai.shui.click`；单机开发通常使用 `http://localhost:5173`，局域网通行密钥真机测试必须使用设备信任且主机名匹配的稳定 HTTPS 来源。

## 按任务查找

| 领域 | 先读 | 代码入口 | 主要验证入口 |
| --- | --- | --- | --- |
| 产品语义与交互 | `PRODUCT.md`、`README.md` | `src/app.ts`、各 CSS 文件 | `tests/browser.e2e.mjs`、`tests/ui-audit.e2e.mjs`、相关专项浏览器脚本 |
| 启动、页面状态、版本更新、Service Worker | `README.md`、`PRODUCT.md`、`RELEASING.md` | `release.json`、`src/main.ts`、`src/lib/release-update.ts`、`public/sw.js` | `tests/frontend-lifecycle.e2e.mjs`、`tests/release-update.e2e.mjs`、`tests/release-update.test.ts`、`tests/service-worker.test.ts` |
| 聊天日期、气泡回执、回到最新消息与键盘跟随 | `PRODUCT.md` 的 Message Timeline、`TEST_PLAN.md` | `src/lib/message-date.ts`、`src/lib/chat-bottom-control.ts`、`src/lib/chat-viewport-motion.ts`、`src/app.ts`、`src/chat-layout.css`、`src/styles.css` | `tests/message-timeline.e2e.mjs`、`tests/chat-bottom-control.e2e.mjs`、`tests/frontend-lifecycle.e2e.mjs`、`tests/chat-viewport-motion.test.ts` |
| 设备邀请与参与者邀请分类 | `PRODUCT.md`、`SECURITY.md` | `src/lib/invite-link.ts`、`src/lib/vault.ts`、`src/app.ts` | `tests/invite-link.test.ts`、`tests/platform-vault.test.ts`、`tests/browser.e2e.mjs` |
| 隐私遮罩、锁定、桌面恢复、系统弹窗 | `PRODUCT.md`、`SECURITY.md`、`TEST_PLAN.md` | `src/app.ts`、`src/cover.css`、`src/auth-recovery.css`、`src/lib/vault.ts` | `tests/desktop-privacy.e2e.mjs`、`tests/desktop-session-flow.e2e.mjs`、`tests/system-surfaces.e2e.mjs`、`tests/vault-resume.e2e.mjs`、`tests/chat-image-privacy.e2e.mjs` |
| 消息格式、签名和协议校验 | `SECURITY.md`、`PRODUCT.md` | `src/lib/types.ts`、`src/lib/message-payload.ts`、`src/lib/crypto.ts`、`server/protocol.mjs` | `tests/crypto.test.ts`、`tests/message-payload.test.ts`、`tests/protocol.test.ts`、`tests/room-protocol.test.ts` |
| MLS、多设备、成员变更与历史边界 | `SECURITY.md`、`PRODUCTION_SECURITY_GATE.md` | `src/lib/mls.ts`、`src/lib/vault.ts`、`server/storage.mjs` | `tests/mls.test.ts`、`tests/storage.test.ts`、`tests/upgrade-safety.test.ts` |
| 通行密钥、本机保险库、恢复、待发箱 | `SECURITY.md`、`README.md` | `src/lib/platform-vault.ts`、`src/lib/vault.ts` | `tests/recovery.test.ts`、`tests/recovery-server.test.ts`、`tests/vault-lifecycle.e2e.mjs`、`tests/vault-resume.e2e.mjs` |
| 自动恢复备份、新码轮换、显式历史恢复 | `RECOVERY_BACKUPS.md`、`SECURITY.md` | `src/lib/backup-crypto.ts`、`src/lib/cloud-backup.ts`、`src/lib/vault.ts`、`server/cloud-backups.mjs` | `tests/cloud-backups.test.ts`、`tests/cloud-backup-lifecycle.e2e.mjs`、`tests/browser.e2e.mjs` |
| 会话管理后台 | `RECOVERY_BACKUPS.md`、`DEPLOYMENT.md` | `src/admin.ts`、`server/admin.mjs`、`server/admin-auth.mjs`、`scripts/admin-setup.mjs`、`compose.admin.yaml` | `tests/admin.test.ts`、`tests/backup-admin-ui.e2e.mjs`、`tests/deploy-admin.test.ts` |
| API、WebSocket、服务端资源控制 | `README.md`、`SECURITY.md` | `src/lib/api.ts`、`server/index.mjs`、`server/storage.mjs`、`server/protocol.mjs` | `tests/api.test.ts`、`tests/server.test.ts`、`tests/storage.test.ts` |
| 照片、视频、普通文件和创建者保险箱（相册 / 文件） | `PRODUCT.md`、`README.md`、`SECURITY.md`、`TEST_PLAN.md`、[D-024](./decisions.md#d-024保险箱本地整理与聊天删除严格分层) | `src/lib/file-crypto.ts`、`src/lib/image-batches.ts`、`src/lib/video-media.ts`、`src/lib/video-poster.ts`、`src/lib/image-viewer-gestures.ts`、`src/lib/gallery-curation.ts`、`src/app.ts`、`src/gallery.css` | `tests/file-attachments.test.ts`、`tests/image-batches.test.ts`、`tests/video-media.test.ts`、`tests/image-viewer-gestures.test.ts`、`tests/gallery-curation.test.ts`、`tests/video-flow.e2e.mjs`、`tests/file-flow.e2e.mjs`、`tests/file-outbox.e2e.mjs`、`tests/file-interactions.e2e.mjs`、`tests/chat-image-privacy.e2e.mjs`、`tests/gallery-loading.e2e.mjs`、`tests/frontend-lifecycle.e2e.mjs`、`tests/cloud-backup-lifecycle.e2e.mjs` |
| 语音留言 | `PRODUCT.md`、`README.md` | `src/lib/voice-gesture.ts`、`src/lib/voice-recorder.ts`、`src/lib/voice-audio.ts`、`src/lib/voice-player.ts`、`src/voice-messages.css` | `tests/voice.test.ts`、`tests/voice-lifecycle.e2e.mjs`、`tests/voice-gestures.e2e.mjs`、`tests/voice-flow.e2e.mjs` |
| 实时音视频通话 | `CALLS.md`、`SECURITY.md` 的通话构造、`DEPLOYMENT.md` 的可选中继部署段与当前状态页 | `src/lib/call-*.ts`、`src/call.css`、`server/calls.mjs` | `tests/call-*.test.ts`、`tests/call-flow.e2e.mjs`、`tests/call-native.e2e.mjs`、`tests/call-view.e2e.mjs` |
| 回应、回复手势、消息删除、未读计数和 presence | `PRODUCT.md`、`SECURITY.md`、[D-024](./decisions.md#d-024保险箱本地整理与聊天删除严格分层) | `src/lib/reactions.ts`、`src/lib/reply-swipe.ts`、`src/lib/message-deletions.ts`、`src/lib/message-payload.ts`、`src/lib/unread-counter.ts`、`src/lib/api.ts`、`server/index.mjs`、`server/storage.mjs` | `tests/reactions.test.ts`、`tests/reply-swipe.test.ts`、`tests/message-deletions.test.ts`、`tests/message-deletion.e2e.mjs`、`tests/reaction-history.e2e.mjs`、`tests/unread-counter.test.ts`、`tests/unread-server.test.ts`、`tests/unread-counter.e2e.mjs` |
| Web Push | `OPERATIONS.md`、`SECURITY.md` | `src/lib/push.ts`、`server/push.mjs`、`public/sw.js` | `tests/push.test.ts`、`tests/push-server.test.ts` |
| 本机 main 集成、局域网测试与跨电脑同步 | [`docs/workflows/local-lan-testing.md`](../workflows/local-lan-testing.md)、本工作流、`README.md` | 共享本机 `main` 工作树、实际 Vite／服务端进程；主机名、证书和数据为每台电脑的本机配置 | 候选与本机 main 精确 SHA、进程工作目录、前端目标代码回读、后端健康接口、局域网 HTTPS 真机记录 |
| 构建、发布、备份与运维 | `RELEASING.md`、`DEPLOYMENT.md`、`OPERATIONS.md`、`PRODUCTION_SECURITY_GATE.md` | `scripts/`、`deploy/`、`.github/workflows/ci.yml` | `tests/deploy-*.test.ts`、`tests/release.test.ts`、`tests/publish.test.ts`、`tests/backup.test.ts`、`tests/operations-*.test.ts` |
| 发布后生产事实、上下文治理与交付效率 | `RELEASING.md`、`docs/context/maintenance.md`、[D-021](./decisions.md#d-021生产回读后对账知识库语义变化继续审阅)、[2026-09-05 交付复盘](../../audit/2026-09-05-mobile-ux-delivery-retrospective.md) | 发布与最小 SHA 回执为 `scripts/publish.mjs`、`scripts/release.mjs`；独立结构化回读为 `scripts/production-readback.mjs`；格式检查为 `scripts/check-docs.mjs`，自动文档 PR 对账尚待实现 | `tests/publish.test.ts`、`tests/release-entry.test.ts`、`tests/production-readback.test.ts`、`tests/ci-docs.test.ts`、`tests/ci-scope.test.ts` |

## 测试命令的准确含义

- `npm run tasks:cleanup -- --plan /绝对路径/plan.json`：发布后任务资源只读检查，加 `--apply` 才清理；入口 `scripts/cleanup-task-resources.mjs`，回归 `tests/cleanup-task-resources.test.ts`，计划与保留边界见[说明](../workflows/task-cleanup.md)。不属于生产切换入口。
- `npm run build`：TypeScript 类型检查后构建 Vite 产物。
- `npm test`：运行 Vitest 自动发现的单元/集成测试；它不等于浏览器回归。
- `npm run check`：依次运行 build 与 Vitest。
- `npm run test:browser`：通过 `scripts/test-browser.mjs` 串行运行全部真实浏览器脚本，并输出逐脚本和总耗时。`-- --group 1` / `-- --group 2` 分别运行主流程与其余专项；CI 在两个独立执行环境中并行运行两组。
- `npm run check:full`：运行 `check`，然后运行浏览器套件。
- `npm run deploy:readback -- --sha <40位SHA>`：独立、只读地复核该精确生产版本，输出逐阶段耗时与失败分类，并在 `.git/quiet-room-readback/` 保存脱敏结构化证据；它不发布、不回滚，也不替代发布授权。
- `npm run test:calls`：完整通话专项入口，包含部分 Vitest 用例与 `call-native.e2e.mjs`、`call-view.e2e.mjs`。`npm run test:calls:e2e` 只运行后两个浏览器专项；CI 与本地已完成 `check:full` 后使用此入口，避免重复运行已被 `npm test` 包含的通话单元测试。
- `node scripts/audit-production.mjs`：使用 npm 官方源审计生产依赖；仅对明确的临时接口故障最多尝试三次。high/critical 漏洞、无效报告和接口持续不可用均阻断 CI。

两个容易误判的细节：

- `tests/browser.e2e.mjs` 会导入并执行 `verifyVoiceFlow` 和 `verifyCallFlow`，所以 `voice-flow.e2e.mjs`、`call-flow.e2e.mjs` 即使没有直接列在 `package.json` 的命令字符串中，仍属于浏览器主流程。
- `.github/workflows/ci.yml` 将完整验证拆为并行任务，`verify` 严格汇总必需结果；文档白名单变更使用轻量检查，其他变更和手动运行默认完整。发布必须验证精确 main 提交的最新 push／手动 CI 成功，且 `Full application verification` 成功；文档绿色结果不能作为应用发布证据。配置文件存在不能证明任意提交已经通过 CI。

浏览器脚本本地默认使用 Chrome，可通过 `CHROME_PATH` 指定程序；CI 使用安装的 Chromium。若受限环境不能监听本地端口，应把它记录为环境限制，不能记作产品失败或测试通过。

## 详细资料索引

- [README.md](../../README.md)：用户流程、架构和本地运行的综合说明。
- [PRODUCT.md](../../PRODUCT.md)：产品与交互契约；不是实时实施状态表。
- [SECURITY.md](../../SECURITY.md)：威胁模型、保护范围、限制和部署安全要求。
- [PRODUCTION_SECURITY_GATE.md](../../PRODUCTION_SECURITY_GATE.md)：公开高安全声明的阻塞门槛与禁止表述。
- [TEST_PLAN.md](../../TEST_PLAN.md)：验收矩阵、覆盖范围、人工验证要求和带日期的测试记录。
- [RECOVERY_BACKUPS.md](../../RECOVERY_BACKUPS.md)：恢复码定位、加密归档、轮换、恢复边界与后台管理。
- [RELEASING.md](../../RELEASING.md)：唯一日常发布入口、授权前提和最近一次发布记录。
- [DEPLOYMENT.md](../../DEPLOYMENT.md)：部署架构、首次配置、可选通话覆盖和服务器布局。
- [OPERATIONS.md](../../OPERATIONS.md)：备份、证书、推送、恢复演练和事故处理。
- [本机局域网测试与跨电脑同步](../workflows/local-lan-testing.md)：本机 `main` 集成、服务回读、局域网 HTTPS 真机验收及 GitHub 同步边界。
- [audit/](../../audit/)：特定日期和代码基线的审查证据；不能自动外推到当前工作树。
