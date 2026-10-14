# V2 生产 helper 与配置审阅（尚未安装）

## 待批准的具体文件

| 仓库文件 | 拟安装固定路径 | 所有权／权限 | SHA-256 |
| --- | --- | --- | --- |
| [quiet-room-deploy](../../../deploy/server/quiet-room-deploy) | `/usr/local/sbin/quiet-room-deploy` | root:root／0755 | `1233f93b41d847c6b7edfbac40cbd55f5aa2d4807c934410213b1ba538066f8a` |
| [compose.startup-health.yaml](../../../deploy/compose.startup-health.yaml) | `/etc/quiet-room/startup-health.compose.yaml` | root:root／0644 | `8f112e610cede4eea34471f1d7f214ddee84e34046b5916b94f62f90742c45e2` |

具体审阅源由本需求PR的最终精确提交确定，安装前必须重新确认完整SHA及上表摘要，不能只用可移动的分支名。这里的文件存在及CI成功均不代表已安装。生产部署配置JSON、凭据、RAM角色、Nginx、应用版本和业务卷没有变更。

## helper 改动

- 保留原三／四参数deploy入口，新增`--stage`与`--activate`，描述协议增加`stagedImageProtocol:1`与`startupHealthProtocol:1`。
- stage仅准备源码和镜像。使用原部署锁、前版CAS、main正向祖先、容量门禁与存储降级保护，增加旧应用healthy、公开健康、CPU负载不超过CPU数、可用内存至少512MiB、最多两份候选回执限制。导入前后旧容器ID／Image ID／StartedAt／running／healthy必须一致。
- stage不运行Compose、不启动应用、不停止旧容器、不关闭维护门、不挂载业务卷、不生成／恢复业务冷备份。镜像导入仍占用Docker层和临时空间，并可能占用CPU／IO；负载不合格直接拒绝，不能为加速绕过容量与数据保护。
- root专属`deploy-state/staged/<SHA>.json`绑定目标SHA、Image ID、归档摘要、前版SHA、独立Git目录和两小时TTL。activate重验当前成功CI、前版、目录干净及镜像身份，并在切换前消费回执。过期／前版变化／目录变化／错误镜像／重复激活拒绝，不自动导入或重发。
- activate后继续原Compose预检、维护门、停写、完整冷备份与校验、切换及HTTPS／WebSocket验收；失败按原安全边界处理。流量开放后不得恢复旧数据。新增代码不调整该边界。
- 两份候选或失败候选目录需独立核验后清理；本次未新增自动删除业务数据或候选资源的规则。

## 可选配置改动

覆盖内容仅为：

```yaml
services:
  quiet-room:
    healthcheck:
      start_interval: 1s
  quiet-room-backup:
    healthcheck:
      start_interval: 5s
```

应用及备份的健康断言、常规探测间隔、超时、重试和启动宽限期从原Compose继承。Docker在启动宽限期内更频繁探测，只有原断言真正成功才healthy。helper检查文件root所有权、普通文件、不可组／其他用户写、固定摘要；Engine>=25及Compose>=2.20.2才启用，缺文件沿用原配置，存在但不合格在维护门前拒绝。回滚同时沿用此覆盖。

## 验证结果与未验证范围

- 本地边界测试：完整归档封存、元数据身份、CRC损坏、旧helper拒绝、tree／attempt变化拒绝、stage前后SHA核对、精确激活命令、证据复用与降级、回读有限等待均已有实际通过结果。
- [PR CI38570523757](https://github.com/zdaiwmm/shui-IM/actions/runs/38570523757)在源`4ac8350`全部通过（helper／覆盖配置摘要与上表一致）：973项、64浏览器入口、双架构镜像、通话／TURN、真实Docker导入／存储故障恢复。Docker使用独立容器／卷和合成数据，检查错误摘要不切换、stage不改数据或容器、错误激活不消费回执、合法单次消费与重放拒绝。后续仅同步并行对账文档，最终提交的CI与合并事实由[PR #302](https://github.com/zdaiwmm/shui-IM/pull/302)拥有；不声称生产实测。
- 既有完整切换／维护门／停写／冷备份／回滚／开放后数据保护、管理员／通话覆盖仍保留全部断言。
- 生产Engine／Compose版本、真实云端stage、生产导入资源开销、实际激活与回读耗时均未在本任务执行。目标时间见[发布效率规程](../../workflows/publish-efficiency.md)，不能替代实测。

## 获得单独确认后的安装边界

安装时按DEPLOYMENT现有原子helper流程：先只读核对当前生产SHA、公开健康、维护门、活动发布、Engine／Compose、旧文件摘要与权限；持有同一发布锁，备份旧helper／覆盖配置；在目标文件同目录写临时文件并核验来源、语法、摘要、root所有权及权限，再原子重命名。安装后独立回读新摘要及协议、原线上SHA／容器／健康不变。此次安装不执行stage、activate、Compose重启或应用发布。

helper／配置安装批准与应用发布批准分开。实际stage须有准备授权，实际activate须用户确认该次完整应用SHA。普通发布工作流不会自行更新root文件。
