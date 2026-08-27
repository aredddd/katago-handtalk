# 手谈 · KataGo 本地复盘版

面向围棋新手的本地 Web 界面：只保留对局、悔棋、停一手、认输、形势判断和
KataGo 分析。服务固定监听 `127.0.0.1`，棋谱、截图和分析都留在本机。

## 现在能做什么

- 自由推演，或选择执黑 / 执白和 AI 对弈
- 显示 KataGo 推荐点、胜率、目差、主要变化和全盘形势
- 从中局截图继续：选择图片、拉起 Windows 截图工具，或直接粘贴剪贴板图片
- 识别后先在预览盘修正黑白棋子，再指定下一手方并载入
- 共享一个棋局窗口做近实时复盘；局面连续两次识别一致后才同步
- macOS 风格毛玻璃界面；超宽屏左右双栏、棋盘居中，窄屏自动改为纵向布局

## 桌面版（推荐）

第一次安装或代码更新后，双击 `desktop\install-desktop.cmd`。它会构建一个约
30 MB 的轻量 Windows 桌面壳，并在桌面、开始菜单各创建一个“手谈 KataGo”
快捷方式。KataGo、CUDA/PyTorch 和模型继续复用当前本地环境，不会重复占用数 GB。

以后只需双击桌面上的“手谈 KataGo”：程序会自动检查环境、启动 KataGo、等待
引擎就绪并打开棋盘。桌面服务使用独立随机回环端口，不会被遗留浏览器标签误连；
关闭窗口时会同时清理它自己启动的后端和 KataGo。详细说明见
[desktop/DESKTOP.md](desktop/DESKTOP.md)。

## 浏览器版（备用）

当前分支按同一 `outputs` 目录中的 KataGo、模型和 5060 配置组织。

第一次运行：

```powershell
.\setup-local.ps1
```

日常使用直接双击 `start-local.cmd`。引擎就绪后浏览器会打开：

```text
http://127.0.0.1:5000
```

退出时在启动窗口按 `Ctrl+C`。完整路径和无浏览器启动方式见
[LOCAL-SETUP.md](LOCAL-SETUP.md)。

## 截图导入

截图卡片提供三种入口：

1. **选择截图**：从文件中选择 PNG / JPG。
2. **拉起截图**：调用 Windows 截图工具；截完回到网页按 `Ctrl+V`。
3. **粘贴图片**：读取剪贴板中的图片；页面聚焦时直接 `Ctrl+V` 也可以。

识别模型目前只支持 19 路。服务端会限制上传大小、图像像素数，并把 4K/手机
图片缩到适合显卡识别的尺寸。模型权重不纳入 Git；安装脚本会明确检查
`models/image2sgf/board.pth` 和 `stone.pth`。

## 近实时复盘

点击“开始实时复盘”，在浏览器系统窗口中选择包含棋盘的窗口。程序只截取共享
画面并在本机识别，不会替你点击第三方棋局，也不会注入或覆盖其它应用。

- 棋盘变化需连续两帧一致才会写入复盘树。
- 单步合法变化保留完整手顺；漏过多手时按当前画面重新建立局面。
- 截图无法看出“停一手”，因此可用“当前轮到”下拉框手动校正。
- 停止共享会立即取消识别和在途分析。

## 本地目录约定

```text
outputs/
├─ KataGo-Web-Beginner/       # 本项目
│  ├─ models/image2sgf/       # board.pth、stone.pth（不提交）
│  ├─ server/                 # Flask / Socket.IO / KataGo 进程层
│  ├─ static/                 # Canvas 棋盘与界面
│  ├─ setup-local.ps1
│  └─ start-local.cmd
├─ KataGo/                    # katago.exe 与棋力模型
└─ KaTrain/analysis_5060.cfg  # RTX 5060 Laptop 分析配置
```

## 测试

```powershell
node --test tests/*.test.mjs
.\.venv\Scripts\python.exe -m pytest -q
```

后端对同一浏览器会话只保留最新分析；新的分析 / AI 请求会终止旧查询。KataGo
stdout 中断会立即唤醒等待者，避免界面长时间假死。

## 上游与许可

本分支基于 [KataGo Web](https://github.com/michelzzw/katago-web)，使用
[KataGo](https://github.com/lightvector/KataGo) 进行分析，并接入
[noword/image2sgf](https://github.com/noword/image2sgf) 的识图结构与权重。
项目代码沿用仓库的 MIT License。大型引擎、棋力模型和识图权重需分别遵守其
上游许可；提交或分发前请自行确认权利，因此本仓库不打包这些权重。
