#!/usr/bin/env node
/**
 * HTML -> APK 本地打包器（命令行版，100% 离线）
 *
 * 核心逻辑来源于离线打包工具页面（tools/HTML转APK打包器.html），
 * 此处抽出为 Node CLI：解析模板 APK -> 注入 HTML -> 改写 AndroidManifest
 * -> 重建 ZIP -> APK v2 自签名。全程不联网，不依赖 Gradle / Android SDK。
 *
 * 项目主页：https://github.com/liyuyang211/html-to-apk
 *
 * 用法：
 *   node html2apk.js --html <file.html> --name "应用名" [--pkg com.xxx.app]
 *        [--out <file.apk>] [--version 1.0] [--code 1] [--mode https|file]
 *        [--icon <icon.png>] [--splash-image <img.png>] [--no-splash]
 *        [--perm cam,mic,loc,store,notif,vib,wake,audio]
 *        [--key <file>] [--cert-cn <名称>] [--reset-key] [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

// Node 18 中 globalThis.crypto 可能缺失，补齐后再加载核心库（核心库使用 global.crypto.subtle）
if (!globalThis.crypto || !globalThis.crypto.subtle) {
  globalThis.crypto = require('crypto').webcrypto;
}
const PackTool = require('./packer-core.js');
const { loadTemplate } = require('./load-template.js');

const TOOL_VERSION = '1.0.0';
// 签名密钥默认放在用户主目录，不污染安装目录。
// 用 --key 或环境变量 HTML2APK_KEY 可覆盖；同一密钥可覆盖安装升级。
const DEFAULT_KEY_FILE = path.join(os.homedir(), '.html2apk', 'signing-key.json');

const HELP = `HTML -> APK 本地打包器 v${TOOL_VERSION}
100% 离线 · 无需 Android SDK / Gradle · APK v2 自签名

用法:
  html2apk --html <file.html> [选项]

必填:
  --html <file>            单文件 HTML（.html / .htm / .xhtml / .txt）

常用选项:
  --name <名称>             应用显示名（默认取 HTML 文件名）
  --pkg <包名>              Android 包名，如 com.example.app（默认自动生成）
  --out <file.apk>          输出路径（默认 HTML 同目录 <名称>-<版本>.apk）
  --version <x.y>           应用版本名（默认 1.0）
  --code <n>                版本号整数，升级需递增（默认 1）
  --key <file>              签名密钥路径（默认 ~/.html2apk/signing-key.json）
                            也可用环境变量 HTML2APK_KEY 指定

外观:
  --icon <png>              应用图标，建议 512x512 PNG（写入 5 档密度）
  --splash-image <png>      自定义启动页图片（支持 GIF）
  --splash-duration <秒>    启动页最短展示秒数，0 = 展示到首帧（默认 0）
  --splash-size <dp>        图标启动页大小（默认 96）
  --splash-square           启动页图标不圆角
  --no-splash               关闭启动页

其他:
  --mode https|file         https=安全上下文（推荐）/ file=兼容优先（默认 https）
  --perm <列表>             逗号分隔: cam,mic,audio,loc,store,notif,vib,wake,all
  --cert-cn <名称>          签名证书 CN（默认 HTML2APK-<包名>）
  --reset-key               丢弃旧密钥重新生成（旧包需卸载重装）
  --json                    JSON 格式输出结果
  -V, --tool-version        显示本工具版本
  -h, --help                显示本帮助

示例:
  html2apk --html ./index.html --name "我的工具" --pkg com.example.tool
  html2apk --html ./game.html --icon ./icon.png --perm cam,vib --json

注意: HTML 必须是单文件；外部 CSS/JS/图片请用绝对 URL 或内联 base64。
`;

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { opts.help = true; continue; }
    if (a === '-V') { opts['tool-version'] = true; continue; }
    if (!a.startsWith('--')) continue;
    // 支持 --key=value 形式
    const eq = a.indexOf('=');
    if (eq > 2) { opts[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { opts[k] = true; continue; }
    opts[k] = next; i++;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const jsonMode = !!opts.json;
const log = jsonMode ? function () {} : function (...a) { console.log(...a); };

function fail(msg) {
  if (jsonMode) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error('❌ ' + msg);
  process.exit(1);
}

// ---------- 压缩流（deflate-raw，用 Node 内置 zlib，兼容 Node 18+） ----------
function asBuffer(u8) { return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength); }
async function inflateRaw(u8) { return new Uint8Array(zlib.inflateRawSync(asBuffer(u8))); }
async function deflateRaw(u8) { return new Uint8Array(zlib.deflateRawSync(asBuffer(u8))); }

// ---------- HTML 读取与编码修复 ----------
function countBad(s) { let n = 0; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0xFFFD) n++; return n; }

function readHtmlBytes(file) {
  let u8 = new Uint8Array(fs.readFileSync(file));
  let note = null;

  if (u8.length >= 2 && ((u8[0] === 0xFF && u8[1] === 0xFE) || (u8[0] === 0xFE && u8[1] === 0xFF))) {
    const be = u8[0] === 0xFE;
    const t16 = new TextDecoder(be ? 'utf-16be' : 'utf-16le').decode(u8);
    u8 = new TextEncoder().encode(t16);
    note = '检测到 UTF-16 编码，已自动转为 UTF-8';
  } else if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) {
    u8 = u8.subarray(3);
  } else {
    const bad = countBad(new TextDecoder('utf-8').decode(u8));
    if (bad > 2) {
      try {
        const gbk = new TextDecoder('gb18030').decode(u8);
        if (countBad(gbk) < bad) {
          u8 = new TextEncoder().encode(gbk);
          note = '检测到 GBK/GB18030 编码（' + bad + ' 处乱码），已自动转为 UTF-8';
        }
      } catch (e) { /* 忽略，保持原字节 */ }
    }
  }

  // 统一 charset 声明为 utf-8：转码后旧声明（如 utf-16 / gbk）会误导 WebView 导致乱码
  const head = new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 4096)));
  const charsetMatch = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i);
  if (charsetMatch) {
    if (!/^utf-?8$/i.test(charsetMatch[1])) {
      let text = new TextDecoder().decode(u8);
      text = text.replace(/(<meta[^>]+charset\s*=\s*["']?\s*)([a-z0-9_-]+)/i, '$1utf-8');
      u8 = new TextEncoder().encode(text);
      note = (note ? note + '；' : '') + 'charset 声明已统一为 utf-8';
    }
  } else {
    let text = new TextDecoder().decode(u8);
    const insert = '<meta charset="utf-8">';
    const m = text.match(/<head[^>]*>/i);
    if (m) text = text.replace(m[0], m[0] + insert);
    else if (/<html[^>]*>/i.test(text)) text = text.replace(/<html[^>]*>/i, x => x + insert);
    else text = insert + text;
    u8 = new TextEncoder().encode(text);
  }
  return { bytes: u8, note: note };
}

function extractHosts(text) {
  const re = /https?:\/\/([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const seen = {}, out = [];
  let m;
  while ((m = re.exec(text)) && out.length < 12) {
    const h = m[1].toLowerCase();
    if (seen[h] || h === 'localhost' || h === 'appassets.local' || h.endsWith('.local')) continue;
    seen[h] = 1; out.push(h);
  }
  return out;
}

// ---------- 包名处理 ----------
const JAVA_KEYS = ['abstract','assert','boolean','break','byte','case','catch','char','class','const','continue','default','do','double','else','enum','extends','final','finally','float','for','goto','if','implements','import','instanceof','int','interface','long','native','new','package','private','protected','public','return','short','static','strictfp','super','switch','synchronized','this','throw','throws','transient','try','void','volatile','while'];

function safePkg(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9._]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
}

function suggestPkg(name) {
  const base = safePkg(name).replace(/[^a-z0-9]/g, '') || 'app';
  return 'com.html2apk.' + (/^[0-9]/.test(base) ? 'a' + base : base);
}

// ---------- 权限 ----------
const PERM_MAP = {
  cam: ['android.permission.CAMERA'],
  mic: ['android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS'],
  audio: ['android.permission.MODIFY_AUDIO_SETTINGS'],
  loc: ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'],
  store: ['android.permission.WRITE_EXTERNAL_STORAGE', 'android.permission.READ_EXTERNAL_STORAGE'],
  notif: ['android.permission.POST_NOTIFICATIONS'],
  vib: ['android.permission.VIBRATE'],
  wake: ['android.permission.WAKE_LOCK']
};

// ---------- 签名密钥持久化（保证同包名可覆盖安装升级） ----------
// keyFile 在 main() 中根据 --key / 环境变量 / 默认值解析后赋值。
function loadKey() {
  try {
    const j = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    if (j && j.cert && j.spki && j.pkcs8) {
      return { cert: new Uint8Array(j.cert), spki: new Uint8Array(j.spki), pkcs8: new Uint8Array(j.pkcs8) };
    }
  } catch (e) { /* 无密钥文件 */ }
  return null;
}
function saveKey(k) {
  try {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, JSON.stringify({
      cert: Array.from(k.cert), spki: Array.from(k.spki), pkcs8: Array.from(k.pkcs8),
      saved_at: new Date().toISOString()
    }), 'utf8');
  } catch (e) { /* 保存失败不阻断 */ }
}

let keyFile; // 由 main() 初始化

// ---------- 主流程 ----------
(async function main() {
  if (opts.help || opts.h) { console.log(HELP); return; }
  if (opts['tool-version'] || opts.version === true) {
    console.log('html2apk ' + TOOL_VERSION);
    return;
  }
  if (opts.key === true) fail('--key 需要指定密钥文件路径');

  keyFile = path.resolve(
    typeof opts.key === 'string' ? opts.key :
    ((typeof process.env.HTML2APK_KEY === 'string' && process.env.HTML2APK_KEY) ? process.env.HTML2APK_KEY : DEFAULT_KEY_FILE)
  );

  const htmlFile = typeof opts.html === 'string' ? opts.html : null;
  if (!htmlFile) fail('缺少 --html <file.html>');
  if (!fs.existsSync(htmlFile)) fail('HTML 文件不存在：' + htmlFile);
  if (!/\.(html?|xhtml|txt)$/i.test(htmlFile)) fail('HTML 扩展名不支持（仅 .html / .htm / .xhtml / .txt）');

  const appName = String(opts.name || path.basename(htmlFile, path.extname(htmlFile))).trim() || 'MyApp';
  let pkg = safePkg(opts.pkg || suggestPkg(appName));
  const segs = pkg.split('.');
  if (segs.length < 2) fail('包名至少需要两段，例如 com.example.app（当前：' + pkg + '）');
  for (const s of segs) {
    if (!s) fail('包名存在空段：' + pkg);
    if (/^[0-9]/.test(s)) fail('包名段不能以数字开头：' + s);
    if (JAVA_KEYS.indexOf(s) >= 0) fail('包名段「' + s + '」是 Java 关键字，不能使用');
  }

  const versionName = String(opts.version || '1.0');
  const versionCode = Math.max(1, parseInt(opts.code || '1', 10) || 1);
  const mode = String(opts.mode || 'https').toLowerCase() === 'file' ? 'file' : 'https';

  const outFile = typeof opts.out === 'string'
    ? opts.out
    : path.join(path.dirname(path.resolve(htmlFile)),
        (appName + '-' + versionName).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim() + '.apk');

  // 图标：无图像处理库，直接把同一张 PNG 写入 5 档密度目录（建议 512×512 正方形）
  let icons = null;
  if (typeof opts.icon === 'string') {
    if (!fs.existsSync(opts.icon)) fail('图标文件不存在：' + opts.icon);
    if (!/\.(png|jpe?g|webp|bmp|gif)$/i.test(opts.icon)) fail('图标格式不支持（PNG / JPG / WebP / BMP / GIF）');
    const b = new Uint8Array(fs.readFileSync(opts.icon));
    icons = {};
    PackTool.ICON_DENSITIES.forEach(d => { icons[d[0]] = b; });
    log('图标：' + opts.icon + '（已写入 5 档密度，建议 512×512 正方形）');
  }

  // 启动页
  let splash = null;
  if (!opts['no-splash']) {
    if (typeof opts['splash-image'] === 'string') {
      if (!fs.existsSync(opts['splash-image'])) fail('启动页图片不存在：' + opts['splash-image']);
      splash = {
        type: 'image',
        imageBytes: new Uint8Array(fs.readFileSync(opts['splash-image'])),
        durationMs: Math.round(parseFloat(opts['splash-duration'] || '0') * 1000) || 0
      };
    } else {
      splash = { type: 'icon', iconSizeDp: parseInt(opts['splash-size'] || '96', 10) || 96, iconRound: opts['splash-square'] ? false : true };
    }
  }

  // 权限
  const perms = ['android.permission.INTERNET'];
  if (typeof opts.perm === 'string' && opts.perm !== 'all') {
    opts.perm.split(',').map(s => s.trim().toLowerCase()).forEach(k => {
      if (PERM_MAP[k]) PERM_MAP[k].forEach(p => { if (perms.indexOf(p) < 0) perms.push(p); });
    });
  } else if (opts.perm === true || opts.perm === 'all') {
    perms.push('android.permission.ACCESS_NETWORK_STATE', 'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS',
      'android.permission.WRITE_EXTERNAL_STORAGE', 'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.POST_NOTIFICATIONS', 'android.permission.VIBRATE', 'android.permission.WAKE_LOCK');
  }

  const hr = readHtmlBytes(htmlFile);
  if (hr.note) log('· ' + hr.note);
  const hosts = extractHosts(new TextDecoder().decode(hr.bytes));

  const templateU8 = loadTemplate(__dirname);
  if (!templateU8) fail('模板缺失：需要 scripts/template.apk 或 scripts/template.apk.base64');

  let keyInfo = opts['reset-key'] ? null : loadKey();
  if (!keyInfo) log('生成 2048 位签名密钥（仅首次，约 1 秒）… → ' + keyFile);

  const t0 = Date.now();
  let result;
  try {
    result = await PackTool.buildApk(templateU8, {
      packageName: pkg,
      appName: appName,
      versionName: versionName,
      versionCode: versionCode,
      mode: mode,
      warmupHosts: hosts.join(','),
      permissions: perms,
      htmlBytes: hr.bytes,
      icons: icons,
      splash: splash,
      keyInfo: keyInfo,
      certCN: String(opts['cert-cn'] || ('HTML2APK-' + pkg))
    }, { inflate: inflateRaw, deflate: deflateRaw });
  } catch (e) {
    fail('打包失败：' + ((e && e.message) || e));
  }
  saveKey(result.keyInfo);

  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(result.apk));

  const out = {
    ok: true,
    apk: path.resolve(outFile),
    size_kb: Math.round(result.apk.length / 1024),
    package: pkg,
    app_name: appName,
    version_name: versionName,
    version_code: versionCode,
    mode: mode,
    permissions: perms,
    warmup_hosts: hosts,
    splash: splash ? (splash.type === 'image' ? '图片启动页' : '图标启动页 ' + splash.iconSizeDp + 'dp') : '关闭',
    ms: Date.now() - t0,
    encoding_note: hr.note,
    key_file: keyFile,
    signing_key: keyFile
  };

  if (jsonMode) { console.log(JSON.stringify(out, null, 2)); return; }

  log('');
  log('✅ 构建成功：' + out.apk);
  log('   包名：' + pkg + '   版本：' + versionName + '（code ' + versionCode + '）');
  log('   大小：' + out.size_kb + ' KB   耗时：' + out.ms + ' ms   加载模式：' + mode);
  log('   权限：' + perms.map(p => p.replace('android.permission.', '')).join(', '));
  log('   启动页：' + out.splash + '   签名密钥：' + keyFile);
  if (hosts.length) log('   预热域名：' + hosts.join(', '));
  log('');
  log('提示：APK 为 v2 自签名，安装时若提示「未知应用」需允许安装；同一密钥打包可覆盖升级。');
})();
