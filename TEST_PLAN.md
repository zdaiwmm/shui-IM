# Quiet Room P0/P1 修复与验收计划

## 双人实时通话（2026-09-04）

- `call-crypto.test.ts`、`call-membership.test.ts` 验证真实 MLS 叶节点绑定、完整设备身份声明、域隔离信令加密、签名／指纹／收件人校验、篡改、过期与未认证身份拒绝。
- `call-controller.test.ts` 验证接听前无采集、语音升级视频、静音／关闭摄像头、异步权限取消、多设备首接听、拒接与忙线、设备撤销、ICE 更新和销毁后的资源释放。
- `call-server.test.ts` 验证鉴权、签名、重放、单房间呼叫状态、抢接、离线设备、撤销／恢复隔离、临时 TURN 凭据及身份声明只来自当前在线认证连接。
- `call-native.e2e.mjs` 使用真实 Chrome WebRTC、真实 MLS 成员和合成媒体，验证双向音视频、语音升级、反向全新视频呼叫、实际 ICE 重启以及双端更新配置。`call-view.e2e.mjs` 覆盖 320–1440px、横竖屏、键盘焦点和媒体播放。
- `browser.e2e.mjs` 中的通话流程走真实页面和认证 WebSocket，验证来电不提前申请权限、静音到达对端、远端实际视频轨道、关闭采集、拒接／取消、pagehide／freeze、迟到授权清理和返回聊天交互恢复。失败诊断只记录媒体状态和计数，不记录 SDP、候选 IP 或密钥。
- `deploy-calls.test.ts` 验证后续发布保留通话 overlay、profile 和持久环境配置，回滚使用原启用模式，危险权限／缺失配置在停机前拒绝。
- 生产剩余验收：本地尚无 Docker，需实际 coturn 镜像、端口／防火墙、TLS、强制 TURN、真机 Wi-Fi／蜂窝互通、30–60 分钟通话及网络切换。自动化合成媒体不代替真机音画与权限体验验证。

## 本地文件格式扩展（2026-09-04）

- 相册通过“图片 / 文件”Tab 分开展示，进入默认“图片”；图片保留宫格和查看器，文件保留下载列表。验证左右方向键及 Home/End 的选择与焦点、快速切换期间异步结果隔离、当前分类历史分页、分类空态，以及上传后展示对应分类。更新后的界面截图位于 `audit/2026-09-04-gallery-tabs/`。
- 聊天与相册本地选择器可多选任意格式，包含 PDF、办公文档、压缩包、音视频及空 MIME 文件；空文件或单个超过 256 MiB 时拒绝。混选保持顺序，连续图片仍按每条 9 张/256 MiB 分组，其他文件每个独立发送。
- 文件卡片显示名称、大小、下载状态与失败重试，支持长按回复/回应；相册文件仅作为相册条目，不进入双方聊天、不产生聊天未读。任意文件内容不在应用内执行或预览，下载前校验原始长度与 SHA-256。
- `file-attachments.test.ts`、`crypto.test.ts`、`image-batches.test.ts`、`reactions.test.ts` 覆盖严格清单、跨设备密文、各格式原字节还原、混选分组、损坏拒绝与内容绑定续传。
- `file-flow.e2e.mjs` 覆盖双入口、混选、未知类型续传、下载逐字节比对、锁定期间取消下载、解锁保留选择和相册权限。`browser.e2e.mjs` 通过真实 MLS 与后端验证双方 PDF 传输、原文件下载和相册文件不进入聊天。
- `file-outbox.e2e.mjs` 覆盖已加密待发文件与文件回复在设备能力回退时暂停，恢复后继续；`file-interactions.e2e.mjs` 覆盖触屏长按及其后的点击抑制。
- 320px、390px、1280px 与 390px 深色截图位于 `audit/2026-09-04-file-attachments/`；真机系统文件选择器和 iOS“存储到文件”仍需设备回归。

## 0. 公开高安全升级增量（2026-09-03）

| 优先项 | 设计目标 | 自动化证据 | 生产门槛 |
|---|---|---|---|
| 存储容灾 | 在线备份 WAL 数据库，只纳入已完成密文附件；数据库/每个分块摘要校验；空目录保护恢复；定时保留 | `backup.test.ts` 覆盖在线快照、恢复、未完成附件排除和篡改拒绝 | 异故障域复制、删除保护、备份过期告警、月度恢复演练 |
| 通行密钥保险库 | 随机 256 位主密钥；WebAuthn PRF + HKDF 包装；系统生物识别/设备密码验证；无新建手势；旧格式一次性迁移 | 真实 Chrome 虚拟 CTAP2.1/PRF 验证、可同步与单设备凭据、新建/解锁/旧库迁移/恢复重绑定 | 实机浏览器矩阵和硬件密钥兜底验证 |
| 成熟前向保密协议 | 新房间使用 RFC 9420 MLS；身份密钥绑定 key package；签名 welcome/Add/Remove；每设备独立令牌与加入边界；过期纪元拒绝与重加密；发送/接收状态原子提交 | `mls.test.ts` 双向消息、独立新设备、加入前密文拒绝、纪元推进、重放与伪成员拒绝；`storage.test.ts` 边界和撤销 | `ts-mls` 自述未正式审计，独立密码学审计前不得宣称“已审计高安全” |
| 隐私后台通知 | 显式授权；VAPID；无 payload 唤醒；排除发送设备；推送不等于送达 | `push.test.ts` 订阅边界、成员绑定、排除发送端；服务端只调用无载荷发送 | Android 与安装态 iOS PWA 实机测试、VAPID secret 管理、元数据告知 |
| 图片相册与本机偏好 | 选择数量不限九张，聊天按每条最多 9 张/256 MiB 顺序分组，相册支持多选直传；安静占位与会话内缓存复用；阅读锚点、文本草稿与恢复提示偏好本机加密 | 严格 payload/分组单测、真实浏览器多选/锁定恢复/拼图/翻页/定位断言 | 大图内存压力、弱网、真机图片选择器与 iOS 返回动效验证 |
| 聊天页面在线状态 | presence 与 WS 连接分离；按角色聚合多设备；进入/退出即时更新；断连和半开连接兜底 | `api.test.ts` 重连重放/严格帧；`server.test.ts` 多 socket 聚合、关闭和 ping/pong 超时 | 元数据告知、代理日志审查、不得作为 E2E 安全信号 |
| 视觉/UI | 系统蓝、灰色气泡、圆角输入器、系统浅/深色、44px 控件、统一对齐/节奏；不复制 Apple 商标或资产 | 390×844、320px 与桌面截图回归；焦点、对比度、溢出和触控尺寸断言 | VoiceOver/TalkBack、系统键盘、安全区和 reduced-motion 人工验证 |

公开发布还必须逐项通过 [PRODUCTION_SECURITY_GATE.md](./PRODUCTION_SECURITY_GATE.md)。本机端到端延迟用于回归，不等价于公网即时性承诺。

## 1. 验收目标

本轮以 `PRODUCT.md` 的“结构化隐私、系统事实可见、原图不变、失败时关闭”和 WCAG 2.2 AA 为准绳。安全与即时性使用可验证目标，不使用“任何条件下绝对安全”或“物理断网时仍即时送达”这类不可实现表述。

消息链路目标：

1. 明文只在端侧处理，服务端持久化内容不得出现消息明文、图片原文、图片文件名、图片 MIME、图片散列、房间访问令牌或配对秘密。
2. 发送前先写入本机 AES-GCM 加密待发箱；失败、刷新、失焦锁定和断线不得使待发消息静默丢失。
3. 所有重试使用同一个 `clientMsgId`；服务端以数据库唯一约束和事务序号保证只提交一次。
4. 客户端只按连续 `serverSeq` 展示，发现缺口主动补同步；重连后无缺口、无重复、顺序一致。
5. 单柄对勾“已发送”（完整说明：服务器已保存）只依据提交 ACK/同步结果；双柄对勾“已送达”（完整说明：对端已安全接收）只依据对端 ECDSA 私钥签出的、与房间/消息 ID/序号绑定的回执。
6. WebSocket 使用应用层心跳发现半开连接，退避重连后自动补消息、补回执、补待发箱。
7. 加密原图按 2 MiB 分块上传；中断后使用原 `blobId`、密钥和 IV 前缀续传，只补缺失分块；完成前不可下载。
8. 每台设备使用独立身份、MLS leaf 和服务端令牌；新设备只有经过原设备核对六位安全码并提交 MLS Add 后才激活，并从激活边界后的消息开始同步。
9. 成员变更后服务端拒绝旧 MLS 纪元密文；客户端处理完整成员事件链后以同一 `clientMsgId` 和当前纪元重新加密待发内容。
10. 回复引用、被回复者、类型和通用非内容标签均在 MLS 载荷内；可见摘要只从本机加密历史生成，服务端不能从消息信封区分普通消息与回复，新设备也不能通过新回复取得加入前正文。
11. 选择数量不限九张；聊天按原顺序分组，每组最多 9 张且原图合计不超过 256 MiB，每组各有一个 `clientMsgId`、加密待发箱项、服务器序号和气泡。单图组使用单图载荷；相册内 `blobId` 唯一，非法 manifest 或超限载荷仍整条拒绝。验证 12 张按 9+3 发送及字节上限分组。
12. 可视区附近图片自动下载、校验、解密并内联显示；聊天、相册和查看器在同一次解锁期间复用已验证缓存。初次载入使用安静占位与无障碍状态，失败保留重试；锁定清空解密缓存和对象 URL。
13. 点按单图或相册任一格从正确索引打开 overlay；前后按钮、触摸横划、键盘方向键、计数、当前原图下载和关闭焦点恢复一致，切页不得重排聊天或产生新消息。

本机安全目标：

1. 新建、加入、解锁和恢复重绑定只使用支持 PRF 的 WebAuthn 通行密钥及系统用户验证，不显示应用手势控件。
2. 版本 3 保险库使用随机 256 位主密钥和 PRF 派生包装密钥；PRF 输出、派生密钥和生物信息不得持久化或发送到服务端。
3. 旧密码保险库使用原密码成功解锁一次后迁移；版本 2 手势保险库必须用原手势与原通行密钥解开一次，随后立即改包为无手势版本 3，不使既有用户失去访问能力。
4. 连续失败从第 4 次起指数退避，最长 30 秒；正常保险库需要注册的 PRF 通行密钥，可同步属性必须与创建时一致，恢复包需要独立随机 256 位恢复码。
5. 每次 `blur` 与 `visibilitychange(hidden)` 在同一事件调用栈内显示常驻不透明遮盖层，不等待下一帧；移动端/PWA 的 `hidden`、所有客户端的 `pagehide`、`freeze`、BFCache 恢复、手动/空闲锁定及系统组件失焦立即清理会话、WebSocket、对象 URL 和传输。移动端/PWA 普通 `blur` 将会话清理防抖 250 ms，快速恢复可取消待定清理；桌面浏览器的普通失焦/隐藏立即遮蔽和清理运行状态，但仅内存保留解锁会话，30 分钟无应用内操作后真正锁定。仅会话和 socket 打开前的网关 WebAuthn 有有界豁免。
6. 回到前台不得自动恢复；重新长按进入已配置通行密钥的解锁页后自动触发验证，取消或失败可手动重试。
7. 聊天和相册选择器失焦后保持白屏，保留连接且隐藏的 input 与选择结果；同一房间、同一设备解锁后续传原入口。覆盖 focus/change 两种先后顺序、取消、迟到事件与跨会话拒绝；手动锁定和 `pagehide` 丢弃待选文件。
8. 相册入口、列表、详情和直传仅创建者可用；一次可选多张，按顺序分别写入相册，均不进入双方聊天消息流。

交互与状态目标：

1. 首次进入无锚点时到达最新消息；离开聊天、进入相册/图片查看器、重新渲染或重新解锁时，恢复本机加密保存的消息 ID 与像素偏移；发送新消息后，输入框变高或键盘变化仍使最新消息位于输入框上方。未发送文本自动加密保存，白屏后恢复；发送成功仅在待发箱持久化后清除对应草稿，保留期间的新输入。
2. 阅读锚点和恢复提醒关闭状态只以本机加密偏好记录存在，换设备不伪装成已同步；损坏记录失败关闭为默认偏好，不把明文写入服务端或普通本机设置。
3. 输入器不提供独立表情面板、梗图入口和表情收藏功能；消息长按菜单提供六种快速回应，每个参与者同一消息最多一个回应，可替换或取消，回应显示在气泡角上且不新增聊天行。
4. 约 500ms 长按显示表情条和纵向拷贝/选择文字/回复菜单，背景轻微模糊、选中消息清晰；320px 长消息下控件不重叠。选择文字直接在原气泡内选中只读文本，位置与尺寸不跳动，不出现弹窗；允许系统调整选区，回执更新保留正在选择的 DOM。原生工具栏与拖动手柄需真机确认。
5. 未失焦时图片入口保留键盘意图；系统选择器造成失焦时以白屏锁定为先。点输入栏以外的空白区域收起键盘。
6. `VisualViewport` 高度/偏移变化后底部输入栏保持在可见键盘上沿；双击、移动端 gesture 和修饰键滚轮不放大整页，图片放大只在专用 overlay 内发生。
7. 聊天使用页面原生滚动，真实消息内容延伸到网页控件与浏览器界面后方；标题栏和输入栏固定在 visual viewport，控件使用独立、有界的玻璃滤镜、方向高光与明暗边缘，整条栏不重复模糊。页面切换不发生位移抖动，查看器全屏展示并支持拖拽缩小退出，尊重 `prefers-reduced-motion`。
8. 普通网页只能通过透明 `theme-color`、`viewport-fit=cover` 和 PWA display 配置尽力融合系统界面，不能强制 Safari/Chrome 原生底部工具栏透明；验收不得把浏览器自行保留的不透明原生栏误判为 CSS 回归。
9. 新 WebSocket 会话默认 `away`；只有设备实际在聊天页时上报 `chat`。同一角色任一活跃设备为 `chat` 即该角色在线，其余设备 `away` 或关闭不能错误拉低聚合结果。
10. 进入相册、图片 overlay 或设备管理应即时变为 `away`，返回聊天即时变为 `chat`，全过程不主动关闭/重建 WebSocket；重连鉴权完成后重放最后期望状态。
11. presence 帧严格限制为 `chat|away`，服务端在 socket close、成员撤销和控制帧 ping/pong 超时后重算并广播。状态只在服务端内存，重启归零；UI 必须把它描述为聊天页面行为提示，不得当作端到端认证、本人注视或送达证明。
12. 加载失败页保留右下角空白长按入口，错误码后显示同字体且略微突出的未读数。计数只包含对方、激活边界之后、尚未在本机聊天可视区标记已读的聊天消息；相册直传、表情回应及同角色其他设备消息不计。锁定/刷新后仅凭独立只读令牌查询数字，前台每 15 秒与 online/focus 刷新；离线保留最近已确认值。只读令牌不得访问 room、WS、附件或推进已读，撤销/恢复/轮换后失效。
13. 表情目标、emoji 和取消事件在加密载荷内严格校验。跨设备按服务器序合并，每角色只保留最新回应；重复/待发确认不重复渲染。重开会话、目标分页、损坏缓存页和锁定中断扫描仍保持历史边界；旧设备未确认能力时禁止发送。

## 2. P0/P1 可追溯矩阵

| 优先级 | 原问题 | 修复机制 | 自动化证据 |
|---|---|---|---|
| P0 | ACK 丢失或断线导致消息卡住/丢失 | 加密 IndexedDB 待发箱、稳定消息 ID、ACK 后仍同步确认、指数退避重试、服务端唯一约束 | `server.test.ts`、`browser.e2e.mjs` |
| P0 | 加入已在服务端封房，但本机保险库未保存 | 本机先保存 `joining` 身份，再调用幂等 `join`；同设备同证明可安全重试 | `storage.test.ts`、浏览器创建/加入流程 |
| P0 | 原图“续传”名不副实 | 加密续传计划、服务端分块状态、幂等预留/上传/完成、配额和过期清理 | `crypto.test.ts`、`storage.test.ts`、浏览器上传中断场景 |
| P1 | “已发送”不代表对端收到 | 拆分等待服务器/服务器已保存/对端签名回执三个状态 | `crypto.test.ts`、`server.test.ts`、`browser.e2e.mjs` |
| P1 | 解锁依赖网络 | 先解锁和展示本地历史，WebSocket 异步恢复 | 浏览器失焦后离线式本地恢复路径 |
| P1 | 恢复能力埋藏且未追踪 | 首屏提醒、导出时间写入加密保险库、恢复包与独立恢复码、通行密钥重绑定 | 浏览器恢复流程 |
| P1 | 存储故障被误报为安全攻击 | `SecurityViolation` 与本机存储/网络错误分流 | 构建类型检查与代码路径审查 |
| P1 | 对比度、输入边界和焦点环不足 | 提高弱文本/边界色对比度、恢复输入焦点环、保持 44×44 触控区 | 浏览器移动端尺寸/焦点/溢出检查 |
| P1 | 服务端缺少配额、清理和真实健康检查 | HTTP/WS 限流、连接上限、消息/图片配额、24 小时未完成上传清理、SQLite/目录读写健康检查 | `storage.test.ts`、`server.test.ts` |
| P1 | 失焦后明文与在途任务仍存活 | 单一幂等锁定入口、AbortSignal、运行代次校验、对象 URL 回收 | `browser.e2e.mjs` |
| P1 | 新用户重复输入手势，旧库又不能直接丢弃 | 版本 3 去掉手势；旧格式解开旧包装后迁移；仅网关 WebAuthn 保留有界失焦豁免 | `gesture.test.ts`、`browser.e2e.mjs` |
| P0 | 多设备共享密钥会暴露历史或扩大单点泄露 | 独立设备身份/令牌/MLS leaf；六位码人工批准；Add/Remove 轮换纪元；服务端加入边界和纪元校验 | `mls.test.ts`、`storage.test.ts`、`server.test.ts` |
| P1 | 回复关系可能泄露给服务端或跨越新设备历史边界 | 回复引用和通用标签放入严格校验的加密载荷 v2；正文摘要只从本机历史生成，渲染只写 `textContent` | `message-payload.test.ts`、`browser.e2e.mjs` |
| P1 | 相册权限与直传能力缺失 | 创建者角色同时控制入口和路由；相册直传使用独立负载并复用原图加密续传 | `crypto.test.ts`、`mls.test.ts`、`browser.e2e.mjs` |
| P1 | 多选受九张限制、载入提示反复闪现，或旧端收到未知相册载荷 | 顺序分组保持每条 9 张/256 MiB 载荷边界、相册多选、活跃设备能力确认、会话缓存复用和安静占位 | `image-batches.test.ts`、`message-payload.test.ts`、`system-surfaces.e2e.mjs`、`browser.e2e.mjs` |
| P1 | 页面重进丢阅读位置，恢复提示关闭后反复出现 | 设备级 AES-GCM 偏好记录保存阅读锚点和恢复提示关闭状态；发送消息单独采用到底部语义 | `storage.test.ts`、`browser.e2e.mjs` |
| P1 | 键盘、双击缩放、透明栏和切页动效不符合移动端预期 | 焦点保留/外部失焦、VisualViewport、整页缩放拦截、透明网页栏、稳定 enter/exit motion 和 reduced-motion | `browser.e2e.mjs`、真机 iOS/Android |
| P1 | WebSocket 已连被误显示为“正在聊天” | 独立 `chat|away` presence、角色多设备 OR 聚合、重连重放、close/撤销/控制帧心跳失活清理 | `api.test.ts`、`server.test.ts`、`browser.e2e.mjs` |

## 3. 自动化测试

### 构建与单元/集成测试

运行：

```bash
npm run check
```

覆盖：消息加解密和篡改拒绝、严格回复/2–9 图相册载荷、加入证明、签名送达回执、通行密钥保险库、本机加密偏好、旧手势规范化/迁移、MLS 多设备 Add/Remove 与纪元、加入历史边界、每设备令牌与撤销、原图逐字节还原、分块中断续传、幂等加入/消息/回执、presence 严格帧/多 socket 聚合/重连重放/失活清理、资源配额、垃圾回收、健康检查、HTTP/WS 总序和重连增量同步。

### 真实 Chrome 端到端测试

运行：

```bash
npm run test:browser
```

默认使用本机 Chrome channel；也可设置 `CHROME_PATH`。测试自行启动随机端口的 Vite 和后端，并使用临时数据目录。覆盖：

- 无手势的新建与加入、虚拟 CTAP2.1 WebAuthn PRF 用户验证；
- 文本实时送达、500ms 长按回复/复制/选择文字、选中范围复制、加密引用渲染与对端签名回执；
- 单图可视区自动解密预览、贴合媒体的气泡、全屏查看、拖拽缩小和松手关闭；
- 一次选择 12 张图按 9+3 生成相册消息，每组及跨组顺序正确，并可从点按项开始前后翻页；
- 离开/返回聊天及重解锁时恢复加密阅读锚点，发送后定位最新消息；
- 表情、梗图和表情收藏入口已移除，解锁重进后不重新出现；
- 未失焦时图片入口保持输入意图，外部空白收起键盘；模拟 `VisualViewport` 后输入栏和最新消息位置正确；
- 消息滚动到标题栏和输入栏下方时仍透过渐变遮罩可见；欢迎/通行密钥/邀请/聊天/相册各页连续 580ms 位置稳定，按钮/错误提示不重叠，双击不触发整页缩放；
- 双方进入聊天时各自与对方均在线；进入相册/overlay/设备管理只更新 chat-page presence 而不改变 WS 连接，返回后恢复；我的状态位于左侧，对方居中显示在线或最近在线时间；
- 旧版本手势的一次性正确/错误迁移路径；
- 移动端/PWA 普通短暂 `blur` 防抖、持续失焦锁定；所有客户端系统组件失焦立即白屏、前台不自动恢复；
- 桌面浏览器 F 持续两秒与右下角长按入口一致；松键、组合键、输入法、失焦、隐藏取消，移动端/PWA 不启用 F；
- 桌面遮蔽保留会话，30 分钟期限不被遮蔽输入续期；后台计时暂停后返回、首个输入、完成长按均检查期限；主动锁定/页面离开/冻结清除保留会话，必须重新验证；
- 恢复时重新解密持久化保险库，忽略被中断更新留下的内存修改；其他窗口替换/删除保险库后禁止使用旧会话恢复；
- 发送过程中失焦，重解锁后待发箱恢复且对端只有一条；
- 聊天和相册图片选择器失焦后白屏，12 张选择保留至同一房间/设备解锁，取消和迟到事件不污染新选择；
- 创建者相册可从本地多选直传；被邀请者没有相册入口，所有直传图片不进入聊天流；
- 图片选择器打开期间的 `pagehide` 立即白屏并丢弃选择，手动锁定也丢弃；
- 置顶恢复提示可关闭并持久保存偏好；自动加密备份及状态、再次通行密钥验证后查看本机码、恢复码自动取件、新设备凭据重绑定、轮换后旧码在线失效、用新码主动恢复历史/相册及继续收新消息；
- 旧密码保险库和版本 2 手势保险库迁移为仅通行密钥版本 3 后重新解锁；
- 390×844 视口无横向溢出、输入焦点可见、可见控件不小于 44×44。

完整验收运行：

```bash
npm run check:full
```

## 4. 仍需人工或部署环境验证

以下项目依赖真实部署或操作系统，不能由本机回环测试替代：

- iOS Safari、iOS Chrome 和安装态 iOS PWA 的真实软键盘：图片选择器是否保持输入意图、点外部是否收起、中文输入法组合态、`VisualViewport` 与安全区；
- iOS Safari/Chrome 的双击与系统 gesture 行为、单图/相册 overlay 横划翻页、返回焦点、聊天阅读锚点、相册/详情进入退出和本机安全提示是否无闪动或布局抖动；
- iOS/Android 真机上的透明网页标题栏/输入栏、浅深色 `theme-color` 和安装态 PWA 融合效果；明确记录 Safari/Chrome 原生底部工具栏由浏览器控制，无法由普通网页强制透明；
- iOS Safari/Android Chrome 的锁屏、应用切换、系统图片选择器取消事件和 PWA 独立窗口生命周期；
- VoiceOver/TalkBack 对在线状态、相册计数、overlay 控件、消息原位选择与回应菜单和 reduced-motion 的播报与焦点顺序；
- 反向代理的 TLS、HSTS、WebSocket upgrade、请求体限制和日志脱敏；
- 弱网、跨地域 RTT、代理重连和服务重启下的延迟分布；
- 数据卷容量告警、SQLite/WAL 一致备份和恢复演练；
- 独立密码学和应用安全审计。

公网 SLO 应按部署地压测制定。本机回环测试只用于发现明显回归，不能证明公网“零延迟”。

## 5. 本轮记录（2026-09-03）

- `npm run build`：通过。
- 不需要监听回环端口的 10 个 Vitest 测试文件、40 项用例已通过，包括旧数据库迁移、回复载荷、MLS 独立新设备/纪元、加入边界、令牌撤销、能力刷新、API 和协议格式。
- 当前受限执行环境拒绝监听本机回环端口，因此本轮无法在这里重新执行 `server.test.ts`、`push-server.test.ts` 和真实 Chrome E2E；这些测试已按新的每设备鉴权、无手势和回复流程更新，仍需在允许本机监听的开发机或 CI 上运行 `npm run check:full`。
- 以上是本地静态构建和非监听测试结果，未执行生产部署。

## 6. 本轮交互与 presence 增量（2026-09-04）

- 已实现单图自动可视区解密预览、2–9 图单条加密相册消息、overlay 定位/翻页、加密本机阅读锚点，以及键盘焦点、整页双击缩放、透明网页栏和 motion 行为；真实浏览器脚本已加入对应断言。
- `api.test.ts` 的 RoomSocket 测试覆盖 presence 期望状态缓存、鉴权后发送、去重、严格服务端快照校验与重连重放；服务端集成测试覆盖角色多设备聚合、`away`、断连、成员变化和控制帧 ping/pong 超时。
- `api.test.ts` 与 `storage.test.ts` 还覆盖了相册能力随已认证设备重连刷新；发送端只有在所有活跃设备都确认 `image-album-v1` 时才允许一条多图相册消息。
- 当前 Codex 沙箱禁止进程监听 `127.0.0.1` 回环端口（`listen EPERM`）。不需要监听端口的 API 单测可在此运行，但 `server.test.ts` 和真实浏览器 E2E 必须在允许 loopback 监听的开发机或 CI 上完成；该限制不是产品或 WebSocket 协议失败的证据。

## 7. 本轮界面修复验收（2026-09-04）

- `npm run build` 和全部 50 项 Vitest 单元/集成测试通过。
- `npm run test:browser -- /tmp/quiet-room-current-fixes` 通过，真实 Chrome 双端签名送达耗时 113 ms；该数字仅是本机回环回归证据。
- 浏览器回归覆盖：表情/梗图/收藏入口移除；通行密钥正常与错误状态间距；欢迎、通行密钥、邀请、聊天、相册、设备管理及返回路径位置稳定；顶部/底部渐变遮罩与消息穿透；双方状态位置和最近在线时间；全屏图片拖拽缩小退出；发送后到底部且 ACK 不拉回旧位置；500ms 长按和选区复制；恢复提醒关闭持久化、立即显示恢复码、取消不误报成功、保存并确认后记录完成、恢复导入后继续收消息。
- 320px、390px 和 1280px 截图检查覆盖聊天、通行密钥、解锁错误、相册、查看器、设备管理、置顶恢复提醒和恢复码面板。置顶提醒关闭图标的描边缺失由截图发现并补充回归断言。
- 真实 iOS 的系统工具栏透明度、原生长按阈值和震动仍由浏览器/设备能力决定；本轮浏览器自动化不能替代真机行为验证。发布状态另见部署记录。


## 8. 扩展审计修复验收（2026-09-04）

新增回归面向审计中已复现的失败路径：

- `frontend-lifecycle.e2e.mjs`：真实 Chromium/IndexedDB 下，复制成功与失败、历史翻页、引用查找、设备链接和排队回调在锁屏后不回填；迟到的旧复制/引用操作不覆盖较新的操作；弹层 Tab、Escape、inert、焦点恢复和外部移除；620 条历史中旧引用与 62 张媒体完整分页；5,001 条消息差量追加及焦点保持。
- `system-surfaces.e2e.mjs`：普通失焦防抖，聊天/相册选择器失焦和隐藏后白屏，focus/change 两种顺序，12 张选择保留至解锁、取消和显式锁定丢弃；导出及麦克风失焦锁定、迟到音轨停止、仅网关 WebAuthn 豁免。`image-batches.test.ts` 验证有序分组、每条数量/字节边界和相册逐张直传。
- `recovery.test.ts`、`recovery-server.test.ts`：旧包导出后的消息和原设备创建的成员变更；全新身份恢复、签名链验证、旧设备隔离、恢复令牌绑定、能力检查、加入前历史拒绝和新纪元消息。
- `vault-lifecycle.e2e.mjs` 真实浏览器生命周期用例：并发发送/接收整段串行、失败后释放队列、解锁等待旧提交、跨窗口或跨房间旧快照拒绝写入。
- `service-worker.test.ts`：网络 503、错误内容类型或断网不得覆盖健康页面缓存。
- `upgrade-safety.test.ts`：畸形 WebSocket upgrade 请求被拒绝后，服务仍能正常响应健康检查。
- `deploy-gate.test.ts`：维护期不接受业务写入；放行之后失败不得恢复旧数据库覆盖已确认消息；缺失代理维护配置时中止发布。
- `operations-export.test.ts`、`operations-check.test.ts`：异地导出必须先校验完整本地备份，再校验远端字节；只有成功后记录新鲜度；过期备份、未配置自动续期及过期异地证明触发失败。
- `ui-audit.e2e.mjs`：320px、390px、1280px、844×390 横屏、深色与 125% 字体等组合，保存几何和截图证据。正常界面动画、弹层滚动和旋转定位需与原审计截图对照。

执行结果与发布状态记录于 `audit/2026-09-04-fixes/report.md`。这里列出覆盖范围，不代表真实 iOS 平台或生产服务器已经完成验证。
## Voice-message regression

- `tests/voice.test.ts`: strict voice manifests/reply validation, duration and waveform bounds, portable PCM WAV encoding, exact audio bytes after decryption, resumable ciphertext, modified digest/chunk rejection, and cancellation.
- `tests/server.test.ts`: production permits only same-origin microphone access and local Blob media playback while keeping camera disabled.
- `tests/browser.e2e.mjs` includes `tests/voice-flow.e2e.mjs`, using Chrome's **fake microphone**, never a physical microphone. Covers pause/continue/preview, encrypted MLS delivery and receipts between two independent devices, playback/seeking, replies, discard, upload failure/retry, reload of local history, microphone denial, and late permission results after lock.
- `tests/voice-lifecycle.e2e.mjs`: old-device capability gate, prompt cancellation/timeout, stale permission ownership, hidden-prompt lock, single-source playback, receipt updates preserving playback, late download/send cleanup, and the five-minute review-before-send limit.
- Run `node tests/browser.e2e.mjs audit-screenshots/voice` for 320/390px recording controls, incoming/outgoing voice bubbles, dark-mode and desktop captures. Inspect these images as well as assertions.
- Manual release check on physical iPhone Safari / installed PWA and Android Chrome: first-time microphone prompt, repeated pause/resume, headset removal/interruption, background/lock while recording or playing, recording limit, and phone-to-desktop playback. Desktop Chrome automation does not certify mobile OS permission or microphone behavior.

## 遮盖、表情与未读计数回归（2026-09-04）

- 构建与 TypeScript 检查通过。Vitest 全量中不需本机监听的 91 项通过；被沙箱监听限制阻止的服务器测试在获准本机监听后全部通过，合并为 101 项；另新增的 11 项 `unread-counter.test.ts` 全部通过。
- `browser.e2e.mjs` 完整双设备流程通过，含真实 MLS 表情发送、取消、更换、双方归属、没有额外聊天行，以及重新解锁后恢复最新回应；本机签名送达样本为 128 ms，不代表公网延迟承诺。既有多图、语音、恢复与阅读位置流程也通过。
- `frontend-lifecycle.e2e.mjs` 通过：真实元素焦点切换不误触发遮盖、窗口失焦同一调用栈立即覆盖、后台返回保留认证入口、选区与回执同时保留、键盘原生菜单放行、320px 长菜单不重叠、单字消息两个表情不裁切。320px 截图已检查，原位选择不出现复制弹窗。
- `unread-counter.e2e.mjs` 通过：使用真实服务端接口，锁屏只统计对方聊天，消息可见后推进已读；刷新锁定页仅用只读令牌查询数字，不恢复解密会话或取得房间内容。单测覆盖离线注册重试、已读合并、乱序响应、401、取消和本地存储异常。
- `reaction-history.e2e.mjs` 通过：450 条加密记录的分页、整页损坏后的继续读取和中途取消，以及真正 `openSession()` 在尾部 400 条表情之后仍显示更早聊天。`system-surfaces.e2e.mjs` 与 `voice-lifecycle.e2e.mjs` 也通过。
- `ui-audit.e2e.mjs` 已将旧复制弹窗流程改为原位选择，语法检查通过；本轮未重跑完整历史审计矩阵。
- 未部署到生产。真实 iPhone Safari / PWA 的应用切换与标签缩略图、原生文字手柄及工具栏仍需实机验收；网页无法删除系统已经缓存的缩略图，也无法保证所有系统版本的原生菜单呈现时机。

## 2026-09-04 Safari 玻璃与图片粘贴验收

- `frontend-lifecycle.e2e.mjs`：页面原生滚动、固定控件、阅读位置、弹层滚动锁、模拟键盘高度与偏移；单柄／双柄对勾以及待发送／失败／重试；剪贴板图片提取、原始字节、草稿和选区保留、忙碌反馈及隐私遮挡。
- `browser.e2e.mjs`：剪贴板图片经过真实 MLS 加密、服务器 blob 存储与接收端解密后逐字节比对；原生滚动下复跑聊天、相册、语音、恢复和锁屏路径。
- WebKit 引擎验证可使用 `QUIET_ROOM_TEST_BROWSER=webkit node tests/frontend-lifecycle.e2e.mjs`，需要先安装 Playwright WebKit。引擎与模拟键盘验证不等同于 iPhone 原生 Safari 工具栏验收。
- 真机仍需检查 Safari 版本／工具栏布局／系统降低透明度设置下的透视效果，以及系统键盘和原生剪贴板图片格式。


## 自动备份与会话后台验收（2026-09-04，独立功能分支）

本节替代当前产品中的手动恢复文件验收；以上带日期历史记录只代表当时版本。完整契约见 `RECOVERY_BACKUPS.md`。

- `npm run check:full`：构建、241 项单元/集成，以及真实 Chromium 浏览器套件；覆盖真实 MLS 替换、原码取件、新码持久化、旧在线入口失效、默认不加载历史、相册独立恢复、新码恢复消息。
- `tests/cloud-backup-lifecycle.e2e.mjs`：已保存但响应丢失、重开保险库复用同一请求/恢复码、数据库/上传中无明文码、取消及迟到解密不覆盖保险库、其他窗口删除后旧请求拒绝、重新验证通行密钥和退出清理。
- `tests/admin.test.ts`：精确 Host/Origin、强密码 + TOTP、Cookie 属性、CSRF、重新验证清理、跨重启动态码防重放；`tests/deploy-admin.test.ts` 验证持久覆盖、首次启用回滚和停机前拒绝不安全配置。
- `tests/backup-admin-ui.e2e.mjs`：真实后台登录/退出、会话设备备份详情、清理确认表单；手机备份设置、相册恢复表单、再次验证后的码页面及横向溢出检查。传入一个本地截图目录可检查画面，恢复码像素替换为明确示意内容后才保存。
- `npm run test:calls`：单独补跑 56 项通话测试、原生 DTLS 与通话 UI 脚本。
- 本地证据不等于 CI、生产或真机通过；尚需真实 iPhone/Android/通行密钥矩阵、真实 Google Authenticator 扫码、生产域名 TLS/维护门、容器管理员配置挂载、灾备恢复及独立审计。管理员清理应以合成会话验收，不使用真实用户数据。
