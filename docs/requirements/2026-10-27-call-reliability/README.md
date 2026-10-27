# 实时视频与语音通话修复 V1

## 身份与确认

- 阶段：用户确认的精确应用已取得 DEPLOY_VERIFIED 与独立 READBACK_OK；本独立文档树仅完成事实对账，不替换应用 SHA 或触发再次发布。
- 规则来源：本机 main `4356531cea264dd01bd9110da90b9ff62cfd7a59` 的 AGENTS／固定流程；已核对最新规则差异。起始基线为 GitHub 实时 main 与本机 origin/main 一致的 `993d01f1750ce598372ca932ad80bae79c5e4e83`，本机 main 较旧。
- 独立分支 `codex/call-reliability-20261027`；本机目录 `.worktrees/call-reliability-20261027`，由本任务新建，跨电脑须重新核验归属与 HEAD。
- 本会话用户在只读审计四项问题及分批方案后回复「确认方案，立即实施，完成后合并发布生产」。没有独立消息 permalink。该确认授权本批实施、必要记录和远端交付；未把未产生的提交视为生产精确 SHA 授权。
- 展示完整应用 `75b01af61eb26ba1cbe5896881c3c354ead3a443`／`2026.10.27.2`、验证与预检结果后，用户回复「确认发布，并告诉我这次具体优化修复了什么问题」，本次精确发布授权来自本会话，无独立消息 permalink。正式 Run 40461354285 的唯一请求 `6853f46d-b4b9-4f7a-9711-d91c3c41b405` 已核对为 deploy，并经既有 production 审核；不修改环境保护或运维配置。
- 无新增页面、文案或关键操作设计；沿用既有接听、挂断、摄像头和隐私清理，原型／视觉流程不适用。

## 范围与边界

1. 区分主叫、已选被叫与其他邀请设备。未选端锁定／访问失效不结束已选通话；响铃时移除自身邀请，最后一台退出才结束。明确拒接仍结束本次呼叫。
2. 修正邀请 Promise 与状态事件作用范围不一致。单台配置验证后掉线不阻止后续邀请；选定后停止剩余邀请；在途邀请的已接听拒绝不推翻获选结果。确定性业务错误不作网络重试，普通重传仍复用原 eventId 与密文。
3. 采集流取得即登记归属，包括原生前台交接及发送器替换等待阶段。挂断／锁定同步停止；迟到结果不能恢复旧通话或污染下一通。
4. 允许受邀被叫在接听准备阶段取消；选定之后仍拒绝未选设备挂断／注入。

保持 MLS 身份、独立设备及历史边界、信令算法与格式、数据库、TURN 配置、部署权限和既有生命周期。语音留言、页面重设计、新中继或基础设施变更不在范围。长期契约由 [CALLS](../../../CALLS.md) 与 [SECURITY](../../../SECURITY.md) 拥有。

## 验收矩阵

| 批次 | 验收 | 验证入口 | 未验证边界 |
| --- | --- | --- | --- |
| 仲裁与取消 | 未选端退出不误挂；单端掉线仍邀请在线设备；已选结果不被后续拒绝推翻；接听前取消及时结束且可再次呼叫 | call-server／call-delivery；真实页面 call-flow | 合成设备不证明物理终端兼容 |
| 媒体归属 | 授权已返回但前台交接未完成、开／切摄像头替换未完成时，挂断／锁定同步停止所有采集 | call-controller；call-flow 原生浏览器轨道及受控异步延迟 | 原生权限弹窗、iPhone 相机切换仍需真机 |
| 最终组合 | 完整应用回归及原生通话、弱网、界面专项无退化；CI 另验证真实 TURN UDP／TCP | check:full、test:calls:e2e、精确 PR／main CI | 真实蜂窝切换、TURN TLS、30–60 分钟公网通话和 macOS 采集未验证 |

## 证据与失败分类

- 修复前：新增定向回归 13 项均失败，分别覆盖服务端 4、媒体归属 3、两种通话类型的跨层邀请 6；保留产品失败，不以原套件存在替代复现。
- 首轮修复后：上述 13 项通过，37 项因该次定向名称筛选未运行；不记为完整套件通过。
- 扩展定向：控制器、跨层邀请、服务端、弱网及信令队列 5 文件／88 项通过；首次受限执行中 8 项本地监听被 EPERM 阻断，受控权限原样重跑成功，没有修改断言。TypeScript 与生产构建通过。
- 跨层夹具采用真实 MLS 配对／成员验证、信令加密、确认队列和服务端仲裁，媒体及 socket 为合成；浏览器补充仍由真实页面与认证 WebSocket 验证。
- 环境：初次 npm 安装因沙箱 DNS 失败，受控权限重试锁定依赖成功；公共 Git 元数据探针同样须受控权限。未改依赖版本或降低安全断言。
- 最终干净源 `264142d4cc50be1767340ae1e3256bb8f6dbe14d` 的完整本地 `check:full` 通过：149 文件／1127 单元集成、86/86 浏览器入口，0 失败／0 未运行，1668151ms。原生 WebRTC、通话视图及 20 个弱网浏览器场景另通过，109012ms；两项等待替换的摄像头回归还核对迟到结果不能影响下一通。
- [PR #431](https://github.com/zdaiwmm/shui-IM/pull/431) 已合并为应用 `75b01af61eb26ba1cbe5896881c3c354ead3a443`／`2026.10.27.2`；源与应用完整文件树同为 `0689fe3e9a66abc8e8ce2ed8cb3c43754c26dbc1`。这份独立记录不替换应用 SHA，不修改版本说明或部署配置。
- [精确 PR CI 40453010499](https://github.com/zdaiwmm/shui-IM/actions/runs/40453010499/attempts/2) attempt 2 成功，包含 Full application verification、真实 TURN UDP／TCP、浏览器和双架构构建。首轮 [WebKit 分片](https://github.com/zdaiwmm/shui-IM/actions/runs/40453010499/job/122019908233) 13 通过／1 失败／7 未运行：`new-room-invite-privacy.e2e.mjs` 捕获未读 Fetch 的原生 access-control 诊断，栈落到 `unread-counter.ts` 的 refresh；未被退出诊断白名单证明。该测试、未读代码、app.ts 与锁文件均未改，历史有同类记录，但根因仍未定位。仅请求一次失败作业原样复验，实际执行完整 attempt 2 并成功；没有改产品或断言，不以绿色抹去原失败。
- [精确应用 main CI 40457899410](https://github.com/zdaiwmm/shui-IM/actions/runs/40457899410) attempt 1 完整成功，push 事件与上述应用 SHA 一致；Full application verification、各浏览器分片、通话／TURN 与同轮双架构镜像均通过。一次本机 watcher TLS 握手超时只恢复同 Run 跟踪，没有重跑 main CI。
- 唯一[固定只读预检 40459706774](https://github.com/zdaiwmm/shui-IM/actions/runs/40459706774)取得精确 PREFLIGHT_OK，外层528212ms含既有production审核等待。请求 `342a557f-d6da-4a9e-a75e-e3014ee9cdfc` 经核对为doctor，仅派发一次，应用与工作流来源均为 `75b01af`；只有一次成功preflight调用，没有生产切换。审核接口的字段筛选报类型不匹配后，只回查原Run及待审核数0，未重复审核或派发。
- 预检实际前版为 `608dfea1e11ba20ddf2456fe380e38ea01230134`；镜像元数据绑定产物12713512874／main CI40457899410／attempt1，到期2026-11-03T05:58:32Z。预检不预载完整镜像，不替代正式发布时字节校验、切换前检查或发布后独立回读。
- 唯一[正式发布 40461354285](https://github.com/zdaiwmm/shui-IM/actions/runs/40461354285)由固定入口核对精确 DEPLOY_VERIFIED；应用始终为获批 SHA，云工作流来源为 `9bed60b536996d462330105dc62b7268bf3e7db3`。云回执2026-10-27T06:30:16.400Z至06:35:18.485Z，外层cloud-publish407328ms含审核等待。只有一次deploy调用；前版为上述 `608dfea`。
- 批次 `20261027T063102Z`；linux/amd64镜像 `sha256:3b2bc5b9c4e66fddbb84fe46d2b5aac7f513b44d09c2cfec5e0c7bbbd90e6f20`，归档摘要 `fa7375685966e88711ee33ef76335ba6fb69e35972acbf8762eb55a36fdb69ce`、210152038字节，绑定精确main CI40457899410／attempt1。
- 首次独立回读2026-10-27T06:35:40.112Z至06:35:41.075Z，962ms，仅因backup starting停在validate-state。应用healthy、获批SHA与镜像一致、维护门absent，TURN运行且探针none。已核对现有备份探针interval和start_period均5分钟；等待窗口后仅续同SHA只读回读，不放宽检查、重启或再次切换。
- 最终独立回读于2026-10-27T06:41:03.280Z至06:41:06.647Z取得 READBACK_OK，3366ms；应用与备份running且healthy，TURN运行且探针none，获批SHA／镜像、HTTPS／数据库／存储、公开与容器产物摘要、新WebSocket均一致，维护门absent。只续同SHA的readback-only，没有重启或第二次切换。
- 本地组合证据已保存到公共Git目录 `quiet-room-deliveries/evidence/call-reliability-20261027/production-summary.json`，包含首次失败和最终成功回读。云端发布与CI由上述远端链接定位；本机证据不会自动跨电脑同步。[发布记录](../../../RELEASING.md#release-call-reliability-20261027)拥有线上批次定位，文档提交不替换应用SHA。真实设备、实际蜂窝／TURN TLS／长公网通话及独立外审没有新增证据；本批资源依固定清理门槛核验，不强删忽略缓存或其他任务资源。
- 提交前检查：仅文本源码、测试、契约及本记录；不提交依赖、构建产物、合成媒体或凭据。版本说明由固定准备工具生成。
