# 原邀请再次进入与首页地址清理 V1

## 身份、确认与授权

- 当前阶段：实现经PR #354合并，PR #356补齐版本；`2026.10.19.4`已发布为`7d21b371809e69a16f35d6f8930ebcad16809a14`，固定发布回执与独立生产回读通过。发布后记录由独立文档PR对账，文档SHA不替代线上应用。
- 2026-10-19用户认可本会话方案并明确「就按这个方案直接实施，不用再出原型和流程图，完成后测试并合并」。本次免原型／流程图；会话消息未提供独立定位。例外仅限本需求，不改变长期流程。
- 用户随后要求「发布生产」，授权版本准备及交付；完整main CI及只读预检就绪后，明确回复「确认，将 7d21b371809e69a16f35d6f8930ebcad16809a14（2026.10.19.4）发布到生产。」。授权仅绑定本次精确应用，无独立消息permalink。
- 规则来源与起始基线：`fe26f4f07dbc3acb1fb904b35bbb2942c0e36b25`，开工时本机main、origin/main与GitHub实时main一致。
- 独占工作树：`/Users/zhouding/ss-worktrees/chamber-invite-reentry-20261019`；分支`codex/chamber-invite-reentry-20261019`，跨电脑接续需重新核验。
- 发布准备另用独占工作树`/Users/zhouding/ss-worktrees/chamber-invite-reentry-release-20261019`、分支`codex/chamber-invite-reentry-release-20261019`；基线与规则来源为`15013ca1c98d134e6e3f15e5de5b8c11fa5a9422`，开工时本机main、origin/main与GitHub一致，较应用合并仅增加上一版本发布记录。

## 方案与边界

- 现状：锁定入口优先用邀请能力读房间，已消费能力返回INVITATION_CLAIMED，导致原受邀方被拦；sessionStorage丢失也会令已加密保存的待加入任务重新占位。
- 旧保险库尚无个人身份时，跨入新邀请的内存操作交接保留已验证的原加密保护包装；后续仍重新校验精确旧包装、复用原应用锁，不覆盖旧槽位、不另设新锁。
- 本机已有保险库先按原应用锁解锁，从加密目录定位原密室；核对原创建者指纹后复用原设备与本机历史。尚未完成则复用加密任务中的占位凭据。其他密室仍走已有空间切换与目标解锁。
- 已解析并交接的参与者邀请以history.replaceState替换为同源`/`，清除路径、查询及片段，保留history.state，不刷新、不增历史、不显示跳转提示；成功后刷新／同浏览器新标签页走原设备解锁。
- 无本机凭据不凭旧邀请授权进入，提示邀请已使用并提供本人身份找回；普通新增设备、双方授权、三设备限制和历史边界保留。轮换邀请与不同的未完成任务仍按原门禁处理；设备／修复／恢复链接不纳入首页清理。
- 不新增明文房间索引、身份缓存、密钥、服务端能力或生产配置。设计沿用DESIGN.md及移动视觉V1.17已有解锁／邀请反馈组件，无样式调整。

## 验收与交付

| 验收项 | 实现与验证 | 状态／限制 |
| --- | --- | --- |
| 已加入原密室：同标签、冷启动、刷新、新标签 | Chamber整链及邀请续入专项；核对原Root／设备／本机槽位与URL | Chromium／WebKit通过 |
| 临时占位缓存丢失后续接原任务 | 独立浏览器真实加密待加入记录 | Chromium／WebKit通过 |
| 当前为另一密室时定位目标 | 加密目录与正常目标解锁 | Chromium／WebKit通过 |
| 地址清理无刷新、不增历史且保留state | 主frame导航计数及History API断言 | Chromium／WebKit通过 |
| 非成员、轮换、撤销／关闭及不同任务 | 既有邀请／Chamber门禁及相关回归 | 非成员专项通过；轮换、撤销／关闭及不同任务由整链／CI回归核验 |

- 本地构建及单元：`npm run check`通过，131文件／1034项。`node tests/chamber-invite-reentry.e2e.mjs`的Chromium及WebKit行为断言通过，含原Root／设备／槽位、多密室、History API与非成员找回入口；单独按引擎续跑后结果相同。全浏览器入口为`npm run test:browser`，实际完成结果见关联PR验收记录。
- 失败分类：开发中的新夹具分别修正了同文档导航被误认为冷启动、History API事件被误计为重载、DOM尚未出现时条件提前成立及测试模块导入；产品断言保留。WebKit两次页面退出触发原renderCover → unread.refresh的原生资源取消诊断（已有try/catch）；专项独立记录该类诊断，未改未读或生命周期实现、不将其归为JS异常或真机证据。
- 初轮证据：`30eab02`的远端CI `39237761566`中，旧恢复批准面板关闭15秒超时（本机主流程同断言通过），以及Chamber通行密钥专项的无Root旧保险库交接失败。后者已定位并补齐原包装交接，本机该专项及重新构建／131文件1034项单元通过；保留原单次根／日常验证断言。初轮本地全浏览器31入口通过后为补修主动中断，不计为完整70入口通过；新候选重新验证并由关联PR核对最终CI，不把旧SHA结果移用为新SHA的远端证据。
- 远端证据：使用分支`codex/chamber-invite-reentry-20261019`的关联PR、精确head检查及最终mergeCommit核验；不以本机测试推断CI或合并成功。原生iPhone／iOS27／Safari及独立安全审阅未验证；桌面引擎模拟不能替代真机。
- 最终实现`02b9c73d0e5e544b6c661b25b0600a5574a0b1b0`的本地构建／1034项单元与完整70项浏览器入口均通过；[PR #354](https://github.com/zdaiwmm/shui-IM/pull/354)精确head的完整[CI 39238729471](https://github.com/zdaiwmm/shui-IM/actions/runs/39238729471) attempt 2通过。attempt 1的相册返回定位断言失败，读取失败原因后只续跑失败任务并通过，未修改该产品或测试。发布版本的精确main CI与预检单独核验，不复用PR CI作为发布门禁。
- 提交前检查差异归属、文本体积、敏感材料、二进制／依赖／产物误纳入；只保存合成测试及必要源码和文档。

## 发布验证与对账

- 发布包源`5eee40792cb80864a2390c7480f6693047e7975f`经[PR #356](https://github.com/zdaiwmm/shui-IM/pull/356)合并为上述应用SHA；仅版本元数据和记录区别于最终实现，运行代码一致。发布包本机`npm run check`通过131文件／1034项，文档检查通过；精确发布PR[CI39242244680](https://github.com/zdaiwmm/shui-IM/actions/runs/39242244680) attempt 1完整通过。
- 精确main[CI39243198868](https://github.com/zdaiwmm/shui-IM/actions/runs/39243198868)最新attempt 3完整成功，含全部70浏览器入口、通话、生产依赖审计、凭据扫描、双架构镜像和Full application verification。attempt 1中Chamber主流程的新标签页续入等待20秒超时，本机完整Chamber定向复核通过；attempt 2失败分片重跑于1分18秒主动取消，以完整attempt 3重新生成匹配镜像。原断言和超时未改，一次完整复验通过；本机watch API超时仅接续原run，不触发额外CI。
- 固定[只读预检39245305548](https://github.com/zdaiwmm/shui-IM/actions/runs/39245305548)取得PREFLIGHT_OK。精确SHA确认后只提交一个[正式发布39246479625](https://github.com/zdaiwmm/shui-IM/actions/runs/39246479625)，正常production审核由当前配置审核账号依本次用户授权完成，未修改或绕过环境保护；固定入口核对DEPLOY_VERIFIED。
- 首次独立回读仅备份starting，应用健康；核对实际备份启动`2026-10-19T11:46:44.289496213Z`、现有5分钟探针及启动期后，仅续跑同SHA的readback-only，于`2026-10-19T11:52:03.011Z`启动并在3251毫秒取得READBACK_OK。线上SHA、镜像、容器、公开／容器资源、HTTPS／数据库／存储和WebSocket一致，维护门absent；应用与备份healthy，TURN运行但探针none。
- 完整发布事实见[本轮发布记录](../../../RELEASING.md#release-chamber-invite-reentry-20261019)。脱敏证据在公共Git元数据`quiet-room-deliveries/evidence/chamber-invite-reentry-20261019/`，独立文档工作树`chamber-invite-reentry-release-record-20261019`仅对账；本批资源依固定清理门禁逐项核验。真机与独立安全审阅缺口保持，不从上线回读推断。
