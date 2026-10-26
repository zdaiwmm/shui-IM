# Quiet Room 当前状态

## PC 八项与 macOS V1 已发布（2026-10-26 13:11）

用户确认免原型实施，追加更多按钮间距／居中；[需求 V1](../requirements/2026-10-26-pc-eight-macos/README.md)拥有具体范围、失败分类与证据。最终源 `91b7fae` 经 [PR #418](https://github.com/zdaiwmm/shui-IM/pull/418) 合并为应用 `460c57d06081d05419226c5d39f3afb659e1abca`／`2026.10.26.1`，完整文件树一致。包含 PC 几何、输入底色、返回位置及背景转场、列表与多余按钮、本人设备加密申请／系统卡批准、更多按钮，以及独立 macOS 包。

干净源完整本地验收通过 145 文件／1100 项、82/82 浏览器入口，0 失败／0 未运行，1359332ms；[精确 PR CI 40268466936](https://github.com/zdaiwmm/shui-IM/actions/runs/40268466936) 和[精确应用 main CI 40270491736](https://github.com/zdaiwmm/shui-IM/actions/runs/40270491736) 均 attempt 1 全绿，Full application verification 成功，head 已独立核对。用户随后确认发布本批生产；固定入口和独立回读均已通过，后续文档对账不再次发布。

本机包为双架构 ad-hoc 签名，Apple Silicon 启动及正式首页只读检查通过；没有 Developer ID／公证，Intel 执行和实际摄像头／通话未验证。安装包加载同一正式站点，本次网页修复已发布，无需为网页版本重新打包。

本页是带时间的接手摘要，不是实时监控。历史详情保存在 [发布记录](../../RELEASING.md)、
对应需求和 Git；[治理前完整状态快照](https://github.com/zdaiwmm/shui-IM/blob/bc329979e232d16a238190bc069eae32a85af4c9/docs/context/status.md)保留原证据和失败历史。

## 最近已验证生产：2026-10-26 13:11

- 应用 `460c57d06081d05419226c5d39f3afb659e1abca`，版本 `2026.10.26.1`；[PR #418](https://github.com/zdaiwmm/shui-IM/pull/418)。实际前版为预检读到的 `530ddf51a03c592959b5db6a765eccc4f2006a51`。
- [精确 main 完整 CI 40270491736](https://github.com/zdaiwmm/shui-IM/actions/runs/40270491736) attempt 1 成功，Full application verification 及双架构镜像通过；本轮核对同一 SHA 的既有完整结果。
- 固定预检 `40272025281` 取得 PREFLIGHT_OK；唯一发布 `40272152233` 取得 DEPLOY_VERIFIED，工作流来源 `6b2bc2b`，应用目标保持 `460c57d`。
- 独立 READBACK_OK 于 `2026-10-26T05:11:36.822Z` 完成，2967ms：应用与备份 healthy、TURN 运行，SHA／镜像／HTTPS／数据库／存储／公开及容器产物／新 WebSocket 一致，维护门不存在，管理员与通话启用。
- 首次回读仅备份 starting；只读核对原 5 分钟检查与启动期后仅续回读，没有重启或再次切换。完整证据见[本批发布记录](../../RELEASING.md#release-pc-eight-macos-20261026)与[需求记录](../requirements/2026-10-26-pc-eight-macos/README.md)。
- PC 八项、追加更多按钮修复及本人设备系统卡授权已发布；目录发现不授予成员资格或旧历史，三端限制保持。macOS 包仍按上方单列的实际验证边界交付。

以上为本次部署时点事实；纯文档对账提交可以领先线上应用 SHA。公共 Git 证据位于 `quiet-room-deliveries/evidence/pc-eight-macos-20261026/production-summary.json`，本轮仅做本批上下文轻治理。

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
