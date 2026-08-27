# 第三方声明

本文记录仓库中直接收录、改写或在本地运行时配合使用的主要第三方项目。它不是
法律意见；归属说明本身也不会补足缺失的授权。

## 仓库中包含的内容

### KataGo Web

- 来源：<https://github.com/michelzzw/katago-web>
- 范围：本仓库的基础代码和历史。
- 许可：上游 README 从初始版本起声明 “MIT”；本仓库保留其归属，并在根目录
  [`LICENSE`](LICENSE) 中同时保留上游与本项目贡献者的 MIT 声明。上游仓库本身
  截至 2026-08-28 未提供单独的完整许可证文件。

### KaTrain 音效

- 来源：<https://github.com/sanderland/katrain/tree/main/katrain/sounds>
- 范围：`static/sounds/capturing.wav`、`stone1.wav` 至 `stone5.wav`。
- 版权：Copyright 2020 Sander Land and/or other authors.
- 许可：KaTrain 许可证对仓库列出的少数资产作出例外，其余内容采用 MIT 条款。
  本仓库中的六个 WAV 与 KaTrain 对应文件一致；完整适用文本收录在
  [`third_party/KaTrain-LICENSE.txt`](third_party/KaTrain-LICENSE.txt)。

### Socket.IO Client

- 来源：<https://github.com/socketio/socket.io-client>
- 范围：`static/vendor/socket.io.min.js`。
- 许可：MIT；许可证副本位于
  [`static/vendor/socket.io-client-LICENSE`](static/vendor/socket.io-client-LICENSE)。

## 仓库不包含、但本地运行会使用的内容

### KataGo 引擎

- 来源：<https://github.com/lightvector/KataGo>
- 范围：相邻 `KataGo` 目录中的 `katago.exe`；不受 Git 跟踪。
- 许可：KataGo 主体采用 MIT 类条款并包含若干各自许可的第三方组件。官方文本的
  当前副本见 [`third_party/KataGo-LICENSE.txt`](third_party/KataGo-LICENSE.txt)。
- 再分发：若发布含引擎的安装包，必须同时带上 KataGo 官方许可证及其二进制所含
  第三方组件的许可证。

### KataGo 神经网络

- 来源：<https://katagotraining.org/networks/>
- 范围：当前预设使用官方 `kata1` 网络；模型文件不受 Git 跟踪。
- 许可：官方 `kata1` 网络适用 KataGo Neural Network License。相关文本副本见
  [`third_party/KataGo-Network-LICENSE.txt`](third_party/KataGo-Network-LICENSE.txt)。
  其他贡献者网络可能采用不同条款，替换模型时应重新确认。

### 可兼容的截图识别权重

- 本仓库中的 `server/vision_recognizer.py` 是为本项目编写的独立实现；源码按根目录
  MIT 许可证提供。
- 它可以读取符合其 FCOS / EfficientNet 检查点结构的用户自备权重，包括可能从
  [noword/image2sgf](https://github.com/noword/image2sgf) 取得的兼容文件。
- 截至 2026-08-28，`noword/image2sgf` 仓库及发布的 `board.pth`、`stone.pth`
  未提供明确许可证。本仓库和 Release 均不包含、镜像、自动下载或重新分发任何
  识图权重；用户应只选择自己有权使用的文件，并自行确认适用许可。

### Python 与桌面构建依赖

便携 ZIP 会打包轻量桌面壳所需的 Python、PyInstaller、PyWebView、WebView2 loader、
pythonnet 与间接组件，但不打包 Flask、OpenCV、PyTorch 或 CUDA。构建脚本从实际
制品生成 Python 包清单与逐文件原生组件清单，并在 `licenses/` 中收录项目、Python、
OpenSSL、libffi、WebView2、.NET facade 和桌面依赖的许可证/NOTICE；任何必需文本、
固定来源或二进制哈希缺失都会使发布打包失败。

首次运行按用户选择从哈希锁文件安装 Flask 及可选的 CPU / CUDA 识图依赖到本机
`%LOCALAPPDATA%` 运行环境。这些后下载组件不是 Release ZIP 的组成部分，各自继续
适用其上游许可证。

桌面壳使用的 `proxy_tools 0.1.0` wheel 没有携带许可证文件，且包元数据与上游
仓库的许可证标识不一致。发行构建采用上游仓库 `LICENSE.txt` 的 BSD 文本，其
固定副本收录在 [`third_party/proxy_tools-LICENSE.txt`](third_party/proxy_tools-LICENSE.txt)；
桌面构建还会从实际构建环境提取其他 Python 包的许可文件和版本清单。

## 发布前检查

1. 不提交或上传 `board.pth`、`stone.pth`、KataGo 模型或未经授权的截图。
2. 如果二进制包包含 KataGo、CUDA 或 Python 依赖，按实际文件重新做许可盘点。
3. 若上游补充或变更许可证，更新本文和 `third_party/` 中的副本。
4. 第三方名称仅用于归属，不表示其作者为本项目背书。
