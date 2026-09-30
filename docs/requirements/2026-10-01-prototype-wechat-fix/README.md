# F01–F15 原型还原与微信密码闭环修复

## 身份与授权

- 当前阶段：正式实施及代码交付；最终候选、PR、CI 和合并以本需求关联 PR 的精确回执为准。本轮不发布生产。
- 规则来源：本机 main `1773dcbefd6f0930bc029ee833510312dd11e08d`；任务起始及冻结基线：GitHub main `61ec6e80dfc13aad8560e8cd20492538bbcbcf1a`。
- 独立分支：`codex/prototype-wechat-fix-20260930`；本机任务目录：`/Users/zhouding/ss-worktrees/prototype-wechat-fix-20260930`。接续时重新核验实际路径和 HEAD，不使用共享开发树的未提交修改。
- 用户在本会话授权完成 F01–F15 的忠实还原、微信 WebView 密码闭环修复及复测，沿用已确认方案和密码 v7，不另创视觉方向。需求／原型确认基线见[原需求记录](../2026-09-30-experience-optimization/README.md)及[密码 v7](../2026-09-30-experience-optimization/password-v7-README.md)。未提供外部永久会话定位；不补造历史签字。
- 密码回访重复超时达到流程重跑上限后，本会话于 2026-10-01 单独确认「授权继续修复和复测」。对应问题定位：`request_user_input_async / call_voVpqSnOazc81ibG2zDXtF5k / 0`；授权为每次密码页独立取消信号与忙碌状态、退场后不挡住新页、拒绝迟到结果的最小修复和验证。
- 正式实施后的提交、推送、PR、CI 与合并沿用本机 main 可核验的持续远端交付授权。生产仍须本批精确 40 位 SHA 单独确认；此前 `2026.09.30.5` 的发布授权不继承。

## 现状、方案与设计依据

起始代码已有主要业务行为，但若干界面的结构、层级、文案和控件与确认图不同。微信创建还被 UA 分支提前拦截，缺失 credential 方法可能抛出类型错误；密码回访仍用居中弹窗。修复覆盖相关页面和这些能力／生命周期边界，不改变 MLS、备份格式、双端签名恢复、原设备保护或服务端权限。

- 设计：沿用 `PRODUCT.md`、`DESIGN.md`、`src/design-system.css` 和当前蓝色明暗主题；逐项依据为[plans.json](../2026-09-30-experience-optimization/plans.json)。15 张确认图及本轮前后截图保存在本机审计目录，未提交大型媒体。
- 密码与恢复优先级：以最终 v7 的 R03 介绍页 → P05 恢复码输入弹层为准，保留独立输入步骤；早期 F01 静态图的内联输入不是此次实现目标。确认结果仍还原 F01 的步骤、核对码及双方结果卡。
- 原型：[v7 入口](../2026-09-30-experience-optimization/prototype/index.html)，流程：[密码 v7 流程](../2026-09-30-experience-optimization/password-v7-flow.md)。本次还原沿用此版本，模拟不作为产品或真机证据。
- 取消、返回、显式锁、后台、目标变化和迟到结果继续失效；缺少原文件仍明确部分备份。密码不用于跨浏览器目录发现，已有空间不改保护方式。

## 逐项验收与实现

| 项目 | 本轮修复及可观察结果 | 验证入口／限制 |
| --- | --- | --- |
| F01 共同恢复 | 三步进度、双方独立结果卡、旧设备影响；邀请二维码折叠；保留 v7 输入弹层与真实双签名 | joint-recovery.e2e.mjs、joint-recovery.test.ts；协助端保留历史，双方可用及未知不重建 |
| F02 隐藏相册提示 | 在线胶囊下居中提示、标题和「知道了」；仅创建者，关闭加密记住 | password-fallback.e2e.mjs、chat-tools.e2e.mjs；弹层、键盘及锁定延后／隐藏 |
| F03 聊天优先 | 消息流尾部单行保存入口，图标／箭头／关闭；紧凑「有新版本／查看」及更新确认 | release-update.e2e.mjs、chat-continuity.e2e.mjs；草稿、阅读锚点与既有更新规则 |
| F04 部分备份 | 警示、记录数量、实际原文件和折叠缺件分层；导出与取消可达 | password-fallback.e2e.mjs、local-history-backup.e2e.mjs；6 文字／4 缺失图片，摘要一致 |
| F05 消息信息 | 底部拉手、关闭、消息预览时间、相连状态阶段及「知道了」 | password-fallback.e2e.mjs、message-read.e2e.mjs、message-deletion.e2e.mjs；不伪造阶段时间或已读 |
| F06 GIF | 修正后加载的 memes.css 七列覆盖，实际五列；常用／推荐、分页与搜索保留 | meme-picker.e2e.mjs；完整产品样式顺序、实际 GIF 动画、跨批次去重与草稿 |
| F07 恢复码说明 | 小导航标题、两条编号要点、两行折叠说明、查看前再次验证 | joint-recovery.e2e.mjs、password-fallback.e2e.mjs、backup-admin-ui.e2e.mjs |
| F08 遮蔽教学 | 关闭叉、设置路径、中性次操作及演练提示 | local-history-backup.e2e.mjs、privacy-surface.e2e.mjs；显式锁和后台仍立即保护 |
| F09 阅读层级 | 正文 16px／时间 12px、不透明接收气泡、原明暗令牌 | password-fallback.e2e.mjs、prototype-fidelity.e2e.mjs；320／390／768／1440、200% 字体及样本对比度 |
| F10 收藏空态 | 星标、标题、两行指引、返回聊天、本机说明与折叠详情 | prototype-fidelity.e2e.mjs、chat-image-privacy.e2e.mjs、message-deletion.e2e.mjs；撤回与独立表情副本边界不变 |
| F11 设备名称 | 设备图标、角色／当前状态、底部轻提示；新微信设备识别为微信，旧名称保留 | password-fallback.e2e.mjs、passkey-management.e2e.mjs；备注 24 字符及原目标验证 |
| F12 移动管理 | 56px 品牌导航与菜单；紧凑行、选择框独立、低频操作菜单、贴底本页批量栏 | backup-admin-ui.e2e.mjs、admin-collection-ui.e2e.mjs；24 项、分页／筛选清空、失败保留 |
| F13 备份帮助 | 三张用途卡、信息条、两行折叠详情和明确返回 | prototype-fidelity.e2e.mjs、local-history-backup.e2e.mjs；云默认关闭，前台／解锁／联网条件保留 |
| F14 动效 | 使用完整样式验证反馈／面板／页面；反向十次保留草稿、十条实际 MLS 发送与立即锁定 | motion-completion.e2e.mjs、prototype-fidelity.e2e.mjs、password-fallback.e2e.mjs；记录采样实际时刻，真机手感未验证 |
| F15 密码闭环 | P03 创建及 P04 回访为完整页，P06 为带目标空间／操作的底部弹层；密码页按渲染独立取消 | platform-vault.test.ts、webview-password.e2e.mjs、password-fallback.e2e.mjs；真实加密／存储与桌面微信 UA，非物理微信 |

## 能力与安全边界

- 可选 `getClientCapabilities` 在点击前预取；只接受显式 `extension:prf === false` 为新建保护不支持。探测拒绝、字段缺失及平台验证器不可用不能排除硬件密钥，也不能作为认证证明。
- 缺少 PublicKeyCredential、credential 容器或 create/get 方法、新建保护实际 NotSupportedError／明确无 PRF 才进入 P03。旧空间解锁的失败不降级。取消、超时、未知、临时及安全错误留在原路径。
- 新密码提示前检查安全连接、WebCrypto 与一次临时非秘密 IndexedDB 写入／删除；失败给出可操作错误，不先创建房间。探测不保证剩余容量足以完成后续全部写入，实际存储错误仍沿用失败清理。
- 密码按输入的 Unicode 保存语义，允许粘贴／密码管理器，不裁剪、规范化、上传或持久保存明文；v3 随机主密钥及 Argon2id 参数不变。表单提交和退场清空输入。
- 每页拥有取消与忙碌状态；用实际成功解密被延迟的场景验证旧页退场后不能安装证明或暴露聊天，新页仍可正常验证。敏感操作继续读取并认证原目标 wrapper。
- 锁定前不读取加密目录里的空间名称，P04 使用「私密空间」；解锁后的敏感操作显示实际目标名称。开发方自审和自动测试不等于独立安全审计。

## 证据与交付边界

- 本机证据根：`/Users/zhouding/ss-worktrees/audits/prototype-wechat-fix-20261001`；`gaps.json` 保存修复前差距与逐项结果，`comparison.html` 为原型／修复前／修复后对照，`after/` 保存截图和测量。跨电脑接续需重新获取这批本机材料；Git 只保存简短记录和测试源码。
- 页面截图分为运行真实加密与服务流程的合成空间、仅用于呈现的加密夹具和可交互原型三类。完整样式夹具按生产加载顺序，表情懒加载样式也纳入；不从呈现夹具推断协议安全。
- 定向验收后冻结候选，运行 `delivery:evidence -- run check:full`；最终 SHA、文件树、耗时、单元／浏览器结果及远端 CI 在本工作树 Git 证据和关联 PR 中核实，失败不移用旧候选回执。
- 初次冻结 `de34a8e03afca200bf726230212f9e21368ba949` 构建通过，793 项测试中 4 项测试入口清单断言失败：新增两个浏览器验收后，清单仍写 50 项／第二组 49 项。同步为 52 项／51 项及对应分片、日志断言；保持每个验收入口恰好一次、串行执行及失败即停止的检查，重新冻结并重跑完整门禁。
- 验收步骤修正有记录：移动管理菜单折叠后先展开导航；连续发送先等消息信息弹层解除背景保护；迟到验证屏障使用事先读取的同一记录替换页面，避免测试自身等待串行存储锁。产品权限、输入保护、验证期限和断言未为通过测试而放宽。
- 本轮 iPhone Debug doctor 在具备本机服务权限时仍未发现可连接 USB iPhone。真实微信 WebView、iOS 键盘／原生工具栏／WebAuthn 与 PRF、Argon2id 真机性能和动效手感未验证；五人首次使用理解测试与独立安全审计未开展。
- 提交前检查新增／修改文件的体积、二进制、内嵌素材、依赖及产物误纳入。线上 `2026.09.30.5` 的历史发布事实保持原记录；本轮新版本为 `2026.09.30.6`，UTC 日期编号，不代表已发布。
