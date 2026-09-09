# ContextRail

中文 | [English](./README.en.md)

ContextRail 把 agent 当前交给模型的上下文画出来。它支持
[Oh My Pi](https://github.com/can1357/oh-my-pi) 和
[Pi](https://github.com/earendil-works/pi)，终端里有一条简洁的状态栏，浏览器里则是一张会随对话生长的空间画布。

它是只读扩展。ContextRail 监听宿主公开的生命周期事件，但不会修改消息、切换 session，也不会控制 agent。

## 现在能看到什么

- 当前上下文用量、模型、工具调用和压缩状态。
- 在宿主上下文接口观察到的 system、memory、developer、user、assistant 和 tool 消息。
- 一条持续增长的 session 历史。消息离开上下文后仍留在画布上，再次进入时会回到窗口中。
- 同一 Hub 下的多个 OMP、Pi 进程和 session。浏览器切换标签只会切换视图。
- Pi 的新建、恢复、分叉、压缩和树导航结果，不需要再发一条消息才刷新。
- 卡片上的内容预览，以及侧边检查器中的文本、thinking、工具参数和图片。这里只显示宿主交给扩展的白名单字段。
- 有保留上限的上下文捕获记录、历史回看和相邻捕获的内容变化。

历史卡片和连线由 Pixi/WebGL 绘制，当前窗口仍使用 DOM。画布静止后渲染循环会停下来，长 session 不会一直占用 CPU。WebGL 不可用时会退回 DOM/SVG。

目前一条消息对应一张卡片。卡片宽度不是该消息的 token 数量。

## 环境要求

- OMP 17.1.3 或更高版本
- Pi 0.83.0 或更高版本
- OMP、Hub 和本地开发需要 Node.js 22.6.0 或更高版本
- Pi 0.83.0 需要 Node.js 22.19.0 或更高版本

## 安装

### OMP

```sh
omp plugin install github:izumi0uu/context-rail
omp plugin enable context-rail
omp
```

已经运行的 OMP 进程需要重启一次。

### Pi

在 ContextRail 源码目录中运行：

```sh
npm install
pi install "$PWD"
pi
```

`pi install` 会把当前目录记录到 Pi 的用户设置。重新构建 ContextRail 后，需要重启 Pi 才会加载新的 `dist/pi.js`。

只想临时加载源码，可以运行：

```sh
npm install
pi --extension ./src/pi.ts
```

### 链接本地源码到 OMP

```sh
npm install
omp plugin link .
omp plugin enable context-rail
omp
```

不写入插件配置的临时运行方式：

```sh
npm install
omp --extension ./src/index.ts
```

`npm install` 会同时构建 OMP、Pi 和 Hub 使用的 `dist/` 文件。

## 使用

在 OMP 或 Pi 中输入：

```text
/context-rail show
/context-rail hide
/context-rail toggle
/context-rail web
/context-rail stop
```

`show` 和 `hide` 控制终端中的展开信息，简短状态栏会保留。`web` 启动或连接本机 Hub，并打印浏览器地址。`stop` 只停止当前 agent 进程的监控，不影响其他进程。

Hub 独立于 OMP 和 Pi。关闭一个 agent 不会关掉浏览器，也不会中断其他 session。

停止 GitHub 安装版本启动的 Hub：

```sh
npm exec --yes --package=github:izumi0uu/context-rail -- context-rail stop
```

使用本地源码时，在仓库目录运行：

```sh
npm run hub -- stop
```

这两个命令会等旧 Hub 释放 discovery 文件和锁，然后才退出。因此可以马上重新启动。

如果 OMP 所在环境找不到 Node.js，可以显式指定路径：

```sh
export CONTEXT_RAIL_NODE=/absolute/path/to/node
omp
```

启动失败时，错误信息会列出 ContextRail 找到的 Node 和 Hub CLI 路径。

## 浏览器画布

画布沿用了 [graphcon-deck](https://github.com/yoheinakajima/graphcon-deck) 的空间交互：卡片待在同一个二维世界里，由镜头和上下文窗口组织视线，不把历史改排成 dashboard。

Window 模式显示当前观察到的上下文，回看捕获记录时则显示那次保留下来的上下文。卡片按捕获到的消息顺序从左到右、从上到下排进矩形窗口。列数会随可用宽度从 2 列逐级增加到最多 6 列，避免跨过断点时卡片突然缩小；达到列数上限后，新增卡片从下一行继续。历史卡片有固定的 home position；只有挡住窗口的卡片才会沿原来的方向向外让位。

Overview 模式展示完整历史。压缩摘要会开启一个新的 epoch，后续内容继续沿蛇形路径生长，之前的卡片不会因为新消息重新排版。

其他交互规则：

- 虚线卡片表示消息已经被观察到，但还没被下一次 `context` 事件确认。
- 桌面端点击卡片会打开非模态侧边检查器，画布仍可交互；移动端使用全屏阅读面板，并将键盘焦点限制在面板内。拖动卡片不会误触详情。
- 点击变暗的历史卡片会前往它所在的 epoch。当前焦点不在按钮或标签上时，左右方向键也能切换 epoch。
- 拖动画布平移，滚轮围绕光标缩放。每个 session 单独保存镜头和 Window/Overview 模式。
- session 标签是只读的。`Follow active` 默认关闭，所以后台 agent 的活动不会抢走当前标签。
- 后台 session 继续收集事件，并用未读标记提示更新。

### 阅读内容

卡片预览使用正文中的首个非空标题或文本行。工具调用显示工具名和可识别的路径、命令或查询参数，工具结果显示工具名和实际输出的第一行。多条模型消息、图片数量和错误状态会单独标注；真实摘要与没有摘要正文的合成压缩事件标记也会区分。

检查器按原有顺序逐条显示 model message，每条都有自己的角色标题，不会把一张来源卡片投影出的多个角色合并成一条消息。`Read` 提供标题、段落和代码块阅读样式；`Original` 显示捕获到的原始块文本。thinking 默认折叠，图片按需加载。初次最多显示 24 个内容块，长文本按每块最多 16,000 个字符分页，后续内容通过加载按钮展开。

复制内容会保留角色标题、正文、thinking 和工具参数，并用图片元信息代替图片数据。这里的“原始”与“复制”都指扩展捕获的内容，不是 provider 请求的原始 JSON。检查器中的 provenance 会说明来源角色、模型角色和这条边界。

### 内容搜索

搜索支持中文、多词查询、大小写和 Unicode 空白归一化，每次最多展示 40 条结果。它搜索的是**有上限的索引摘录，不是全文**：每条最多索引 12,000 个字符，最多保留 10,000 条索引记录，摘录及归一化文本合计最多保留 8 MiB。图片 base64 不进入索引；工具参数只收录可识别的路径、命令或查询预览。

正文超出摘录范围，或条目未被索引时，都可能搜索不到。这不表示原内容不存在。8 MiB 是保留的摘录文本预算，索引对象、画布、完整消息和浏览器其他状态的内存不包含在这个数字里。

索引优先保留最新 10,000 条候选记录，并从最新记录开始分配文本预算；结果仍按时间顺序展示。750 条及以上时分片构建，每片最多 128 个工作项、目标时间预算 6 ms，完成后一次性替换索引。切换 session 或捕获会取消过期任务；重建期间显示索引状态，不展示上一份内容的搜索结果。原子替换可能短暂同时持有旧索引和新索引，各自最多 8 MiB 文本；单个工作项不能被时间预算中途打断。

### 大会话的后台工作与历史保留

750 条及以上的场景将几何布局交给同源 Web Worker，只传 ID、类型、顺序和连接关系，不传消息正文或图片。后台计算期间保留旧画面并显示更新状态，暂时禁用旧卡片入口；完成后提交最新结果。过期布局会取消；Worker 不可用时回退到主线程计算。JSON 解析、元数据整理及最终画布提交仍在主线程，不保证首次显示完全没有长任务。

每个运行时的历史默认保留最多 2,000 条、16 MiB 序列化 UTF-8 JSON 条目及摘要连接。超过任一预算时，优先删除最早的不活跃记录及其关联连接，以增量删除通知浏览器。当前 active / pending 条目始终受保护，即使它们本身超过预算；界面会明确提示超额，而不是悄悄丢弃当前上下文。运行时 API 的 `historyRetention: { maxItems, maxBytes }` 可调整预算，`ContextTimeline` 构造函数接受相同选项。

历史保留只影响 ContextRail 的内存视图，不删除 agent 的会话文件、不执行模型压缩，也不写入磁盘。它与捕获归档、搜索索引是独立预算，不能相加后当作进程堆内存上限。不可变条目与内容通过结构共享避免重复深拷贝，外部可变输入仍在入口复制隔离。

### 上下文捕获与回看

每个 session 默认最多保留 24 次捕获，捕获归档的**序列化 UTF-8 JSON** 预算为 8 MiB；达到数量或字节上限时会淘汰较早记录。这与浏览器搜索索引的 8 MiB 是两份独立预算，也不是整个进程或浏览器的堆内存上限。记录保存在内存中，不写入磁盘。

回看时，浏览器会额外持有一份所选归档，避免新捕获或淘汰让正在阅读的内容发生变化；返回最新或切换 session 后释放这份回看引用。实时缓冲仍按原有数量和字节上限淘汰。

捕获选择器可以回看仍可用的记录并比较相邻捕获的变化；返回实时视图不会控制或回退 agent。若单次捕获本身超过字节预算，会留下明确的内容不可用标记，不能回放其内容，也不能计算涉及它的内容差异。

一次捕获只证明 ContextRail 在上下文 hook 或 session 重建时观察到了那份内容，**不证明随后确实发生了模型调用**。Pi 的 session 恢复、树导航和压缩重建也可能形成记录。后续扩展和 provider 转换仍可能改变最终请求，ContextRail 不提供 provider 原始请求载荷。

运行独立演示：

```sh
npm run preview
```

打开命令打印的地址即可。演示走真实的 HTTP/SSE 通道，会定期模拟工具调用和上下文压缩，不需要启动 OMP 或 Pi。

## 架构

```text
OMP process A -----+
OMP process B -----+--> local ContextRail Hub --> HTTP/SSE --> web/index.html
Pi process A ------+          |
Pi process B ------+          +--> per-process/session read models

src/extension-runtime.ts  shared session runtime and Hub publisher
src/omp-extension.ts      OMP lifecycle adapter
src/pi-extension.ts       Pi lifecycle adapter
src/index.ts              OMP package entry
src/pi.ts                 Pi package entry
src/hub-client.ts         authenticated Hub publisher
src/hub-delta.ts          bounded state patches and reconstruction
src/hub-cli.ts            Hub lifecycle and discovery lock
src/server.ts             localhost ingest API and SSE server

src/snapshot.ts           normalized context model
src/timeline.ts           history and active-window reconciliation
src/context-captures.ts   bounded immutable context-observation archive

web/index.html            viewer shell, session store and DOM layer
web/src/scene-layout.ts   permanent positions and Window projection
web/src/camera.ts         renderer-neutral camera math
web/src/pixi-history.ts   virtualized history cards, edges and hit testing
web/src/content-view.ts   cached content previews and bounded excerpt search
web/src/inspector-view.ts paged nonmodal content-reader rendering and copy text
```

OMP 和 Pi 只负责把宿主事件转换成同一份 snapshot。时间线、Hub 和浏览器不需要知道事件来自哪个 agent。

## 开发

```sh
npm test
npm run typecheck
npm run build
npm run check
```

测试使用 Node.js 内置 test runner。`npm run build` 会生成独立的 OMP、Pi 入口和浏览器资源。

OMP 与 Pi 都是运行时宿主，不是项目依赖。仓库只定义宿主接口需要的少量结构类型，所以安装 ContextRail 时不会顺带安装另一个 agent。

## 数据与安全

- `context` 事件处理器没有返回值，不能替换宿主原本的消息列表。
- 卡片内容来自宿主的 agent-level context。后续扩展、provider 序列化、tokenization、缓存或安全处理仍可能改变最终请求。
- 捕获编号是观察记录，不是模型调用凭证；合成压缩标记也不是模型消息。字节受限记录不提供内容回放或内容差异。
- Pi 只有在发出 `session_compact` 后才记录压缩边界。取消或失败的压缩不会产生假的摘要节点。
- 发给 Hub 的数据经过字段白名单。原始消息 ID、tool call ID、时间戳、provider signature、response ID、usage 明细和扩展私有字段不会离开 agent 进程。
- 消息详情只存在于 agent 进程、Hub 内存和打开的浏览器页面中，不写入磁盘。断开的 session 最多在 Hub 中保留一小时。
- Hub 绑定随机的 `127.0.0.1` 端口，并拒绝跨源读取。
- producer 和 viewer 使用两把不同的随机 capability。它们保存在当前用户私有的临时 discovery 文件中。
- 浏览器地址只带只读 capability，不能发布状态、发送 heartbeat 或断开 producer。拿到该地址的人可以读取 Hub 内存里的卡片内容，所以不要把它当普通公开链接分享。
- 服务端没有 CORS 响应头，并使用限制严格的 Content Security Policy。
- 浏览器没有切换 agent session、发送 prompt、abort 或关闭 agent 的接口。
- ContextRail 不监听 token 级 `message_update`，避免每个 token 都触发 TUI 和画布更新。

总 token 用量由宿主提供。目前没有可靠的逐消息 token 统计。

## 后续计划

- 允许 Hub 在机器重启后恢复历史。
- 给 pinned context 增加更明确的来源信息。
- 为超长 session 增加可配置的内存保留策略。
- 宿主提供可靠数据后，再显示每张卡片的 token 权重。
- 为后续 OMP 和 Pi 生命周期版本增加兼容性 fixtures。

## License

MIT
