# iPhone 真机调试

固定入口为 `tools/iphone-debug/scripts/device.py`，技能源在
[`SKILL.md`](../../tools/iphone-debug/SKILL.md)。工具独立于网页构建，无常驻录屏、
无生产注入、无第三方上传，也不会重启现有局域网服务。

## 一次安装

使用 Python 3.12+ 执行（系统 `python3` 版本不足时选用已安装的新版解释器）：

```sh
python3 tools/iphone-debug/scripts/device.py setup
python3 tools/iphone-debug/scripts/device.py install-skill
```

依赖固定在 `requirements.txt`；默认运行环境为 `~/.cache/iphone-debug/venv`，
可用 `IPHONE_DEBUG_RUNTIME` 指定其他持久目录。工具调用开源 pymobiledevice3
11.8.0（GPL-3.0-or-later）、PyAV 18.1.0 与 Pillow 12.3.0，不把依赖源码打包进产品。
主依赖版本固定，传递依赖由 pip 解析；升级后需要重新做真机验证。

`install-skill` 将完整工具复制到 `$CODEX_HOME/skills/iphone-debug`（未设置时使用
`~/.codex/skills/iphone-debug`），拒绝覆盖已存在的技能；更新时先比较已安装版本与源码，
在确认差异归属后同步本任务文件。也可使用官方当前文档列出的 `~/.agents/skills`。
本机安装位置应在
交付回执中记录，不能在工具中硬编码某台电脑、UDID、临时工作树或局域网主机名。
[官方技能发现说明](https://learn.chatgpt.com/docs/build-skills)支持个人技能与符号链接；
若新技能未出现，重新打开 Codex。另一台电脑需要单独安装依赖和技能。

## 常用入口

```sh
python3 tools/iphone-debug/scripts/device.py doctor
python3 tools/iphone-debug/scripts/device.py doctor --origin https://YOUR-HOST:5173 --ca /absolute/rootCA.pem
python3 tools/iphone-debug/scripts/device.py screenshot --output /private/tmp/iphone-shot-UNIQUE
python3 tools/iphone-debug/scripts/device.py record --seconds 30 --output /private/tmp/iphone-record-UNIQUE
python3 tools/iphone-debug/scripts/device.py cleanup --output /private/tmp/iphone-record-UNIQUE
```

输出目录必须全新，以免覆盖其他采集；权限为仅当前用户可访问。多个 USB iPhone
必须显式传 `--device`，只有一台时自动选择。保留设备解锁和 USB 信任；原生服务需要
开发者权限时按实际错误开启 Developer Mode。Safari DOM 检查另需网页检查器；USB
连接成功不代表页面已可检查。iOS 27 未实现锁定查询时记为 unknown，不误报为连接失败。
`doctor` 的 HTTPS 检查在 Mac 端完成，不证明 iPhone 已信任证书。

录制等待 `CAPTURE_READY` 后开始复现，默认 30 秒，范围 1..180 秒；每秒发送 RTCP
反馈保持画面，连续 8 秒无完整视频帧或超过 256 MiB 停止并报错。正常完成会自动生成 MP4、
`capture.json`、`timing.ndjson` 和 `decode.json`。录制被取消时仍尝试关闭原生流，
数值回执标为 incomplete；保留的完整 RTP 包可用 `decode --output /absolute/run` 手动解码。
异常终止或拔线不保证设备端即时停止，需核验回执，不能把 incomplete 记为完成。

自动开合键盘：先取得并查看当前截图，核实 Safari 的目标页面、来源以及安全空白落点，
再向 `record` 传 `--keyboard X,Y,X,Y --target-verified`（至少录制 6 秒）。四个坐标是 0..65535 范围的
输入框和空白点击位置，由本次截图换算；该标记是操作者核实声明，不是工具自动识别页面。
仅重复点击，不输入、删除或发送文字。不要复用旧任务的绝对坐标。

## 数值探针与证据

需要 DOM 对照时，通过已连接的网页检查器在已核实的本机开发页执行
`tools/iphone-debug/scripts/viewport-probe.js`。它采样 30 秒、最多 10000 行，
自动移除事件监听；可调用 `window.__iphoneDebug.stop()` 提前停止。
结果在 `window.__iphoneDebug.result`，包含字段名、事件编号、起始墙钟、相对毫秒、
标题/列表/输入栏矩形与输入长度，不包含文字或消息内容，不向网络发送。
页面重载会丢失内存结果，必要时提前保存数值 JSON。探针有测量开销，必要时对比不带探针的录制。

RTP 时间戳按此次已验证的原生流 24 kHz 解码，墙钟映射保存在 timing 中；其他系统或流
格式需重新验证，不保证跨版本。MP4 保留时间位置，将变更后的分辨率缩放到首帧尺寸；
decode 回执报告分辨率变化、解码错误和序列不连续。零丢包不代表零编码伪影：灰块、
拼接或分辨率变化不能单凭一帧归因于网页。DOM 矩形稳定也不能证明原生合成层稳定。

原始媒体可能包含通知和页面私密内容；只保留完成定位所需的短片，不提交到仓库。
`cleanup` 仅删除 manifest 白名单中的录屏/截图，保留数值证据和未知文件。
验证工具逻辑：`python3 -m unittest discover -s tools/iphone-debug/scripts -p 'test_*.py'`。
数值探针的字段与取消验证：`node --test tools/iphone-debug/scripts/test-probe.mjs`。
桌面浏览器结果、工具连接成功、真机操作验收、CI 和生产是不同证据层级。
