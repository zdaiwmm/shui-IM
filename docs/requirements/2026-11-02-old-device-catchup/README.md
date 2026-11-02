# 旧设备大量消息补拉与收发恢复 V1

## 身份、方案与授权

- 阶段：代码及交付记录已合并；获批应用已固定入口发布至两个环境，主站独立回读成功，东京独立回读两次受公开资源下载超时阻断。结果以本页下方及发布记录的实际回执为准。
- 规则来源与起始基线：`7c952acbb87c34c0688be131239a3ebcd9e1aa9b`；开工时本机 main、origin/main 与 GitHub 实时 main 一致且干净。
- 本任务新建分支：`codex/old-device-catchup-20261102`；本机目录 `/Users/zhouding/ss-worktrees/old-device-catchup-20261102`。接续须重新核验 HEAD 和归属。
- 用户报告：主站新增设备连接并大量收发后，旧设备只能刷新分段取得消息且无法发送。
- V1 目标：自动连续补齐在线保留范围内的消息，按消息顺序追赶 MLS 纪元，同步后恢复收发；中断从原子保存的进度续传。
- 范围：HTTP 字节分页、签名保留边界消费、成员同步的暂时失败重连及回归。既有原子持久化、普通重试原 ID／密文、加入前历史权限、真实过期缺口与控制记录失败关闭契约保持。
- 设计材料：非页面修复，原型及视觉流程确认不适用。
- 2026-11-02，本聊天用户确认 V1：「确认，按这个范围修复，验证通过后合并 PR，发布前再确认。」授权本地实施、验证及 PR 合并；没有本次生产发布授权。消息独立定位未提供，不推断其他会话授权。
- 2026-11-02，本聊天用户随后明确「确认，将 2026.11.02.2（18275d5d）发布到两个环境」。Git 核对短 SHA 唯一对应完整应用 `18275d5d4b7cb47dcb2ef357c42ded37f7e012a2`，本次授权 production／`https://ai.shui.click` 与 tokyo-public／`https://mijiu.cloud`，不改发后续文档 main。独立消息定位未提供。

## 根因与实现

`getWindowMessages` 丢弃了服务器 `hasMore`；`consumeWindowBoundary` 消费一页后把未返回的普通记录视作可跳过缺口。签名边界允许跳过确实缺失的普通消息，但字节分页不证明消息已淘汰。三设备真实 MLS／HTTP／WS／加密 IndexedDB 回归在修复前发现：服务器保留 149 条，旧端本机却缺少第 66–107 条。

`getWindowMessagePage` 保留续页标志，校验分页记录顺序，不使用服务端 nextSeq 推进本机游标；原数组接口供既有调用兼容。边界消费者在有下一页且已推进时继续拉取。已在队列却未能落盘的记录不能变成过期缺口。成员同步暂时失败先关闭当前连接，阻止排队的新纪元数据越过未完成的同步，再由现有重连路径续传。签名／身份等安全失败仍停止连接。

这次修复避免继续误跳过记录，不承诺自动恢复已被旧版记为缺口、且相应历史纪元密钥已销毁的消息；不回退密钥或清空本机历史。真实旧端状态未读取，现有安全修复／私有历史恢复仍按原契约执行。

## 验收与证据

| 验收项 | 证据 | 限制 |
| --- | --- | --- |
| 新设备大量收发后旧设备一次进入连续补齐在线记录 | 新增 old-device-catchup 回归，独立三设备，140 条近 4,000 字 CJK 文本、对端回复、删除控制及跨纪元，核对完整序列且无虚假过期范围 | 合成数据，省略界面绘制；非物理设备验证 |
| 中断自动续传，发送恢复 | 同一回归注入一次 HTTP 断连与一次消息／MLS 原子事务中止；无需刷新便追赶并由旧端发送，另两端接收，重开保险库确认持久进度 | 真实旧设备、真实网络未验收 |
| 历史与安全边界保持 | 新端不能读取加入前消息；既有 message-window／MLS 专项及 API 分页顺序验证 | 不增加历史密钥或恢复权限 |

- 修复前确定性失败：本机 `/tmp/old-device-catchup-repro.log`，脱敏结论如上；临时日志不是跨电脑载体。
- 定向单元：API／message-window／MLS，3 文件 41 项通过；新增回归 Chromium 与 WebKit 均通过，包含网络／原子写入中断续传。
- 首轮完整验证源 `9eb7d3c2`：构建通过，159 单元文件中 158 通过；browser-runner 的 4 项入口计数／清单断言因新增回归未同步而失败，浏览器阶段尚未运行。仅更新清单与 90→91 入口计数，保留分片无遗漏与失败统计断言；下一候选重验。
- 干净冻结源 `bffaaea2426c662fa10fa545e1cab8b12b62a514`：本地 `delivery:evidence -- ensure check:full` 通过，159 文件／1272 单元与集成项，91/91 浏览器入口，0 失败／0 未运行，1909628ms；独立 `ensure test:calls:e2e` 通过，97415ms，20 项合成弱网场景，不外推物理设备或真实公网 TURN。
- [PR #484](https://github.com/zdaiwmm/shui-IM/pull/484) 于 2026-11-02T09:34:06Z 正常合并为应用 `18275d5d4b7cb47dcb2ef357c42ded37f7e012a2`／2026.11.02.2。合并树 `e8f313e72ceea238409a4f9a97e5573d6f115744` 与验证源完全相同。
- [精确 PR CI41417202541](https://github.com/zdaiwmm/shui-IM/actions/runs/41417202541/attempts/2) attempt2 完整汇总成功。首次 outbox-epoch-review 中129条全部接受且接收，发送268次超过266上限；同候选本地原断言为235次，云端失败分组仅原样复验一次后通过。未调整产品或断言，首次差异根因未定位；其他首轮成功作业由 GitHub 沿用，不声称重跑了所有成功作业。一次watch查询502、一次状态查询超时后仅恢复同run查询，未另派CI。
- 精确应用 main CI41421734394 首轮 frontend-lifecycle 的反应插入 follower FLIP 动画断言失败（job125198738232，1通过／1失败／21未运行）。该断言在本地及 PR 同树通过，首次差异未定位。随后取消其余在途浏览器分片，首轮最终 cancelled，不能称为首轮完整通过。为满足发布镜像 manifest 对 run_attempt 的严格绑定，仅对同一提交完整原样复验一次（不是只重跑失败组），不修改产品／动画或断言。
- [精确应用 main CI41421734394 attempt2](https://github.com/zdaiwmm/shui-IM/actions/runs/41421734394/attempts/2) 已完整成功，全部浏览器分片、完整应用汇总及双架构镜像均属本轮；通过现有 release-ci 只读校验，远端两个本应用 attempt2 产物未过期且 SHA 一致。代码交付时尚未下载或部署镜像，也未执行生产预检、切换或回读；随后精确授权发布的结果另记下方。
- 材料检查：必要源码与 Markdown，没有凭据、真实消息、二进制或截图／录屏；依赖与构建产物不提交。
- 真机：未验证真实旧设备，也不承诺自动恢复旧版已误跳过且密钥已销毁的历史。
- 发布：精确应用18275d5d已固定入口发布至production／ai.shui.click和tokyo-public／mijiu.cloud，各一次实际切换并取得DEPLOY_VERIFIED及冷备份校验。主站独立READBACK_OK于UTC10:43:39.775完成，3163ms；东京独立回读及一次只读重试均在public-artifacts超时（14561ms／28322ms），保持READBACK_REQUIRED；一次30秒补充下载诊断也超时，不能代替独立成功。两环境服务器SHA／镜像与HTTPS健康通过；东京独立资源比较、新WebSocket未执行，不再切换或自动第三次回读。详见[本次发布记录](../../../RELEASING.md#release-old-device-catchup-both-20261102)。脱敏授权、准备失败、认证缓存、发布与回读证据保存在公共Git目录`quiet-room-deliveries/evidence/old-device-catchup-20261102/`。
- 对账：独立无部署配置工作树`docs/old-device-catchup-production-20261102`，基线5ffd0fc9；对账时本机main／origin/main／GitHub main均已前进3733af5c，规则无变化，2026.11.02.3不纳入本次生产授权。仅对账三份既有文档，不发布文档main。
- 清理：东京未取得独立READBACK_OK，固定清理门禁未满足，本批资源全部保留；不填readbackVerified=true，不执行清理apply，不触碰其他任务或旧PR。

| 本批资源路径／分支 | 状态 | 原因 |
| --- | --- | --- |
| `/Users/zhouding/ss-worktrees/old-device-catchup-20261102`／`codex/old-device-catchup-20261102` | 保留 | 东京回读门禁未满足；另含忽略的node_modules／dist及专属Git证据 |
| `/Users/zhouding/ss-worktrees/old-device-catchup-delivery-20261102`／`docs/old-device-catchup-delivery-20261102` | 保留 | 东京回读门禁未满足；交付文档晚于应用，不把它冒记为已发布代码 |
| `/Users/zhouding/ss-worktrees/old-device-catchup-production-record-20261102`／`docs/old-device-catchup-production-20261102` | 保留 | 当前对账活动目录，且东京回读门禁未满足 |
