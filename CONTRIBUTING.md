# 贡献指南

感谢你愿意改进手谈。这个分支强调“新手能直接使用”：新增功能前，请先确认它能
让对局、截图复盘或 AI 推演更简单，而不是把专业设置重新堆回主界面。

## 开始之前

1. 普通缺陷和功能建议先开 Issue；安全问题按 [SECURITY.md](SECURITY.md) 私下报告。
2. 从默认分支 `beginner-local` 创建短分支，避免混入模型、日志或构建产物。
3. 只提交你有权许可的代码、图片、音效和模型。若引用第三方实现，请在 PR 中给出
   来源和许可证；没有明确许可证的材料不要新增到仓库。

## 本地开发

Python 测试环境：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
```

运行测试：

```powershell
.\.venv\Scripts\python.exe -m pytest -q
node --test tests/frontend_contract.test.mjs tests/frontend_desktop_contract.test.mjs tests/goboard_state.test.mjs tests/live_review_state.test.mjs
```

测试使用假引擎和临时模型文件，不需要 KataGo、GPU 或真实权重。要手动运行完整
应用，请按 [LOCAL-SETUP.md](LOCAL-SETUP.md) 准备这台机器对应的本地环境。

## 提交要求

- UI 改动至少检查 1280×720 和窄窗口布局，文字保持中文 / 英文键值一致。
- 识图改动应覆盖文件导入、剪贴板、手动校正和实时重同步路径。
- 不提交 `.pth`、`.bin.gz`、`katago.exe`、`.venv`、`.runtime` 或 `desktop-dist`。
- 截图应去除账号、路径、通知和其他个人信息。
- PR 描述写清改动、验证方式、已知限制和涉及的第三方来源。

提交贡献即表示你有权提交这些内容，并同意将你拥有版权的原创贡献按根目录
[LICENSE](LICENSE) 所述 MIT 条款提供；第三方材料继续适用其原许可。
