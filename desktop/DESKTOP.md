# 手谈 Windows 桌面构建与发布

本文面向维护者和发布者。普通用户请从项目 README 的 GitHub Release 快速开始。

桌面包由轻量 PyWebView 启动壳和白名单应用资源组成。用户不需要安装 Git、Node.js
或系统 Python；首次运行由启动器在 `%LOCALAPPDATA%\KataGoHandTalk\runtime` 准备
受管理的 Python 环境。KataGo 可执行文件和棋力网络必须由用户提供，截图识别权重
是可选组件，以上二进制和模型均不会进入发行包。

## 官方全量打包

正式发行必须从可验证且完全干净的 Git checkout 全量重建。在项目根目录执行：

```powershell
git status --short
.\desktop\package-release.ps1
```

第一条命令必须没有任何输出。`package-release.ps1` 会再次检查当前提交和工作树；
存在已修改、已暂存或未跟踪文件时直接失败。不要用参数绕过这一发布门禁。

成功后在 `desktop-dist\release\` 生成：

```text
KataGo-HandTalk-<VERSION>-windows-x64.zip
KataGo-HandTalk-<VERSION>-file-manifest.json
SHA256SUMS
```

外部 JSON 清单逐项记录相对路径、字节数和 SHA-256，并记录源码 commit、工作树状态
和是否跳过构建；同一份清单位于 ZIP 内的
`KataGo-HandTalk/FILE-MANIFEST.json`。`SHA256SUMS` 同时校验 ZIP 与外部清单。

## 锁文件与可复现构建

桌面依赖有两个角色不同的文件：

- `desktop/requirements-desktop.txt` 是供维护者阅读和更新的直接依赖输入；
- `desktop/requirements-desktop.lock.txt` 是构建实际消费的精确锁文件，包含完整传递
  依赖和允许制品的 SHA-256。

更新输入后，需使用 `uv 0.12.6` 和锁文件首行记载的完整命令重新生成并审核 lock；
不要手工删除哈希，也不要让构建直接消费未锁定的输入文件。构建脚本执行：

```text
uv pip sync --strict --require-hashes desktop/requirements-desktop.lock.txt
```

并再次核对 `pywebview==6.1`、`PyInstaller==6.22.2`。此外，构建固定并校验 portable
`uv 0.12.6` 的 SHA-256、固定 uv 管理的 Python `3.11.16`，设置
`PYTHONHASHSEED=0`、`SOURCE_DATE_EPOCH=946684800` 和 `TZ=UTC`。打包阶段按稳定顺序
写入 ZIP，并把文件时间统一为固定值。

这些约束用于让相同 commit、相同 Windows x64 工具链的产物可复核。发布候选仍应
在同一干净 checkout 连续全量打包两次并比较 ZIP 与 manifest 的 SHA-256；若不同，
必须先查明原因，不能把“脚本已固定参数”当成已验证的可复现性结论。

## 构建目录内容

单独运行开发构建：

```powershell
.\desktop\build-desktop.ps1
```

会生成：

```text
desktop-dist/KataGo-HandTalk/
├─ KataGo-HandTalk.exe       # 带 VERSION 对应的 PE 版本信息
├─ _internal/                # PyInstaller / PyWebView 运行文件
├─ app/                      # 明确白名单复制的本地 Web 应用
│  ├─ server/ static/ config/ third_party/
│  ├─ run-local.py setup-local.ps1 config.ini VERSION
│  └─ README、安装、CHANGELOG、LICENSE、NOTICE 与 requirements 文档
└─ licenses/                 # 项目、Python、桌面依赖和原生组件的离线许可
```

`app/` 不是工作区的递归副本。构建只收录脚本列出的目录和根文件，并在结束前拒绝：

- KataGo、`*.pth`、`*.bin.gz` 及其他模型或权重；
- `.venv`、`.runtime`、Git 元数据、缓存、日志和数据库；
- 构建电脑的项目绝对路径或用户目录；
- 意外混入桌面壳的 Torch、OpenCV、Flask 等重型后端包；
- 缺失的项目、Python 或构建脚本明确要求的原生组件许可文件。

`build-desktop.ps1` 只生成开发目录，不检查工作树是否干净，也不构成正式 Release。

## Dirty 开发包

只有本地调试时才允许打包脏工作树：

```powershell
.\desktop\package-release.ps1 -AllowDirty
```

这会先全量构建，再生成文件名带 `-dirty` 的开发制品。若已经单独构建，只想快速
验证打包逻辑，可使用：

```powershell
.\desktop\package-release.ps1 -SkipBuild -AllowDirty
```

规则是强制的：

- `-SkipBuild` 必须与 `-AllowDirty` 同时使用；单独使用会失败。
- 只要使用 `-SkipBuild`，或源码工作树不干净，制品名就带 `-dirty`。
- `-SkipBuild -AllowDirty` 仍检查版本、PE 元数据、许可、禁止文件、绝对路径、ZIP
  内容与哈希，但无法证明现有构建目录来自当前源码。
- 任意 `-dirty` 制品都只能用于开发测试，不能上传为官方 Release，也不能改名冒充
  正式包。

## 发布前验收

每个正式候选至少完成以下步骤：

1. 确认根目录 `VERSION`、Release 标签和更新日志一致；`0.1.0-beta.2` 对应标签
   `v0.1.0-beta.2`。
2. 运行 Python 与前端测试：

   ```powershell
   python -m pip install --require-hashes -r requirements-dev.lock.txt
   python -m pytest -q
   node --test `
     tests/frontend_contract.test.mjs `
     tests/frontend_desktop_contract.test.mjs `
     tests/goboard_state.test.mjs `
     tests/live_review_state.test.mjs
   ```

3. 确认 `git status --short` 无输出，再运行无参数的
   `.\desktop\package-release.ps1`。
4. 根据 `SHA256SUMS` 独立复核 ZIP 和外部 manifest：

   ```powershell
   Get-Content .\desktop-dist\release\SHA256SUMS
   Get-FileHash `
     .\desktop-dist\release\KataGo-HandTalk-0.1.0-beta.2-windows-x64.zip `
     -Algorithm SHA256
   Get-FileHash `
     .\desktop-dist\release\KataGo-HandTalk-0.1.0-beta.2-file-manifest.json `
     -Algorithm SHA256
   ```

5. 在同一干净 checkout 再全量打包一次并比较哈希；不一致时停止发布并调查。
6. 在未安装 Python、Git 或 Node.js 的干净 Windows 10 和 Windows 11 x64 环境中完整
   解压并运行，不能从 ZIP 预览窗口启动。
7. 首次配置分别验证：选择 KataGo exe、棋力网络、包内默认 analysis 配置；关闭识图
   可直接进入棋盘；若使用合法取得的识图权重，再验证 Auto / CUDA / CPU 中计划支持
   的路径。
8. 验证基础对局、连续退一手、停一手、认输、新对局、分析开关、AI 走子、截图
   导入 / 粘贴、窗口置顶、重新配置并重启，以及退出后清理后端。
9. 验证错误态可恢复：无效 KataGo、无效网络、引擎启动失败、端口占用、无 WebView2、
   识图未配置 / 安装失败；检查“重试、重新选择、打开日志、关闭识图并继续”等动作
   在 `900×650`、`1280×720` 和 `1920×1080 @ 150%` 下均可见且可用。
10. 检查包内离线许可、版本、commit / manifest、构建日期或诊断信息可访问，且 ZIP
    不含引擎、网络、识图权重、个人路径、日志或其他开发机数据。

只有上述验收和 clean Git 全量打包都通过，制品才是正式候选。UI 看起来可用并不
等于达到 beta 发布门槛。

## GitHub 预发布流程

`.github/workflows/release.yml` 只响应 `v*` 标签，并要求标签严格等于 `v` 加根目录
`VERSION`。工作流依次运行 Python / 前端测试、无参数官方打包、输出与校验和复核、
GitHub 构建来源证明，然后创建或更新 prerelease。Actions 均固定为完整 commit SHA。

不要为了试运行工作流随意推送正式标签。先在本地完成上面的验收并提交所有改动，
再从目标 commit 创建与 `VERSION` 一致的标签。

## 开发机快捷方式

源码开发期间可双击：

```text
desktop\install-desktop.cmd
```

它会运行开发构建，并在当前用户桌面和开始菜单创建指向
`desktop-dist\KataGo-HandTalk\KataGo-HandTalk.exe` 的快捷方式。也可只重建快捷方式：

```powershell
.\desktop\install-desktop.ps1 -SkipBuild
```

这是开发便利脚本，不是最终安装器；移动源码目录后需要重新创建快捷方式。公开 beta
只能发布由无参数 `package-release.ps1` 在干净 checkout 中生成的便携 ZIP。

## 常见问题

- **提示缺少 KataGo 或棋力网络**：返回首次配置，重新选择本机文件。发行包不会
  自动夹带、下载或重新分发它们。
- **没有截图识别模型**：选择“关闭识图并继续”，仍可正常对局和使用 KataGo 分析。
  来源与许可说明见包内 `licenses/THIRD_PARTY_NOTICES.md`。
- **重新配置后发生什么**：保存 KataGo、网络、配置或识图设置会停止旧后端并重启；
  先保存或导出当前重要推演。
- **窗口无法显示**：Windows 10 需要 Microsoft Edge WebView2 Runtime；Windows 11
  通常已经自带。启动失败时使用启动器提供的日志与诊断入口。
- **Windows 显示 SmartScreen**：`v0.1.0-beta.2` 尚未进行 Authenticode 签名。只从
  GitHub Release 下载，并核对 `SHA256SUMS` 和构建来源证明。
