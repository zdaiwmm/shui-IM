# Emoji 与表情面板

## 状态与基线

- 阶段：本地实施完成，完整门禁和 WebKit 专项已通过；按最新授权不远端交付。
- 规则及起始基线：`bfb7facfa4bad491833d75d8bddd78135c7ab9fe`，本机 main、origin/main、实时 GitHub main 开工一致。
- 分支：`codex/emoji-picker`；独占工作树 `/Users/zhouding/ss-worktrees/emoji-picker`。

## 已确认范围

分类顺序 Emoji → GIFs → 贴纸；Emoji 使用完整标准目录，点击插入草稿。GIFs 每行七个均布，贴纸五个；新 GIF 聊天宽高缩至原来 60%，贴纸保持原尺寸。Tab 约 38px，透明点击区域 44px；默认面板约六成屏高，上限 640px，输入框随之上移。保留已有手势、隐藏策略与最近使用十项。

设计依据为根 DESIGN.md、PRODUCT.md、src/design-system.css、src/memes.css。沿用既有玻璃面板、字体和浅深主题；效果图的内容为示意，不复制头像、聊天头部等未请求变化。

## 确认记录

本会话 2026-09-28：用户先要求“输出效果图即可，不需要制作原型和流程图”，本次明确豁免两项产物；随后“没问题”并要求提高半屏面板，再展示约 60% 高度效果图后用户明确“实施”，随后要求“继续”。授权正式实施及适用的验证、提交、PR/CI/合并；未授权生产发布。会话标识 `01a0e712-971e-7a22-8bf1-a2d03b4f7d67`，未提供消息 ID。

最终效果图本机路径：`/Users/zhouding/.codex/generated_images/01a0e712-971e-7a22-8bf1-a2d03b4f7d67/exec-79eb3079-e59e-4cca-8a69-4077aa72b1a4.png`。图片仅作本机审阅，不纳入 Git；跨电脑可用本记录确认范围。

后续授权收紧：自动审批两次拒绝提交／推送组合命令，实际均未执行。用户在本会话明确选择“只完成本地实施”。因此本任务只做本地代码和验收，不推送、创建 PR、合并或发布；此最新明确限制优先于上述默认远端交付流程。

## 实现与边界

- Unicode 17.0 RGI 共 3,953 项及 CLDR 48 中文注释，离线分类和搜索；字体显示能力由系统决定。
- Emoji 复用现有草稿事件与字符上限；加密和发送仍走文本路径。
- GIF 分类使用可选加密 expressionKind 与 expression-kind-v1 能力；旧设备混用时发送兼容格式，已加密待发消息等待能力恢复。旧消息和无类别收藏不猜测、不缩小。
- 不改变原图字节、贴纸动画、隐藏与已读语义；不修改部署配置。

## 验收

`npm run delivery:evidence -- run check:full` 已通过：构建、727 项单元／集成测试、44/44 浏览器脚本。完整执行约 504 秒，日志本机 `/private/tmp/qr-emoji-full.log`。执行期间产品代码未变；文档补充和媒体测试加强发生在对应媒体脚本运行前。证据工具标记 `clean: false`，它证明本地工作树执行成功，不作为精确提交 CI 或生产发布证据。

表情回归覆盖 Emoji 选区插入、中文搜索与空结果、60% 面板高度、紧凑 Tab、GIF 七列、贴纸五列、连续发送、半屏／全屏、安装及响应式布局。媒体回归覆盖 GIF 精确 60% 宽高、长 GIF、旧设备能力门禁，以及上传失败重试、尺寸接续、字节完整性和隐私清理。原先将贴纸尺寸直接与 GIF 比较的两个断言已改为明确验证五列贴纸尺寸。

补充 `MEME_WEBKIT=1 node tests/meme-picker.e2e.mjs`、`QUIET_ROOM_TEST_BROWSER=webkit node tests/media-upload.e2e.mjs` 均通过；前者截图在本机 `/private/tmp/qr-emoji-webkit/`，日志为 `/private/tmp/qr-emoji-webkit.log`、`/private/tmp/qr-emoji-media-webkit.log`。实际截图已检查面板高度、紧凑 Tab 及五列贴纸布局，均沿用既有视觉体系。

iPhone / iOS 27 / Safari 真机未验收；桌面 WebKit 不能替代真机。GitHub CI、PR、合并及生产均未执行。
