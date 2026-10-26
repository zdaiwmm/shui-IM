# Quiet Room 当前状态

## PC 八项与 macOS V1：本地实施与定向验收（2026-10-26）

用户确认免原型实施，追加更多按钮间距／居中；[需求 V1](../requirements/2026-10-26-pc-eight-macos/README.md)拥有具体范围、原始失败分类与证据。独占分支 `codex/pc-eight-macos-20261026` 基于实时 main `530ddf5`；PC 几何与新密室旧侧栏隔离、成对加密申请／原设备系统卡批准、同图标独立 macOS 包已实现。构建与 145 文件／1100 项本地通过；Chromium/WebKit 桌面专项及真实三浏览器 MLS 拒绝／重试／批准／无旧历史链路通过。完整浏览器回归、PR CI 与合并仍待完成，不据此宣称已发布。

本机包为双架构 ad-hoc 签名，Apple Silicon 启动及正式首页只读检查通过；没有 Developer ID／公证，Intel 执行和实际摄像头／通话未验证。安装包仅加载正式站点，网页修复上线仍需另行确认精确 SHA。

本页是带时间的接手摘要，不是实时监控。历史详情保存在 [发布记录](../../RELEASING.md)、
对应需求和 Git；[治理前完整状态快照](https://github.com/zdaiwmm/shui-IM/blob/bc329979e232d16a238190bc069eae32a85af4c9/docs/context/status.md)保留原证据和失败历史。

## 最近已验证生产：2026-10-25 12:59

- 应用 `24c89baa25865fd4bb256851597351e421ce7190`，版本 `2026.10.25.1`；[PR #413](https://github.com/zdaiwmm/shui-IM/pull/413)。
- [精确 main 完整 CI 40162315313](https://github.com/zdaiwmm/shui-IM/actions/runs/40162315313) attempt 1 成功；143 文件／1086 单元、82 浏览器入口、通话与双架构通过。
- 固定预检 `40162916329` 取得 PREFLIGHT_OK；唯一发布 `40163290907` 取得 DEPLOY_VERIFIED。
- 独立 READBACK_OK 于 `2026-10-25T04:59:25.307Z` 完成：应用与备份 healthy、TURN 运行，SHA／镜像／HTTPS／数据库／存储／产物／新 WebSocket 一致，维护门不存在。
- 首次回读仅备份 starting；在核对原启动期后只续回读，没有再次切换。完整证据及此前失败见[本批发布记录](../../RELEASING.md#release-experience-reliability-20261025)与[需求记录](../requirements/2026-10-25-experience-reliability/README.md)。
- 视频／表情、认证媒体缓存、桌面面板及本人设备目录同步已发布；目录发现不授予成员资格或旧历史，列表移除保留既有数据。最新长期契约为 PRODUCT／SECURITY／NEW_ROOM_ARCHIVES。

以上为部署时点事实。本轮另以固定入口于 `2026-10-25T14:11:28.902Z` 对同一应用 SHA 取得新的 READBACK_OK（3407ms），没有切换生产；回执已保存在公共 Git 证据目录。

## 六批项目治理 V1 已合并，未发布

- 用户确认全部六批并明确「立即实施」；[需求与验收矩阵](../requirements/2026-10-25-project-governance/README.md)拥有范围与结果。
- [PR #415](https://github.com/zdaiwmm/shui-IM/pull/415)合并为代码 `d00b11fd9e9c9d21ed4a482d76dc8714931d7331`；与最终源 `e5aa705` 完整文件树相同。内部改动未部署。
- 干净冻结源本地 check:full 完整通过：145文件／1098单元、82浏览器入口，0失败／0未运行，1410104ms。[精确PR完整CI40203889136](https://github.com/zdaiwmm/shui-IM/actions/runs/40203889136) attempt1通过；[精确main完整CI40205549905](https://github.com/zdaiwmm/shui-IM/actions/runs/40205549905) attempt2成功；首轮未确认WebKit原生unread Fetch诊断及原分片13通过／1失败／6未运行保留，通过单作业入口请求的唯一原样复验实际执行完整attempt2，未改代码或断言，不宣称已定位修复。
- 容量测试独立于宿主占用，保留真实文件与策略；新增合成服务器恢复、MLS及跨分块原件校验；时间线呈现投影抽成独立模块，归档去重改用索引；操作影响对照已完成，没有新增正式页面。
- 工作树／旧PR已逐项盘点，未知使用者、未证明集成和脏目录继续保留。追加工作树忽略规则后共享旧main状态干净；三条非法名称引用保全原字节／摘要和有效恢复ref后隔离，常规fetch成功。隔离不覆盖正常分支、工作树或提交。
- 当前独占目录为原治理树，文档分支 `codex/project-governance-evidence-20261025`，起点为已核实合并SHA；没有复制部署配置。公共Git证据位于 `quiet-room-deliveries/evidence/project-governance-20261025/reviewed-summary.json`，包含本地、只读回读、隔离修复和CI定位。
- GitHub及origin/main已同步至该代码合并；共享本机main仍为4356531，不切换其他使用者的接手目录。纯文档对账SHA不替代线上应用SHA。

## 仍开放的边界与证据缺口

- iPhone／iOS 27／Safari 原生键盘、触控、锁屏卡片和认证器验收暂缓；桌面／模拟测试不替代真机。
- 外部独立审阅暂缓，[公开高安全门槛](../../PRODUCTION_SECURITY_GATE.md)继续开放；内部回归与依赖扫描继续执行。
- Mac 主动拉取是现有过渡灾备：离线／睡眠中断、36 小时新鲜度门槛、无独立不可变存储及外部告警送达保证。实际配置和新鲜回执需按 OPERATIONS 回读。
- 本机盘约 96%、19 GiB 可用，原 strict 备份成功夹具曾被容量门槛阻断；现已固定测试容量前提，真实生产准入不变。盘点时工作树约 12.7 GiB，清理不足以使整盘低于 80%。生产容量不可由本机数字推断。
- 证书无人值守续期、整站灾难恢复时间、真实公网通话／网络切换，以及历史未定位浏览器诊断须分别取证；不因后续一次绿色抹去原失败。

## 接续入口

按 [工作流](workflow.md) 隔离、验证和交付；按 [项目地图](overview.md) 定位源码与专项；
按 [决策页](decisions.md) 和对应产品／安全契约处理语义。需求确认、代码存在、自动测试、CI、真机和生产状态分别记录。
