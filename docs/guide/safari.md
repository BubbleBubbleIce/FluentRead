# Safari macOS 开发版

本 fork 增加原生 Safari Web Extension 的构建与 Apple 包装入口，复用 FluentRead 的扩展界面、配置、消息与翻译服务。它是本机开发版，尚未经过 Safari 实机验收或 App Store 发布；不表示上游已经发布 Safari 扩展。

## 构建

需要 macOS、完整 Xcode、Node.js 20+ 与项目锁定的 pnpm。Apple 的许可由使用者阅读并接受。命令行仅安装 Command Line Tools 不足以生成 Safari App。

```sh
pnpm install --frozen-lockfile
pnpm package:safari
```

Apple Silicon 上如果安装在 `gifsicle` 等旧图片压缩工具的安装脚本失败，可以使用 `pnpm install --frozen-lockfile --ignore-scripts`，再单独执行 `pnpm exec wxt prepare`。本次 Safari/Chrome/Firefox 构建采用此路径并成功；没有升级锁文件或启用这些图片压缩工具。

`build:safari` 明确使用 WXT 0.20.18 默认支持的 Safari MV2，生成 `.output/safari-mv2`。后台沿用项目已有的 `persistent: false` 配置。`package:safari` 使用 Apple 官方 packager（旧 Xcode 使用 converter）生成 `.output/safari-app/FluentRead/FluentRead.xcodeproj`，复制扩展资源，不打开应用或改变系统的 Xcode 选择。若 Xcode 安装位置不同，设置 `DEVELOPER_DIR`。

打开生成的 Xcode 项目，选择 macOS App scheme，使用本机开发签名编译运行。也可以按实际 scheme 名称使用 `xcodebuild`；查看 scheme：

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -list -project .output/safari-app/FluentRead/FluentRead.xcodeproj
```

Apple 工具不会覆盖已有项目；重新打包前删除本次生成的 `.output/safari-app/FluentRead`，或用 Xcode 在同一项目内继续调试。

## 安装与验收

运行生成的 FluentRead App，在 Safari 设置的「扩展」中启用 FluentRead，并允许访问测试网页。本机未签名开发版本需要在 Safari 的开发者设置中允许未签名扩展；系统菜单名称可能随 Safari 版本变化。

先在普通网页选择免费翻译服务，依次确认全文翻译、恢复原文、再次翻译、划词翻译与设置保存；关闭后重新打开 Safari，再确认配置和翻译仍可使用。AI 服务使用已有配置入口，实际请求需要供应商密钥与额度。

## 功能范围

全文、悬浮、划词、输入框翻译、云端 AI 服务及词书复用现有代码，仍需 Safari 实测。Safari 不提供 Chrome Translator 或 Chrome Offscreen API；目前项目的能力契约在 Safari 中关闭图片 OCR、圈选翻译、扩展本地模型及扩展内语音播放，保留页面语音回退。没有在 Safari 非持久后台中借用 Firefox 的持久 iframe。

按域名移除 Origin / Referer 依赖 Safari 的 DNR 能力及网站授权。首次验收先保持默认空名单；启用该功能后需另测请求头和目标服务。Safari API 或供应商的运行验证不能由 Chrome/Firefox 构建通过代替。

本机 Xcode 27 打包器还提示 `content_scripts.world`、`options_ui.open_in_tab` 与 `content_scripts.match_about_blank` 不支持。因此 YouTube/X 的主世界字幕桥、依赖主世界导航信号的网页、设置页打开方式与邮箱空白子页面都不能视为已适配。请求头规则使用的 `initiatorDomains` 需要 Safari 26+。在完成这些场景的实机验证前，请把此包视为原生移植起点。

若只需要网页核心翻译，也可以直接使用上游已提供的 [Safari Userscripts 安装方案](./userscript.md)。它与原生扩展开发版是两个安装入口，请避免同时启用。

参考：[WXT Safari 发布说明](https://wxt.dev/guide/essentials/publishing.html#safari)、[Apple Safari Web Extension 包装](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)。
