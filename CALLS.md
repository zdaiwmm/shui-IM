# 双人实时语音与视频通话

本轮在 Quiet Room 内加入浏览器 WebRTC 双人通话。界面采用 FaceTime 的布局与交互：远端视频铺满通话页、右上角本地预览、底部半透明控制区，来电使用红色拒接和绿色接听。网页不会接入 Apple FaceTime 服务，也不具备原生系统来电或锁屏后台通话能力。

## 使用与生命周期

- 聊天输入栏右侧加号展开功能面板，其中“视频通话”和“实时语音”分别发起视频和音频通话。双方需打开支持通话的最新版并解锁同一个 MLS 安全会话。
- 支持来电接听／拒接、主叫取消、静音、开关摄像头、可用设备上的前后摄像头切换，以及语音通话中开启视频。关闭摄像头会停止对应采集轨道；静音会禁用麦克风轨道。
- 来电响铃阶段不申请被叫的摄像头或麦克风权限。对方有多个在线授权设备时，最先接听的设备参与通话，其余停止响铃；任一设备明确拒接会结束本次呼叫。
- 响铃最多 45 秒，媒体权限等待最多 30 秒。忙线、离线、权限拒绝、连接失败、网络变差与结束原因在通话页显示。浏览器阻止自动播放时，提供真实的点击播放入口。
- 视频初始目标为 720p、24 fps，发送码率上限约 1.5 Mbps；弱网时依次降低码率、分辨率、帧率，必要时暂停视频发送并保留音频和既有摄像头授权；连续恢复样本满足门槛后逐级恢复。手动关闭摄像头始终停止采集并取消自动恢复。实际码率、清晰度与延迟由终端、浏览器和线路共同决定。
- 网络短暂变化会先保留已成功媒体路径，再按有界阶梯恢复；WebSocket 短断可在 30 秒内按同一设备重绑定同一 callId。设备撤销、锁定或隐私遮盖立即结束通话。所有本地轨道先同步停止，结束通知再尽力发送；迟到的权限授权不会重新开启摄像头或麦克风。
- 页面隐藏、`pagehide`、`freeze` 和权限弹窗导致的失焦遵循现有隐私策略。桌面端即使暂存解锁会话，也不会保留音视频采集或恢复旧通话。
- 移动端前台通话暂停原有 10 分钟空闲锁定；桌面端保留其独立的 30 分钟真实无操作截止时间。通话计时、网络统计和媒体帧不会冒充用户操作延长桌面会话。
- 本轮没有服务器录音、录像、转写或通话历史。挂断后可返回聊天；重新进入页面需要重新发起通话。

## 加密与信任边界

音视频由两个浏览器通过 DTLS-SRTP 加密传输。优先端到端直连；网络无法打通时，由 TURN 转发相同的加密数据包。TURN 不解码、不转码，也不终止浏览器之间的媒体加密。

呼叫、SDP 和 ICE 候选通过现有已认证 WebSocket 路由。信令内容使用独立域的 P-256 ECDH / HKDF-SHA-256 / AES-256-GCM 加密，完整外层信封由设备 ECDSA 身份签名；房间、通话、收发设备、事件 ID 与有效期均被绑定。SDP 必须包含合法的 SHA-256 DTLS 指纹并使用 DTLS-SRTP 媒体协议；完全相同的有效签名事件重传只重发确认，不重复推进通话；同 eventId 的不同内容、过期、越权或被篡改的事件会被拒绝。

客户端在生成本地 SDP 或申请通话采集前，验证实际本地 MLS 树中的成员身份，以及设备本人对房间、角色和完整公钥包的签名声明。后者由当前已认证在线连接提供，但其信任来自本地 MLS 叶节点绑定的签名密钥。服务器返回的设备列表或所谓“已验证”字段不能代替这些验证。成员变化通过已有配对证明和签名成员事件核验；接听和重连同样检查对方身份。

服务器仍可观察通话参与设备、邀请／接听／结束时间和连接 IP；TURN 能观察转发时序、地址与流量。直连时对方也可能得知你的公网 IP。需要隐藏双方之间的直连地址时，可配置强制 TURN，但会增加服务器带宽和中继路径依赖。

此处信令使用长期设备 ECDH 密钥，**不宣称信令具备前向保密**：攻击者若同时保存旧密文并日后获取相关设备私钥，可能还原旧 SDP／候选信息；媒体会话使用独立的 DTLS 临时密钥。服务器不持久化通话信令，但这不能保证外部代理或运维监控从不记录元数据。

加密不防止对方录屏、终端木马或浏览器扩展读取已解密内容；被攻陷的站点也可能下发恶意客户端代码。本轮不是独立密码学审计，已有 MLS 实现的审计限制仍适用，详见 `SECURITY.md`。

## 服务器与部署

用户提供的服务器为 2 核、2 GiB 内存、200 Mbps 峰值公网带宽。两人通话无需服务器转码，P2P 时服务器主要处理少量信令；TURN 时主要压力转为网络收发。因此可先使用现有主机，不需要增加媒体混流服务。峰值带宽不是持续带宽保证，仍需核实流量套餐与实际线路。

按每人向外发送约 1.5 Mbps 视频粗估，同一 TURN 完整转发双向视频时，服务器合计入站约 3 Mbps、出站约 3 Mbps；纯出站约 1.35 GB／小时，另有音频、包头和重传。此为规划估算，不是实测账单。无录制时不会随通话时间持续增加磁盘占用。

可选 `compose.calls.yaml` 为 Linux 公网主机提供 coturn 服务，设 256 MiB 容器内存上限，不默认占用站点的 443 端口。`.env.calls.example` 列出所需配置：

| 配置 | 用途 |
|---|---|
| `COTURN_IMAGE` | 上线前审核并固定的 coturn 镜像标签／摘要；不内置未经验证的版本 |
| `TURN_PUBLIC_IP`、`TURN_REALM` | 实际公网 IPv4 和服务域 |
| `TURN_SECRET` | 仅后端与 coturn 共享的随机 base64url 密钥，不发往浏览器 |
| `CALL_STUN_URLS`、`TURN_URLS` | 真实可达的 STUN／TURN 地址 |
| `CALL_RELAY_ONLY` | 默认 false；true 时要求媒体经 TURN，缺少有效 TURN 配置会拒绝通话 |
| `TURN_MIN_PORT`、`TURN_MAX_PORT` | 默认 UDP 49160–49200 中继范围 |
| `TURN_TLS_ENABLED`、`TURN_TLS_DIR` | 可选 TURN TLS 5349 及证书目录 |

开放 3478/UDP、3478/TCP 与配置的 UDP 中继范围；启用 TLS 时另开 5349/TCP。云安全组和主机防火墙都要放行。单独的 5349 回退不保证能穿过只允许 HTTPS 443 的企业网络。配置未提供 STUN／TURN 时，仅尝试当前网络可用的直连，不代表移动网络一定可接通。

客户端通过认证接口领取两小时有效的临时 TURN 凭据；客户端根据 expiresAt 提前刷新，最迟约 60 分钟领取一次并更新配置；刷新本身不重启健康媒体。刷新失败继续保留媒体并重试，过期凭据不能用于新的 ICE restart。服务端不返回共享密钥。

生产采用现有受控发布流程。先由管理员审核并安装更新后的 root-owned helper，再将实际配置保护为 `/opt/quiet-room/shared/calls.env`（root 所有、0600）；TLS 目录使用持久的 `/opt/quiet-room/shared/turn-tls`。后续正常发布与回滚会自动保留通话 overlay 和 profile，缺失必要配置会在停机前拒绝。不要只手动启动一次中继后继续使用旧 helper：旧版本的 `--remove-orphans` 可能在下次发布时移除它。完整步骤、权限要求和回滚边界见 `DEPLOYMENT.md` 的双人通话部署部分。

## 验证与上线前剩余项

- `npm run check`：生产构建及单元／服务器测试，涵盖签名、篡改、过期重放、MLS 身份、设备声明、权限生命周期、忙线、多设备抢接、撤销和临时 TURN 凭据。
- `npm run test:calls`：通话专项单元测试、真实 Chrome WebRTC 双向媒体与 ICE 重连，以及 320–1440px、横竖屏通话界面回归。
- `node tests/browser.e2e.mjs /tmp/quiet-room-call-integration`：真实页面、MLS 配对和认证 WebSocket 上的音频／视频接听、升级、拒接、挂断、权限与隐私清理，并继续执行原有聊天、多设备和恢复回归。浏览器使用合成音视频，不采集真实设备。

本机没有 Docker，尚未运行真实 coturn 容器或验证云防火墙。上线验收需在两部实际设备上覆盖 Wi-Fi／蜂窝网络、强制 TURN、30–60 分钟通话、网络切换及浏览器权限弹窗；同时确认 TURN 实际流量与内存。HTTP／WebSocket 健康检查不能代替这部分验证。

## 弱网连接策略与诊断（2026-09-10）

“对标微信”仅指体验目标：优先语音、自动恢复和可诊断失败。本实现采用浏览器标准 WebRTC、已认证 WebSocket 和既有 TURN 配置，不实现或声称掌握微信专有算法或服务端网络。

`call-connection.ts` 的阶段时钟支持并发阶段；trickle ICE 不必等待收集完成才发送邀请。
重复进入同一活动阶段不会延长其截止时间，锁定/结束会清除全部阶段和异步操作。

| 阶段 | 单次截止 | 超时码 | 恢复动作 |
| --- | --- | --- | --- |
| 配置 | 总预算 19 秒，单请求含响应体 4 秒 | CONFIG_TIMEOUT / CALL_CONFIG_TIMEOUT | 仅网络、429、5xx 按 250/500/1000ms 重试；格式、401、403立即失败 |
| WebSocket | 建连 8 秒、认证 10 秒、恢复总预算 30 秒 | WS_CONNECT_TIMEOUT / WS_AUTH_TIMEOUT | 重新建连认证，同一设备恢复同一 callId；认证拒绝结束安全会话中的通话 |
| invite/accept | 45 秒，接听不延长原始邀请期限 | SIGNAL_TIMEOUT | 结束邀请；确认丢失重发同一密文 eventId |
| SDP | 每次 8 秒 | SDP_TIMEOUT | 结束协商；迟到结果被生命周期代次隔离 |
| ICE gathering | 12 秒 | ICE_GATHER_TIMEOUT | 进入线路恢复；单个节点错误仅记录脱敏事件 |
| ICE checking | 12 秒 | ICE_CHECK_TIMEOUT | 进入线路恢复 |
| DTLS/SRTP | 10 秒 | DTLS_TIMEOUT | 结束安全媒体建立，不能将 ICE connected 当作成功 |
| 远端媒体 | 首次 10 秒，已连接音频短暂 mute 使用恢复总预算 | MEDIA_TIMEOUT | 等待 live、非 muted 的音频；缺失则结束并提示重新呼叫 |
| 质量统计 | 每次 12 秒，正常 4 秒采样 | STATS_TIMEOUT | 保留媒体，下次采样；不因缺失统计执行 ICE restart |
| 网络恢复 | 总预算 60 秒，每条路径约 12 秒 | RECOVERY_TIMEOUT / RELAY_FAILED | 第一次重新收集并 restart，第二次刷新验证配置再 restart，第三次有 TURN 则 relay-only；仍失败结束 |

初始 `iceTransportPolicy=all` 允许 host、STUN 与配置的 TURN UDP/TCP/TLS 同时参与浏览器 ICE；显式 relay-only 部署保留原隐私边界。`iceCandidatePoolSize=4` 在用户权限及信令准备期间预收集。URL scheme、主机/IP、端口、transport、空 TURN、relay-only、有效期及去重均经客户端校验；服务端不做“一个 DNS 节点失败则全局不可用”的预探测。可选 `CALL_ICE_REGIONS` 是 URL 到简短地域标签的 JSON 映射，仅包含已配置地址，凭据不含设备标识。多节点与各传输能否连通仍取决于管理员实际提供的 TURN 网络。

已连接路径短暂断开等待约 3 秒；单次 RTT 偏高只影响质量样本，不切线路。视频连续 3 个坏样本降低一级，连续 8 个好样本恢复一级：1.5Mbps/720p/24fps → 700kbps → 降分辨率与 350kbps → 180kbps/12fps → 暂停视频。暂停时禁用视频轨道和发送编码，保留音频；用户可点击“停用视频自动恢复”停止摄像头采集。质量枚举为 good/degraded/audio-only/recovering。

质量输入使用选中 candidate-pair、RTT、jitter、inbound 计数差分与 remote-inbound 丢包、availableOutgoingBitrate、轨道 mute/unmute；不把累计 bytesSent 当作 bitrate。候选类型包括 host/srflx/prflx/relay，中继协议优先读取 relayProtocol。缺失浏览器统计明确保持未知，不能把未知带宽当作零。

语音消息保留原 clientMsgId、上传 plan、blobId、分块密文与 MLS 待发箱。完成响应丢失时先查询同 blob 状态；普通重试不能重复生成消息或推进 MLS。错误区分 VOICE_CONNECT_FAILED、VOICE_UPLOAD_INTERRUPTED、VOICE_ACK_UNKNOWN、VOICE_DOWNLOAD_INTERRUPTED、VOICE_DECRYPT_FAILED、VOICE_DECODE_FAILED。浏览器 Fetch 无法可靠拆分 DNS/TCP/TLS 失败，连接码覆盖这些原因，不能伪造具体 DNS 诊断。

解锁期间可在本机控制台读取 `window.quietRoomCallDiagnostics?.()`，或读取控制器的 `diagnosticsSnapshot`。仅保留当前/刚结束通话的最多 64 条脱敏阶段事件，callId 使用带内存随机盐的 SHA-256；快照包含质量统计、候选类型/协议、重连和 restart 次数、是否触发 audio-only、建立时间及失败阶段/码。新通话替换旧快照，隐私清理删除读取入口。没有持久化或上传日志，不记录 SDP、完整候选、地址、设备标识、访问令牌、TURN 凭据、消息或媒体内容。

`npm run test:weak-network` 执行控制器/配置/信令/语音故障单元专项与 Chrome 注入专项；`test:calls:e2e` 和现有 CI 通话任务也执行浏览器弱网专项。CDP 测试覆盖 100/300/800ms、5/10/20% WebRTC 丢包设置、上下行带宽不对称，并输出实际接通耗时与观察到的丢包。信令断开及质量恢复另有可重复的合成输入，TURN UDP/TCP/TLS 的失败升级目前在控制器模拟层验证。真实页面主流程验证权限等待时的 pagehide/freeze、锁定后下一次通话以及语音上传确认丢失后的单消息交付。

标准依据：[W3C WebRTC](https://www.w3.org/TR/webrtc/)、[W3C WebRTC Stats](https://www.w3.org/TR/webrtc-stats/)、[Chrome DevTools 网络故障接口](https://chromedevtools.github.io/devtools-protocol/tot/Network/)。阶段超时和质量阈值是本项目初始策略，需要依据真实设备和线路数据调整。
