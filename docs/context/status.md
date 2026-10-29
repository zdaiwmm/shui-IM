# Quiet Room 当前状态

## 当前生产：两个环境运行 2026.10.29.2（2026-10-29）

用户精确确认后，production／https://ai.shui.click和tokyo-public／https://mijiu.cloud均已更新为应用`4dd34c7df8bcae76d246bca2df86d7e7ac34a693`／`2026.10.29.2`。固定入口分别核对DEPLOY_VERIFIED，独立READBACK_OK分别于UTC11:12:53.346和11:28:32.381完成，均首次通过。两环境应用与备份running／healthy，TURN running／none，维护门absent；精确SHA／镜像、HTTPS、公开与容器产物、新WebSocket一致，production管理员开启、东京关闭，通话均开启。[发布记录](../../RELEASING.md#release-inapp-media-keyboard-both-20261029)拥有精确授权、前版、批次、冷备份、镜像及分段计时；后续文档SHA不替换线上应用。

本批PR #470纳入原应用锁／首次聊天PR #453并统一媒体时间回执，PR #471补Safari原生窗口失焦后的编辑器恢复。最终干净源158文件／1248项及89/89浏览器入口全部通过；精确PR与[精确main CI40859735589](https://github.com/zdaiwmm/shui-IM/actions/runs/40859735589)均attempt1完整成功，合并树与验证源一致。用户在同一USB iPhone／iOS27.2本机实际组件重复验收，确认每次可直接重开键盘；Telegram原生应用锁和真实公网双设备通话未新增实测，截图／录屏证据缺口保持。

[需求记录](../requirements/2026-10-29-inapp-media-keyboard/README.md)拥有首批失败、真机焦点证据及近期盘点。旧PC适配#405仍有未合并增量；旧#460续发已由#465交付，#463为旧文档对账，未混入本批。对账不再次发布；工作树与证据按固定工具核验。

## 上一批生产：两个环境运行 2026.10.28.8（2026-10-28历史）

用户在展示完整SHA、两个来源、CI／预检与未验证项后明确回复「确认，两个环境都发布」。当批两环境应用均为 `c1b3a9a2815bf36206f6e39cdb50fcd68e255b07`／`2026.10.28.8`；[精确main完整CI40693257651](https://github.com/zdaiwmm/shui-IM/actions/runs/40693257651) attempt1通过，包含本任务及此前已合并更新。后续知识库提交不替换线上应用SHA。

| 环境 | 本次前版 | 独立回读完成（UTC） | 当前证据 |
| --- | --- | --- | --- |
| production／https://ai.shui.click | `11ecacf422e794a102e958ec810ad31afe38c16c` | 13:41:41.777 | 原命令成功已恢复核实、READBACK_OK；外层云查询失败保留，缺少外层DEPLOY_VERIFIED |
| tokyo-public／https://mijiu.cloud | `054d868eff8bfc6575721a5e4cd16145864d1362` | 13:52:49.674 | 固定DEPLOY_VERIFIED及独立READBACK_OK |

两环境应用与备份均running且healthy，TURN running且探针none，维护门absent；精确SHA／镜像、HTTPS／数据库／存储、公开与容器资源及新WebSocket通过。production管理员启用，东京关闭，通话均启用。[发布记录](../../RELEASING.md#release-chat-link-preview-both-20261028)拥有唯一请求、原云状态查询中断、切换中首次回读失败、原命令退出0／Success与精确成功标记的恢复证据，以及两个最终回读。没有重复切换或把失败工作流改写为绿色。

东京在本次更新前实际已运行2026.10.28.2，由实时预检与既有脱敏交付记录核对；下方首发段落保留为历史。两环境来源、配置及数据独立；本轮没有新增物理iPhone、原生标签偏好、真实双设备公网通话或独立安全外审结论。对账在第二个不含部署配置的工作树进行，资源按固定清理规则逐项核验。

## 新消息与本人设备接入 V2：已随本批发布至两个环境（2026-10-28）

[PR #461](https://github.com/zdaiwmm/shui-IM/pull/461)已合并为应用`e1dec75e75967908149ca7e096a48d973f0844c7`／`2026.10.28.7`：新消息胶囊在输入框上方屏幕居中，锁定提示向上避让；接收解除待发等待，授权卡片稳定、双密室独立接入、上限toast及拒绝后旧密文重复发送循环修复完成。最终head9aa50的[完整PR CI40683922211](https://github.com/zdaiwmm/shui-IM/actions/runs/40683922211)及精确应用[主线CI40685667539](https://github.com/zdaiwmm/shui-IM/actions/runs/40685667539) attempt1均通过，合并文件树与PR head相同。本地1198项及43＋36＋9个浏览器入口全部覆盖通过；源码等价、环境与夹具失败及有界复验由[需求记录](../requirements/2026-10-28-chat-entry-device-access/README.md)拥有。本机main已集成应用；现随2026.10.28.8发布至两个环境，未启动局域网服务，物理iPhone未验证。

## 媒体发送连续性 V1.1：已随本批发布至两个环境（2026-10-28）

上传至正式消息复用同一行、媒体外框与固定状态槽；时间在服务确认后才显示，表情底行保持24px，聊天接管发送后清除表情面板的重复过程提示。最终源 `b7ba7fc93c9032f7b22daddc8cb0307e4757be13` 的本地完整1192项测试、88个浏览器入口及[完整PR CI40673111733](https://github.com/zdaiwmm/shui-IM/actions/runs/40673111733) attempt1通过。[PR #464](https://github.com/zdaiwmm/shui-IM/pull/464)已合并为 `6198839a16c9bc79d7b23da599d13daa952f7d0d`／2026.10.28.6，文件树与验证源一致；本机main已快进，无运行中的本项目局域网服务，真机未验证；现随2026.10.28.8发布至两个环境，生产证据见上方当前快照。[需求记录](../requirements/2026-10-28-media-send-continuity/README.md)拥有确认、原型、资源失败后一次有界重跑及正式交付证据。

## 网页链接预览 V1.1：已发布至两个环境（2026-10-28）

用户确认最终方案并授权两项续发回归修复和检查后合并。[PR #465](https://github.com/zdaiwmm/shui-IM/pull/465)已正常合并为应用 `c1b3a9a2815bf36206f6e39cdb50fcd68e255b07`／`2026.10.28.8`。输入紧凑预览、固定加密大小图快照、新标签及旧端降级保持；请求合并续发、当前连接、准备进展和原限流／有界发送断言均有证据。组合源本地构建／1246项、43＋37＋8完整88浏览器入口与[精确PR完整CI40689413752](https://github.com/zdaiwmm/shui-IM/actions/runs/40689413752) attempt1通过；第二片遗漏构建后的单次补建／续跑及所有历史失败由[需求记录](../requirements/2026-10-28-chat-link-preview/README.md)拥有。[精确应用主线CI40693257651](https://github.com/zdaiwmm/shui-IM/actions/runs/40693257651) attempt1完整成功；文档对账提交不替换上述应用SHA。两环境已按本次精确确认完成更新和独立回读；production外层云查询失败与原命令恢复证据分别保留，详见上方当前快照。物理iPhone及原生标签偏好未新增验收。

## 浏览器创建密室数量限制 V1：已随本批发布至两个环境（2026-10-28）

当前浏览器最多创建3个密室，加入不占名额；原始创建身份核验、同房间去重、移除释放名额和跨标签页保存复核已实施。超限保留来源并显示指定toast；恢复凭证页删去完成三步后显示已设置的说明，原流程保留。Chromium／WebKit创建限制及既有邀请／凭证回归均通过；最终候选 `83ae3085298c2d3473d182abc1be13edb6fc983c` 的[完整PR CI40659338970](https://github.com/zdaiwmm/shui-IM/actions/runs/40659338970) attempt1全部通过，含155文件／1184项测试、87个浏览器入口、通话及双架构镜像，verify成功。[PR #457](https://github.com/zdaiwmm/shui-IM/pull/457)已合并为 `c423647bd17ae85608cf8217a89815c41e8c9ef9`／`2026.10.28.4`；[需求V1](../requirements/2026-10-28-browser-created-room-limit/README.md)持有本地整轮限制与确认边界。现随2026.10.28.8发布至两个环境，物理iPhone仍未验证。

## Safari 底部网页区域与键盘重开 V2：已随本批发布至两个环境（2026-10-28）

用户确认本次免原型直接修复。[PR #452](https://github.com/zdaiwmm/shui-IM/pull/452)已合并为应用 `e970de778d4b95d40cd22da76acd6ddc76d2601f`／`2026.10.28.3`，与最终精确候选完整文件树一致。仅既有网页衬底在编辑时保留键盘，原生操作收起后可再次点按重开；其他区域保持原规则。干净源完整 86／86 浏览器入口通过，最终精确 PR 完整 CI40654313238 attempt1 通过；本机首轮单元超时、有界复验、旧候选 CI 超时及真机通道缺口由[需求记录](../requirements/2026-10-28-safari-keyboard-hit-area/README.md)拥有。现随2026.10.28.8发布至两个环境，精确应用与回读见上方当前快照；真机缺口保持。

## 东京通话中继权限修复 V1：已随本批发布至两个环境（2026-10-28）

[PR #451](https://github.com/zdaiwmm/shui-IM/pull/451) 修复重复未指定地址拒绝项造成的公网中继403，保留内网／回环／云元数据保护；新增九项白名单外权限回归，避免实验室白名单掩盖错误。完整精确 PR CI 通过，候选为 `054d868eff8bfc6575721a5e4cd16145864d1362`／`2026.10.28.2`，精确主线完整 CI40651713869 attempt1与固定核验器均通过，新环境普通更新 doctor 通过。它还包含主线最近在线保存修复；本次实时预检确认东京此前已运行该应用，旧知识库首发快照已过时。当前经用户精确授权随2026.10.28.8发布至两个环境，见上方当前快照。[需求与验证](../requirements/2026-10-28-turn-public-peer-policy/README.md)保留隔离复现、CI 原生媒体及本机两轮超时的区别。

## 东京独立对外环境首发历史（2026-10-28）

本节为首发阶段记录；当前应用及证据以本页顶部为准。`tokyo-public`／`https://mijiu.cloud` 已按用户精确确认首发应用 `39af219c330b9348aa7b0d2162e5c7c5336340db`／`2026.10.27.4`，完整 CI、固定 `DEPLOY_VERIFIED` 和 `06:52:29Z` 独立 `READBACK_OK` 均通过。应用、备份、HTTPS、资源及新 WebSocket 一致；管理员关闭，TURN 仅确认运行。新 Lightsail 东京 24 美元实例、来源、凭据、数据及备份均独立；原自用 `production`／`ai.shui.click` 未执行变更，下方旧环境发布记录不被新环境 SHA 替代。

首份快照已离机复制并在空目录恢复校验；容量及本地备份新鲜度检查与保守产物保留定时器已启用。14 个大陆／海外探针 HTTPS 采样全通过，但合成强制中继媒体测试失败：已隔离复现 `::` 拒绝项产生拒绝所有地址的问题，修复及其新版本发布尚未完成。单次 Mac 副本不代表持续自动离机备份或不可变存储，外部告警、真实双设备／跨网络及独立外审仍缺证据。[发布记录](../../RELEASING.md#release-aws-tokyo-mijiu-20261028)和[需求 V1.1](../requirements/2026-10-27-aws-tokyo-public/README.md)持有证据及失败恢复过程；对账不再次部署。

## 最近在线时间 V1：已随本批发布至两个环境（2026-10-28）

[PR #448](https://github.com/zdaiwmm/shui-IM/pull/448)已合并为 `2094c62889751fef48490a117eccb963b87b8930`／`2026.10.28.1`。每空间／参与者仅保存最近一次确认聊天在线时间；当前在线状态仍实时计算，胶囊样式不变。最终源本地 155 文件／1184 项、86/86 浏览器入口，以及精确 PR 完整 CI 均通过；合并文件树与验证源相同。需求确认、主线 CI 定位、失效旧时间及真机边界由[需求记录](../requirements/2026-10-28-presence-last-seen/README.md)拥有。合并阶段曾按用户要求先不发布；本次经精确双环境授权，现随2026.10.28.8发布，见上方当前快照。

## 部署效率 V1 已发布（2026-10-27 20:19）

[第一批PR #439](https://github.com/zdaiwmm/shui-IM/pull/439)合并为`da6f7d6`，补按耗时分片与精确本地验证复用；[第二批PR #440](https://github.com/zdaiwmm/shui-IM/pull/440)合并为候选`69b437c2f016aecde5063fff1be7070ebf1ac0cf`，补10秒启动期探针及最长6分钟的独立回读观察。原健康判定、宽限期、备份／回滚边界、全部浏览器及精确CI门槛保留。

两批精确PR完整CI均通过，第一批精确main完整CI通过（590秒）。69b437c的主线轮被后续发布文档更新取消，未通过；后续`11ecacf422e794a102e958ec810ad31afe38c16c`仅改文档，应用及验证代码与69b437c相同，[该精确main CI40499312268](https://github.com/zdaiwmm/shui-IM/actions/runs/40499312268) attempt1完整成功（649秒），Full application verification及同轮双架构镜像通过，固定精确CI核验器通过。该精确应用已按用户本次「确认，发布」上线，本文档提交不替换它。[需求记录](../requirements/2026-10-27-deploy-efficiency-v1/README.md)拥有逐层证据、执行指纹修正、合并历史处置及计时口径。唯一[发布40502197172](https://github.com/zdaiwmm/shui-IM/actions/runs/40502197172)及首次独立 READBACK_OK 均通过，固定入口与回读合计286599ms（约4分47秒）。生产实测备份首次探针在启动10.007秒后成功，原判定与宽限期保持；[发布记录](../../RELEASING.md#release-deploy-efficiency-v1-20261027)拥有完整定位与计时边界。

## 审计整改两批 V1 已发布（2026-10-27 19:28）

用户确认整改方案V1并授权执行；[第一批PR #436](https://github.com/zdaiwmm/shui-IM/pull/436)合并为 `668407ca5e762e591b9c07731510019ef832ac81`，补可信来源、四路写入限流、后台来源额度及畸形路径400，并澄清当前新旧格式规则。[第二批PR #437](https://github.com/zdaiwmm/shui-IM/pull/437)合并为应用 `7516e8e49959f7b24a5bfb305e5aa820191c4931`／`2026.10.27.4`，补手工备份容量准入、显式保留策略及隔离计时演练；与最终组合源 `15774ff` 完整文件树一致。

第一批完整本地86浏览器入口通过；组合本地153文件／1144项及灾备专项31项通过，两批精确PR完整CI均通过。原备份候选的旧空间恢复超时、取消的旧源复验、必要文档冲突集成及各层证据分别由[第一批记录](../requirements/2026-10-27-audit-abuse-hardening/README.md)和[备份记录](../requirements/2026-10-27-audit-backup-safety/README.md)拥有，不将未复现错误认定已修复。

应用 `7516e8e` 的[精确main完整CI40490796677](https://github.com/zdaiwmm/shui-IM/actions/runs/40490796677) attempt1已通过，含全部浏览器、通话及同轮双架构镜像。用户随后明确授权上述完整SHA、代理安装及实际链路验收。唯一[发布40494694818](https://github.com/zdaiwmm/shui-IM/actions/runs/40494694818)取得DEPLOY_VERIFIED，同SHA最终独立READBACK_OK于2026-10-27T11:28:01.568Z完成；两次备份starting回读按原窗口后续跑，没有再次切换。实装nginx、实测代理peer及新容器信任配置一致，主站／后台伪造XFF不能重置来源预算，另一实际来源有独立额度，自然窗口恢复；细节由[发布记录](../../RELEASING.md#release-audit-remediation-20261027)拥有。真机及独立外审没有新增结论；外部告警渠道和不可变存储继续按用户决定另定。本文档提交不替换线上应用SHA。

## 失效邀请创建修复已发布（2026-10-27 18:03）

[PR #434](https://github.com/zdaiwmm/shui-IM/pull/434)的失效邀请入口修复及[PR #435](https://github.com/zdaiwmm/shui-IM/pull/435)的验证取样续修已发布为应用 `e6dfcedccedd8b8adcea9a97224478c23fd59578`／`2026.10.27.3`。失效后创建正常，已有密室仍要求原应用锁，迟到结果保留隐私门禁；产品文件与原520f2f7相同，新增差异仅测试及记录。[需求记录](../requirements/2026-10-27-expired-invite-create/README.md)持有原失败、取样修正、用户改发精确SHA的确认及真机边界。

原520f2f7的main CI两轮失败，未发布；新精确PR与main CI均attempt1完整通过。用户随后明确确认改发上述完整SHA，唯一[发布40484081401](https://github.com/zdaiwmm/shui-IM/actions/runs/40484081401)取得DEPLOY_VERIFIED，独立READBACK_OK于2026-10-27T10:03:16.062Z完成。首次仅备份starting，按原5分钟窗口等待后只续同SHA回读；[发布记录](../../RELEASING.md#release-expired-invite-20261027)拥有精确批次与证据。真机与独立外审没有新增结论。

## 实时视频与语音修复 V1 已发布（2026-10-27 14:41）

[PR #431](https://github.com/zdaiwmm/shui-IM/pull/431) 已合并为应用 `75b01af61eb26ba1cbe5896881c3c354ead3a443`／`2026.10.27.2`，与冻结源 `264142d` 完整文件树一致。修复未选设备退出误挂、邀请失败与接听竞争、接听准备中取消及待挂载摄像头清理；加密与数据格式、TURN 和部署配置保持。范围、用户确认及失败分类由[通话修复 V1](../requirements/2026-10-27-call-reliability/README.md)拥有。

最终源本地完整149文件／1127单元集成、86/86浏览器入口及通话专项通过；精确PR CI attempt2、[精确应用main CI](https://github.com/zdaiwmm/shui-IM/actions/runs/40457899410) attempt1完整通过。首轮未定位WebKit未读Fetch诊断保留于需求记录。唯一[只读预检](https://github.com/zdaiwmm/shui-IM/actions/runs/40459706774)取得PREFLIGHT_OK，用户随后确认上述完整SHA；唯一[正式发布](https://github.com/zdaiwmm/shui-IM/actions/runs/40461354285)取得DEPLOY_VERIFIED，独立READBACK_OK于2026-10-27T06:41:06.647Z完成。首次仅备份starting，等待既有窗口后只续回读，没有重启或再次切换；[发布记录](../../RELEASING.md#release-call-reliability-20261027)拥有批次定位。真机、真实公网长通话和独立外审没有新增证据。

## 待发取消续接 V2 已发布（2026-10-27 11:33）

[PR #428](https://github.com/zdaiwmm/shui-IM/pull/428)合并为应用 `608dfea1e11ba20ddf2456fe380e38ea01230134`／`2026.10.27.1`，与最终源 `d4b6087` 完整文件树一致。取消后持久发送队列不再包含该项；独立加密核验材料仅供已接收消息的迟到回传，正常落盘后原子退役。刷新／重连继续收发，本机隐藏保持；DB16、协议、权限与运维配置未变。

最终干净源完整本地 148 文件／1114 单元、86/86 浏览器入口通过，0 失败／0 未运行，1667475ms；[精确 PR CI 40438327515](https://github.com/zdaiwmm/shui-IM/actions/runs/40438327515)及[精确应用 main CI 40441136003](https://github.com/zdaiwmm/shui-IM/actions/runs/40441136003)均 attempt 1 成功，Full application verification 与同轮双架构镜像通过。唯一[固定只读预检 40442557633](https://github.com/zdaiwmm/shui-IM/actions/runs/40442557633)取得精确 PREFLIGHT_OK，296727ms 含正常审核等待，实际前版为 `926a786`。用户确认上述完整 SHA 后，唯一[正式发布 40443816396](https://github.com/zdaiwmm/shui-IM/actions/runs/40443816396)取得精确 DEPLOY_VERIFIED；首次回读仅备份 starting，等待既有启动窗口后，同 SHA 只读回读取得 READBACK_OK。没有再次切换或运维配置变更。

修复前四个真实故障、夹具／CI 失败与一次定向修正、兼容及旧材料缺失限制见[需求 V2](../requirements/2026-10-27-cancel-accepted-validation/README.md)；[发布记录](../../RELEASING.md#release-cancelled-send-20261027)拥有精确应用定位。真机与独立外审未新增证据，不扩大为整站无故障结论。

## 恢复失败原件清理 R2 已发布（2026-10-27 08:54）

[PR #425](https://github.com/zdaiwmm/shui-IM/pull/425)已合并为应用`926a786e3e20c9148c8df805643c62fdd9edb9c7`／`2026.10.26.3`，与最终源`9246fe5`完整文件树一致。单份原件、随机run／来源范围及小型归属见证避免原件跨库再复制的额外配额；失败按归属清理，保留已有副本、其修复与并发写入。需求、旧候选失败及兼容边界由[恢复清理R2](../requirements/2026-10-27-restore-failure-validation/README.md)拥有，备份追赶优化未纳入。

最终干净源完整本地148文件／1114单元、85/85浏览器入口通过，0失败／未运行，1558905ms；含25恢复用例、两引擎清理保护、无锁并发与旧版兼容。[PR CI 40421681687](https://github.com/zdaiwmm/shui-IM/actions/runs/40421681687)和[精确main完整CI 40424742449](https://github.com/zdaiwmm/shui-IM/actions/runs/40424742449)均attempt 1成功，Full application verification与双架构构建通过。[只读预检40426096627](https://github.com/zdaiwmm/shui-IM/actions/runs/40426096627)取得PREFLIGHT_OK，120197ms，doctor请求66c71ca1仅派发一次；预检读到的前版为9cf771de。

用户确认上述完整应用SHA后，唯一[发布40427980206](https://github.com/zdaiwmm/shui-IM/actions/runs/40427980206)取得精确DEPLOY_VERIFIED。两次独立回读因连接关闭停止；用户报告防火墙IP已改后，仅续同SHA readback-only，于2026-10-27T00:54:52.395Z取得READBACK_OK，3346ms。应用／备份健康、SHA／镜像／公开及容器资源、新连接一致，维护门absent；没有再次切换。具体回执和前次失败见[发布记录](../../RELEASING.md#release-restore-original-cleanup-20261027)，文档对账不替换线上应用SHA；真机与外审边界保持。

## 前批房间运行与归档 V1：已包含当前生产

用户明确免原型实施并授权合并；[需求 V1](../requirements/2026-10-27-room-runtime-archive-v1/README.md)记录边界、DB16升级与回退要求、测量及失败分类。[PR #422](https://github.com/zdaiwmm/shui-IM/pull/422)已合并为应用`9cf771de91598370bc77c1e73128ef5889b8a092`/`2026.10.26.2`，包含独立打开上下文、统一备份状态、加密私有目录与有界正文页，以及接入阶段投影；完整文件树与最终源`1768145`一致。

最终干净源本地148文件/1114项、85/85浏览器入口及通话专项通过；[精确PR完整CI 40368042830](https://github.com/zdaiwmm/shui-IM/actions/runs/40368042830) attempt 1成功。[精确应用main CI 40372398641](https://github.com/zdaiwmm/shui-IM/actions/runs/40372398641/attempts/3) attempt 3完整复验成功，Full application verification及同轮双架构镜像已核对；首轮WebKit未读Fetch诊断未定位，局部attempt 2因镜像轮次绑定不足取消，完整原样复验与全部失败历史见需求记录。[只读预检40375941485](https://github.com/zdaiwmm/shui-IM/actions/runs/40375941485)取得精确PREFLIGHT_OK，88825ms；首轮预检因CI未通过停止。用户随后确认精确应用SHA，固定入口DEPLOY_VERIFIED与独立READBACK_OK均通过；该批生产证据见[历史发布记录](../../RELEASING.md#release-room-runtime-archive-20261027)。

## 前批 PC 八项与 macOS V1：已包含当前生产

用户确认免原型实施，追加更多按钮间距／居中；[需求 V1](../requirements/2026-10-26-pc-eight-macos/README.md)拥有具体范围、失败分类与证据。最终源 `91b7fae` 经 [PR #418](https://github.com/zdaiwmm/shui-IM/pull/418) 合并为应用 `460c57d06081d05419226c5d39f3afb659e1abca`／`2026.10.26.1`，完整文件树一致。包含 PC 几何、输入底色、返回位置及背景转场、列表与多余按钮、本人设备加密申请／系统卡批准、更多按钮，以及独立 macOS 包。

干净源完整本地验收通过 145 文件／1100 项、82/82 浏览器入口，0 失败／0 未运行，1359332ms；[精确 PR CI 40268466936](https://github.com/zdaiwmm/shui-IM/actions/runs/40268466936) 和[精确应用 main CI 40270491736](https://github.com/zdaiwmm/shui-IM/actions/runs/40270491736) 均 attempt 1 全绿，Full application verification 成功，head 已独立核对。用户随后确认发布本批生产；固定入口和独立回读均已通过，后续文档对账不再次发布。

本机包为双架构 ad-hoc 签名，Apple Silicon 启动及正式首页只读检查通过；没有 Developer ID／公证，Intel 执行和实际摄像头／通话未验证。安装包加载同一正式站点，本次网页修复已发布，无需为网页版本重新打包。

本页是带时间的接手摘要，不是实时监控。历史详情保存在 [发布记录](../../RELEASING.md)、
对应需求和 Git；[治理前完整状态快照](https://github.com/zdaiwmm/shui-IM/blob/bc329979e232d16a238190bc069eae32a85af4c9/docs/context/status.md)保留原证据和失败历史。

## 自用环境最近已验证生产：2026-10-27 20:19

- 应用 `11ecacf422e794a102e958ec810ad31afe38c16c`，版本 `2026.10.27.4`；部署效率 [PR #439](https://github.com/zdaiwmm/shui-IM/pull/439)／[PR #440](https://github.com/zdaiwmm/shui-IM/pull/440)及此前审计整改均包含。实际前版 `7516e8e49959f7b24a5bfb305e5aa820191c4931`；后续纯文档 main 不替换线上应用 SHA。
- 精确 main 完整 CI40499312268 attempt 1、固定只读预检通过。唯一[发布40502197172](https://github.com/zdaiwmm/shui-IM/actions/runs/40502197172)取得 DEPLOY_VERIFIED，请求 `eb95c678-cd59-422d-b2bb-688789ff3820`，批次 `20261027T121607Z`；工作流来源464322d，应用与工作流 SHA 分别核对。
- `2026-10-27T12:19:08.249Z` 首次独立 READBACK_OK：应用／备份 healthy、TURN 运行且无健康探针、维护门 absent，SHA／镜像／公开与容器资源及新 WebSocket 一致。无需额外等待、续跑或再次切换。
- 实装10秒启动探针，首探针延迟10007ms且成功；原稳态5分钟间隔、5分钟宽限、10秒超时、1次失败及备份健康判定不变。固定入口与回读286599ms（约4分47秒），不含文档对账；一轮测量不构成固定速度保证。此前19:28代理及真实链路验收见[历史记录](../../RELEASING.md#release-audit-remediation-20261027)，本次未改代理或 helper。

本页为部署时点事实，不是实时监控。[发布记录](../../RELEASING.md#release-deploy-efficiency-v1-20261027)持有回执定位；脱敏生产证据在公共 Git 目录 `quiet-room-deliveries/evidence/deploy-efficiency-v1-20261027/production-evidence.json`。仅按固定入口核验本批资源，活动目录、忽略缓存／专属证据和晚于应用的文档资源按结果保留，不处理其他任务。外部告警／不可变存储另定，真机与外审边界保持。

## 六批项目治理 V1：已包含于当前生产

- 用户确认全部六批并明确「立即实施」；[需求与验收矩阵](../requirements/2026-10-25-project-governance/README.md)拥有范围与结果。
- [PR #415](https://github.com/zdaiwmm/shui-IM/pull/415)合并为代码 `d00b11fd9e9c9d21ed4a482d76dc8714931d7331`；与最终源 `e5aa705` 完整文件树相同。该提交是当前已发布应用的祖先，内部改动已包含于生产；下面保留原批次验证，不追加独立真机结论。
- 本批应用 `530ddf51a03c592959b5db6a765eccc4f2006a51`／`2026.10.25.2` 曾于 2026-10-26 07:03 取得精确切换回执，原应用两次独立回读均受 SSH 连接阻断，不能记为 READBACK_OK。用户批准的临时单地址规则已新增并撤销，恢复原有 9 条。随后由上方已完整回读的 PC 应用接续；[本批历史发布记录](../../RELEASING.md#release-project-governance-20261026)保留各阶段证据，不补发旧版或覆盖最近已验证生产。
- 干净冻结源本地 check:full 完整通过：145文件／1098单元、82浏览器入口，0失败／0未运行，1410104ms。[精确PR完整CI40203889136](https://github.com/zdaiwmm/shui-IM/actions/runs/40203889136) attempt1通过；[精确main完整CI40205549905](https://github.com/zdaiwmm/shui-IM/actions/runs/40205549905) attempt2成功；首轮未确认WebKit原生unread Fetch诊断及原分片13通过／1失败／6未运行保留，通过单作业入口请求的唯一原样复验实际执行完整attempt2，未改代码或断言，不宣称已定位修复。
- 容量测试独立于宿主占用，保留真实文件与策略；新增合成服务器恢复、MLS及跨分块原件校验；时间线呈现投影抽成独立模块，归档去重改用索引；操作影响对照已完成，没有新增正式页面。
- 工作树／旧PR已逐项盘点，未知使用者、未证明集成和脏目录继续保留。追加工作树忽略规则后共享旧main状态干净；三条非法名称引用保全原字节／摘要和有效恢复ref后隔离，常规fetch成功。隔离不覆盖正常分支、工作树或提交。
- 原治理交付时的独占目录为治理树，文档分支 `codex/project-governance-evidence-20261025`，起点为已核实合并SHA；没有复制部署配置。公共Git证据位于 `quiet-room-deliveries/evidence/project-governance-20261025/reviewed-summary.json`，包含本地、只读回读、隔离修复和CI定位。
- 该批提交现已包含于本次固定应用；本轮不修改或清理其任务现场。纯文档对账 SHA 不替代线上应用 SHA。

## 语言与反馈 V1.1：已包含两个环境2026.10.28.8

功能由PR #454合入，已随精确应用c1b3a9a2815bf36206f6e39cdb50fcd68e255b07发布至两个环境；本页顶部生产证据拥有实际发布终点。旧PR #460仍未合并，但其续发请求合并修复已通过PR #465在当前应用重新实现、验证和交付，不再列为缺失功能。原CI重复失败及未定位动画证据仍由[原需求](../requirements/2026-10-28-language-feedback/README.md)保留，不将后续通过改写为旧候选通过。

## 后台仅动态码登录与双域名 V1：本地完整验收通过，生产未切换（2026-10-29）

用户明确直接实施并要求准备东京后台、发布前确认。目标为原生产 `admin.shui.click`、东京 `admin.mijiu.cloud`；原生产保留绑定，东京独立初始化。TOTP 单因素、完整编号加新码清理、持久化五次失败冷却及旧配置兼容已完成，本地159文件／1,253项及89／89浏览器通过，Chromium和本机HTTPS WebKit后台专项通过；东京绑定已在本机回验，0600配置未安装。[本次需求](../requirements/2026-10-29-admin-totp-only/README.md)拥有授权与验证，远端精确head／CI／合并入口为[PR #474](https://github.com/zdaiwmm/shui-IM/pull/474)。尚未执行 DNS、配置安装或生产发布。

## 仍开放的边界与证据缺口

- iPhone／iOS 27／Safari 原生键盘、触控、锁屏卡片和认证器验收暂缓；桌面／模拟测试不替代真机。
- 外部独立审阅暂缓，[公开高安全门槛](../../PRODUCTION_SECURITY_GATE.md)继续开放；内部回归与依赖扫描继续执行。
- Mac 主动拉取是现有过渡灾备：离线／睡眠中断、36 小时新鲜度门槛、无独立不可变存储及外部告警送达保证。实际配置和新鲜回执需按 OPERATIONS 回读。
- 原治理盘点时本机盘约 96%、19 GiB 可用，strict 备份成功夹具曾被容量门槛阻断；现已固定测试容量前提，真实生产准入不变。当时工作树约 12.7 GiB，清理不足以使整盘低于 80%；该历史本机快照不代表当前生产容量。
- 证书无人值守续期、整站灾难恢复时间、真实公网通话／网络切换，以及历史未定位浏览器诊断须分别取证；不因后续一次绿色抹去原失败。

## 接续入口

按 [工作流](workflow.md) 隔离、验证和交付；按 [项目地图](overview.md) 定位源码与专项；
按 [决策页](decisions.md) 和对应产品／安全契约处理语义。需求确认、代码存在、自动测试、CI、真机和生产状态分别记录。
