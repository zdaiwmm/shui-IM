# 部署效率 V1

## 当前交付结论

两批实现均已验证并按顺序合并至`69b437c2f016aecde5063fff1be7070ebf1ac0cf`，文件树`ce84be5dc211175483221148d7edafa89f932e10`。随后主线仅增加既有审计整改的发布文档，成为`11ecacf422e794a102e958ec810ad31afe38c16c`；应用、测试、Compose、发布工具及CI代码与69b437c完全相同。原候选main CI40498006398 attempt1被该更新自动取消，未通过。[11ecacf的精确main CI40499312268](https://github.com/zdaiwmm/shui-IM/actions/runs/40499312268) attempt1完整成功，Full application verification、全部浏览器、通话／TURN、审计和同轮双架构镜像通过，用时649秒。固定精确CI核验器也已只读通过，两架构产物未过期；没有另开相同代码的CI。用户确认后已发布该精确应用11ecacf，本文档提交不替换它。

| 批次 | 精确源／PR与合并 | 验证 |
| --- | --- | --- |
| CI与本地验证工具 | 源`47ad5a1b5260dc2cf6348ddd98a7fae0ad61a384`，[PR #439](https://github.com/zdaiwmm/shui-IM/pull/439)，合并`da6f7d6fd38f3eb47c7ae8e3de0d6ce470162223` | [PR CI 40494325579](https://github.com/zdaiwmm/shui-IM/actions/runs/40494325579)及[main CI 40495931206](https://github.com/zdaiwmm/shui-IM/actions/runs/40495931206)均attempt1完整通过，Full application verification成功 |
| 备份启动及回读等待 | 源`6661c158d6b6dd77f485a60890982d6653c6e078`，[PR #440](https://github.com/zdaiwmm/shui-IM/pull/440)，合并为`69b437c2f016aecde5063fff1be7070ebf1ac0cf` | [PR CI 40496449280](https://github.com/zdaiwmm/shui-IM/actions/runs/40496449280) attempt1完整通过，含真实Docker夹具 |

用户随后针对已明确的11ecacf回复「确认，发布」，执行前展开核对完整SHA。唯一固定发布及首次独立回读通过，于2026-10-27 20:19完成；固定入口与回读约4分47秒，生产首次健康探针延迟10.007秒。原安全和验证门槛保持，未安装helper或改变云权限；真机和独立外审没有新增结论。

## 确认、范围与隔离

用户于2026-10-27在本会话明确回复「同意，按 V1 分两批实施，保持安全和验证标准不变，验证通过后完成 PR 合并，生产发布时再确认精确提交」。无独立消息permalink。非页面运维需求，原型与流程图不适用。

规则与第一批基线`0098a8f8a5418cd5b8ea130bd9309edfd1f1e119`；独立分支`codex/deploy-efficiency-v1-a-20261027`。第二批从实时main `668407ca5e762e591b9c07731510019ef832ac81`新建`codex/deploy-efficiency-v1-b-20261027`；各自位于本机`/Users/zhouding/ss-worktrees/`对应同名需求目录，未改共享工作树。

保留PR与精确main完整CI、全部用例／引擎／执行轮数、同轮双架构镜像、精确提交确认、生产审核、镜像校验、冷备份／回滚边界和独立回读。没有扩大轻量白名单、改产品断言、协议、业务代码、依赖或root helper。第二批配置已由本次精确获批发布激活。

## 实现与可观察验收

1. 浏览器四个专项分片按版本化的逐脚本耗时均衡，同runner仍串行，分片内原顺序保留；新脚本／无效测量使用60秒估计，仍执行。主流程独立、86个入口及全部浏览器轮数保留。
2. `delivery:evidence ensure`只复用本任务最新同命令、同提交／文件树／干净状态和执行环境的成功证据；旧记录、较新失败／中断或内容／环境变化均重新执行，`run`仍强制执行。执行文件绑定内容摘要／链接目标及版本资料；传输层CODEX_TOOL_CALL_ID从指纹和子进程同时移除，其他环境完整绑定。实际独立工具调用已命中复用；CI、生产、真机证明不参与复用。
3. Compose显式加入`start_interval:10s`；原5分钟启动宽限期、稳态5分钟间隔、10秒超时、1次失败及36小时备份时效判定保留。只读核查生产Engine26.1.3／Compose2.27.0支持该能力；[Moby v26.1.3实现](https://github.com/moby/moby/blob/v26.1.3/daemon/health.go#L234)在未设置该字段时回退到常规间隔，不能套用新版文档默认值。
4. 独立回读只对运行中备份starting状态每10秒观察，最长6分钟，每次重验部署身份、来源、镜像、维护门及应用／TURN；实际healthy后再执行原有全部独立检查。Docker判定unhealthy、丢失探针、连接失败、身份漂移及超时立即停止，保留失败证据；启动宽限期内的失败探针仍按原Docker策略保持starting。只续同SHA回读，不再次切换。初始无探针的历史版本保持原兼容，starting过程中丢失探针不视为就绪。外层只读子进程限时8分钟。

提前只读准备、原RunID接续与READBACK_OK后分开报告上线／对账沿用[既有入口](../../workflows/publish-efficiency.md)，没有另造发布器。

## 验证与计时

- 第一批最终源干净本地`check`通过149文件／1132项，30616ms；20项定向测试包含分片完整性、元数据触碰、实际内容变化、真实独立CLI及失效条件。实际再次调用`ensure check`只复用成功证据，没有启动测试。
- 浏览器分配／执行及产品断言与源`cf5fcdef`相同，该源本地完整149文件／1130项、86/86浏览器通过，0失败／未运行，1702396ms。原记录clean=false因Chrome启动ctime变化而不可复用，原样保留；结束后HEAD未变、Git干净。工具修正按影响范围补check和新精确完整CI，没有将旧记录改写为可复用。
- 第二批源`3b36217`干净本地`check`通过152文件／1158项，28686ms；最终头6661c15文件树与其[已成功验证的合并组合40494326234](https://github.com/zdaiwmm/shui-IM/actions/runs/40494326234)完全相同，仍重新取得新精确头完整CI。
- 本机无Docker。真实Docker CI使用无网络／宿主挂载／业务卷／生产配置的私有tmpfs容器，原探针失败时保持starting，合成健康收据就绪后才healthy，并拒绝过期、未来和最新失败状态。最终候选的[main CI40499312268](https://github.com/zdaiwmm/shui-IM/actions/runs/40499312268)启动检查已通过，测得健康收据就绪后9713ms变为healthy，夹具总耗时30658ms；不代表生产备份已完成或生产提速实测。
- 测量基线为[main CI40482174872](https://github.com/zdaiwmm/shui-IM/actions/runs/40482174872)的86个入口，仅保存脚本名与耗时。85个专项原分片累计681920／411040／302580／546540ms，历史回放均衡至约486秒，属于估计。
- 首个重排PR完整CI实际738秒，专项job572／607／611／620秒；第一批main完整CI实际590秒（9分50秒），最终11ecacf完整main CI为649秒（10分49秒），原对照main为772秒（12分52秒）。环境与排队不同，单次对照不作固定提速承诺。

## 本次生产验收

- 发布规则／工作流来源 `464322d6e76ad4eb665338530a928184171e0595`；隔离发布工作树 `deploy-efficiency-v1-production-20261027` 固定应用 `11ecacf422e794a102e958ec810ad31afe38c16c`。固定 doctor5925ms通过，复用精确 main 完整成功CI40499312268及同轮镜像；没有重复CI。
- 唯一请求 `eb95c678-cd59-422d-b2bb-688789ff3820` 的[正式发布40502197172](https://github.com/zdaiwmm/shui-IM/actions/runs/40502197172) attempt1取得 DEPLOY_VERIFIED，正常通过既有生产审核。实际前版7516e8e，沿用版本2026.10.27.4；批次 `20261027T121607Z`、完整镜像／归档／调用定位见[发布记录](../../../RELEASING.md#release-deploy-efficiency-v1-20261027)。
- 首次独立回读12:19:05.160Z至12:19:08.249Z成功，内部3087ms；应用／备份healthy、TURN运行（探针none）、维护门absent、完整SHA／镜像／公开和容器资源／HTTPS／数据库／存储／新WebSocket均符合。未进入等待或另行续跑。
- 实装启动期10秒探针；备份启动后10007ms首次执行成功。稳态300秒、宽限300秒、超时10秒、失败阈值1及原健康脚本保持。云发布核心199564ms，外层283415ms；固定入口加回读286599ms（约4分47秒），包含派发与正常审批，不含文档对账。一轮生产测量不承诺固定比例，CI的9713ms夹具测量继续保留其原口径。

## 失败边界与接续

原本地完整记录和中间成功CI均保留。Chrome启动元数据及每次工具调用的传输ID曾使本地证据过度失效，已分别以内容／版本标识和子进程输入规范化修正，并补跨独立CLI验收；未吞测试错误或放松产品断言。

第二批提前纳入第一批源后，GitHub在第一批合并时判定多合并基点冲突；本地计算文件树与已通过CI的组合一致，未绕过平台。正常合入第一批main后，精确树仍为`ce84be5...`，新头6661c15完整CI通过才合并。后续相同先后依赖批次宜在前批合并后冻结后批PR，避免这类额外CI；本地准备及不改变候选的工作仍可并行。

原始过程快照可从[69b437c中的记录](https://github.com/zdaiwmm/shui-IM/blob/69b437c2f016aecde5063fff1be7070ebf1ac0cf/docs/requirements/2026-10-27-deploy-efficiency-v1/README.md)回查。脱敏汇总位于公共Git目录`quiet-room-deliveries/evidence/deploy-efficiency-v1-20261027/summary.json`；本次脱敏生产回执、独立回读与实际探针核验另存同目录 `production-evidence.json`。生产已验证，对账使用独立无部署配置分支；按固定清理入口检查和执行本批资源，结果留在公共Git目录清理回执及summary.json，缓存／专属证据或活动目录按核验结果保留，未清理其他任务资源。
