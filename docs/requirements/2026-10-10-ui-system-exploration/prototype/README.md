# Quiet Room 可交互原型 P1

2026-10-11，本需求 S 设计阶段的待审版本。用户已确认 V5 截图配色并授权制作交互原型，明确不需要业务流程图。正式产品尚未实施。

源码内容摘要 SHA-256：`4d1a41612dee53150100aa96aee85a74dd151d492a94fbccccad0e60ca0befe7`。按 `index.html`、`styles.css`、`app.js`、`icons.js`、`server.mjs` 顺序，将文件名、换行、文件内容、换行送入 SHA-256；本标签与摘要共同识别待审对象。

## 启动与体验

从本任务 worktree 运行，只需要 Node.js，不需要安装原型依赖或构建：

```sh
node docs/requirements/2026-10-10-ui-system-exploration/prototype/server.mjs --port 8846 --pattern /absolute/telegram-pattern.svg
```

访问 [本机原型](http://127.0.0.1:8846/)。服务器只监听 `127.0.0.1`；此地址不用于手机局域网访问。停止服务器用 Ctrl-C。

本机会话纹样位置：`/Users/achilles/.codex/visualizations/2026/10/10/01a12631-e947-7a91-af08-e958fca410e2/telegram-pattern.svg`。跨电脑从 [Telegram Web K 原文件](https://raw.githubusercontent.com/TelegramOrg/Telegram-web-k/master/public/assets/img/pattern.svg) 取得并核对 SHA-256 `6b56e5b5a31081d46a4b7c6d503c11235f37499486294c77753f8d25af0c520d`。该 500KB 纹样与预览图片不纳入 Git；缺失纹样时应补齐素材后再做视觉审阅。

桌面顶部切换浅深色，左侧进入聊天、设置、弹窗、半屏面板；点击输入框自动进入标准键盘情境，也可选择较高键盘。宽窗口右侧提供收信、历史、失败、断线、空对话与加载状态。

手机宽度直接使用整个可用视口，不显示原型控制栏或模拟键盘。点击聊天标题进入设置，在“主题外观”切换浅深色；“关于此原型”可重置演示。菜单也提供设置、外观与历史入口。桌面工具右侧不显示时，这些聊天内入口仍可使用。

建议依次体验：发送一句话；长按或右键消息并回复；删除自己的消息后撤销；在历史位置切换标准／较高键盘；打开附件、表情或外观面板并拖动顶部把手关闭。

## 视觉与交互规则

配色沿用 [V5 取样与适配说明](../static-style/SOURCES.md) 和 [令牌记录](../static-style/tokens.json)。导航、输入区与面板使用不透明表面。设置色彩、危险色及状态色为 P1 延展，不声称来自用户截图。

| 项目 | P1 规则 |
| --- | --- |
| 浅色 | 黄绿／青绿渐变壁纸；接收 `#FFFFFF`、发送 `#E0FFC6`；输入区 `#BCE8CF`；操作色 `#529D68` |
| 深色 | 黑色壁纸、接收 `#342234`；发送共享 `#944CD5 → #9349F4 → #3768FF` 连续渐变场；输入 `#242424`、导航 `#252525`；操作色 `#9465ED` |
| 文本 | 系统字体；消息正文 16px / 22px；标题 15px，紧凑态 14px；设置正文 14px；消息时间 11px |
| 间距与圆角 | 气泡内距 8px 11px 7px；组间 12px；主圆角 16px，连续消息辅助圆角 8px；设置分组 10px |
| 控件 | 设置行 44px；导航／输入操作区 40×44px，图标独立保持小尺寸；设置图标底 24px；开关 36×22px |
| 标题与输入 | 常规标题 48px，输入时 40px，隐藏头像并将在线状态与名字同行；输入区基准 52px；文本框最高 88px，超出内部滚动 |
| 按钮反馈 | 按压缩放 `.96`，100ms；键盘焦点有明确描边；禁用状态不触发操作 |
| 动效 | 消息／页面／弹窗 180ms，面板进入 240ms；缓动 `cubic-bezier(.22,1,.36,1)`；减弱动效和系统偏好均可关闭主要位移与循环动效 |
| Toast 与 tips | Toast 在标题下方，普通 2.6s，撤销 7s；文字区域不拦截底层操作，仅操作按钮接收点击；tips 仅悬停／键盘聚焦，延迟 400ms |
| 弹窗 | 窄幅 280px，取消与确认分开；Esc／遮罩取消，Tab 焦点限制于弹窗，退出恢复焦点；背景视图使用 inert |
| 半屏面板 | 宽度随聊天区，顶部圆角 18px；内容超过上限时内部滚动，最高 `min(74%,460px)`；下拉把手、关闭按钮、遮罩、Esc 均可关闭 |
| 消息操作 | 长按 480ms／右键／键盘菜单进入回复、复制、删除；仅自己的消息有删除；触摸右滑超过 46px 触发回复 |
| 对话位置 | 跟随最新时，键盘变化和自己发送后保持底部；阅读历史时保留首条可见消息及偏移；新消息只增加提示，点击回到最新后清零 |

## 键盘与浏览器空间

桌面预览的底部浏览器工具栏为 60px；标准键盘与输入工具条合计 390px，较高情境为 474px，并随较矮预览缩小。高度只是可审阅的空间压力模型，不是对 Safari 工具栏结构或真实键盘尺寸的承诺。

手机布局接入 `visualViewport.height` 与 `offsetTop`，独立滚动消息列表，固定输入区在当前可视区底部；同一帧的尺寸事件合并处理。手机不再额外放置一个主题工具栏，以免再占用 42px。多行输入有高度上限，紧凑标题不增加副标题行。

已验证桌面较高键盘下标题 40px、消息区 180px；320×400 短视口配合三行输入时，标题 40px、输入 93px、消息区 267px，最新消息仍可见。375px 同宽仅改变高度时，历史消息的阅读偏移保持不变。尺寸模拟不代表 iPhone / iOS 27 / Safari 真机通过。

## 模拟边界与文件

聊天数据全部虚构，仅存在内存。发送回执、在线、通话、自动锁定与设置保存均为演示；语音波形不调用麦克风。图片选择只创建本地 Blob 预览，其他文件显示文件卡片，不上传，不执行；重置时销毁 Blob URL。拍摄项使用浏览器原生文件选择入口，原型不主动申请摄像头权限。刷新页面恢复初始对话。

原型不导入正式应用入口，不注册 Service Worker，不连接真实聊天服务，不持久化到 localStorage，不改变协议、恢复、隐私或设备边界。

| 文件 | 用途 |
| --- | --- |
| [index.html](index.html) | 聊天、设置与桌面审阅入口 |
| [styles.css](styles.css) | 主题、紧凑布局、面板和动效 |
| [app.js](app.js) | 内存状态、消息操作、弹层、尺寸锚点 |
| [icons.js](icons.js) | 现有依赖 Lucide 0.468.0 的最小图标节点集合 |
| [server.mjs](server.mjs) | 本机静态预览与 V5 对照路由 |
| [design-qa.md](design-qa.md) | 浏览器实测、视觉对照、已修复问题及验证缺口 |

## 图标许可

Lucide 0.468.0 来源于任务基线已有 npm 依赖，仅复制所需图标节点；没有新增正式依赖。版权与许可原文：

```text
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```
