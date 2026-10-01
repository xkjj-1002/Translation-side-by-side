# 即时翻译 · 双语对照

按一下 `Alt / Option + T`，在网页外语正文下方显示中文译文，保留原文，随时隐藏或恢复。

适用于 Chrome / Edge 桌面版。当前发布版本：**v0.2.2**。

**[下载发布版本](https://github.com/xkjj-1002/Translation-side-by-side/releases/latest)** · [安装与更新](docs/INSTALL.md) · [隐私说明](docs/PRIVACY.md) · [反馈问题](https://github.com/xkjj-1002/Translation-side-by-side/issues)

## 安装

**方式一：Edge 加载项商店（审核通过后可用，推荐）**

本扩展已提交 Microsoft Edge 加载项商店，审核通过后即可一键安装，并由商店自动更新：

<https://microsoftedge.microsoft.com/addons/detail/jbfkfiagchndpdhhdnhikpofbmajfrmj>

在审核通过之前，请用下面的手动安装方式。

**方式二：手动安装（Edge / Chrome）**

1. 在发布页下载附件 **`instant-translate-v0.2.2.zip`**，解压到准备长期保留的文件夹。
2. 打开 `chrome://extensions` 或 `edge://extensions`，启用开发者模式。
3. 点击「加载已解压的扩展程序」，选择解压后包含 `manifest.json` 的目录。
4. 在自动打开的设置页选择翻译引擎，并测试连接。

**请下载 Release 中的扩展 ZIP。** 首页 `Code → Download ZIP` 和 Release 下的 `Source code` 只包含产品说明，不是扩展安装包。

手动安装需要自己替换文件来更新；商店版本由商店自动更新。Chrome 版本目前只提供手动安装。本仓库公开，任何账号都可以下载安装包并提交反馈。

## 开始翻译

- `Alt + T`（macOS 为 `Option + T`）：翻译，或隐藏 / 恢复译文。
- `Alt + Shift + T`（macOS 为 `Option + Shift + T`）：切换译文显示。
- 按键无反应时，打开工具栏面板查看实际快捷键，按提示重新绑定。

## 选择翻译引擎

| 引擎 | 需要准备什么 |
|---|---|
| 浏览器内置 AI | 浏览器与设备支持，并能下载语言包；运行时在本地翻译 |
| 有道智云 | 文本翻译应用 ID 与密钥，费用取决于服务商套餐 |
| 大模型 API | 兼容接口地址、模型与密钥，费用取决于服务商 |
| 本地演示 | 不需要密钥，只显示模拟译文，用来查看界面效果 |

内置 AI 不可用时，请配置在线引擎。首次使用能否直接翻译，取决于所选引擎是否就绪。

## 更新与反馈

每个版本的修复、已知问题和下载文件都在 [Releases](https://github.com/xkjj-1002/Translation-side-by-side/releases)。更新时替换原安装目录的内容，并在扩展管理页重新加载，详细步骤见 [安装与更新](docs/INSTALL.md)。

反馈请提供浏览器版本、扩展版本、复现步骤和错误提示；不要附上 API 密钥或包含个人信息的原文。

本仓库提供产品文档与版本下载，源码和构建流程由私有源码仓库管理。允许安装、使用与卸载；不提供开源许可。
