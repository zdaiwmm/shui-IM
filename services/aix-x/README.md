# AIX 帖子与视频服务

`index.mjs` 是部署在 mijiu-server 上的独立 Node HTTP 服务。复制 `index.mjs` 和 `x-api.mjs` 即可运行，应用代码和运行时数据目录均不需要随服务部署。使用 Node 24.14 或以上版本，通过 `node --env-file=/etc/quiet-room/aix.env index.mjs` 启动。该服务只监听 `127.0.0.1`，由独立隧道连接 HTTPS 入口 `aix.shui.click`。隧道和入口示例见 [deploy/aix](../../deploy/aix)。

| 环境变量 | 用途 |
| --- | --- |
| `AIX_PORT` | 本地监听端口，默认 `18087` |
| `AIX_PUBLIC_ORIGIN` | 播放地址的 HTTPS 来源，线上填写 `https://aix.shui.click` |
| `AIX_GATEWAY_TOKEN` | 聊天后端与 AIX 共用的随机密钥，使用 32 至 256 个 base64url 字符 |
| `AIX_XRAY_PROXY` | mijiu-server 上的回环 Xray HTTP 入口，例如 `http://127.0.0.1:10809`。支持该入口专用的代理凭据。设置后，仅本进程的封面和视频请求经该出口访问 |
| `AIX_MEDIA_ENABLED` | 确认媒体使用权限后设为 `true`，启用视频和封面。默认只查询文本 |

- `GET /healthz` 返回 `204`，仅表明本地监听与隧道可达。
- 聊天后端通过 `POST /v1/x/posts/lookup` 查询公开帖子，传入帖子 ID、操作类型及必要时的视频 ID。AIX 直连 FxTwitter 公开接口，只提交帖子 ID，无需 X API Bearer Token。查询全文和申请播放时重新查询帖子，媒体按原顺序返回。不可用或标记敏感的帖子回退至原链接。
- `GET /v1/x/media/<ticket>` 使用仅限所选视频的 15 分钟随机票据。票据保存在进程内存，服务重启后失效。播放器支持 MP4 直流及单段字节请求，优先使用不超过 2.5 Mbps 的清晰度。单个视频上限为 768 MiB，服务同时承载 8 路媒体请求，单票据最多 4 路。
- 保持入口的代理缓存、响应临时文件和媒体访问日志关闭。请求路径含有短期票据。媒体以流的形式经过内存，客户端断开会停止上游请求。

仓库根目录运行 `npm test -- services/aix-x/relay.test.mjs`。测试从监听端口请求实际 HTTP 路由，FxTwitter 和媒体 CDN 使用本地模拟。
