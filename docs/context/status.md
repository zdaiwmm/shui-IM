# Quiet Room 当前状态

本页是带时间的接手摘要，不是实时监控。历史详情保存在 [发布记录](../../RELEASING.md)、
对应需求和 Git；[治理前完整状态快照](https://github.com/zdaiwmm/shui-IM/blob/bc329979e232d16a238190bc069eae32a85af4c9/docs/context/status.md)保留原证据和失败历史。

## 最近已验证生产：2026-10-25 12:59

- 应用 `24c89baa25865fd4bb256851597351e421ce7190`，版本 `2026.10.25.1`；[PR #413](https://github.com/zdaiwmm/shui-IM/pull/413)。
- [精确 main 完整 CI 40162315313](https://github.com/zdaiwmm/shui-IM/actions/runs/40162315313) attempt 1 成功；143 文件／1086 单元、82 浏览器入口、通话与双架构通过。
- 固定预检 `40162916329` 取得 PREFLIGHT_OK；唯一发布 `40163290907` 取得 DEPLOY_VERIFIED。
- 独立 READBACK_OK 于 `2026-10-25T04:59:25.307Z` 完成：应用与备份 healthy、TURN 运行，SHA／镜像／HTTPS／数据库／存储／产物／新 WebSocket 一致，维护门不存在。
- 首次回读仅备份 starting；在核对原启动期后只续回读，没有再次切换。完整证据及此前失败见[本批发布记录](../../RELEASING.md#release-experience-reliability-20261025)与[需求记录](../requirements/2026-10-25-experience-reliability/README.md)。
- 视频／表情、认证媒体缓存、桌面面板及本人设备目录同步已发布；目录发现不授予成员资格或旧历史，列表移除保留既有数据。最新长期契约为 PRODUCT／SECURITY／NEW_ROOM_ARCHIVES。

以上只证明该时点的生产状态，本轮治理没有重新部署或取得新的生产回读。

## 当前活动工作：六批项目治理 V1

- 用户在确认六批全部纳入后明确「立即实施」；[需求与验收矩阵](../requirements/2026-10-25-project-governance/README.md)拥有范围、授权、阶段及后续交付证据。
- 基线为 GitHub 实时 main 与 origin/main `bc329979e232d16a238190bc069eae32a85af4c9`；共享本机 main 仍是 `4356531`，不可用作当前实现基线。
- 独占分支 `codex/project-governance-20261025`；本机实际目录按需求记录重新核验。其他工作树归属与使用者未释放前保留，不将已合并等同于可删除。
- 依赖按锁文件独立安装，当前正在进行环境、测试、运维、性能、职责拆分及操作影响核对；尚未用本轮改动证明 CI、合并或生产。

## 仍开放的边界与证据缺口

- iPhone／iOS 27／Safari 原生键盘、触控、锁屏卡片和认证器验收暂缓；桌面／模拟测试不替代真机。
- 外部独立审阅暂缓，[公开高安全门槛](../../PRODUCTION_SECURITY_GATE.md)继续开放；内部回归与依赖扫描继续执行。
- Mac 主动拉取是现有过渡灾备：离线／睡眠中断、36 小时新鲜度门槛、无独立不可变存储及外部告警送达保证。实际配置和新鲜回执需按 OPERATIONS 回读。
- 本机盘约 96%、19 GiB 可用，旧 strict 备份成功测试曾被容量门槛阻断；工作树约 12.7 GiB，不能承诺清理即可使整盘低于 80%。生产容量不可由本机数字推断。
- 证书无人值守续期、整站灾难恢复时间、真实公网通话／网络切换，以及历史未定位浏览器诊断须分别取证；不因后续一次绿色抹去原失败。

## 接续入口

按 [工作流](workflow.md) 隔离、验证和交付；按 [项目地图](overview.md) 定位源码与专项；
按 [决策页](decisions.md) 和对应产品／安全契约处理语义。需求确认、代码存在、自动测试、CI、真机和生产状态分别记录。
