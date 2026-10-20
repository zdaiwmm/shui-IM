# S2 · 页面与状态分离的流程图

> 最新实施约束：A04 及同类页内操作／错误反馈统一改用 toast，不重画 S2 原型。原图及下表／流程中的旧反馈文案按此覆盖；完整说明和实施前审计见 [05_handoff.md](05_handoff.md)。范围已确认：仅实现新建密室，旧数据不迁移，进入产品实施。


实线表示导航或用户任务推进；虚线表示原页面内反馈。P 编号为主界面类型，A–L 为旧状态追踪编号。完整 130 项对应关系见 [changes.md](changes.md)，静态图集包含代表画面。多个状态可以出现在同一页面，不应为状态增加路由或返回层级。

## 创建与邀请

```mermaid
flowchart LR
  Home["P01 首页 A01"] -->|点击创建，成功| Chat["P02 空聊天 A03"]
  Home -.-> Busy["A02 按钮 loading，慢操作才显示"]
  Home -.-> Failure["A04/A05 原位错误与重试"]
  Chat -.-> Copy["B01 已复制 toast／B02 失败 toast"]
  Link["对方打开链接"] --> Shell["P02 待连接聊天壳"]
  Shell -.-> Verify["B04 验证中状态"]
  Shell -.-> Wait["B08 等待对方进入的系统卡片"]
  Shell -.-> Retry["B09 连接中断卡片与重试"]
  Shell -.-> Invalid["B06/B07 失效卡片；不创建正式密室"]
  Shell -->|连接完成，同一界面| Ready["P02 启用聊天输入；URL 归首页"]
  Link -->|本机已有效加入 B10| Ready
  Link -->|本机已有应用锁 B12| Lock["P04 现有解锁"] --> Shell
```

聊天壳出现不代表成员和加密连接已就绪。邀请只有成功提交才消费；未验证前不展示可信密室数据。返回原有聊天／首页不消费待处理邀请。B10 不展示额外确认页。

## 隐私引导与应用锁

```mermaid
flowchart LR
  Guide["P02 现有折叠三步卡"] --> Cover["P10 现有遮蔽演练"]
  Guide --> Auto["P05 现有自动锁定"]
  Guide --> Card["P08 恢复卡制作"]
  Cover -.-> Enable["D05 现有启用确认浮层"]
  Settings["P03 现有设置"] --> CoverSettings["P10 现有遮蔽配置 D03"]
  Settings --> Auto
  Settings --> Detect{"自动判断保护能力\nE01/E02 不展示"}
  Auto -->|设置保护需要时| Detect
  Detect -->|可用设备保护| Native["系统原生验证"]
  Detect -->|数字输入| Numeric["P04 现有输入组件 E03"]
  Numeric -.-> Confirm["E15 同页再次输入"]
  Numeric -.-> Error["E05/E06/E09 原位错误"]
  Numeric -.-> Save["E08 原位忙碌"]
  Numeric -->|成功| Origin["回原入口，E16 toast + 状态更新"]
  Native -->|成功| Origin
  Native -->|取消／失败| Same["回原入口，保留重试，不自动降级"]
  Auto -.-> Timing["E13 现有等待时间半屏选择"]
```

D03 取消原稿自创的中间配置页，复用现有配置；指南直接进入既有演练。应用锁关闭保留一次风险确认，忘记密码按需显示说明浮层，全局清除单独确认。

## 密室切换与本机删除

```mermaid
flowchart LR
  List["P06 现有密室列表 F01"] -->|点击，直接切换| Chat["P02 聊天；F03 复用离线状态"]
  List -.-> Busy["F02 仅选中行忙碌，没有加载页"]
  List -.-> Menu["F12 现有长按菜单，没有管理页"]
  Menu --> Rename["F05 现有改名弹窗"] --> List
  Menu --> Delete["F06/F07 一次删除确认，含未备份风险"]
  Delete -->|取消| List
  Delete -->|确认| List
  List -.-> Clear["F08 行内清理中"]
  List -.-> Error["F09 清理未完成，可继续清理"]
  List -->|最后一项清理完成 F10| Home["P01 原首页"]
  Other["另一标签页完成删除"] --> List
  Other -.-> Toast["F11 toast，撤下旧内容，禁止写回"]
```

## 设备接替

```mermaid
flowchart LR
  Settings["P03 设置"] --> Panel["G01/G02/G03 同一生成链接面板"]
  Panel -.-> Select["多目标在面板内选具体设备；唯一目标预选"]
  Panel -.-> Copy["生成并复制，原位 loading／toast"]
  Panel --> Link["发给对方对应设备"] --> Chat["P02 对方待连接聊天壳"]
  Chat -.-> Local["G04/G05 原位准备；旧缓存保持"]
  Chat -.-> State["G06/G08/G09/G11 系统卡片，支持正确重试"]
  Chat -.-> Unknown["G12 仅类型未知时确认具体目标"]
  Chat -->|成功| Active["同一聊天启用输入，无 G07 成功页"]
  Active -.-> Old["G10 旧端聊天卡片：已被接替"]
```

同类设备不批量撤销，链接绑定具体身份及版本。通信撤销不等于撤销旧恢复材料；该说明留在链接面板，不新增 L07 页面。

## 默认备份与恢复卡

```mermaid
flowchart LR
  Chat["聊天与默认加密备份"] --> Overview["P07 备份与本机恢复 H01"]
  Overview -.-> States["H02–H08/K02/K03/K06/K08/K09 总览内进度、结果和重试"]
  Overview --> Card["P08 恢复卡 I01"]
  Card -.-> Form["长口令与确认，I02/I03 字段错误"]
  Card -.-> Generate["I04 按钮忙碌，I14 原位生成失败"]
  Card -.-> Save["I05 同页展示图片；I06 保存失败 toast"]
  Card -.-> Verify["I07 同页重新选入验证；I08/I09 原位错误"]
  Card -->|验证成功 I10| Overview
  Overview -.-> Saved["toast + 恢复卡行已验证"]
  Card -.-> Help["I11 重新导出同页说明；I12 按需帮助浮层"]
```

默认备份不等待保存卡片。口令保护图片中的恢复材料，不决定服务器是否持有解密能力。保存按钮被点击不等于文件已保存验证。

## 本机恢复与私人合并

```mermaid
flowchart LR
  Overview["P07 当前密室总览"] --> Restore["P09 恢复记录 J01"]
  Restore -.-> Reading["J04 按钮／任务区 loading"]
  Restore -.-> Summary["J06/K04 原位摘要，确认目标及范围"]
  Restore -.-> Working["J07 任务区进度，J10 直接暂停／继续"]
  Restore -.-> Error["J02/J03/J05/J09/J12/J14/J15 原位错误或空状态"]
  Restore -.-> Resume["J13 同页续接任务"]
  Restore -->|本机完成 J11| Chat["P02 当前聊天定位私人导入 K01"]
  Chat -.-> Backup["P07 私人备份进度，不提前承诺当前卡覆盖全部"]
  Backup -.-> Done["K03 总览分项更新为全部已备份"]
  Peer["另一方 P02 聊天 K05"] -.-> Unchanged["保持原样，无私人导入数据或通知"]
  Chat -->|用户主动转发| Confirm["K07 一次分享范围确认"]
  Restore -->|目标删除 J16| List["P06 列表 + toast；不转移恢复目标"]
```

连接系统卡为本机操作反馈，不作为共享消息发送，不计入消息未读、回执或归档。恢复后的历史仍属于当前密室，私人备份的权限隔离和完整提交门槛保持不变。

## 跨流程处理

- L01 存储异常留在原入口或列表，禁止自动清空、新建替代身份。
- L02 能力不足在入口原位告知；L03 并发提示贴近发起操作，不跳并发页。
- L04 有锁时直接回现有锁屏，无锁时仍撤下敏感预览，不凭空增加解锁条件。
- L05 本机清空使用原首页；L06 缺少恢复材料在恢复表单解释。
- L08 全局清除保留明确确认。确认浮层不能被 toast 替代。

本稿是静态目标，不把时序、原生认证、密码学、真实设备及服务端竞争条件标成已验证。
