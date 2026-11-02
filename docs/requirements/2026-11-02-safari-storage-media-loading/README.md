# Safari 存储恢复、媒体加载与引用语音 V1

## 身份、范围与授权

- 基线与规则来源：5ffd0fc912d96d065bbdea5b23524c9ce7438af3；本机main、origin/main、实时GitHub main开工时一致。独立分支/目录：codex/safari-storage-media-loading-20261102及同名worktree。
- 用户2026-11-02报告iPhone 15 Pro Safari从后台返回两次出现存储错误toast，刷新可进入，原错误文字未知。连接失效是排查假设，未取得真机异常日志，不认定唯一根因。
- 本会话用户明确「确认，两项一起处理，不用做原型，直接实施，验证通过后合并，发布前再确认」，并追加截图要求一起处理带引用语音时间位置。实施阶段授权I/D，免原型与流程图；消息永久定位未提供。交付后用户「确认发布」，并答复「两个环境都发布」，本次P授权固定应用`54c104fb24149683e8392ae7e306bbab072bb904`／2026.11.02.3至production／https://ai.shui.click与tokyo-public／https://mijiu.cloud；后续文档main不纳入应用目标。
- 排除第三方错误收集、数据库降级/清空、协议及密码学变化、旧数据迁移。身份验证、媒体遮蔽、回执及原ID/原密文重试保持。生产只按本次精确授权使用固定入口，分别记录切换与独立回读。

## 实现与验收

| 项目 | 行为、异常边界 | 入口与验证 |
| --- | --- | --- |
| 存储 | 仅明确IndexedDB连接丢失/正在关闭异常，连接获取或纯读取最多3次，间隔100/250ms；后台停止。升级开始后不重试。权限、配额、未知及通用Abort不重试。写事务开始后只执行一次，同步抛错主动中止，保留旧值 | database-recovery.ts、vault.ts；entry-switch-repair中的storage-recovery真实IDB注入及既有vault-lifecycle/MLS回归 |
| 中央胶囊 | 当前语言最长阶段及100%预留统一宽度，图片/视频同为24px高/R12、12px字/环、6px间距/横8px。窄格局部约束省略，隐藏尺寸文字不被读屏读取。最新状态立即替换，取消尺寸变换、400ms保留及旧阶段排队；完成即撤去。失败/重试同节点同槽 | media-capsule.ts、app.ts、design-system.css；media-upload四语言尺寸/即时状态/完成断言及真实下载失败重试，video-upload |
| 引用语音 | 播放器铺满引用撑开的气泡，时间仍距气泡右8px/底6px，同排点击播放和普通语音保持 | voice-messages.css；voice-message-ui补收发两侧/320、390、1440/明暗几何断言及截图 |

设计依据：基线PRODUCT/SECURITY、DESIGN V1.37/V2.3、移动规范媒体状态矩阵及实际样式。用户本次确认覆盖中央胶囊旧宽高FLIP及最短停留，发送角标保持20px方案。原型豁免不等于真机验证。

## 证据与接续

- 存储/入口专项Chromium及WebKit通过，包括读取恢复、持续失败上限、权限/未知不重试、后台停止、应用锁不绕过、已排队写入回滚且只执行一次。
- 中央胶囊新增断言两引擎通过。首轮media-upload在失败后重试残留is-error断言失败；恢复时重建内容并清除错误样式后，两引擎完整专项通过，保留原失败。发送十一语言及整行连续性保持。
- 引用语音新增右8/底6断言在修改前Chromium/320/浅色/发出引用确定性失败。旧用例仅检查同排，未覆盖气泡边缘。修改后专项在Chromium/WebKit通过，每引擎72套布局及收发两侧明暗引用锚点通过。首轮追加几何测量/截图改变后续播放用例的视口状态，造成点击被拦截；将新增几何阶段移到原播放回归之后，原播放/暂停/取消/重试断言保持，完整专项通过。
- 冻结源`9ef494c582faf0159d2e20a0445583d8e1c4db18`，本地构建及159文件/1272项通过。首次`delivery:evidence -- ensure check:full`于outbox-epoch-review的129条队列发送次数上限断言失败，41通过/1失败/49未运行；已接受、接收129条、待发0，发送次数超过266，原完整命令保持failed（1003392ms），不改写为首次通过。
- 同一干净源不改产品、断言或上限，仅原样定向复验一次，16+17队列57次发送，64+65队列254次发送（≤266）；消息全部接受/接收，待发0。此前旧设备候选已有同类差异，首次次数差异根因仍未定位，不能据此断言与本次修改无关。随后使用现有runner导出的selectBrowserScripts/runBrowserScript，从失败项之后顺序接续49/49通过，原41、定向复验1、接续49共91个浏览器入口完成覆盖；不是第二次完整命令全绿。
- [PR #486](https://github.com/zdaiwmm/shui-IM/pull/486)的[精确完整CI41428184898](https://github.com/zdaiwmm/shui-IM/actions/runs/41428184898) attempt1成功：五个浏览器分片、原生通话/TURN、依赖审计、凭据扫描及双架构镜像通过。核对精确head与可合并状态后正常合并为应用`54c104fb24149683e8392ae7e306bbab072bb904`/2026.11.02.3；与冻结源完整文件树同为`b36b541a152dbaa30a5645d58beeed48cfe4d41b`。
- [精确应用main CI41432875130](https://github.com/zdaiwmm/shui-IM/actions/runs/41432875130) attempt1完整成功，head为54c104fb24149683e8392ae7e306bbab072bb904，五个浏览器分片、通话/TURN、依赖审计、扫描、双架构镜像和verify均通过。对账在第二个独立文档工作树进行，不包含部署配置，不因对账替换应用SHA。
- 实组件WebKit截图另以393px视口/DPR3/粗指针复核：等待、下载1%/99%、解密、生成遮罩、生成预览六态同为118.015625×24px；引用语音明暗收发截图检查通过。截图为本机模拟证据，不代表真机，图片不纳入Git。
- 本地及PR脱敏证据保存于公共Git目录`quiet-room-deliveries/evidence/safari-storage-media-loading-20261102/local-and-pr-evidence.json`，保留原失败记录及接续入口清单；截图是合成组件，不含用户原图或真实消息。
- iPhone 15 Pro Safari实际后台故障未复现，桌面WebKit不等于真机。生产发布与独立回读另按下方证据记录，不由自动测试或CI推断。

## 本批生产授权与执行

- 用户在精确应用交付后确认发布至两个环境，授权见本页首段；固定应用SHA保持54c104fb24149683e8392ae7e306bbab072bb904／2026.11.02.3。发布接续时规则与独立文档工作树基线均为f812cd378e67de5d954b8e3b95dbb8fbd4b5371e，本机main、origin/main和实时GitHub main一致；其相对应用提交仅为运维文档变化，不改发文档提交。
- 两环境前版均为18275d5d4b7cb47dcb2ef357c42ded37f7e012a2／2026.11.02.2，只读预检通过。发布准备曾遇GitHub SSH、CI API TLS、隔离克隆及镜像连接重置，均未调用server-deploy。仅进程级复用现有GitHub HTTPS认证、只读Git对象及认证ZIP缓存，不改发布入口／超时／helper／服务器网络；分段传输保留失败并补齐缺失数据，完整ZIP大小、SHA-256和重读认证元数据一致后，仍由固定入口重验CI／manifest／归档。具体摘要与耗时见[本批发布记录](../../../RELEASING.md#release-safari-storage-media-both-20261102)。
- production已取得精确DEPLOY_VERIFIED，819971ms，唯一实际切换，冷备份校验通过；独立READBACK_OK于UTC12:17:51.347完成，8643ms。应用／备份running且healthy，TURN running且探针none、维护门absent，SHA／镜像、HTTPS／数据库／存储、公开及容器资源、新WebSocket全部通过，管理员与通话均开启。
- tokyo-public已取得精确DEPLOY_VERIFIED，1941276ms，唯一实际切换，冷备份校验通过。独立回读与唯一一次同SHA只读重试均在public-artifacts阶段失败（17401ms／16146ms），保持READBACK_REQUIRED。两轮服务器SHA／来源／镜像、应用与备份running／healthy、TURN running／探针none、维护门absent和HTTPS／数据库／存储通过，管理员关闭、通话开启；独立公开与容器资源比较、新WebSocket未执行。未再切换或放宽原检查上限，后续只能续同SHA只读回读及对账。
- 脱敏授权、准备失败、认证镜像、精确发布与独立回读证据保存在公共Git目录`quiet-room-deliveries/evidence/safari-storage-media-loading-20261102/`，独立文档工作树不含部署配置。本地原完整命令失败、真机故障未复现及独立安全审阅缺口仍保留。

东京尚未满足独立回读成功门禁，本批资源保留，未调用清理脚本或把readbackVerified填为true：

| 资源路径／分支 | 状态 | 原因 |
| --- | --- | --- |
| `/Users/zhouding/ss-worktrees/safari-storage-media-loading-20261102`／`codex/safari-storage-media-loading-20261102`，head 9ef494c582faf0159d2e20a0445583d8e1c4db18 | 保留 | 本批独立回读门禁未满足，专属回执已脱敏归档 |
| `/Users/zhouding/ss-worktrees/safari-storage-media-loading-delivery-20261102`／`docs/safari-storage-media-loading-delivery-20261102`，head 017898645467ee7213b63d3b9e685d71e86c4cce | 保留 | 同批发布收尾门禁未满足 |
| `/Users/zhouding/ss-worktrees/safari-storage-media-production-record-20261102`／`docs/safari-storage-media-production-20261102` | 保留 | 当前对账工作树仍在使用 |
