# Quiet Room 固定发布流程

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
默认临时目录完成真实路径规范化、隔离发布和成功回执验证，见[本次线上发布记录](#本次线上发布记录)。

该入口依次执行：只读预检 → 核对 GitHub main → 等待该提交完整 CI 成功 →
新建独立浅克隆发布副本（仅 main，`--depth 1`）→ 再次核对提交 →
调用已有服务器发布程序 → 回读线上提交号并保存隔离副本内的成功回执。
不会把本地未提交文件复制过去，也不会切分支、stash、重置或覆盖开发工作区。
GitHub main 在准备期间变化时停止，不擅自改发新版。

本地待合并改动仍须先审阅、测试并合并；该入口只发布已合并内容，不自动合并。
已经完成且失败的 CI 不会自动重跑，先读取失败原因再处理。

## CI 与分段耗时

发布等待的轮询间隔为 5 秒。发布入口和隔离副本都会检查精确 `main` SHA 的
`.github/workflows/ci.yml`，只接受 `push` 或 `workflow_dispatch` 事件中最新的 run，
并要求该 run 已完成且成功、同一次 attempt 的 `Full application verification`
job 已完成且成功。查询读取所有分页；取回 job 证据后再次核对最新 run 和 attempt，
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
完整 CI，但不会自动触发或重跑它。若 main 已变化，先重新审阅并取得新目标版本的
发布授权；手工运行 CI 本身不构成发布授权。

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
- 2026-09-04 已按 `DEPLOYMENT.md` 独立审阅并原子更新 root 发布程序，当前版本包含可选通话中继、后台持久 Compose 覆盖及分段计时支持；精确提交、摘要和旧副本路径见[本次线上发布记录](#本次线上发布记录)。普通应用发布不会自动替换它，后续发布仍需核对安装版本。
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
