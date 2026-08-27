# 第三方声明

本文记录仓库中直接收录、改写或在本地运行时配合使用的主要第三方项目。它不是
法律意见；归属说明本身也不会补足缺失的授权。

## 仓库中包含的内容

### KataGo Web

- 来源：<https://github.com/michelzzw/katago-web>
- 范围：本仓库的基础代码和历史。
- 已知许可状态：上游 README 从初始版本起标有 “MIT”，但截至 2026-08-28
  仓库中没有完整 `LICENSE`，GitHub 也未识别出许可证。
- 注意：本仓库保留上游归属；根目录 `LICENSE` 只授权本分支贡献者拥有权利的
  原创修改，并不代替上游作者作出新的许可声明。

### noword/image2sgf

- 来源：<https://github.com/noword/image2sgf>
- 范围：`server/noword_recognizer.py` 的棋盘定位、透视校正和 361 点分类流程基于
  该项目；运行时可选用其 `board.pth`、`stone.pth` 权重。
- 已知许可状态：截至 2026-08-28，源仓库、发布页和模型文件均未提供明确许可。
- 注意：权重被 `.gitignore` 排除，本仓库不镜像或重新分发它们。根目录 MIT
  授权不覆盖相应第三方衍生部分。公开再分发前应先获得作者明确授权，或改用具有
  清晰许可的独立实现和模型。

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

### Python 与桌面构建依赖

`requirements.txt`、`desktop/requirements-desktop.txt` 和 PyTorch 安装步骤会从各自
上游安装依赖。源码仓库没有把这些依赖重新打包。若发布 PyInstaller 桌面成品，
应基于实际构建产物生成依赖清单，并附 Python、PyInstaller、pywebview、OpenCV、
Flask、PyTorch、CUDA/cuDNN 及其间接组件要求的许可证或声明。

## 发布前检查

1. 不提交或上传 `board.pth`、`stone.pth`、KataGo 模型或未经授权的截图。
2. 如果二进制包包含 KataGo、CUDA 或 Python 依赖，按实际文件重新做许可盘点。
3. 若上游补充或变更许可证，更新本文和 `third_party/` 中的副本。
4. 第三方名称仅用于归属，不表示其作者为本项目背书。
