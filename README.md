# StreamLens（网页视频画质检测）

Chrome Manifest V3 扩展。自动识别网页中 HTML5 `<video>` 的真实分辨率、帧率、码率、编码格式和丢帧率，并给出画质评级（例如 `1080P 蓝光 60帧`、`⚠ 疑似假1080P（码率过低）`）。纯原生 JavaScript，无需构建，无 npm 依赖。

StreamLens is an MV3 extension that inspects the real resolution, FPS, bitrate, codec and dropped frames of web videos. No build step, no dependencies.

## 安装

扩展没有上架 Chrome 商店，从 GitHub 下载后手动加载。支持 Chrome 111 及以上，以及 Edge、Brave 等 Chromium 内核浏览器。

1. 打开本仓库的 **Releases** 页面，下载最新的 `stream-lens-x.y.z.zip`（也可以在仓库首页点 **Code → Download ZIP**）。
2. 解压到一个固定位置，之后不要删除或移动这个文件夹，浏览器会一直从这里读取扩展。
3. 在地址栏打开 `chrome://extensions`（Edge 是 `edge://extensions`）。
4. 打开右上角的 **开发者模式**。
5. 点击 **加载已解压的扩展程序**，选择解压出来的文件夹（里面直接能看到 `manifest.json`）。
6. 点击工具栏的拼图图标，把 StreamLens 固定到工具栏。
7. 刷新已经打开的网页，扩展才会注入这些页面。

更新版本时，下载新的 zip，覆盖原文件夹的内容，然后在 `chrome://extensions` 点击 StreamLens 卡片上的刷新按钮，再刷新网页。

Chrome 重启后可能提示“停用开发者模式的扩展程序”，点 **取消** 或关闭提示即可，不会影响使用。这是手动安装方式的限制。

## 使用说明

1. 打开任意视频网页并播放，视频右上角会出现一个半透明悬浮窗，显示三行信息：视频（编码、分辨率、帧率）、音频（编码、采样率、声道）、码率和下载速度。左侧色条的颜色表示画质：绿色是高码率，蓝色是标准，红色是码率偏低，灰色是无法判断。
2. 工具栏图标上的角标显示当前视频的分辨率档位（如 `1080`、`4K`），点击图标打开详情面板，可以看到画质评级、丢帧统计、视频来源和播放状态。
3. 悬浮窗的开关：
   - 按 `Alt+Shift+V`（Mac 上是 Option+Shift+V）显示或隐藏悬浮窗。
   - 悬浮窗上的 `暂停` 按钮临时停止检测并保留悬浮窗，再点 `开启` 恢复。
   - 点悬浮窗右上角的 `×` 会隐藏悬浮窗并停止检测，需要在详情面板里重新打开 `检测` 和 `悬浮窗` 两个开关。
4. 评级如何看：
   - `高码率 / 真蓝光` 表示码率达到该分辨率档位的高档标准。
   - `⚠ 疑似假1080P（码率过低）` 表示分辨率标称 1080P，但码率远低于正常水平，多半是低码率片源放大而来。
   - 码率按编码效率折算，H.265、VP9、AV1 的门槛比 H.264 低。具体阈值见后文“评级规则简述”。
5. 常见问题：
   - **悬浮窗没出现**：刷新网页；确认 `检测` 和 `悬浮窗` 开关都是开的；浏览器内置页（`chrome://`）和应用商店页不能使用。
   - **没有音频行或下载速度**：直链 MP4 没有这些数据，只有 YouTube、B站这类自适应流媒体才有。
   - **码率显示“未知”**：浏览器没有提供解码字节数，或视频受 DRM 保护。
   - **全屏时看不到悬浮窗**：网页如果把 `<video>` 本身全屏，浏览器只渲染视频，悬浮窗无法显示，请在非全屏或网页全屏下查看。
   - 扩展不收集、不上传任何数据，只保存两个开关状态在本机浏览器里。

## 功能概览

- **检测开关**：Popup 顶部的 `检测画质` 开关，默认开启，对所有标签页和 frame 全局生效。关闭后内容脚本停止所有检测定时器、观察器、事件监听和 `requestVideoFrameCallback` 循环，不再读取视频指标，Badge 清空；OSD 不会消失，而是变成只显示 `检测已关闭` 的静态面板（灰色圆点，不显示任何指标，数值不会再变化）；重新打开后无需刷新页面即可恢复。状态保存在 `chrome.storage.local` 的 `detectionEnabled` 键中，浏览器重启后仍然保留。OSD 上的 `暂停` / `开启` 按钮可直接开关检测（写入同一个 `detectionEnabled`，Popup 开关会同步），不必再打开扩展菜单。OSD 右侧的关闭按钮（×）会隐藏悬浮窗并同时关闭检测，需要在 Popup 中重新打开悬浮窗开关和 `检测画质` 才会恢复。`Alt+Shift+V` 和 Popup 底部开关只控制 OSD（`osdEnabled`），检测开启或关闭时都有效。
- **图标 Badge**：在工具栏图标上显示当前页面最佳视频的分辨率档位（如 `1080`、`4K`），颜色代表档位。
- **Popup 详情面板**（300px 宽，约 270px 高，深色紧凑布局）：标题行右侧是 `检测` 开关；下方依次是画质评级与徽章、和悬浮窗相同的三行信息（视频 / 音频 / 码率与下载速度）、一行丢帧、视频来源和播放状态；底部是悬浮窗开关。没有音频信息时音频行自动隐藏。
- **网页悬浮监控面板 (OSD)**：显示在视频右上角，固定三行，每行带图标，左侧色条表示画质等级（绿 / 蓝 / 红 / 灰）：
  ```
  H.264 · 1920×1080 · 25.4 fps
  AAC · 48 kHz · 2.0
  码率 712 kb/s · 下载 753 KB/s
  ```
  音频行在拿不到音频信息时隐藏，下载速度在拿不到时不显示。可用 `Alt+Shift+V` 或 Popup 开关显示或隐藏，全屏播放时仍然可见。检测关闭时悬浮窗保持显示，内容为 `检测已关闭`，按钮变为 `开启`；点击 `暂停` 可临时停止检测并保留悬浮窗，点击 `开启` 恢复。点击关闭按钮（×）会隐藏悬浮窗并停止检测（关闭 `检测画质`），不是只隐藏悬浮窗。
- **多 frame 支持**：内容脚本运行在所有 frame，`background.js` 汇总每个 tab 的各 frame 数据并选出"最佳视频"（优先播放中，其次画面面积最大）。
- **MSE 编码识别**：在 MAIN world 钩住 `MediaSource.addSourceBuffer`、`SourceBuffer.changeType` 和 `SourceBuffer.appendBuffer`，识别 YouTube、B站等站点的 H.264 / VP9 / AV1 / H.265 视频编码和 AAC / Opus 等音频编码。采样率和声道数从 fMP4 / WebM 初始化段（只读前 64 KB）里解析，下载速度由 `appendBuffer` 累计字节数的 3 秒增量得出。
- **暂停时保留指标**：暂停时显示最近一次有效码率和帧率，并标注"已暂停"，不会显示 0 kbps。
- **码率未知时降级**：`webkitVideoDecodedByteCount` 不可用时码率显示 `不支持/未知`，分辨率和帧率不受影响。

权限仅 `storage` 与 `activeTab`，没有 `webRequest`，不读取网络请求。

## 目录结构

```
stream-lens/
├── manifest.json               MV3 清单、快捷键、内容脚本注册
├── background.js               Service Worker：汇总各 frame 数据、Badge、快捷键、GET_TAB_STATE
├── content_main.js             MAIN world：钩住 MediaSource，经 postMessage 上报编码
├── content_isolated.js         ISOLATED world：发现 video、统计指标、OSD、上报给 background
├── utils/quality_evaluator.js  纯函数：分辨率档位、码率评级、编码解析、格式化、最佳视频选择
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── icons/                      icon16 / icon48 / icon128（由 tools/generate_icons.js 生成）
├── tools/
│   ├── generate_icons.js       生成图标，纯 node
│   └── validate.js             校验 manifest、引用文件、图标，并对所有 js 做语法检查
└── tests/
    ├── *.test.js               node:test 单元测试（evaluator、content、background、popup）
    └── manual/
        ├── test.html           手动测试页
        └── iframe_player.html  手动测试用的嵌套播放器页
```

## 从源码加载（开发）

1. 克隆本仓库：`git clone <仓库地址>`。
2. 按上文“安装”的步骤 3 到 5 操作，选择仓库根目录（包含 `manifest.json` 的那一层）。
3. 修改代码后，在 `chrome://extensions` 点击扩展卡片上的刷新按钮，并刷新被测网页。

要在 `file://` 页面中测试，请在扩展详情页打开 **允许访问文件网址**。

### 修改快捷键

默认快捷键是 `Alt+Shift+V`（macOS 同样是 `Alt+Shift+V`，即 Option+Shift+V）。打开 `chrome://extensions/shortcuts`，找到 StreamLens 的"开启/关闭网页悬浮监控面板 (OSD)"，即可修改。如果快捷键与其他扩展冲突，Chrome 会让该项显示为"未设置"，需要手动指定。

## 手动测试（对应 PRD 第 7 节）

本仓库的开发环境无法启动 Chrome，下面的步骤需要在真实 Chrome 中执行。自动化检查见后文。

准备：准备一个本地 MP4 文件（H.264 即可），另备一个 1920x800 的电影片源（2.39:1）。可用 ffmpeg 生成：

```
ffmpeg -f lavfi -i testsrc2=size=1920x800:rate=24 -t 30 -c:v libx264 -b:v 4M test_1920x800.mp4
```

| # | PRD 第 7 节场景 | 步骤 | 预期结果 |
|---|---|---|---|
| 1 | 普通 MP4 页面 | 打开 `tests/manual/test.html`，选择本地 MP4，播放第 1 个播放器。 | Badge 出现档位文字（如 `1080`）；Popup 显示正确的分辨率、FPS、码率和 `H.264 (AVC)` 或 `MP4 (直链)`；视频来源为 `主页面`，状态为 `播放中`。 |
| 2 | 禁止右键与 iframe | 在同一页面播放第 2 个播放器（`oncontextmenu="return false"`）。再在第 3 个 iframe 里选择文件播放；也可以按页面提示用 `python3 -m http.server 8000` 起服务，点击"切换为跨域 iframe"。 | 禁止右键不影响抓取。iframe 内视频能被识别，Popup 的视频来源显示 `Iframe 嵌套播放器`。 |
| 3 | 1920x800 判定 | 播放 `test_1920x800.mp4`。 | Popup 分辨率为 `1920 × 800`，评级标签以 `1080P` 开头，不是 `720P`；比例显示 `2.40:1 宽屏`。 |
| 4 | MSE 站点与清晰度切换 | 打开 YouTube 或 B站，播放任意视频，再手动切换清晰度（如 720P 到 1080P）。 | 编码格式显示 `H.264` / `VP9` / `AV1` 等名称；切换清晰度后 1 到 2 秒内分辨率、码率和评级自动更新。 |
| 5 | OSD 开关与全屏 | 播放视频后按 `Alt+Shift+V`；再用 Popup 底部开关切换；最后进入全屏。 | 视频右上角悬浮窗立即显示或隐藏，Popup 开关与快捷键状态同步；全屏时悬浮窗仍可见（外层容器全屏时）。 |
| 6 | 检测开关 | 播放视频，确认 Badge 和 OSD 正常。打开 Popup，关闭顶部的 `检测画质` 开关。再打开开关。关闭期间按 `Alt+Shift+V`。 | 关闭后 Badge 为空，OSD 仍然显示，内容变为 `检测已关闭`，按钮变为 `开启`，面板上的任何数值、圆点颜色和 `已暂停` 标记都不再变化（观察几秒，暂停或拖动视频也不变）。Popup 显示"检测已关闭，打开上方开关后开始检测"。重新打开后不刷新页面，约 2 秒内 Badge、OSD 和 Popup 数据恢复。`Alt+Shift+V` 只控制 OSD，关闭期间按它不会恢复检测，只会隐藏或显示这个 `检测已关闭` 面板，重新开启检测后 OSD 按最后一次的开关状态显示。 |
| 7 | OSD 关闭按钮 | 播放视频，确认 Badge 和 OSD 正常。点击 OSD 右侧的 `×`。再打开 Popup，查看顶部开关和底部悬浮窗开关。重新打开这两个开关。 | 点击 `×` 后 OSD 立即消失，Badge 清空，Popup 顶部 `检测画质` 开关和悬浮窗开关都变为关闭，Popup 显示"检测已关闭，打开上方开关后开始检测"。重新打开两个开关后不刷新页面，约 2 秒内 Badge、OSD 和 Popup 数据恢复。 |
| 8 | OSD 检测按钮 | 播放视频，点击 OSD 上的 `暂停`。观察几秒后点击 `开启`。再点击 `暂停`，打开 Popup 看顶部开关，在 Popup 中重新打开开关。 | 点击 `暂停` 后 OSD 保留，显示 `检测已关闭`，Badge 清空，Popup 顶部开关同步为关闭，面板数值不再变化。点击 `开启` 后约 2 秒内 OSD 恢复指标，Badge 恢复。在 Popup 中打开开关时 OSD 按钮同步变回 `暂停`。 |

补充检查：

- **暂停**：播放后暂停，Popup 的来源状态变为 `已暂停`，码率和帧率保留最近值，不会变成 0。
- **假高清**：播放码率明显偏低的 1080P 视频（如 `-b:v 500k`），徽章应显示 `⚠ 疑似假1080P（码率过低）`。
- **无视频页面**：打开一个没有视频的页面或 `chrome://extensions`，Popup 显示空状态"当前页面未检测到正在播放的 HTML5 视频，或视频使用 Canvas 渲染"，Badge 为空。
- **SPA 切集**：B站连续剧切换下一集，编码和码率不应沿用上一集的旧值。
- **多视频页面**：同一页面有多个视频时，Popup 显示正在播放的、面积最大的那个。

## 自动检查

在仓库根目录运行：

```
node tools/validate.js
node --test 'tests/*.test.js'
```

- `validate.js` 检查 manifest（MV3、权限恰好为 `storage` 与 `activeTab`、内容脚本配置）、引用文件是否存在、图标尺寸，并对每个 `.js` 运行 `node --check`。
- 测试使用 Node 内置测试运行器（需要 Node 18 或更高版本）。在 Node 22 上请使用带引号的 glob 写法，直接传目录会报 `MODULE_NOT_FOUND`。
- 单元测试用 `node:vm` 加上假的 DOM 和 `chrome` API，覆盖评级函数、MAIN world 钩子、内容脚本、后台汇总和 Popup 渲染，包括检测开关的开启、关闭和恢复，以及检测关闭时 OSD 保持显示且数值不再变化、OSD 检测按钮、OSD 关闭按钮隐藏悬浮窗并关闭检测、写入失败时恢复检测。

## 打包发布（维护者）

发布时只需要运行时文件，不要带上 `tests/`、`tools/`。把 `manifest.json` 里的 `version` 改好后，在仓库根目录运行：

```
zip -r stream-lens-1.0.0.zip manifest.json background.js content_main.js content_isolated.js utils popup icons -x "*.DS_Store"
```

然后在 GitHub 的 **Releases → Draft a new release** 里创建同版本号的 tag（如 `v1.0.0`），把 zip 作为附件上传。

## 重新生成图标

```
node tools/generate_icons.js
```

脚本只依赖 node 自带的 `fs`、`path`、`zlib`，会覆盖 `icons/` 下的三个 PNG。

## 评级规则简述

分辨率档位按"长边 / 短边"判断，所以 1920x800 这类宽银幕片源判为 1080P，竖屏视频同样适用。码率按档位和编码效率折算后评级：

| 档位 | 偏低 (low) | 偏高 (high) |
|---|---|---|
| 4K | 低于 6000 kbps | 高于 14000 kbps |
| 2K | 低于 3500 kbps | 高于 8000 kbps |
| 1080P | 低于 1500 kbps | 高于 4000 kbps |
| 720P | 低于 800 kbps | 高于 2000 kbps |
| 480P | 低于 400 kbps | 高于 1000 kbps |
| 360P 及以下 | 低于 200 kbps | 高于 600 kbps |

阈值是按编码效率折算后的有效码率（H.265、VP9、AV1 比 H.264 效率更高）。480P 及以下的阈值是实现时的经验取值，可在 `utils/quality_evaluator.js` 的 `BITRATE_THRESHOLDS` 中调整。

## 已知限制

- **音频与下载速度只覆盖 MSE 播放**：直链 MP4 / WebM 没有 `addSourceBuffer`，浏览器也不向扩展暴露音频参数和下载量，此时悬浮窗只显示视频行和码率，音频行隐藏。下载速度是播放器喂给解码器的数据量，不等于网卡实际流量；预缓冲阶段会高于码率，缓冲满之后接近 0。
- **采样率和声道只认 fMP4 / WebM 初始化段**：其他容器只显示音频编码名，没有采样率和声道。
- **Canvas / WebGL 渲染的播放器**：没有 `<video>` 元素可读，无法检测，Popup 会显示空状态。
- **DRM 受保护内容**：解码字节数和帧统计可能不可用，码率会显示 `不支持/未知`。
- **码率是估算值**：通过 `webkitVideoDecodedByteCount` 的增量计算，是解码字节数的滑动平均，不等于容器的标称码率。该属性是非标准接口，浏览器可能不提供。
- **MSE 编码按 frame 记录**：同一个 frame 内有两个 MSE 视频时，以最近一次 `addSourceBuffer` 的编码为准。
- **MSE 钩子在 document_start 注入**：极少数在扩展注入之前就创建了 MediaSource 的页面可能识别不到编码，此时回退为按 `src` 推断或显示未知。
- **受限页面**：`chrome://`、Chrome 应用商店、扩展页等不允许注入内容脚本，Popup 会显示空状态。
- **Service Worker 会休眠**：`background.js` 的内存状态可能丢失，内容脚本每秒的心跳会重新填充，状态同时镜像到 `chrome.storage.session`。
- **检测关闭时 MAIN world 钩子仍在**：页面 API 无法被还原，所以关闭检测后 `content_main.js` 对 `MediaSource` 和 `attachShadow` 的钩子仍然保留，只做被动记录，不读取视频指标，也不向 background 发送报告。关闭检测前已加载的页面，重新打开后约 1 秒内恢复上报，之前记录的编码会重新同步。
- **最低 Chrome 版本**：需要 Chrome 111 或更高（`content_scripts` 的 `world` 字段需要 111，`storage.session` 需要 102，`setBadgeTextColor` 需要 110）。
- **检测关闭时每个 frame 可能各有一个面板**：检测关闭后 background 不再选举最佳视频，所以每个含有较大视频（宽至少 160、高至少 90 像素）的 frame 都可能显示自己的 `检测已关闭` 面板。位置由每约 1.5 秒一次的轻量定时器更新（只查询 `<video>` 的位置，不读取指标、不监听视频事件、不发送消息），视频移动后面板最多延迟约 1.5 秒跟随。该定时器只在悬浮窗开关开启时运行。idle 模式下找不到 Shadow DOM 内的视频，所以面板和 `开启` 按钮只会出现在普通文档里的视频上。
- **每个标签页只有一个悬浮窗**：background 选出标签页内的最佳视频，只有该视频所在的 frame 显示 OSD（最多有约 1 秒延迟）。其他 frame 的视频不显示悬浮窗。如果拥有 OSD 的 iframe 被直接移除而没有发出最后一次报告，background 在约 3 秒（两次心跳）后不再把它计入选举，之后其他 frame 才会显示悬浮窗，Badge 和 Popup 同理；该条目在 5 秒后被彻底清除。
- **Shadow DOM 发现方式**：content_main.js 在页面创建 shadow root 时通知内容脚本，之后才会遍历 DOM 查找其中的 `<video>`（两次遍历至少间隔 2 秒），另有每 30 秒一次的兜底遍历。通过声明式 Shadow DOM（`<template shadowrootmode>`）创建的 root 不经过 `attachShadow`，最长要等 30 秒才能被发现。
- **`about:blank` 和 `srcdoc` 框架**：已设置 `match_about_blank`，可以注入。`blob:` 和 `data:` 框架不会被注入，里面的播放器检测不到。
- **MSE 在 Worker 中运行**：content_main.js 看不到 Worker 内的 `addSourceBuffer`，此时编码显示"未知编码"，码率评级不会给出"偏低"的结论。
- **标签页加载状态与导航**：iframe 加载也会让标签页状态变为 `loading`，而且在只有 `storage` 和 `activeTab` 权限时，`tabs.onUpdated` 通常不带 `url`。因此 background 不依赖它：顶层 frame（frameId 0）每次报告都带有 `documentId`，`documentId` 变化即表示加载了新的顶层文档（跳转或刷新），此时丢弃其他 frame 的旧条目；只有子 frame 加载不会改变它，所以不会清掉有效数据。顶层 frame 在没有视频时也会发送一次 `hasVideo: false` 作为通知。限制：新页面的子 frame 如果在顶层 frame 的第一次报告之前就报告过，会被一并丢弃，约 1 秒内由下一次心跳补回；旧页面在导航提交前的最后一次心跳仍可能让旧数据最多保留 5 秒。如果 background 在导航前已被重启，第一次报告只记录 `documentId`，旧数据同样靠 5 秒清理。带 url 的 `loading` 事件仍会立即清空该标签页的数据。
- **OSD 在页面全屏元素之外的位置**：OSD 会被迁移到全屏元素内部。如果播放器全屏的是 `<video>` 本身，浏览器只渲染该元素，悬浮窗无法显示，这时请看 Popup 或 Badge。
