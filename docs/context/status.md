# Quiet Room 当前状态

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

## 最近已验证生产：2026-10-27 14:41

- 应用 `75b01af61eb26ba1cbe5896881c3c354ead3a443`，版本 `2026.10.27.2`；[PR #431](https://github.com/zdaiwmm/shui-IM/pull/431)。实际前版 `608dfea1e11ba20ddf2456fe380e38ea01230134`；纯文档main不替换线上应用SHA。
- [精确main完整CI40457899410](https://github.com/zdaiwmm/shui-IM/actions/runs/40457899410) attempt1成功，Full application verification、通话／TURN及同轮双架构镜像通过；完整本地、PR CI与失败历史由[通话修复V1](../requirements/2026-10-27-call-reliability/README.md)拥有。
- [预检40459706774](https://github.com/zdaiwmm/shui-IM/actions/runs/40459706774)取得PREFLIGHT_OK；唯一[发布40461354285](https://github.com/zdaiwmm/shui-IM/actions/runs/40461354285)取得精确DEPLOY_VERIFIED，请求 `6853f46d-b4b9-4f7a-9711-d91c3c41b405` 只派发一次，工作流来源 `9bed60b`；批次 `20261027T063102Z`，应用固定用户获批SHA。
- 独立READBACK_OK于 `2026-10-27T06:41:06.647Z` 完成，3366ms：应用与备份running且healthy，TURN运行（探针none），SHA／镜像／HTTPS／数据库／存储／公开及容器资源摘要／新WebSocket全部一致，维护门absent；管理员与通话启用。
- 首次回读仅备份starting；等待既有5分钟探针／启动期后只续同SHA只读回读。没有重启、再次切换或运维配置变更。完整回执与首次失败见[发布记录](../../RELEASING.md#release-call-reliability-20261027)。

本页为部署时点事实，不是实时监控。脱敏组合证据保存在公共Git目录 `quiet-room-deliveries/evidence/call-reliability-20261027/production-summary.json`；本批资源按固定入口核验，活动记录树与含缓存／专属证据资源按实际检查保留，不清理其他任务现场。备份追赶优化未纳入，真机与外审仍暂缓。

## 六批项目治理 V1：已包含于当前生产

- 用户确认全部六批并明确「立即实施」；[需求与验收矩阵](../requirements/2026-10-25-project-governance/README.md)拥有范围与结果。
- [PR #415](https://github.com/zdaiwmm/shui-IM/pull/415)合并为代码 `d00b11fd9e9c9d21ed4a482d76dc8714931d7331`；与最终源 `e5aa705` 完整文件树相同。该提交是当前已发布应用的祖先，内部改动已包含于生产；下面保留原批次验证，不追加独立真机结论。
- 本批应用 `530ddf51a03c592959b5db6a765eccc4f2006a51`／`2026.10.25.2` 曾于 2026-10-26 07:03 取得精确切换回执，原应用两次独立回读均受 SSH 连接阻断，不能记为 READBACK_OK。用户批准的临时单地址规则已新增并撤销，恢复原有 9 条。随后由上方已完整回读的 PC 应用接续；[本批历史发布记录](../../RELEASING.md#release-project-governance-20261026)保留各阶段证据，不补发旧版或覆盖最近已验证生产。
- 干净冻结源本地 check:full 完整通过：145文件／1098单元、82浏览器入口，0失败／0未运行，1410104ms。[精确PR完整CI40203889136](https://github.com/zdaiwmm/shui-IM/actions/runs/40203889136) attempt1通过；[精确main完整CI40205549905](https://github.com/zdaiwmm/shui-IM/actions/runs/40205549905) attempt2成功；首轮未确认WebKit原生unread Fetch诊断及原分片13通过／1失败／6未运行保留，通过单作业入口请求的唯一原样复验实际执行完整attempt2，未改代码或断言，不宣称已定位修复。
- 容量测试独立于宿主占用，保留真实文件与策略；新增合成服务器恢复、MLS及跨分块原件校验；时间线呈现投影抽成独立模块，归档去重改用索引；操作影响对照已完成，没有新增正式页面。
- 工作树／旧PR已逐项盘点，未知使用者、未证明集成和脏目录继续保留。追加工作树忽略规则后共享旧main状态干净；三条非法名称引用保全原字节／摘要和有效恢复ref后隔离，常规fetch成功。隔离不覆盖正常分支、工作树或提交。
- 原治理交付时的独占目录为治理树，文档分支 `codex/project-governance-evidence-20261025`，起点为已核实合并SHA；没有复制部署配置。公共Git证据位于 `quiet-room-deliveries/evidence/project-governance-20261025/reviewed-summary.json`，包含本地、只读回读、隔离修复和CI定位。
- 该批提交现已包含于本次固定应用；本轮不修改或清理其任务现场。纯文档对账 SHA 不替代线上应用 SHA。

## 仍开放的边界与证据缺口

- iPhone／iOS 27／Safari 原生键盘、触控、锁屏卡片和认证器验收暂缓；桌面／模拟测试不替代真机。
- 外部独立审阅暂缓，[公开高安全门槛](../../PRODUCTION_SECURITY_GATE.md)继续开放；内部回归与依赖扫描继续执行。
- Mac 主动拉取是现有过渡灾备：离线／睡眠中断、36 小时新鲜度门槛、无独立不可变存储及外部告警送达保证。实际配置和新鲜回执需按 OPERATIONS 回读。
- 原治理盘点时本机盘约 96%、19 GiB 可用，strict 备份成功夹具曾被容量门槛阻断；现已固定测试容量前提，真实生产准入不变。当时工作树约 12.7 GiB，清理不足以使整盘低于 80%；该历史本机快照不代表当前生产容量。
- 证书无人值守续期、整站灾难恢复时间、真实公网通话／网络切换，以及历史未定位浏览器诊断须分别取证；不因后续一次绿色抹去原失败。

## 接续入口

按 [工作流](workflow.md) 隔离、验证和交付；按 [项目地图](overview.md) 定位源码与专项；
按 [决策页](decisions.md) 和对应产品／安全契约处理语义。需求确认、代码存在、自动测试、CI、真机和生产状态分别记录。
