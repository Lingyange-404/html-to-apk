'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

if (!globalThis.crypto || !globalThis.crypto.subtle) {
  globalThis.crypto = require('node:crypto').webcrypto;
}

const PackTool = require('../scripts/packer-core.js');
const { loadTemplate } = require('../scripts/load-template.js');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const TEMPLATE = loadTemplate(SCRIPTS);
const enc = new TextEncoder();

function asBuffer(u8) { return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength); }
async function inflateRaw(u8) { return new Uint8Array(zlib.inflateRawSync(asBuffer(u8))); }
async function deflateRaw(u8) { return new Uint8Array(zlib.deflateRawSync(asBuffer(u8))); }
async function maybeInflate(entry) { return entry.method === 8 ? inflateRaw(entry.data) : entry.data; }

test('crc32 匹配标准测试向量', () => {
  assert.equal(PackTool.crc32(enc.encode('123456789')), 0xCBF43926);
});

test('parseZip 能解析模板 APK 并找到关键条目', () => {
  const zip = PackTool.parseZip(TEMPLATE.slice());
  const names = zip.entries.map(e => e.name);
  assert.ok(names.includes('AndroidManifest.xml'), '缺少 AndroidManifest.xml');
  assert.ok(names.includes('assets/index.html'), '缺少 assets/index.html');
  assert.ok(zip.cdOff > 0 && zip.cdSize > 0);
});

test('buildZip / parseZip 往返保持内容与文件名', async () => {
  const items = [
    { name: 'a.txt', data: enc.encode('hello world '.repeat(20)), store: false },
    { name: 'dir/b.bin', data: new Uint8Array([0, 1, 2, 3, 250, 255]), store: true },
    { name: '空文件.txt', data: new Uint8Array(0), store: false }
  ];
  const built = await PackTool.buildZip(items, deflateRaw);
  const parsed = PackTool.parseZip(built);
  assert.equal(parsed.entries.length, items.length);
  for (let i = 0; i < items.length; i++) {
    assert.equal(parsed.entries[i].name, items[i].name);
    assert.deepEqual(await maybeInflate(parsed.entries[i]), items[i].data);
  }
});

test('AXML 解析/序列化往返保持字符串池与节点数', async () => {
  const zip = PackTool.parseZip(TEMPLATE.slice());
  const mf = zip.entries.find(e => e.name === 'AndroidManifest.xml');
  const doc = PackTool.parseAxml(await maybeInflate(mf));
  const stringsBefore = doc.pool.strings.slice();
  const nodesBefore = doc.nodes.length;
  const doc2 = PackTool.parseAxml(PackTool.serializeAxml(doc));
  assert.deepEqual(doc2.pool.strings, stringsBefore);
  assert.equal(doc2.nodes.length, nodesBefore);
});

test('buildApk 注入 HTML、改写 manifest 并生成 v2 签名 APK', async () => {
  const template = TEMPLATE.slice();
  const html = enc.encode('<!doctype html><html><head><meta charset="utf-8"></head><body><h1>你好</h1></body></html>');

  const result = await PackTool.buildApk(template, {
    packageName: 'com.example.unittest',
    appName: '单测应用',
    versionName: '2.3',
    versionCode: 7,
    mode: 'https',
    permissions: ['android.permission.INTERNET', 'android.permission.VIBRATE'],
    htmlBytes: html,
    splash: { type: 'icon', iconSizeDp: 96, iconRound: true },
    certCN: 'html2apk-unittest'
  }, { inflate: inflateRaw, deflate: deflateRaw });

  assert.ok(result.apk.length > 100000, 'APK 体积异常');
  assert.ok(result.keyInfo.cert.length > 100, '证书未生成');

  const zip = PackTool.parseZip(result.apk);

  const htmlEntry = zip.entries.find(e => e.name === 'assets/index.html');
  assert.ok(htmlEntry, 'HTML 未注入');
  assert.deepEqual(await maybeInflate(htmlEntry), html);

  const mf = zip.entries.find(e => e.name === 'AndroidManifest.xml');
  const doc = PackTool.parseAxml(await maybeInflate(mf));
  assert.ok(doc.pool.strings.includes('com.example.unittest'), '包名未改写');
  assert.ok(doc.pool.strings.includes('2.3'), '版本名未改写');
  assert.ok(doc.pool.strings.includes('单测应用'), '应用名未改写');

  const perms = [];
  for (const nd of doc.nodes) {
    if (nd.t !== 0x0102) continue; // N_START_EL
    if (doc.pool.strings[nd.name] !== 'uses-permission') continue;
    const pa = nd.attrs.find(a => doc.pool.strings[a.name] === 'name');
    if (pa) perms.push(doc.pool.strings[pa.data]);
  }
  assert.ok(perms.includes('android.permission.INTERNET'), 'INTERNET 权限丢失');
  assert.ok(perms.includes('android.permission.VIBRATE'), 'VIBRATE 权限丢失');
  assert.ok(!perms.some(p => p.indexOf('CAMERA') >= 0), '多余权限未清除');

  const buf = Buffer.from(result.apk.buffer, result.apk.byteOffset, result.apk.byteLength);
  assert.ok(buf.includes(Buffer.from('APK Sig Block 42')), '签名块 magic 缺失');
});

test('复用同一密钥可保持证书一致（覆盖升级前提）', async () => {
  const template = TEMPLATE.slice();
  const io = { inflate: inflateRaw, deflate: deflateRaw };
  const base = {
    packageName: 'com.example.reuse', appName: '复用测试',
    versionName: '1.0', versionCode: 1, htmlBytes: enc.encode('<html></html>')
  };
  const a = await PackTool.buildApk(template, base, io);
  const b = await PackTool.buildApk(template, Object.assign({}, base, { keyInfo: a.keyInfo }), io);
  assert.deepEqual(b.keyInfo.cert, a.keyInfo.cert);
  assert.ok(b.apk.length > 0);
});
