# 审计整改 B：开发依赖

用户确认四项修复方案后要求完整实施、验证、合并并发布两个环境，本批属于已授权范围。独立工作树`audit-remediation-b-20261107`、同名codex分支，基线`bbe102b3bd0cff712f9366f614b4c35d3705ee3c`；实际路径`/Users/zhouding/ss-worktrees/audit-remediation-b-20261107`，初始干净。A/C/D独立交付，最终组合验证和精确SHA发布确认仍适用。

Vite 7.3.6→7.3.7，Vitest 3.2.7→4.1.12，postcss范围内的source-map-js 1.2.1→1.2.2；@vitest/mocker随官方Vitest固定到4.1.12，旧tinypool路径移除。未使用audit fix --force、非兼容override或不必要5.x升级。运行环境Node24.14.1满足版本要求。

依据：[Vitest 4迁移](https://v4.vitest.dev/guide/migration.html)、[Vitest安全公告](https://github.com/vitest-dev/vitest/security/advisories)、[Vite安全公告](https://github.com/vitejs/vite/security/advisories/GHSA-9jrq-w75r-8gcw)及npm官方注册表精确版本元数据。

## 验证

- 官方registry首次审计：5个受影响依赖节点（moderate1/high2/critical2）；顶层升级后剩source-map-js 1项，按已有兼容范围刷新后完整与omit=dev审计均0。
- 初次check构建通过，1302/1304单元通过。迁移后Intl.DateTimeFormat构造函数spy未按旧行为调用原构造函数，测试替身改为显式构造真实对象，原“不重复格式化”断言保留；另一项delivery-tools在与A完整门禁并行时超过原5000ms，未提高超时。
- 单worker定向复验chat-render、delivery-tools：18/18通过，5.47秒；两类首次失败均保留日志。完整验证待冻结候选执行，避免同时运行两套高负载门禁。
- 原始审计与日志在`.artifacts/audit-remediation`，不提交node_modules、构建产物或原始大型日志。尚无B批完整通过、合并或上线结论。

源候选`0d7d64fec33883ae6a9b7393d14f9c8994dece8b`已推送为PR515。本地冻结完整套件正在运行。CI42272470160首轮frontend-lifecycle回应FLIP边界失败，原断言未改，一次定向作业复验通过；Native call media作业两次都在Ubuntu字体apt下载时达到10分钟上限，尚未进入测试。保存两次安装日志，不第三次盲重试，不放宽测试或安装超时。源改动已经纳入最终组合，由新的精确组合full CI及本地完整门禁统一放行，PR515不独立绕过检查合并。
