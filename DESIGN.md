# Quiet Room Design System

## 2026-10-24 十三项体验（V1.31）

沿用P1，用户确认[十三项V1](docs/requirements/2026-10-24-ui-13-fixes/README.md)免原型直接实施。设置外遮罩76%，底部44px关闭柄覆盖轻渐隐区域，滚动区保留48px末项滚入空间；深浅两种主题均保留下沿。在线单选24px圆形及16px／3px对勾，44px整行热区。创建logo192px、短屏144px，双对话左右5个SVG单位、1.8秒连续轻移；阶段字使用主题色。减少动态禁用位移及旋转。

历史loading为头部下方独立的小圆环与文字，不挤动历史行。图片详情仅保留标题旁44px关闭控件，无底部收起文字。表情等待标记在主体下方，正常过程文字不覆盖表情；可见状态最短400ms，过期中间态合并至最新有效状态，动效仍为原240ms，隐私优先。标签图标在现有品牌右下角绘制本机当前密室未读数，0恢复原图标，超过99显示99+。


## 2026-10-24 媒体、设置与阅读一致性（V1.30）

用户确认[本轮V1与S1](docs/requirements/2026-10-24-ui-consistency-backup/README.md)，明确免原型和流程图直接实施。沿用P1：媒体过程提示居中、触摸不变暗；普通文字及语音时间／回执统一右8px、下6px，媒体局部底板的可见右留白相应收窄。胶囊文字10→8px，灯连接折线端点，心形放大10%。设置保留独立来源画布，底部柄独占44px，外侧35%遮罩、下沿边界及同色顶部系统区。

EPUB撤下搜索，目录、阅读设置与独立页码跳转使用同一P1半屏语言；目录定位当前章节，字号按2px调整并保留阅读锚点。PDF／文本搜索与格式安全边界保留。视频默认应用内最大化，共用图片工具位置及拖拽退出／回弹；显式系统全屏仍独立。创建每阶段仅一句，SVG圆形完成标记平顺显现，真实就绪门槛不变。凭证已设置页的导出下方单独放置自动备份卡，使用现有开关，分类计数来自已提交、校验的备份。

## 2026-10-24 界面与交互一致性（V1.28）

用户确认[22项V1](docs/requirements/2026-10-24-ui-22-refinements/README.md)并明确免原型直接实施。沿用P1，页面往返统一280ms；设置保留来源滚动，设备标题与数量同行、刷新同位。凭证物料、密码与卡外主操作重新排布，占位文字常规字重；提交异常统一toast。创建品牌、阶段文字和圆环集中展示，媒体状态合并过期中间态且完成已开始动画，触控目标及隐私清理不变。完整参数见[移动规范V1.28](docs/design/mobile-visual-standard.md#2026-10-24-界面与交互一致性v128)，替代V1.26对应布局及原位错误描述。

## 2026-10-23 设置与恢复体验（V1.26）

已确认V1.4原型沿用P1；参数和状态见[移动规范V1.26](docs/design/mobile-visual-standard.md#2026-10-23-设置与恢复体验v126)。五组设置及独立在线样式页、同色系统区、透明浮动顶栏、原位创建圆环、三页凭证与独立恢复页替代V1.23的对应呈现。规范不代表真机通过；验证与交付以[本需求记录](docs/requirements/2026-10-23-settings-17-prototype/README.md)为准。

实施预览追加确认：设置不提供消息通知；密室列表共用子页280ms右侧推入／向右返回，遮蔽缩略图上方留24px，设备箭头固定三列布局右侧。

子页动效追加：设置来源画面保持原位，新页从右侧覆盖；密室切换保留独立旧画布的原几何与滚动位置，明确前后层级，返回只移出子页，避免祖先样式切换触发重排和残影。

## 2026-10-23 媒体播放与查看控件

本轮[已确认 V1](docs/requirements/2026-10-23-media-playback-viewer/README.md)将页内视频的中央播放／前后跳转和底部操作、进度条分开，移除重复播放按钮，倍速直接显示当前数值。图片删除和翻页沿用 #242124 深色媒体表面，删除图形使用高对比危险色；文件名与时间只增加局部不透明底，不新增整条遮罩。解码失败和需要再次点按播放独立占位，保留现有重试／关闭／翻页与权限；错误文字不得被播放按钮覆盖。44px 热区、200% 文字、键盘进度和短屏适配沿用 P1；原生播放器及隐私生命周期不变。对应规范 V1.25，原型与正式验证证据由需求记录拥有。

## 2026-10-24 语音气泡融合与同排回执

用户确认[静态V2.3](docs/requirements/2026-10-24-voice-bubble-integrated/README.md)并授权正式实施、验证与合并；实施中另要求收窄最大长度。保留40px主体／44px完整按钮、22×24内向声波和相邻13px整秒（gap8），共享文字消息的R16／收发侧底角R6、连续分组、主题颜色与深色发送渐变。时长驱动主体长度并预留统一元数据空间，包含时间／状态的普通字号总宽最多220px；200%文字允许在消息轨内增宽以保持可读和无重叠。取消语音独有鲜绿表面、R7与侧向菱形尾角。

时间和原回执使用11px字体，在同一语音行的最右端下移3px；收到为声波→秒数→时间，发出为秒数→镜像声波→时间／回执。元数据仍是独立节点，覆盖整行按钮但不截获普通点按，回执刷新保留播放器和媒体状态。加载仅图标淡动与无障碍状态，暂停无额外可见文字；播放失败保留原因，发送失败的44px重试可增加反馈行，防止挤占普通主行。引用仍在主行上方，减少动态保留静态播放边界。录音、试听、裁剪、原菜单、回执含义及隐私生命周期不变。规范V1.29和voice-message-ui拥有几何与真实媒体回归；音质诊断仍由旧语音需求单独拥有。

## 2026-10-22 二十四项精修

沿用P1及[移动规范V1.23](docs/design/mobile-visual-standard.md#2026-10-22-二十四项页面精修v123)：3.6秒分阶段创建、顶部设置抽屉、完整原图凭证、三步回验及页内恢复密码。本人归档改密校验原密码并停用旧在线读取能力；真实历史和应用锁边界由NEW_ROOM_ARCHIVES与SECURITY拥有。原型/流程仅本轮按用户要求免除；逐条证据及未通过项由[24项需求](docs/requirements/2026-10-22-chamber-24-polish/README.md)拥有，不以规范目标声称完成。

## 2026-10-21 设备接入失效页

独立状态页沿用P1主题，520px内容轨、20px左右留白、26px标题、14px正文／1.6行高、三步有序列表和44px底部「返回密室列表」。页面主体独立滚动，操作区不遮挡正文；使用现有锁形图标及accent-soft，不显示聊天或在线控件。参数及实组件样例见[移动规范设备失效补充](docs/design/mobile-visual-standard.md#2026-10-21-设备接入失效页v122)。

## 2026-10-21 页面与恢复流程修订

本轮用户明确直接实施。解锁居中／底部操作、子页标题对称留白、独立本人设备与帮对方进入、凭证卡片与恢复进度、最终双对话品牌、1.6秒创建动效由[移动规范V1.21](docs/design/mobile-visual-standard.md#2026-10-21-页面与恢复流程v121)定义；状态与导航、PNG兼容及授权边界以NEW_ROOM_ARCHIVES.md为准。普通toast1.5秒、错误2秒。其余P1主题与控件保留。


## 2026-10-21 邀请与隐私引导

沿用P1现有卡片、字体与主题。邀请标题改为用户指定的完整句，说明为剩余有效时间，主按钮“复制密室加入链接”。三步引导仅“已开启／已设置”状态片段用accent；说明维持ink-muted，长文自然换行。应用锁使用36×22轨道／44热区开关，“修改”为R12、14px、44高的次按钮。恢复凭证直接使用现有完整设置页及表单，见[移动规范V1.20](docs/design/mobile-visual-standard.md#2026-10-21-邀请与隐私状态v120)。

## 2026-10-20 新密室状态反馈

已确认的新密室沿用 P1，具体呈现见[移动规范 V1.19](docs/design/mobile-visual-standard.md#2026-10-20-新密室与反馈承载v119)。创建／复制原位完成，错误统一 toast，加入／接替由聊天内系统卡承接；备份与恢复继承既有设置页，私有历史气泡的标签、正文与时间各占正常流。静态 S2 保留供追踪，后续 toast 修订优先。实施和设备证据见[本需求记录](docs/requirements/2026-10-20-room-archive-static/06_implementation.md)。

## 2026-10-19 聊天与设置精修

[本轮V1](docs/requirements/2026-10-19-mobile-settings-chat-fixes/README.md)沿用移动视觉V1.18。名称管理、遮蔽页和在线样式使用既有P1页面、R12控件、520px轨道、20px边距；动作最小44px、间隔8px。在线样式预览复用实际SVG，子页无重复关闭；浅色返回和表情选中态具有明确边界。引用不侵占媒体尺寸，滚动渐变逐帧跟随；工具与表情直接交接、Emoji不等待本机收藏读取。语音边界与选区共用实时坐标，Gaussian保持既有强度。真实触控与键盘证据单列。

## Chamber original-device migration and shared settings, 2026-10-19

The [confirmed V2](docs/requirements/2026-10-19-local-migration-ui/README.md) follows [mobile visual standard V1.17](docs/design/mobile-visual-standard.md). Invitation/privacy cards share the message timeline's outer rails. Empty composer height is 44px and real multiline content grows to the existing 88px cap. Four code cells use 2rem/700; their timer is 13px/500 in the legend's right side, accent colored and prefixed “有效期：”. The landing headline stays on one line at default text sizes and reflows when enlarged.

Settings pages share a 520px content limit, 20px sides, 26px heading, R12 surfaces and a scrollable body. Adjacent bottom actions share width, 44px minimum height, 14px type and an 8px gap; the existing Back owner keeps the original handlers. Floating status/settings surfaces gain a weak ink border and shadow. Chamber's compact heart uses existing factual presence, visibility and reduced-motion behavior, without an idle heartbeat.

## Chamber mobile correction, 2026-10-18

The [confirmed nine-item V1](docs/requirements/2026-10-18-chamber-mobile-refinements/README.md) retains P1 tokens. Page Back uses the Auto-lock footer: full available width within 520px, 20px sides, 44px minimum target, R12, neutral surface/ink and bottom max(16px, safe area). Existing page actions are moved with their business handlers and accessible destination intact. The measured footer height reserves page content and floating-gallery controls, including enlarged text. Numeric verification says “输入密码”; loading/errors retain a stable prompt region.

Short timelines begin at their top inset with equal clearance above and below the Settings target; polling does not reset card reading position. The inviter row places “本次验证码” at left and accent-colored tabular countdown at right; the adjacent action says “复制”. Restart uses the exact “邀请链接被其他人占用？重新发起” label and an explicit confirmation. No code or countdown appears before the replacement invitation is claimed.

Mnemonic words occupy an independent page with ordered saving guidance and no quiz. Import and code editing preserve the background canvas; the focused bar follows keyboard geometry. Mnemonic completion reuses one input through word 11. The code bar displays four R12 cells with surface85%/ink15% fill (dark: surface76%/ink24% with a clearer field edge), 28px tabular digits and an accent current-cell indicator. Real keyboard timing is separately verified; samples and endpoint fallback are not a claim of native UIKit access. Parameters and component evidence live in mobile visual standard V1.16.

## Chamber code renewal and identity recovery, 2026-10-18

The [confirmed five-item V1](docs/requirements/2026-10-18-chamber-invite-recovery/README.md) keeps P1 tokens and replaces invitation-card hierarchy with a 20px title, 14px explanation, a readable 32px four-digit display and an adjacent 44px Copy action. The validity text is subordinate; link copy and explicit invitation restart have distinct priority. Expired claimant state replaces the old form, while inviter expiry replaces digits/copy with a clear status and next step. Chamber header controls use one right-aligned flex row without wrapping. Desktop keeps its wide chat layout and removes only its persistent sidebar/toggle for personal-root rooms.

Required daily numeric unlock is immediately present, without Cancel or entrance travel; Delete and optional Forgot remain available. Optional verification retains the established motion and cancellation. Identity import has a 26px heading, 14px lead, three columns of twelve indexed 44px/16px inputs and standard full-width primary/secondary actions. Compact spacing fits 320×568, 390×664 and 390×844 with keyboard closed, without scaling text or targets; enlarged text/keyboard may scroll. The maintained mobile standard records these scoped overrides; privacy teardown remains immediate.

## Chamber chat continuity correction, 2026-10-18

The [confirmed V1](docs/requirements/2026-10-18-chamber-chat-continuity/README.md) retains P1 foundations and 44px targets. Privacy guidance belongs to the timeline throughout invitation and active chat, preserving one keyboard/scroll owner. Focused Chamber headers remain transparent; dark invitation, code and guide cards mix 88% paper / 12% ink in OKLCH without an ordinary rim. Activation preserves the mounted chat shell, composer and reading position.

Auto-lock duration uses the shared 240ms half-sheet lifecycle at 54dvh (540px maximum), scrolling its existing choices. Selection saves and closes; cancellation changes nothing and failures retain the old choice. Its page has no persistent saved label. A sole bottom Back action uses the neutral surface and R12. The cover notice aligns its vertical center with the 80px hot zone and leaves at least 40px for outward rings; the defer button is transparent. Numeric pages commit the offscreen 100% transform before reveal, then use the existing 280ms horizontal transition; six 12px dots use uniform 1px borders. Reduced motion and synchronous privacy teardown remain authoritative. Current parameters and regression examples are recorded in the maintained mobile standard.

## Chamber invitation and privacy correction, 2026-10-18

The [confirmed V1](docs/requirements/2026-10-18-chamber-invite-lock-fixes/README.md) retains P1 palettes, system type and 44px minimum hit targets. Numeric keys contain only centered digits; setup, daily and sensitive-operation numeric verification share one opaque page with 280ms horizontal entry/exit. Privacy removal remains synchronous and reduced motion bypasses travel.

Floating controls start 12px below the top safe inset, inside a header measuring its actual height. The settings disc paints 34px inside its 44px target; the capsule paints a 34px minimum fill inside its at-least-44px target and grows for wrapping. Inviter code digits are 32px display text without per-digit borders or input fills. Invitation/guide/code cards use ordinary opaque surfaces and no default rim. Unchanged network/timer states preserve their DOM and do not replay animation.

Auto-lock has a 26px title, 14px introduction, 12px-corner groups, 14px labels, 12px support and existing switch geometry. Its 44px timing row reveals a scrollable set of existing choices only on request. Cover practice fills the error-page canvas without header/footer bands; an anchored downward arrow points to the 80px hot zone, whose outward rings are more visible. The result dialog puts gray “暂不开启” left and the primary action right. The existing 3.1-second logo sequence repeats, with a static reduced-motion state. The maintained mobile standard contains these parameters; older sections describe previous versions.

## Chamber refinement, 2026-10-17

The auto-lock page also has an independent device-local blank-area double-tap switch, enabled by default to preserve existing behavior. Disabling this gesture does not disable other lock authorities; failed writes retain the prior selection and preference changes reset any partial gesture.

The [confirmed V1](docs/requirements/2026-10-17-chamber-refine/README.md) keeps P1 palettes and opaque control surfaces. The original local mark uses an architectural doorway and two people, centered together with the Chamber wordmark. Its finite 3.1-second frame/door/people sequence does not block actions; reduced motion displays the final mark immediately. Numeric protection adapts keys and decorative space to the actual visible viewport, keeps 44px minimum targets and puts the first-create-only browser hint last.

Chamber removes the full-width header fill; the right-side status capsule and 44px circular Settings control keep separate opaque surfaces and quiet elevation. The invitation card and vertical three-step guide are sibling cards, without nested cards. Code, copy, deadline and restart appear after the unique claim; no visible request number. Mnemonic, cover practice and auto-lock use body titles, independently scrolling content and bottom-safe Back actions, superseding their previous top bars. Existing keyboard/layout ownership, accessible text enlargement and privacy teardown remain authoritative. Actual parameters are maintained in the mobile standard.


## Chamber identity and invitation, 2026-10-17

The [confirmed Chamber scope](docs/requirements/2026-10-16-personal-mnemonic-friends/README.md) retains P1 tokens and uses an original local C/paired-point mark with a finite introductory animation. Reduced motion settles immediately. Create/join artwork keeps a stable horizontal position. App lock comes before identity creation; the chat guide has three ordered, visually explicit steps: 助记词, 入口遮蔽, 自动锁定, without a defer action. Mnemonic confirmation, read guidance and enabled privacy controls are distinct states.

The claimant sees the verification card at the top of a pending chat shell, with request ID and an absolute, tabular, high-contrast 30-minute countdown. The four-digit code uses four separate 64px-high native inputs, numbered accessible labels, automatic next focus, backspace/arrow navigation and whole-code paste/autofill; it does not open the generic single-field mobile draft editor. The inviter also sees four code cells. Chamber chat uses the prototype's right-aligned presence capsule and settings; the inviter's copy action precedes the three-step guidance. Activated creator capsules retain the Safe action, pending invitations and joiners do not. Inactive communication is explained once; primary verification remains reachable on short/320px layouts. New recovery pages separate device approval, historical decryption and joint room recovery, show fixed scope/deadline and retain verified progress after interruption. Existing 44px controls, 16px inputs, body scrolling, light/dark palettes and synchronous privacy cleanup apply. These screens do not confer a security grade or promise native WebView/passkey support. Parameter exceptions and examples are also recorded in the [maintained visual standard](docs/design/mobile-visual-standard.md).

## Composer handoff and first protection pages, 2026-10-16

The confirmed [V1](docs/requirements/2026-10-16-composer-handoff-entry/README.md) gives native keyboard/panel exchange one screen-coordinate presentation owner. Expression/tools to keyboard fade the inert outgoing panel in place; the editing row goes directly from its painted position to the native keyboard edge. Keyboard to expressions brings the panel up while compensating the moving parent, without summing keyboard and panel occupancy. Defer timeline inset settlement to the handoff endpoint, keep bottom-following messages at their existing clearance and retain history anchors. Rapid reversal reuses the current presentation; user scrolling supersedes the captured anchor; privacy abort removes compensation immediately. The existing 360ms bounded fit and actual native viewport evidence remain authoritative, with no new focus exception or promise of UIKit animation control.

Tools paint their whole bottom safe area with composer-panel-surface. Root bottom sampling follows an open panel, then returns to the focused composer for keyboard input. Both first-create and invitation protection screens use the same local lock artwork, 26px/600 centered title, 14px/1.6 centered lead, 14px external name label, 48px/R12 field and bottom 44px actions. Content-driven large/small/no artwork and independent body scrolling retain short-screen and 200% text reachability. Existing passkey/password capability and authentication paths are unchanged. Actual examples and regressions are tests/fixtures/composer-handoff.mjs inside the mobile-safari-feedback entry; automated device contexts and physical iPhone evidence remain separate.

## Space and voice correction, 2026-10-15

The confirmed [space/voice V1](docs/requirements/2026-10-15-mobile-space-voice/README.md) keeps P1 colors, 44px targets and the existing 280ms page motion. A 72px recording disc grows from 1× to 1.25× on leftward cancellation travel; upward locking arms at 144px with the guide moved 72px higher. Paused voice uses themed waveform/selection surfaces, two outward-facing 44px boundary targets that stay separate at the minimum range, an inline compact preview inside the timeline, with its own slot before the trimmed track and the existing send action; preview and export both use the selected range. Delete uses Lucide Trash2 at the shared 1.8 stroke weight.

Mobile form editors use --surface for the field instead of a 15% ink mix; their accessory bar stays neutral. Exiting a nested overlay updates top theme-color and the bottom page canvas. Waiting invite copy is one sentence with a semantic-danger, tabular time. Joined spaces have no expiry label. Create/join fields and copy follow the V1 record; other device enrollment keeps its existing optional notes. List cancellation retains the source list under the editor; successful creation keeps an inert profile presentation until the destination is ready. Reduced motion and immediate privacy cleanup remain authoritative. Examples/acceptance are the real mobile-space-voice and voice-gestures browser entries; native Chrome/Safari results remain separate.

## Mobile continuity correction, 2026-10-15

The [ten-item correction](docs/requirements/2026-10-15-mobile-ten-fixes/README.md) keeps V1.5 geometry. Light inputs retain their 76% composer / 24% raised fill; dark inputs use 88% composer / 12% ink for visible separation. Light tool icon surfaces use 88% panel / 12% ink; dark tools retain accent-soft. These fills have no ordinary border. The input-row plane travels with the row instead of painting the expanded form's final footprint; its join to the tools stays opaque. The keyboard accessory underlay shares the existing keyboard transform, and retiring expressions move in the chat plane without inheriting the moving composer. Keyboard open/close preserves the presence layout. Settings push/pop planes remain opaque. Media long-press retains its concealed source until the inert preview is decoded and revealed in the same frame; privacy cleanup remains immediate. Quick reactions explicitly reset native button borders and backgrounds, with selected state and keyboard focus retained. Synthetic regression examples live in tests/fixtures/mobile-ten-fixes.mjs and the existing mobile-safari-feedback entry; native Safari remains a separate acceptance.

The browser IM visual system follows P1, explicitly approved for implementation on 2026-10-11. The primary reference is the user's Telegram light/dark screenshots, interpreted for Quiet Room's existing two-person product. This replaces the former Liquid Glass direction. Confirmation, source samples and scope live in the [requirement record](docs/requirements/2026-10-10-ui-system-exploration/README.md).

## Maintained mobile visual standard

The [P1 mobile visual standard](docs/design/mobile-visual-standard.md) is the maintained parameter reference. Read its relevant sections before UI work. Approved project adjustments must update the standard, its affected examples and discrepancy/acceptance records in the same task. Word and illustrated HTML are versioned exports. Preserve product and security contracts; never turn an unimplemented proposal into an implementation claim. R1 and the V1.4 media capsule and continuity update were confirmed on 2026-10-12; implementation status is owned by the [audit requirement](docs/requirements/2026-10-12-p1-ui-audit/README.md).

Debug mobile UI in the actual local project through the Codex browser, using verified device emulation before plain responsive resizing. Record mobile mode, touch/coarse-pointer support, UA, DPR and the effective viewport. Inspect live DOM/styles and interactions; retain screenshots only as evidence. Synthetic renderer samples, automated clicks and physical Safari touch/keyboard/chrome verification are distinct evidence. Developer access requires current-session authorization.

## Intent and palette

Messages are the primary surface when two people read a private conversation on a phone in daylight or at night. The interface uses compact typography, opaque controls, quiet borders and limited elevation. Browser chrome and a tall native keyboard are part of the available-space constraint.

`src/design-tokens.css` owns shared foundations, including the standalone administration entry; `src/design-system.css` owns app component rules; `src/appearance.css` supplies the other three local palettes. The existing `blue` storage identifier now means **经典** and retains compatibility with saved preferences. 松绿、雾紫、暖杏 remain available. The independent brightness preference offers system (default), light and dark. Old, malformed or unavailable storage falls back to system. Explicit light/dark overrides the OS inside the app; selecting system resumes OS changes. Palette and brightness save immediately in the current browser/PWA data space, synchronize same-origin tabs and preserve the previous effective value and selection after a failed write. There is no cross-device sync. The synthetic preview never reads private messages. This is the approved [V1 fidelity correction](docs/requirements/2026-10-11-p1-fidelity/README.md).

| Role | Classic light | Classic dark |
| --- | --- | --- |
| Wallpaper anchors | `#CAD381`, `#66AB84`, `#89BE87`, `#D0D7B2` | `#000000` |
| Incoming message | `#FFFFFF` | `#342234` |
| Outgoing message | `#E0FFC6` | Continuous `#944CD5` → `#9349F4` → `#3768FF` |
| Header | `#BCE8CF` | `#242424` |
| Composer | `#BCE8CF` | `#242424` |
| Primary action | `#34784A`, white text | `#7950BD`, white text |
| Secondary message time | `#67726B` incoming / `#3C783B` outgoing | `#C3B4C5` incoming / near-white outgoing |

Wallpaper colors and message fills follow the confirmed samples. Action colors and small metadata are adjusted for readable contrast, rather than copying low-opacity screenshot text. Pure black/white are deliberate reference choices. The local line-art tile is arranged from the existing Lucide 0.468.0 icons, with its ISC notice embedded in `src/assets/chat-pattern.svg`; it is bundled with the app, not fetched remotely. The prototype's larger Telegram pattern is not shipped. The local tile repeats at 200×250px; wallpaper gradients use the P1 top-left yellow-green, top-right green and lower-left teal arrangement. The synthetic appearance preview shares these tokens and the local tile.

## Surfaces and typography

- `--paper`, `--paper-pure`, `--surface`, `--surface-raised` define opaque page, grouped and elevated surfaces. `--ink` and muted variants define text; `--accent`, `--action-surface`, `--action-ink`, `--danger` and `--focus` remain semantic.
- Legacy `--glass*` names are opaque compatibility aliases; sheen, control blur and glass shadows are disabled. New components use the semantic surface tokens. Do not remove media-concealment or privacy filters while changing decorative material.
- Use the system UI font. Messages are 16px / 22px at the default root size; their rem sizing scales with accessible text enlargement. Inputs remain at least 16px to avoid iOS focus zoom. Row labels and action text are 14px, supporting text 12–13px, message time 11px in rem units. Delivery glyphs retain their approximately 16px geometry and accessible descriptions.
- Use 4px within a message group and 12px between adjacent groups. A date separator ends a group. Bubble radius is 16px, with a 6px terminal side corner. Main surface radius is 16px; bounded controls 12px. Borders are quiet 1px lines, not luminous rims.
- Keep controls visually compact while preserving 44px hit targets, visible focus and native text selection. Small glyphs are usually 20–23px. Do not scale whole pages or reduce the body font to make them fit.

`--on-accent` remains the legacy outgoing-message text token. Filled actions use `--action-ink` separately, so pale light-mode bubbles do not force dark text onto a dark action button.

## Chat and keyboard space

The header remains 48px plus the top safe area, including while the keyboard is open. Existing presence, connection information, space navigation and optional heart remain available. Keyboard opening preserves the same presence and status arrangement. It does not add a new title or duplicate the peer information.

The composer starts at 60px with 8px above and max(8px, bottom safe area) below its 44px editing row. The input has 12px corners, no normal border or shadow, and a subtle fill mixing the current composer surface at 76% with surface-raised at 24%. Pointer/touch focus adds no outline; Tab navigation retains a visible keyboard focus. Multiline text grows to 88px and then scrolls internally, retaining native caret, selection and composition behavior. Growth reads the CSS cap. Reply drafts, recording and expression tools keep their existing state owners.

Desktop input uses the same compact vertical scale; its floating tools keep an 8px gap above the composer module, matching the confirmed prototype. The mobile expression panel reuses the measured keyboard plus accessory occupancy, so the editing row reaches the same screen position. Its first unmeasured opening uses a bounded fallback. Vertical rail pulls do not change its detent; horizontal scrolling and collection reordering remain available. Held recording uses a 72px feedback disc inside the viewport; cancel feedback remains destructive red.

The confirmed V1.5 tools panel has square outer corners, no decorative handle, 12px top/bottom spacing and four columns. Its six actions retain their order and availability, with 48×44px icon surfaces and at least 64px targets. Both composer panels use --composer-panel-surface: surface 70% plus composer-surface 30% in light mode, surface-raised in dark mode. The expression rail uses a minimal folded-sticker-plus Add icon, Emoji, Favorites and installed covers; its keyboard-sized panel has square top corners and no Expand/Restore or Collapse controls; the composer Plus stays unchanged. Emoji targets remain at least 44px, with columns adapting to narrow widths; stickers stay five columns. Tools travel for 240ms on a velocity-preserving cubic path. Expression and editing-row handoffs share the existing 360ms keyboard fit; all commit final geometry once and animate only transforms. Closing panels become inert immediately; ordinary visual exit completes before removal. Reversals reuse the painted position and velocity. Reduced motion settles immediately, background ends presentation, and privacy teardown removes it synchronously. Locked recording keeps the 72px send disc; paused previews return to a 44px control.

Mobile form data fields use the shared titled draft overlay defined in the maintained standard: freeze the background layout, follow the visible viewport only in the editor, commit explicitly and clear on privacy/navigation invalidation. Chat input retains its existing continuous editing. The existing VisualViewport, keyboard gesture, list/document scrolling and bottom-following controllers remain authoritative. A header inset change must compensate a history reader's scroll in the same task before paint; latest-following retains its existing endpoint alignment. Group spacing must not alter the established latest-message/composer gap. Keyboard open/close, interrupted motion, Chinese composition and browser toolbar movement need regression coverage. A desktop short-viewport simulation is not evidence of real iPhone keyboard behavior, and native Safari toolbar transparency is not promised.

The current outgoing dark gradient spans the rendered timeline. The maintained target samples the current visible chat viewport, so offscreen history does not stretch it; layout coordinates keep in-flight transforms from changing the field (standard 03 3 / D20). Media and expression bubbles preserve their intrinsic geometry, concealment state and contrasting metadata overlays; expressions retain their transparent exterior.

## Long press and other overlays

Long press uses the approved reaction / selected message / action-list hierarchy. The six existing reactions and their protocol stay unchanged. Replies lead the current actions, destructive deletion is red, and text selection is last behind a divider. Availability still depends on message kind, ownership and confirmation; this design adds no pin, forward or report functions.

A sheet's visible handle is 32 × 4px. Interactive invitation handles retain a full-width 44px drag area around that mark. Restoring an already-open drawer from settings is immediate; a fresh open or close keeps its transition. Increased contrast retains explicit strong input/control boundaries.

The selected bubble is an inert, aria-hidden clone above an 8px blurred focus backdrop. It retains media concealment and removes duplicate element IDs. Placement keeps the reactions above the preview and a scrollable 216px action card below it. If the visible viewport is too short, only the inert preview is clipped; the real message is unchanged. Closing, Escape, keyboard traversal, deletion choices and privacy teardown retain their existing lifecycle.

Simple two-action confirmations use an approximately 280px opaque dialog, 14px corners, a 17px heading and separated horizontal 44px actions. Complex summaries and recovery forms keep wider 16px-corner containers and 20px content insets; do not shrink their security text into the simple-confirmation layout. Half sheets use 18px top corners, a 32×4px handle and scrolling content; invitation drag thresholds and damping are unchanged. Recovery/history input panels keep their viewport-owned placement and security lifecycle. Toasts and tips use opaque 12px-radius surfaces, 13px text and semantic error colors. Successful operations and privacy cleanup never wait for a toast or transition.

Operation verification sheets meet the viewport bottom, including its safe area. Secondary joint-code, history-restore and backup-privacy panels share 17px headings, 18px top corners, 20px horizontal padding and a decorative 32×4px handle on mobile; desktop uses centered 16px-corner forms. Existing close controls retain 44px targets and existing gesture ownership. Their content scrolls independently from the visible action area in a short visual viewport. Device note and passkey-name inputs share the full available width, at least 44px height and 16px type. Empty and single-line chat editors center their 22px line within the 44px field, with symmetric fixed insets that remain clear when the existing 88px capped editor scrolls. Message-information stages are read-only 40px rows; their actions retain 44px targets. Photo details have a 64×44px handle target and square outer edges when expanded to the full viewport. Update notes remain a centered 16px-radius dialog with a single 20px horizontal inset, a fixed header and independently scrolling content.

## Settings and desktop

Settings uses a complete mobile page or desktop content pane, a 48px header, grouped 10px-corner cards, 24px colored icon tiles with 17px glyphs and ordinary 44px rows with 14px copy. Long text and 200% text enlargement may increase row height. Groups follow function without restoring the removed local/space split. The online-style value sits on the same row when space permits. Appearance uses native immediate-choice radios, independent brightness options and a synthetic preview. Notifications have one page heading and one 20px content inset; explanatory, permission and privacy text stays visible, while rows without long text retain the 44px scale. Private-space drawers use compact rows, a 24px selected-space title and a fixed footer. The scrolling body must keep all security, backup, device and appearance controls reachable. Full-screen password, recovery and device pages share the same colors and smaller bounded controls without changing their authorization or storage behavior.

Two-line settings and recovery-entry rows use 14px labels, 12px supporting text and 6px vertical padding; text enlargement or wrapping may grow the row. Drawer headings are 17px. Backup-code input uses the shared 12px-radius surface, 16px input text and an 88px minimum textarea. Cover-practice navigation uses the same compact header scale while retaining the existing practice gesture target.

Desktop layout begins at 1024 CSS px. Chamber and new room-archive rooms use the full workspace without a persistent sidebar or its toggle, including while awaiting the peer; space switching remains inside Settings. Only legacy rooms and the unapproved browser directory retain the 280px collapsible sidebar. Text messages remain bounded to 640px, and new-room invitation/privacy cards share that readable width. Embedded legacy drawers keep square outer edges.

The confirmed [PC adaptation V1](docs/requirements/2026-10-25-pc-ui/README.md) keeps P1 and uses a centered 720px settings dialog with 24px viewport clearance, 16px corners, an explicit 44px Close target and its existing focus/dismissal owner. The touch handle remains mobile-only. Settings children share a 720px content/header/action rail with 28px side insets; short desktop windows use 12px dialog clearance and retain scrolling. Four palettes, both schemes, enlarged text and visible keyboard focus remain supported. `src/desktop-polish.css` loads after the complete mobile cascade. Gallery headers use three slots when no sidebar toggle exists; media viewers and recording retain their viewport and gesture owners. Call chrome uses the same opaque surfaces, 48px control discs, a compact 24px peer title and 80px identity mark; video overlays retain contrasting dark controls over unpredictable video. The reader uses 52px header chrome, 44px controls and a 16px toolbar; reading typography, pagination and file sanitization remain independent. Administration uses the same foundations, 44px actions and 12px control corners.

Call toolbars retain 18px corners and video previews 16px corners at narrow and landscape breakpoints; the base peer title stays 24px, with the existing 28px desktop variant. App and administration switches use a 36×22px track and 18px thumb inside a 44px target; native confirmation dialogs use the shared 16px/20px/17px dialog scale, 14px body text and 12px content gaps without page-form margins. Reader search-result tips share the 13px text and 12px surface radius.

All existing routes are in scope: welcome and access verification; invitation, device joining and repair; browser access and passkey management; chat, space lists and settings; notifications, appearance and lock timing; devices; backup import/export and recovery; gallery, favorites and media details; document reading; voice and calls; help, releases and cover practice. Confirmations, bottom sheets, menus, inputs, switches, radios, empty/loading/error feedback and toasts share the component scale. Cover and privacy curtains preserve their immediate concealment and quiet browser-error presentation.

## Motion, accessibility and verification

Shared motion tokens live in `src/motion.css` and finite effects in `src/lib/motion.ts`: press feedback 100ms at .96 scale with one WAAPI scale/opacity owner (the voice gesture retains its own press feedback), local/message/page effects 180ms, half sheets 240ms, media 280ms, menu exit 140ms. Gesture settling remains critically damped and keyboard travel remains coordinated with the native viewport. Do not animate layout properties or restart progress/connection animations on every update.

Photo-detail sheet entry and exit use 240ms; viewer fade, zoom and return-to-source use 280ms. Ordinary Toasts remain for 2.6 seconds; errors remain for 5 seconds with the existing inline/status error locations. Toast entry uses 180ms and exit 140ms. Themed tooltips use 13px text, 12px corners and a 400ms mouse/keyboard delay, dismiss on Escape/blur/scroll and clear immediately on privacy concealment. Touch controls keep accessible names; security-critical guidance stays inline. Message/reaction and gallery menus exit in 140ms. Centered update notes use 180ms entry and 140ms exit, without inheriting half-sheet timing.

Reduced motion disables decorative motion. Reduced transparency and increased contrast remove the focus backdrop blur and wallpaper; forced colors uses system surfaces and explicit borders. Preserve keyboard focus, screen-reader state, 44px targets, at least 4.5:1 small-text contrast and the original media privacy lifecycle. No analytics, remote assets or runtime observers are added.

Verify the full product cascade in both effective schemes, all four palettes and at 320/390/768/1024/1440px, including short viewports, 200% text, keyboard focus, reduced motion and forced colors. Capture the actual invitation body and release-notes body, populated media surfaces, reader/expressions/voice/call states and administration dialogs; a substituted mock body is not coverage. Existing timeline, keyboard, scrolling, selection, reactions, deletion, media, recovery and call tests remain the functional authority. True iPhone / iOS 27 Safari keyboard, toolbar and touch validation must be recorded separately from browser automation.

## Private space identity and navigation

The confirmed space navigation uses P1’s existing opaque surfaces and tokens. Mobile lists are full pages with 48px safe-area-aware headers; all rows start at 68px with 40px circular avatars, 14px names and 12px previews. The current row uses a quiet tint/check, without a separate enlarged heading. Authorization has a 32px visual surface and at least a 44px target. The chat entry is avatar-only: 32px inside a 44px target, with the full space name retained for assistive technology. Settings has its own header target.

Creation separates an 80px avatar and change action from the externally labeled, 48px name input. Use a 1px quiet focus boundary, 12px corners and existing theme colors. Avatar source selection is a half sheet with the 32×4px handle in a named 44px button, without redundant heading/X controls. The invitation follows the same handle convention. Emoji editing uses a 96px preview, 44px background targets and six columns (five on narrow screens) of animated emoji. Animate every visible option, pause offscreen/background/inert surfaces, and honor reduced motion with stills. Crop uses a circular preview, drag/pinch gestures and compact accessible zoom/reset alternatives; do not render a native range slider.

Opaque top surfaces extend through the top safe area. The document’s bottom sampling background follows the composer, or the current full-page surface when navigating; source/invitation sheets use their own bottom surface. Native Safari chrome remains browser-controlled and requires real-device verification.

## Entry acceptance refinement (2026-10-13)

Settings uses the same 22px outlined gear in chat and space navigation, with a 44px clickable target. Page return controls share an outlined left arrow. Waiting invitations live in the conversation, including their current progress and remaining lifetime; opening a waiting space never opens a second invitation sheet. Avatar source selection opens directly over the space list. Explanatory copy uses a light outlined information symbol. Gallery empty states use local theme-aware photo artwork.

Full-page overlays and local hierarchy changes share 280ms horizontal navigation; source sheets use 240ms vertical travel. Semantic cancellation clears sensitive state immediately while inert presentation finishes leaving; privacy and runtime aborts still remove content immediately. Reduced motion skips travel. The browser top theme-color hint follows the current top surface, while CSS paints the separate bottom safe area. Actual native browser chrome still requires device validation. Password entry has no fixed reading/typing timeout; cancellation and page lifecycle continue to invalidate verification.

## 2026-10-14 移动交互修订

用户确认本轮免原型／流程图直接实施。移动设置按本次 iPhone 反馈直接进入全屏，无半屏停靠或顶部柄，240ms纵向进退；一级无返回，右上关闭。二级页保留设置画面承接280ms横向转场，返回恢复全屏与滚动。空间列表左侧进入、向左退出，右上关闭，移除列表设置入口。头像来源改内容高度，保留两项44px操作与安全区。

表单编辑满宽贴可见区下沿，标题14px、字段16px，完成按钮内嵌右侧44px热区；无取消按钮，遮罩／Escape仍放弃草稿。底色采用中性输入辅助栏表面；本地调试同步辅助栏颜色，原生Safari颜色另作真机验证。表情首行是“+”、Emoji和已添加合集，不再使用搜索或底部Tab。现有Fluent动画在Emoji最前，普通Unicode分类在同一滚动内容中。

聊天末行到输入栏目标12px；最新按钮按实际末行是否进入输入栏遮挡区判断，不按悬浮按钮自身位置判断。更新提示使用44px目标内的紧凑文字操作。键盘交接保持原输入节点和草稿，隐私清理立即执行。

## iPhone feedback revision (2026-10-14)

The [seven-item correction](docs/requirements/2026-10-14-mobile-safari-feedback/README.md) supersedes the earlier Settings detents. Settings fills the visible viewport and its scrolling body receives all remaining height, without a reserved bottom block. Chat header and composer share the effective surface, including the existing focused variant, across four palettes and both schemes. The form editor paints an opaque accessory underlay beyond the visible keyboard boundary and uses a stronger field fill; explicit Done and native keyboard Done finalize composition before commit, while cancellation and invalidation remain authoritative. Expression dismissal releases occupancy once and moves the editing row with the panel using synchronized transforms. Rapid handoff taps preserve focus. Fluent originals remain byte-identical; preview size is bounded to 36 CSS px and its physical pixel density. Progress updates with unchanged geometry retain their current motion, and retiring status snapshots never recursively clone earlier snapshots. Native iPhone keyboard, input accessory and browser material still require separate evidence.

## Composer and microphone correction, 2026-10-15

The confirmed [eight-item V1](docs/requirements/2026-10-15-composer-voice-refine/README.md) replaces the former expanded expression detent and independent preview. The Add page has only its 22px, 1.8-stroke Back inside a 44px target; Add is a 44px/R12 primary action and removal is a danger text action. Text and paused-voice Send use centered 23px SVGs. Permission preparation keeps the ordinary composer visible; first authorization releases its tracks and requires a fresh recording gesture. Only actual capture reveals recording chrome. Successful permission preparation is memory-only for the current private runtime, tolerates an optional query remaining prompt and clears on rejection/teardown. Keyboard opening waits for native geometry, follows reported intermediate samples directly and uses a smooth 360ms fallback for endpoint-only reports. A stale opening flag cannot prevent a trusted rearm after 900ms. The shared track owns both trim positions and pointer-to-sample mapping; outward 44px targets remain separate at the minimum range. Browser toolbars and the native animation clock remain outside page control. Regression examples are composer-voice-refine, mobile-safari-feedback and voice-gestures; physical-device evidence remains separate.

## Confirmed numeric password V1 (2026-10-15)

The [approved V1 prototype and flow](docs/requirements/2026-10-15-iphone-numeric-passcode/README.md) replace only new-password setup and numeric-wrapper daily unlock with the iPhone six-digit layout. Center the lock, title, six dots, three columns of circular keys with telephone letters, and the final centered zero. At 390×844, keys are 78px with 30px column and 20px row gaps; short/narrow layouts use 66–72px keys and scroll when needed. Default geometry matches the approved prototype. Intrinsic header/action height keeps enlarged text reachable without scaling the entire page. This surface uses the prototype’s neutral light/dark colors as a local P1 exception. System font, visible keyboard focus, original page motion, reduced motion and immediate privacy cleanup remain authoritative. No input field or native keyboard is created. Existing text-password pages and sensitive-operation sheets retain their current presentation.

## Compact attachment status, approved V1 (2026-10-23)

The [approved prototype and flow](docs/requirements/2026-10-23-media-status-compact/README.md) supersede the 32px media capsule: preparation, upload, submission and errors paint at 24px/R12; completed receipts and reveal hints paint at 20px/R10. Keep 12px process copy, 11px completed copy, 12px rings, 6px gaps, 8px horizontal padding and independent 44px action targets. Expressions retain transparent completed metadata below the image. File selections own their message card and progress from preparation onward. Unknown progress has no percentage; offline pending says waiting for connection. Upload completion is separate from server acceptance and read receipts. Same-ID retries restore complete feedback; a submission failure reuses its prepared payload without uploading again. A persistent shell uses 240ms width/height FLIP, inverse content scaling and 180ms crossfade, at most one retiring layer. Reduced motion settles immediately; privacy cleanup never waits. The maintained standard 11.3 and requirement validation record own actual implementation evidence.
