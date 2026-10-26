# Chamber for macOS

独立 AppKit / WKWebView 应用，正式来源固定为 `https://ai.shui.click/`。
无需 Chrome、Electron、Docker 或本机服务。网页更新沿用正式站点的版本；安装包不包含未发布的网页修复。

在 macOS 安装 Xcode Command Line Tools 后运行 `npm run build:macos`。
默认输出到忽略的 `.artifacts/macos/`；也可向构建脚本传入绝对输出目录。
DMG 包含双架构 `Chamber.app`、应用程序文件夹快捷入口和安装说明。
拖入应用程序后打开，在 Dock 选择“选项 → 在程序坞中保留”。关闭窗口保留进程，点击 Dock 重新打开；Command-Q 退出。
首次加入已有密室，可使用“文件 → 打开密室链接…”（Command-O）粘贴本人设备链接或普通邀请。输入遮挡显示、不保存原生字段，仅交给固定正式来源的既有验证流程。

网页数据独立于已有浏览器，首次授权遵守普通新增设备及历史边界。
新本机保护使用应用密码；没有 Apple Associated Domains 配置时，不声明内嵌通行密钥可用，既有保护绝不降级。
没有原生 JavaScript 桥接，不忽略 TLS 错误、不注入远程脚本；只允许正式来源在应用中导航，用户主动点击的 HTTP(S) 外链交给默认浏览器。
文件选择、下载位置及相机/麦克风均由用户操作和系统权限控制。失去前台时原生遮挡网页，网页原有锁定及清理仍独立执行。

当前构建使用本机 ad-hoc 签名，**没有 Apple Developer ID 签名或公证**。公开分发前需用有效身份签名并完成公证，不能称为已通过 Gatekeeper 的发行包。
本机可直接运行包内 `Contents/MacOS/Chamber --self-test` 验证窗口与 WebKit 初始化；这不证明生产授权、通话或通行密钥可用。
