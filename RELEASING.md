# Quiet Room 固定发布流程

新版本发布前将上一版 `release.json` 的原始内容追加到 `release-history.json`，按发布顺序保留唯一 ID。
应用以已查看版本或旧客户端迁移基线合并后续说明，去重相同条目；仅停留遮蔽页不会推进已查看基线。
构建及容器均需包含该历史文件，未知旧基线展示仓库内可用历史，不编造更早记录。

<a id="release-20260912-3"></a>

## 当前线上发布记录（2026-09-12 23:57）

- 用户确认发布精确 main 提交 `e8ff6bed2f5d0c0d7143966cf882410c8c565baa`；PR #115、精确 main CI `34700242179` 全部通过。
- 固定入口返回 `DEPLOY_OK` 与 `DEPLOY_VERIFIED`；服务器批次为 `20260912T145723Z`，发布目录为 `/opt/quiet-room/git-releases/20260912T145723Z-e8ff6bed`，切换前冷备份已校验。
- 独立只读回读于 `2026-09-12T15:10:29Z` 返回 `READBACK_OK`，证据保存在发布调用工作树 Git 元数据的 `quiet-room-readback/`；线上 SHA、应用/备份镜像、HTTPS 健康、公开 WebSocket 和版本化公开产物均匹配。
- 本次版本 `2026.09.12.3`：后台贴纸列表直接切换自动隐藏；已安装合集发送前读取最新服务端设置；聊天表情无额外背景、边框和阴影；快捷入口增量拖动使用 `requestAnimationFrame`，修复右边缘同手势反向回弹。
- 生产应用与备份容器运行且应用健康；备份容器无健康探针，记录为 `none`。后台开关 `1`，通话覆盖 `0`，TURN 容器不存在。实体 iPhone / iOS 27 / Safari 及生产管理员逐项操作仍未验收。
## 先更新用户可见版本说明

每个包含用户可见变化的发布候选都必须先更新根目录 `release.json`：使用新的唯一 `id`，并以
简洁语句逐条填写本次 `notes`。构建会校验该文件，把同一个版本 ID 同时注入应用和
Service Worker；复用旧 ID 会让已经打开的客户端无法识别新版本。纯发布记录文档不需要修改
该文件，也不能为了触发更新提示制造空版本。

版本生成与固定批次入口见 [工作流](docs/context/workflow.md#固定批次发布2026-09-10)。工具改进不制造空的用户可见版本，也不自动发布。

## 本机一次性初始化

在每台受信计算机上完成一次 GitHub CLI 和部署配置初始化；配置使用系统凭据存储和本机路径，
不进入 Git：

```bash
gh auth login -h github.com --web --git-protocol https
npm run deploy:setup -- --host <production-host> --user <deploy-user> \
  --server-key /absolute/path/to/production-key
```

日常同步固定使用 `npm run repo:doctor`、`npm run repo:pull` 和 `npm run repo:push`。发布仍必须
由精确 main SHA 授权，不能自动发布“当前最新”提交；配置会被所有 worktree/clone 复用，不需要
每次重新填写。

## 每次只用这个入口

用户明确要求发布后，确认需要上线的完整 GitHub `main` 提交号，再执行：

```bash
node scripts/publish.mjs --sha <40位提交号>
```

当前源码会将入口及隔离临时目录转换为真实路径，支持 Mac 的 `/var/folders`、
`/tmp` 等目录别名。旧版入口的临时目录兼容方式仍保留，必要时使用同一固定入口：

```bash
TMPDIR=/private/tmp node scripts/publish.mjs --sha <40位提交号>
```

2026-09-04 已复现：默认临时目录经过 `/var/folders` 别名时，隔离副本中
`scripts/release.mjs` 的入口判断将参数路径与 `import.meta.url` 的
`/private/var/folders` 真实路径直接比较，可能未执行发布主体便以 0 退出。
早期发布通过单次指定 `TMPDIR=/private/tmp` 避开该问题；它只选择临时副本位置，
不更换发布入口或修改源码中的发布门槛。当前修复另有目录／文件符号链接入口、
无网络合成发布和缺少成功回执的自动回归。2026-09-04 的 `b299824` 发布已使用
默认临时目录完成真实路径规范化、隔离发布和成功回执验证，见[该次历史发布记录](#release-20260904-2209)。

该入口依次执行：只读预检 → 核对 GitHub main → 等待该提交完整 CI 成功 →
新建独立发布副本（仅 main 历史，按需取 blob）→ 校验祖先并固定获批提交 →
调用已有服务器发布程序 → 回读线上提交号并保存隔离副本内的成功回执。
不会把本地未提交文件复制过去，也不会切分支、stash、重置或覆盖开发工作区。
GitHub main 在准备期间正常前进时继续发布已确认批次，不擅自改发新版；候选不再属于 main 时拒绝。生产已为同版时仅做独立回读，生产领先或分叉时拒绝常规发布。发布仍须单写者，不自动回退生产。

本地待合并改动仍须先审阅、测试并合并；该入口只发布已合并内容，不自动合并。
已经完成且失败的 CI 不会自动重跑，先读取失败原因再处理。

## 发布后知识库对账

服务器切换不负责修改知识库。隔离副本中的 `release.mjs` 会在回读线上 `current-sha`
后写精确 SHA 回执并输出 `DEPLOY_VERIFIED`；外层 `publish.mjs` 还必须核对该回执与批准
SHA 完全相同。只有外层核对成功并且后续独立只读生产回读得到 `READBACK_OK`，才将知识库
生产层级更新为完整回读通过。对账在维护窗口
之外执行，依次更新 `RELEASING.md` 的发布证据与 `docs/context/status.md` 的当前生产快照，
清理过时的候选状态；再运行 `node scripts/check-docs.mjs`、`git diff --check`，由 CI 执行
凭据扫描，并人工或由代理审阅跨文档语义。语义规则见
[知识库维护规则](./docs/context/maintenance.md#发布后的固定触发点)与
[D-021](./docs/context/decisions.md#d-021生产回读后对账知识库语义变化继续审阅)。

发布后对账必须在第二个独立克隆或单独 `git worktree` 中执行，不复用含部署配置的发布
副本，也不复制 `.deploy.local.json`、密钥相关环境或未脱敏原始回执。只显式纳入允许的
文档，不能使用 `git add .`，不能直接推送 `main`，也不能修改调用发布的工作树。有差异
才建立文档 PR；无差异时记录检查成功。相同发布/回读证据重复运行应幂等，不重复追加。
文档 PR 合并造成 GitHub main SHA 晚于线上应用 SHA 是正常状态，该文档提交不需要发布。

独立回读已有仓库内固定入口。外层 `publish.mjs` 精确核对成功回执后，另行执行：

```bash
npm run deploy:readback -- --sha <本次获批并已发布的40位提交号>
```

保存证据通过 `git rev-parse --absolute-git-dir` 定位当前工作树独立的 Git 元数据目录，
支持普通克隆与 linked worktree；该目录仍需执行权限。旧版本入口不支持 linked worktree 时，在已有精确发布克隆中执行同一入口，先以
`npm ci --omit=dev --ignore-scripts --no-audit --no-fund` 准备锁定依赖，通过环境传入现有配置，
不复制凭据、不再次部署。该限制不能记作生产失败或静默跳过证据保存。

该命令每次重新读取生产，不复用旧绿色结果；只执行服务器状态/容器检查、公开 HTTPS、
运行容器与公开产物逐字节摘要核对及新的 WebSocket 连接，不调用发布 helper，不开关维护门，
也不读取真实消息、附件或备份内容。成功时输出 `READBACK_OK`，并将版本化、脱敏 JSON 证据以
0600 权限原子写入当前仓库的 `.git/quiet-room-readback/`，不会污染工作树。结构化回读成功
仍不等于知识库已对账、CI 通过、真机通过或独立安全审计通过；无人值守文档 PR 对账器尚未
落地，执行发布的任务仍须按本页顺序完成人工/代理审阅与对账。

若应用已经 `DEPLOY_VERIFIED`/`READBACK_OK`，但文档生成、检查、推送或 PR 失败，生产发布
仍然成功。记录 `CONTEXT_SYNC_BLOCKED` 与可重试的同一份证据，只重试知识库对账；禁止为
修复文档状态再次调用服务器发布程序。

固定入口成功但独立回读超时、探针失败或证据无法保存时，分别记录“固定入口已验证”和
“独立回读待完成”，只用同一目标 SHA 重跑上述只读入口及后续对账。回读失败固定输出
`READBACK_BLOCKED class=<分类> phase=<阶段> retry=readback-only`；安全续跑不会调用或重试
生产切换。发布进入过非只读阶段后连接中断、开放
流量后的检查失败或未取得精确回执时，先标记 `PRODUCTION_STATE_UNRESOLVED` 并调查真实
生产状态；在查明前不得假定回滚成功，也不得再次执行切换。

固定入口核对目标线上 SHA、`deployed-at`、精确发布目录与维护标记，分别记录容器
`running` 和实际健康探针结果，核对实际 Image ID/不可变镜像引用、HTTPS
`ok`/`database`/`storage`、首页、Service Worker、首页引用的版本化产物及公开 WebSocket。
没有健康探针时明确记录 `none`，不能写 `healthy`。任何阶段失败都不能产生 `READBACK_OK`；
无法取得的字段保持未验证。

回读阶段固定为 `server-state`、`validate-state`、`https-health`、`public-artifacts`、
`container-artifacts` 和 `public-websocket`，另有总耗时；每行 `READBACK_TIMING` 只包含阶段、
结果、失败分类（仅失败时）和毫秒数。失败分类固定区分用法/配置、连接、服务器检查、生产
元数据、容器状态、镜像、HTTPS 健康、公开产物、WebSocket 与本地证据写入。原始 SSH、HTTP
或 WebSocket 错误不进入结构化计时与证据。

## CI 与分段耗时

发布等待的轮询间隔为 5 秒。发布入口和隔离副本都会检查精确 `main` SHA 的
`.github/workflows/ci.yml`，只接受 `push` 或 `workflow_dispatch` 事件中最新的 run，
并要求该 run 已完成且成功、同一次 attempt 的 `verify` 汇总 job
已完成且成功。查询读取所有分页；取回 job 证据后再次核对最新 run 和 attempt，
较新的失败、取消、排队或运行中结果都不能回退到旧绿色结果。

严格限定的纯文档提交可以通过轻量 CI，但这不能作为应用发布证据。若确实需要发布
这样的精确提交，先确认 GitHub `main` 仍是用户批准的完整 SHA，再手动运行：

```bash
gh api repos/zdaiwmm/shui-IM/commits/main --jq .sha
gh workflow run ci.yml --repo zdaiwmm/shui-IM --ref main
gh run list --repo zdaiwmm/shui-IM --workflow ci.yml --branch main --event workflow_dispatch --limit 5 --json databaseId,headSha,status,conclusion,url
```

核对新 run 的 `headSha` 与批准版本逐字相同，并在 GitHub Actions 中确认完整 job
成功后，仍使用本页开头的 `publish.mjs --sha <40位提交号>`。入口可等待仍在运行的
完整 CI，但不会自动触发或重跑它。手工 dispatch 仍针对当时的 main；不能拿后续 main 的 CI 替代冻结提交的 CI。确需变更目标时重新审阅并确认，手工运行 CI 本身不构成发布授权。

本地输出 `RELEASE_TIMING`，分别记录预检、CI 等待／校验、克隆、服务器发布和线上
回读耗时；服务器 helper 输出 `DEPLOY_TIMING`，记录源码获取、镜像构建、Compose
预检、维护门、停止容器、冷备份、启动、健康验证、元数据发布、公开 WebSocket
验证、清理及必要的回滚阶段。每条计时只包含固定阶段名、成功／失败和毫秒数；服务器
使用 Bash 内置秒计时，毫秒值精度为 1 秒，不增加命令参数或环境内容日志。

失败阶段也保留耗时和原退出状态；成功回滚仍代表本次发布失败。清理失败仍按原策略
输出警告，不撤销已验证的发布。阶段顺序、发布锁、冷备份校验、维护门和开放流量后
禁止恢复旧数据的要求保持原样。

服务器计时只有在经独立审阅、按 `DEPLOYMENT.md` 安装新版 root helper 后才生效。
2026-09-04 已独立安装并用于 `b299824` 发布，取得下述首次分段实测；普通代码推送
或应用发布仍不会自动更新它。该次耗时不是与旧生产流程的同条件对照，不据此宣称生产
提速百分比。

## 已完成的一次性配置

- GitHub CLI 已安装；账户已授权，凭据由系统钥匙串保存，不写入代码。
- `.deploy.local.json` 保存生产地址、用户名和专用 SSH 密钥路径；已排除出 Git。
- 生产 SSH 已验证可从当前国内出口直连，仅放行获批的单地址，不开放全网。
- 2026-09-04 已按 `DEPLOYMENT.md` 独立审阅并原子更新 root 发布程序，当前版本包含可选通话中继、后台持久 Compose 覆盖及分段计时支持；精确提交、摘要和旧副本路径见[2026-09-04 helper 安装记录](#release-20260904-2209)。普通应用发布不会自动替换它，后续发布仍需核对安装版本。
- 日常诊断入口：`npm run deploy:doctor`，仅读取状态。

## Mac 锁屏与手机远程

发布入口只调用 Node、Git、GitHub CLI 和 SSH，不使用浏览器、网页终端、鼠标、
桌面自动化或交互式密码输入。`--sha` 是本次准确版本的非交互确认，不是跳过检查。
本次生产发布已完整通过命令行完成；尚未进行人为锁屏状态下的端到端验收，
不要把“无 GUI 依赖”写成“所有锁屏配置下已验证成功”。

Mac 必须保持开机、联网、应用在线且未睡眠。按官方说明，在应用的连接设置中使用
“Keep this Mac awake”，接通电源；不要把锁屏与睡眠、合盖、关机混为一谈。
远程任务继承主机权限，必要的命令批准仍可能需要在手机上确认。
参考：https://learn.chatgpt.com/docs/remote-connections

若钥匙串被单独锁定、凭据撤销或过期，预检可能失败；不导出明文令牌规避保护。
若家庭/办公公网出口变化，SSH 白名单需要重新核对。当前单地址规则不能保证换网后
自动恢复。永久固定出口或受控私网通道应另行授权配置，不能临时改为全网开放。

## 失败处理

- CI 未通过：不发，查看对应失败步骤；审计服务异常不等于安全审计通过。
- CI 的生产依赖审计由 `node scripts/audit-production.mjs` 执行原 npm 审计，仍以 high/critical 为阻断阈值。仅对明确的临时网络或官方接口错误最多尝试三次，间隔五秒；漏洞、认证/配置错误、无效报告和重试耗尽均失败。只有 npm 返回真实、有效的成功报告才算审计通过，不使用替代漏洞库或跳过检查。
- SSH 超时：核对生产目标和实际国内出口，不能用访问 GitHub 的代理出口代替。
- 发布中连接断开：先检查线上 SHA、维护标记和服务器日志；不得盲目重发。
- 进程退出码为 0，但缺少服务器 `DEPLOY_OK` 或入口 `DEPLOY_VERIFIED`：不算发布成功。新发布入口另外要求隔离副本的 `.git/quiet-room-verified-sha` 回执与批准 SHA 相同；它只在服务器调用成功且线上 SHA 回读匹配后生成，子程序静默退出会被拒绝。先检查线上 SHA、维护标记和服务器日志；不因退出码或旧回执而推断已上线，也不盲目重发。
- 发布副本保留在工具打印的临时目录，便于诊断；不在故障时自动清理证据。
- 服务器程序负责冷备份、临时阻断业务流量、切换、健康与 WebSocket 验证。
  开放流量后不自动恢复旧数据，避免抹掉新消息。

## 本次线上发布记录

- 日期：2026-09-12（Asia/Shanghai）；服务器批次 `20260912T075839Z`，独立回读于
  `2026-09-12T08:04:57Z` 成功。应用提交
  `b9ec6754ef6dbaf3d0ac348654ec2bf9fa8ec088`，版本 `2026.09.12.2`；PR #113 已合并。
- 本批修复后台 GIF/贴纸自动隐藏未传递到聊天发送的问题，移除聊天表情的额外背景和边框，并优化贴纸快捷入口拖动的帧率与右边缘反向滑动；更新日志已随 `release.json` 发布。
- 精确 main CI
  [34681349485](https://github.com/zdaiwmm/shui-IM/actions/runs/34681349485) 全部通过，覆盖构建与单元/集成测试、浏览器回归四分片、原生通话、依赖审计、凭据扫描和 `verify` 汇总。
- 固定入口 `node scripts/publish.mjs --sha b9ec6754ef6dbaf3d0ac348654ec2bf9fa8ec088` 返回
  `DEPLOY_OK`／`DEPLOY_VERIFIED`；发布目录
  `/opt/quiet-room/git-releases/20260912T075839Z-b9ec6754ef6d`，冷备份
  `/opt/quiet-room/backups/predeploy/data-20260912T075839Z-b9ec6754ef6d.tar.gz`。
- 独立 `READBACK_OK` 总耗时 2,709ms：线上 SHA、维护标记、容器状态和公开/容器产物一致；应用健康，
  备份容器运行中且无健康探针；HTTPS `ok`／`database`／`storage` 与新建公开 WebSocket 均通过。运行镜像摘要为
  `sha256:668b8f2e3cbc9138c165ba8279d64605684992d0cefe1e7db5a62a7cc343ed03`。
- iPhone / iOS 27 / Safari 真机、生产管理员逐项操作、独立密码学审计和高安全发布门槛仍未完成；文档提交不代表应用再次部署。

- 日期：2026-09-12（Asia/Shanghai）；服务器批次 `20260912T020340Z`，独立回读于
  `2026-09-12T02:06:08Z` 成功。应用提交
  `28cf70d380406d9a699873608f8df0430d2e8db2`，版本 `2026.09.12.1`；PR #110 已合并。
- 本批上线表情面板最近使用、媒体本地缓存与失败重试、贴图入口拖拽和边缘手势修复、发送后保持面板打开、
  弹窗遮蔽层竞态与发热控制，以及 GIF/贴纸自动隐藏管理开关。完整应用 CI
  [34665526770](https://github.com/zdaiwmm/shui-IM/actions/runs/34665526770) 已通过。
- 固定入口 `node scripts/publish.mjs --sha 28cf70d380406d9a699873608f8df0430d2e8db2` 返回
  `DEPLOY_OK`／`DEPLOY_VERIFIED`；服务器部署总计 127,000ms。发布目录
  `/opt/quiet-room/git-releases/20260912T020340Z-28cf70d38040`，冷备份
  `/opt/quiet-room/backups/predeploy/data-20260912T020340Z-28cf70d38040.tar.gz`。
- 独立 `READBACK_OK` 总耗时 3,451ms：线上 SHA、维护标记、容器状态和公开/容器产物一致；应用容器运行且健康，
  备份容器运行中且无健康探针；目标与运行镜像摘要均为
  `sha256:94c70012a4c0f247a9efd3674e0e4fe2ce33724bfe85136ea0105d62f9328c99`。HTTPS
  `ok`／`database`／`storage` 与新建公开 WebSocket 均通过；后台开关为 `1`，通话覆盖为 `0`，TURN 容器不存在。
- iPhone / iOS 27 / Safari 真机、生产管理员逐项操作、独立密码学审计和高安全发布门槛仍未完成；文档对账提交不代表应用再次部署。

- 日期：2026-09-11（Asia/Shanghai）；服务器批次 `20260911T072608Z`，独立回读于
  `2026-09-11T07:29:10Z` 成功。应用提交
  `c0e2921f3bf0bc25af37d7c768b50e4839262c32`，版本 `2026.09.11.3`。
  本批按用户要求纳入 PR #96、#97、#98、#99、#100；其中 #100 在发布前按 squash 合并。
- 本批范围包括：已读回执与送达状态分离、多设备未读同步、视频上传本地占位与进度/重试/取消；
  GIF 表情列表稳定尺寸、贴纸快捷入口惯性拖动与边缘回弹、拖动误触修复；录音停止前保持本地；
  既有版本说明随 `release.json` 版本 `2026.09.11.3` 发布。消息加密、设备历史边界、附件完整性、
  恢复与服务端密文边界保持既有契约。
- PR 合并提交分别为：#96 `2f4b22d6cbf18d014f8dc70ee37cc2574a30c487`、#97
  `17ae0d8e890c4ae3b2443f324b48311f2a83a347`、#98
  `98eeb1d18936b983a5b901a305db7fca57df5860`、#99
  `9228187491fdafda42835c1b1faf420c80fa55e3`、#100
  `c0e2921f3bf0bc25af37d7c768b50e4839262c32`。精确 main CI
  [34572989626](https://github.com/zdaiwmm/shui-IM/actions/runs/34572989626) 对最终提交全部通过，
  包含构建与单元/集成测试、浏览器回归四分片、原生通话、依赖审计、凭据扫描和 `verify` 汇总。
- 固定入口 `node scripts/publish.mjs --sha c0e2921f3bf0bc25af37d7c768b50e4839262c32` 返回
  `DEPLOY_OK`／`DEPLOY_VERIFIED`；入口总耗时 171,166ms，服务器部署阶段 126,000ms。
  发布目录 `/opt/quiet-room/git-releases/20260911T072608Z-c0e2921f3bf0`，冷备份
  `/opt/quiet-room/backups/predeploy/data-20260911T072608Z-c0e2921f3bf0.tar.gz`。
- 独立 `READBACK_OK` 总耗时 2,816ms：线上 SHA、维护标记、容器状态和公开/容器产物一致；
  应用健康，备份容器运行中且无健康探针；HTTPS `ok`／`database`／`storage` 与新建公开
  WebSocket 均通过。运行镜像摘要为 `sha256:4b8a842e103be9292eb6320c3a07a46f887c4101a8495e9c1e01e4b2efbe3cf2`。
- iPhone / iOS 27 / Safari 真机、生产管理员逐项操作、独立密码学审计和高安全发布门槛仍未完成。
  文档对账提交不代表应用再次部署。

- 日期：2026-09-11（Asia/Shanghai）；服务器批次 `20260911T043006Z`，独立回读于 12:34:45 成功。
  应用提交 `17ae0d8e890c4ae3b2443f324b48311f2a83a347`，版本 `2026.09.11.2`。
  代码通过 [PR #96](https://github.com/zdaiwmm/shui-IM/pull/96) 合并，发布说明通过
  [PR #97](https://github.com/zdaiwmm/shui-IM/pull/97) 合并；用户已明确授权本次直接完成发布。
- 本批修复消息已读与送达语义混淆：对方设备解密并保存不再直接显示双勾，文字／语音／文件在
  前台可见后发送精确加密已读回执，媒体须完成校验、加载并显露；多设备遮蔽层未读计数按同参与者
  已读范围合并并遵守加入边界；视频发送保留本地占位、首帧封面、上传进度、失败重试和取消。
- 冻结候选 `8624d33757f113835a82648f40c147d268d690e7` 的 `npm run delivery:evidence -- run check:full`
  通过：78 个测试文件、637 项测试、33/33 浏览器入口；浏览器总计 410.49 秒。最终 main CI
  `34561926453` 对精确应用提交全部通过。
- 固定入口总耗时 286,308ms，服务器切换 250,000ms；取得 `DEPLOY_OK`／`DEPLOY_VERIFIED`。
  发布目录 `/opt/quiet-room/git-releases/20260911T043006Z-17ae0d8e890c`，冷备份
  `/opt/quiet-room/backups/predeploy/data-20260911T043006Z-17ae0d8e890c.tar.gz`。
- 独立 `READBACK_OK` 耗时 2,873ms：线上 SHA、维护标记、容器状态和镜像一致；应用健康，备份容器
  运行中且无健康探针；HTTPS `ok`／`database`／`storage`、公开版本化产物和新建 WebSocket 均通过。
  运行镜像摘要为 `sha256:b5c6077d45d13e3e7f179f894eb1898dece317093e079d746b88a6fab4095703`；
  后台开关 `1`，通话覆盖 `0`，TURN 容器不存在。
- iPhone / iOS 27 / Safari 真机仍未验证；生产管理员逐项操作、独立密码学审计和高安全发布门槛
  仍按既有文档保持。文档对账提交不代表应用再次部署。

- 日期：2026-09-10（Asia/Shanghai）；服务器批次 `20260910T113538Z`，独立回读于 19:38:11 成功。
  应用提交 `e3e4eed9e2a6a4a5516d184c55f76b2d801b9e6f`，版本 `2026.09.10.4`。用户明确要求聊天反馈与后台上传修复一起集成、合并、直接发布，并明确本次不再重复确认；本任务固定该精确目标后执行。
  [集成 PR #89](https://github.com/zdaiwmm/shui-IM/pull/89) 已合并，源提交为聊天 `299e7418d0c8ee768d8905b68c71ad6d2d4f8840`（PR #87）与后台上传 `8c557225918694ed8d0567e555766c91b962b65b`。
- 候选 `89f5a608cb7155aa8256b6d93fd86e555ccc4bb9` 完整组合验证通过：78 文件／635 项单元测试、31/31 浏览器入口（398.95 秒）；[PR CI 34471148826](https://github.com/zdaiwmm/shui-IM/actions/runs/34471148826) 与精确 main [CI 34471738691](https://github.com/zdaiwmm/shui-IM/actions/runs/34471738691) 全部通过，合并文件树与候选一致。
- 本批上线爱心合拢、在线收发电流和空闲心跳增强、浅灰输入占位、500ms 长按录音防误触，以及加密已读双勾。文字／语音／文件须在前台可见，图片／视频还须校验、加载并显露；语音已读不表示已听完。后台整包上限对齐 50 MiB，异常 HTTP 响应显示可理解错误。
- 固定入口核对 `DEPLOY_VERIFIED`，总耗时 321,404ms（含等待 main CI）；冷备份已校验。发布目录 `/opt/quiet-room/git-releases/20260910T113538Z-e3e4eed9e2a6`，冷备份 `/opt/quiet-room/backups/predeploy/data-20260910T113538Z-e3e4eed9e2a6.tar.gz`。
- 后台 Nginx 独立安装了该提交的配置：实际 `/etc/nginx/conf.d/admin-mijiu.conf` 精确上传路由从 12m 改为 70m，其他路由仍为 64k。安装前旧摘要校验、同部署锁、备份、安装后 `nginx -t`、reload、active 与加载配置回读均通过。新文件 SHA-256 `fdfbaeaf3880ce6cace2614b99064968d6cda7e81112c27b987bfc25c3fc6290`，旧配置备份 `/opt/quiet-room/deploy-state/nginx-backups/admin-mijiu-20260910T113750Z-e3e4eed9e2a6.conf`；未更换部署 helper。
- 在应用与 Nginx 更新后，独立 `READBACK_OK` 耗时 2,737ms：线上 SHA、镜像、容器及公开产物一致；维护标记不存在，应用健康，备份容器运行中（无健康探针）；HTTPS ok/database/storage 和新建 WebSocket 均通过。后台开关 `1`，通话覆盖 `0`，TURN 容器不存在。脱敏证据保存于公共 Git 目录 `quiet-room-release-evidence/e3e4eed9e2a6/`。
- iPhone / iOS 27 / Safari 真机仍未验证；未使用管理员凭据在生产导入测试包。配置生效与自动合成上传验收不等于生产管理页面逐项验收。对账文档单独提交，不再次部署。

- 日期：2026-09-10（Asia/Shanghai）；服务器批次 `20260910T105954Z`，独立回读于 19:06:39 成功。
  应用提交 `b8be26c563430a98ffeade5a07ef815f6f87d169`，版本 `2026.09.10.3`；用户确认该完整提交后发布。
  [PR #84](https://github.com/zdaiwmm/shui-IM/pull/84) 已合并，精确 main [CI 34468072163](https://github.com/zdaiwmm/shui-IM/actions/runs/34468072163) 完整通过（含 632 项测试、浏览器回归、通话专项、依赖审计与凭据扫描）。
- 本批上线最多三个并行采集任务、持久任务进度与预计耗时、完整校验后自动上架、列表分页优化、Noto 多码点原图与 Signal 封面修复，以及表情搜索的过期返回动画和初始焦点竞态修复。
- 固定入口取得并核对 `DEPLOY_VERIFIED`，总耗时 414,455ms；镜像构建 302 秒，期间一次只读 SSH 检查超时，随后公网健康和构建恢复，未重试生产切换。冷备份已校验；发布目录 `/opt/quiet-room/git-releases/20260910T105954Z-b8be26c56343`，备份 `/opt/quiet-room/backups/predeploy/data-20260910T105954Z-b8be26c56343.tar.gz`。
- 独立 `READBACK_OK` 耗时 2,729ms：线上 SHA、镜像、容器和公开产物一致；维护标记不存在；应用健康，备份容器运行中（无健康探针）；HTTPS ok/database/storage 与新建 WebSocket 全部通过。后台开关为 `1`，通话覆盖开关为 `0`，TURN 容器不存在。脱敏证据保存于公共 Git 目录 `quiet-room-release-evidence/b8be26c56343/`。
- 真实 Chrome 临时数据库验证 Signal 20 张合集、Noto 白旗、刷新后任务恢复和自动上架，Signal 首页 24/24 封面解码；不等于生产管理页面逐项验收。iPhone / iOS Safari 真机未验证。对账文档单独提交与合并，不再次部署。

- 日期：2026-09-10（Asia/Shanghai）；服务器批次 `20260910T093547Z`，独立回读于 17:38:18 成功。
  应用提交 `e30a0cd1e876a4e8c152c34b2d833494b5078e71`，版本 `2026.09.10.2`；用户对该精确提交确认发布。
  [PR #82](https://github.com/zdaiwmm/shui-IM/pull/82) 已合并，精确 main [CI 34460331818](https://github.com/zdaiwmm/shui-IM/actions/runs/34460331818) attempt 1 完整通过。
- 本批包含媒体已读后 10 秒隐藏、向右拖拽隐藏与圆角、弱网通话恢复和语音优先、语音消息幂等重试，以及后台表情管理和 Signal / Noto 采集改进。
- 固定入口取得 `DEPLOY_VERIFIED`，总耗时 206,579ms；冷备份已校验。发布目录为 `/opt/quiet-room/git-releases/20260910T093547Z-e30a0cd1e876`，冷备份为 `/opt/quiet-room/backups/predeploy/data-20260910T093547Z-e30a0cd1e876.tar.gz`。
- 独立 `READBACK_OK` 耗时 3,001ms：线上 SHA、镜像、容器与公开产物一致；维护标记不存在；应用健康，备份容器运行中且无健康探针；HTTPS 的 ok/database/storage 和新建公开 WebSocket 均通过。脱敏证据持久保存于公共 Git 目录 `quiet-room-release-evidence/e30a0cd1e876/`。
- 最终组合本地 `check:full` 76 文件 / 620 项单元测试和 30/30 浏览器入口通过；通话及弱网专项证据见已有验收报告。iPhone / iOS Safari、真实多地域 TURN 与 Wi-Fi/蜂窝切换未验收。生产通话覆盖开关仍为 `0`、TURN 容器不存在；应用发布未配置中继基础设施。
- 对账文档单独提交与合并，不改变上述线上应用 SHA，也不再次部署。

- 日期：2026-09-10（Asia/Shanghai）；服务器批次 `20260909T232408Z`，独立回读于 07:27:26 成功。
  应用提交 `bc5893092fc8051750319bf38b77302e166d0194`，版本 `2026.09.09.10`；[PR #70](https://github.com/zdaiwmm/shui-IM/pull/70) 已合并，精确 main CI [34379775756](https://github.com/zdaiwmm/shui-IM/actions/runs/34379775756) 全部成功。
- 本批合并后台会话、表情管理和贴图导入修正：响应式控制台、状态筛选、批量操作、分页、上传反馈、详情预览、失败重试与键盘导航，以及含 `title.txt` 的 `.wastickers` 导入和封面排除。
- 固定入口取得 `DEPLOY_VERIFIED`，服务器发布目录为 `/opt/quiet-room/git-releases/20260909T232408Z-bc5893092fc8`，冷备份为 `/opt/quiet-room/backups/predeploy/data-20260909T232408Z-bc5893092fc8.tar.gz`。独立 `READBACK_OK` 核对线上 SHA、容器与公开产物、HTTPS 健康和公开 WebSocket 一致；脱敏证据位于独立发布 clone 的 `.git/quiet-room-readback/`。iPhone / iOS 27 / Safari 真机未验证。

- 日期：2026-09-09（Asia/Shanghai）；服务器批次 `20260909T121009Z`，独立回读于 20:14:25 成功。
  应用提交 `1f42ea0f6ec649bee87320107e481a188bdb4d50`，版本 `2026.09.09.9`；
  PR #62（代码）与 PR #63（发布说明）已合并，精确 main CI `34348514538` 全部成功。
- 本批将后台 GIFs 与贴图分为独立资源库，移除资源搜索和自动获取；手动上传直接打开文件选择器，
  按格式自动分类，使用文件名初始化名称并默认上架，修复 `.wastickers` 上传后的上架问题。
  Apple Liquid Glass 视觉优化分支明确排除。
- 固定入口取得 `DEPLOY_VERIFIED`；独立 `READBACK_OK` 总耗时 2,540ms，证据位于
  `/private/tmp/quiet-room-publish-2oiFDb/.git/quiet-room-readback/20260909T121425674Z-1f42ea0f6ec6-success.json`。
- 线上 SHA、容器与公开产物、HTTPS 健康和公开 WebSocket 独立回读一致。iPhone / iOS 27 / Safari
  真机未验证。

- 日期：2026-09-09（Asia/Shanghai）；服务器批次 `20260909T084220Z`，独立回读于 16:46:45 成功。
  应用提交 `ff828dc4476defc907c1f6daac144a7d6322b335`，版本 `2026.09.09.7`；
  PR #59 已合并，精确 main CI `34329323339` attempt 1 全部成功。
- 本批缩短空输入框和录音按钮的长按启动等待，并加快取消录音退出反馈；管理员表情、阅读器及移动交互
  已在基线中，Apple Liquid Glass 三个分支明确排除。
- 固定入口取得 `DEPLOY_VERIFIED`，独立 `READBACK_OK` 总耗时 2,892ms；
  生产发布目录为 `/opt/quiet-room/git-releases/20260909T084220Z-ff828dc4476d`，
  冷备份为 `/opt/quiet-room/backups/predeploy/data-20260909T084220Z-ff828dc4476d.tar.gz`。
- 线上 SHA、容器与公开产物、HTTPS 健康和公开 WebSocket 独立回读一致。iPhone / iOS 27 / Safari
  真机录音延迟尚未验证。

- 日期：2026-09-09（Asia/Shanghai）；服务器批次 `20260909T072358Z`，独立回读于 15:35:21 成功。
  应用提交 `7136b15c495ce7bfa4265a093c9e1f12c16d8b19`，版本 `2026.09.09.6`；
  PR #58 已合并，main 精确 CI `34322813712` 全部成功。
- 本批将动图和贴纸原图移出应用包，客户端改为读取服务器已上架资源；新增资源管理的自动获取配置弹窗，
  支持动图／贴纸合集、数量目标、关键词、错误重试和待上架审核。旧公开素材缓存随 Service Worker 升级清理。
- `admin.mijiu.cloud` 已配置 DNS A 记录、可信证书（有效期至 2026-12-08）和 Certbot 自动续期；
  原有管理员配置通过生产同版非特权容器校验并以只读方式挂载。后台上线后回读：首页 200、未认证 API 401、
  跨域请求 403、`/ws` 404；旧 `sao.shui.click` 已停用并返回 410。
- 固定入口取得 `DEPLOY_VERIFIED`，容器、冷归档和公开 WebSocket 检查通过。独立
  `READBACK_OK` 总耗时 3,207ms，证据位于独立回读 clone 的 `.git/quiet-room-readback/`；
  生产镜像 `sha256:e2e7e79ed0023ad3e5b88f3a3e9b89e08fde491d7121f335a3e1646384913373`。
- 本机构建及 68 个测试文件的 528 项测试通过，30 个 CI 浏览器入口通过；表情 WebKit 专项、后台合成登录／上传／审核、
  数量校验及失败重试通过。iPhone / iOS 27 / Safari 真机仍未验证。

- 日期：2026-09-09（Asia/Shanghai）；服务器批次 `20260908T235336Z`，最终独立回读于 08:02:06 成功。
  应用提交 `ab3c04ef49d19fe8f1d4b70ff5c5df4747ce670b`，版本 `2026.09.09.5`。
  用户在精确 SHA 已列明后确认未发布则继续发布及资源同步。
  [PR #56](https://github.com/zdaiwmm/shui-IM/pull/56) head 为 `35ed4bae681695d69808fa2f24ac2465e29e9df3`。
- 本批包含更新说明、输入占位、状态栏、表情手势和菜单、收藏与备份布局、消息媒体稳定性、
  EPUB 全书页码与跨章节连续翻页、单行阅读器工具栏及 PDF 翻页修正。
  新增 400 张 Google Noto 普通动画（原始 WebP，CC BY 4.0），未新增合集，露骨色情素材未纳入。
- 本地构建、68 个文件的 529 项测试及 30 个浏览器入口分段通过；Chrome / WebKit 专项、
  触摸跟手与状态栏画布像素检查通过；iPhone / iOS 27 / Safari 真机未验证。
  [PR 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34290709451) 通过；
  [精确 main CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34290750485) 首次贴纸搜索超时，
  同树 PR 及 CI 同版浏览器本地复测通过后重跑失败作业，attempt 2 全部成功。
- 固定入口一次实际发布成功，外层核对精确回执；总耗时 182,868ms，服务器发布 136 秒。
  发布目录 `/opt/quiet-room/git-releases/20260908T235336Z-ab3c04ef49d1`，已校验冷归档
  `/opt/quiet-room/backups/predeploy/data-20260908T235336Z-ab3c04ef49d1.tar.gz`。
- 公开素材批次 `noto-gifs-20260909` 事务新增 400、跳过 0，生产已上架动画 500、合集 30。
  400 份新增原图共 132,633,304 字节，逐份 SHA-256、批次标记及数据库 quick_check 均通过。
  导入前停机冷归档 `/opt/quiet-room/backups/expression-import-20260909T000026Z-ab3c04ef49d1/data.tar.gz`
  已校验；未同步测试数据库。SQLite 快照及只读挂载校验曾失败并自动恢复服务，改用既有冷归档后导入成功，
  后置校验在运行容器中以数据库只读模式续做，未重复导入或再次发布。
- 最终独立 `READBACK_OK` 耗时 2,614ms，SHA、镜像、HTTPS 产物与 WebSocket 一致，维护门不存在。
  应用健康，备份运行且无健康探针；实际镜像为
  `sha256:92020cd6ca1afbb0038eee77357e4f4abdc9b2ee1b3b164cb6526b59152b4f31`。
  后台、通话与 TURN 未启用。公共 Git 目录证据
  `quiet-room-readback/20260909T000204069Z-ab3c04ef49d1-success.json`。
  上一批已知的在线逻辑备份附件索引异常未在本批修复，不将冷归档和容器运行记为在线逻辑备份成功。
  对账在独立工作树完成，文档合并不触发再次部署。

## 历史线上发布记录（2026-09-09 06:27）

- 日期：2026-09-09（Asia/Shanghai）；服务器批次 `20260908T221713Z`，最终独立回读于 06:27:35 成功。
  应用提交 `46e4b77fee27df1ad30cb32cf4a45e1fd01186d0`，版本 `2026.09.09.4`。
  用户明确授权本批修复、合并和生产发布；自动审批要求精确 SHA 后，用户确认发布及公开表情库初始化。
  [PR #54](https://github.com/zdaiwmm/shui-IM/pull/54) head 为 `d3fd45121f65bfad60b0ee82f4da004d6d766993`。
- 本批同时纳入本机 main 已集成但此前未发布的表情资源库、文档阅读器和媒体控件。
  修正表情自动分页及安装合集管理、全屏展开与跨 tab 定位；逐屏文档阅读、滚动模式、翻页动画、搜索与封面；
  更新日志、回复焦点、照片连续退出、离线电流反馈和移动竖屏保护。产品与隐私边界见 [PRODUCT.md](PRODUCT.md)、
  [MEMES.md](MEMES.md)、[SECURITY.md](SECURITY.md)。Safari 不支持方向锁时采用横屏保护，不声称能锁定系统旋转。
- 本地构建、527 项单元/集成测试、30 个浏览器入口通过；进程组回收 `kill EPERM` 后分段续跑，
  不记为 check:full 单次零退出。Chrome 专项与 WebKit 阅读器、表情、照片和回复交互通过，
  移动/桌面截图及几何检查通过；iPhone / iOS 27 / Safari 真机未验证。
  [PR 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34281004905) 与
  [精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34282202538) 全部成功。
- 固定入口一次实际发布成功，外层核对精确成功回执；总耗时 135,289ms，服务器发布 107 秒。
  发布目录 `/opt/quiet-room/git-releases/20260908T221713Z-46e4b77fee27`；发布前冷归档
  `/opt/quiet-room/backups/predeploy/data-20260908T221713Z-46e4b77fee27.tar.gz` 已校验。
- 经用户授权，另以维护锁、停机冷归档及仓库原子初始化器完成公开素材入库：30 个已上架合集、100 张 GIF，
  883 份去重原图、56,948,375 字节，新增 130、跳过 0，完成标记与数量回查一致。
  使用仓库静态素材，未同步测试数据库；后续代码版本不自动导入测试后台新增资源。
  公开文件只读权限预检通过后才进入最终维护，初始化冷归档为
  `/opt/quiet-room/backups/predeploy/catalog-20260908T222618Z-46e4b77fee27.tar.gz`，未修改原始聊天数据。
- 初始化后独立 `READBACK_OK` 耗时 2,967ms，目标 SHA、批次、发布目录、HTTPS 健康与公开资源一致，
  WebSocket 连接成功，维护标记不存在。应用健康，备份运行且无健康探针；两者镜像为
  `sha256:2a6d5cab1098907f22cbb052db15943228e34acc3bee57970758279d3f3e55b5`。
  后台、通话与 TURN 未启用。脱敏证据为公共 Git 目录中的
  `quiet-room-readback/20260908T222732300Z-46e4b77fee27-success.json`。
- 初始化前在线逻辑备份报告附件索引不完整，未自动修复或删除数据；备份代码未变，索引异常仍需独立调查。
  上述冷归档校验不等于在线逻辑备份成功。早期 SSH 白名单问题由用户修复；公开素材权限失败事务未提交且服务已恢复，
  最终预检及初始化成功后再次完成生产回读。本机 main 原 HTTPS 来源已回读同一应用代码；
  发布后对账只修改文档，不触发再次部署。

## 历史线上发布记录（2026-09-09 00:22）

- 日期：2026-09-09（Asia/Shanghai）；服务器批次 `20260908T161957Z`，00:22:14 独立回读成功。
  应用提交 `01f7ab0b60aded47e04bef5e34e42ddb9300cade`，版本 ID `2026.09.08.6`。
  用户明确授权本轮 11 项修复优化、合并并发布，无需再次审核；精确目标在发布前展示。
  [PR #52](https://github.com/zdaiwmm/shui-IM/pull/52) head 为
  `c703adef6acf08445021dc7ae1733504f5cc8bbf`，从远端 `733e794` 构建，未包含本地专用调试工具。
- 统一五列表情容器、缩小定位图标与表情消息、清晰长按预览、录音热区动画、工具背景、
  保险箱浮动显隐、顶部自适应 toast；表情不自动进入保险箱；文件阅读器被拦截时静默停留。
  跨版本说明按历史记录合并去重。新加密表情标记须所有活动设备更新，旧自定义图片不推测分类；
  真实后台与原始附件校验继续生效。详见 [D-037](docs/context/decisions.md#d-037表情呈现文件阅读器与跨版本说明)。
- 本地构建、518 项单元／集成测试通过，28 个浏览器入口分段续跑通过，不记为 check:full 单次零退出。
  WebKit 表情／文件／系统界面、原生 WebRTC／通话 UI、移动及桌面截图通过；本轮无 iPhone 真机通过证据。
  [PR 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34248542602) 和
  [精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34249429553) 均成功。
- 固定入口一次成功，`DEPLOY_OK`、`DEPLOY_VERIFIED` 与隔离克隆精确回执一致；总耗时 582,322ms
  （含等待 CI 399,755ms），服务器发布 73 秒。发布目录
  `/opt/quiet-room/git-releases/20260908T161957Z-01f7ab0b60ad`，冷备份
  `/opt/quiet-room/backups/predeploy/data-20260908T161957Z-01f7ab0b60ad.tar.gz` 已校验。
- 独立 `READBACK_OK` 耗时 2,816ms：目标 SHA、批次和发布目录匹配，维护标记不存在；
  应用运行且健康，备份运行且无健康探针，两者镜像均为
  `sha256:372b94b8e538d3c3c269a8b34233923addcb9085a8ea0a696a2a27719f203be5`。
  HTTPS 健康三项全 true，首页、Service Worker、JS、CSS 与 preload 摘要匹配容器，WebSocket 成功。
  后台、通话和 TURN 未启用。
- 本机 main 以 `d650fe8` 集成并保留本地调试工具；可信 HTTPS 源码和健康后端回读通过。
  对账在不含部署配置的第二个独立工作树完成，文档提交不触发再次部署；共享源目录未提交改动保留。

## 历史线上发布记录（2026-09-08 23:28）

- 日期：2026-09-08（Asia/Shanghai）；服务器批次 `20260908T152725Z`，23:28:44 独立回读成功。
  应用提交 `9728183734c602f3602a07cbdcac4643501cb6ed`，版本 ID `2026.09.08.5`。
  用户本轮明确授权修复输入框键盘故障、合并并发布生产，无需再次审核。
  [PR #49](https://github.com/zdaiwmm/shui-IM/pull/49) head 为
  `8a8b205c7fdae88747c4c600be767a268a3c3ffd`；主线期间仅新增上一版文档对账，已核对应用文件一致。
- 空输入框短按改在 `touchend` 同步聚焦，保留鼠标释放、长按录音和取消行为；
  处理 `pointerup` 后隐式丢失捕获的事件顺序。WebKit 真实触摸对比确认旧版在 `pointerup` 聚焦、
  新版在 `touchend` 聚焦。未修改密码学、存储、键盘布局 CSS 或服务器发布程序。
- 本地 `npm run check:full` 单次通过构建、514 项单元／集成测试和 28／28 浏览器入口
  （浏览器总计 410.00 秒）。[PR 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34242462548)
  及[精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34243283577) 均成功。
  USB iPhone16,1 / iOS 27.0 可连接，但当时处于浏览器连接错误页；本次没有真机键盘通过证据。
- 首次发布在 `stop-containers` 阶段检测到旧容器仍运行，固定程序回滚成功；未进入冷备份及
  数据替换阶段。独立 `READBACK_OK` 确认旧版 `cf95d2d` 健康（3,289ms），再只读检查容器停止／退出事件。
  对同一精确 SHA 的一次有限重试成功，未修改发布入口或 helper。该停止状态时序问题保留为运维观察项。
- 成功重试取得 `DEPLOY_OK`、`DEPLOY_VERIFIED` 并由外层核对精确回执；入口耗时 155,296ms，
  服务器阶段 48 秒。发布目录 `/opt/quiet-room/git-releases/20260908T152725Z-9728183734c6`，
  冷备份 `/opt/quiet-room/backups/predeploy/data-20260908T152725Z-9728183734c6.tar.gz` 已校验。
- 独立 `READBACK_OK` 耗时 2,734ms：SHA、发布目录和镜像一致，维护标记不存在；
  应用运行且健康，备份运行且无健康探针，镜像为
  `sha256:9c1136b6fcb399a0ca996386e93399a196689699b619892b9e4de7320ae8f461`。
  HTTPS 健康三项全 true；首页、Service Worker、JS、CSS 与 preload 摘要匹配容器，WebSocket 成功。
  后台、通话和 TURN 未启用。本机 main `ff61522` 已集成，可信 HTTPS 源码和后端健康回读通过。
- 对账使用不含部署配置的独立工作树；文档提交不触发再次部署。既有四个未提交文件未纳入。

## 历史线上发布记录（2026-09-08 23:03）

- 日期：2026-09-08（Asia/Shanghai）；服务器批次 `20260908T150136Z`（23:01:36），
  23:03:39 独立回读成功。应用提交 `cf95d2dfb4b3169c8affef38f27db1c0cbee67fb`，
  版本 ID `2026.09.08.4`。用户本轮明确授权合并近期完成分支、推送 main 并自行发布，无需再次确认。
  [PR #48](https://github.com/zdaiwmm/shui-IM/pull/48) head 为
  `f9cabc5def84be08736c7d6138a59423f83121e9`，合并后文件树与该候选完全一致。
- 包含键盘修复 `4f65f77`、模糊位图 `744fd1d`、标题栏、相册与图片属性，以及
  贴纸/GIF `f3778bd`、聊天工具/附件收藏/输入框录音 `1fc84d4`。
  键盘核心模块、视口运动模块与原布局 CSS 相对本机基线 `83dd21e` 逐字节不变。
  合并修复空输入框录音释放重复聚焦，以及页面过渡的临时坐标覆盖历史阅读位置；
  保护仅用于保存位置恢复，普通分页仍允许聚焦输入框回到最新消息。
- [PR 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34239954968) 与
  [精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34240917913) 全部成功。
  最终候选本地 `CI=1 npm run check:full` 单次通过构建、514 项单元／集成测试和
  28／28 浏览器入口（315.16 秒）；原生通话、通话 UI、WebKit 聊天工具与系统界面专项通过。
  CI 补装实际需要的 WebKit；浏览器入口计数、对话框聚焦夹具与浮点高度断言已同步。
  没有新增真机验收，既有换行偶发闪动暂缓项继续保留。
- 固定 `publish.mjs --sha` 返回精确 `DEPLOY_OK`／`DEPLOY_VERIFIED`，外层核对回执成功。
  入口耗时 632,034ms（含等待 main CI 420,120ms），服务器阶段 93 秒。
  发布目录 `/opt/quiet-room/git-releases/20260908T150136Z-cf95d2dfb4b3`，已校验冷备份
  `/opt/quiet-room/backups/predeploy/data-20260908T150136Z-cf95d2dfb4b3.tar.gz`。
- 独立 `READBACK_OK` 耗时 2,990ms：线上 SHA、批次、发布目录一致，维护标记不存在；
  应用运行且健康，备份运行且无健康探针，二者实际镜像均匹配
  `sha256:df76d19c62fec31c935ab646e89666bf3e342c4ad46ac59fa59ea2544e54a3b0`。
  HTTPS 健康三项全 true；首页、Service Worker、JS、CSS 与 preload 摘要匹配容器，
  新建 WebSocket 连接成功。`admin-enabled=0`、`calls-enabled=0`，TURN 不存在。
  未读取真实消息、附件或备份内容；发布前旧版本为 `18e07b08e3c1422ac693a7f98a6a66ac1277ef85`。
- 本机 main 保留并行完成的 iPhone 调试工具 `b15a453`，以 `8f6a753` 集成此应用。
  前后端 cwd 均为 `/Users/zhouding/quiet-room-local-main`，原可信 HTTPS 来源健康与新源码回读通过。
  原开发目录四个未提交文件未纳入。对账在不含部署配置的独立文档工作树完成，文档不触发重新部署。

## 历史线上发布记录（2026-09-08 14:02）

- 日期：2026-09-08（Asia/Shanghai）；服务器批次 `20260908T060001Z`（14:00:01），
  14:02:06 独立回读成功。用户确认的精确应用提交为
  `18e07b08e3c1422ac693a7f98a6a66ac1277ef85`，版本 ID `2026.09.08.3`。
  [PR #46](https://github.com/zdaiwmm/shui-IM/pull/46) 的 head 为
  `60d0bcd1b83d6471b4fc2dd265e2e16c728acec4`。发布提交也包含已合并的
  [PR #44](https://github.com/zdaiwmm/shui-IM/pull/44) 工作流文档，应用与测试文件和候选一致。
- 本次修复聊天进入保险箱、设备管理、备份与恢复及返回时重复淡入造成的闪烁；
  聊天图片、视频封面、相册缩略图和聊天遮挡背景统一为 48px 模糊。原图、显露手势、
  附件校验、权限和密钥边界保持原契约。来源提交为 `8b35afac605c717a2a433c489c810c6adc55a15e`
  与 `94714618c77533035cc35419adb258fd49383e1a`，均为本次应用提交祖先。
- [PR 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34187013152) 与
  [精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34187412121) 全部成功，
  包含两组浏览器、原生通话、依赖审计、凭据扫描及完整汇总。本地最终组合
  `npm run check:full` 通过 58 个文件、473 项测试和 24／24 浏览器入口（292.01 秒）；
  WebKit 页面切换、原生通话和通话界面专项也通过。没有新增真机验收。
- 固定 `publish.mjs --sha` 返回精确 `DEPLOY_OK`／`DEPLOY_VERIFIED`，外层核对成功回执。
  入口耗时 111,670ms，隔离发布与入口回读 78,791ms，服务器阶段 64 秒。
  发布目录 `/opt/quiet-room/git-releases/20260908T060001Z-18e07b08e3c1`，已校验冷备份
  `/opt/quiet-room/backups/predeploy/data-20260908T060001Z-18e07b08e3c1.tar.gz`。
- 独立 `READBACK_OK` 耗时 2,759ms：线上提交、批次和发布目录一致，维护标记不存在；
  应用运行且健康，备份运行且无健康探针，两者实际镜像均匹配目标
  `sha256:b0ecc02159d7ace38cc15f15f555b3ba16490a047c8566f7a9cd7592fc7d32bc`。
  HTTPS 健康三项全为 true；首页、Service Worker、应用 JS、CSS 和 preload 与容器产物摘要一致，
  独立 WebSocket 连接成功。`admin-enabled=0`、`calls-enabled=0`，TURN 不存在。
  未读取真实消息、附件或备份内容。发布前预检确认旧版本为 `a493aa06459c86a89049978e1df218245cce3836`。
- 对账在不含部署配置的独立文档工作树完成；文档提交不代表应用再次部署。

## 历史线上发布记录（2026-09-08 12:13）

- 日期：2026-09-08（Asia/Shanghai）；服务器批次 `20260908T041211Z`（12:12:11），
  12:13:56 独立回读成功。用户明确授权本次修复合并并发布生产；目标应用提交为
  `a493aa06459c86a89049978e1df218245cce3836`，版本 ID `2026.09.08.2`。
  [PR #43](https://github.com/zdaiwmm/shui-IM/pull/43) 的精确 head 为
  `b49af39189ec1f95178aa370685fc9a5baae6b1a`，合并后文件树与候选一致。
- 本次修复分页外旧消息回执反复请求空同步，以及空同步重建相册、返回动画期间误重开
  退场相册的问题。旧回执从本机加密历史读取，签名、消息绑定和角色校验继续有效；
  历史缺失失败关闭，不跳过回执或重复推进 MLS。没有新增真机验收。
- [PR 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34185394350) 与
  [精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34185773418)
  全部成功，包含构建、两组浏览器、原生通话、依赖审计、凭据扫描与完整汇总。
  修复本地 `npm run check:full` 通过 58 个文件的 473 项单元／集成测试及
  24／24 浏览器入口（289.24 秒）；版本说明变更后构建与更新提示专项也通过。
- 固定 `publish.mjs --sha` 返回精确 `DEPLOY_OK`／`DEPLOY_VERIFIED`，外层成功核对回执。
  总耗时 387,651ms，其中等待 main CI 297,569ms、隔离发布与入口回读 74,702ms，
  服务器阶段 62 秒。发布目录 `/opt/quiet-room/git-releases/20260908T041211Z-a493aa06459c`，
  已校验冷备份 `/opt/quiet-room/backups/predeploy/data-20260908T041211Z-a493aa06459c.tar.gz`。
- 独立 `READBACK_OK` 耗时 3,108ms：线上提交、批次和发布目录一致，维护标记不存在；
  应用运行且健康，备份运行且无健康探针，二者实际镜像均匹配目标
  `sha256:7bc15bbfba26b8101ff15b57f7569fc2c19aefef9f33f2a754c466c5e19dec7b`。
  HTTPS 的 `ok`／`database`／`storage` 全为 true；首页、Service Worker、应用 JS、CSS
  和 preload 与容器产物逐字节摘要一致，独立 WebSocket 连接成功。
  `admin-enabled=0`、`calls-enabled=0`，TURN 不存在。未读取真实消息、附件或备份内容。
- 发布前只读预检确认旧应用为 `0d835dc78030e9f9ba8ef7d25af36e63314ada13`。
  发布后对账在不含部署配置的独立文档 worktree 完成；文档提交不代表再次部署。

## 历史线上发布记录（2026-09-08 11:20）

- 日期：2026-09-08（Asia/Shanghai）；服务器批次 `20260908T031931Z`（11:19:31），
  11:20:53 独立回读成功。用户确认的应用提交为
  `0d835dc78030e9f9ba8ef7d25af36e63314ada13`，版本 ID `2026.09.08.1`，
  [PR #41](https://github.com/zdaiwmm/shui-IM/pull/41) 的 head 为
  `527a94435e84b4fa70386f9344216c60f91f9142`。
- 本批发布已在 main 的 iPhone 键盘跟随、输入区域定位、可续传附件提醒修复及固定发布入口，
  同时更新版本 ID，使旧客户端识别新版本。原共享目录四个未提交文件未纳入。
  本轮没有新增真机验收，既有列表末尾闪动等缺口继续保留。
- [PR 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34182031335) 与
  [精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34182411954)
  全部成功，包含两组浏览器、原生通话、依赖审计、凭据扫描与完整汇总。
  候选本地 `npm run check:full` 通过 58 个文件、473 项单元／集成测试、24／24 浏览器入口
  （287.35 秒）；首次受限运行因本地端口 `EPERM` 失败，获端口权限后的完整重跑通过。
- 本次实时预检回报生产为 `a2fa6336f9ff080c71442ea9b53d283961044c28`，与上一轮较早的
  `fd7a8ab` 快照不同；该预检只证明当时运行 SHA，不补造中间版本的独立发布证据。
- 固定 `publish.mjs --sha` 入口返回精确 `DEPLOY_OK`／`DEPLOY_VERIFIED`，外层成功核对回执。
  总耗时 94,003ms，隔离发布与入口回读 73,544ms，服务器发布 60 秒。发布目录
  `/opt/quiet-room/git-releases/20260908T031931Z-0d835dc78030`，已校验冷备份
  `/opt/quiet-room/backups/predeploy/data-20260908T031931Z-0d835dc78030.tar.gz`。
- 独立 `READBACK_OK` 耗时 2,748ms：线上 SHA、批次和发布目录一致，维护标记不存在；
  应用运行且健康，备份运行且无健康探针，二者镜像均为
  `sha256:3862fecef4e3d6b1629b95dba829829e146e4e765c6352b28833fef24e8e1c65`。
  HTTPS 的 `ok`／`database`／`storage`、公开与容器产物逐字节摘要和 WebSocket 均通过。
  `admin-enabled=0`、`calls-enabled=0`，TURN 不存在。检查未读取真实消息或备份内容。
- 对账在不含部署配置的独立文档 worktree 完成，文档提交不代表再次部署。

## 上次线上发布记录（2026-09-07 08:57）

- 日期：2026-09-07（Asia/Shanghai）；服务器批次 `20260907T005618Z`（08:56:18），
  08:57:28 独立回读成功。应用提交 `fd7a8ab7732afff98c4f0a6a3b60c31ea67bf213`，由
  [PR #37](https://github.com/zdaiwmm/shui-IM/pull/37) 合并，候选 head
  `5125c383b1ba990000aeb62a4b6868d9c8b1e81e`。
- 本批上线首次加入与新增设备绑定的 WebAuthn 回焦续接、图片边缘缩放和回复左滑阻尼、备份与
  恢复页视觉层级、蓝牙音频授权交接，以及 iOS 发送滚动期间固定栏定位和延迟视口回调抑制。
  离线密文入队、消息／MLS 原子持久化、普通重试密文复用、设备历史、恢复权限和原始附件校验
  边界保持不变。
- 用户提供的 iPhone／iOS 27／Safari 专项真机回归覆盖多行输入、单行／多行发送和输入框高度
  复位期间的标题栏与输入工具栏稳定；本机调试后端没有既有房间授权，因此不证明消息真实网络
  送达。首次加入／设备绑定修复后的真机复测、Tesla 蓝牙、Android 和其他系统表面仍未验证。
- 精确 main 的[完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34050348842)全部成功，
  通过构建和单元／集成测试、两组浏览器回归、原生通话、凭据扫描、文档检查、生产依赖审计、
  `Full application verification` 与最终 `verify`。各来源工作树的本地 `npm run check:full`
  证据见状态页，不能替代该精确 main CI。
- 固定入口 `node scripts/publish.mjs --sha fd7a8ab7732afff98c4f0a6a3b60c31ea67bf213`
  返回精确 `DEPLOY_OK`、`DEPLOY_VERIFIED`，外层回执核对成功。入口总耗时 92,173ms，其中
  隔离发布与入口回读 73,333ms；服务器发布 59 秒，获取源码 5 秒、构建镜像 13 秒、维护门
  1 秒、停止容器 1 秒、冷备份 6 秒、启动及健康等待 31 秒、门内验证 1 秒。发布目录
  `/opt/quiet-room/git-releases/20260907T005618Z-fd7a8ab7732a`，已校验冷备份
  `/opt/quiet-room/backups/predeploy/data-20260907T005618Z-fd7a8ab7732a.tar.gz`。
- 08:57:28 独立只读回读返回 `READBACK_OK`，总耗时 2,987ms：线上 SHA、批次和发布目录一致，
  维护标记不存在；应用运行且健康，备份容器运行且无健康探针；应用与备份实际镜像均匹配
  `sha256:4b52b219a0cfad66da1a1aca4dd0f54d90056f3fa0b55c7be72476d7f2be9972`。HTTPS 的 `ok`、
  `database`、`storage` 均为 true，首页、Service Worker、版本化公开／容器产物和公开 WebSocket
  均通过；`admin-enabled=0`、`calls-enabled=0`，TURN 不存在。检查未读取真实消息、附件或备份
  内容；公开高安全声明仍受 `PRODUCTION_SECURITY_GATE.md` 阻塞。
- 发布后在不带部署配置的第二个独立 worktree 对账本记录与状态页；文档 PR 不代表再次部署。

## 上次线上发布记录（2026-09-06 21:03）

- 日期：2026-09-06（Asia/Shanghai）；服务器批次 `20260906T130200Z`（21:02:00），
  21:03:09 独立回读成功。应用提交 `fc3c0cdd28f5acac81f32e30b8c57b28536b0f2c`，由
  [PR #35](https://github.com/zdaiwmm/shui-IM/pull/35) 合并，候选 head
  `50f33a05e0645fc4097b30da258e429c06e1d9bb`。
- 本批修复多行输入和发送时的聊天布局抖动：输入栏按底边定位，输入框高度、消息插入与列表
  位移由同一逐帧动画驱动，标题栏和输入工具栏保持固定；连续组词、伸展途中发送、多行发送后
  复位及阅读旧消息锚点均从当前可见位置衔接。消息／MLS 原子持久化、普通重试密文复用、设备
  历史、恢复和原始附件校验边界不变。
- 最终本地 `npm run check:full` 通过构建、54 个测试文件／454 项单元集成及 24／24 个 Chromium
  浏览器入口（265.30 秒），WebKit 输入栏专项也通过。PR 首轮
  [CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34033689900)的浏览器第 1 组暴露既有图库
  返回用例在滚动账务提交前读取基线的竞态；产品断言保持不变，夹具等待两个动画帧后再记录
  基线。修订后的 [PR 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34034272592)
  和精确 main [完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34034568250)全部成功。
- 固定入口 `node scripts/publish.mjs --sha fc3c0cdd28f5acac81f32e30b8c57b28536b0f2c`
  返回精确 `DEPLOY_OK`、`DEPLOY_VERIFIED`，外层核对成功。入口总耗时 362,808ms，其中等待
  main CI 276,063ms、隔离克隆 7,804ms、部署与入口回读 71,883ms；服务器部署 58 秒，获取
  源码 4 秒、构建镜像 15 秒、停止容器 1 秒、冷备份 6 秒、启动及健康等待 31 秒、门控验证
  1 秒。发布目录 `/opt/quiet-room/git-releases/20260906T130200Z-fc3c0cdd28f5`，已校验冷备份
  `/opt/quiet-room/backups/predeploy/data-20260906T130200Z-fc3c0cdd28f5.tar.gz`。
- 21:03:09 独立只读回读返回 `READBACK_OK`，总耗时 2,661ms：线上 SHA、批次和目录一致，
  维护标记不存在；应用运行且健康，备份容器运行且无健康探针；应用与备份实际镜像均匹配
  `sha256:1dd0dbdd60dec11d8ec7c92c917e61a4c1afb88ba868632739d6fc27def9762b`。HTTPS 健康、
  首页、Service Worker、版本化公开／容器产物和公开 WebSocket 均通过；`admin-enabled=0`、
  `calls-enabled=0`，TURN 不存在。检查未读取真实消息、附件或备份内容；真实 iPhone／Android、
  长期运维和独立安全审计仍未验证。
- 首次从不带部署配置的任务 worktree 调用固定入口时，预检因缺少 `serverHost` 在 24ms 内阻断，
  未进入任何生产阶段；随后从已有配置的原始工作区对同一精确 SHA 执行成功。回读后在不带部署
  配置的独立 worktree 对账本记录与状态页；文档 PR 不代表重新部署。

## 上次线上发布记录（2026-09-06 19:37）

- 日期：2026-09-06（Asia/Shanghai）；服务器批次 `20260906T113628Z`（19:36:28），
  19:37:32 独立回读成功。应用提交 `981b21612b16bc5b9d1e4007ed051f17a3170256`，由
  [PR #31](https://github.com/zdaiwmm/shui-IM/pull/31) 集中合并用户可见改动，
  [PR #33](https://github.com/zdaiwmm/shui-IM/pull/33) 补齐生产 Docker 构建所需的
  `release.json`；两者之间的 PR #32 仅对账上一批发布文档。
- 本批上线遮蔽长按后的 Safari 静默焦点观察、回复手势可见宽度上限、相册翻页与缩放归位、
  已验证密文媒体缓存、语音录制文案与消息时间对比度、textarea 与聊天布局同步动画，以及
  `release.json` 驱动的 Service Worker 新版本广播、聊天更新条和有序版本说明。消息／MLS
  原子持久化、普通重试密文复用、设备历史、恢复和原始附件校验边界不变。
- PR #31 的[完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34029235057)与 PR #33 的
  [完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34029933055)均成功。本地集中组合
  `npm run check:full` 通过 54 个测试文件／453 项单元集成及 24／24 个浏览器入口；Docker
  修复后 `npm run check` 通过 54 个文件／454 项测试。精确 main 的
  [完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34030231719)首次仅浏览器第 1 组的
  图库返回聊天锚点时序断言失败；同一源码树此前 PR CI 已通过，且并行进入 main 的变更仅为
  文档。读取日志后只重跑该 SHA，浏览器两组、完整应用汇总与最终 `verify` 全部成功。
- 首次尝试发布前一合并提交 `624abe606674140b0c3de5a44043c8b273ad5e02` 时，Docker 构建
  因未复制 `release.json` 在 TypeScript 阶段失败；发布停在 `build-image`，尚未进入维护门、
  停容器、冷备份或流量切换，生产未变化。修复经新 PR 和新 main SHA 的完整 CI 后才重新执行
  固定入口，没有盲目重发失败 SHA。
- 固定入口 `node scripts/publish.mjs --sha 981b21612b16bc5b9d1e4007ed051f17a3170256`
  返回精确 `DEPLOY_OK`、`DEPLOY_VERIFIED`，外层核对成功。入口总耗时 88,711ms，其中隔离
  发布与入口回读 69,888ms；服务器部署 56 秒，获取源码 5 秒、构建镜像 13 秒、停止容器 1 秒、
  冷备份 5 秒、启动及健康等待 31 秒。发布目录
  `/opt/quiet-room/git-releases/20260906T113628Z-981b21612b16`，已校验冷备份
  `/opt/quiet-room/backups/predeploy/data-20260906T113628Z-981b21612b16.tar.gz`。
- 19:37:32 独立只读回读返回 `READBACK_OK`，总耗时 2,794ms：线上 SHA、批次和目录一致，
  维护标记不存在；应用运行且健康，备份容器运行且无健康探针；实际镜像匹配
  `sha256:0d8bc95ce285143a9cffe6dfa82dafd4300ef643ae9afe14ca8a1f286e9b17ff`。HTTPS 健康、
  首页、Service Worker、版本化公开／容器产物和公开 WebSocket 均通过。检查未读取真实消息、
  附件或备份内容；真实 iPhone／Android、长期运维和独立安全审计仍未验证。
- 回读后在不带部署配置的第二个独立 worktree 对账本记录与状态页；文档 PR 不代表重新部署。

## 上次线上发布记录（2026-09-06 19:10）

- 日期：2026-09-06（Asia/Shanghai）；服务器批次 `20260906T110806Z`（19:08:06），
  19:10:59 独立回读成功。应用提交 `b2c1b65e6a3ee80dcd6eb4b158e3e8182e2f0e49`，由
  [PR #30](https://github.com/zdaiwmm/shui-IM/pull/30) 于 19:02:50 merge 合并，候选 head
  `6855fa5e7a42a6065e8c1fec7cef04c304ce3ea9`；合并前后文件树一致。
- 本批增加交付前主线同步、任务分支推送和共享交接登记规则，以及默认只检查、按精确 SHA
  条件执行的开发资源清理脚本。未修改聊天运行时代码、生产 helper 或安全契约；登记仍由 agent
  执行，未实现自动领取队列、后台持续集成或自动模型切换。
- [PR 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34028794067) 与
  [精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34029104686) 全部成功。
  本地最终 `npm run check:full` 通过 53 个文件／447 项单元集成及 23／23 个浏览器入口，
  浏览器总计 254.60 秒；26 项清理专项只在临时仓库测试。CI 另通过通话、凭据扫描、
  生产依赖审计及完整汇总。
- 固定 `publish.mjs --sha b2c1b65e6a3ee80dcd6eb4b158e3e8182e2f0e49` 返回精确 `DEPLOY_OK` 与
  `DEPLOY_VERIFIED`，外层与独立读取的隔离副本回执均匹配。总耗时 344,208ms，其中等待
  main CI 254,826ms、克隆 7,747ms、部署与入口回读 74,847ms；服务器部署 61 秒。
  发布目录 `/opt/quiet-room/git-releases/20260906T110806Z-b2c1b65e6a3e`，已校验冷备份
  `/opt/quiet-room/backups/predeploy/data-20260906T110806Z-b2c1b65e6a3e.tar.gz`。
- 固定独立回读返回 `READBACK_OK`，耗时 2,457ms：维护标记不存在，应用运行且健康，
  备份运行且无健康探针；实际 Image ID 均匹配
  `sha256:e9b6d54e3ed5bb03b5f8efacd008de075c6433dbbdf7d9bdc7a649a781bd75c3`。
  HTTPS 三项健康均为 true；首页、Service Worker、应用 JS/CSS 与 preload 产物和容器一致，
  公开 WebSocket 新连接成功。`admin-enabled=0`、`calls-enabled=0`；不外推真机或独立审计。
- 首次独立回读所有远端检查通过，但在 linked worktree 的 `.git` 文件下保存证据失败。
  随后在已有精确发布克隆补齐锁定的生产依赖，仅重跑独立回读并取得成功证据；没有再次部署。
  该兼容问题保持待修复，操作要求见本页回读入口说明。
- 发布记录在独立文档 worktree 对账，不携带部署配置，不因文档合并重新发布。
  当前任务仍活跃且开发目录含依赖/构建缓存，按清理规则保留本任务开发资源；不清理其他会话。

## 上次线上发布记录（2026-09-06 17:09）

- 日期：2026-09-06（Asia/Shanghai）；`deployed-at=20260906T090746Z`（17:07:46 发布批次），
  17:09:06 前完成独立回读。应用版本 `e359476ce6bffee85ae355bdf93b34b14a544dc2`，由
  [PR #28](https://github.com/zdaiwmm/shui-IM/pull/28) 于 17:01:04 以 merge commit 合并；
  合并前冻结 head 为 `f3b763d4aa9c12a0ecbae235cec7be5932ab7397`，合并提交第二父树与
  head 树逐字节一致。用户明确授权向私有仓库推送、创建 PR、合并并发布到正式来源。
- [PR #28 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34023207250) 与
  [精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34023450500) 均成功：
  构建、52 个测试文件／421 项单元集成、两组共 23 个浏览器入口、原生通话、凭据扫描、
  生产依赖审计及 `Full application verification`／`verify` 汇总全部通过。本地最终组合
  `npm run check:full` 从头通过，浏览器汇总 254.96 秒；合并期间暴露的回复手势／消息删除
  竞态夹具已按 window 级松手监听修正，定向和完整套件均通过。自动化不替代真实 iPhone 验收。
- 本次集中纳入：通行密钥回焦与遗留请求中止、聊天媒体准备阶段和默认遮蔽、图片查看器适配
  与手势、松手前持续跟随的左滑回复、可回拖的语音发送／取消反馈，以及任务隔离规则和独立
  只读生产回读入口。早先已由 PR #26 合并的 patch 等价遮蔽激活提交未重复引入。消息／MLS
  原子持久化、普通重试密文复用、设备历史、原始附件校验、恢复与创建者权限边界不变。
- 固定入口 `node scripts/publish.mjs --sha e359476ce6bffee85ae355bdf93b34b14a544dc2`
  从独立浅克隆执行，再次核对 GitHub main 与上述最新完整 CI；服务器返回精确 `DEPLOY_OK`，
  外层核对回执并返回 `DEPLOY_VERIFIED`。入口总耗时 95,986ms：预检 5,962ms、核对 main
  1,419ms、CI 复核 4,159ms、隔离克隆 8,163ms、隔离发布及入口回读 76,277ms。服务器阶段
  总计 62 秒，其中获取源码 5 秒、构建镜像 19 秒、维护门 1 秒、冷备份 5 秒、启动及健康等待
  32 秒，分项有嵌套。
- 发布目录 `/opt/quiet-room/git-releases/20260906T090746Z-e359476ce6bf`；已校验冷备份
  `/opt/quiet-room/backups/predeploy/data-20260906T090746Z-e359476ce6bf.tar.gz`。
- 17:09:06 前由本版本新增的固定只读入口取得 `READBACK_OK`，总耗时 2,679ms：版本、批次、
  目录一致且维护标记不存在；应用容器运行且健康，备份容器运行且没有健康探针；两者 Image ID
  与目标镜像均为 `sha256:9bd4fafb734a4c4280511500c0801c576d1969f80b2292c7ce145c85daabb205`。
  HTTPS `ok`／`database`／`storage` 全为 true；首页、`/sw.js`、
  `/assets/app-Co95iXoj.js`、`/assets/app-DJkFQLSk.css` 与 preload 脚本和运行容器产物逐字节
  一致，公开 WebSocket 新连接成功。检查未读取真实消息、附件或备份内容；结构化脱敏证据以
  0600 权限写入发布调用仓库的 `.git/quiet-room-readback/`。
- 本次回读 `admin-enabled=0`、`calls-enabled=0`，后台和 TURN 仍未启用。回读后在不带部署
  配置的独立文档 worktree 对账；该文档 PR 不代表重新部署。修复后真实 iPhone Safari、
  长期运维与独立安全审计边界保持不变。

## 上次线上发布记录（2026-09-06 13:38）

- 日期：2026-09-06（Asia/Shanghai）；`deployed-at=20260906T053714Z`（13:37:14 发布批次），
  13:38:29 独立回读完成。应用版本 `6cce8b017c98cf270729e28bfabae0ee3e551570`，由
  [PR #26](https://github.com/zdaiwmm/shui-IM/pull/26) 于 13:31:13 squash 合并；合并前功能
  提交为 `e579ea806ab6f1e422e1b349a0d1d6b5ccdedce9`。范围仅为遮蔽层长按进入验证页后，Safari
  偶发不弹系统密码验证的问题：遮蔽空闲期预读加密的 v3 保险箱包装，使受信长按完成后能在
  用户激活仍有效时同步发起 WebAuthn；实际解锁仍在生命周期锁内重新读取当前持久记录。
- [PR 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34013956905) 与
  [精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34014192269) 均成功：
  构建、52 个测试文件／419 项单元集成、两组共 23 个浏览器入口、原生通话、凭据扫描、
  生产依赖审计与 `Full application verification`／`verify` 汇总通过。本地最终
  `npm run check:full` 从头通过，浏览器汇总 250.01 秒；覆盖虚拟 CTAP2.1/PRF、Chromium、
  Playwright WebKit、系统表面和生命周期时序。真实 iPhone iOS 27 Safari 的系统验证弹窗
  仍待真机验收，自动化结果不外推为真机通过。
- 固定入口 `node scripts/publish.mjs --sha 6cce8b017c98cf270729e28bfabae0ee3e551570`
  从独立浅克隆执行，再次核对 GitHub main 与该 SHA 的最新完整 CI；服务器返回精确
  `DEPLOY_OK`，外层核对回执并返回 `DEPLOY_VERIFIED`。入口总耗时 88,183ms，隔离发布与
  入口回读 70,328ms；服务器部署总计 56 秒，其中获取源码 4 秒、构建镜像 14 秒、维护门
  1 秒、冷备份 5 秒、启动及健康等待 32 秒，分项有嵌套。
- 发布目录 `/opt/quiet-room/git-releases/20260906T053714Z-6cce8b017c98`；已校验冷备份
  `/opt/quiet-room/backups/predeploy/data-20260906T053714Z-6cce8b017c98.tar.gz`。
- 13:38:29 独立只读回读 `READBACK_OK`，总耗时 2,572ms：版本、批次和目录一致，维护标记
  不存在；应用容器运行且健康，备份容器运行、没有健康探针；两者 Image ID 与目标镜像均为
  `sha256:f05f256b587db9b4cc7d5691b5b93b90be60099ef9302003452f4e23f762e1cb`。
  HTTPS `ok`／`database`／`storage` 全为 true；首页、`/sw.js`、
  `/assets/app-CIOXv7kU.js`、`/assets/app-CmgLvIKV.css` 与 preload 脚本和容器产物逐字节
  一致，公开 WebSocket 新连接成功。检查未读取真实消息、附件或备份内容；
  `admin-enabled=0`、`calls-enabled=0`，TURN 仍未启用。
- 回读后在不带部署配置的独立文档 worktree 对账本记录和状态页；文档 PR 不代表重新部署
  应用。真实 iPhone/Android、长期运维与独立安全审计边界保持不变。

## 上次线上发布记录（2026-09-06 10:32）

- 日期：2026-09-06（Asia/Shanghai）；`deployed-at=20260906T023118Z`（10:31:18 发布批次），
  10:32:18 独立回读完成。应用版本 `f7c2f1daa41c00a107685750d4be62cc892c15f2`，由
  [PR #24](https://github.com/zdaiwmm/shui-IM/pull/24) 于 10:18:09 squash 合并。范围为录屏
  键盘白屏、标题抖动、收键盘时工具栏中途显现与输入区材质一致性；生命周期边界见 D-026。
- [PR 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34005889972) 与
  [精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/34006132442) 均成功：
  构建、51 个测试文件／413 项单元集成、两组共 23 个浏览器入口、原生通话、凭据扫描、
  生产依赖审计与 `Full application verification`／`verify` 汇总通过。本地最终
  `npm run check:full` 从头通过，浏览器汇总 251.43 秒；通话两项与 WebKit 前端生命周期、
  系统表面、回到底部专项另行通过。真实 iPhone/Android 仍未验收。
- 首次切换在停止容器后仍检测到备份容器运行，保护检查拒绝进入冷备份与新容器启动；
  返回 `ROLLBACK_OK`，没有创建该次冷备份或恢复数据。Docker 事件显示停止完成后由回滚
  重启旧容器；10:30:19 独立 `READBACK_OK` 确认旧 SHA、镜像、健康与产物一致。现有证据
  与停止状态同步的瞬时问题相符，但未证明根因。旧版状态明确后对同一 SHA 有界重试一次，
  保留全部安全检查；未改写 root helper，其摘要仍为
  `d95bbe225f593732d68bd555228c8ebf1cad29420988d9c40fb681cbfbaf78fe`。
- 第二次固定入口 `node scripts/publish.mjs --sha f7c2f1daa41c00a107685750d4be62cc892c15f2`
  返回精确 `DEPLOY_OK`、`DEPLOY_VERIFIED`，外层核对成功回执。总耗时 75,669ms，隔离发布
  与入口回读 56,109ms，服务器阶段 42 秒（停止检查通过、冷备份 5 秒、启动健康等待 31 秒）。
- 发布目录 `/opt/quiet-room/git-releases/20260906T023118Z-f7c2f1daa41c`；已校验冷备份
  `/opt/quiet-room/backups/predeploy/data-20260906T023118Z-f7c2f1daa41c.tar.gz`。
- 10:32:18 独立只读回读 `READBACK_OK`：版本、批次、目录一致，维护标记不存在；应用
  容器运行且健康，备份容器运行、没有健康探针；两者 Image ID 与目标镜像均为
  `sha256:a847d5f786daecc972df2988e1148f092de58fa0785308eea4913f8e2810ef41`。
  HTTPS `ok`／`database`／`storage` 全为 true；首页、`/sw.js`、
  `/assets/app-CX7MDSBJ.js`、`/assets/app-CmgLvIKV.css` 与 preload 脚本和容器产物
  逐字节一致，公开 WebSocket 连接成功。本机访问正式来源遭连接重置，因此公开 HTTPS
  与 WSS 探针从生产主机访问正式域名，独立于发布程序执行；不声称异网络客户端验证。
  未读取真实消息、附件或备份内容。`admin-enabled=0`、`calls-enabled=0`。
- 回读后在不带部署配置的独立文档工作树对账发布记录、状态页、D-026 与测试证据；
  文档 PR 不代表重新部署应用。真机与长期运维／独立安全审计边界保持不变。

## 上次线上发布记录（2026-09-05 18:08）

- 日期：2026-09-05（Asia/Shanghai）；服务器 `deployed-at=20260905T100553Z`（18:05:53
  发布批次），18:08 前完成独立回读。
- 应用版本：`2738893b395082504603d4fb0a6360e85d4c4a3f`。由
  [PR #22](https://github.com/zdaiwmm/shui-IM/pull/22) 于 17:59:04 squash 合并；合并前功能
  提交为用户明确批准推送的 `f50ab003fd917d910857adb92074cc0770ed3dfa`，后续仅补充浏览器
  时序、受信点击链路和可移植测试夹具。发布前重新读取并锁定合并后的精确 `main` SHA。
- [PR #22 最终完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33959213106) 与
  [精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33959422621) 均成功；通过
  构建、51 个测试文件／402 项单元集成、两组共 23 个浏览器入口、原生通话、凭据扫描、
  生产依赖审计及 `Full application verification`／`verify` 汇总。此前三次 PR CI 分别暴露
  弹窗 URL 断言过早、异步解密后丢失浏览器用户激活以及 CI Chromium 没有内置 PDF 阅读器；
  产品实现改为在受信点击中先开系统阅读器窗口，随后才解密和校验，CI 阅读器夹具改用
  `text/plain`，PDF/JSON/文本白名单继续由单元测试覆盖，没有用应用内任意渲染器绕过边界。
- 冻结候选最终本地 `npm run check:full` 从头通过，包含 51 个测试文件、402 项测试和
  23／23 个浏览器入口，浏览器汇总 223.86 秒；系统阅读器、文件交互、视频与浏览器专项
  另在本机系统 Chrome 通过。自动化不能替代真实 iPhone/Android 对键盘、蓝牙录音、手势、
  系统验证弹窗和系统文件阅读器的验收。
- 固定入口 `node scripts/publish.mjs --sha 2738893b395082504603d4fb0a6360e85d4c4a3f`
  从独立浅克隆执行；服务器返回 `DEPLOY_OK`，外层核对精确回执并返回 `DEPLOY_VERIFIED`。
  发布入口总耗时 89,010ms，其中隔离发布及入口回读 70,373ms；服务器发布总计 57 秒，
  取源码 5 秒、构建镜像 14 秒、停止容器 1 秒、冷备份 5 秒、启动及健康等待 31 秒、门内验证
  1 秒，分项有嵌套。
- 发布目录为 `/opt/quiet-room/git-releases/20260905T100553Z-2738893b3950`，已校验冷备份为
  `/opt/quiet-room/backups/predeploy/data-20260905T100553Z-2738893b3950.tar.gz`。
- 独立只读生产回读返回 `READBACK_OK`：线上 SHA、批次和发布目录一致，维护标记不存在；
  应用容器运行且健康，备份容器运行且没有健康探针。两者实际 Image ID 均匹配目标镜像
  `sha256:070b2adae9261dca00d69c4e3c1220a6e140cd8d3ed7552c84cc0512a53df363`。
  HTTPS `ok`／`database`／`storage` 全为 true；首页、`/sw.js`、
  `/assets/app-B18y3jGk.css`、`/assets/app-CHnKAoOL.js` 和
  `/assets/modulepreload-polyfill-B5Qt9EMX.js` 与运行中容器产物逐字节一致，公开 WebSocket
  独立连接成功。检查未读取真实消息、附件或备份内容。
- 本次回读 `admin-enabled=0`、`calls-enabled=0`；后台和 TURN 仍未启用。真实 iPhone/Android
  动画手感、键盘/系统表面、蓝牙录音、系统阅读器差异与长期运维/独立审计待办不变。

## 上次线上发布记录（2026-09-05 13:48）

- 日期：2026-09-05（Asia/Shanghai）；服务器 `deployed-at=20260905T054846Z`（13:48:46
  发布批次），13:50 前完成独立回读。
- 应用版本：`434e5203dd0fbe504a1df8d8d8807395571d6755`。由
  [PR #20](https://github.com/zdaiwmm/shui-IM/pull/20) 于 13:43:09 squash 合并；合并前按
  `c4d79e6e01532b3e07a8a5e854e10965f6faf570` 精确 head 锁定。用户明确确认推送、合并和发布。
- [PR #20 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33947701146) 与
  [精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33947937368) 均成功；通过
  构建、50 个测试文件／400 项单元集成、两组共 23 个浏览器入口、原生通话、凭据扫描、生产
  依赖审计及 `Full application verification`／`verify` 汇总。
- 冻结候选最终本地 `npm run check:full` 从头通过，浏览器汇总 200.55 秒；
  `npm run test:calls:e2e` 两项通过，WebKit 底部定位与前端生命周期专项通过。底部按钮专项在
  Chromium/WebKit 均保持键盘、选区和固定标题，22/46 帧动画仅读取目标布局 3 次；双端主流程
  实际长按语音播放器并完成本机删除。自动化不替代真实 iPhone/Android 验收。
- 固定入口 `node scripts/publish.mjs --sha 434e5203dd0fbe504a1df8d8d8807395571d6755`
  从独立浅克隆执行；服务器返回 `DEPLOY_OK`，外层核对精确回执并返回 `DEPLOY_VERIFIED`。
  总耗时 89,531ms：预检 5,621ms、核对 main 969ms、CI 复核 4,396ms、隔离克隆 7,536ms、
  隔离发布及入口回读 71,002ms。服务器发布总计 70,969ms，其中部署 57,644ms；取源码 4 秒、
  构建镜像 14 秒、维护门 1 秒、停止容器 1 秒、冷备份 5 秒、启动及健康等待 31 秒、门内验证
  1 秒，分项有嵌套。
- 发布目录为 `/opt/quiet-room/git-releases/20260905T054846Z-434e5203dd0f`，已校验冷备份为
  `/opt/quiet-room/backups/predeploy/data-20260905T054846Z-434e5203dd0f.tar.gz`。
- 独立只读生产回读返回 `READBACK_OK`：线上 SHA、批次和发布目录一致，维护标记不存在；
  应用容器运行且健康，备份容器运行且没有健康探针。两者实际 Image ID 均匹配目标镜像
  `sha256:020481276435bfc4190322b7713877c73e4b5c34947237130ffc7c1dce5a5470`。
  HTTPS `ok`／`database`／`storage` 全为 true；首页、`/sw.js`、
  `/assets/app-BQYeiGmm.css`、`/assets/app-BNsCx6Ck.js` 和
  `/assets/modulepreload-polyfill-B5Qt9EMX.js` 与运行中容器产物逐字节一致，公开 WebSocket
  独立连接成功。检查未读取真实消息、附件或备份内容。
- 本次回读 `admin-enabled=0`、`calls-enabled=0`；后台和 TURN 仍未启用。真实 iPhone/Android
  键盘帧率、手势、权限、播放器与长期运维/独立审计待办不变。

## 上次线上发布记录（2026-09-05 11:00）

- 日期：2026-09-05（Asia/Shanghai）；服务器 `deployed-at=20260905T030000Z`（11:00:00
  发布批次），11:06 前完成独立回读。
- 应用版本：`98aee2aa7491564d30c9a93cc3869c5f758610a3`。主体由
  [PR #17](https://github.com/zdaiwmm/shui-IM/pull/17) 于 10:27:30 squash 合并为
  `694cc06a1d3a0ce2ab3ca539c2c2bcf525185aa5`；跨字体测试夹具由
  [PR #18](https://github.com/zdaiwmm/shui-IM/pull/18) 于 10:49:49 squash 合并为最终应用
  SHA。用户明确确认推送、合并和发布该仓库；发布前重新读取 GitHub main 并锁定完整提交。
- [PR #17 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33938924491)、
  [PR #18 最终完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33939464149) 与
  [精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33940176339) 均成功。
  最终 main run 约 4 分钟，通过构建、50 个测试文件／400 项单元集成、两组共 23 个浏览器
  入口、原生通话、凭据扫描、生产依赖审计及 `Full application verification`／`verify` 汇总。
- 合并 PR #17 后的 main run
  [33939125012](https://github.com/zdaiwmm/shui-IM/actions/runs/33939125012) 仅因 Linux CJK/emoji
  字体回退下回应气泡后续位移为 4.920654296875px、夹具固定要求大于 8px 而失败；300ms
  FLIP、首帧零跳动、DOM 保留、最终移除和 reduced-motion 均满足。PR #18 把距离阈值改为
  兼容字体行框且仍排除无位移的值，未修改应用代码。其首次执行又在 Playwright 安装阶段
  长时间无进展后取消；同一提交重跑完整成功，没有用基础设施重跑掩盖测试失败。
- 冻结候选本地 `npm run check:full` 通过 50 个 Vitest 文件、400 项测试和 23／23 个浏览器
  入口，浏览器汇总 200.34 秒。夹具修正后定向 `node tests/frontend-lifecycle.e2e.mjs` 通过；
  最终精确 PR/main CI 提供 Linux Chromium 全量证据。自动化不能代替真实 iPhone/Android。
- 第一次固定入口在服务器调用前的隔离浅克隆阶段等待 120,011ms 后超时，总计 137,104ms；
  临时目录未形成 Git 仓库，生产仍为旧 SHA。随后同协议只读 `git ls-remote` 在 5.3 秒内
  成功，确认可安全重试。没有在结果不明或进入非只读阶段后重发。
- 成功固定入口 `node scripts/publish.mjs --sha 98aee2aa7491564d30c9a93cc3869c5f758610a3`
  从独立浅克隆执行；服务器返回 `DEPLOY_OK`，外层核对精确回执并返回 `DEPLOY_VERIFIED`。
  成功入口总耗时 145,543ms：预检 6,143ms、核对 main 819ms、CI 复核 4,694ms、隔离克隆
  61,664ms、隔离发布及入口回读 72,217ms。服务器阶段 58 秒：取源码 5 秒、构建镜像 15 秒、
  维护门 1 秒、冷备份 5 秒、启动及健康等待 31 秒、公开 WebSocket 1 秒；分项有嵌套。
- 发布目录为 `/opt/quiet-room/git-releases/20260905T030000Z-98aee2aa7491`，已校验冷备份为
  `/opt/quiet-room/backups/predeploy/data-20260905T030000Z-98aee2aa7491.tar.gz`。
- 独立只读生产回读返回 `READBACK_OK`：线上 SHA、批次和发布目录一致，维护标记不存在；
  应用容器运行且健康，备份容器运行且没有健康探针。两者实际 Image ID 均匹配目标镜像
  `sha256:1e7aa9cbdeac8089600581d7b7fbe5a63cf6a2a7013b7cdfe74dadfed0f06a6b`。
  HTTPS `ok`／`database`／`storage` 全为 true；首页、`/sw.js`、
  `/assets/app-BQYeiGmm.css`、`/assets/app-BEGaEWXm.js` 和
  `/assets/modulepreload-polyfill-B5Qt9EMX.js` 与运行中容器产物逐字节一致，公开 WebSocket
  独立连接成功。检查未读取真实消息、附件或备份内容。
- 本次回读 `admin-enabled=0`、`calls-enabled=0`；后台和 TURN 仍未启用。真实 iPhone/Android
  的键盘、浏览器工具栏、原生选择器、权限、播放器、后台恢复、手势手感、证书无人值守续期、
  异故障域备份、外部告警和独立安全审计待办不变。耗时、token 成本原因与可执行改进见
  [本次交付复盘](./audit/2026-09-05-mobile-ux-delivery-retrospective.md)。

## 上次线上发布记录（2026-09-05 02:31）

- 日期：2026-09-05（Asia/Shanghai）；服务器 `deployed-at=20260904T183121Z`（02:31:21 发布批次），02:32:39 独立回读完成。
- 应用版本：`e619afb8f9f732839872815c591ea56e454f40e3`，来自 [PR #14](https://github.com/zdaiwmm/shui-IM/pull/14)。功能分支最终提交 `1fbd131264d4eb17914932c94cfabd7035f0ca83`，合并后源码树一致；发布前重新读取 GitHub main 并确认目标 SHA。用户明确要求本轮修改合并并上线。
- [PR 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33905364719) 与[精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33905829879) 均成功；各自通过构建、44 文件／316 项单元集成、两组共 22 个浏览器入口、原生通话、凭据扫描、生产依赖审计及 `Full application verification`／`verify` 汇总。
- PR 首轮 [CI 33904925793](https://github.com/zdaiwmm/shui-IM/actions/runs/33904925793) 仅浏览器第 2 组失败，停止于 Linux Chromium 大字号时间线字形度量断言，没有合并或发布。日志证明气泡无重叠、无溢出且只有一次必要换行；测试原本用固定 5px 判断字形框到稍低元信息基线，跨字体栈误报“增加两行”。改用真实行高区分一行与两行，保留重叠、溢出、短消息同行和对比度断言；Chrome／WebKit 32 种布局复跑及后续两次完整 CI 均通过。
- 本地冻结应用工作树 `npm run check:full` 全程通过（44 文件、316 项、22／22 浏览器入口，浏览器 171.28 秒），`npm run test:calls:e2e` 两项通过；WebKit 系统生命周期、视口／底部、时间线、桌面隐私、语音提交及媒体隐私专项通过。完整映射和真机边界见[验收记录](./audit/2026-09-05-mobile-continuity/README.md)与 [TEST_PLAN.md](./TEST_PLAN.md)。
- 固定入口 `node scripts/publish.mjs --sha e619afb8f9f732839872815c591ea56e454f40e3` 从干净、同步的本地 main 创建隔离发布副本，等待并验证精确 main push CI 后执行。服务器返回 `DEPLOY_OK`，入口返回 `DEPLOY_VERIFIED`；冷备份与公开 WebSocket 验证通过。发布目录为 `/opt/quiet-room/git-releases/20260904T183121Z-e619afb8f9f7`，已验证冷备份为 `/opt/quiet-room/backups/predeploy/data-20260904T183121Z-e619afb8f9f7.tar.gz`。
- 固定入口总耗时 348,456ms，包含约 278 秒的 main CI 等待及校验；实际隔离发布与回读 70,301ms，其中服务器发布 56 秒。服务器阶段：源码获取 5 秒、镜像构建 14 秒、停止容器 1 秒、冷备份 4 秒、启动及健康等待 31 秒、公开 WebSocket 1 秒。分项有嵌套，不重复累加。
- 02:32:39 独立只读回读返回 `READBACK_OK`：线上 SHA、批次、发布目录一致且维护标记不存在；应用容器运行且健康，备份容器运行，两者实际 Image ID 均匹配目标镜像 `sha256:1f5a19ca7f06d12369f0dfeeed46a976106407482a109c3ddcc5e7fa299cc444`。备份容器没有健康探针，未伪称探针成功。HTTPS `ok`／`database`／`storage` 均为 true；首页、`/sw.js`、`/assets/app-B5Z_plEF.css`、`/assets/app-BOtAs6Yy.js` 和 preload 脚本与容器产物逐字节一致。检查未读取真实消息、附件或备份内容。
- 本次回读 `admin-enabled=0`、`calls-enabled=0`；后台和 TURN 仍未启用。发布通过命令行与 SSH 完成，并以临时防休眠保持主机可用；未人为锁屏验收。真实 iPhone 键盘／工具栏／选择器／权限／播放器及手感尚未验收，证书无人值守续期、异故障域备份、外部告警和独立安全审计待办不变。

## 上次线上发布记录（2026-09-05 01:20）

- 日期：2026-09-05（Asia/Shanghai）；服务器 `deployed-at` 为 `20260904T172045Z`（01:20:45，发布批次时间），独立回读于 01:22:02 完成。
- 应用版本：`718f7d2451413a1e5e67e0d56ddeee15acd9f8d6`，来自 [PR #12](https://github.com/zdaiwmm/shui-IM/pull/12)，于 01:09:14 squash 合并到 main；合并前后源码树一致，合并后重新读取 GitHub main 并确认完整目标提交。用户已明确要求本轮修改合并并上线。
- [最终 PR 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33898587091) 对应 `b09701623490ad5df892217a22b4ca4dd97db5d1`；[精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33899412990) 对应上述应用提交。全部构建、311 项单元／集成、两组 21 个浏览器入口、通话专项、凭据扫描、依赖审计及完整汇总任务成功。
- 最终应用代码本地 `npm run check:full` 全程通过（43 个测试文件、311 项、21／21 浏览器入口，浏览器汇总 163.92 秒），两项通话专项及最终 WebKit 生命周期／回到底部／时间线均通过。两引擎各 24 种布局、共 50 张合成截图，关键明暗／大字号／极端媒体／历史按钮已目检，新时间线浏览器错误为 0。首次本地回归暴露冷图恢复偏移，随后发现 WebKit 尺寸观察反馈；修正应用并补充回归后重新通过，未放宽位置断言或过滤错误。详细证据见 [TEST_PLAN.md](TEST_PLAN.md)。
- 发布前两次尝试均止于只读 CI 门禁，没有切换生产：首次尚无精确 main run；等待期间手动触发的 [run 33899335682](https://github.com/zdaiwmm/shui-IM/actions/runs/33899335682) 命中旧测试样例，随后被延迟启动的上述自动 push run 按既有并发规则取消。手动全历史扫描的两项 `generic-api-key` 已通过历史源码在内存中解码逐字节核实：`tests/admin.test.ts`（历史提交 `16b69c802f59558a754c1466508a07d54a51024e`）为 [RFC 6238 Appendix B 公开测试向量](https://www.rfc-editor.org/rfc/rfc6238#appendix-B)，`tests/upgrade-safety.test.ts`（历史提交 `bebcc1090206c1df752000f1092fd2840bb217f9`）为 [RFC 6455 §1.3 公开握手样例](https://www.rfc-editor.org/rfc/rfc6455#section-1.3)。未修改扫描规则、增加豁免或改写历史；手动全历史扫描仍可能报告这些样例。本次最终入口按原门禁验证最新自动 push 的同一 SHA、attempt 及完整应用 job 全部成功，没有回退选择旧绿色运行。
- 固定入口 `node scripts/publish.mjs --sha 718f7d2451413a1e5e67e0d56ddeee15acd9f8d6` 使用默认临时目录完成隔离发布，服务器返回 `DEPLOY_OK`，本地返回 `DEPLOY_VERIFIED`。隔离副本 `/private/var/folders/kx/xvfkgvzn5cb2t23mnc9518kr0000gn/T/quiet-room-publish-VOEPxI` 内 `.git/quiet-room-verified-sha` 与目标完整 SHA 相同。切换前冷备份已校验，维护门与放行后数据保留规则保持原契约。
- 01:22:02 独立回读确认 SHA、发布目录与批次一致，维护标记消失；应用容器运行且健康，备份容器运行，两者实际 Image ID 均为 `sha256:ab2cd6ada1a28a694d40874581bc96a0e899cdc2120a82bba8b3845baacaccf0` 并匹配目标镜像。备份容器没有健康探针，未伪称探针成功。HTTPS `ok`／`database`／`storage` 全为 true，首页、`/sw.js`、`/assets/app-Du49i6Zl.css`、`/assets/app-x_7XInK8.js` 与首页引用的 preload 脚本均和运行中产物逐字节匹配；前后部署及容器身份一致。公开 WebSocket 验证来自固定发布程序。
- 本次实际回读 `admin-enabled=0`、`calls-enabled=0`；后台与 TURN 仍未启用。发布目录：`/opt/quiet-room/git-releases/20260904T172045Z-718f7d245141`。已验证冷备份：`/opt/quiet-room/backups/predeploy/data-20260904T172045Z-718f7d245141.tar.gz`。
- 成功入口总耗时 86,813ms，其中预检 5,315ms、核对 main 1,092ms、CI 核验 4,189ms、浅克隆 7,598ms、隔离发布及回读 68,613ms。服务器阶段 55 秒：拉取源码 4 秒、构建镜像 14 秒、冷备份 4 秒、启动容器及健康等待 31 秒。分项有嵌套，不重复累加；不包含前两次门禁中止，也不作为同条件提速对照。
- 本次范围：气泡内时间／等宽回执、居中本地日期、随输入栏固定间距的回到最新消息按钮，及相关冷图锚点和 WebKit 观察反馈修复；保留上一批次的 24 项交互改进。按钮按真正末条阈值显隐，已知存在更新历史时继续提供分页入口；短距离缓行，保留键盘，主动手势／导航／隐私清理可中断。加密、原始附件校验、设备历史边界、恢复与部署流程未变。
- 服务器 root helper 沿用此前已安装版本，本次未升级。发布通过 Node／Git／GitHub CLI／SSH 完成，期间临时防止自动休眠；未进行人为锁屏状态端到端测试。真实 iPhone Safari 工具栏、键盘、原生权限和播放器手势、跨网络通话及既有运维／审计待办仍需独立验收。随后知识库文档提交不代表应用重新部署。

<a id="release-20260905-0003"></a>

## 历史线上发布记录（2026-09-05 00:03）

- 日期：2026-09-05（Asia/Shanghai）；服务器 `deployed-at` 为 `20260904T160356Z`（00:03:56）。
- 应用版本：`0e6812b571eea2980130a59bd98c876936be1f11`，来自 [PR #10](https://github.com/zdaiwmm/shui-IM/pull/10)，于 00:00:02 squash 合并到 main；合并后重新读取 GitHub main 并确认完整目标提交。用户已明确要求本轮修改合并并上线。
- [最终 PR 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33892320363) 对应 `61b15ad619a2122251b36e6b9711e37d4dee32f5`；[精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33892662497) 对应上述应用提交。全部构建、311 项单元／集成、两组 19 个浏览器入口、通话专项、凭据扫描、依赖审计及完整汇总任务成功。
- 最终应用代码本地 `npm run check:full` 全程通过（43 个测试文件、311 项、19／19 浏览器入口，浏览器汇总 148.51 秒），通话两项专项及 WebKit 生命周期通过；UI 巡检 64 张截图、0 浏览器错误。首轮 PR CI 发现温图测试基线在图片解码前保存锚点，使用延迟图片响应复现后改为等待全部图片 `decode()`；未修改应用代码或放宽锚点断言，修正后 Chrome 与 WebKit 生命周期均通过，随后最终 PR/main 完整 CI 通过。详细证据见 [TEST_PLAN.md](TEST_PLAN.md)。
- 固定入口 `node scripts/publish.mjs --sha 0e6812b571eea2980130a59bd98c876936be1f11` 使用默认临时目录完成隔离发布，服务器返回 `DEPLOY_OK`，本地返回 `DEPLOY_VERIFIED` 并写入精确 SHA 成功回执。切换前冷备份已校验，维护门与放行后数据保留规则保持原契约。
- 00:09:22 独立回读确认目标 SHA、发布目录与批次一致，维护标记消失；应用容器运行且健康，备份容器运行，两者实际 Image ID 均为 `sha256:c3c3d07fd95d0917dc90e4baf422f8e9e070bbee1176147f614b8305d6ecaac3` 并匹配目标镜像。备份容器没有健康探针，未伪称探针成功。HTTPS 健康三项全为 true，首页、`/sw.js`、`/assets/app-8cehm-Du.css`、`/assets/app-Cy4jps8i.js` 与首页引用的 preload 脚本均和运行中产物逐字节匹配；前后部署及容器身份一致。WebSocket 证据来自固定发布程序。初版临时回查脚本因访问备份容器不存在的 `Health` 字段中止，修正只读字段解析后完整通过；没有因此重新部署。
- 本次实际回读 `admin-enabled=0`、`calls-enabled=0`；后台与 TURN 仍未启用。
- 发布目录：`/opt/quiet-room/git-releases/20260904T160356Z-0e6812b571ee`。已验证冷备份：`/opt/quiet-room/backups/predeploy/data-20260904T160356Z-0e6812b571ee.tar.gz`。
- 入口总耗时 249,501ms，其中包含等待精确 main CI 的 165,778ms；浅克隆 7,138ms，隔离发布及回读 70,061ms。服务器阶段 57 秒，拉取源码 4 秒、构建镜像 13 秒、冷备份 4 秒、启动容器及健康等待 32 秒、公开 WebSocket 验证 1 秒。分项有嵌套，不重复累加；不作为同条件提速对照。
- 本次范围：聊天视口跟随和发送平移、回执保留媒体节点、缩小并稳定媒体尺寸、图片缩放与原生视频播放优先、保险箱头部／标签／显隐、水平阻尼录音及取消、精简解锁／菜单／备份页和页面渐变。逐项见 [24 项交互验收](audit/2026-09-04-interactions/README.md)。加密、原始附件校验、设备历史边界、恢复及部署流程未变。
- 服务器 root helper 沿用此前已安装版本，本次未升级。发布通过 Node／Git／GitHub CLI／SSH 完成，期间临时防止自动休眠；未进行人为锁屏状态端到端测试。真实 iPhone Safari 工具栏、键盘、原生权限和播放器手势、跨网络通话及既有运维／审计待办仍需独立验收。

<a id="release-20260904-2209"></a>

## 历史线上发布记录（2026-09-04 22:09）

- 日期：2026-09-04；服务器 `deployed-at` 为 `20260904T140919Z`（Asia/Shanghai 22:09:19），独立回读于 22:11:28 完成。该服务器字段是发布批次时间；实际入口耗时见下文。
- 用户确认的完整应用版本：`b299824888811477f1ed31d223c1ce02be2af4c7`，为 [PR #8](https://github.com/zdaiwmm/shui-IM/pull/8) 合并后的 `main`，包含 [PR #7](https://github.com/zdaiwmm/shui-IM/pull/7) 的 CI／发布提速改动。本地 `main` 已同步此应用版本，整合前快照保留；后续发布记录的文档提交不代表应用再次部署。
- [PR 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33880450265) 与[精确 main 完整 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33880822033) 均通过构建、311 项单元/集成、全部 19 个浏览器脚本、原生通话媒体和界面、凭据扫描、生产依赖审计及 `Full application verification`／`verify` 汇总门。发布前固定入口再次核对精确 SHA 的最新 run、attempt 和完整应用 job。
- 本地固定快照构建、311 项单元/集成、19 项浏览器分段覆盖及两项通话浏览器专项通过。首轮完整浏览器命令的最后一项因合成录音实际仅 460ms、低于 500ms 产品门槛而超时；增加测试录制余量后专项通过，产品发送门槛未改变。此证据不写成单次本地 `check:full` 全程成功；详情见 `TEST_PLAN.md`。
- 本次新增：聊天视频本机静态预览与播放、保险箱照片／视频相册、聊天媒体默认模糊及下拉／隐私遮罩重置、备份页间距与相册柔光加载、键盘／工具栏同步与发送追随，以及长按松手发送、左滑取消、上滑锁定、暂停试听和续录。发布前另修复锁定后旧语音手势绑定继续引用聊天 DOM 的问题，并验证解绑与重新进入。原始附件校验、设备历史边界及既有自动恢复备份能力保留。
- 本次通过 `node scripts/publish.mjs --sha b299824888811477f1ed31d223c1ce02be2af4c7` 发布，未设置临时目录覆盖。服务器返回 `DEPLOY_OK`，固定入口回读返回 `DEPLOY_VERIFIED`；隔离副本 `/private/var/folders/kx/xvfkgvzn5cb2t23mnc9518kr0000gn/T/quiet-room-publish-vfUQ9O` 内 `.git/quiet-room-verified-sha` 与目标完整 SHA 一致。
- 独立回读：`current-sha`、批次和发布目录一致，维护标记不存在；应用容器运行且健康，备份容器运行。两容器完整镜像标签均为本次 SHA，实际 `.Image` 均与目标镜像 `.Id` `sha256:4756be34b681ea165861496d8a5ca72b866a8e3540f9132666e91e158f389c30` 一致，未仅依赖标签文本判断。
- 公网 HTTPS 健康返回 `ok: true`、`database: true`、`storage: true`；首页、`/sw.js` 及首页引用的 `/assets/app-kseOHrus.js`、`/assets/modulepreload-polyfill-B5Qt9EMX.js`、`/assets/app-R1rQoMOZ.css` 均正常返回，且与运行中应用容器的 `dist` 逐字节一致。WebSocket 检查证据来自发布程序的成功验证。本次未读取真实消息、附件或备份内容。
- 发布前已独立审阅并原子安装本次 SHA 中的 root helper，仅增加分段计时；语法、`root:root`、0755 和 SHA-256 `d95bbe225f593732d68bd555228c8ebf1cad29420988d9c40fb681cbfbaf78fe` 均通过，发布后再次回读一致。旧摘要为 `de6890784d837ce6dbb25304421d0536ee6893e4fa3aeda703f95472547dd807`，旧文件保存在 `/opt/quiet-room/deploy-state/helper-before-b299824888811477f1ed31d223c1ce02be2af4c7/quiet-room-deploy`；安装事务持有同一发布锁并在相同文件系统原子替换，普通发布不自更新 helper。
- 发布目录：`/opt/quiet-room/git-releases/20260904T140919Z-b29982488881`。
- 已验证冷备份：`/opt/quiet-room/backups/predeploy/data-20260904T140919Z-b29982488881.tar.gz`。
- 本次固定发布入口实测 **92,582ms（约 93 秒）**，其中入口预检 5,697ms、精确 CI 校验／等待 4,040ms、浅克隆 7,262ms，隔离副本发布及回读 74,457ms。服务器 helper 总计约 **61 秒**：源码获取 5 秒、构建 17 秒、停止容器 1 秒、冷备份 4 秒、启动及等待健康 32 秒、公开 WebSocket 验证 1 秒。服务器计时精度为 1 秒；分项有嵌套且还包含其他阶段，不重复累加。CI 在调用前已成功，这不是开发、审核、CI 运行、helper 安装及后续独立回读的总用时，也不是与旧流程的同条件生产提速对照。
- `admin-enabled=0`、`calls-enabled=0`，后台与 TURN 的既有未启用状态不变。真实 iPhone/Android 通行密钥和恢复、Safari 键盘／录音手感／视频格式、公网通话与切网仍未验收；证书自动续期、异故障域备份、外部告警及独立审计待办未改变。

## 上次线上发布记录（2026-09-04 20:51）

- 日期：2026-09-04；服务器 `deployed-at` 为 `20260904T125135Z`（Asia/Shanghai 20:51:35），独立回查证据记录于 20:55。
- 应用版本：`6753d010d822ef5cb90b2b3d2582d9fd1f7805c6`，为 [PR #5](https://github.com/zdaiwmm/shui-IM/pull/5) 合并后的完整 `main` 提交。功能提交 `16b69c802f59558a754c1466508a07d54a51024e` 经集成提交 `9e4df1b512c5fdba51d59612ff5e2d9f3302be2b` 合入，保留上次聊天和保险箱变更。
- [PR CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33874161493) 与[精确 main 提交 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33874534302) 均通过构建、单元/集成、浏览器及通话专项、凭据扫描和官方 npm 生产依赖审计。精确 main CI 的验证任务于 `2026-09-04T12:50:41Z` 成功结束。
- 集成工作树 `npm run check:full` 通过（241 项单元/集成及完整浏览器回归），`npm run test:calls` 通过（56 项及原生 DTLS、通话 UI）；恢复入口统一为“保险箱”后重新构建并通过 `tests/backup-admin-ui.e2e.mjs`。只读恢复/权限/轮换及发布程序审查未发现明确阻塞，不等于独立安全审计。
- 本次使用 `TMPDIR=/private/tmp node scripts/publish.mjs --sha 6753d010d822ef5cb90b2b3d2582d9fd1f7805c6` 完成发布；服务器返回 `DEPLOY_OK`，固定入口回读并返回 `DEPLOY_VERIFIED`。
- 发布后独立回查：`current-sha` 与上述完整应用版本一致，维护标记不存在；应用容器使用该版本且健康，备份容器使用该版本且运行中。HTTPS 健康检查返回 `ok: true`、`database: true`、`storage: true`；公开首页及其引用的 `/assets/app-bCdxEOq6.js`、`/assets/modulepreload-polyfill-B5Qt9EMX.js`、`/assets/app-DedURc0R.css` 与运行中容器构建产物逐字节匹配，`/sw.js` 返回 200。合成未知备份编号的未认证取件返回 401，未读取真实恢复材料。WebSocket 检查证据来自服务器发布程序的成功结果，不作为新的手工或真机验证。
- 发布前独立原子升级 root helper，来源为集成提交 `9e4df1b512c5fdba51d59612ff5e2d9f3302be2b`；已核对语法、`root:root`、0755 和 SHA-256 `de6890784d837ce6dbb25304421d0536ee6893e4fa3aeda703f95472547dd807`。旧副本保存在 `/opt/quiet-room/deploy-state/helper-before-9e4df1b512c5fdba51d59612ff5e2d9f3302be2b/quiet-room-deploy`；升级时验证旧摘要为 `237c0473b7ff73824f7f6a75afc28c7cf4621a56977419b2fefd3c6afd828ce6`，发布后再次确认新摘要一致。
- 发布目录：`/opt/quiet-room/git-releases/20260904T125135Z-6753d010d822`。
- 已验证冷备份：`/opt/quiet-room/backups/predeploy/data-20260904T125135Z-6753d010d822.tar.gz`。
- 本次上线：前台自动加密备份、QR3 自动定位与本地解密、本机再次通行密钥认证查看恢复码、设备恢复后换码并停用旧在线入口，以及用户主动用新码恢复历史消息或保险箱；手动恢复 JSON 上传/下载入口移除。恢复仍需其他可信活跃设备协助，备份可能滞后，完整边界见 `RECOVERY_BACKUPS.md`。
- 后台代码随版本部署，但 `admin-enabled=0`，`sao.shui.click` 管理入口未启用。未配置管理员文件/环境、该域名的独立证书和 Nginx 站点，服务器解析器也未取得该域名地址；仍需完成 DNS/TLS、密码与真实 Google Authenticator 绑定和后台验收。主站自动备份不依赖后台启用，服务器不托管恢复码。
- `calls-enabled=0`，TURN 仍未启用。真实 iPhone/Android 通行密钥与恢复、iPhone Safari 键盘／工具栏和滑动、公网通话与切网仍未验收。证书自动续期、异地备份与独立审计的既有待办未改变。后续仅发布记录的文档提交不代表应用再次部署。

## 历史线上发布记录（2026-09-04 20:17）

- 日期：2026-09-04；服务器 `deployed-at` 为 `20260904T121727Z`（Asia/Shanghai 20:17:27），独立回查证据记录于 20:19。
- 应用版本：`22f752e1bf711c3d4b9c57abcc03eacdff027c61`，为 [PR #3](https://github.com/zdaiwmm/shui-IM/pull/3) 合并后的完整 `main` 提交。
- [PR CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33871313999) 与[精确 main 提交 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33871665048) 均通过构建、自动测试、浏览器及通话专项、凭据扫描和官方 npm 审计。精确 main CI 于 `2026-09-04T12:16:45Z` 成功结束；其依赖审计首次请求取得有效 npm v2 报告，`total`、`high`、`critical` 均为 0。该结论只对应此次检查，不外推后续漏洞库状态。
- 本地最终 `npm run check:full` 通过（构建、228 项单元/集成测试及完整浏览器回归）；补充的 `frontend-lifecycle.e2e.mjs` 在 Chrome 和 WebKit 均通过，包含连续键盘帧、工具栏收缩、5000 条历史有界读取、锁定清理、62 图分页隐藏及独立桌面上下文的四宽输入布局和真实滚轮检查。小屏、大字号、长计数及桌面明暗截图已检查；详细记录见 `TEST_PLAN.md`，不等于真机验收。
- 本次使用 `TMPDIR=/private/tmp node scripts/publish.mjs --sha 22f752e1bf711c3d4b9c57abcc03eacdff027c61` 完成发布；服务器返回 `DEPLOY_OK`，固定入口回读并返回 `DEPLOY_VERIFIED`。
- 发布后独立回查：`current-sha` 与上述完整应用版本一致，维护标记不存在；应用容器使用该版本且健康，备份容器使用该版本且运行中。HTTPS 健康检查返回 `ok: true`、`database: true`、`storage: true`，首页与 `/sw.js` 均返回 200；首页引用的 `/assets/index-C8DRBFcA.css`、`/assets/index-Cg9c2XDe.js` 与已部署构建产物逐字节匹配。WebSocket 检查证据来自服务器发布程序的成功结果，不作为新的手工或真机验证。
- 服务器 root helper 沿用上次安装版本，本次未升级；独立回查 SHA-256 仍为 `237c0473b7ff73824f7f6a75afc28c7cf4621a56977419b2fefd3c6afd828ce6`。
- 发布目录：`/opt/quiet-room/git-releases/20260904T121727Z-22f752e1bf71`。
- 已验证冷备份：`/opt/quiet-room/backups/predeploy/data-20260904T121727Z-22f752e1bf71.tar.gz`。
- 本次变更范围：聊天键盘坐标同步与滚动开销优化、紧凑状态栏和中性玻璃材质；桌面输入框宽度修复，移除消息旁悬停回复按钮并保留菜单回复；创建者相册改为保险箱，默认模糊、两次点击分别显露与放大、眼睛图标批量显示／隐藏，以及单行等高分类和详情时间展示。
- 普通文件附件、桌面隐私恢复、实时音视频通话应用代码及审计有限重试沿用上次已发布能力，并非本次新增。`codex/session-recovery-backups` 开发分支未合并，也未被本次发布修改；其开发内容未随本次上线。
- 仍未验证：真实 iPhone Safari 的键盘／工具栏同步与流畅度。`calls.env` 未配置、TURN 未启用，公网跨网络可靠性、强制中继、长通话与切网真机验收仍待完成。证书自动续期和异地备份的既有待办见 `OPERATIONS.md`；本次没有宣称这些限制已解除。

## 历史线上发布记录（2026-09-04 17:59）

- 日期：2026-09-04。
- 应用版本：`caf8abeb8e1053631a1ccc0c1264de4a796a00a6`，为 [PR #1](https://github.com/zdaiwmm/shui-IM/pull/1) 合并后的完整 `main` 提交；包含审计重试修复 `e09616fd98a4b80277e05f0d12acb2ac50a24e5a`。
- [PR CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33860011374) 与[精确 main 提交 CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33860468538) 均通过构建、自动测试、浏览器及通话专项、凭据扫描和官方 npm 审计，均取得真实 npm v2 零漏洞报告。
- 本地 `npm run check` 与补充后的审计专项通过；自动测试不等于真机验收。
- 发布前独立原子升级 root helper，来源为提交 `e09616fd98a4b80277e05f0d12acb2ac50a24e5a`；已核对 `root:root`、0755 和 SHA-256 `237c0473b7ff73824f7f6a75afc28c7cf4621a56977419b2fefd3c6afd828ce6`。旧副本保存在 `/opt/quiet-room/deploy-state/helper-before-e09616fd98a4/quiet-room-deploy`。
- 本次使用 `TMPDIR=/private/tmp node scripts/publish.mjs --sha caf8abeb8e1053631a1ccc0c1264de4a796a00a6` 完成发布。
- 服务器返回 `DEPLOY_OK`，本地入口回读并返回 `DEPLOY_VERIFIED`。
- 发布后独立回查：`current-sha` 为上述完整应用版本，`deployed-at` 为 `20260904T095922Z`，维护标记不存在；应用容器为该版本且健康，备份容器为该版本且运行中。HTTPS 健康检查返回 `ok: true`、`database: true`、`storage: true`，首页与 `/sw.js` 均返回 200。WebSocket 检查证据来自服务器发布程序的成功结果，不作为新的手工或真机验证。
- 发布目录：`/opt/quiet-room/git-releases/20260904T095922Z-caf8abeb8e10`。
- 已验证冷备份：`/opt/quiet-room/backups/predeploy/data-20260904T095922Z-caf8abeb8e10.tar.gz`。
- 范围：文件附件、聊天交互修复、桌面隐私恢复、实时音视频通话应用代码及生产依赖审计有限重试已上线。`calls.env` 未配置、TURN 未启用；公网跨网络可靠性、强制中继和真机验收仍待完成，不能由此次部署或浏览器模拟测试推断通过。
- 证书自动续期和异地备份的既有待办仍见 `OPERATIONS.md`，本次没有宣称已修复。
