# Quiet Room 当前状态

生产证据快照：2026-09-04 18:02（Asia/Shanghai）。本页用于接手定位，不代替实时 Git、CI 或生产回读；后续文档提交不代表应用重新部署。

## 已发布版本与范围

正式来源为 `https://ai.shui.click`。已部署并回读确认的完整应用提交为 `caf8abeb8e1053631a1ccc0c1264de4a796a00a6`，来自已合并的 [PR #1](https://github.com/zdaiwmm/shui-IM/pull/1)。本次包含：

- 普通文件附件、混合文件选择、加密续传、下载完整性验证及相册“图片 / 文件”分栏。
- 聊天键盘与滚动、在线状态布局、回应、引用层级和未读计数修复。
- 普通桌面浏览器的 30 分钟无操作期限及页面内存恢复；移动、平板和 PWA 保持严格锁定策略。
- 双人实时音视频通话的应用代码与加密信令；生产中继配置及公网真机验收仍待完成。
- npm 官方生产依赖审计的有限重试；高危漏洞、无效报告和重试耗尽仍阻断发布。

产品与安全契约见 [决策页](./decisions.md)、[SECURITY.md](../../SECURITY.md) 和 [CALLS.md](../../CALLS.md)。云端自动备份及通过恢复码取件已在下述独立功能分支实现；不属于上述生产证据。

## 验证与生产证据

- [PR CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33860011374) 与 [精确应用提交的 main CI](https://github.com/zdaiwmm/shui-IM/actions/runs/33860468538) 均通过构建、单元/集成、浏览器回归、通话专项、凭据扫描和依赖审计。审计取得真实 npm 官方零漏洞报告；该结论只对应当时检查，不外推后续提交或漏洞库变化。
- 固定发布入口返回 `DEPLOY_OK` 与 `DEPLOY_VERIFIED`。独立回读确认应用提交一致、维护标记解除、应用容器健康、备份容器运行；HTTPS 健康、首页和 Service Worker 响应正常。WebSocket 检查来自发布程序的成功验证。
- 服务器发布程序已在应用切换前独立原子更新；发布前冷备份已校验。完整摘要、目录、时间和验证明细集中保存在 [发布记录](../../RELEASING.md#本次线上发布记录)。
- 浏览器自动测试使用虚拟认证器和合成媒体，不等于真实 iPhone/Android、Safari 或公网网络验收。

## 仍需处理的事项

- **通话中继与真机验收**：`calls.env` 未配置，`calls-enabled=0`，TURN 未启用。客户端仍可尝试直连；公网/蜂窝跨网络、强制中继、长通话与切网可靠性尚未验证。详见 [CALLS.md](../../CALLS.md) 与 [DEPLOYMENT.md](../../DEPLOYMENT.md)。
- **macOS 发布路径**：临时目录别名可能使发布子程序静默退出。使用 `TMPDIR=/private/tmp` 运行同一固定入口已完成本次发布，源码路径规范化仍待修复；处理方法和成功判据见 [RELEASING.md](../../RELEASING.md)。
- **既有运维待办**：证书自动 DNS 续期、异故障域不可变备份与外部告警尚未完成；本次发布未改变这些配置。详见 [OPERATIONS.md](../../OPERATIONS.md)。
- **公开高安全门槛**：独立审计、独立可信客户端、真机矩阵及运营要求仍受 [PRODUCTION_SECURITY_GATE.md](../../PRODUCTION_SECURITY_GATE.md) 阻塞。

## 自动恢复备份独立分支（2026-09-04 20:25，Asia/Shanghai）

- 分支：`codex/session-recovery-backups`，基于 `9007f207b20239db105b5451c3afdcf13a349319` 创建独立 worktree。用户要求隔离原目录中并行功能，完成后再合并；本任务未合并、推送或部署。分支提交以 Git 为准，不将上述旧生产快照冒充当前生产回读。
- 实现：QR3 自动定位密文备份、本机加密保管码并再次通行密钥验证查看、MLS 替换后持久化新码并转移全部历史归档、旧在线取件失效、用新码主动恢复消息/相册、相册独立存储、移除手动文件恢复 UI。安全边界与旧 QR2 迁移限制见 `RECOVERY_BACKUPS.md` 和 D-012。
- 后台：`sao.shui.click` 会话/设备/备份元数据、密码加 TOTP、CSRF、重新验证清理、可恢复的附件清理队列。没有恢复码托管；后台凭据配置在数据卷之外，持久 Compose 覆盖及维护门已接入发布 helper。
- 本地自动测试通过：`npm run check:full`（241 项单元/集成及浏览器套件）；随后新增的 `node tests/backup-admin-ui.e2e.mjs` 也通过并加入浏览器入口。`npm run test:calls` 通过（56 项测试及原生 DTLS/通话 UI）。修改最终表单样式后单独复跑后台/备份 UI 并检查截图，未把截图中的示意码当作真实材料保存。
- 未验证：该分支 CI、独立审计、真实 iPhone/Android/Google Authenticator 扫码、生产 DNS/TLS/挂载和维护门、容器构建与灾备演练。后台配置生成脚本、Nginx 与 root helper 仍须在未来获授权发布时按部署文档安装；仅提交文件不会启用线上后台。
- 最终恢复保护补测通过：只有服务器明确确认请求过期才允许丢弃等待中的替代设备身份；网络状态不明确时保留本机材料。最终构建、`cloud-backup-lifecycle.e2e.mjs` 和完整 `browser.e2e.mjs` 重新通过；未在该补丁后重复无关专项。

## 接手时复核

重新读取 `git status`、本地 HEAD、GitHub main、目标 CI 和实际生产 SHA；文档版本与已部署应用提交可以不同。后续发布仍须取得当次授权、确认完整目标提交并遵循 [RELEASING.md](../../RELEASING.md)，不能把本次提交号当作新一次发布授权。
