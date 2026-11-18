# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 1.0.0 (2026-11-18)

首次开源发布。

- 将离线打包工具页面的核心逻辑抽取为 Node CLI，支持 ZIP 解析/重建、二进制 AXML 改写、APK v2 自签名。
- 支持单文件 HTML 注入、应用名/包名/版本/权限配置、应用图标与启动页（含 GIF）。
- 支持 UTF-8 / UTF-16 / GBK 编码自动识别与 `<meta charset>` 补全。
- 签名密钥持久化，支持 `--key` / `HTML2APK_KEY` 自定义路径，同一密钥可覆盖安装升级。
- 新增 `--json` 输出、`-V` / `--tool-version`、`-h` / `--help`、`--参数=值` 形式。
- 新增浏览器 GUI 版（`tools/HTML转APK打包器.html`，完全离线、自包含）。
- 新增零依赖单元测试与 GitHub Actions CI。
- MIT 许可证开源。
