# html-to-apk

> 把一个**单文件 HTML** 打包成可直接安装的 Android APK。**100% 本地离线**，无需 Android SDK、Gradle，也不联网、不上传任何内容。

核心是一个约 140 KB 的 WebView 模板 APK：解析 ZIP → 注入 HTML 到 `assets/index.html` → 改写 `AndroidManifest.xml`（包名 / 应用名 / 版本 / 权限 / 启动页）→ 重建 ZIP → APK v2 自签名。

## 特性

- **完全离线**：不联网、不依赖 Gradle / Android SDK、不调用任何外部服务，零 npm 依赖（仅用 Node 内置 API）。
- **体积小巧**：产物约 137 KB + HTML 体积，构建通常不到 1 秒。
- **中文友好**：应用名支持中文；自动识别并转换 UTF-16 / GBK 编码，缺 `<meta charset>` 时自动补全。
- **可定制**：应用图标、启动页（支持 GIF 动图）、权限、版本、`https` / `file` 加载模式。
- **安全上下文**：`https` 模式下 WebView 获得安全上下文，登录、摄像头、云端 API 可正常工作。
- **可覆盖升级**：签名密钥持久化，同一密钥打出的包可覆盖安装；换密钥才需要卸载重装。
- **双形态**：命令行 CLI + 完全离线的浏览器 GUI（拖拽选图标、可视化调启动页）。

## 环境要求

Node.js **18+**（用到内置 `zlib` 与 `crypto.subtle`）。推荐 Node 20 / 22。

## 安装

```bash
# 方式一：npx 直接运行（需先发布到 npm，当前推荐方式二/三）
npx html-to-apk-local --html ./index.html --name "我的工具"

# 方式二：克隆后全局链接
git clone https://github.com/liyuyang211/html-to-apk.git
cd html-to-apk
npm link
html2apk --help

# 方式三：不安装，直接用 node 调用
node scripts/html2apk.js --html ./index.html --name "我的工具"
```

## 快速开始

```bash
node scripts/html2apk.js \
  --html "/path/to/index.html" \
  --name "我的工具" \
  --pkg com.example.tool \
  --out "./我的工具.apk"
```

最小调用（包名与输出路径自动生成）：

```bash
node scripts/html2apk.js --html "/path/to/index.html" --name "我的工具"
```

构建成功后把 APK 传到手机安装即可。自签名应用安装时系统会提示「未知应用 / 未知来源」，需手动允许。

## 参数

| 参数 | 说明 | 默认值 |
|---|---|---|
| `--html <file>` | **必填**。单个 HTML 文件（.html / .htm / .xhtml / .txt） | — |
| `--name <名称>` | 应用显示名，支持中文 | HTML 文件名 |
| `--pkg <包名>` | Android 包名，至少两段、每段不能以数字开头、不能是 Java 关键字 | `com.html2apk.<名称>` |
| `--out <file.apk>` | 输出 APK 路径 | HTML 同目录 `<名称>-<版本>.apk` |
| `--version <x.y>` | 版本名 | `1.0` |
| `--code <n>` | 版本号（整数，升级需递增） | `1` |
| `--mode https\|file` | `https`：网页获得安全上下文（**推荐**）；`file`：传统 file:// 加载，兼容性优先 | `https` |
| `--icon <png>` | 应用图标，建议 512×512 正方形 PNG | 模板默认图标 |
| `--splash-image <png>` | 启动页图片（支持 GIF 动图） | 图标启动页 |
| `--splash-duration <秒>` | 启动页最短展示秒数，`0` = 展示到首帧加载完成 | `0` |
| `--splash-size <dp>` | 图标型启动页的图标大小 | `96` |
| `--splash-square` | 启动页图标不圆角 | 圆角 |
| `--no-splash` | 关闭启动页 | 开启 |
| `--perm <列表>` | 权限，逗号分隔：`cam` `mic` `audio` `loc` `store` `notif` `vib` `wake`；`all` 全开 | 仅 `INTERNET` |
| `--key <file>` | 签名密钥文件路径 | `~/.html2apk/signing-key.json` |
| `--cert-cn <名称>` | 签名证书 CN | `HTML2APK-<包名>` |
| `--reset-key` | 丢弃旧密钥重新生成（旧包需卸载重装） | 复用 |
| `--json` | JSON 格式输出结果，便于脚本解析 | 文字输出 |
| `-V`, `--tool-version` | 显示本工具版本 | — |
| `-h`, `--help` | 显示帮助 | — |

所有 `--参数 值` 也支持 `--参数=值` 形式。签名密钥路径还可用环境变量 `HTML2APK_KEY` 指定，优先级：`--key` > `HTML2APK_KEY` > 默认路径。

## 工作原理

```
template.apk ──解析 ZIP──> AndroidManifest.xml ──二进制 AXML 改写──> 包名/名称/版本/权限/meta-data
                     └──> assets/index.html ──注入──> 你的 HTML
                     └──> 图标/启动页资源 ──替换──> 自定义图片
                                  │
                                  ▼
                            重建 ZIP → APK v2 签名 → 输出 .apk
```

- **AXML 改写**：直接解析/序列化 Android 二进制 XML，增删 `uses-permission`、改写 `package` / `versionCode` / `versionName` / `label` 与 `meta-data`，不依赖 aapt。
- **ZIP 重建**：自行实现 local header / central directory / EOCD，保留 UTF-8 文件名标志。
- **签名**：纯 WebCrypto 生成 2048 位 RSA 自签名证书，实现 APK Signature Scheme v2（分块SHA-256 摘要 + 签名块）。

## 签名与密钥

- 密钥文件（默认 `~/.html2apk/signing-key.json`）包含**私钥**，是覆盖升级的唯一凭据。
- **不要把密钥文件提交到 Git**，也不要发给别人。持有它的人可以用你的签名给同包名应用升级。
- 换机器、换密钥或重装系统导致密钥丢失后，新包无法覆盖旧包，需先卸载旧包再安装。
- 使用 `--key` 可为不同应用维护不同密钥；使用 `--reset-key` 主动换新密钥。

## 限制

- **单文件 HTML**：模板只注入 `assets/index.html` 一个文件。外部 CSS / JS / 图片若用相对路径会失效，需内联（base64 / 内联 style/script）或改成绝对 URL。
- **图标不缩放**：CLI 无图像处理库，提供的图标原样写入 5 档密度目录，请自备 512×512 正方形 PNG。
- **无真机验证**：本工具只负责构建，无法在构建环境验证安装与运行行为，安装由用户侧完成。
- **自签名**：未接入应用商店签名体系，部分手机可能拦截安装，需手动允许「未知来源」。

## 浏览器 GUI 版

双击打开 `tools/HTML转APK打包器.html` 即可在浏览器中使用，功能与 CLI 一致，额外支持拖拽选图标、可视化调启动页参数，**完全离线**。

> 注意：GUI 版密钥保存在浏览器 `localStorage`（键名 `h2a_key`），与 CLI 的密钥文件**互不相通**。用 GUI 打的包和用 CLI 打的包签名不同，覆盖安装前需卸载旧包。

## 开发

```bash
git clone https://github.com/liyuyang211/html-to-apk.git
cd html-to-apk
npm test          # 运行全部单元测试（Node 内置 test runner，零依赖）
```

项目结构：

```
html-to-apk/
├── scripts/
│   ├── html2apk.js            # CLI 入口
│   ├── packer-core.js         # 打包核心库（ZIP / AXML / v2 签名）
│   ├── load-template.js       # 模板加载器（二进制优先，回退 base64）
│   ├── template.apk.base64    # WebView 模板 APK 的 base64 文本（仓库分发形态）
│   └── template.apk           # 同上的二进制副本（本地可选，不入库）
├── tools/
│   └── HTML转APK打包器.html  # 浏览器 GUI 版（自包含，离线可用）
└── test/                 # 单元测试
```

欢迎提交 Issue 和 PR，详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

[MIT](./LICENSE) © 2026 liyuyang211
