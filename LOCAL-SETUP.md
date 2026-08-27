# 本地源码启动说明

本文说明如何在 Windows 上从源码运行手谈。普通用户应优先下载 GitHub Release 的
便携 ZIP；源码模式主要用于开发、测试和调试。

脚本不会把运行依赖安装到系统 Python。默认运行时放在仓库内：

```text
.runtime\   # uv、uv 管理的 Python 与下载缓存
.venv\      # 项目虚拟环境
```

两者均为可再生成目录，不应提交到 Git。桌面 Release 则把对应运行数据写到
`%LOCALAPPDATA%\KataGoHandTalk\runtime`，不要把这两种目录混用。

## 第一次安装

在项目根目录打开 PowerShell：

```powershell
.\setup-local.ps1 -VisionBackend Auto
```

`setup-local.ps1` 使用固定版本并校验 SHA-256 的 portable `uv 0.12.6`，再由 uv
安装和管理 Python `3.11.16`、创建 `.venv`、按 `requirements.lock.txt` 中的精确
版本与哈希安装核心依赖。`requirements.txt` 只是供维护者阅读和生成 lock 的输入；
脚本不依赖预先安装的系统 Python。

可用参数如下：

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `-RuntimeRoot <路径>` | `<仓库>\.runtime` | 指定 uv、Python 和缓存目录。 |
| `-VenvRoot <路径>` | `<仓库>\.venv` | 指定虚拟环境目录。 |
| `-VisionBackend None` | — | 只安装核心依赖，不安装截图识别依赖。已有环境中的 Torch 不会因此自动卸载。 |
| `-VisionBackend Auto` | 默认 | 找到 `nvidia-smi.exe` 时安装 CUDA 版，否则安装 CPU 版。 |
| `-VisionBackend CUDA` | — | 从 PyTorch cu128 索引安装固定版本的 CUDA wheel。需要可用的 NVIDIA 驱动。 |
| `-VisionBackend CPU` | — | 从 PyTorch CPU 索引安装固定版本的 CPU wheel。 |
| `-CpuVision` | 关闭 | 兼容旧参数，等同于 `-VisionBackend CPU`，并覆盖同时给出的后端值。 |

`Auto` 只以是否能找到 `nvidia-smi.exe` 决定后端；若随后 CUDA 安装或可用性检查
失败，脚本会报错，不会静默回退 CPU。此时请明确重跑
`.\setup-local.ps1 -VisionBackend CPU`。

当前脚本从匹配后端的 `requirements-torch-cpu.lock.txt` 或
`requirements-torch-cuda.lock.txt` 安装精确的 `torch==2.11.0+cpu` /
`torch==2.11.0+cu128` 与对应 `torchvision==0.26.0` 本地版本，再按
`requirements-vision.lock.txt` 安装其余识图依赖；所有下载制品都要求命中 lock 中的
哈希。选择 `Auto`、`CUDA` 或 `CPU` 时，脚本会强制
重装两个 Torch wheel 并检查实际 CPU / CUDA 类型，避免在切换后端后继续误用旧
wheel。因此切换识图计算方式会重新下载和安装 Torch，耗时和下载量都可能较大。

要从 CUDA 切到 CPU，例如：

```powershell
.\setup-local.ps1 -VisionBackend CPU
```

要改回自动选择：

```powershell
.\setup-local.ps1 -VisionBackend Auto
```

## 截图识别权重

截图识别是可选功能。启用时还需要用户自行放置：

```text
models\vision\board.pth
models\vision\stone.pth
```

这些权重不会随仓库或 Release 分发。本项目也不提供镜像或自动下载；请由用户从
自己有权使用的来源合法取得，并确认上游许可允许自己的使用场景。不要把权重提交
到仓库或再打包分发。相关归属和风险见
[第三方声明](THIRD_PARTY_NOTICES.md)。

为避免破坏已有本地安装，程序仍会在新目录没有完整权重对时回退读取旧的
`models\image2sgf\` 目录；新安装不应再依赖该旧路径。

不需要截图识别时，可从一开始只安装核心依赖：

```powershell
.\setup-local.ps1 -VisionBackend None
```

## 配置 KataGo

源码模式不会附带 KataGo 可执行文件、棋力网络或用户自定义分析配置。可以编辑本机
`config.ini`，其中相对路径按仓库根目录解析；也可以在每次启动时传入绝对路径。
启动参数会设置 `KATAGO_PATH`、`KATAGO_MODEL`、`KATAGO_CONFIG` 环境变量；这些
环境变量优先于 `config.ini`。

包内的 `config\default_analysis.cfg` 是通用分析起点。若使用自定义配置，请确保它与
所选 KataGo 版本和后端兼容。

## 日常启动

双击 `start-local.cmd`，或在 PowerShell 中运行：

```powershell
.\start-local.ps1
```

`start-local.ps1` 的参数与行为如下：

| 参数 | 作用 |
| --- | --- |
| `-NoBrowser` | 服务就绪后不自动打开系统浏览器。 |
| `-KataGoPath <文件>` | 覆盖 KataGo 可执行文件路径。 |
| `-ModelPath <文件>` | 覆盖 KataGo 棋力网络路径。 |
| `-ConfigPath <文件>` | 覆盖 KataGo analysis 配置路径。 |
| `-DisableVision` | 本次运行关闭截图识别，即使权重已存在。 |
| `-CpuVision` | 仅在脚本需要首次创建 `.venv` 时，要求安装 CPU 识图依赖。已有 `.venv` 不会由启动脚本重装；切换后端请显式重跑 `setup-local.ps1`。 |

完整示例：

```powershell
.\start-local.ps1 `
  -KataGoPath "D:\Go\katago.exe" `
  -ModelPath "D:\Go\network.bin.gz" `
  -ConfigPath ".\config\default_analysis.cfg" `
  -NoBrowser
```

若 `.venv` 尚不存在，启动脚本会自动调用安装脚本：

- 使用 `-DisableVision`，或任一识图权重缺失时，选择 `VisionBackend None`；
- 两个权重都存在且指定 `-CpuVision` 时，选择 `VisionBackend CPU`；
- 两个权重都存在且未指定上述参数时，选择 `VisionBackend Auto`。

若 `.venv` 已存在，启动脚本不会根据权重或 `-CpuVision` 自动改装依赖。需要切换
`None / Auto / CUDA / CPU` 时，请先显式执行对应的 `setup-local.ps1` 命令。

服务默认只监听：

```text
http://127.0.0.1:5000/
```

若环境变量 `PORT` 已设置，则使用该端口；无论端口为何，都只绑定本机回环地址，不
接受局域网或公网连接。退出时在启动窗口按 `Ctrl+C`。

## 常见命令

只运行核心功能、关闭识图：

```powershell
.\setup-local.ps1 -VisionBackend None
.\start-local.ps1 -DisableVision
```

安装 CPU 识图并启动：

```powershell
.\setup-local.ps1 -VisionBackend CPU
.\start-local.ps1
```

自定义可再生成目录：

```powershell
.\setup-local.ps1 `
  -RuntimeRoot "D:\HandTalkRuntime" `
  -VenvRoot "D:\HandTalkVenv" `
  -VisionBackend Auto
```

之后启动时也需要让 `start-local.ps1` 找到同一个 `.venv`；当前启动脚本本身没有
`-VenvRoot` 参数，所以这种自定义主要供桌面启动器或高级开发流程使用。普通源码
开发建议保留默认目录。
