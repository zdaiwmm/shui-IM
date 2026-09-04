# Quiet Room 项目地图

更新时间：2026-09-04。本页用于按任务定位，不复制完整产品说明或目录树。相对路径均从仓库根目录计算。

## 一分钟认识项目

- 技术栈：原生 TypeScript/DOM + Vite 前端，Node.js ESM 服务端，SQLite 和文件系统密文存储，Vitest 与 Playwright 测试。
- 运行要求：Node.js 24 或以上；服务端使用内置 `node:sqlite`。
- 前端启动：`src/main.ts` 加载样式、实例化 `QuietRoomApp`，并在生产环境注册 Service Worker。
- 主要编排：`src/app.ts` 管理页面、会话、生命周期、消息、附件、相册和通话接入。项目不是 React 应用。
- 服务入口：`server/index.mjs` 提供 HTTP/WebSocket、认证、安全头与资源限制；`server/storage.mjs` 管理 SQLite、序号、设备历史边界及密文附件状态。
- 正式来源：`https://ai.shui.click`；本地开发通常使用 `http://localhost:5173` 才适合 WebAuthn RP ID 测试。

## 按任务查找

| 领域 | 先读 | 代码入口 | 主要验证入口 |
| --- | --- | --- | --- |
| 产品语义与交互 | `PRODUCT.md`、`README.md` | `src/app.ts`、各 CSS 文件 | `tests/browser.e2e.mjs`、`tests/ui-audit.e2e.mjs`、相关专项浏览器脚本 |
| 启动、页面状态、Service Worker | `README.md` | `src/main.ts`、`public/sw.js` | `tests/frontend-lifecycle.e2e.mjs`、`tests/service-worker.test.ts` |
| 隐私遮罩、锁定、桌面恢复、系统弹窗 | `PRODUCT.md`、`SECURITY.md`、`TEST_PLAN.md` | `src/app.ts`、`src/cover.css`、`src/auth-recovery.css`、`src/lib/vault.ts` | `tests/desktop-privacy.e2e.mjs`、`tests/desktop-session-flow.e2e.mjs`、`tests/system-surfaces.e2e.mjs`、`tests/vault-resume.e2e.mjs` |
| 消息格式、签名和协议校验 | `SECURITY.md`、`PRODUCT.md` | `src/lib/types.ts`、`src/lib/message-payload.ts`、`src/lib/crypto.ts`、`server/protocol.mjs` | `tests/crypto.test.ts`、`tests/message-payload.test.ts`、`tests/protocol.test.ts`、`tests/room-protocol.test.ts` |
| MLS、多设备、成员变更与历史边界 | `SECURITY.md`、`PRODUCTION_SECURITY_GATE.md` | `src/lib/mls.ts`、`src/lib/vault.ts`、`server/storage.mjs` | `tests/mls.test.ts`、`tests/storage.test.ts`、`tests/upgrade-safety.test.ts` |
| 通行密钥、本机保险库、恢复、待发箱 | `SECURITY.md`、`README.md` | `src/lib/platform-vault.ts`、`src/lib/vault.ts` | `tests/recovery.test.ts`、`tests/recovery-server.test.ts`、`tests/vault-lifecycle.e2e.mjs`、`tests/vault-resume.e2e.mjs` |
| API、WebSocket、服务端资源控制 | `README.md`、`SECURITY.md` | `src/lib/api.ts`、`server/index.mjs`、`server/storage.mjs`、`server/protocol.mjs` | `tests/api.test.ts`、`tests/server.test.ts`、`tests/storage.test.ts` |
| 图片、普通文件和创建者相册 | `PRODUCT.md`、`README.md`、`TEST_PLAN.md` | `src/lib/file-crypto.ts`、`src/lib/image-batches.ts`、`src/app.ts` | `tests/file-attachments.test.ts`、`tests/image-batches.test.ts`、`tests/file-flow.e2e.mjs`、`tests/file-outbox.e2e.mjs`、`tests/file-interactions.e2e.mjs` |
| 语音留言 | `PRODUCT.md`、`README.md` | `src/lib/voice-recorder.ts`、`src/lib/voice-audio.ts`、`src/lib/voice-player.ts` | `tests/voice.test.ts`、`tests/voice-lifecycle.e2e.mjs`、`tests/voice-flow.e2e.mjs` |
| 实时音视频通话 | `CALLS.md`、`SECURITY.md` 的通话构造、`DEPLOYMENT.md` 的可选中继部署段与当前状态页 | `src/lib/call-*.ts`、`src/call.css`、`server/calls.mjs` | `tests/call-*.test.ts`、`tests/call-flow.e2e.mjs`、`tests/call-native.e2e.mjs`、`tests/call-view.e2e.mjs` |
| 回应、未读计数和 presence | `PRODUCT.md`、`SECURITY.md` | `src/lib/reactions.ts`、`src/lib/unread-counter.ts`、`src/lib/api.ts`、`server/index.mjs`、`server/storage.mjs` | `tests/reactions.test.ts`、`tests/reaction-history.e2e.mjs`、`tests/unread-counter.test.ts`、`tests/unread-server.test.ts`、`tests/unread-counter.e2e.mjs` |
| Web Push | `OPERATIONS.md`、`SECURITY.md` | `src/lib/push.ts`、`server/push.mjs`、`public/sw.js` | `tests/push.test.ts`、`tests/push-server.test.ts` |
| 构建、发布、备份与运维 | `RELEASING.md`、`DEPLOYMENT.md`、`OPERATIONS.md`、`PRODUCTION_SECURITY_GATE.md` | `scripts/`、`deploy/`、`.github/workflows/ci.yml` | `tests/deploy-*.test.ts`、`tests/release.test.ts`、`tests/publish.test.ts`、`tests/backup.test.ts`、`tests/operations-*.test.ts` |

## 测试命令的准确含义

- `npm run build`：TypeScript 类型检查后构建 Vite 产物。
- `npm test`：运行 Vitest 自动发现的单元/集成测试；它不等于浏览器回归。
- `npm run check`：依次运行 build 与 Vitest。
- `npm run test:browser`：串行运行 `package.json` 中列出的真实浏览器脚本。
- `npm run check:full`：运行 `check`，然后运行浏览器套件。
- `npm run test:calls`：通话专项入口。除了部分 Vitest 用例，还包括 `call-native.e2e.mjs`、`call-view.e2e.mjs`。它们在 CI 中独立运行；本地 `check:full` 后仍需补跑该入口。

两个容易误判的细节：

- `tests/browser.e2e.mjs` 会导入并执行 `verifyVoiceFlow` 和 `verifyCallFlow`，所以 `voice-flow.e2e.mjs`、`call-flow.e2e.mjs` 即使没有直接列在 `package.json` 的命令字符串中，仍属于浏览器主流程。
- `.github/workflows/ci.yml` 声明了构建、单元/集成、浏览器测试、秘密扫描和生产依赖审计；这只描述 CI 配置，不能证明任意本地工作树或提交已经通过 CI。

浏览器脚本本地默认使用 Chrome，可通过 `CHROME_PATH` 指定程序；CI 使用安装的 Chromium。若受限环境不能监听本地端口，应把它记录为环境限制，不能记作产品失败或测试通过。

## 详细资料索引

- [README.md](../../README.md)：用户流程、架构和本地运行的综合说明。
- [PRODUCT.md](../../PRODUCT.md)：产品与交互契约；不是实时实施状态表。
- [SECURITY.md](../../SECURITY.md)：威胁模型、保护范围、限制和部署安全要求。
- [PRODUCTION_SECURITY_GATE.md](../../PRODUCTION_SECURITY_GATE.md)：公开高安全声明的阻塞门槛与禁止表述。
- [TEST_PLAN.md](../../TEST_PLAN.md)：验收矩阵、覆盖范围、人工验证要求和带日期的测试记录。
- [RELEASING.md](../../RELEASING.md)：唯一日常发布入口、授权前提和最近一次发布记录。
- [DEPLOYMENT.md](../../DEPLOYMENT.md)：部署架构、首次配置、可选通话覆盖和服务器布局。
- [OPERATIONS.md](../../OPERATIONS.md)：备份、证书、推送、恢复演练和事故处理。
- [audit/](../../audit/)：特定日期和代码基线的审查证据；不能自动外推到当前工作树。
