# 安装与更新

## 首次安装

### Edge 加载项商店

扩展已提交 Microsoft Edge 加载项商店，审核通过后可直接在商店安装，并由商店自动更新：

<https://microsoftedge.microsoft.com/addons/detail/jbfkfiagchndpdhhdnhikpofbmajfrmj>

### 手动安装（Edge / Chrome）

在 [Releases](https://github.com/xkjj-1002/Translation-side-by-side/releases/latest) 下载 `instant-translate-vX.Y.Z.zip`，不要下载 Source code 或首页 Code 菜单里的 ZIP。

解压 ZIP，确保选择的文件夹第一层有 `manifest.json`、`content.js`、`bg/`、`icons/`、`options/` 和 `popup/`。将文件夹保留在固定位置，加载后不要删除。

Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`。开启开发者模式，点击「加载已解压的扩展程序」，选择上述文件夹。首次安装自动打开设置页，选择引擎并测试连接。

## 更新已有安装

1. 备份原扩展文件夹，下载目标版本扩展 ZIP，并先解压到临时位置。
2. 关闭正在翻译的页面，将原安装目录中的扩展文件替换为新包内容，保持目录路径不变，移除旧版已不存在的文件。
3. 在扩展管理页点击原扩展的重新加载按钮，然后刷新要翻译的网页。
4. 检查扩展管理页显示的版本号，并测试设置与翻译功能。不要先卸载原扩展，卸载可能清除设置。

保持路径不变可以避免加载为第二份扩展。加载已解压的扩展不会自动获取 GitHub 更新；通过商店安装的版本由商店自动更新，不需要手工替换文件。

## 回到旧版

在 Releases 下载旧版附件，按同样步骤替换原目录并重新加载。如果新版设置与旧版不兼容，可能需要重新配置。密钥请自行安全保存，不要提交到反馈中。

## 校验下载

每个正式 Release 附有 `SHA256SUMS.txt` 和 `release-metadata.json`。前者供校验 ZIP 完整性，后者记录构建对应的源码提交和已执行的检查。
