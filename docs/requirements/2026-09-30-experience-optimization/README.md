# Quiet Room 15 项体验优化

## 身份与确认

- 阶段：正式实施；定向验收通过，完整回归进行中。
- 规则来源：本机 main `509444485ca49bd12b659d599476253a3a0d9ab3`。
- 起始基线：远端 main `61cc401caa69cc3732063c6133e8459cee79d6b7`。
- 独立分支：`codex/experience-optimization-20260930`。
- 用户于 2026-09-30 在本会话明确要求「按照方案实施，并完成验收」。范围为已展示 F01–F15 方案及密码兜底 v7；以上是可核实的本会话摘要，未提供外部永久消息链接。
- 正式实施、验收及持续远端交付已授权；生产发布需要另行确认精确提交。

## 材料与边界

- `plans.json` 保存本次确认的逐项结果、实现范围与验收标准。
- 密码 v7 材料保存设计确认记录；演示结果不作为真实产品验收证据。
- 视觉依据：现有 PRODUCT.md、DESIGN.md、共享主题／动效／组件和已审阅的 15 张效果图。
- 保持隐蔽相册入口、真实消息状态、安全遮蔽优先、原始保护方式及历史备份边界。
- 使用合成测试空间与后台浏览器，不复制凭据或真实聊天。

## 分批验收矩阵

| 风险域 | 范围 | 定向验证 | 依赖／限制 |
| --- | --- | --- | --- |
| 本地保护 | F15 | 创建、解锁、敏感操作重新验证、旧保险库、取消／超时／生命周期 | Argon2id 与随机主密钥；模拟浏览器不替代系统验证真机 |
| 共同恢复 | F01、F07 | 协助端、丢失端、双方丢失、无有效重建、签名绑定、取消 | 保留空间选择与协助端历史 |
| 聊天与媒体 | F02–F06、F09–F11 | 阅读锚点、草稿、回执、备份缺件、GIF 分批、收藏、设备名 | 不改变投递或隐藏入口权限 |
| 管理与帮助 | F08、F12、F13 | 移动批量选择、分页失败、遮蔽及备份文案 | 默认保护与云备份策略不变 |
| 动效与综合 | F14及全部 | 减少动态效果、中途反向、320／390／平板／桌面、明暗主题、全量回归 | 真机键盘与手感单独记录 |

## 验收与交付

- F01–F15 已实现；定向验收包括真实新密码创建／参与者邀请／MLS 消息、原空间重新验证、自动共同恢复与协助方历史保留、实际本地备份、GIF 分批缓存、后台批量失败和分页。完整回归及最终截图检查进行中。
- 浏览器证据使用合成空间及后台 Chrome；手机 UA／320、390px 视口属于桌面模拟，不声称为真实 Safari 或物理 iPhone。
- 密码保险库使用 v3 随机主密钥与 Argon2id 包装；DB 版本 12。旧版 v1／v2 使用独立旧格式测试夹具验证，不通过新的 createVault 冒充旧保险库。
- 审视修正：页面返回后迟到创建不再安装保险库，未使用房间清理；防止重复创建；密码取消不弹错误；320px 后台三项导航保持同一行；发出消息时间颜色使用现有 on-accent 令牌。
- 当前没有可连接 USB iPhone：原生键盘、系统验证／工具栏、后台缩略图及动效手感未验证。首次使用 5 人测试尚未开展。F14 时长是待真机确认的候选；这些项目不能标记通过，也不能凭自动测试发布。
- PR／CI／合并：待完成。
- 生产部署：不在本轮授权范围。


## 逐项实现与验收入口

| 优化 | 实际行为与期望结果 | 验收入口 |
| --- | --- | --- |
| F01 自动共同恢复 | 不选择恢复谁；各端认证后确定重建／协助，双方明确批准同一签名请求；双方可用与未知状态拒绝重建 | joint-recovery.test.ts、joint-recovery.e2e.mjs；首次理解测试未开展 |
| F02 一次相册提示 | 仅已配对创建者展示，关闭状态加密保存，弹层隐藏提示，不进入未读 | password-fallback.e2e.mjs、chat-tools.e2e.mjs |
| F03 聊天优先 | 首次主操作开始聊天，保存入口为消息流内紧凑卡，更新提示收拢 | password-fallback.e2e.mjs、chat-continuity.e2e.mjs、release-update.e2e.mjs |
| F04 部分备份 | 标明可用／缺失原文件，按类型展开；缺失时明确继续导出部分备份 | local-history-backup.e2e.mjs、password-fallback.e2e.mjs；6 条文字／4 张缺失图片对照 |
| F05 消息信息 | 长按已发消息可查看真实状态及既有发送时间；无阶段时间不补造，撤回关闭详情 | password-fallback.e2e.mjs、message-read.e2e.mjs、message-deletion.e2e.mjs |
| F06 常用与推荐 | 常用仅含使用过的项目并按次数排序；无记录推荐；五列，已加载批次去重，不遍历凑数 | meme-picker.e2e.mjs |
| F07 恢复码说明 | 短标题、折叠说明，明确各自保管／双方参与／历史另恢复；查看需原保护方式重新验证 | password-fallback.e2e.mjs、joint-recovery.e2e.mjs、backup-admin-ui.e2e.mjs |
| F08 遮蔽教学 | 正确设置路径、中性关闭确认、演练标签；硬锁仍即时遮蔽 | local-history-backup.e2e.mjs、privacy-surface.e2e.mjs |
| F09 阅读层级 | 正文 16px／消息时间 12px，收消息气泡不透明，沿用明暗令牌；测量实际合成对比度 | password-fallback.e2e.mjs；320／390／768／1440、明暗、200% 字体 |
| F10 收藏空态 | 指引长按收藏；返回原聊天位置；取消收藏不删除原消息 | password-fallback.e2e.mjs、chat-image-privacy.e2e.mjs、message-deletion.e2e.mjs |
| F11 设备名称 | 默认系统＋浏览器，备注选填 24 字符；旧记录沿用、未知稳定回退 | password-fallback.e2e.mjs、passkey-management.e2e.mjs |
| F12 紧凑后台 | 约 95px 资源行、底部已选本页操作栏、批量数量确认；失败保留选择 | backup-admin-ui.e2e.mjs；320／390、首中末页／24 项 |
| F13 备份帮助 | 入口／恢复码／历史备份各自用途；云备份默认关闭，前台解锁联网运行 | password-fallback.e2e.mjs、local-history-backup.e2e.mjs |
| F14 动效 | 100／240／280ms；沿用取消和反向机制，输入时暂停装饰、减少动态效果 | motion-system.e2e.mjs、motion-completion.e2e.mjs、chat-continuity.e2e.mjs；真机未验证 |
| F15 密码闭环 | 仅明确不支持时新空间兜底；原目标敏感操作重新验证；取消／导航／锁定拒绝迟到成功 | password-protection.test.ts、platform-vault.test.ts、password-fallback.e2e.mjs、vault-lifecycle.e2e.mjs；原生验证及首次理解测试未开展 |
