# 跨设备发布与独立回读

2026-11-09 用户在实施会话确认跨设备发版方案。基线 e5297664，分支 codex/cross-device-publish。范围为发布工具，无产品页面变更。每次实际部署仍需确认应用的完整 SHA 和目标。

GitHub Actions 中选择 **Release and verify Quiet Room**，选择 main、完整应用 SHA、站点以及 doctor、readback 或 deploy。both 串行执行，逐站查看同一运行的日志和证据。切换结果不明时，另发该站点的 readback，只核验同一 SHA。复用已有单写者组、生产审核及发布脚本。原有 CLI 和在途发布保持兼容。

主站沿用阿里云短期身份。东京需要 production 环境变量 TOKYO_LIGHTSAIL_ROLE_ARN，对应 AWS 角色的信任限于本仓库 production 环境、受保护的 main 和 sts.amazonaws.com 受众，权限限定东京目标实例的 lightsail:GetInstanceAccessDetails。东京既有防火墙仅允许维护源 /32。仓库变量 TOKYO_RELEASE_RUNNER 指定具备已授权固定出口的一次性 Linux 执行机标签，基于 GitHub Ubuntu 镜像且提供 AWS CLI、Node、Git、gh 和 SSH。需维护方核实出口；变更网络规则、云授权或新增付费执行机另行确认。执行机须能访问该实例的 SSH；使用 Lightsail 签发的临时证书及返回的主机公钥。不要复制个人私钥。环境审核针对本次运行所列 SHA 和目标。

启用验收先对正在运行的精确 SHA 分站执行 doctor 和 readback。记录 GitHub 运行链接及逐站结果，再安排经确认的生产切换。未配置云角色或连通性未知时保持待验。
