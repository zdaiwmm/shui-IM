# 全站动效实施与验证清单

本清单对应方案 V2 的 M01–M22，不以修改文件数量代替覆盖。用户于 2026-09-28 明确要求“拉取最新代码，并完整实施此方案，注意不要漏做”，本次按该完整实施授权进入 I/D；不再把新增原型制作作为本次实施的前置等待。此前原型仍是示例，不补记真机或未发生的原型确认。

实施基线为实时核验的 main `2bbdf923eae63cd9ff604a69cccddc83123e3e58`，已合入原独占任务分支，合入后 HEAD `fad1f076a3f08ca34b77cb94d44190d6020509d7`。包含最新 Emoji、备份恢复功能。正式生产发布未授权。

## 逐项覆盖

以下“保留”均为刻意保留已满足目标的行为，不表示省略检查。测试名称是验证入口，执行结果另见本文件末尾，不能由表格推断通过。

| 范围 | 实际实施／保留边界 | 验证入口（tests/） |
| --- | --- | --- |
| M01 消息 | 统一消息与日期分隔的收敛曲线；连续布局变化保留当前位移；新增底部接收消息与邻近消息协同。所有消息类型使用同一重排入口。保留持久化先行、草稿保护、真实送达／已读。 | chat-continuity、message-timeline、message-read、media-upload、voice-flow |
| M02 回复引用 | 回复阈值增加退出滞回，快速提交按末段速度判断；回位使用临界阻尼并可被新手势接管。保留引用定位与返回锚点。 | motion-system、reply-swipe.test、frontend-lifecycle、chat-continuity |
| M03 菜单回应删除 | 菜单共享缓动与实际完成清理，回应布局采用统一收敛；保险库移除媒体先隐藏画面再退场，不缩放大型媒体。保留长按阈值、消息复制和删除授权。 | frontend-lifecycle、reaction-history、message-deletion、gallery-loading |
| M04 输入区 | 保留已有输入高度／消息几何协调、当前高度接续和真实键盘控制器；相关提示与局部控件统一反馈，不给原生键盘另套固定曲线。 | chat-list-viewport、frontend-lifecycle、chat-continuity |
| M05 导航 | WAAPI 接管普通页面 push/pop，两层从当前绘制位置反向接续；完成或取消清理。认证网关与隐私切换仍立即替换。 | motion-system、system-surfaces、desktop-session-flow |
| M06 抽屉弹层 | 共享 dialog 全部调用方改实际动效完成清理、重开转移视觉位置和焦点归属；抽屉内页局部过渡；邀请面板增加跟手阻力、取消回位。 | motion-system、space-drawer-ui、spaces、history-restore、passkey-management |
| M07 查看器 | 图片缩放被接管时采样当前矩阵，取消“先 finish 再开始”；回位使用收敛曲线；详情开合缩短拖尾、实际结束清理。保留多指仲裁、分页残余速度、原生视频与资源生命周期。 | image-viewer-gestures.test、photo-details、video-flow、motion-system |
| M08 资源与表情 | 相册切换采样透明度、取消旧切换；标签统一缓动；表情排序取消旧位置动画后成组测量，避免堆叠。保留已有表情边界阻力、分类／位置记忆、空态和缓存。 | gallery-loading、meme-picker、file-interactions、chat-continuity |
| M09 阅读 | 文本／EPUB 翻页从当前绘制位置接续，降低首次透明度落差；目录、搜索使用共享曲线。保留 PDF 稳定呈现、搜索取消、阅读净化与销毁。 | document-reader、file-flow |
| M10 结果进度 | 缩短通知拖尾；公共忙碌按钮补 aria-busy；附件状态变化局部反馈，不在每个百分比更新时重播。真实进度、重试与完成语义保留。 | media-upload、file-outbox、release-update、local-history-backup |
| M11 控件 | 小型按钮按下压缩／松手收敛，普通条目与表单颜色反馈，保留焦点环与禁用语义；开关滑块统一缓动，大型媒体与消息不全局缩放。 | motion-system、space-drawer-ui、backup-access、frontend-lifecycle |
| M12 录音 | 保留已存在的对数阻力和取消滞回；录音入口收敛优化；取消装饰在实际完成后清理，音轨与明文仍同步释放。 | voice-gestures、voice-lifecycle、voice-submission、voice-flow |
| M13 播放 | 仅在播放状态变化时替换图标，避免每次 timeupdate 重建／重播；波形颜色轻量衔接，seek 继续同步真实音频。 | voice-flow、voice-lifecycle |
| M14 通话 | 状态文字局部接续、控制图标与按下反馈；计时更新不重播。销毁取消效果；接听、挂断、媒体释放、信令与权限不等待动画。 | call-view、call-native、call-weak-network、call-flow |
| M15 滚动定位 | 保留现有底部跟随、手动滚动优先、历史加载锚点、引用返回和可中断定位；新消息重排仅在适用底部状态启用，不对历史补播。 | chat-bottom-control、chat-list-viewport、chat-continuity |
| M16 隐私 | 隐藏手势回位使用统一收敛；保留先隐藏／销毁后视觉清理，动作中断检查当前页面和隐私状态，禁止旧回调恢复内容。 | chat-image-privacy、desktop-privacy、frontend-lifecycle、vault-lifecycle |
| M17 附件 | 准备、上传、发送中、失败的标签反馈；复用既有几何占位、预览解码、取消和重试；原生选择器继续在用户激活栈调用。 | media-upload、video-upload、file-outbox、system-surfaces |
| M18 设置设备表单 | 公共按钮忙碌状态、焦点、选项反馈，抽屉子页接续，校验提示局部淡入。保留输入、权限与撤销生效时机。 | passkey-management、spaces、space-drawer-ui、browser-access |
| M19 备份恢复引导 | 新备份开关滑块、隐私说明面板、恢复码面板和结果提示接入共享控件／dialog／通知；保留步骤语义、系统验证、回读才成功、进度收起与取消区别。 | backup-access、local-history-backup、history-restore、joint-recovery、cloud-backup-lifecycle |
| M20 连接在线 | 保留已有在线与连接状态事实、固定区域及周期提示，不为断线添加显示延迟；共享提示节奏优化，通话连接状态局部反馈。 | presence-circuit、unread-counter、call-weak-network、browser |
| M21 主题生命周期 | 浅深色继承现有 token；共享效果在减少动态效果／后台变化时收敛，图片缩放响应运行时减少动态效果；隐私销毁仍优先。 | motion-system、system-surfaces、frontend-lifecycle、desktop-privacy |
| M22 系统背景 | root/body 的 chrome-tint 跟随页面 paper，备份／遮挡页面匹配 paper-pure；原生主题提示保持透明，底部内容与既有安全间距保留，无新增不透明网页底层。 | motion-system、system-surfaces、chat-list-viewport；真实 Safari 待真机 |

## 共用组件调用范围

- `mountDialog`：消息／资源动作、空间抽屉／上下文／改名／邀请、表情预览与搜索、通行密钥管理、备份隐私说明、恢复码／恢复进度、释放说明以及 app.ts 中全部现有调用方。通过原调用入口接入，不另造弹层系统。
- `transitionPage`：app.ts 中普通导航入口；认证网关仍立即替换。没有把安全页也强制套成普通动画。
- 消息重排：文字、表情、图片、视频、文件、语音、日期、回应与输入区协同；媒体原图尺寸和新旧 GIF 分类契约保留。
- `motion.css`：通过应用入口加载，深浅色、移动／桌面以及公共状态样式共用；不覆盖管理后台独立产品，不增加远程脚本或监测。

## 验证证据与限制

- 新增 `motion.test.ts` 验证阻尼单调收敛、速度接续及帧率独立性。
- 新增 `motion-system.e2e.mjs` 并纳入完整浏览器入口，验证导航反向、弹窗完成与焦点、关闭途中重开、邀请拖动取消、回复阈值、失效回调、缩放接管、减少动态效果与深色背景衔接。
- 现有导航测试从 CSS 动画名称检查改成真实运动效果检查；日期与消息测试仍要求同位移、同时长，并按方案约束在 220–320ms 内。手势测试增加绘制样式夹具并同步新回位参数，未放宽取消／隐私／权限断言。
- 开发期构建及 734 项单元／集成测试已通过；浏览器全量首轮已通过前七项，日期分隔测试发现旧时长断言，已按方案更新，最终候选需完整复验。此处不将开发期通过视为最终候选通过。
- 无真实 iPhone 验收证据；桌面 WebKit／Chromium 不等于真实键盘、系统工具栏或双端设备体验通过。不承诺固定帧率；本轮不新增第三方性能采集。
- 最终自动测试、CI、PR、合并与生产状态在完成后追加；生产未因本记录更新。
