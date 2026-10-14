# 发布效率与验证分级

2026-10-14 用户确认效率优先优化并授权验证、PR、CI及合并，要求不影响当日发布。
本规则将应用版本验证与发布工具验证分开，生产仍绑定用户确认的完整应用SHA。

## 验证范围

| 变更 | 本地验证 | CI |
| --- | --- | --- |
| 明确列出的运维记录、流程与规则 | 文档事实、链接及格式 | docs、凭据扫描、verify |
| 明确列出的发布工具／专项测试／发布CI配置 | `node scripts/check-delivery.mjs`、文档检查；真实连接能力按下节提前预检 | delivery、docs、凭据扫描、verify |
| 产品、server运行代码、依赖／锁文件、Docker／Compose、root helper、安全契约、其他未知路径或混合变更 | 风险匹配的应用验证 | 完整应用CI、双架构镜像及verify |

符合 `docs/requirements/日期-编号/README.md` 命名的需求记录按文档处理，scope将实际变动的记录传给文档作业检查；新原型、脚本、JSON和专项契约不由此进入轻量范围。

白名单及专项测试由 `scripts/ci-scope.mjs` 单点定义；删除／重命名同时检查两侧路径，未知差异和非普通文件退回完整验证。
手动完整CI与Merge Queue保留完整验证。发布专项涵盖CLI协议、精确CI、镜像摘要／架构、流传输、
切换前失败、维护门、回滚、开放流量后保留数据、独立回读和中断续跑；使用隔离夹具，不连接生产。
工具需要真正云端接入验收时，在专门授权的只读doctor阶段执行，不用夹具通过代替云权限可用。
root helper、业务卷及恢复工具不进入工具快通道。

新CI在verify中额外记录 `Full application verification` 步骤，只有full模式执行。
发布器要求该步骤成功；delivery/docs绿色只表示该范围交付通过，不能授权应用发布。
历史应用CI保留旧协议：没有delivery作业的历史流水线仍使用精确SHA、最新run／attempt与既有verify证明。
发布工具无需修改 `release.json`，其合并SHA不替换已经获批的应用SHA，也不重建镜像。

## 准备、发布与接续

从已验证的工具版本执行，以下入口统一要求完整40位应用SHA与同一命名环境：

```sh
node scripts/publish.mjs --cloud --prepare --environment production --sha <完整应用SHA>
node scripts/publish.mjs --cloud --with-readback --environment production --sha <获批完整应用SHA>
node scripts/publish.mjs --cloud --resume <原工作流RunID> --with-readback --environment production --sha <同一应用SHA>
node scripts/publish.mjs --readback-only --environment production --sha <同一应用SHA>
```

- `--prepare` 只触发已有受保护工作流的doctor模式，验证真实云权限、CLI、helper、容量、来源、前版状态、正向祖先、完整应用CI和未过期镜像元数据；不下载大镜像、不切换、不安装helper、不修改RAM或业务数据。它不授予发布权，也不表示完整镜像已预载；发布时仍重验并下载校验。
- doctor先验证真实云命令通路，再检查应用CI，避免CI等待掩盖基础接入故障。已有生产环境审核照常保留。预检的容量和线上状态只是当时快照，不能取消切换前检查。
- `--with-readback` 在精确云回执核对后自动启动原有独立只读回读；回读仍使用本机SSH及命名环境，产物哈希／HTTPS／WebSocket与容器证据单独保存。失败只报告 `READBACK_REQUIRED`，只续跑 `--readback-only`，不再次切换。
- 同版本云回执以 `ALREADY_DEPLOYED_READBACK_REQUIRED` 进入回读，不伪造 `DEPLOY_VERIFIED`。
- 派发前将唯一请求ID及应用SHA保存到本任务Git元数据 `quiet-room-cloud-publish/`。响应丢失先按请求ID找到原工作流，之后 `--resume` 跟踪原RunID并读取精确回执；不提交第二个工作流，也不重跑云命令。失败或状态未知时仍检查原InvokeId并独立回读。
- 不带新增参数的旧入口保留原语义。正在运行的工作流、精确应用目标、已安装helper及其他任务工作树不由本次优化改写。

CI镜像清理额外保护活动发布工作流与最近三个成功doctor／deploy的应用候选，避免main前进立即淘汰已准备批次。
仍受GitHub七天自然到期限制；预检和发布都检查是否过期。候选列表不可核实时停止清理，不自动重跑应用CI或改发新SHA。
准备阶段是提前发现阻塞，不承诺镜像永久保留或零下载等待。

## 完成与计时

分别报告“固定入口验证”“独立回读成功”“文档对账完成”。READBACK_OK后可报告上线成功，
文档对账继续在第二独立树处理；文档失败不会重发。正常条件下以确认后五分钟内完成切换和回读作为待实测目标，
不把本地专项耗时或小文件抽样外推为生产速度。沿用RELEASE_TIMING／READBACK_TIMING记录准备、传输、切换、回读与对账耗时。

本次交付不执行生产操作、不切换应用、不安装helper、不更改云权限；当日发布及独立回读证据由原发布任务拥有。
