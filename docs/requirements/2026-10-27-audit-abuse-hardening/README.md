# 审计整改 V1：滥用防护与当前规则

## 身份、范围与授权

- 2026-10-27 用户在审计复核及整改方案V1之后明确要求「按照你的方案执行」。来源为本任务会话，未提供独立消息permalink。
- 第一批范围：可信来源地址、四条写路由限流、后台按来源认证额度及密码计算并发、畸形路径400、当前格式与安全规则摘要。用户已授权实施及按仓库持续交付流程完成PR／CI／合并；生产仍须确认精确提交。
- 第二批手工备份与隔离恢复演练单独交付。用户随后明确选择「先完成代码和隔离演练，外部渠道／存储另定」；外部告警渠道和不可变存储不在本轮实施范围，未声称已经建立。
- 不涉及正式页面，无需页面原型／流程图；排除新密室自动销毁、遗留数据补TTL、密码学／恢复协议变更、界面修改和整体路由重写。
- 规则及起始基线：本机main、origin/main与GitHub实时main均为 `e6dfcedccedd8b8adcea9a97224478c23fd59578`；已读取该版AGENTS、固定流程、隔离门槛及维护规则。
- 独立任务树 `/Users/zhouding/ss-worktrees/audit-abuse-hardening-20261027`，分支 `codex/audit-abuse-hardening-20261027`，本会话新建；跨电脑接续需重新核对路径／HEAD／状态。未读取或复制生产凭据、消息、备份。

## 实现与边界

- `server/request-limits.mjs`统一可信代理地址解析、规范化及有界固定窗口；只接受可信直连代理传来的单IP，链式／畸形值回退实际连接地址。nginx主站四处XFF均覆盖为 `$remote_addr`，已有edge配额保持。
- 原应用配额接入有界存储；活动桶不因大量新键而被驱逐。过期惰性清理；容量满对新键拒绝，既有未用完额度继续可用。进程重启重置、NAT共享和分布式可用性风险保留。
- MLS事件／welcome、附件complete与push DELETE采用来源和设备双层预算；设备维度绑定认证所得room/device/operation，不相信请求体自报身份，换IP不重置。阈值及错误行为由SECURITY拥有；拒绝先于昂贵操作，既有签名／撤销复查／幂等保持。
- 后台登录与删除会话二次验证共用按来源8次／分钟额度；保持单次scrypt计算在途，繁忙503与额度429分开，均给出Retry-After；原TOTP持久防重放和会话／CSRF／同源验证保持。
- URL解码只捕获路径URIError并返回400/INVALID_PATH，其他内部错误仍走原映射和日志。
- PRODUCT与SECURITY增加当前适用摘要，保留历史依据；明确24小时链接不等于房间销毁、旧安全码路径、新应用锁与独立归档口令的区别。

## 验收与证据

| 验收项 | 验证入口 | 当前证据 |
| --- | --- | --- |
| 代理信任、伪造链／非法值、等价IP、容量与到期恢复 | `tests/request-limits.test.ts`、`tests/abuse-controls.test.ts` | 定向通过（新增专项12/12；既有admin、push及部署均通过） |
| 四路超额先拒绝、跨IP不可绕过、设备和操作独立 | `tests/abuse-controls.test.ts` | 定向通过（新增专项12/12；既有admin、push及部署均通过） |
| 真实签名welcome／event重复、九附件完成重试、签名退订 | `tests/abuse-controls.test.ts` | 定向通过（新增专项12/12；既有admin、push及部署均通过） |
| 后台跨来源、到期、删除二验、TOTP重放及单并发 | `tests/admin-abuse.test.ts`、`tests/admin.test.ts` | 定向通过（新增专项12/12；既有admin、push及部署均通过） |
| 畸形URL无500／错误堆栈、代理配置保留edge限制 | `tests/abuse-controls.test.ts`、`tests/deploy-script.test.ts` | 定向通过（新增专项12/12；既有admin、push及部署均通过） |
| 完整应用与文档 | `npm run delivery:evidence -- run check:full`、`scripts/check-docs.mjs` | 待冻结后执行 |

本机没有nginx／Docker可执行程序，尚未执行真实nginx配置解析；静态配置断言不能替代安装后的代理链验收。本批无生产授权、代理配置安装、生产流量测试、真机或独立外审证据。

## 当前阶段与接续

实现与定向验证已完成，准备冻结及完整验收。新增后台测试首轮因fetch未保留测试Host返回404、未进入认证；改用项目既有node:http测试方式后原断言全部通过，没有修改产品Host校验。语法与TypeScript检查通过。

提交、PR、精确CI和合并结果分别由Git与PR记录拥有。冻结前准备唯一发布版本，验证结果绑定最终文件树，不把本机通过当作已发布。需求与概要只同步必要事实，提交前检查材料、格式、链接及凭据误纳入。
