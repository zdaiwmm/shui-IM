# 两次补充交互需求验收（2026-09-05）

本轮接续已发布的 24 项交互、气泡日期和返回最新消息功能，同时处理用户随后两次补充。此页只使用合成会话和媒体；工作树、自动测试、CI、真机、生产分别记录，当前生产证据见[状态页](../../docs/context/status.md)。

| 用户问题 | 最终实现 | 可重复验证入口 |
| --- | --- | --- |
| 语音长按后原按钮出现蓝圈 | 记录触摸／键盘来源，触摸恢复焦点不显示圈，键盘与辅助激活保留焦点 | `voice-submission.e2e.mjs`、`voice-gestures.e2e.mjs` |
| 松手出现删除、长条和发送 | 自动处理／上传只显示状态；失败恢复可重试草稿，原音频与消息 ID 不变 | `voice-submission.e2e.mjs`、主流程 `voice-flow.e2e.mjs` |
| 键盘出现后上下滑列表 | 垂直触摸不滚动，移动中保留键盘，最后一指松开收键盘，保留草稿 | `frontend-lifecycle.e2e.mjs`、`chat-image-privacy.e2e.mjs` |
| 输入栏随工具栏卡顿 | 运动期间隐藏输入栏，稳定重测后淡入；隐藏控件不能被点击，最新按钮共享定位与显隐 | `chat-viewport-motion.test.ts`、`frontend-lifecycle.e2e.mjs`、`chat-bottom-control.e2e.mjs` |
| 聊天和保险箱标题栏移动 | 标题栏固定可见屏幕顶部；以 DOM 坐标减去可视视口偏移检验，覆盖真实文档滚动加模拟键盘偏移 | `frontend-lifecycle.e2e.mjs` |
| 按钮迟滞、页面切换闪空 | 当次点击立即进入页面，内容短渐显；页背景与标题栏不整页消失，按下即时反馈 | `system-surfaces.e2e.mjs`、`browser.e2e.mjs` |
| 显露图片下拉无反馈 | 照片／相册／视频预览随手指阻尼位移，达到阈值后松手隐藏，短拖返回；真实取消和锁定立即清理 | `chat-image-privacy.e2e.mjs`、`video-flow.e2e.mjs` |
| 图片／上传／麦克风／摄像头弹窗立即锁 | 仅用户发起操作取得有时限可见失焦交接；首次焦点返回消费，结果早到短暂等待，真实后台或再次离开仍锁 | `system-surfaces.e2e.mjs`、`browser.e2e.mjs`、`voice-flow.e2e.mjs` |
| 角落难按、返回后无响应 | 80×80px 热区，指针捕获；已是遮蔽页的常驻隐私幕可转交角落手势；迟到焦点与异步读取做状态防护 | `desktop-privacy.e2e.mjs`、`desktop-session-flow.e2e.mjs` |
| 长按结束后弱扩散、立即验证 | 1 秒完成后 180ms 弱扩散，期间普通松手不取消，隐藏／锁定取消；网关立即发起真实通行密钥 API，迟到旧结果不得污染新尝试 | `desktop-privacy.e2e.mjs`、`browser.e2e.mjs` |
| 时间／对勾与末行同行 | 正文尾部预留状态宽度，状态略低于正文且时间浅灰；不足才换行，单字仍紧凑，待发不降低整泡透明度 | `message-timeline.e2e.mjs` |
| 不能破坏既有业务 | 保持日期去重／历史锚点／最新按钮、原始文件逐字节传输、MLS 原子存储和重试、设备／恢复边界 | `npm run check:full`、`npm run test:calls:e2e` |

## 检查画面

[390px 深色末行时间](./390-dark-inline-time.png) · [320px 大字号与极端文字](./320-large-text-edges.png) · [语音自动发送状态](./voice-sending.png)。语音图是隔离组件夹具，空白区域不是实际聊天内容被清空；集成主流程另验证真实消息传输。

## 验证边界

Chrome 与 Playwright WebKit 覆盖公开视口几何、事件顺序、布局、可见性和真实浏览器业务流程。真实 iPhone Safari 的原生键盘／工具栏合成、系统选择器与权限窗口仍需真机验收；网页不能读取尚未公开的原生动画帧，也不能自行授予系统权限。此轮采用用户允许的“运动期间隐藏、稳定后出现”策略，避免把中间错误位置呈现出来。

本次原生前台交接是明确的交互取舍：浏览器不可靠地区分可见窗口失焦原因，有限窗口内不能保证识别所有窗口切换。隐藏、离页、冻结和锁定保留既有安全处理，详见[产品契约](../../PRODUCT.md)、[安全边界](../../SECURITY.md)与 D-020。
