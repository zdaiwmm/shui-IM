# 应用锁、聊天键盘与媒体回执修复 V1

## 身份与授权

- 当前阶段：获用户精确授权后，两个环境均已发布并独立回读通过；当前记录为发布后对账。
- 规则来源：本机main f8c4a1c352c3d8e237ced99cd7aa981774ee7ec3；GitHub实时main及origin/main均为f1416557769d305aefe7f61993ff3305afa9cae7，作为本任务基线。
- 独占分支：codex/inapp-media-keyboard-20261029；本机目录/Users/zhouding/ss-worktrees/inapp-media-keyboard-20261029。跨电脑重新核验。
- 2026-10-29用户明确：先解决应用锁／首次聊天键盘修复阻塞，再一并修复两项媒体时间样式；本次免原型直接实施，验证后合并，准备两个环境发布；追加截图中点击Safari底部区域收键盘后再次点输入框失效。消息独立定位未提供。原型及流程图本次均免除；初始只准备发布，后续精确发布确认及执行见文末。
- 纳入原PR #453精确源4a380ececa86f1675ee37c6a72138c3c9e3dcee8，保留当前主线续发、新消息、设备接入、链接预览及已发布版本历史。新任务树承担整合，不覆盖原任务现场。

## 方案与边界

1. 新应用锁共用能力判断：明确不可用直接数字密码；未知／原生验证未完成时明确重试、数字密码或取消。已有通行密钥仍验证原凭据；无效数据及不安全来源失败关闭。双击、取消和页面生命周期拒绝迟到写入。原确认及失败历史由[原需求](../2026-10-28-inapp-lock-first-chat/README.md)拥有。
2. 首次成员／MLS激活保持已存在的输入框节点，加入占位页无输入框时正常挂载；未就绪仍禁止发送。原PR的离线续发阻塞按当前主线的已确认修复重验，不放宽数量／顺序／加密／限流或超时断言。
3. 原生工具栏可夺走页面原生焦点却保留输入DOM焦点。原首批移除900ms旧打开标记守卫并保留首次聚焦；真机追加证据表明还需在可见页面窗口失焦时释放聊天编辑器，并保留返回点按的原生默认行为，直到键盘打开几何确认恢复。避免touchend取消默认后强制focus再次被原生层拒绝。组合输入完成前不主动blur，桌面、隐藏锁定、草稿、选区及网页衬底保焦原边界保持。
4. 图片、视频、相册及表情完成回执共用20px高、11px字、20px行高、横向8px、R10和4px时间／对勾间距。接收端只有时间，表情透明。发送24px固定布局槽及媒体／消息／邻条位置保持，完成内容在右端紧凑排列；未确认前时间隐藏，单／双勾事实及失败重试不变。

## 设计依据与验证限制

沿用DESIGN、PRODUCT、docs/design/mobile-visual-standard.md及实际加载的design-system／room-polish／memes样式。没有新视觉方向、第三方资源或依赖。共享完成回执由实际组件及浏览器尺寸断言提供样例；截图不入库。

浏览器自动化使用独立合成数据、移动UA／触控／DPR及合成视口；原生验证使用模拟失败和虚拟认证器。它们不等于真实Telegram、iPhone系统键盘或通行密钥证据。截图中的Safari地址栏属于原生界面，网页不能拦截其点击；产品修复作用于返回输入框时的恢复路径。

## 首批验收与证据

- 整合后基线check：158文件／1248项通过，尚不代替最终修改的完整门禁。
- 新增Safari旧打开标记回归：修改前失败，修改后Chromium／WebKit通过；保留草稿、选区、组合输入及网页衬底保焦断言。
- 媒体首轮遇旧底板伪元素位置断言，与新紧凑完成内容结构不符；改为检查真实可见胶囊20px及双方尺寸和4px间距，保留消息／状态／邻条连续性采样，未放宽原几何上限。
- 定向：inapp-lock-first-chat双引擎通过；media-upload含10种尺寸／表达、双方完成胶囊规格、4px间距、同ID重试和逐帧连续性通过；video-upload真实视频、首帧、确认后时间及紧凑间距通过。
- 首批最终干净源63992025c361ee38ea68a70bb1a4500d5e4b1931，完整树0aab754a0315d353e00a23a3af375fd586df5fca；check:full通过158文件／1248项及89/89浏览器入口，1802632ms（浏览器1778.19秒），0失败／0未运行。来源Git元数据delivery-evidence拥有精确命令、SHA及执行指纹。
- 追加WebKit media-upload通过全部10种尺寸／表达、双方完成胶囊及4px间距、失败重试／冷缓存／锁定URL清理；Chromium实际视频专项同时通过。
- [精确PR CI40843675627](https://github.com/zdaiwmm/shui-IM/actions/runs/40843675627) attempt2全部成功，完整应用验证、双架构镜像、全部浏览器、通话、文档及扫描均通过。首轮跨纪元129条全部接收但send=268超过原266上限；其余检查通过。只原样复验失败分组一次，23/23通过，send=244、接收129；本地相同边界send=241、接收129。原阈值和断言未改，根因尚未确定，不将旧失败或PR #453旧CI改写为通过。
- [PR #470](https://github.com/zdaiwmm/shui-IM/pull/470)匹配head于2026-10-29T09:09:21Z合并为应用1198ca0c8673864ffee97036ac9509b73c1090fb，版本2026.10.29.1；合并完整树与验证源一致。原PR #453同时被GitHub识别为已合并至该提交。本机干净main在独占集成锁内快进至应用SHA，无运行中的本项目main服务，不声明局域网真机验收。
- 两环境独立只读release doctor通过：production／https://ai.shui.click及tokyo-public／https://mijiu.cloud的连接、helper、环境身份和CI镜像支持正常，实际前版均为c1b3a9a2815bf36206f6e39cdb50fcd68e255b07／2026.10.28.8。
- 首批精确应用main完整CI40847411217 attempt2成功；首轮inapp-lock-first-chat在WebKit退出阶段记录同源未读GET的原生Fetch／access-control诊断，其余检查通过。只原样复验失败分组一次后通过，未改错误断言。后续带请求见证的只读诊断未复现，原失败根因仍未知。
- 首批合并阶段未发布；本批最终双环境发布见文末。原生Telegram应用锁与真实通行密钥仍未验收，Safari键盘真机范围见下节。

## Safari原生焦点补充修复（2026-10-29）

- 用户补充：等超过1秒及反复点击仍失败，点其他位置后再点输入框才恢复。USB iPhone（iPhone16,1、iOS27.2）Safari打开mijiu.cloud旧线上2026.10.28.8，只读数值采样发现窗口失焦、activeElement仍是textarea而CSS焦点消失；关闭视口695px、键盘打开319px。输入命中目标正确，未禁用、无只读／inert或指针遮挡。此前工具栏占用阈值假设与真机数据不符，未纳入修改。
- 补充修复：可见窗口失焦释放原生聊天输入焦点，返回手势不取消原生默认聚焦；打开几何确认后退出恢复路径。组合输入先完成再释放，运行清理时退役恢复归属。现有底部控件不能在页面失焦时重新抢焦点。
- 新回归在修改前失败，修改后Chromium／WebKit通过；覆盖程序focus被原生拒绝时的默认点按、首次聚焦、草稿／选区、非取消事件、缩放、IME与网页衬底。最终干净源1ae601928d376e7c64168e66d593435d506c3c49、完整树ec0dd1ae8198c12353af2ee29dad832f802f3979的check:full通过158文件／1248项及89/89浏览器入口，0失败／0未运行，1867425ms（浏览器1838.73秒）。
- 在同一USB iPhone的独立本机可信HTTPS合成聊天页加载本任务实际组件及修复源码，保留真实原生视口；用户重复“打开→点击原生底部区域收起→等两秒→直接点输入框”，明确反馈“每次都能直接弹出键盘”。只采集焦点、视口、矩形及长度数值，未采集消息文字，未注入生产事件监听或修改生产。无原生截图／录屏证据：显示服务当前不可用；不把USB或数值采样称为录屏成功。

- [精确PR完整CI40855611623](https://github.com/zdaiwmm/shui-IM/actions/runs/40855611623) attempt1全部成功，含全部浏览器、原生通话、单元、扫描、文档及双架构镜像。[PR #471](https://github.com/zdaiwmm/shui-IM/pull/471)匹配上述head于2026-10-29合并为应用4dd34c7df8bcae76d246bca2df86d7e7ac34a693／2026.10.29.2；合并树与验证源完整一致。本机干净main在本任务集成锁内快进，同步时无main目录Node服务，不把Git同步称为服务或真机验收。
- [最终精确main CI40859735589](https://github.com/zdaiwmm/shui-IM/actions/runs/40859735589) attempt1完整成功，固定发布核验器确认最新精确main运行／attempt、verify及Full application verification通过；全部浏览器、通话和同轮双架构镜像通过。两个命名环境的固定只读release doctor已在补充合并后再次通过（production6371ms、tokyo-public9271ms），当次发布准备时前版均为c1b3a9a2815bf36206f6e39cdb50fcd68e255b07。

- 2026-10-29T10:55:24.353Z最终只读准备：两个环境身份、容量和前版正向祖先通过；两者均为linux/amd64，匹配同轮未过期镜像产物12891515958，名为quiet-room-image-4dd34c7df8bcae76d246bca2df86d7e7ac34a693-1-amd64。仅核验元数据，该准备阶段未下载或导入镜像；当时两站实时前版均为c1b3a9a／2026.10.28.8，未切换生产。脱敏准备回执保存在公共Git目录quiet-room-deliveries/evidence/inapp-media-keyboard-20261029/release-ready-summary.json。

## 近期未上线盘点

- 原应用锁／首次聊天PR #453已由本批PR #470纳入，连同PR #471真机续修均已发布至两个环境，不再是漏发项。
- [旧PC适配PR #405](https://github.com/zdaiwmm/shui-IM/pull/405)仍未合并，原CI的移动反向动效首帧失败已原样复验一次后停止。当前主线缺少其独立desktop-polish样式、设置弹层720px限宽和44px关闭按钮；部分新版密室无侧栏目标已被后续PC修复覆盖，不能将整份旧补丁都认作漏发。本批不扩大到这项旧PC适配，也不绕过原阻塞。
- [旧续发PR #460](https://github.com/zdaiwmm/shui-IM/pull/460)仍为草稿，但其outboxResumeRequested续发请求合并逻辑已存在于线上c1b3a9a的src/app.ts，并由后续PR #465交付，不重复纳入旧分支。
- [东京对账PR #463](https://github.com/zdaiwmm/shui-IM/pull/463)仅7份文档，应用与配置已有原任务上线／回读证据；未合并文档不等于功能漏发。原任务对账阻塞保留，本批不重发或接管旧配置变更。

## 已发布应用与边界

冻结应用4dd34c7df8bcae76d246bca2df86d7e7ac34a693／2026.10.29.2，包含首批1198ca0c及真机阻断补充修复。后续纯文档提交不替换应用。两个独立目标为production／https://ai.shui.click和tokyo-public／https://mijiu.cloud。用户已精确确认这两个目标；固定入口各执行一次并分别独立回读成功，授权及结果见下节。

交付对账在独立codex/inapp-media-keyboard-record-20261029文档树维护，不含部署配置；精确应用main完整CI成功后再合并文档，不取消该应用验证，也不将文档提交替代发布候选。证据已保存到公共Git目录；资源依固定工具核验，不因清理再次发布。

## 本次精确发布授权与执行

用户在完整SHA、版本、两个环境、CI／预检及未验证项展示后回复「确认，按这个提交发布到两个环境。」本次授权固定应用4dd34c7df8bcae76d246bca2df86d7e7ac34a693／2026.10.29.2，同时包含production／https://ai.shui.click和tokyo-public／https://mijiu.cloud。无独立消息permalink；不追随文档main改发其他应用。

- production固定隔离入口一次执行取得精确DEPLOY_VERIFIED，725006ms；本机镜像准备440642ms；服务器总计218000ms，其中导入104000ms、冷备份73000ms。批次20261029T110904Z；切换前冷备份校验通过。独立同SHA回读于2026-10-29T11:12:53.346Z取得READBACK_OK，3945ms，无失败或重发。应用与备份running／healthy，TURN running／none，维护门absent；SHA／镜像、HTTPS、公开及容器资源、新WebSocket一致，管理员和通话启用。
- tokyo-public固定隔离入口一次执行取得精确DEPLOY_VERIFIED，845589ms；本机镜像准备326684ms，服务器总计458000ms，其中导入441000ms。批次20261029T111941Z，切换前冷备份校验通过。独立同SHA回读于2026-10-29T11:28:32.381Z首次取得READBACK_OK，12120ms，无失败或重发。应用与备份running／healthy，TURN running／none，维护门absent；精确SHA／镜像、HTTPS、公开及容器资源、新WebSocket一致；管理员关闭、通话启用。

本批linux/amd64镜像sha256:f799e4154d2a3032306e41a7498e12fdfd99fa67bd9c4e903920d830f5b8ebdf，归档SHA-256为78db17516387f1ad098386c432d25f46922a70bcef05e5b5fb6286b1e9b3da8d、212530104字节，绑定精确main CI40859735589／attempt1。固定发布与独立回读分别计证；脱敏摘要在公共Git目录quiet-room-deliveries/evidence/inapp-media-keyboard-20261029。没有新的Telegram原生应用锁或公网双设备通话验收结论。

两个环境全部完成后，仅在本独立文档树更新RELEASING、状态与本需求；[本次发布证据](../../../RELEASING.md#release-inapp-media-keyboard-both-20261029)持有汇总。没有再次部署或把后续文档main当作线上应用。
