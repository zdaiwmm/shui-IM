# PC 八项修复与 macOS 独立安装包 V1

## 阶段与授权

2026-10-26 用户确认「免原型直接实施这 8 项 PC 问题。macOS 做独立安装包，能固定到 Dock 直接打开」。随后追加 PC 更多按钮与气泡的间距及圆点居中。确认来源为本任务用户消息，未提供独立消息定位；原型和流程图本轮明确免除。允许本任务 I/D 实施、验证及既有持续远端交付；没有本次生产发布授权。

规则来源本机 main `c9f38d91afe7e64434824fd2b6b2542de55260b6`，与实施基线的 AGENTS/workflow 相同。GitHub 基线 `530ddf51a03c592959b5db6a765eccc4f2006a51`；实施独占 `codex/pc-eight-macos-20261026`，本机目录 `/Users/zhouding/ss-worktrees/pc-eight-macos-20261026`。最终源 `91b7fae2fcad0f032b5380d6ba271bad42399af3` 经 [PR #418](https://github.com/zdaiwmm/shui-IM/pull/418) 合并为应用 `460c57d06081d05419226c5d39f3afb659e1abca`／版本 `2026.10.26.1`，完整文件树一致。状态：代码及精确主线完整 CI 通过，未发布。记录树 `codex/pc-eight-macos-record-20261026` 基于该合并提交，不包含部署配置。

## 范围与验收矩阵

| 项目 | 具体结果与边界 | 实现／验证入口 |
| --- | --- | --- |
| 1 本人密室授权 | 已通过本人设备目录发现的密室可直接申请；原端在该密室时间线收到系统卡，应用锁验证后允许或拒绝。过期／拒绝可重试。通过已有本人设备的加密通道传递内部单次接入材料，无复制链接步骤。目录发现仍不授予成员资格和旧历史 | own-room-access、独立 own-admission 邮箱、pc-room-access |
| 2 入口图标 | 网页与安装清单版本化引用现有双向对话图标，原生包用同一资源；不删除既有浏览器数据或应用 | manifest、index、macOS 包 |
| 3 工具栏透明边缘 | PC 工具／表情面板展开时，整个输入栏宽度均由不透明底色承接；输入行宽度保持 | pc-layout、desktop-layout、pc-room-access |
| 4 遮蔽页 | PC 遮蔽练习不继承内容轨 padding，不产生横向或多余纵向溢出；原长按权限和锁定保持 | pc-layout、pc-room-access |
| 5 返回位置 | PC 返回以当前页面内容轨为中心，设置及其他完整页保持独立滚动和可达操作 | pc-layout、desktop-layout、pc-room-access |
| 6 设置切页 | PC 设置入口使用内容页；转场冻结来源的实际几何，原设置不横移／重排，返回保留滚动 | app transitionPage、desktop-layout、pc-room-access |
| 7 多余按钮 | 新密室不挂载旧格式桌面侧栏及其自动注入按钮，现有聊天／设置入口保持 | DesktopWorkspace 调用、pc-room-access |
| 8 列表顶部 | PC 列表标题背景铺满所在区域，去除列表的设置齿轮；新增和返回仍可用 | space-drawer、pc-layout |
| 追加 更多按钮 | PC 圆形按钮距气泡 8px，20px 图标在既有 44px 目标中双轴居中 | pc-layout、pc-room-access |
| macOS | 无 Chrome/Docker 依赖的 AppKit/WKWebView 包，正式来源固定、独立存储、Dock 重开、原图标；相机／麦克风由系统按需请求，文件选择／下载由用户选路径 | desktop/macos、build:macos |

仅 PC 布局作断点修复，不改移动端页面尺寸或导航动效。授权采用现有 P-256 ECDH/HKDF/AES-GCM 与 ECDSA，另分 purpose 和服务器邮箱，旧目录载荷格式保持兼容；请求/回答绑定 carrier room、目标 room、双方设备、随机 ID 和固定十分钟截止。原端验证活跃同角色设备后使用现有设备接入证明与 MLS add，仍受三端限制。信任基础是已有本人设备关系，不接受仅凭房间 ID 的公开申请。锁定／离线／隐藏不宣布接入完成，已读内容不能远程抹除。

## 验证与限制

- 最终干净源 `91b7fae` 的 `npm run delivery:evidence -- run check:full` 通过 145 文件／1100 项及 82/82 浏览器入口，0 失败／0 未运行，1359332ms，文件树 `5f1dba9815082148dd9ccbb17dac688aef9c223b`。涵盖 Chromium/WebKit、真实三浏览器 MLS 拒绝／重试／应用锁批准／新消息／无旧历史，以及 PC 透明边缘、返回居中／底距、静止设置背景、遮蔽溢出和更多按钮几何；完整存储／恢复／附件／语音／通话／隐私也通过。
- [精确 PR 完整 CI 40268466936](https://github.com/zdaiwmm/shui-IM/actions/runs/40268466936) attempt 1 全绿，Full application verification 成功。[精确应用 main CI 40270491736](https://github.com/zdaiwmm/shui-IM/actions/runs/40270491736) attempt 1 全绿，已独立核对应用 SHA 和 Full application verification；不把本记录后续文档提交当作已验证应用或生产版本。
- macOS arm64 与 x86_64 编译、合并二进制、ad-hoc 签名验证、DMG 校验通过。Apple Silicon 上原生窗口/WebKit self-test 通过，实际原生窗口已只读打开正式首页。宿主未安装 Rosetta，Intel 执行未验证；相机／通话及旧 macOS 真机另验。
- 无有效 Apple Developer ID 身份，安装包未签发行证书／未公证，不能声称通过 Gatekeeper。仅本机临时签名包，公开分发另需签名公证。安装包不包含未发布网页修复，站点版本由后续精确 SHA 发布决定。
- 内嵌 WebKit 未配置 Associated Domains，不宣称系统通行密钥可用；新应用保护明确走现有密码入口，既有浏览器通行密钥／数据不导入、不降级。
- 初代新整链夹具先后暴露剪贴板写入未等待、首次设锁后遗漏独立操作验证；已保留失败并修正夹具等待，产品断言不放宽。后续失败需按证据分类。
- 后续夹具需等待新密室 ID，避免误读旧邀请按钮；引导链接改从实际应用生成函数取得，真实网络、批准及 MLS 流程保留。输入栏宽度比较使用聊天内容宽度，排除已有 1px 外边框。最初新注册入口引起统计预期不匹配，改由既有 desktop-layout 入口顺序执行新链路，保留 82 个入口和原统计断言。
- 首轮完整检查因仓库内安装包暂存的 Applications 符号链接扫描到 Cursor 自带测试，误扩为 171 个文件并伴随一项超时；打包暂存改用仓库外随机临时目录，完成后清理，旧任务生成链接已移除。候选 `c4395dc`／`57912b4` 的完整浏览器运行因纳入时间线末尾卡片与返回栏／输入底角视觉修正主动中断，未作为通过或产品失败证据；最终验证只归于上述干净源。
- 截图、DMG、编译产物、证据与依赖保存在忽略目录或本机交付目录，不加入 Git；提交前检查体积、二进制、敏感内容及格式。

## 本机安装包

交付文件 `/Users/zhouding/Downloads/Chamber-PC-20261026/Chamber-1.0.0-macOS.dmg`，182312 字节，SHA-256 `36ae66a9b7f337c825edd4e6898ae03b837909603bcfb2c29442a0c79abb1b4f`。这是本机路径，不是跨电脑下载地址；同目录有说明及校验文件。打开 DMG 后拖入应用程序，启动后在 Dock 选择保留；Command-O 可粘贴已有邀请／设备链接。网页版本跟随正式站点，代码合并不使本包提前加载未发布修复。

本地完整证据保存在实施树 Git 元数据的 delivery-evidence，截图和构建记录在该树忽略的 `.artifacts/`。没有新建生产发布、没有清除既有数据、没有修改旧 Chrome 应用。实施树的忽略材料及未发布应用仍需保留，不按已发布资源清理。
