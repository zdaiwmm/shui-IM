# 房间运行上下文、备份状态与私有历史 V1

## 身份与授权

- 阶段：已实施、合并、发布并完成独立回读；固定入口DEPLOY_VERIFIED与独立READBACK_OK均通过，本文件为发布后对账记录。
- 版本：2026.10.26.2（固定工具按UTC分配序号）；用户本次确认日期为上海时间2026-10-27。
- 基线：14848e71cf0c28753045f7f77200853427797642；分支：codex/room-runtime-archive-v1-20261027。
- 规则接手：本机main 4356531cea264dd01bd9110da90b9ff62cfd7a59；实时GitHub与origin/main均为上述基线。
- 用户于2026-10-27在本会话明确「不制作原型，按照方案执行，完成后合并，发布生产」。方案为本会话上一条完整V1；消息永久定位未提供。免除本次原型与流程图，授权I/D；生产仍需最终精确SHA确认。
- 向用户展示完整应用`9cf771de91598370bc77c1e73128ef5889b8a092`、版本、CI与预检后，用户于2026-10-27明确回复「确认，发布生产，并输出下一阶段优化方案」，本次P授权仅绑定该SHA。下一阶段为R方案输出，未授权新增实施或沿用本批原型例外。

## 已确认范围

1. 每次打开独立运行身份，旧成功/失败/finally不能回填后续上下文；读取有界并可取消，保留已进入原子提交的原槽位操作。
2. 同一只读备份状态表达凭证、自动开关、运行、旧恢复范围、最新覆盖与原件；未知不写成0/成功。
3. 私有导入先完成删除投影，再分页解密；来源room+消息ID、原件、私有边界、既有共享去重保持。页100，最多300条或8MiB正文；锚点独立。
4. 渐进迁移运行、历史、备份和接入投影所有权；不机械拆分全部app，不改密码学、后端权限、MLS原子持久化或原ID/原密文重试。

## 固定取舍

- 最新范围仅本浏览器当前密室已同步共享历史和已发布私有导入；不代表其他离线设备。
- 旧成功与新失败同时表达；共享隐藏不自动删除独立私有副本。
- 派生索引加密、可重建、原子采用；异常停止私有展示，原记录保留。旧标签升级失败需刷新，不能降级数据库。
- 真机及外部审计暂缓；模拟证据不替代。部署、证书与Mac灾备排除。
- Worker、复杂虚拟列表、更多无关模块迁移由测量触发，不默认扩张。

## 验收与证据

本会话V1的SID-01..10、BAK-01..14、HIS-01..14、ARC-01..08为验收索引。最终精确候选的命令、结果与耗时由本工作树`delivery:evidence`及PR/CI拥有，开发期结果不代替最终组合。

| 风险/验收 | 实现与自动入口 | 证据边界 |
| --- | --- | --- |
| SID-01..06/09、ARC-04/07 | room-runtime.test、room-runtime-isolation.e2e、archive-backup-state.test；锁定/切房/同房重开/重复打开/迟到拒绝/排队force | 修改前基线SID-01确定性失败：锁后retained=1、DOM仍遮蔽；修复后两引擎定向通过，不推断外传 |
| SID-07/08/10、ARC-05/08 | frontend-lifecycle、vault-lifecycle、privacy/system-surfaces、device-access、offline-outbox及现有MLS专项 | 需最终完整门禁；真实冻结、系统操作与iPhone暂缓 |
| BAK-01..06/09/13/14 | archive-backup-state单元/浏览器、settings-v14；12条整链验证10条部分完成、导入版本失效 | 页面动态状态与未知计数定向两引擎通过；最终门禁另记 |
| BAK-07/08/10/11/12 | room-archive-lifecycle、room-archives-store、archive-writer-lifecycle、settings-v14 | 原件缺失保留旧head、丢回执原ID、轮换/资格提交门禁由真实服务测试证明 |
| HIS-01..14 | private-archive-pagination.e2e、room-archive-lifecycle、timeline-model、message-deletions、vault-lifecycle | 删除后0显示、跨来源同ID、冲突、取消、加密目录缺页、锚点、双向页和30次释放；索引异常停止私有段 |
| ARC-01..03/06 | room-business-state、own-space-directory、pc-room-access、spaces、new-room及旧恢复专项 | 状态投影不授予能力，不改变协议；旧格式不迁移 |

## 测量方法与开发期样本

`QUIET_ROOM_PRIVATE_PERF=1 node tests/private-archive-pagination.e2e.mjs`：同一本机Chrome、临时合成库；1000/10000原始记录，10%删除事件、5%附件引用、普通正文2048字节。每种实现20次交错热读取；旧基线14848e71仅在测试中将DB打开版本改为16以读取同一夹具，读取/解密/投影逻辑不变。新目录首次认证与加密外部归并单列，原件未加载。开发期首轮：1000条建目录88.8ms、首屏中位21→17ms／p95 24.6→18.9ms；10000条建目录1042.8ms、中位207→18ms／p95 219.5→26.5ms。此为分段热读取，不是完整解锁、冷启动、原件或iPhone结论。正文热页解密100条，应用持有页不超过100条/8MiB，单条大记录例外；Chrome采样JS堆不包含原生缓冲/物理内存，也不承诺物理擦除。

## 存储升级、停止与回退

DB16只新增privateCatalog加密派生存储；原privateArchive/privateMedia不转换、不删。导入记录与集合版本在同一事务发布；失败/取消的暂存不显示、不备份。目录按128条扫描，删除角色与目标身份完整核验；最多8路加密外部归并，采用指针前核对集合版本。构建中断后下次在专用跨标签任务锁内丢弃未发布派生页重建；无Web Locks时保留CAS失败关闭，不删除可能被其他构建使用的页。专用任务锁不持有网络期间的vault写租约。

页面离开取消私有媒体，锁定释放页/DOM/URL；同runtime页面任务不回写旧页面。数据库升级时旧连接关闭，旧版本打开失败需刷新。功能回退必须保留DB16读取器；当前提供原记录有界扫描接口供重建/兼容导出，交互异常时失败关闭。撤销派生目录实现时仍须完成全部来源认证和删除投影后才显示，不得仅局部页过滤；不降级库、不移除原始记录或恢复材料。后端、密码学与设备边界保持。

## 最终验证门槛

- `npm run check:full`（含85个顺序浏览器入口）；公共运行期清理补`npm run test:calls:e2e`。
- 生产依赖审计与精确PR/main完整CI由既有门禁检查；轻量文档绿色不替代应用完整CI。
- 开发期首次完整检查因端口EPERM失败；受控重跑仅剩新增入口导致的旧runner计数断言，已同步85入口并定向12项通过。保留原失败，不把首次运行写成全绿。
- 真机、外审、生产均未验证。

## 设计依据

DESIGN.md、docs/design/mobile-visual-standard.md、src/main.ts实际加载样式和archive-settings现有组件。沿用当前P1纸面/主题/控件，本次不制作原型或新视觉方向。

## 交付

[PR #422](https://github.com/zdaiwmm/shui-IM/pull/422)已合并为应用`9cf771de91598370bc77c1e73128ef5889b8a092`，最终源`1768145ac08b1b509836fd1d56e04bfc31e4cd9b`；两者完整文件树同为`08aabc2a954f332c4812d52d17968bfcfbffde4b`。本批版本`2026.10.26.2`，后续纯文档提交不改变冻结应用目标。

干净最终源本地`check:full`通过：148文件/1114项，85/85浏览器入口，0失败/0未运行，1396492ms。另行`test:calls:e2e`通过，107737ms，包含原生Chrome媒体、通话视图及20个合成弱网场景；不等于实体iPhone或真实公网TURN损伤验证。证据由该源工作树的`delivery:evidence`与PR保留。

[精确PR完整CI 40368042830](https://github.com/zdaiwmm/shui-IM/actions/runs/40368042830) attempt 1成功，Full application verification、全部浏览器分片、通话、依赖审计和双架构镜像通过。[精确应用main CI 40372398641](https://github.com/zdaiwmm/shui-IM/actions/runs/40372398641/attempts/3) attempt 3完整复验成功，精确head、Full application verification、全部分片、通话和当前attempt的双架构镜像均已核对。首轮失败和局部复验取消保留于下方记录，不声称已定位修复原生诊断。

使用`src/main.ts`实际加载样式与`appearance`主题入口，核对390px浅色、深色200%字级和1440px桌面的新增备份状态段；截图夹具首次仅设置系统配色未应用产品主题，已修正核对条件并等主题过渡结束后重拍。视觉证据限该状态段，原型免除不等于真机验证。

[固定只读预检40375941485](https://github.com/zdaiwmm/shui-IM/actions/runs/40375941485)经既有正常环境审核取得精确PREFLIGHT_OK，88825ms，绑定main CI attempt 3与同轮镜像。用户确认后唯一[正式发布40376981116](https://github.com/zdaiwmm/shui-IM/actions/runs/40376981116)取得精确DEPLOY_VERIFIED，实际前版`460c57d06081d05419226c5d39f3afb659e1abca`；发布目标始终为上述完整应用SHA，云工作流来源为纯文档main `188c086`。

首轮独立回读仅备份starting，应用healthy、精确SHA/镜像一致、维护门absent；核对既有5分钟健康检查窗口后仅续跑readback-only。2026-10-26T18:33:16.148Z取得独立READBACK_OK，3162ms：应用与备份均healthy，TURN运行（无健康探针），HTTPS/数据库/存储/公开及容器产物/新WebSocket全部通过。没有重启或再次切换。完整[发布记录](../../../RELEASING.md#release-room-runtime-archive-20261027)拥有回执、镜像与时间；脱敏组合证据保存在公共Git目录`quiet-room-deliveries/evidence/room-runtime-archive-v1-20261027/production-summary.json`，不随实施工作树清理而丢失。

后续纯文档对账不替换线上应用SHA，也不触发再次发布。用户要求的下一阶段优化方案只在本会话输出，需后续确认才实施；真机与独立审计仍暂缓，公开高安全门槛不变。


### 补充故障注入证据

准备检查点落盘后，在archive-progress屏障取消，再新增排序更早的私有导入及共享记录，修复前确定性失败「备份来源已改变」，修复后同一用例Chromium/WebKit通过。续传改为固定检查点的私有身份/共享序号与原导入版本；不得将新导入版本错误写到旧扫描位置。保留原对象和源身份，不重置已有待传密文。升级被旧连接阻塞时明确要求关闭/刷新其他标签，本机数据保留。


最终开发期测量复核（同源代码、20次交错热样本）：1000条建目录92.4ms，首屏中位21.45→17.7ms，p95 30.4→18.7ms；10000条建目录1101.1ms，中位204.3→17.3ms，p95 214.7→39.5ms。旧实现持有1000/10000正文，新页持有100；30个私有控制器加载/取消循环后正文页均释放。Chrome粗采样堆最大值在同一热进程中约384MB（旧）/271MB（新），包含模块、夹具和GC差异，不能当作受控峰值或8MiB逻辑正文预算的物理内存证明。旧架构没有被删除用于测量：基线代码仅在显式性能模式读取，普通CI不依赖历史提交可见性。


### 首个冻结候选的真实回归失败

冻结源730f776626b44fc1661faaf3084a2889e1464e10的构建/148文件1114项通过；本机check:full在draft-refresh停止（5通过/1失败/79未运行），PR #422首轮CI同一用例失败。原陈旧保险库检查仍拒绝打开，但每次open推进全局runtimeEpoch使当前认证入口的错误反馈被误判为过期。修复采用独立RoomRuntime身份和取消信号区分重复打开，保留原全局认证epoch职责；不修改stale-vault拒绝、toast断言或15秒期限。新候选重新冻结并执行风险匹配完整门禁，不能沿用本轮失败作为最终通过。

同轮CI另有media-cache迁移断言仍预期DB15；更新为DB16，保留从DB10迁移的原128字节与usedAt=2断言。draft-refresh定向Chromium/WebKit通过。隔离夹具在取消旧构建后仍暂停其加密操作，却先等待同房新构建取得目录锁，形成夹具自锁；调整为先启动新打开、释放旧加密，再验证旧控制器保持空页且新控制器正常读完，不取消目录任务锁或降低隔离断言。五种屏障场景两引擎均通过；这些定向结果仍不代替新候选完整门禁。

### 精确main首轮CI失败

应用`9cf771d`的main CI 40372398641 attempt 1，分片3/4作业121746431895在`new-room-invite-privacy.e2e.mjs:91`失败（13通过/1失败/7未运行）：WebKit原生`web-inspector://bootstrap.js`报告unread请求「Fetch API cannot load http… due to access control checks」，调用栈经`unread-counter.refresh`/`refreshCoverUnread`。与此前状态页保留的未定位诊断同类，但本轮没有根因修复证据；同树本地完整检查与PR CI均通过也不能抵消这次失败。保留现有零页面错误断言，不改代码、过滤器或期限；按有界重试规程仅请求一次该失败分片的原样复验，最终main门禁仍须实际成功。

首轮固定只读预检40372693443请求已核对`mode=doctor`及完整应用SHA，经既有production正常审核后，因「Latest CI run for the exact main commit has not passed」停止，357831ms；未执行生产切换。2026-10-26 18:00 UTC通过单作业重跑接口请求上述失败分片一次，后续实际执行范围与结果按GitHub attempt记录核对；未改代码或放宽断言。main成功后只续跑只读预检。

单作业接口建立attempt 2但复用其他作业的原时间戳，产物仍仅有attempt 1的双架构镜像；发布工具`artifactName`/`findCIImageArtifact`要求当前attempt的镜像，不能用局部绿色替代。因此停止该局部复验，改为同一SHA的完整CI复验与镜像重建；不复制或重命名旧镜像，不放宽绑定门禁。局部attempt不计为通过，也不作为产品根因已修复的证据。

attempt 2实际取消后，完整重跑建立attempt 3（各作业从18:04 UTC重新执行）；2026-10-26 18:13 UTC完整成功，当前attempt双架构镜像均存在且未过期。失败类型没有通过修改产品或过滤错误来消除，本批结论仅为原样完整复验实际通过。
