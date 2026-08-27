# 手谈桌面版

桌面版只是一个很轻的窗口外壳。KataGo、截图识别和 Web 服务仍由项目自己的
`.venv` 运行，不会被重复打包，所以构建目录小，模型也只保留一份。

## 一键安装

双击 `desktop\install-desktop.cmd`。它会：

1. 在 `.runtime\desktop-build-venv` 创建独立构建环境；
2. 安装固定版本的 `pywebview 6.1` 和 `PyInstaller 6.22.2`；
3. 构建 `desktop-dist\KataGo-HandTalk\KataGo-HandTalk.exe`；
4. 在桌面和当前用户的开始菜单创建“手谈 KataGo”快捷方式。

第一次构建需要联网下载 Python 包，但不需要管理员权限。项目所在路径可以包含
中文和空格。安装完成后直接双击快捷方式；桌面壳会自动检查本地环境、按需运行
`setup-local.ps1`、启动 KataGo，然后在独立窗口中打开棋盘。

棋盘右上角的“置顶”按钮可以让窗口始终显示在其他应用上方；再次点击即可取消。
选择会保存在本机，下次打开桌面版时自动沿用。

> `desktop-dist` 不是独立安装包。请保留整个项目目录，以及相邻的 `KataGo`
> 和 `KaTrain` 目录；快捷方式会把项目绝对路径交给桌面壳。

## 手动构建或重建快捷方式

```powershell
.\desktop\build-desktop.ps1
.\desktop\install-desktop.ps1 -SkipBuild
```

构建环境和临时文件都在 `.runtime` 下；不会把 `torch`、`torchvision`、`cv2`
或 Flask 打进桌面程序。如果构建脚本检测到这些重型依赖混入，会直接报错。

## 常见问题

- **提示找不到 `desktop_launcher.py`**：桌面壳源码不完整，请更新当前分支。
- **提示找不到 KataGo、模型或截图识别权重**：先按根目录的 `LOCAL-SETUP.md`
  补齐对应文件，再重新打开桌面快捷方式。
- **窗口无法显示**：Windows 10 需要安装 Microsoft Edge WebView2 Runtime；
  Windows 11 通常已经自带。启动失败时桌面壳会给出可复制的错误信息。
- **移动了项目目录**：重新双击 `install-desktop.cmd`，让快捷方式记录新路径。
