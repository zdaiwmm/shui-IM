# 全站动效实施与验证清单

本清单对应方案 V2 的 M01–M22，不以修改文件数量代替覆盖。用户于 2026-09-28 明确要求“拉取最新代码，并完整实施此方案，注意不要漏做”，本次按该完整实施授权进入 I/D；不再把新增原型制作作为本次实施的前置等待。此前原型仍是示例，不补记真机或未发生的原型确认。

实施基线为实时核验的 main `2bbdf923eae63cd9ff604a69cccddc83123e3e58`，已合入原独占任务分支，合入后 HEAD `fad1f076a3f08ca34b77cb94d44190d6020509d7`。包含最新 Emoji、备份恢复功能。正式生产发布未授权。

## 补齐轮次（2026-09-28，实施中）

本轮基线与规则来源 `509444485ca49bd12b659d599476253a3a0d9ab3`。用户通过新任务明确授权按 V2 和 M01–M22 欠项一次性实施、验收、PR、CI、合并并准备生产发布；精确生产 SHA 仍须届时确认。来源聊天 `01a0e6e2-aec3-7d63-8e00-3c85978ade80`。任务树 `/Users/zhouding/ss/motion-completion/ss`，分支 `codex/motion-completion`，由应用独占分配。

旧表是上一轮文件覆盖及自动验证摘要，**不能证明 22 类体验全部达标**。上一应用已发布的事实保留，体验完成结论撤回；以下补齐轮次尚未交付。原正常速度原型是模拟，不能充当正式产品前后对比。本轮 USB 主机诊断未发现可用 iPhone，真机触摸、键盘、系统栏均受阻待验证。

| 项目／组件与入口 | 原问题／现状证据 | 本轮动作与正常速度目标 | 验收状态 |
| --- | --- | --- | --- |
| M01 消息 renderMessages，全部类型／日期／输入恢复 | 重排固定 300ms，连续操作仅保位置 | 已改位移时长及连续接续；同事务同步，不缩放长气泡 | motion-completion 同机对照、chat-continuity、message-*、media/video-upload 自动通过；真机键盘叠加受阻待验证 |
| M02 回复 bindReplySwipe、引用定位与返回 | 阻力及滞回存在，协同证据不足 | 保留阈值／速度／纵向仲裁；回复栏变化后协同可见消息，退出清空旧引用文本 | motion-system、reply-swipe、chat-continuity、frontend-lifecycle 自动通过；真机连续手势受阻待验证 |
| M03 菜单／回应／删除 renderMessages | 删除未触发邻近 FLIP | 同步移除敏感节点，仅存邻近坐标并收拢；回应共用位移时长 | motion-completion 正常速度对照、frontend-lifecycle、reaction-history、message-deletion 自动通过；真机长按受阻待验证 |
| M04 composer／键盘／表情 | 已有高度和原生视口控制 | 保留原生归属，不对 composer 叠加 transform；保留草稿与选区 | chat-list-viewport、frontend-lifecycle、chat-continuity、meme-picker 自动通过；iOS 组合态与键盘中间帧受阻待验证 |
| M05 transitionPage 所有普通导航 | 反向仍固定 340ms | 已按剩余路程与当前速度接续，认证即时，旧页面不可交互 | 反向对照 340→140ms；motion-system、system-surfaces、desktop-session-flow 自动通过；真机往返受阻待验证 |
| M06 mountDialog／抽屉／邀请 | 邀请忽略速度，回拉不能抵消接管偏移 | 接入末段速度、方向取消及接管偏移；保留实际完成清理和焦点锁 | motion-system 快甩／反向／重开、space-drawer-ui、spaces、passkey-management、backup-access、history-restore 自动通过；真机系统返回受阻 |
| M07 图片视频查看器／详情 | 缺来源展开返回 | 来源层与手势层独立；返回计入 contain 内容比例、当前缩放平移及展开进度；失效来源简单退出 | photo-details 新增正常／放大／展开中关闭起终点通过；分页、原字节、详情、隐私通过；最终门禁及真机原生全屏待验证 |
| M08 相册／文件／收藏／表情 | 标签已有，网格删除缺少协同 | 新增移除邻居 FLIP；保留标签接续、缓存不重播、表情排序与归属校验 | gallery-loading、file-interactions、chat-tools、meme-picker：空／加载／错误／缓存／排序／回滚自动通过；真机放下受阻 |
| M09 文档阅读器 | 翻页已有，搜索关闭仍独立时序 | 搜索／目录改受控接续；关闭使旧搜索失效；保留 PDF、净化及分页 | document-reader 搜索／目录／无结果、主题／窄屏、PDF 像素、worker 清理自动通过；真机阅读手势受阻 |
| M10 通知／进度／结果 | 重复通知重新入场 | 已原位更新；忙碌 aria-busy；进度仅取真实任务，保留失败／重试语义 | 通知对照、media-upload、file-outbox、release-update、local-history-backup 自动通过；共享进度条修复待完整复验 |
| M11 控件 | CSS active 短点反馈可能不可见 | 小控件缩放、大按钮透明度；短点补反馈；滑出／cancel／失焦／后台清理，不延迟点击 | 短点对照 .97→1，公共表单／焦点自动通过；真机滑出与 hover 受阻待验证 |
| M12 录音 | 既有阻力与取消手势 | 取消提示局部接续；保留阈值／滞回、立即停轨与不误发送 | voice-gestures、voice-lifecycle、voice-submission、voice-flow：拒绝／cancel／后台／迟到授权自动通过；真机长按受阻 |
| M13 VoicePlayer | 局部状态转换不足 | 新增加载／播放／暂停／失败／结束局部淡入；timeupdate 不重播，seek 仍同步真实音频 | voice-flow、voice-lifecycle 自动通过；真机播放与 seek 受阻待验证 |
| M14 CallView | 仅状态文案动画 | 头像／文案／有效控制区同阶段反馈，计时不重播，媒体操作先执行 | call-view、browser 主流程及首轮 CI 原生／视图通过；最终本地专项待执行，真机双端受阻待验证 |
| M15 聊天定位与锚点 | 已有可中断定位 | 保留单一滚动归属、历史插入锚点、阅读不拉底和手动接管 | chat-bottom-control、chat-list-viewport、chat-continuity、frontend-lifecycle 自动通过；真实键盘叠加滚动受阻 |
| M16 隐藏与隐私 | 回位中再拖动缺当前位置接管 | 已采样矩阵并还原阻力输入；正式阈值不变；遮挡／销毁即时 | chat-image-privacy、desktop-privacy、vault-lifecycle、frontend-lifecycle：旧回调不重显、资源清理自动通过；真机手势受阻 |
| M17 附件准备／预览／移除 | 慢 metadata 反馈与移除协同不足 | 即时显示本地准备状态；尺寸确认再挂稳定几何；预览淡入、移除先销毁后收拢，无假进度 | media/video-upload、file-outbox、system-surfaces 主体自动通过；新增共享轨道回归待复验；原生选择器真机受阻 |
| M18 设置／设备／表单 | 迟到响应缺页面归属，刷新整页退回加载态 | 原位刷新、当前请求归属校验；确认撤销立即移除并移动邻居；新条目淡入，已有条目不重播；失败保留列表可重试 | motion-completion 新增保留页面、失败重试、连续请求、离页与立即撤销几何；Chromium 通过，最终 WebKit／门禁待验；原设置／表单专项通过，真机认证返回受阻 |
| M19 备份／恢复／引导 | 主要公共弹层 | 恢复阶段变化同步标题／说明；百分比不重播；重开显示现状，保留安全和回读契约 | backup-access、local-history-backup、history-restore、joint-recovery、cloud-backup-lifecycle 自动通过；真机后台／认证受阻 |
| M20 连接与在线 | 缺失 transport 快照的文字不明确 | 明确连接中／已断开，原位淡入且断线即时；不把 transport 当对方在线 | presence-circuit 状态路径通过、颜色终点断言失败；改等实际过渡后完整复验，未记整体通过 |
| M21 主题／视口／生命周期 | 部分共享效果可收敛 | 共享 WAAPI 对运行时 reduce／隐藏立即收敛并释放监听；保留独立手势清理 | motion-system 新增导航运行时 reduce、system-surfaces、desktop-privacy 和主题／窄屏自动通过；最终 WebKit、真机待验证 |
| M22 页面背景／安全区 | root/body 匹配，原生材质不可由网页证明 | 保留页面表面、透明主题提示和原安全间距；不改聊天滚动归属 | system-surfaces、motion-system、chat-list-viewport 网页层通过；原生工具栏／安全区受阻待真机，不承诺全透明 |

每项结论最终须附入口／状态／实现或保留理由／正常速度证据；正常、取消反向、连续为共同门槛，异步追加失败、重试、过期结果，数据页追加空、加载、内容、错误。未验证不得写通过。

## 上一轮逐项覆盖（历史）

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
- 开发期构建及 734 项单元／集成测试已通过；浏览器分段排查已覆盖完整入口。日期与照片详情旧时长断言已同步；恢复码测试检查同一输入对象即使被移除也已清空；相册历史图片操作明确等待相应分页，避免与恢复滚动触发的加载竞态。
- WebKit 的动效专项与完整 frontend-lifecycle 已通过，明暗主题聊天、窄屏和相册底部截图已检查。新增弹层重开终点断言发现并修复 CSS 过渡与 WAAPI 同时控制 transform 的问题；导航连续性断言冻结测试中间帧，避免合成器在两次样式读取间继续推进导致误报。
- 产品候选 `6f941567f8b76d14f30384c1bac798e5e1f98720` 的干净文件树通过完整 `check:full`：734 项单元／集成、46/46 浏览器，515154ms；`delivery:evidence` 已保存精确 SHA、文件树、结果与耗时。原生通话、通话 UI 与 20 个弱网场景也通过。之后仅补通话测试超时的脱敏诊断与本记录，产品代码未改变，受影响入口另行复验。
- PR CI 曾在应用主流程的通话连接等待处超时，未放宽断言、屏蔽测试或据本地通过直接合并。最终 CI、受影响复验与合并事实汇总到 [PR #217](https://github.com/zdaiwmm/shui-IM/pull/217)。
- 无真实 iPhone 验收证据；桌面 WebKit／Chromium 不等于真实键盘、系统工具栏或双端设备体验通过。不承诺固定帧率；本轮不新增第三方性能采集。
- USB 设备检查未发现可用 iPhone；未执行生产发布。最终自动测试／CI／合并以同一 PR 的精确候选与交付证据为准，不为补自动汇总再创建产品 PR。


## 补齐轮次：开发验证记录

- 类型检查通过；新增策略与回复、语音、图片手势共 51 项定向单元测试通过。浏览器入口增加 motion-completion，runner 的 12 项测试通过。
- Chromium 动效专项（含邀请快速甩动／反向取消／运行时减少动态）、阅读器、CallView、隐私图片、照片详情、恢复、连接在线专项通过。桌面 WebKit 聊天连续性与新增 motion-completion 通过。均为本任务未冻结文件树的开发证据，最终门禁与 SHA 另记。
- frontend-lifecycle 在回应增／删两处旧固定 300ms 断言处中断。已明确分类为方案变化后的旧时长断言；改为 180–320ms 有界时长，原位置、ACK 不重启和节点身份断言保留。未把该套件记作通过，不继续开发期盲目重跑；冻结后执行完整门禁。
- 正常速度同机同数据对照：基线 `5094444` 的只读源码快照与当前源码使用同一 `tests/motion-completion.e2e.mjs`，393×695 桌面 Chromium。基线短／长／连续发送均 300ms，当前分别 265／296／245ms；基线删除无邻近动效，当前删除节点立即移除且 10 个邻近内容收拢；反向导航 340→140ms；重复通知重新入场→原位保持；极短点击 scale 1→.97 后回到 1。它们是实际组件路径，不是原型。
- 对照样本两轮帧间隔最大约 16.8ms，均无 >34ms 帧间隔、长任务和布局位移；仅该桌面短路径，不外推全站或真机帧率。WebKit 当前样本有 1 次约43ms帧间隔；该引擎不提供 longtask/layout-shift 观测，不把空数组写作性能通过。
- 本地正常速度录屏与数值：`/private/tmp/motion-completion-before/`、`/private/tmp/motion-completion-after/`。仅测试文案和模拟身份；媒体不提交仓库。已抽查当前消息帧，气泡、输入区与布局无明显重叠。尚不能据单帧证明全部质感。
- 工程交付、完整自动门禁、全场景视觉验收及精确生产提交确认尚未完成。不得将上述局部证据写成全部 22 项体验完成。

## 冻结候选与失败归因

- `a0909f86b4f2c84b066527a869f6c431d0ebd460` 干净候选 `check:full`：构建与 737 项单元／集成通过，浏览器 46/47 通过，509480ms。唯一失败 presence-circuit 的离线颜色基准取在 CSS 过渡尾段，得到 oklab 中间色；终点 oklch 与其字符串不同。已改等待真实动画完成，颜色相等断言保留。该完整门禁结果为失败。
- [PR #221](https://github.com/zdaiwmm/shui-IM/pull/221) 首轮 CI：同一颜色问题；另主流程锁屏测试固定等待 80ms，未保证续传计划已落盘。已改等首个 PUT 分块请求（加密流程先 await savePlan，之后才 upload），不降低恢复断言，不改加密／存储代码。
- 审查修复准备提示的共享进度轨道宽度污染；改回已有 scaleX 控制并补轨道宽度回归。照片来源返回改计算 contain 内容与当前层／图片变换；新增正常、放大平移、展开途中、来源删除用例，专项已通过。
- 上述修复仍在同一 PR，不创建下一批。最终候选复验完成前不合并或发布；自动通过和真实 iPhone 体验受阻继续分别记录。

### 主线组合与第二轮

- 验证期间 PR #220 合入 `8d340c8edb3a1de5466ebafa0df860621d2778cc`。本任务同步该主线；代码自动合并，版本号冲突按固定 release:prepare 工具生成 `2026.09.28.7`，保留主线 `.6` 历史。
- M06／M18／M19 按主线新契约验收：设置返回立即恢复设置抽屉；关闭未完成的恢复弹窗即取消任务，强制生命周期清理仍暂停。上表“重开显示现状”仅指已有任务／失败后入口，不恢复旧的“收起后继续”产品语义。旧历史表中的收起描述只适用于上一版本。
- `fc80d8f5cbed659dc6171b0df7b653de61b97035` 第二次干净完整门禁：构建与 737 项单元／集成通过，浏览器前 43 项通过，media-upload 的重试按钮 44px 触达断言失败，后三项未执行，459819ms。结果仍为失败。
- 为触达失败增加诊断后，10 类媒体的重试按钮均测为 63×44px，未稳定复现缩小。移动行的 CDP 四角坐标可能存在不同舍入；改为同一页面任务读取真实 getBoundingClientRect 和 offset 尺寸，仍要求四项全部至少 44px，不扩大容差、不降低触达要求。随后定向及组合完整门禁以实际结果为准。

### 组合门禁与 M18 补齐

- `f6401a33056f1edc98dca89175423bf885ed906a` 干净组合候选完整 `check:full` 通过：94 个测试文件、738 项单元／集成、47/47 浏览器，515436ms。CI run `36421531593` 全部通过。前述颜色与触达问题在该候选通过，失败历史仍保留。
- 逐入口复核发现设备刷新／移除仍整页退回加载态，M18 再补原位刷新。请求只更新所属页面与最新操作；确认撤销的节点在再次请求前立即移除，邻居接续；失败保留列表与重试入口，新条目淡入，已有条目不重播。期间按钮禁用但状态提示保持可访问，不改设备授权／撤销事务。
- 新增设备展示夹具隔离网络，验证保留原页面、忙碌、原位失败／重试、立即移除与邻居运动、连续请求归属、离页失效；Chromium 定向通过。真实设备授权仍由原双端主流程和安全测试验证，不能以该夹具替代。
- 同机基线副本 `5094444` 的 WebKit frontend-lifecycle，以及 Chromium 阅读器／通话 UI 同路径录屏已完成：`/private/tmp/motion-visual-before-webkit/`、`motion-visual-before-reader/`、`motion-visual-before-call/`；当前候选对应录屏／验证另记。仅合成数据，录屏与截图不提交仓库。
