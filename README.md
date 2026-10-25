# Chamber

Chamber 是面向两名参与者的端到端加密聊天应用。仓库、存储与部署标识保留 `quiet-room` 兼容名称。
代码与自动测试证明实现，生产状态以精确发布和独立回读证据为准。

项目接手从 [AGENTS.md](AGENTS.md) 和 [当前状态](docs/context/status.md) 开始；
代码、详细契约与测试定位见 [项目地图](docs/context/overview.md)。

## 当前产品与兼容范围

新建密室以 [NEW_ROOM_ARCHIVES.md](NEW_ROOM_ARCHIVES.md) 为准：

- 无注册、无前置应用锁，创建后分享一次性短链接；两方各自使用独立设备密钥与访问令牌。
- 新密室通过 RFC 9420 MLS 交换消息。待发密文与棘轮状态原子保存，普通重试复用消息 ID 和原密文。
- 本机应用锁可选，支持密码或实际可用的 WebAuthn PRF。未设置应用锁时，本浏览器可自动解密；加密存储不等于抵御浏览器使用者。
- 每名参与者最多三台独立设备。目录发现、加入授权、设备接替与历史恢复是不同能力；新增设备没有加入前的共享历史。
- 默认在前台、解锁且联网时向本人独立归档备份。恢复使用本人凭证原图和独立口令，在本机验证并私有导入，不授予实时成员资格。
- 名称、头像和列表移除可在本人已授权设备间加密同步；列表移除保留原有本机内容、独立归档和对方状态。

[CHAMBER_IDENTITY.md](CHAMBER_IDENTITY.md) 和 [RECOVERY_BACKUPS.md](RECOVERY_BACKUPS.md)
定义此前个人根、双人恢复及旧 QR3／QR4 格式。它们继续适用于对应存量数据；旧空间迁移已停用，
不将旧流程用作新建密室入口，不自动转换或清理旧数据。

## 消息、附件与隐私

正文、回复关系、反应、消息类型和原附件在本机加密。服务端持有必要元数据与密文；
管理员维护的公开表情原图另按 [MEMES.md](MEMES.md) 管理。

原图片、视频、语音和文件逐字节加密与校验。支持的 PDF／EPUB／文本仅在本机完整校验后阅读，
文档脚本不执行。聊天删除、保险箱整理、列表移除和设备撤销各有独立范围，见
[产品契约](PRODUCT.md)、[安全模型](SECURITY.md) 和 [操作影响对照](docs/workflows/operation-effects.md)。

在线、服务端接收、对方送达和已读是不同事实。遮罩不是认证；浏览器原生工具栏、截图和系统副本
不受网页完全控制。锁定及隐私生命周期释放明文运行时与媒体授权，具体边界以安全模型为准。

正式来源为 `https://ai.shui.click`。通行密钥与本机历史绑定该来源；退役域名不兼容原来源的保险库。

## Requirements

- Node.js 24 或以上；服务端使用内置 `node:sqlite`。
- 支持 Web Crypto、IndexedDB、WebSocket 和 WebAssembly 的现代浏览器；通行密钥功能另要求相容认证器的真实 PRF 输出。
- 非回环部署使用受信任的 HTTPS。

## Local development

按项目规则在本任务的独立 worktree 中运行：

```sh
npm ci --prefer-offline
npm run dev
```

前端默认 `http://127.0.0.1:5173`，API／WebSocket 经代理访问回环服务。
通行密钥测试使用 `http://localhost:5173` 或设备信任且名称匹配的稳定 HTTPS 来源。
移动模拟入口见 [移动调试流程](docs/workflows/mobile-debug.md)；模拟不替代真机验证。
局域网与跨电脑配置见 [本地 LAN 流程](docs/workflows/local-lan-testing.md)。

本机 main 仅作为同步基线，测试服务运行于任务 worktree。代码与规则经本仓库 PR／CI 同步，
证书、密钥、保险库、消息与恢复材料保留在各自本机环境。

## Production build

```sh
npm run build
npm run check
npm run check:full
```

`check` 包含类型检查、构建及单元／集成测试；`check:full` 另运行注册的完整浏览器入口。
通话／TURN、镜像、依赖审计与发布门槛按对应流程执行。验证失败保留原结果并分类，
不将受控测试、桌面 WebKit 或 CI 成功写成真机或生产验收。

## Container deployment

[DEPLOYMENT.md](DEPLOYMENT.md) 说明环境与一次性安装；[RELEASING.md](RELEASING.md)
定义固定的精确 SHA 发布入口、完整 CI、冷备份、切换和独立回读。生产发布逐次确认精确提交。
应用已开放业务写入后的回读失败不能触发旧数据自动覆盖。

开发容器示例使用 [compose.yaml](compose.yaml)，生产、管理员与通话覆盖分别按部署文档审阅。
业务 SQLite 与附件密文不进入源码、测试日志或提交。

## Recovery and loss

本人归档的凭证原图与口令、应用锁、实时设备身份互不替代。换浏览器不能凭空找回本机未完成上传的历史；
旧卡、已下载密文及失陷客户端的限制见新密室契约。客户端归档也不替代服务器灾备。

[OPERATIONS.md](OPERATIONS.md) 定义现有 Mac 主动拉取、成功回执、新鲜度、容量和保留规则。
Mac 睡眠、断网或损坏会中断此过渡方案；FileVault 不构成不可变异地存储。

## 安全与验证边界

[PRODUCTION_SECURITY_GATE.md](PRODUCTION_SECURITY_GATE.md) 的独立密码学／应用安全审阅、
可信客户端及物理设备门槛仍未关闭。采用 MLS 或依赖扫描通过不等于独立审计。
本轮项目治理暂缓真机与外审，相关限制继续保留。

## Commands

现有命令以 [package.json](package.json) 为准。常用入口：

| 用途 | 命令／契约 |
| --- | --- |
| 环境检查 | `npm run repo:doctor -- --local` |
| 开发、移动与 LAN | `npm run dev`、`npm run dev:mobile`、`npm run dev:lan` |
| 构建与自动验证 | `npm run check`、`npm run check:full` |
| 通话专项 | `npm run test:calls` |
| 备份、校验、隔离恢复 | `npm run backup:create`、`npm run backup:verify -- <快照>`、`npm run backup:restore -- <快照> <空目录>` |
| 资源清理 | [任务清理流程](docs/workflows/task-cleanup.md)；先核验所有权、集成、证据和使用状态 |
| 发布与独立回读 | [固定发布流程](RELEASING.md) |
