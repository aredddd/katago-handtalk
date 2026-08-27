# 手谈 · KataGo 本地复盘桌面版

[![CI](https://github.com/aredddd/katago-web/actions/workflows/ci.yml/badge.svg?branch=beginner-local)](https://github.com/aredddd/katago-web/actions/workflows/ci.yml)
![Platform](https://img.shields.io/badge/platform-Windows-2f80ed)
[![License](https://img.shields.io/badge/license-mixed%20%E2%80%94%20see%20LICENSE-f59e0b)](LICENSE)

面向围棋新手的本地 KataGo 桌面复盘工具。它把常用操作、截图导入、近实时
棋盘识别和 AI 推演放进一个轻量窗口；服务只监听 `127.0.0.1`，棋谱、截图和
分析数据默认都留在本机。

![手谈主界面：中盘局面、KataGo 推荐点和双栏控制区](docs/screenshots/main-interface.png)

## 功能

- 自由推演，或选择执黑 / 执白和 AI 对弈
- 悔棋、停一手、认输、新对局和全盘形势判断
- 随时开启 / 关闭 KataGo 分析，查看推荐点、胜率、目差和主要变化
- 从文件选择截图、拉起 Windows 截图工具，或直接粘贴剪贴板图片
- 导入后先修正识别结果、指定下一手方，再从中局继续推演
- 共享一个棋局窗口做近实时复盘；稳定确认后自动同步局面
- 窗口置顶、macOS 风格毛玻璃界面，以及窄窗口纵向自适应布局

## 截图导入

![截图识别后的棋盘校正和下一手确认](docs/screenshots/screenshot-import.png)

截图卡片提供三种入口：

1. **选择截图**：读取 PNG / JPG 文件。
2. **打开系统截图**：拉起 Windows 截图工具，截完回到应用按 `Ctrl+V`。
3. **粘贴截图**：直接读取剪贴板图片；窗口聚焦时按 `Ctrl+V` 也可以。

识别完成后会显示置信度和建议检查的交叉点。点击预览盘可让一个交叉点在
“空位 → 黑子 → 白子 → 空位”之间切换。确认下一手方后再载入，适合从任意
中盘局面开始复盘。

> 截图识别目前只支持 19 路。截图本身不能恢复落子顺序，也无法判断刚才是否
> 停了一手；必要时请手动选择“当前轮到”。

## 快速开始

### 当前预设环境

当前启动脚本按这台开发机的目录和 RTX 5060 Laptop 配置制作：

```text
outputs/
├─ KataGo-Web-Beginner/       # 本项目
│  └─ models/image2sgf/       # board.pth、stone.pth（不提交）
├─ KataGo/                    # katago.exe 与棋力模型
└─ KaTrain/analysis_5060.cfg  # KataGo 分析配置
```

默认棋力模型文件名为
`kata1-tf2-b10c384-s2941M-d5872M.bin.gz`。换电脑或换模型时，目前需要同步调整
`config.ini`、`setup-local.ps1` 和 `start-local.ps1` 中的路径；它还不是一个
内置引擎和模型的通用安装包。

### 桌面版（推荐）

第一次安装或代码更新后，双击：

```text
desktop\install-desktop.cmd
```

脚本会构建轻量 Windows 桌面壳，并在桌面和开始菜单创建“手谈 KataGo”快捷
方式。以后双击快捷方式即可自动检查环境、启动本地服务、连接 KataGo 并打开
棋盘；关闭窗口时会一并清理它启动的后端。KataGo、CUDA/PyTorch 和模型继续
复用项目环境，不会重复打包数 GB 数据。详见
[桌面版说明](desktop/DESKTOP.md)。

### 浏览器版（备用）

第一次运行：

```powershell
.\setup-local.ps1
```

日常使用双击 `start-local.cmd`，或在 PowerShell 中运行：

```powershell
.\start-local.ps1 -NoBrowser
```

服务就绪后访问 `http://127.0.0.1:5000/`。退出时在启动窗口按 `Ctrl+C`。
详细环境检查和 CPU 识图选项见 [本地启动说明](LOCAL-SETUP.md)。

## 近实时复盘

点击“开始实时复盘”，在系统共享窗口中选择包含棋盘的窗口。程序只截取共享
画面并在本机识别，不会替你点击第三方棋局，也不会注入或覆盖其他应用。

- 每帧都重新识别完整棋盘，不沿用上一帧的低置信度点。
- 单步合法变化连续两帧一致后同步；漏过多手或规则校验失败时，同一完整局面
  在多个视频帧中稳定后自动重新同步。
- 手动确认过的截图局面会作为实时复盘基线。
- 停止共享会立即取消识别和在途分析。

## 开发与测试

Python 3.11 和 Node.js 24 可运行全部测试；测试不需要真实 KataGo、GPU 或模型：

```powershell
python -m pip install -r requirements-dev.txt
python -m pytest -q
node --test tests/frontend_contract.test.mjs tests/frontend_desktop_contract.test.mjs tests/goboard_state.test.mjs tests/live_review_state.test.mjs
```

后端对同一浏览器会话只保留最新分析；新的分析 / AI 请求会终止旧查询。
KataGo stdout 中断会立即唤醒等待者，避免界面长时间假死。

## 已知限制

- 桌面壳当前仅支持 Windows 10 / 11，并依赖 Microsoft Edge WebView2 Runtime。
- 识图模型只支持 19 路，且复杂背景、透视过大或棋子反光时仍需人工校正。
- `board.pth`、`stone.pth`、KataGo 引擎和棋力模型均不在仓库中。
- 当前安装脚本是 RTX 5060 Laptop 预设，不保证其他目录结构可直接运行。

## 参与项目

提交问题或改动前请阅读 [贡献指南](CONTRIBUTING.md)。普通缺陷和功能建议可使用
GitHub Issues；安全问题请按 [安全策略](SECURITY.md) 私下报告。请勿提交模型、
引擎二进制、真实棋局账号信息或包含个人数据的截图。

## 许可与第三方

本项目不是一个可以无条件整体标为 MIT 的单一来源代码库：

- `aredddd` 及后续贡献者为这个分支创作的原创修改采用 [MIT 条款](LICENSE)。
- 原项目 [michelzzw/katago-web](https://github.com/michelzzw/katago-web) 的 README
  声明为 MIT，但截至 2026-08-28 没有完整许可证文件。
- `server/noword_recognizer.py` 基于
  [noword/image2sgf](https://github.com/noword/image2sgf)；该上游及其模型目前没有
  明确许可证。因此本仓库不打包或重新分发识图权重，MIT 授权也不覆盖对应的
  第三方衍生部分。
- KataGo、KataGo 网络、KaTrain 音效和 Socket.IO Client 各自适用上游许可。

完整归属、收录范围和再分发注意事项见
[第三方声明](THIRD_PARTY_NOTICES.md)。归属说明不能替代授权；若要将整个仓库
明确作为单一 MIT 项目发布，仍需原项目作者和 `image2sgf` 作者补充许可，或用
独立实现替换相关识别代码与权重。
