# Codex 本地移动调试

本工具由仓库源码维护，家里与公司拉取同一提交后即可按相同流程运行。它是 Chromium 中的设备参数模拟和 Safari 风格调试外壳，不是 iPhone、Safari/WebKit 或安全认证真机证据。

## 启动

先按 [项目工作流](../context/workflow.md#开工隔离门槛)核验任务独占工作树。Node 要求沿用 package.json（当前 >=24），缺依赖时在该树执行 `npm ci --prefer-offline`。

```sh
npm run dev:mobile
```

启动器输出实际入口，默认 `http://localhost:5185/__mobile-debug`，API 默认 8787。两个服务仅监听 `127.0.0.1`；任一端口占用则停止，不结束其他任务、不自动换来源。需要其他端口时显式指定：

```sh
npm run dev:mobile -- --port 5201 --api-port 8801
```

每个工作树默认使用已忽略的 `data/mobile-debug`。接续既有测试数据可显式传 `--data-dir <本机路径>`，绝不覆盖、清空或同步原数据。`localhost` 与 `127.0.0.1`、不同端口及协议均是不同浏览器来源；已有保险库接续必须核对原来源。需要禁用服务端文件监听时用 `--no-watch`。Ctrl+C 停止本任务前后端。

## 在 Codex 浏览器配置真实设备参数

用户须在当前电脑启用设置 → 浏览器 → 开发者模式 → 完整 CDP 访问，并授权**本次输出的精确本地来源**。仓库里的说明、历史授权和设备 JSON 都不是权限。CDP 接口仍未出现时按浏览器工具文档重新初始化运行时；不得探测隐藏接口、改全局配置或绕过限制。

用已记录的浏览器 API 打开输出 URL；读取 [设备参数](../../tools/mobile-debug/device-profile.json)，通过工具返回的 CDP 接口文档配置：

- `Emulation.setUserAgentOverride` 使用 profile.userAgent；`Emulation.setTouchEmulationEnabled` 使用 profile.touch。
- 居中调试外壳使用 profile.metrics，但将 **width 与 height 设为 0**，让外层画布采用实际浏览器可用面积；screenWidth/Height、DPR、mobile、方向与 scale 1 保留。外壳内手机合成为 393×852，显示比例上限为 100%。
- 直接打开真实页面时改用 profile.metrics 的 393×852。不要把外层画布的宽度当作手机网页宽度。
- 鼠标转触控默认关闭。此前在 Codex 中出现不完整触摸序列及点击超时；原始触摸注入也可能不支持。必须报告实际限制，不以触控点参数生效代替滑动、长按或多指验证。

刷新后从实际 iframe 回读 UA、platform、maxTouchPoints、DPR、粗指针／hover、布局高度与 VisualViewport 高度。profile 中 iOS 27 UA 是明确选择的模拟字符串，不证明该系统版本的实际行为。原生通行密钥能力必须按当前浏览器探测，不能从 UA 推断，也不能为调试强制降级或安装虚拟认证器。

## 外壳控制与边界

顶部按钮控制模拟键盘、工具栏展开／收起、随输入聚焦自动弹出和键盘高度。系统栏与键盘为本地绘制，时间／信号／电池为固定示例，导航图标为视觉示意；地址显示实际本地 host，刷新按钮刷新真实 iframe。细边框、工具栏与键盘高度设置随页面刷新保留；输入框内容不被调试工具保存。

默认状态栏 59px、底部工具栏 110px，网页布局为 393×683。320px 键盘开启时，布局高度仍为 683，调试桥接将 VisualViewport.height **合成为 473** 并发出非原生 resize/scroll 事件，真实页面被裁切到同一可见区。工具栏收起后布局为 393×763。外观与时序只是明确标注的调试模型，不能确认 iOS 原生键盘、中文输入法、安全区域、Safari 工具栏动画或真实手势。

桥接只在显式启动本工具、同源且父页面为 `/__mobile-debug` 的 iframe 中生效。普通 `npm run dev`、直接打开应用、生产构建不启用模拟。用户退出调试外壳即可回到原始浏览器行为。

正式产品的移动表单输入使用独立草稿浮层，聊天输入保持原方式。行为与授权由[移动批注需求记录](../requirements/2026-10-14-mobile-debug-feedback/README.md)拥有；本工具直接加载实际应用，不另设原型入口。

## 换电脑与验证

通过 PR/CI 合并的源码、项目 Skill、参数与需求记录随 GitHub 同步。另一台电脑核实同一基线、安装自身依赖、在独占工作树启动，并重新取得本机 Codex 的精确来源 CDP 授权和回读证据。端口、进程会话、证书、私钥、保险库、数据库、邀请及恢复材料不随 GitHub 同步；本机截图也不自动成为另一台设备的验证结果。

```sh
npm run check
npm run test:mobile-debug
```

专项验证真实本地前后端、非默认端口、数据隔离、设备参数、合成视口、正式表单背景固定与回填／取消、键盘开关和刷新、普通开发入口隔离。已接入完整浏览器门禁。真实 iPhone 验收另按 [局域网 HTTPS](local-lan-testing.md) 或 [iPhone 调试](iphone-debug.md)执行。
