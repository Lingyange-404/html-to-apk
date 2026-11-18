'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 加载 WebView 模板 APK。
 * 优先读取二进制 scripts/template.apk（本地开发快），
 * 若不存在则从 scripts/template.apk.base64 解码（便于纯文本分发，如 Git 仓库）。
 * 两者内容应完全一致。
 *
 * @param {string} scriptsDir scripts 目录的绝对路径
 * @returns {Uint8Array|null} 模板 APK 字节，缺失时返回 null
 */
function loadTemplate(scriptsDir) {
  const bin = path.join(scriptsDir, 'template.apk');
  if (fs.existsSync(bin)) return new Uint8Array(fs.readFileSync(bin));

  const b64 = path.join(scriptsDir, 'template.apk.base64');
  if (fs.existsSync(b64)) {
    const text = fs.readFileSync(b64, 'utf8').replace(/\s+/g, '');
    return new Uint8Array(Buffer.from(text, 'base64'));
  }
  return null;
}

module.exports = { loadTemplate };
