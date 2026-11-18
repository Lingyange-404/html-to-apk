# 贡献指南

感谢你考虑为 html-to-apk 做贡献！

## 报告问题

提交 Issue 时请尽量包含：

- 使用的 Node.js 版本（`node -v`）与操作系统；
- 完整的命令行参数与复现步骤；
- 期望行为与实际行为，以及完整的报错信息；
- 若涉及 HTML 内容，说明是否引用了外部 CSS / JS / 图片（相对路径会把资源打不进去）。

## 开发环境

无需安装依赖，只要有 Node.js 18+：

```bash
git clone https://github.com/liyuyang211/html-to-apk.git
cd html-to-apk
npm test
```

## 提交 PR

1. Fork 仓库并创建特性分支，如 `git checkout -b fix/axml-utf8`。
2. 改动后确保 `npm test` 全部通过。
3. 若新增功能，补充对应的单元测试，并更新 `README.md` 的参数表。
4. 提交时写清楚改动动机与影响范围，然后发起 Pull Request。

## 注意事项

- **不要提交签名私钥**（`signing-key.json`、`*.pem`、`*.p12` 等）。仓库 `.gitignore` 已忽略，但提交前请再确认 `git status`。
- 核心库 `scripts/packer-core.js` 同时被 CLI 和浏览器 GUI 使用（GUI 中是内联副本）。若改动核心逻辑，请同步更新 GUI 页面里的对应代码。
- 保持零 npm 依赖；核心逻辑只用 Node / 浏览器内置 API。
- 测试产物（`test/fixtures/*.apk`、`test/fixtures/*-key.json`）由测试生成，不要提交。
