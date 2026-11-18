# AIX 独立连接

`aix.shui.click` 接受 HTTPS 帖子查询和短时播放请求。接入层转发到独立 frps 的回环端口，frpc 对接 mijiu-server 上的 [AIX 服务](../../services/aix-x/README.md)。AIX 服务只向固定的 X API 和媒体来源发请求，使用该进程的本机 Xray HTTP 入口。聊天服务仅在配置查询凭据后启用入口。普通聊天和已有视频导入继续走各自入口。

| 位置 | 服务及端口 |
| --- | --- |
| 公网接入主机 | Nginx 443。独立 frps 17447，仅向允许的 frpc 来源开放。Nginx 通过回环访问 18087 |
| mijiu-server | 独立 frpc 出站连接 17447。AIX 服务监听在 127.0.0.1:18087 |
| 凭据 | 隧道与 HTTPS 查询各用独立凭据。X API 凭据只交给 AIX 服务 |

模板针对 frp 0.72.0 与 Nginx 1.20。私有隧道证书的 SAN 使用 aix.shui.click，服务端持有私钥，客户端持有验证 CA。Nginx 另用浏览器信任的该域名证书。将 frp token 写入各自的 `/etc/aix-frp/token`，限制为服务用户可读。两端各用新服务单元、配置目录、生命周期和权限。先离线运行 `frps verify -c frps.toml`、`frpc verify -c frpc.toml`，安装证书后用 `nginx -t` 核对独立虚拟主机配置。

接入主机先确认承载这种反向连接的权限。阿里云 ECS 的公开使用须知禁止流量穿透服务。当前候选还没有登记该独立域名或接通 mijiu-server，配置可用于允许这种接入的主机。正式接入前需核实 [ECS 使用须知](https://help.aliyun.com/zh/ecs/user-guide/usage-notes)和 [X 开发者协议](https://developer.x.com/en/developer-terms/agreement-and-policy)，再确定公网入口和播放授权。

先保持 `AIX_MEDIA_ENABLED` 关闭，核对本机、边缘回环和 HTTPS 的 `/healthz` 都是 204，再验证查询请求有凭据才可访问。确认视频播放授权和配置后，用两段视频的公开帖子检查点击前无媒体访问、分段请求 206、越界 416、锁屏和切页后上游连接结束。核对同时播放的连接数和两台机器的出入流量、错误率及首帧时间。回滚从移除聊天侧 `AIX_GATEWAY_TOKEN` 开始，然后停止 AIX 独立服务并移除该域名入口。

空闲隧道只有长连接和心跳。播放流量经过公网入口和 mijiu-server，带宽会随有效并发叠加。配置把整条视频隧道的带宽上限先设为 2 MB/s，Nginx 禁用媒体缓冲及临时文件，平时用该服务的响应码和连接统计定位问题。
