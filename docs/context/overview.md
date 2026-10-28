消息时间线呈现投影：`src/lib/message-timeline.ts`分离聊天排序／隐藏及本人私有归档去重，其他来源房间相同消息ID仍私有可见；由`app.ts`委托调用，不改变协议、回执或存储。验证为`tests/message-timeline-model.test.ts`及既有frontend-lifecycle／恢复／删除专项；`npm run perf:timeline`输出合成投影基线，`QUIET_ROOM_TIMELINE_PERF=1 node tests/frontend-lifecycle.e2e.mjs`另测真实DOM／输入／锁定清理。隔离灾备入口为`npm run test:restore-drill`；范围与证据见[治理V1](../requirements/2026-10-25-project-governance/README.md)。

运行隔离与私有分页V1：`room-runtime.ts`拥有每次打开的异步结果；`private-archive-catalog.ts`建立加密完整删除投影与外部归并目录，`private-history-controller.ts`拥有有界正文页／媒体取消；`archive-backup-state.ts`拥有备份任务和统一只读状态，`room-business-state.ts`仅投影目录／授权／就绪。`vault.ts`的v16派生存储保留原始记录，旧标签需刷新，不能降级数据库。新回归为room-runtime-isolation、private-archive-pagination、archive-backup-state；`QUIET_ROOM_PRIVATE_PERF=1 node tests/private-archive-pagination.e2e.mjs`比较基线14848e71的全量私有读取与分页，合成内存／耗时不外推真机。确认、回退和验收见[需求V1](../requirements/2026-10-27-room-runtime-archive-v1/README.md)。


22项界面一致性（2026-10-24）：`motion`、`space-drawer`和`room-creation-view`统一页面过渡；`archive-settings`与`room-polish.css`修正凭证／设备布局；`ui-notice`集中提交异常，`form-input`锁背景滚动，`meme-picker`恢复分类，`media-capsule`合并过期状态；弱网写入分离在`app.ts`。回归集中`settings-v14.e2e`与`offline-outbox.e2e`，并跑完整浏览器。确认及证据见[22项V1](../requirements/2026-10-24-ui-22-refinements/README.md)，视觉V1.28。 退出动画中的迟到回执不消费返回位置意图由`app.ts`的当前列表所有权检查保证，确定性回归为`frontend-lifecycle.e2e`。

设置与恢复V1.4（2026-10-23）：设置分类和导航在`space-drawer.ts`，原位创建在`room-creation-view.ts`，凭证与恢复完整页在`archive-settings.ts`，本人链接授权在`app.ts`／`invite-link.ts`及device-link存储路径。回归新增`settings-v14.e2e`并保留new-room-flows/mobile、numeric-password、设备与归档测试；确认及实施证据见[本需求](../requirements/2026-10-23-settings-17-prototype/README.md)，契约为NEW_ROOM_ARCHIVES、SECURITY、D-077与视觉V1.26。

系统审计四项修复：服务端邀请与归档事务授权在storage/room-archives；本机发送意图和顺序在app.ts、outbox-order.ts、vault.ts；Mac磁盘暂存及流预算在backup-stream、backup、backup-transfer、backup-limits。验收新增admission-lifecycle、offline-outbox和backup-large-database，范围及交付见[修复记录](../requirements/2026-10-23-system-audit-fixes/README.md)。

24项页面与凭证精修：`archive-settings.ts`、`archive-card-image.ts`、`room-archive-crypto.ts`、`room-archive.ts`与`server/room-archives.mjs`管理三步回验、整图和签名CAS读取能力轮换；`form-input.ts`、`chat-keyboard-layout.ts`与`room-polish.css`负责输入及顶部抽屉几何。验收以chamber-polish、new-room-flows/mobile、mobile-safari-feedback、numeric-password、presence-circuit与归档单测为入口；范围和失败历史由[24项V1](../requirements/2026-10-22-chamber-24-polish/README.md)拥有，安全由NEW_ROOM_ARCHIVES与SECURITY拥有。

邀请与隐私引导（2026-10-21）：24小时共享时限在`room-link-lifetime.mjs`、`short-invites.mjs`与storage；恢复凭证直达和状态、自动应用锁及标题在`app.ts`／`archive-settings.ts`，本机顺序保存在`spaces.ts`加密目录。验收入口`new-room-invite-privacy`、`new-room-passkey`与`new-room-flows/mobile`，范围及证据见[需求V2](../requirements/2026-10-21-invite-privacy/README.md)。

原邀请续入与首页地址：`src/app.ts`在本机解锁后按加密目录定位参与者邀请，复用待加入凭据并以History API清理为同源根地址；专项`tests/chamber-invite-reentry.e2e.mjs`由既有Chamber整链入口调用，并可单独验证Chromium／WebKit。范围见[需求V1](../requirements/2026-10-19-chamber-invite-reentry/README.md)、D-072及PRODUCT／SECURITY。

新密室与本人归档（2026-10-20）：[确认与实施证据](../requirements/2026-10-20-room-archive-static/06_implementation.md)、[长期契约](../../NEW_ROOM_ARCHIVES.md)。首页创建与短链接／设备接替在 `src/app.ts`、`short-room-link.ts`、`server/short-invites.mjs`；浏览器应用锁在 `browser-room-key.ts`；独立归档、PNG 卡及私有恢复在 `room-archive*.ts`、`archive-card-image.ts`、`archive-settings.ts`、`private-archive-view.ts`、`vault.ts` 与 `server/room-archives.mjs`。专项 `new-room-flows`、`new-room-mobile`、`new-room-passkey`、`room-archive-lifecycle` 已注册浏览器门禁。仅处理新建密室，不转换旧数据。下方旧双人恢复说明只对原格式有效。


Chamber九项移动交互：`src/lib/page-back.ts`／`src/page-back.css`统一完整页返回，`form-input.ts`处理连续助记词及键盘上四格，`password-keypad.ts`保留验证交接画布；邀请重发与短列表定位位于`server/chamber-invitations.mjs`／`src/app.ts`。范围见[九项V1](../requirements/2026-10-18-chamber-mobile-refinements/README.md)，长期边界D-068及视觉V1.16；回归为Chamber单测／整链、聊天UI、数字密码及移动调试。

Chamber验证码续接与忘记应用锁：`server/chamber-invitations.mjs`区分长期邀请／30分钟码，`src/app.ts`管理双端过期与重取、先核对身份再设新锁；根包装取消写入在`src/lib/vault.ts`，桌面无侧栏由`desktop-workspace.ts`控制。范围与授权见[本轮V1](../requirements/2026-10-18-chamber-invite-recovery/README.md)，长期边界D-067、视觉V1.15；专项为邀请单测及Chamber／数字／桌面浏览器。

Chamber邀请／应用锁修订：重发立即出码与截止、原位卡片、统一数字验证及单次邀请验证在`src/app.ts`／`password-dialog.ts`，双PRF操作在`platform-vault.ts`，过期及占位在`server/chamber-invitations.mjs`。范围、豁免及验证由[本次V1](../requirements/2026-10-18-chamber-invite-lock-fixes/README.md)拥有，视觉参数为移动规范V1.13；不表示已部署或真机通过。

Chamber入口与隐私修订：创建直达保护、启动失败兜底和邀请状态在`src/app.ts`；占位即生成验证码在`server/chamber-invitations.mjs`，本机倒计时默认关及离开开关在`src/lib/idle-lock.ts`。界面与品牌使用`entry-experience.css`、`entry-art.ts`、`numeric-password.css`；边界见D-064及[本轮记录](../requirements/2026-10-17-chamber-refine/README.md)，专项为Chamber／数字密码／隐私／设置浏览器及邀请／idle-lock单测。

运维Mac主动拉取备份：`scripts/mac-backup.mjs`、`server/backup-transfer.mjs`；安装入口 `scripts/install-mac-backup.mjs`、`scripts/configure-mac-backup-server.mjs`。独立回执与健康、资源上限及离线限制见 [OPERATIONS.md](../../OPERATIONS.md#mac-主动拉取模式)，专项 `tests/backup-transfer.test.ts`。

# Quiet Room 项目地图

本浏览器创建数量限制：`vault.ts`核验本机原始创建端及去重，复用跨标签页租约保存创建意图；`own-space-directory.ts`只读移除记录释放名额。`app.ts`入口预检并复核，加入不占名额。回归为`tests/new-room-creation-limit.e2e.mjs`，已纳入完整浏览器门禁；产品边界由NEW_ROOM_ARCHIVES与[需求V1](../requirements/2026-10-28-browser-created-room-limit/README.md)拥有。

手工备份加固V1：`scripts/backup.mjs`默认严格容量准入并明确保留全部旧点，仅显式`--retain-days N`才启用既有成功校验后的UTC日期保留；自动worker保持原策略。`tests/manual-backup.test.ts`验证失败保留、参数和容量边界，`tests/disaster-recovery.test.ts`经真实手工入口完成隔离计时演练。范围／测量见[备份V1](../requirements/2026-10-27-audit-backup-safety/README.md)，不代表生产RTO或外部告警／不可变存储已完成。

审计滥用防护V1：`server/request-limits.mjs`统一可信代理单地址规范化与有界配额，`server/index.mjs`为MLS事件／welcome、附件complete和push DELETE补来源／设备限制；`server/admin.mjs`隔离来源尝试并保留密码校验单并发，畸形路径返回400。契约与阈值见SECURITY当前摘要，确认及证据见[整改V1](../requirements/2026-10-27-audit-abuse-hardening/README.md)；回归为request-limits、abuse-controls、admin-abuse及既有admin／push／部署测试。仓库代理配置不代表已安装到生产。

待发取消与迟到回传：`src/lib/vault.ts`原子移除待发并另存本人设备绑定、只供接收核验的加密记录，`app.ts`正常本人回传落盘后原子退役；旧客户端不会把该记录当待发送项。专项`tests/cancelled-send.e2e.mjs`覆盖真实双端MLS、提交前／后取消、刷新／重连、事务中断及篡改拒绝，已注册浏览器门禁。修复前失败、授权与兼容限制见[本次记录](../requirements/2026-10-27-cancel-accepted-validation/README.md)。

PC 八项与 macOS：`src/pc-layout.css`、`app.ts`修复桌面页几何和输入底色；`own-room-access.ts`与独立`own-admission`服务器邮箱实现本人已发现密室申请，复用原成对认证与 MLS 加入。`tests/pc-room-access.e2e.mjs`覆盖实际链路；`desktop/macos`及`npm run build:macos`生成本机独立包。范围与平台缺口见[需求 V1](../requirements/2026-10-26-pc-eight-macos/README.md)。

本人设备目录：`src/lib/own-space-directory.ts`、`server/own-space-directory.mjs`，同角色设备逐端加密/签名同步有界目录元数据；发现目录不授权成员或历史，列表移除保留已有数据。契约由`PRODUCT.md`、`NEW_ROOM_ARCHIVES.md`、`SECURITY.md`拥有，单元为`tests/own-space-directory.test.ts`，真实双浏览器回归由`tests/spaces.e2e.mjs`中的`tests/fixtures/own-space-directory.mjs`执行。系统媒体会话清理由`src/lib/system-media-session.ts`统一处理，实际iOS锁屏卡片需另验。

十三项体验修复：[需求V1](../requirements/2026-10-24-ui-13-fixes/README.md)；`tab-unread.ts`绘制只读未读favicon，`vault.ts`／`app.ts`原子取消待发并核验发送前持久记录；`meme-picker.ts`独立读取添加目录，公共Fluent缓存由`public/sw.js`按版本管理。对应回归沿用settings-v14、message-deletion、frontend-lifecycle及meme-picker／media-upload。

融合消息体系的语音V2.3：`voice-player.ts`、`voice-messages.css`与`design-system.css`管理40主体／44目标、总宽默认最多220、同排右侧下移3px的时间／回执，以及共享消息主题；`app.ts`把独立回执放入播放器网格，刷新不打断播放。真实几何、四配色／200%文字、加载／重试及原生播放回归为`voice-message-ui.e2e.mjs`，并与voice-flow/lifecycle联合；确认由[本次V2.3](../requirements/2026-10-24-voice-bubble-integrated/README.md)拥有。iOS27.2杂音续查仍由[旧语音需求](../requirements/2026-10-23-voice-quality-bubble/README.md)拥有；合成对照不代表真机音质修复。

重新接入历史归属：`vault.ts`为新本机主密钥分配独立记录范围，逐槽核验原历史所有者并在新槽位关联；`app.ts`覆盖原目录不可见的接替与旧错误会话刷新，保留两份来源槽位。`vault-lifecycle`验证缺失／篡改投影、较早检查点、取消及陈旧守卫；`new-room-flows/mobile`共享`fixtures/repair-history-scope.mjs`覆盖新建另一密室、邀请方离线后上线、原历史／附件／撤回及旧故障会话。边界及阶段见[历史归属V1](../requirements/2026-10-22-repair-history-scope/README.md)。

自动备份容量：`src/lib/vault.ts`统一v2/v3载荷读写的8 MiB字符上限，并在加密前阻止超限普通／MLS原子写入；旧限制误拒的完整记录可按原材料打开。`vault-lifecycle`验证精确边界、认证及原子保留，`room-archive-lifecycle`以Chromium／WebKit验证完整附件分块及中断续传，`new-room-flows/mobile`覆盖双端自动备份后刷新及设备接替。证据及限制见[容量修复V1](../requirements/2026-10-22-vault-archive-size/README.md)。

设备接入失效独立页（2026-10-21）：`src/app.ts`及`src/room-polish.css`管理终止接入呈现、三步指引与刷新／列表守卫，`Vault.localAccessDeniedDeviceId`仅为加密本机设备绑定提示。真实服务及重入专项`tests/device-access-page.e2e.mjs`已注册浏览器门禁，旧格式撤销继续由audit-interactions验证；范围与证据见[需求V1](../requirements/2026-10-21-device-access-page/README.md)。

聊天与设置修订：`app.ts`／`chat-visuals.ts`管理媒体回复、渐变和导航，`passkey-management.ts`、`space-drawer.ts`与`chamber-refinements.css`管理名称／遮蔽／在线样式；`meme-picker.ts`即时Emoji、`voice-recorder.ts`实时裁剪。范围与授权由[本轮V1](../requirements/2026-10-19-mobile-settings-chat-fixes/README.md)拥有，视觉V1.18；主回归为mobile-settings-chat-fixes及原聊天／身份／媒体专项。

旧空间迁移已按用户要求撤下：迁移模块与接口删除，`chamber-space.ts`隔离历史未完成绑定，保留旧恢复卡和普通备份。新密室身份、双根历史解密和共同恢复保留。当前范围见[移除需求](../requirements/2026-10-19-remove-legacy-migration/README.md)；回归为`retired-chamber-state.test.ts`、`chamber-lifecycle.test.ts`、`legacy-chamber-retirement.e2e.mjs`及Chamber整链。此前十二项界面修订由`settings-layout.ts`、`page-back.ts`与`chamber-refinements.css`继续维护。

删除附件回收与旧协议重试：`server/storage.mjs`／`server/cloud-backups.mjs`的持久清理队列保留待清文件配额，`src/lib/vault.ts`／`src/app.ts`在发送前准备legacy待发密文。回归为`tests/room-cleanup.test.ts`、`tests/waiting-space-delete.test.ts`及`tests/vault-lifecycle.e2e.mjs`；范围与证据见[审计修复V1](../requirements/2026-10-18-audit-storage-legacy-fixes/README.md)。

空间／语音十四项：`app.ts` 原参与者MLS启动／密文队列与导航，`browser-access.ts`目录等待状态、`platform-vault.ts`新保护WebView策略及`voice-recorder.ts`选区文件／冻结重试；实组件回归`tests/mobile-space-voice.e2e.mjs`／`voice-gestures.e2e.mjs`，范围与授权见[需求记录](../requirements/2026-10-15-mobile-space-voice/README.md)。

移动端十项连续性修复：`src/lib/composer-panel-motion.ts`、`meme-picker.ts`及`app.ts`管理面板／键盘交接，`chat-keyboard-underlay`与输入行分别拥有其绘制平面；定向例在`tests/fixtures/mobile-ten-fixes.mjs`，由既有`mobile-safari-feedback.e2e.mjs`执行。确认与证据见[十项需求](../requirements/2026-10-15-mobile-ten-fixes/README.md)，长期参数见移动视觉规范V1.8。

发布效率／验证分级：`scripts/check-delivery.mjs`、`scripts/ci-scope.mjs` 与[规程](../workflows/publish-efficiency.md)；工具改动使用delivery专项，应用发布仍要求精确完整CI。准备／续跑／独立回读入口沿用 `scripts/publish.mjs`。

Codex 本地移动调试：`scripts/dev-mobile.mjs`、`tools/mobile-debug/`、`.agents/skills/quiet-room-mobile-debug/`；统一入口 `npm run dev:mobile`，专项 `tests/mobile-debug.e2e.mjs` 已接入完整浏览器门禁。跨电脑与权限边界见 [工作流](../workflows/mobile-debug.md)，7条产品批注与待确认输入浮层见 [需求记录](../requirements/2026-10-14-mobile-debug-feedback/README.md)。

移动交互连续性V1及iPhone验收修订：设置直接全屏与空间横向导航、满宽表单、键盘重开、末行定位及合并Emoji／贴纸入口，长期契约见DESIGN／PRODUCT／MEMES与[确认及验证记录](../requirements/2026-10-14-mobile-interaction-polish/README.md)；相关入口为`half-sheet.ts`、`space-drawer.ts`、`form-input.ts`、`meme-picker.ts`与`app.ts`；本次七项修正和专项入口见[验收修订](../requirements/2026-10-14-mobile-safari-feedback/README.md)。

CI 镜像与双独立环境：`scripts/ci-image.mjs`、`scripts/deploy-config.mjs`、`scripts/publish.mjs`／`release.mjs` 与 `.github/workflows/ci.yml`；按精确 main CI run／attempt 校验并传输对应架构镜像。配置、发布与独立回读均选择同一命名环境。缓存维护为独立 root 工具 `deploy/server/quiet-room-cache-maintenance`，不进入每日定时器。契约与验证见[本次需求](../requirements/2026-10-12-ci-image-environments/README.md)、DEPLOYMENT 与 OPERATIONS；源代码存在不代表生产已安装或清理。

独立空环境首次部署：固定入口的显式 `--initialize` 需要独立命名来源、root 配置允许和真实空状态证据，使用真实 TLS／流量闸门及启动后健康检查；已有更新流程继续使用常规入口。首次失败保留数据和闸门，拒绝重复初始化。契约见 [DEPLOYMENT](../../DEPLOYMENT.md#first-deployment-to-an-independent-empty-environment)，测试为 `tests/deploy-initialize.test.ts`，东京采购与实际安装状态由[本任务记录](../requirements/2026-10-27-aws-tokyo-public/README.md)拥有。

备份与恢复双入口：`src/lib/backup-settings-ui.ts`、`src/lib/history-restore-ui.ts`；跨设备授权在 `cloud-backup.ts` / `local-history-backup.ts`，角色级开关在 `server/cloud-backups.mjs`。验证含 `tests/backup-access.e2e.mjs`；边界见 [恢复契约](../../RECOVERY_BACKUPS.md) 与 [需求记录](../requirements/2026-09-28-backup-recovery/README.md)。

后台工作区 V1：`src/admin/workspace.ts` 实现六入口的查询与详情，`server/admin-data.mjs` 投影新旧归档元数据，`server/admin-diagnostics.mjs` 有界读取只读回执。回归为 `admin-data.test.ts`、`admin-workspace.e2e.mjs` 与既有后台专项；来源删除不影响新版归档。范围见[本次需求](../requirements/2026-10-25-admin-v1/README.md)。

后台组件层：`src/admin/ui.ts`、`src/admin.css`，页面与验证契约见
[后台组件与页面](../workflows/admin-ui.md)。后台页面由 `src/admin.ts` 编排，共用表格、分页、状态与错误处理组件。

本机 PDF／EPUB／文本阅读：`src/lib/document-reader.ts`、`src/lib/pdf-reader.ts`、`src/lib/epub-reader.ts`、
`src/lib/epub-archive.worker.ts`、`src/lib/document-paging.ts`、`src/document-reader.css`；文件格式图标在 `src/lib/file-format.ts`。
专项 `tests/document-reader.e2e.mjs`，附件接入与锁定回归仍在 `tests/file-flow.e2e.mjs`、
`tests/file-interactions.e2e.mjs`。范围与安全边界见 [D-038](decisions.md#d-038pdf-与文本改用本机内置阅读器)。

聊天工具与附件收藏入口：`src/chat-tools.css`、`src/lib/attachment-favorites.ts`、`src/app.ts`。
空输入框长按与圆弧录音层：`src/lib/voice-gesture.ts`、`src/lib/voice-recorder.ts`。
产品范围见 [PRODUCT.md](../../PRODUCT.md#chat-tools-and-attachment-favorites)，验证见
`tests/chat-tools.e2e.mjs`、`tests/attachment-favorites.test.ts`、`tests/voice-gestures.e2e.mjs`。
该收藏是加密本机标识投影，与下方梗图独立副本不同。

更新时间：2026-09-07。本页用于按任务定位，不复制完整产品说明或目录树。相对路径均从仓库根目录计算。

需求协作：所有变更先按[需求澄清与设计确认](workflow.md#需求澄清与设计确认)推进；页面需求先原型与业务流程图，参考根 `DESIGN.md` 和实际样式／组件。记录使用[最小需求模板](../requirements/TEMPLATE.md)，保存遵循[轻量规则](workflow.md#需求材料的轻量保存)。

空白双击主动锁定：`src/lib/blank-double-lock.ts`、`src/app.ts`；验证 `tests/blank-double-lock.e2e.mjs`（Chromium／桌面 WebKit），引用定位整气泡反馈由 `tests/chat-continuity.e2e.mjs` 验证。契约见 D-054。

桌面双栏与收展：`src/lib/desktop-workspace.ts`、`src/desktop.css`；验证 `tests/desktop-layout.e2e.mjs`，复用下方空间/隐私回归。

私密空间列表与在线样式：`src/lib/space-drawer.ts`、`src/spaces.css`、`src/lib/spaces.ts`；
本机加密预览与只读未读计数的契约见 `PRODUCT.md`、`SECURITY.md`，专项为
`tests/spaces.test.ts`、`tests/spaces.e2e.mjs`、`tests/space-drawer-ui.e2e.mjs`。
空间私有头像与创建编辑：`src/lib/space-profile-ui.ts`、`space-avatar.ts`、`avatar-crop.ts`、`half-sheet.ts`、`src/space-profile.css`；资源 `public/space-avatars/`，来源 `src/lib/space-avatar-catalog.json`；验证 `tests/space-avatar.test.ts`、`tests/space-profile.e2e.mjs`。

## 一分钟认识项目

- 每个新会话先读[固定交付流程](workflow.md#固定交付流程)：统一同步、盘点、集成、验证、PR、发布、回读和对账；[入口生效范围](maintenance.md#新会话入口)说明旧工作树与跨电脑的规则加载。
- 技术栈：原生 TypeScript/DOM + Vite 前端，Node.js ESM 服务端，SQLite 和文件系统密文存储，Vitest 与 Playwright 测试。
- 运行要求：Node.js 24 或以上；服务端使用内置 `node:sqlite`。
- 前端启动：`src/main.ts` 加载样式、实例化 `QuietRoomApp`，并在生产环境注册 Service Worker。
- 主要编排：`src/app.ts` 管理页面、会话、生命周期、消息、附件、相册和通话接入。项目不是 React 应用。
- 服务入口：`server/index.mjs` 提供 HTTP/WebSocket、认证、安全头与资源限制；`server/storage.mjs` 管理 SQLite、序号、设备历史边界及密文附件状态。
- 正式来源：`https://ai.shui.click`；单机开发通常使用 `http://localhost:5173`，局域网通行密钥真机测试必须使用设备信任且主机名匹配的稳定 HTTPS 来源。

## 按任务查找

梗图面板与本机收藏见 [MEMES.md](../../MEMES.md)、`src/lib/meme-picker.ts`、`src/lib/meme-media.ts`、
`src/lib/vault.ts` 的收藏存储及 `src/memes.css`；专项为 `tests/meme-media.test.ts` 和 `tests/meme-picker.e2e.mjs`。
表情消息分类见 `src/lib/expression-media.ts`、`src/lib/message-payload.ts` 和
`tests/expression-media.test.ts`；加密呈现标记、旧内置摘要识别及保险箱过滤边界见
[D-037](./decisions.md#d-037表情呈现文件阅读器与跨版本说明)。
后台资源库和采集任务见 `server/expression-catalog.mjs`、`server/admin.mjs`、`src/admin.ts`、`tests/expression-catalog.test.ts` 与 `tests/admin-collection-ui.e2e.mjs`；前端默认与搜索只读取已上架资源。公开 Signal 与 Noto 动画目录用于管理员显式采集，受限传输见 `server/memes.mjs`、`server/sticker-source.mjs`、`server/noto-source.mjs`；真实联网验收见 `tests/admin-collection-live.e2e.mjs`。旧预置清单用于历史识别、`tests/sticker-library.test.ts` 完整性验证及显式初始化；`npm run expressions:initialize` 经 `server/shipped-expressions.mjs` 校验后原子入库并上架，不在启动时自动执行。搜索范围和真实联调证据见 MEMES 与状态页，不把合成搜索视为上游可用性证明。

| 领域 | 先读 | 代码入口 | 主要验证入口 |
| --- | --- | --- | --- |
| 产品语义与交互 | `PRODUCT.md`、`README.md` | `src/app.ts`、各 CSS 文件 | `tests/browser.e2e.mjs`、`tests/ui-audit.e2e.mjs`、相关专项浏览器脚本 |
| Chamber个人助记词、前置应用锁、唯一邀请与独立新设备 | `CHAMBER_IDENTITY.md`、[本轮确认](../requirements/2026-10-16-personal-mnemonic-friends/README.md) | `personal-identity*.ts`、`personal-device*.ts`、`personal-directory*.ts`、`chamber-invitations.ts`及对应`server/*.mjs`、`src/app.ts` | `tests/personal-*.test.ts`、`challenge-join-server.test.ts`、`chamber-invitations.test.ts`、`chamber-passkey.e2e.mjs`、`chamber-flow.e2e.mjs` |
| 双根历史解密、签名关闭、共同恢复及旧迁移停用 | `CHAMBER_IDENTITY.md`、`RECOVERY_BACKUPS.md`、`SECURITY.md` | `src/lib/joint-history-keys.ts`、`chamber-history*.ts`、`chamber-lifecycle.ts`及对应服务端 | `tests/joint-history-keys.test.ts`、`chamber-history-record.test.ts`、`chamber-lifecycle.test.ts`、`chamber-flow.e2e.mjs`、`legacy-chamber-retirement.e2e.mjs` |
| 启动、页面状态、版本更新、Service Worker | `README.md`、`PRODUCT.md`、`RELEASING.md` | `release.json`、`release-history.json`、`src/main.ts`、`src/lib/release-update.ts`、`public/sw.js` | `tests/frontend-lifecycle.e2e.mjs`、`tests/release-update.e2e.mjs`、`tests/release-update.test.ts`、`tests/service-worker.test.ts` |
| 文字草稿、刷新与提交后清除 | `PRODUCT.md` 的 Conversation Continuity、`SECURITY.md` 的 Device-local text checkpoints | `src/lib/draft-checkpoint.ts`、`src/lib/vault.ts`、`src/app.ts` | `tests/draft-checkpoint.test.ts`、`tests/draft-refresh.e2e.mjs`（Chrome／桌面 WebKit，真实刷新、事务中断、ABA、多标签页与双端 MLS） |
| 聊天日期、气泡回执、回到最新消息与键盘跟随 | `PRODUCT.md` 的 Message Timeline、`TEST_PLAN.md` | `src/lib/message-date.ts`、`src/lib/chat-bottom-control.ts`、`src/lib/chat-viewport-motion.ts`、`src/lib/chat-keyboard-layout.ts`、`src/app.ts`、`src/chat-layout.css`、`src/styles.css` | `tests/message-timeline.e2e.mjs`、`tests/chat-bottom-control.e2e.mjs`、`tests/chat-list-viewport.e2e.mjs`、`tests/frontend-lifecycle.e2e.mjs`、`tests/chat-viewport-motion.test.ts`、`tests/chat-keyboard-layout.test.ts` |
| 设备邀请与参与者邀请分类 | `PRODUCT.md`、`SECURITY.md` | `src/lib/invite-link.ts`、`src/lib/vault.ts`、`src/app.ts` | `tests/invite-link.test.ts`、`tests/platform-vault.test.ts`、`tests/browser.e2e.mjs` |
| 全局空闲锁定、隐私遮罩、系统弹窗 | `PRODUCT.md`、`SECURITY.md`、`TEST_PLAN.md` | `src/app.ts`、`src/lib/idle-lock.ts`、`src/lib/desktop-access.ts`、`src/lib/idle-lock-prompt.ts`、`src/idle-lock.css`、`src/cover.css`、`src/auth-recovery.css`、`src/lib/vault.ts` | `tests/idle-lock.test.ts`、`tests/privacy-surface.e2e.mjs`、`tests/desktop-privacy.e2e.mjs`、`tests/desktop-session-flow.e2e.mjs`、`tests/system-surfaces.e2e.mjs`、`tests/vault-resume.e2e.mjs`、`tests/chat-image-privacy.e2e.mjs` |
| 消息格式、签名和协议校验 | `SECURITY.md`、`PRODUCT.md` | `src/lib/types.ts`、`src/lib/message-payload.ts`、`src/lib/crypto.ts`、`server/protocol.mjs` | `tests/crypto.test.ts`、`tests/message-payload.test.ts`、`tests/protocol.test.ts`、`tests/room-protocol.test.ts` |
| MLS、多设备、成员变更与历史边界 | `SECURITY.md`、`PRODUCTION_SECURITY_GATE.md` | `src/lib/mls.ts`、`src/lib/vault.ts`、`server/storage.mjs` | `tests/mls.test.ts`、`tests/storage.test.ts`、`tests/upgrade-safety.test.ts` |
| 多浏览器认可、逐空间对方授权 | [S5 需求](../requirements/2026-09-22-browser-access/README.md)、`SECURITY.md` | `src/lib/browser-access.ts`、`src/lib/browser-access-proof.mjs`、`src/lib/browser-access-ui.ts`、`server/browser-access.mjs`、`src/lib/mls.ts`、`src/app.ts` | `tests/browser-access.test.ts`、`tests/browser-access.e2e.mjs` |
| 通行密钥、本机保险库、恢复、待发箱 | `SECURITY.md`、`README.md` | `src/lib/platform-vault.ts`、`src/lib/passkey-management.ts`、`src/lib/vault.ts` | `tests/passkey-management.e2e.mjs`、`tests/platform-vault.test.ts`、`tests/recovery.test.ts`、`tests/recovery-server.test.ts`、`tests/vault-lifecycle.e2e.mjs`、`tests/vault-resume.e2e.mjs` |
| 自动恢复备份、新码轮换、显式历史恢复 | `RECOVERY_BACKUPS.md`、`SECURITY.md` | `src/lib/backup-crypto.ts`、`src/lib/cloud-backup.ts`、`src/lib/history-restore-ui.ts`、`src/lib/vault.ts`、`server/cloud-backups.mjs` | `tests/cloud-backups.test.ts`、`tests/cloud-backup-lifecycle.e2e.mjs`、`tests/history-restore.e2e.mjs`、`tests/browser.e2e.mjs` |
| 双人恢复、邀请进度、本地聊天备份 | `RECOVERY_BACKUPS.md`、`LOCAL_HISTORY_BACKUPS.md`、[D-041](decisions.md#d-041双人恢复后其他旧设备必须重新授权) | `src/lib/joint-recovery.ts`、`server/joint-recovery.mjs`、`src/lib/local-archive.ts`、`src/app.ts` | `tests/joint-recovery.test.ts`、`tests/joint-recovery.e2e.mjs`、`tests/local-archive.test.ts`、`tests/local-history-backup.e2e.mjs` |
| 会话管理后台与采集任务 | `RECOVERY_BACKUPS.md`、`MEMES.md`、`DEPLOYMENT.md` | `src/admin.ts`、`server/admin.mjs`、`server/expression-catalog.mjs`、`server/admin-auth.mjs`、`scripts/admin-setup.mjs`、`compose.admin.yaml` | `tests/admin.test.ts`、`tests/expression-catalog.test.ts`、`tests/backup-admin-ui.e2e.mjs`、`tests/admin-collection-ui.e2e.mjs`、`tests/deploy-admin.test.ts` |
| API、WebSocket、服务端资源控制 | `README.md`、`SECURITY.md` | `src/lib/api.ts`、`server/index.mjs`、`server/storage.mjs`、`server/protocol.mjs` | `tests/api.test.ts`、`tests/server.test.ts`、`tests/storage.test.ts` |
| 照片、视频、普通文件和创建者保险箱（相册 / 文件） | `PRODUCT.md`、`README.md`、`SECURITY.md`、`TEST_PLAN.md`、[D-024](./decisions.md#d-024保险箱本地整理与聊天删除严格分层) | `src/lib/file-crypto.ts`、`src/lib/media-dimensions.ts`、`src/lib/image-batches.ts`、`src/lib/video-media.ts`、`src/lib/video-poster.ts`、`src/lib/media-upload-view.ts`、`src/lib/image-viewer-gestures.ts`、`src/lib/gallery-curation.ts`、`src/app.ts`、`src/gallery.css` | `tests/file-attachments.test.ts`、`tests/message-payload.test.ts`、`tests/image-batches.test.ts`、`tests/video-media.test.ts`、`tests/image-viewer-gestures.test.ts`、`tests/gallery-curation.test.ts`、`tests/video-flow.e2e.mjs`、`tests/video-upload.e2e.mjs`、`tests/media-upload.e2e.mjs`、`tests/file-flow.e2e.mjs`、`tests/file-outbox.e2e.mjs`、`tests/file-interactions.e2e.mjs`、`tests/chat-image-privacy.e2e.mjs`、`tests/gallery-loading.e2e.mjs`、`tests/frontend-lifecycle.e2e.mjs`、`tests/cloud-backup-lifecycle.e2e.mjs` |
| 语音留言 | `PRODUCT.md`、`README.md` | `src/lib/voice-gesture.ts`、`src/lib/voice-recorder.ts`、`src/lib/voice-audio.ts`、`src/lib/voice-player.ts`、`src/voice-messages.css` | `tests/voice.test.ts`、`tests/voice-lifecycle.e2e.mjs`、`tests/voice-gestures.e2e.mjs`、`tests/voice-flow.e2e.mjs` |
| 实时音视频通话 | `CALLS.md`、`SECURITY.md` 的通话构造、`DEPLOYMENT.md` 的可选中继部署段与当前状态页 | `src/lib/call-*.ts`、`src/call.css`、`server/calls.mjs` | `tests/call-*.test.ts`、`tests/call-flow.e2e.mjs`、`tests/call-native.e2e.mjs`、`tests/call-view.e2e.mjs` |
| 回应、回复手势、消息删除、未读计数和 presence | `PRODUCT.md`、`SECURITY.md`、[D-024](./decisions.md#d-024保险箱本地整理与聊天删除严格分层) | `src/lib/reactions.ts`、`src/lib/reply-swipe.ts`、`src/lib/message-deletions.ts`、`src/lib/message-payload.ts`、`src/lib/unread-counter.ts`、`src/lib/message-read.ts`、`src/lib/presence-circuit.ts`、`src/presence-circuit.css`、`src/lib/api.ts`、`server/index.mjs`、`server/storage.mjs` | `tests/reactions.test.ts`、`tests/reply-swipe.test.ts`、`tests/message-deletions.test.ts`、`tests/message-deletion.e2e.mjs`、`tests/reaction-history.e2e.mjs`、`tests/unread-counter.test.ts`、`tests/unread-server.test.ts`、`tests/unread-counter.e2e.mjs`、`tests/message-read.test.ts`、`tests/message-read.e2e.mjs`、`tests/presence-circuit.e2e.mjs`、`tests/presence-persistence.test.ts` |
| Web Push | `OPERATIONS.md`、`SECURITY.md` | `src/lib/push.ts`、`src/lib/device-notifications.ts`、`src/lib/notification-settings.ts`、`src/lib/notification-policy.ts`、`server/push.mjs`、`public/sw.js` | `tests/push.test.ts`、`tests/push-server.test.ts`、`tests/device-notifications.test.ts`、`tests/notification-capability.test.ts`、`tests/notifications.e2e.mjs` |
| 本机 main 集成、局域网测试与跨电脑同步 | [`docs/workflows/local-lan-testing.md`](../workflows/local-lan-testing.md)、本工作流、`README.md` | 共享本机 `main` 工作树、实际 Vite／服务端进程；主机名、证书和数据为每台电脑的本机配置 | 候选与本机 main 精确 SHA、进程工作目录、前端目标代码回读、后端健康接口、局域网 HTTPS 真机记录 |
| 构建、发布、备份与运维 | `RELEASING.md`、`DEPLOYMENT.md`、`OPERATIONS.md`、`PRODUCTION_SECURITY_GATE.md` | `scripts/deploy-config.mjs`、`scripts/deploy-setup.mjs`、`scripts/repo.mjs`、`scripts/publish.mjs`、`scripts/release.mjs`、`scripts/production-readback.mjs`、`deploy/`、`.github/workflows/ci.yml` | `tests/deploy-*.test.ts`、`tests/release.test.ts`、`tests/publish.test.ts`、`tests/production-readback.test.ts`、`tests/backup.test.ts`、`tests/operations-*.test.ts` |
| 发布后生产事实、上下文治理与交付效率 | `RELEASING.md`、`docs/context/maintenance.md`、[D-021](./decisions.md#d-021生产回读后对账知识库语义变化继续审阅)、[2026-09-05 交付复盘](../../audit/2026-09-05-mobile-ux-delivery-retrospective.md) | 发布与最小 SHA 回执为 `scripts/publish.mjs`、`scripts/release.mjs`；独立结构化回读为 `scripts/production-readback.mjs`；格式检查为 `scripts/check-docs.mjs`，自动文档 PR 对账尚待实现 | `tests/publish.test.ts`、`tests/release-entry.test.ts`、`tests/production-readback.test.ts`、`tests/ci-docs.test.ts`、`tests/ci-scope.test.ts` |

新增交付工具：`scripts/prepare-release.mjs` 生成与应用版本计划；`scripts/delivery-evidence.mjs` 执行既有门禁并汇总脱敏证据。使用与固定批次规则见 [工作流](workflow.md#固定批次发布2026-09-10)，回归为 `tests/delivery-tools.test.ts`。

## 测试命令的准确含义

架构资源边界：`server/byte-budget.mjs`、`server/socket-budget.mjs`、`src/lib/history-projection.ts`、`scripts/backup-state.mjs`／`backup-health.mjs`。构建新增 `tsconfig.resource-boundaries.json` 严格 checkJs；定向回归为 `tests/resource-bounds.test.ts`，加密历史对照测量是手动 `node tests/history-memory.benchmark.mjs`，不属于正确性门禁。协议、预算与实际证据见[逐项验收](../requirements/2026-09-30-architecture-resource-optimization/README.md)和[测量限制](../requirements/2026-09-30-architecture-resource-optimization/measurements.md)。

本地聊天备份：`LOCAL_HISTORY_BACKUPS.md`、`src/lib/local-archive.ts`、`src/lib/local-history-backup.ts`、`src/lib/local-backup-file.ts`；回归为 `tests/local-archive.test.ts` 和 `tests/local-history-backup.e2e.mjs`。双人恢复协议为 `src/lib/joint-recovery.ts` 与 `tests/joint-recovery.test.ts` / `tests/joint-recovery.e2e.mjs`。旧自动备份隐藏入口为 `#legacy-backup` 与 `#legacy-recovery`。

本人归档自动备份开关与分类数见 `src/lib/archive-settings.ts`、`room-archive.ts` 和 `src/app.ts` 的备份运行期；断点、统计与损坏回归为 `tests/room-archive-lifecycle.e2e.mjs`，开关、来源画布和视觉为 `tests/settings-v14.e2e.mjs`。

聊天遮蔽位图实现见 `src/lib/concealed-image.ts`；高斯像素验证为
`tests/concealed-image.test.ts`，编码中锁定、URL 释放和聊天显隐回归沿用
`tests/chat-image-privacy.e2e.mjs`。它只生成解锁运行期的内存预览，不替代原始附件。

- `npm run tasks:cleanup -- --plan /绝对路径/plan.json`：发布后任务资源只读检查，加 `--apply` 才清理；入口 `scripts/cleanup-task-resources.mjs`，回归 `tests/cleanup-task-resources.test.ts`，计划与保留边界见[说明](../workflows/task-cleanup.md)。不属于生产切换入口。
- `npm run build`：TypeScript 类型检查后构建 Vite 产物。
- `npm test`：运行 Vitest 自动发现的单元/集成测试；它不等于浏览器回归。
- `npm run check`：依次运行 build 与 Vitest。
- `npm run test:browser`：通过 `scripts/test-browser.mjs` 串行运行全部真实浏览器脚本，并输出逐脚本和总耗时。`-- --group 1` / `-- --group 2` 分别运行主流程与其余专项；CI主流程独立运行，其余专项按已记录耗时分为四个独立runner，同树不并发。测量数据只影响分片分配，未知脚本仍执行；完整分组顺序及浏览器轮数保留。
- `npm run check:full`：运行 `check`，然后运行浏览器套件。
- `npm run deploy:readback -- --sha <40位SHA>`：独立、只读地复核该精确生产版本，输出逐阶段耗时与失败分类，并在 `.git/quiet-room-readback/` 保存脱敏结构化证据；它不发布、不回滚，也不替代发布授权。
- `npm run test:weak-network`：通话控制器、配置、信令确认和语音重试专项，以及 Chrome 信令/质量输入和 CDP WebRTC 网络故障注入；不等于真机或实际 TURN 验收。
- `npm run test:calls`：完整通话专项入口，包含部分 Vitest 用例与 `call-native.e2e.mjs`、`call-view.e2e.mjs` 和 `call-weak-network.e2e.mjs`。`npm run test:calls:e2e` 只运行这三个浏览器专项；CI 与本地已完成 `check:full` 后使用此入口，避免重复运行已被 `npm test` 包含的通话单元测试。
- `node scripts/audit-production.mjs`：使用 npm 官方源审计生产依赖；仅对明确的临时接口故障最多尝试三次。high/critical 漏洞、无效报告和接口持续不可用均阻断 CI。

通话邀请跨层回归新增 `tests/call-delivery.test.ts`，覆盖真实 MLS 身份、加密信令、确认队列与服务端仲裁的设备掉线／接听竞争；`call-flow.e2e.mjs` 另走真实页面和认证 WebSocket 检查接听准备中取消及待替换摄像头清理。范围与分层证据见[通话修复 V1](../requirements/2026-10-27-call-reliability/README.md)。

两个容易误判的细节：

- `tests/browser.e2e.mjs` 会导入并执行 `verifyVoiceFlow` 和 `verifyCallFlow`，所以 `voice-flow.e2e.mjs`、`call-flow.e2e.mjs` 即使没有直接列在 `package.json` 的命令字符串中，仍属于浏览器主流程。
- `.github/workflows/ci.yml` 将完整验证拆为并行任务，`verify` 严格汇总必需结果；文档白名单变更使用轻量检查，其他变更和手动运行默认完整。发布必须验证精确 main 提交的最新 push／手动 CI 成功，且 `Full application verification` 成功；文档绿色结果不能作为应用发布证据。配置文件存在不能证明任意提交已经通过 CI。

浏览器脚本本地默认使用 Chrome，可通过 `CHROME_PATH` 指定程序；CI 使用安装的 Chromium。若受限环境不能监听本地端口，应把它记录为环境限制，不能记作产品失败或测试通过。

- 存储循环、三日快照和媒体缓存：[实施契约](../requirements/2026-09-24-storage-calls/storage-contract.md)。定向回归为 `message-window.test.ts`／`message-window.e2e.mjs`、`backup-retention.test.ts`、`media-cache.e2e.mjs`；`scripts/test-turn-relay.sh` 仅在隔离 Linux CI 验证真实 TURN。

## 详细资料索引

- **系统栏与明暗主题**：`src/lib/system-chrome.ts` 同步系统明暗状态并保持透明 theme-color 提示，查看器不另设不透明色值；浏览器原生工具栏仍由系统控制。
- **保险箱图片属性与动图**：`src/lib/photo-detail-model.ts` 定义有界属性展示，`photo-metadata.ts` / `photo-metadata.worker.ts` 负责本机可取消解析，`photo-details.ts` 挂载仅保险箱可见的属性面板；`image-animation.ts` 识别 GIF / 动态 WebP / APNG 并管理内存静态帧。验证入口为 `tests/image-photo.test.ts` 和已纳入 `check:full` 的 `tests/photo-details.e2e.mjs`。Live Photo 不在该功能范围内；真机、CI、生产证据与本地自动测试分开记录。
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
- [iPhone 真机调试](../workflows/iphone-debug.md)：持久 USB 工具、自动录制与键盘操作、数值探针、证据限制及媒体清理。
- [audit/](../../audit/)：特定日期和代码基线的审查证据；不能自动外推到当前工作树。

聊天连续性（历史键盘、引用往返、发送动画接续、表情状态）的专项为 `tests/chat-continuity.e2e.mjs`，与既有 `chat-list-viewport`、`chat-bottom-control`、`frontend-lifecycle` 和 `meme-picker` 一起随 `npm run check:full` 执行。确认与证据见[需求记录](../requirements/2026-09-28-chat-continuity/README.md)。

聊天定位的异步发送／上传与用户滚动竞争、收消息同时弹键盘、邻近锚点恢复及发送补齐本地尾部，由 `tests/chat-scroll-stability.e2e.mjs` 在 WebKit／Chromium 手机与桌面布局检查并纳入完整浏览器门禁。规则及真机限制见[定位稳定性需求](../requirements/2026-10-10-chat-scroll-stability/README.md)。


体验优化 F01–F15：新增本机密码保护位于 `src/lib/password-protection.ts`、`password-dialog.ts` 与 `vault.ts`，界面共用 `src/experience.css`；新密码与原设备密钥的混合恢复沿用 `joint-recovery.ts`。回归入口为 `password-protection.test.ts`、`platform-vault.test.ts`、`password-fallback.e2e.mjs`、`joint-recovery.e2e.mjs`、`local-history-backup.e2e.mjs`、`meme-picker.e2e.mjs` 和 `backup-admin-ui.e2e.mjs`。确认与验收由[本次需求记录](../requirements/2026-09-30-experience-optimization/README.md)维护，长期边界见 PRODUCT.md、SECURITY.md 和 RECOVERY_BACKUPS.md。

数字密码V1：新设置／数字日常解锁由 `src/lib/password-keypad.ts` 与 `src/numeric-password.css` 实现，`numeric-6` 标识在密码包装AAD中认证；未标记长密码沿用原输入。`tests/numeric-password.e2e.mjs` 随完整浏览器门禁验证已确认原型几何、两次输入、首位0、等待与隐私清理，真实保险库／MLS链路仍由 `password-fallback.e2e.mjs` 覆盖。取舍见D-061与[需求记录](../requirements/2026-10-15-iphone-numeric-passcode/README.md)。

### 邀请、恢复及接入状态定向回归

失效短邀请沿正常入口恢复首页或原应用锁，由 `tests/fixtures/expired-invite-entry.mjs` 随 `tests/new-room-invite-privacy.e2e.mjs` 在 Chromium／WebKit 检查失败反馈、真实创建、原保险库保留及锁定／隐藏后的迟到响应。确认与证据见[失效邀请创建修复 V1](../requirements/2026-10-27-expired-invite-create/README.md)。

Chamber聊天卡片随键盘滚动、透明浮动顶栏、加入前样式门禁、时长半屏及遮蔽演练对齐由`tests/chamber-chat-ui.e2e.mjs`覆盖真实组件；`tests/chamber-flow.e2e.mjs`另覆盖邀请方停留设置、丢失连接后的加密接续及首次聊天节点保留。确认和证据见[聊天接续V1](../requirements/2026-10-18-chamber-chat-continuity/README.md)，合成视口不代表iPhone真机。

`tests/audit-interactions.e2e.mjs` 使用本地合成服务、独立浏览器密钥和虚拟认证器，覆盖同标签邀请取消重开、恢复读取重试／关闭／限流／隐藏、添加设备批准自动安装、锁定续接、返回草稿与设备撤销发送守卫；已纳入 `npm run test:browser` 第二组。可附目录参数保存脱敏截图；不代表 iPhone 真机或跨平台通行密钥同步验证。

应用锁入口／遮蔽存储等待／连续切换由`src/app.ts`、`src/lib/browser-room-key.ts`及`tests/entry-switch-repair.e2e.mjs`覆盖：真实存储租约阻塞与取消、解密迟到拒绝、明确槽位及过期选择。该专项已纳入完整浏览器第二组，同时核对18套明暗的完成勾、标题、设备行及有界连接卡片；表情交接状态另由`tests/media-upload.e2e.mjs`的明确冷／热缓存覆盖。[进入修复V1／V1.1／V1.2](../requirements/2026-10-25-expression-entry-repair/README.md)及P1 V1.33拥有范围与证据，不改变旧格式验证及历史边界。

即时设置／九套整体配色／桌面应用入口：`src/lib/appearance.ts`、`src/appearance.css`、`src/lib/app-access.ts`、`public/manifest.webmanifest`；入口由 `src/app.ts` 与扁平 `space-drawer.ts` 承载。回归 `tests/settings-appearance.e2e.mjs`、`appearance.test.ts`、`desktop-access.test.ts`、`desktop-session-flow.e2e.mjs` 和 `draft-refresh.e2e.mjs`；真实系统安装、原生通行密钥及iPhone证据单列。[确认范围](../requirements/2026-10-10-settings-appearance-desktop/README.md)取代旧默认60秒和桌面每次锁后验证的描述。九主题、经典与松绿／雾紫差异及18套明暗验证由[九主题V1](../requirements/2026-10-25-appearance-nine/README.md)及P1 V1.32补充；语音主题继承另见`voice-message-ui.e2e.mjs`。

移动表单统一输入：`src/lib/form-input.ts`／`src/form-input.css`；背景几何消费者通过 `layoutViewport()` 保持稳定，前景编辑器读取原始VisualViewport。`src/lib/gateway-intro.ts`维护入口图形三态。产品与安全边界见本次[需求记录](../requirements/2026-10-14-mobile-debug-feedback/README.md)。

恢复失败原件清理：`room-archive.ts`与`vault.ts`共用独立未发布原件范围、小型run归属见证、消息／原件引用／目录原子发布及保守旧残留回收；`tests/restore-original-cleanup.e2e.mjs`由既有room-archive-lifecycle入口顺序纳入。范围和证据见[恢复清理R2](../requirements/2026-10-27-restore-failure-validation/README.md)。
