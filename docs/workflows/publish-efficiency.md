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

- `--prepare` 只触发已有受保护工作流的doctor模式，验证真实云权限、CLI、helper、容量、来源、前版状态、正向祖先、完整应用CI和未过期镜像元数据；不下载大镜像、不切换、不安装helper、不修改RAM或业务数据。它不授予发布权，也不表示完整镜像已预载；发布时仍重验候选来源和镜像身份。
- doctor先验证真实云命令通路，再检查应用CI，避免CI等待掩盖基础接入故障。已有生产环境审核照常保留。预检的容量和线上状态只是当时快照，不能取消切换前检查。
- `--with-readback` 在精确云回执核对后自动启动原有独立只读回读；回读仍使用本机SSH及命名环境，产物哈希／HTTPS／WebSocket与容器证据单独保存。失败只报告 `READBACK_REQUIRED`，只续跑 `--readback-only`，不再次切换。
- 同版本云回执以 `ALREADY_DEPLOYED_READBACK_REQUIRED` 进入回读，不伪造 `DEPLOY_VERIFIED`。
- 派发前将唯一请求ID及应用SHA保存到本任务Git元数据 `quiet-room-cloud-publish/`。响应丢失先按请求ID找到原工作流，之后 `--resume` 跟踪原RunID并读取精确回执；不提交第二个工作流，也不重跑云命令。失败或状态未知时仍检查原InvokeId并独立回读。
- 不带新增参数的旧入口保留原语义。正在运行的工作流、精确应用目标、已安装helper及其他任务工作树不由本次优化改写。

CI镜像清理额外保护活动发布工作流与最近三个成功doctor／deploy的应用候选，避免main前进立即淘汰已准备批次。
仍受GitHub七天自然到期限制；预检和发布都检查是否过期。候选列表不可核实时停止清理，不自动重跑应用CI或改发新SHA。
准备阶段是提前发现阻塞，不承诺镜像永久保留或零下载等待。

## V2：完整验证前移、提前导入、精确激活

2026-10-14用户确认V2实施、验证、PR、CI和合并；生产helper与配置只提供审阅材料，待单独确认后安装。具体边界及验收由[V2需求记录](../requirements/2026-10-14-publish-efficiency-v2/README.md)拥有。

完整应用CI仍包含构建、全部单元／集成测试、全部63个浏览器入口、通话／TURN、生产依赖审计、凭据扫描及amd64／arm64镜像。浏览器group 2改为六个按实际耗时均衡的分片，入口及断言不变；新增入口以保守默认耗时分配。镜像按架构复用BuildKit缓存，失败缓存写入不影响验证结果，运行期导入检查与真实Docker存储夹具继续运行。

main浏览器作业仅在以下条件全部成立时复用PR的实际执行证据：已合并的同仓库PR、精确合并提交与相同Git tree、最新成功完整CI的同run／attempt、同分片、实际执行且一小时内、相同Node二进制／依赖锁／Playwright容器摘要／固定基础镜像／系统及CPU指纹。复用证据不能再作为新证据。身份不明、环境变化、超时、重跑或证据缺失时执行完整分片；main的构建／单元／通话／审计／镜像仍重新运行。`Full application verification`聚合要求全部作业成功。

新镜像在CI导出时先执行原完整归档、哈希、唯一标签及配置ID校验，通过后写入`validationVersion:2`和`sourceTree`。发布runner核验小manifest及成功CI／tree；服务器依旧完整核对ZIP、CRC、归档字节数／SHA-256、导入Image ID／revision／架构。旧manifest仍走原runner全量下载校验。此调整消除控制runner的一次重复大文件下载，不省略服务器的完整镜像校验。

helper经独立批准安装且`stagedImageProtocol:1`后，新增入口：

```sh
node scripts/publish.mjs --cloud --stage --environment production --sha <完整候选SHA>
node scripts/publish.mjs --cloud --activate --with-readback --environment production --sha <本次获批完整SHA>
```

- 确认发布前可单独授权`stage`：在发布锁内核验精确成功CI、前版SHA及正向祖先，健康与容量、CPU负载、至少512MiB可用内存通过后流式导入。只准备Git checkout和镜像，不启动候选应用、不关闭流量、不停止容器、不挂载／写入／恢复业务卷。前后线上容器ID、镜像、启动时间、运行和healthy状态、公开健康及前版SHA必须一致。至多保留两份候选回执。
- `stage`成功保存root专属、两小时有效的SHA／Image ID／归档摘要／前版SHA／checkout回执。过期、脏目录、前版变化、镜像变化或CI新attempt均拒绝使用；不自动重载、不自动改发新版本。未安装新helper时在大文件导入前拒绝stage／activate。
- 用户确认本次精确SHA后执行`activate`：重新核验CI、manifest、容量、前版及镜像，消费一次候选回执，省去重复传输与导入。随后仍执行原Compose预检、维护门、停写、冷备份与校验、切换、HTTPS／WebSocket验证及安全回滚。开放流量后绝不恢复旧数据。
- 可选启动探针覆盖文件单独安装；只将启动探测间隔改为应用1秒、备份5秒，保留健康断言、超时、重试和宽限期。要求Engine>=25、Compose>=2.20.2，root所有权及固定文件摘要。不存在时沿用原配置。
- 独立回读只对精确版本／镜像已一致且应用healthy、备份running但探针`starting`的状态等待；最多37次探测、10秒间隔、6分钟等待预算。其他异常立即失败。等待只重跑只读回读，仍保留所有产物哈希／HTTPS／WebSocket及前后身份检查，不重发应用。

阶段安排及耗时均为待生产实测的目标，审核等待、缓存冷启动、排队、网络和大数据备份另计：

| 阶段 | 时点 | 目标耗时 |
| --- | --- | --- |
| 风险匹配本地验证、PR与完整CI | 功能完成后立即开始；与审阅并行 | 完整CI约3—5分钟；本地与审阅按变更计 |
| 精确main CI | 合并后，用户确认发布前 | 证据可复用且缓存命中时约2—4分钟，否则完整分片 |
| doctor及stage | 精确main CI后，确认发布前单独授权准备 | 约1—3分钟，传输依赖网络 |
| activate、冷备份、切换及独立回读 | 用户确认本次精确SHA后 | 已预载候选约1.5—3分钟；大备份与异常等待另计 |
| 文档对账 | 回读成功后 | 不阻塞上线成功结论，不再部署 |

禁止把预计时长写成实测结果。未执行stage时仍可使用原deploy路径；未安装helper／覆盖配置时不承诺上述生产耗时。

## 完成与计时

分别报告“固定入口验证”“独立回读成功”“文档对账完成”。READBACK_OK后可报告上线成功，
文档对账继续在第二独立树处理；文档失败不会重发。正常条件下以确认后五分钟内完成切换和回读作为待实测目标，
不把本地专项耗时或小文件抽样外推为生产速度。沿用RELEASE_TIMING／READBACK_TIMING记录准备、传输、切换、回读与对账耗时。

本次交付不执行生产操作、不切换应用、不安装helper、不更改云权限；当日发布及独立回读证据由原发布任务拥有。
