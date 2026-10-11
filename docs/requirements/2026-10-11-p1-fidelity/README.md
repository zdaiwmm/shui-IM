# P1 全页面还原修正 V1

- 状态：V1 源候选验证通过；生产待精确提交确认。最终远端交付由 [PR #271](https://github.com/zdaiwmm/shui-IM/pull/271) 回执拥有。
- 确认：2026-10-11，用户明确“确认，按 V1 实施，包括你建议的明暗偏好规则。所有页面和 UI 细节都要逐项对照 P1 核验，不用再做原型和流程图。完成测试、PR、CI 和合并后，再确认具体提交发布线上。”本会话标识 `01a12853-5682-71f3-b84a-0b98ef07c9bf`，未提供独立消息 ID。
- 规则来源：本机 main `4356531cea264dd01bd9110da90b9ff62cfd7a59` 的 AGENTS／workflow；开工基线为已核验 GitHub main `0cb49a0db061ec33a468e21c710b6e0a874d2335`。共享 origin/main 已同步，本机 main 保持原样。
- 独占工作树：`/Users/achilles/Documents/Codex/shui-IM/.worktrees/p1-fidelity-v1-20261011`，分支 `codex/p1-fidelity-v1-20261011`。旧审计克隆只读参考。
- 依据：[已确认 P1](../2026-10-10-ui-system-exploration/prototype/README.md)、[原确认记录](../2026-10-10-ui-system-exploration/README.md)。本机差异证据位于原会话 visualizations 的 `prototype-fidelity-audit-20261011/AUDIT.md`，不提交截图或真实材料。

## 范围与边界

| 批次 | 验收目标 | 定向验证 |
| --- | --- | --- |
| A01／02／06 设置与通知 | 完整设置页面、48px标题、44px单行、小彩色图标及功能分组；长文字自适应，不恢复本机／空间二分；通知单标题／单内距 | settings-appearance、space-drawer-ui、desktop-layout、notifications |
| A03 外观 | 四配色兼容，独立系统／浅／深偏好及示例预览；默认系统、即时保存、失败保留原值、同源标签同步 | appearance、settings-appearance、system-surfaces |
| A04／05／12 表单和恢复 | 设备备注完整宽度／至少44px／16px；验证内容滚动与操作区分离；同级恢复表单和容器统一，业务独立 | password-fallback、passkey-management、local-history-backup、joint-recovery、backup-access |
| A07／08 聊天 | 壁纸尺度密度和渐变、连续输入工具栏、移动半屏；桌面工具定位及原键盘／滚动／录音所有者保留 | chat-tools、timeline、chat-list-viewport、chat-scroll-stability、voice-gestures |
| A09／10／11 控件 | 简单确认约280px横向双操作；复杂表单自适应；关闭44×44、普通动作14px、开关36×22与44px触区分离 | prototype-fidelity、browser-access、backup-admin-ui |
| A13／14／15 反馈 | 普通Toast2.6秒、错误足够阅读且保留原错误位置；退出140ms；主题化Tooltip与键盘／触屏规则；按压.96／100ms单一属性控制者 | motion、motion-system、motion-completion、frontend-lifecycle |
| A16 来源与覆盖 | P1→规范→组件→实际页面追溯；补真实入口／状态，不以更改断言适应偏差 | 本记录、DESIGN、产品入口矩阵及完整门禁 |

明暗偏好只保存在当前浏览器／PWA数据空间，配色独立；旧数据／无效值回退系统。手动模式覆盖应用内系统明暗，恢复系统后响应系统变化；刷新保留，同源标签同步，不跨设备。保存失败保留实际外观和选择。预览只用示例，不读取真实聊天。原生浏览器／系统表面仍由系统控制。

实施中用户补充指出占位文字未上下居中、设置文字与 P1 不同，并明确占位问题是聊天底部的“输入消息”，属于已确认忠实度范围。聊天单行22px行高与44px框改用对称11px上下保留区；不改文本测量、88px上限、键盘或历史锚点所有者。设置正文明确14px／400、标题17px／600，字体顺序和抗锯齿与既有P1对照；不新增字体下载。二级联合恢复、历史恢复与备份说明在移动端使用贴底18px顶部圆角容器，桌面保留居中16px表单；关闭触区44px，装饰柄不新增拖动职责。

不改协议、密码学、WebAuthn、设备／历史边界、恢复、通知权限、隐私生命周期或已有手势职责。长按保持反应→选中消息→现有操作，不新增账号、群聊、转发、举报、置顶或撤销业务。隐私清理不等待动画。

## 证据与交付

覆盖320／390／768／1024／1440宽度、浅深色及四配色，短视口、200%文字、键盘、减少动态效果和强制颜色。逐项补邀请真实正文、更新说明、有内容图库、媒体／图片详情、PDF／EPUB、表情、录音各状态、通话阶段、备份恢复进度和管理表格／弹窗；以实际入口和同状态截图核验。原审计14邀请模拟正文、29错误更新截图不计通过；设备404为夹具。

最终源候选的构建、完整浏览器、通话及精确PR CI已通过，详见下方合并前快照。末尾仅更新本记录与状态页，产品证据仍绑定源SHA；最终交付head、合并SHA和精确main完整CI由PR回执拥有，须独立核验后再提请本次发布。真机iPhone／iOS27／Safari键盘、工具栏和触摸独立记录，桌面模拟不替代。本次尚未授权或执行生产发布；旧84d5发布回读阻塞不授权重发。

## P1 到实际页面的追溯

共同依据是原型的 [样式](../2026-10-10-ui-system-exploration/prototype/styles.css)／[交互](../2026-10-10-ui-system-exploration/prototype/app.js)，长期尺度由 [DESIGN](../../../DESIGN.md) 统一拥有。以下入口使用正式组件与合成数据，不替换正文，不把合成内容记为真机或真实数据证据。

| 范围 | 正式组件／样式 | 核验入口 |
| --- | --- | --- |
| 设置、空间与外观 | space-drawer、appearance、system-chrome、design-system | settings-appearance、space-drawer-ui、desktop-layout；ui-detail-audit 读取 P1 实际字体计算结果并比较 |
| 首次使用、设备、访问与密码 | app 各 gateway／设备渲染器、password-dialog、browser-access-ui | ui-detail-audit、p1-controls、passkey-management、browser-access、password-fallback |
| 邀请、更新正文、帮助与演练 | renderInviteWait、release-update／release-notes、各 help／cover 渲染器 | ui-detail-audit 的 spaceInvite、release-update 的真实一次性说明；不沿用旧模拟截图 |
| 通知与反馈 | notification-settings、tooltips、control-feedback、motion | notifications（Chromium／WebKit）、p1-controls、motion-system／completion |
| 聊天与工具区 | design-tokens／system、现有 composer 与 timeline 所有者 | settings-appearance、p1-controls 空／单行中心、chat-list-viewport／scroll-stability／tools |
| 图库、图片详情与视频 | gallery、photo-details、media-viewer | photo-details 的有内容图库／菜单／展开详情／查看器；video-flow 的控制态与确认 |
| 文档、表情与录音 | document-reader、meme-picker、voice-recorder | document-reader 的 PDF／EPUB，meme-picker 的最近／emoji／搜索，voice-submission／gestures 的处理中／发送／失败／锁定／暂停 |
| 通话、备份恢复与管理 | call-view、backup-settings-ui、history-restore-ui、联合恢复及 admin | call-view 各阶段；history-restore／joint-recovery 进度与失败；backup-admin-ui／admin-collection-ui 的表格、详情与确认 |

`auditUiDetails` 固定36种实际页面／弹窗／菜单，五宽×浅深共360组合，另查320px下200%文字；`auditP1Surface` 在已有功能断言保留的前提下，按五宽×浅深及200%文字补各实际状态。四配色在 settings-appearance 检查可读性、持久化及失败回滚，在恢复表单检查共享表面，不声称所有页面逐一运行四配色笛卡尔积。PNG和结构化几何保存在本机 visualizations，不提交截图或大媒体。

## 候选准备

- 版本计划：固定入口生成并应用 `2026.10.11.2`，UTC `2026-10-11T01:26:04Z`，审阅确认旧版本对象原样保留、ID不重复。只是候选记录，不代表部署。
- 开发定向验证已覆盖构建、外观／动效与浏览器入口分组单元、明暗保存与跨标签页、短视口密码、Toast／Tooltip、草稿保留、空／单行居中、实际更新正文、通知双引擎、媒体、阅读、录音、通话、恢复和管理。最后字体／容器调整后仍须以冻结候选门禁为准。
- 证据夹具调整：使用正式加载顺序；媒体矩阵移到原手势断言之后；更新正文直接接入既有 release-update 路径。保留原功能断言和开发失败日志，未以改小产品断言容纳偏差。快速系统明暗切换复现了独立新查询与被观察查询采样不一致，现统一查询并补8轮切换回归。
- 冻结源与通过证据见下方；iPhone／iOS27／Safari真机与本次生产尚未验证／授权。最终远端交付仍以精确回执为准。

## 首次冻结验证与修正

- 源候选 `7cd7cdd47afbaace60539e3e04fed2287c3e9cfb`／树 `64fa33bd50d2b6bebd2dbc9310df75a260a31f85` 的本地 check:full 构建通过，855项测试通过、10项备份传输测试因磁盘98%触发 BACKUP_CAPACITY_LOW；命令仍为失败，未放宽容量门禁。独立通话专项通过（129.768秒），含20种合成弱网，非真机证据。
- [PR #271](https://github.com/zdaiwmm/shui-IM/pull/271) 首次 [CI](https://github.com/zdaiwmm/shui-IM/actions/runs/38102389218) 的构建／单元、依赖审计、通话／TURN和浏览器2组2/4通过，整体失败。浏览器旧透明输入区断言、7px上下保留区断言与用户已确认的实色连续背景、居中修正冲突；按新契约改为验证不透明／无模糊／输入区同色及对称11px，保留功能、滚动和定位断言。
- 动效夹具补齐正式加载顺序后，深色画布差异仍复现；进一步核对发现显式明暗选择器提高了旧 chrome-tint 的优先级。修正共享画布变量，使根／body与实际P1页面一致，保留并加强原背景一致性断言。
- `ebf2f19feb5cdf1e58888fbec16a9af05d868cdf`／树 `a764066b6e729569a67fb642c385a1e95ac63c0c` 构建通过，第二次 [CI](https://github.com/zdaiwmm/shui-IM/actions/runs/38103098052) 再次定位实时换行首帧失败：新高度66px接近动画当前66.34375px，旧分支提前清理消息位移，消息跳约7.7px。本机确定性66.25px边界同样复现，排除仅为CI时序波动；修正仅让活动转换继续保存／收敛原位置，闲置同高输入仍提前返回。原1.25px首帧阈值保留。
- 发现上述产品阻断后有意中止该候选本地完整浏览器入口，24项通过、文档阅读入口中断、34项未运行，完整命令仍为失败，不拼作全绿。修正后重新冻结并验证。
- 第二次CI还发现设置图标旧22px断言与已确认24px图标底／17px图形冲突，现同时验证二者。输入区颜色逐帧检查复现了焦点切换时子控件独立背景过渡；统一背景即时变化，保留按压／录音及其他属性所有者，并使桌面输入栏遵循相同连续表面。确定性换行原实现失败、修正后Chromium／WebKit通过；设置、桌面、工具和录音定向回归通过，最终完整门禁另行记录。
- `05276c7dd1bd3fe3251cbeb73e078a6f9c7d9329` 的第三次 [CI](https://github.com/zdaiwmm/shui-IM/actions/runs/38103848941) 其余检查通过，历史恢复表单复现12px无谓溢出。本机原样复现后，内存诊断确认百分比高度上限按内容网格行计算；显式视口网格行消除正常高度溢出，再按新增装饰柄预留量收紧短视口输入高度与重复间距。原整表单／按钮可见、等距内距和完整单码断言保留，修正后历史恢复Chromium／WebKit、联合恢复与备份访问通过。旧完整浏览器有意中止，2项通过、1项中断、56项未运行，命令仍为失败。

## 最终源验证（合并前快照）

- 干净源 `0d7dafccedd5f8f0eb5b32d34e7bc16cd75f35d7`／树 `32e537331eb2e2cfcd9f15539c1430cf17db5ff4`：构建通过；完整浏览器59／59通过（994.601秒）；独立通话专项通过（130.434秒），含20种合成弱网。三项证据均绑定同一SHA／树，`clean=true`。
- 精确 [PR完整CI](https://github.com/zdaiwmm/shui-IM/actions/runs/38104360110) attempt 1全部12项成功，含106文件／865项单元集成、59个浏览器入口、原生通话及认证TURN UDP／TCP。早期本机check:full仍因磁盘容量失败，不改记为通过；备份容量门禁未放宽，最终865项完整单元验证由CI提供。
- 主矩阵36种实际页面／弹层×五宽×浅深共360组合，以及36种200%文字检查通过；另保存63份实际状态矩阵、693个几何采样（包含同入口不同初态，不代表63个独立页面）。四配色、短视口、减少动态效果、强制颜色、焦点／草稿和隐私清理另有定向断言。抽查设置浅深／200%文字、聊天单行、恢复面板、联合恢复和更新正文截图，不将自动几何检查等同于逐像素人工审阅。
- 本机持久证据在本会话 visualizations 的 `p1-v1-final-0d7dafc`，包含命令日志、结构化布局、选取截图审阅及绑定源的交付摘要；不提交截图或合成媒体。文档收尾只更新本记录与状态页，最终精确PR／main CI仍须核验。
- 只读发布预检未通过：Git连接发生TLS中断，既有SSH在认证前关闭，未取得当前生产SHA；没有执行生产切换。旧发布状态未决事实保留。本次生产仍须用户确认最终精确提交；真机iPhone／iOS27／Safari仍无新增验证。
