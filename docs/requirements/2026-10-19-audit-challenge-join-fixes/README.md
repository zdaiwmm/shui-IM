# 个人根挑战与旧加入重放修复 V1

## 范围与授权

- 本机规则来源 main `4356531cea264dd01bd9110da90b9ff62cfd7a59`；任务按实时 GitHub main 与 origin/main 一致的 `d53adf78f0a4a8c5edb55ea5c41421c591068a96` 中最新规则执行。共享 main 只读。
- 本任务新建 `codex/audit-challenge-join-fixes-20261019`；实际本机独占工作树/HEAD 以 Git 回读为准。
- 用户在两项问题说明后要求「继续验证这两个问题，确认真实存在后完成修复并发布生产」，随后「确认，发布生产」。据此授权两项 V1 最小根因修复、自动回归、PR/CI/合并和发布准备；没有独立消息 permalink。随后展示完整应用 b7a90f4708ffaa3c5599f9e98db4851fd28485c2、版本、完整 CI/预检和缺口后，用户再次回复「确认，发布生产」，明确授权本次精确提交；没有沿用旧 618aa5c 发布授权。
- 非页面需求，无原型/流程图阶段。包含 IM-SHUI-003、004；排除 UI、依赖升级、其他证据不足候选及生产数据排查。

## 方案与验收

1. 003：原匿名 POST challenge 可占满目标身份 20 个持久槽，低于 IP 30/分钟限额；新根挑战 HTTP 500，实际重启仍受阻，既有签名 proof 和另一根正常。真实 HTTP/合成数据三轮复现，Date-only 仅用于确认 30 分钟截止。匿名签发改为不落逐请求持久槽、不驱逐旧 proof，现有字段不变。独立持久 HMAC 键认证签发范围，根签名及 30 分钟截止仍必需；业务操作与消费回执同事务。兼容部署前精确未消费旧挑战。键只用于服务端签发认证，不是用户私钥。
2. 004：真实 MLS 恢复撤销原 joiner 后，普通 token/邀请 GET 均 401，但旧邀请和精确 join 元组（即使随机错误设备 token）返回当前成员/状态/序号，重启仍存在，三轮复现。未恢复 active 权限或得到明文。exact retry 新增 active/recovery fencing 与原 token 校验；原未设独立 token 的旧邀请凭据兼容保留。
3. 回归覆盖：公开签发超过旧全局/身份阈值不占槽；签发所有作用域字段、根签名、截止/单次消费；业务或回执写失败共同回滚、双连接及重启、旧挑战兼容；正常加入幂等、错误/缺失 token、pending recovery/撤销后的拒绝及重启；不二次插入成员或推进 MLS。

## 证据与当前阶段

- 审计快照 d53adf7：既有 7 文件/32 项通过；新增两个观察用例各 3/3 复现含重启。完整已跟踪 1121 个 blob 与基线一致。只读审计报告及原失败保留于本机唯一 `im-shui-audit-20261019-070511` 目录；可复跑回归在本 PR 的 tests/。
- 开发首轮 9 文件/40 项，39 通过；正常 join retry 暴露原 member 查询未选 access_hash。改用现有按 device ID/token 查询，原断言不改，追加旧省略独立 token 兼容测试后针对性复验。原日志保留，不将首轮记为通过。
- 修正后定向 9 文件/41 项全部通过，含新增 9 项。权限审核启动超时后仅重试一次同一组本地验证成功；完整工程门禁、PR/main CI、固定预检及生产/独立回读证据见下节。
- 原生 iPhone/iOS27/Safari 未验证；本批无界面/设备交互更改，自动回归不代表独立密码学审计。

## 交付与生产证据（2026-10-19）

- [PR #346](https://github.com/zdaiwmm/shui-IM/pull/346)源`253c313002fe883d5f594e3e31aec896b684915c`正常合并为应用`b7a90f4708ffaa3c5599f9e98db4851fd28485c2`，完整树一致，版本`2026.10.18.5`。精确[PR CI39176736736](https://github.com/zdaiwmm/shui-IM/actions/runs/39176736736)与[main CI39178072775](https://github.com/zdaiwmm/shui-IM/actions/runs/39178072775)均attempt 1完整成功：130文件/1028项、70浏览器入口、通话/TURN、依赖审计、文档/凭据扫描、双架构镜像和Full application verification。
- 本机check:full构建及1018项通过，10项既有backup-transfer因主机93%已用触发严格80%容量门禁，未放宽门禁；测试生成的唯一Python缓存经归属核对后移除，跟踪源树未改变。69/70个浏览器原始入口分段通过；frontend-lifecycle合成视口/输入高度运动等待两次超时，原因未定位，同源码云端通过。mobile-debug首次本机Chrome超时，固定Playwright原断言复验通过。原失败保留，不将分段结果冒充干净单次本机全量通过。静态复核确认客户端先加密持久化独立token，后续join重试复用同一值。
- 固定[云预检39178586083](https://github.com/zdaiwmm/shui-IM/actions/runs/39178586083)核对PREFLIGHT_OK；用户随后确认上述精确应用。唯一[云发布39178883752](https://github.com/zdaiwmm/shui-IM/actions/runs/39178883752)于`2026-10-19T00:05:01.133Z`取得DEPLOY_VERIFIED，从618aa5c实际切换一次。原production审核保留，未改helper/环境保护，也未重复派发部署。
- 首次独立回读仅backup starting失败；只读核对实际启动`2026-10-19T00:04:49.054158389Z`及既有5分钟间隔/启动期后，仅续跑同SHA readback-only。最终READBACK_OK于`2026-10-19T00:10:18.475Z`成功，应用/备份healthy、TURN运行且探针none，维护门absent；SHA/镜像、HTTPS/数据库/存储、公开及容器产物、新WebSocket一致。精确镜像/归档摘要等由[发布记录](../../../RELEASING.md#release-audit-challenge-join-20261019)拥有。
- 脱敏证据在公共Git元数据`quiet-room-deliveries/evidence/audit-challenge-join-fixes-20261019/delivery.json`及同目录发布/回读文件，位于任务树及其专属Git目录之外。第二个无部署配置文档树按维护页对账；代码批已更新安全契约/测试入口，本轮核对长期规则和安全声明门槛，无新增产品取舍。文档提交不发布；本批资源按固定门禁收尾，其他任务、真机和独立安全审阅缺口保持原边界。
- 当前阶段/下一步：生产发布与独立回读已完成；此文档对账经PR/CI合并后核验本批资源，不再次部署。
