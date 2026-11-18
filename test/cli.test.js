'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'html2apk.js');
const FIX = path.join(__dirname, 'fixtures');
const BASIC = path.join(FIX, 'basic.html');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}
function cleanup(...files) {
  for (const f of files) { try { fs.unlinkSync(f); } catch (e) { /* 忽略 */ } }
}

test('--help 输出完整帮助', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /HTML -> APK 本地打包器/);
  assert.match(r.stdout, /--key/);
});

test('-V 与 --tool-version 输出版本号', () => {
  for (const flag of ['-V', '--tool-version']) {
    const r = run([flag]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /html2apk 1\.0\.0/);
  }
});

test('缺少 --html 时 JSON 模式返回结构化错误', () => {
  const r = run(['--json']);
  assert.equal(r.status, 1);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
  assert.match(j.error, /缺少 --html/);
});

test('非法包名被拒绝', () => {
  const r = run(['--html', BASIC, '--pkg', 'single', '--json']);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /至少需要两段/);
});

test('完整打包：自定义密钥路径、产物有效、同密钥复用', (t) => {
  const key = path.join(FIX, 'cli-key.json');
  const out = path.join(FIX, 'cli.apk');
  t.after(() => cleanup(key, out));

  const args = ['--html', BASIC, '--name', 'CLI测试', '--pkg', 'com.example.clitest', '--key', key, '--out', out, '--json'];
  const r = run(args);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.package, 'com.example.clitest');
  assert.equal(j.app_name, 'CLI测试');
  assert.equal(j.key_file, key);
  assert.ok(j.size_kb > 100);
  assert.ok(fs.existsSync(out), 'APK 未生成');
  assert.ok(fs.existsSync(key), '密钥未生成');

  const certBefore = JSON.parse(fs.readFileSync(key, 'utf8')).cert;
  const r2 = run(args);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(JSON.parse(r2.stdout).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(key, 'utf8')).cert, certBefore, '第二次打包应复用同一签名证书');
});

test('支持 --参数=值 形式', (t) => {
  const key = path.join(FIX, 'eq-key.json');
  const out = path.join(FIX, 'eq.apk');
  t.after(() => cleanup(key, out));

  const r = run([
    '--html=' + BASIC, '--name=等号测试', '--pkg=com.example.eq',
    '--key=' + key, '--out=' + out, '--json'
  ]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.app_name, '等号测试');
});

test('UTF-16 编码自动转换并统一 charset 声明', (t) => {
  const src = path.join(FIX, 'utf16.html');
  const key = path.join(FIX, 'utf16-key.json');
  const out = path.join(FIX, 'utf16.apk');
  t.after(() => cleanup(src, key, out));

  const html = '<!doctype html><html><head><meta charset="utf-16"></head><body>中文测试</body></html>';
  fs.writeFileSync(src, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(html, 'utf16le')]));

  const r = run(['--html', src, '--key', key, '--out', out, '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.match(j.encoding_note, /UTF-16/);
  assert.match(j.encoding_note, /charset/);
});
