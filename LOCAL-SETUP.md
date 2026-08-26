# 本地新手版启动说明

这套启动方式专为当前 `outputs` 目录准备：KataGo Web 会复用旁边已经配置好的
RTX 5060 CUDA 引擎、棋力模型和分析配置，同时把 Python 与全部依赖保存在项目内。

## 第一次运行

在项目目录打开 PowerShell：

```powershell
.\setup-local.ps1
```

脚本会创建 `.runtime` 和 `.venv`，安装 Python 3.11、Web 依赖，以及支持
RTX 5060 的 CUDA 12.8 PyTorch。以后这些目录可以随时删除并重新生成，不纳入 Git。

截图识别还需要以下两个上游权重（大型文件不会提交到 Git）：

```text
models/image2sgf/board.pth
models/image2sgf/stone.pth
```

若缺失，安装脚本会在联网安装前停止并给出路径。权重可从
[noword/image2sgf Releases](https://github.com/noword/image2sgf/releases) 获取；重新
分发前请确认其上游许可。

## 日常启动

双击 `start-local.cmd`。服务准备好后会自动打开：

```text
http://127.0.0.1:5000
```

服务固定只监听本机回环地址，不接受局域网或公网连接。退出时在启动窗口按
`Ctrl+C`。如做自动化测试、不希望弹出浏览器，可运行：

```powershell
.\start-local.ps1 -NoBrowser
```

## 当前硬件配置

- KataGo：`..\KataGo\katago.exe`（CUDA 12.8 / cuDNN 9.8）
- 棋力模型：`..\KataGo\models\kata1-tf2-b10c384-s2941M-d5872M.bin.gz`
- 分析配置：`..\KaTrain\analysis_5060.cfg`
- 默认分析：1000 visits，可在界面切换分析强度
- 截图模型：`models\image2sgf\board.pth` 与 `stone.pth`
- 默认界面语言：中文

若只想在没有 NVIDIA 驱动的电脑上运行截图识别，可重新执行
`.\setup-local.ps1 -CpuVision` 安装 CPU 版 PyTorch（速度会明显变慢）。脚本会
检查已安装 wheel 的 CPU / CUDA 类型；在两种模式间切换时会强制替换，而不是
误用同版本的旧 wheel。
