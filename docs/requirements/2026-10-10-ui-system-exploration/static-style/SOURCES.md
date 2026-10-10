# Telegram 截图视觉 V5

用户否定 V4 的 Classic／Tinted 配色组合，并提供当前使用的两张 Telegram iPhone 截图。本版以这两张截图为配色与颜色关系的首要依据。2026-10-11 用户确认本版配色并授权制作 [P1 交互原型](../prototype/README.md)；正式产品没有改动。

## 取色方法与依据

截图原图为 1179 × 2556，内嵌 Display P3 ICC。使用 Pillow ImageCms 将像素转换至 sRGB 后，只分析平坦气泡区域的主色与壁纸小块的中位色。截图不是跨平台统一的官方设计规范，取样值不代表 Telegram 固定主题令牌。

- 浅色：接收气泡 `#FFFFFF`、发送气泡 `#E0FFC6`、发送时间约 `#2EA22F`。壁纸包含黄绿 `#CAD381`、青绿 `#66AB84`、右侧柔绿 `#89BE87` 与淡黄绿 `#D0D7B2`，不能用灰白底替代。
- 深色：壁纸底色 `#000000`，接收气泡上段主色 `#342234`、下段暖色样本 `#352626`；发送气泡沿对话由 `#944CD5` 经 `#9349F4` 向 `#3768FF` 变化。导航代表样本 `#252525`、输入背景样本 `#242424`。
- 对截图只做只读像素分析；不将用户截图、真实消息、名字、链接或群聊内容复制到本需求材料。样式板继续使用虚构的双人对话。
- `tokens.json` 区分实际取样值与浏览器适配值。浅色导航／输入样本来自原生玻璃表面，转换成不透明色后只能作为代表色，不声称复现动态材质。

## 纹样与浏览器适配

纹样取自 [Telegram Web K 官方仓库](https://github.com/TelegramOrg/Telegram-web-k/blob/master/public/assets/img/pattern.svg)，用于接近截图中的线描壁纸。取回的被动 SVG 不含脚本、嵌入图片或外部链接。预览素材 SHA-256：`6b56e5b5a31081d46a4b7c6d503c11235f37499486294c77753f8d25af0c520d`。该文件为本地审阅素材，未纳入 Git；跨电脑须重新取得并核对摘要。

- 浅色壁纸用静态 CSS 多点渐变近似取样关系；深色用黑底与低对比紫／棕／蓝纹样。纹样位置及空间渐变不是逐像素重建。
- 深色发送气泡共享一个垂直渐变场，由首次静态排版测量确定偏移；各气泡不重新播放完整渐变。小尾巴取对应高度的渐变色。
- 导航与输入表面采用不透明材质；不复刻原生 Liquid Glass、动态折射或系统工具栏。
- 设置局部的绿色／紫色图标、开关、分组背景为沿截图色相的延展，截图本身未提供设置页依据。
- 正文 16px、设置行高 44px、常规标题 48px、键盘态标题 40px、输入区 52px、输入框 36px 为本需求浏览器适配值。键盘态静态总可视区 274px，不代表用户真实设备高度。
- 气泡主圆角 16px、连续消息辅助圆角 8px 沿用此前核对的 [Telegram iOS 气泡实现](https://github.com/TelegramMessenger/Telegram-iOS/blob/f1dd7a2dbd02cbbf513e75d5695d8d36d1cf5838/submodules/TelegramUIPreferences/Sources/PresentationThemeSettings.swift)。V4 的官方默认主题组合已被用户否定，不继续作为配色依据。
- 保留无账号、两名参与者与既有功能边界；不新增联系人、群聊或消息能力。

## 本地绘制

`board.html` 是静态 HTML/CSS/SVG，只包含首次排版时对连续渐变的测量，没有交互事件、真实输入、主题切换或业务流程。直接打开可看基础布局；完整纹样预览由绘制脚本在内存中加载本地 SVG。

`render.mjs` 使用本会话内置 Playwright，阻断 HTTP／HTTPS 请求，只读取本地样式板和 SVG，将纹样作为 Data URL 注入内存。跨电脑先重新定位 Codex workspace dependencies，不假定下列运行时存在。

```sh
/Users/achilles/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node docs/requirements/2026-10-10-ui-system-exploration/static-style/render.mjs /absolute/output.png /absolute/telegram-pattern.svg
```

PNG 与 SVG 只保留在本会话 visualizations 目录。绘制与消息裁切检查属于静态 Chromium 证据；不代表 Safari 工具栏、VisualViewport、真实键盘或交互验证。V5 配色已确认；P1 的交互证据另见 [design-qa.md](../prototype/design-qa.md)。
