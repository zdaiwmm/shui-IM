# Language 与用户反馈 V1.1

## 身份与当前阶段

- 阶段：静态原型已制作，待用户确认设计及正式实施。
- 用户于 2026-10-28 在本会话确认 V1 方案、邮箱必填及原建议语言清单，并要求增加繁体中文；明确「静态图片即可，按照当前产品视觉规范制作」。未提供外部消息链接。
- 本次例外：以静态图片替代可交互原型；保留静态流程说明。不据此推断正式实施或生产发布授权。
- 规则来源：本机 main `f3c16204b19bfae876af400651461c1849a1f1e6` 的 AGENTS.md 及 workflow 固定流程、确认与隔离章节。
- 设计基线：GitHub 实时 main 与本机 origin/main 均为 `be615e37bb504a4d15c74c1bfa069b15c7c93ec6`，本机 main 较旧。
- 本任务新建目录：`/Users/zhouding/ss-worktrees/language-feedback-prototype-20261028`。
- 独立分支：`codex/language-feedback-prototype-20261028`；开工工作树干净。

## 已确认范围与本次细化

- 11 种界面语言：English、简体中文、繁體中文、Español、Français、Deutsch、Português、Русский、العربية、日本語、हिन्दी。
- 设置「聊天体验」新增「语言 / Language」。首次进入按浏览器提供的设备语言偏好顺序匹配，无法匹配用 English；手动选择优先，本设备保存，并可恢复跟随系统。
- 简繁匹配细化：显式 Hans/Hant 优先于地区；zh-TW/HK/MO 匹配繁体，zh-CN/SG 和无地区 zh 匹配简体。其他支持语言归并地区变体。此细化随 V1.1 一并审阅。
- 用户端界面、提示与错误文案本地化，用户内容不翻译；阿拉伯语需 RTL 布局。后台本期保持中文。
- 设置「关于」新增「用户反馈」，独立页有必填邮箱、必填多行正文及提交按钮，正文最多 5,000 字。
- 格式校验原位提示；提交中禁止重复操作；失败保留本次输入并允许重试；成功明确已收到并可返回设置。
- 邮箱与反馈主动提交给管理员，页面明确说明，不自动附带聊天、密钥、恢复材料。后续实现服务端输入校验、提交限流、后台鉴权和防重复。
- 后台反馈按时间倒序分页，包含邮箱、正文、时间、未读／已读状态及手动标记已读。本期无站内回复。
- 返回未提交页面、锁定时的草稿生命周期以及反馈数据保留／删除策略在正式实施前明确；本次图片不承诺长期保存未提交输入。

## 设计材料

- 静态源：`prototype/index.html`，V1.1；仅本地设计素材，无真实接口、业务入口、Service Worker 或真实数据初始化。
- 渲染入口：`prototype/render.mjs`。在仓库根执行 `node docs/requirements/2026-10-28-language-feedback/prototype/render.mjs <已存在的绝对输出目录>`，使用锁文件安装的 Playwright 和本机 Chrome。
- 直接浏览 HTML 即默认浅色画板；查询参数 `view=mobile|states|admin|flow`、`theme=light|dark` 选择静态画板。按钮仅为静态外观，不能真实提交。
- 设计依据：本基线 DESIGN.md、PRODUCT.md、docs/design/mobile-visual-standard.md；实际 tokens 来自 src/design-tokens.css，设置分组参考 src/lib/space-drawer.ts 与 src/app.ts，子页参考 src/lib/settings-layout.ts、src/chamber-refinements.css；后台参考 src/admin.ts、src/admin.css。
- 沿用现有 P1 默认浅绿／深紫，系统字体、20px 子页边距、26px 标题、14px 标签、16px 输入、44px 操作和 R12 控件；后台沿用 240px 侧栏、连续表格。复用共享 token，不修改现有视觉规范或正式组件。
- 主图：设置、语言、反馈；浅深两版。补图：邮箱格式错误、网络失败、成功；后台列表与详情浅深两版；流程概览。
- 流程源：flow.md。静态渲染为 flow-light.png，和 Mermaid 表达相同行为。
- PNG 仅保存在本机 `/Users/zhouding/.codex/visualizations/2026/10/28/01a1812a-6f7d-7971-be36-87e6b2c3be63/language-feedback/`，不入 Git。

## 确认与证据

| 节点 | 范围 | 依据与权限 |
| --- | --- | --- |
| 第一次确认 | V1 + 繁体中文，即 V1.1 | 2026-10-28 本会话用户明确确认，授权静态设计 |
| 第二次确认 | 本次静态图与流程 | 待用户审阅；尚未授权正式实施 |

- 已完成本地 Chrome 静态渲染，检查 390×844 页面图与 1440px 后台画板，浅深主题及表单状态；11 种语言完整显示，无横向溢出。
- 未执行产品测试或真实提交；未验证移动键盘、真机、系统语言匹配、语言持久化、翻译完整性、RTL 实现、真实后台权限与网络请求。
- 材料仅 HTML、MJS 和 Markdown，无复制依赖、图片或 Base64；正式业务、接口、依赖配置和生产配置均无变更。
- 交付终点：本地静态设计材料。下一步为审阅 V1.1 并确认是否实施；不自动合并主线或发布。
