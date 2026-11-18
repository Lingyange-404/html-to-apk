(function (global) {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function concatU8(a, b) {
    var o = new Uint8Array(a.length + b.length);
    o.set(a); o.set(b, a.length);
    return o;
  }
  function u8ToB64(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  function b64ToU8(b64) {
    var s = atob(b64), u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  var utf8enc = new TextEncoder();
  var utf8dec = new TextDecoder('utf-8');

  function parseZip(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65536); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP: EOCD 未找到');
    var count = dv.getUint16(eocd + 10, true);
    var cdOff = dv.getUint32(eocd + 16, true);
    var entries = [];
    var p = cdOff;
    for (var e = 0; e < count; e++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP: 中央目录损坏 @' + p);
      var method = dv.getUint16(p + 10, true);
      var csize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOff = dv.getUint32(p + 42, true);
      var name = utf8dec.decode(u8.subarray(p + 46, p + 46 + nameLen));

      if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error('ZIP: 本地头损坏 @' + name);
      var lNameLen = dv.getUint16(localOff + 26, true);
      var lExtraLen = dv.getUint16(localOff + 28, true);
      var dataStart = localOff + 30 + lNameLen + lExtraLen;
      entries.push({
        name: name, method: method, csize: csize,
        data: u8.subarray(dataStart, dataStart + csize)
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries: entries, cdOff: cdOff, cdSize: dv.getUint32(eocd + 12, true) };
  }

  function dosDateTime(d) {
    d = d || new Date();
    var time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
    var date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
    return { time: time, date: date };
  }
  function buildZip(items, deflateFn) {
    var dt = dosDateTime();
    var chunks = [], central = [], offset = 0;
    var enc = utf8enc;
    return (async function () {
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var nameBytes = enc.encode(it.name);
        var crc = crc32(it.data);
        var method = 0, payload = it.data;
        if (!it.store && it.data.length > 0 && deflateFn) {
          payload = await deflateFn(it.data);
          if (payload.length < it.data.length) method = 8; else payload = it.data;
        }
        var lh = new Uint8Array(30 + nameBytes.length);
        var dv = new DataView(lh.buffer);
        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(6, 0x0800, true);
        dv.setUint16(8, method, true);
        dv.setUint16(10, dt.time, true);
        dv.setUint16(12, dt.date, true);
        dv.setUint32(14, crc, true);
        dv.setUint32(18, payload.length, true);
        dv.setUint32(22, it.data.length, true);
        dv.setUint16(26, nameBytes.length, true);
        dv.setUint16(28, 0, true);
        lh.set(nameBytes, 30);
        chunks.push(lh, payload);
        central.push({ nameBytes: nameBytes, method: method, crc: crc, csize: payload.length, usize: it.data.length, offset: offset });
        offset += lh.length + payload.length;
      }
      var cdStart = offset, cdSize = 0;
      for (var j = 0; j < central.length; j++) {
        var c = central[j];
        var ce = new Uint8Array(46 + c.nameBytes.length);
        var cv = new DataView(ce.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, c.method, true);
        cv.setUint16(12, dt.time, true);
        cv.setUint16(14, dt.date, true);
        cv.setUint32(16, c.crc, true);
        cv.setUint32(20, c.csize, true);
        cv.setUint32(24, c.usize, true);
        cv.setUint16(28, c.nameBytes.length, true);
        cv.setUint32(42, c.offset, true);
        ce.set(c.nameBytes, 46);
        chunks.push(ce);
        cdSize += ce.length;
        offset += ce.length;
      }
      var eocd = new Uint8Array(22);
      var ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, central.length, true);
      ev.setUint16(10, central.length, true);
      ev.setUint32(12, cdSize, true);
      ev.setUint32(16, cdStart, true);
      chunks.push(eocd);
      var total = 0;
      for (var k = 0; k < chunks.length; k++) total += chunks[k].length;
      var out = new Uint8Array(total), o = 0;
      for (var m = 0; m < chunks.length; m++) { out.set(chunks[m], o); o += chunks[m].length; }
      return out;
    })();
  }

  var CHUNK_DOC = 0x0003, CHUNK_POOL = 0x0001, CHUNK_RESMAP = 0x0180;
  var N_START_NS = 0x0100, N_END_NS = 0x0101, N_START_EL = 0x0102, N_END_EL = 0x0103, N_TEXT = 0x0104;
  var T_STRING = 0x03, T_FIRST_INT = 0x10;

  var utf16dec = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-16le') : null;
  function parsePool(u8, dv, pos) {
    var count = dv.getUint32(pos + 8, true);
    var styleCount = dv.getUint32(pos + 12, true);
    var flags = dv.getUint32(pos + 16, true);
    var stringsStart = dv.getUint32(pos + 20, true);
    var isUtf8 = (flags & 0x100) !== 0;
    var strings = [];
    for (var i = 0; i < count; i++) {
      var off = pos + stringsStart + dv.getUint32(pos + 28 + 4 * i, true);
      if (isUtf8) {
        var p = off, n16 = u8[p++];
        if (n16 & 0x80) n16 = ((n16 & 0x7f) << 8) | u8[p++];
        var n8 = u8[p++];
        if (n8 & 0x80) n8 = ((n8 & 0x7f) << 8) | u8[p++];
        strings.push(utf8dec.decode(u8.subarray(p, p + n8)));
      } else {
        var q = off, len = dv.getUint16(q, true); q += 2;
        if (len & 0x8000) { len = ((len & 0x7fff) << 16) | dv.getUint16(q, true); q += 2; }
        var chars = new Uint8Array(len * 2);
        for (var c = 0; c < len * 2; c++) chars[c] = u8[q + c];
        strings.push(utf16dec.decode(chars));
      }
    }
    return { strings: strings, flags: flags, styleCount: styleCount, count: count };
  }
  function parseAxml(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var pos = 8;
    var pool = null, resMap = null, nodes = [];
    while (pos < u8.length) {
      var type = dv.getUint16(pos, true);
      var size = dv.getUint32(pos + 4, true);
      if (type === CHUNK_POOL) {
        pool = parsePool(u8, dv, pos);
      } else if (type === CHUNK_RESMAP) {
        var n = (size - 8) / 4; resMap = [];
        for (var i = 0; i < n; i++) resMap.push(dv.getUint32(pos + 8 + 4 * i, true));
      } else if (type === N_START_NS) {
        nodes.push({ t: type, prefix: dv.getUint32(pos + 16, true), uri: dv.getUint32(pos + 20, true) });
      } else if (type === N_END_NS) {
        nodes.push({ t: type, prefix: dv.getUint32(pos + 16, true), uri: dv.getUint32(pos + 20, true) });
      } else if (type === N_START_EL) {
        var ns = dv.getUint32(pos + 16, true);
        var name = dv.getUint32(pos + 20, true);
        var attrStart = dv.getUint16(pos + 24, true);
        var attrSize = dv.getUint16(pos + 26, true);
        var attrCount = dv.getUint16(pos + 28, true);
        var attrs = [];
        var ap = pos + 16 + attrStart;
        for (var a = 0; a < attrCount; a++) {
          var ap2 = ap + a * attrSize;
          attrs.push({
            ns: dv.getUint32(ap2, true),
            name: dv.getUint32(ap2 + 4, true),
            raw: dv.getUint32(ap2 + 8, true),
            type: dv.getUint8(ap2 + 15),
            data: dv.getUint32(ap2 + 16, true)
          });
        }
        nodes.push({ t: type, ns: ns, name: name, attrs: attrs });
      } else if (type === N_END_EL) {
        nodes.push({ t: type, ns: dv.getUint32(pos + 16, true), name: dv.getUint32(pos + 20, true) });
      } else if (type === N_TEXT) {
        nodes.push({ t: type, data: dv.getUint32(pos + 16, true) });
      } else {
        nodes.push({ t: type, raw: u8.subarray(pos, pos + size) });
      }
      pos += size;
    }
    return { u8: u8, pool: pool, resMap: resMap, nodes: nodes };
  }

  function encodePoolEntry(str, isUtf8) {
    var out = [];
    if (isUtf8) {
      var bytes = utf8enc.encode(str);
      var n16 = str.length, n8 = bytes.length;
      if (n16 < 0x80) out.push(n16); else out.push(0x80 | (n16 >> 8), n16 & 0xff);
      if (n8 < 0x80) out.push(n8); else out.push(0x80 | (n8 >> 8), n8 & 0xff);
      for (var i = 0; i < bytes.length; i++) out.push(bytes[i]);
      out.push(0);
    } else {
      var len = str.length;
      if (len < 0x8000) { out.push(len & 0xff, (len >> 8) & 0xff); }
      else {
        var hi = 0x8000 | ((len >> 16) & 0x7fff);
        out.push(hi & 0xff, (hi >> 8) & 0xff, len & 0xff, (len >> 8) & 0xff);
      }
      for (var j = 0; j < len; j++) {
        var code = str.charCodeAt(j);
        out.push(code & 0xff, (code >> 8) & 0xff);
      }
      out.push(0, 0);
    }
    return out;
  }

  function serializePool(pool) {
    var isUtf8 = (pool.flags & 0x100) !== 0;
    var offsets = [], datas = [];
    var cur = 0;
    for (var i = 0; i < pool.strings.length; i++) {
      offsets.push(cur);
      var enc = encodePoolEntry(pool.strings[i], isUtf8);
      datas.push(enc);
      cur += enc.length;
    }
    var stringsStart = 28 + 4 * pool.strings.length + 4 * (pool.styleCount || 0);
    var pad = (4 - (cur % 4)) % 4;
    var total = stringsStart + cur + pad;
    var u8 = new Uint8Array(total), dv = new DataView(u8.buffer);
    dv.setUint16(0, CHUNK_POOL, true);
    dv.setUint16(2, 28, true);
    dv.setUint32(4, total, true);
    dv.setUint32(8, pool.strings.length, true);
    dv.setUint32(12, pool.styleCount || 0, true);
    dv.setUint32(16, pool.flags, true);
    dv.setUint32(20, stringsStart, true);
    dv.setUint32(24, 0, true);
    for (var k = 0; k < offsets.length; k++) dv.setUint32(28 + 4 * k, offsets[k], true);
    var w = stringsStart;
    for (var m = 0; m < datas.length; m++) {
      for (var b = 0; b < datas[m].length; b++) u8[w++] = datas[m][b];
    }
    return u8;
  }

  function serializeAxml(doc) {
    var poolChunk = serializePool(doc.pool);
    var parts = [];
    var docHead = new Uint8Array(8);
    var dh = new DataView(docHead.buffer);
    dh.setUint16(0, CHUNK_DOC, true);
    dh.setUint16(2, 8, true);
    var docSize = 8;
    parts.push(poolChunk); docSize += poolChunk.length;
    if (doc.resMap) {
      var rm = new Uint8Array(8 + 4 * doc.resMap.length);
      var rv = new DataView(rm.buffer);
      rv.setUint16(0, CHUNK_RESMAP, true);
      rv.setUint16(2, 8, true);
      rv.setUint32(4, rm.length, true);
      for (var i = 0; i < doc.resMap.length; i++) rv.setUint32(8 + 4 * i, doc.resMap[i], true);
      parts.push(rm); docSize += rm.length;
    }
    for (var n = 0; n < doc.nodes.length; n++) {
      var nd = doc.nodes[n];
      var u8;
      if (nd.t === N_START_EL) {
        var size = 16 + 20 + 20 * nd.attrs.length;
        u8 = new Uint8Array(size);
        var v = new DataView(u8.buffer);
        v.setUint16(0, N_START_EL, true);
        v.setUint16(2, 16, true);
        v.setUint32(4, size, true);
        v.setUint32(8, nd.line || 0, true);
        v.setUint32(12, 0xFFFFFFFF, true);
        v.setUint32(16, nd.ns, true);
        v.setUint32(20, nd.name, true);
        v.setUint16(24, 20, true);
        v.setUint16(26, 20, true);
        v.setUint16(28, nd.attrs.length, true);
        v.setUint16(30, 0, true);
        v.setUint16(32, 0, true);
        v.setUint16(34, 0, true);
        for (var a = 0; a < nd.attrs.length; a++) {
          var at = nd.attrs[a], base = 36 + 20 * a;
          v.setUint32(base, at.ns, true);
          v.setUint32(base + 4, at.name, true);
          v.setUint32(base + 8, (at.raw === undefined || at.raw === null) ? 0xFFFFFFFF : at.raw, true);
          v.setUint16(base + 12, 8, true);
          u8[base + 14] = 0;
          v.setUint8(base + 15, at.type);
          v.setUint32(base + 16, at.data, true);
        }
      } else if (nd.t === N_END_EL) {
        u8 = new Uint8Array(24);
        var ev2 = new DataView(u8.buffer);
        ev2.setUint16(0, N_END_EL, true);
        ev2.setUint16(2, 16, true);
        ev2.setUint32(4, 24, true);
        ev2.setUint32(8, nd.line || 0, true);
        ev2.setUint32(12, 0xFFFFFFFF, true);
        ev2.setUint32(16, nd.ns, true);
        ev2.setUint32(20, nd.name, true);
      } else if (nd.t === N_START_NS || nd.t === N_END_NS) {
        u8 = new Uint8Array(24);
        var nv = new DataView(u8.buffer);
        nv.setUint16(0, nd.t, true);
        nv.setUint16(2, 16, true);
        nv.setUint32(4, 24, true);
        nv.setUint32(8, nd.line || 0, true);
        nv.setUint32(12, 0xFFFFFFFF, true);
        nv.setUint32(16, nd.prefix, true);
        nv.setUint32(20, nd.uri, true);
      } else if (nd.raw) {
        u8 = nd.raw;
      } else {
        continue;
      }
      parts.push(u8); docSize += u8.length;
    }
    dh.setUint32(4, docSize, true);
    var head = docHead;
    var all = [head].concat(parts);
    var total = 0;
    for (var p = 0; p < all.length; p++) total += all[p].length;
    var out = new Uint8Array(total), o = 0;
    for (var q = 0; q < all.length; q++) { out.set(all[q], o); o += all[q].length; }
    return out;
  }

  function makeStrResolver(doc) {
    var map = {};
    for (var i = 0; i < doc.pool.strings.length; i++) {
      var s = doc.pool.strings[i];
      if (!(s in map)) map[s] = i;
    }
    return {
      get: function (str) {
        if (str in map) return map[str];
        var idx = doc.pool.strings.length;
        doc.pool.strings.push(str);
        map[str] = idx;
        return idx;
      },
      at: function (idx) { return doc.pool.strings[idx]; }
    };
  }

  function editManifest(doc, opts) {
    var R = makeStrResolver(doc);
    var ANDROID_NS = 'http://schemas.android.com/apk/res/android';
    var androidNsIdx = -1;
    for (var i = 0; i < doc.pool.strings.length; i++) {
      if (doc.pool.strings[i] === ANDROID_NS) { androidNsIdx = i; break; }
    }
    function attrOf(node, name, ns) {
      for (var j = 0; j < node.attrs.length; j++) {
        var a = node.attrs[j];
        if (R.at(a.name) === name && (ns ? a.ns === ns : a.ns === 0xFFFFFFFF)) return a;
      }
      return null;
    }
    function elName(nd) { return R.at(nd.name); }
    function findElement(name) {
      for (var k = 0; k < doc.nodes.length; k++) {
        if (doc.nodes[k].t === N_START_EL && elName(doc.nodes[k]) === name) return doc.nodes[k];
      }
      return null;
    }

    var manifest = findElement('manifest');
    if (!manifest) throw new Error('AXML: manifest 元素未找到');
    var aPkg = attrOf(manifest, 'package', null);
    aPkg.type = T_STRING; aPkg.data = R.get(opts.packageName); aPkg.raw = aPkg.data;
    var aVC = attrOf(manifest, 'versionCode', androidNsIdx);
    if (aVC) { aVC.type = T_FIRST_INT; aVC.raw = 0xFFFFFFFF; aVC.data = (opts.versionCode | 0) >>> 0; }
    var aVN = attrOf(manifest, 'versionName', androidNsIdx);
    if (aVN) { aVN.type = T_STRING; aVN.data = R.get(opts.versionName); aVN.raw = aVN.data; }

    var app = findElement('application');
    if (app) {
      var aLabel = attrOf(app, 'label', androidNsIdx);
      if (aLabel) { aLabel.type = T_STRING; aLabel.data = R.get(opts.appName); aLabel.raw = aLabel.data; }
    }

    var metaVals = {};
    metaVals['wrap_mode'] = (opts.mode === 'file') ? 'file' : 'https';
    metaVals['warmup_hosts'] = opts.warmupHosts || '';
    var mv = opts.metaValues || {};
    for (var mk in mv) if (Object.prototype.hasOwnProperty.call(mv, mk)) metaVals[mk] = String(mv[mk]);
    for (var m = 0; m < doc.nodes.length; m++) {
      var nd2 = doc.nodes[m];
      if (nd2.t === N_START_EL && elName(nd2) === 'meta-data') {
        var nm = attrOf(nd2, 'name', androidNsIdx);
        var val = attrOf(nd2, 'value', androidNsIdx);
        var mname = nm ? R.at(nm.data) : null;
        if (val && mname && metaVals[mname] !== undefined) {
          val.type = T_STRING; val.data = R.get(metaVals[mname]); val.raw = val.data;
        }
      }
    }

    if (opts.permissions) {
      var keep = {};
      for (var pk = 0; pk < opts.permissions.length; pk++) keep[opts.permissions[pk]] = true;
      var outNodes = [], skipping = false, depth = 0;
      for (var x = 0; x < doc.nodes.length; x++) {
        var nd3 = doc.nodes[x];
        if (!skipping && nd3.t === N_START_EL && elName(nd3) === 'uses-permission') {
          var pa = attrOf(nd3, 'name', androidNsIdx);
          var pname = pa ? R.at(pa.data) : '';
          if (!keep[pname]) { skipping = true; depth = 1; continue; }
        }
        if (skipping) {
          if (nd3.t === N_START_EL) depth++;
          else if (nd3.t === N_END_EL) { depth--; if (depth === 0) skipping = false; }
          continue;
        }
        outNodes.push(nd3);
      }
      doc.nodes = outNodes;
    }
    return doc;
  }

  function derLen(n) {
    if (n < 0x80) return [n];
    if (n < 0x100) return [0x81, n];
    return [0x82, (n >> 8) & 0xff, n & 0xff];
  }
  function tlv(tag, content) {
    var l = derLen(content.length);
    var out = new Uint8Array(1 + l.length + content.length);
    out[0] = tag; out.set(l, 1); out.set(content, 1 + l.length);
    return out;
  }
  function derSeq(items) {
    var total = 0;
    for (var i = 0; i < items.length; i++) total += items[i].length;
    var c = new Uint8Array(total), o = 0;
    for (var j = 0; j < items.length; j++) { c.set(items[j], o); o += items[j].length; }
    return tlv(0x30, c);
  }
  function derSet(items) {
    var total = 0;
    for (var i = 0; i < items.length; i++) total += items[i].length;
    var c = new Uint8Array(total), o = 0;
    for (var j = 0; j < items.length; j++) { c.set(items[j], o); o += items[j].length; }
    return tlv(0x31, c);
  }
  function derInt(bytes) {
    var i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    var v = bytes.subarray(i);
    if (v[0] & 0x80) {
      var p = new Uint8Array(v.length + 1); p[0] = 0; p.set(v, 1);
      return tlv(0x02, p);
    }
    return tlv(0x02, v);
  }
  function oidFromDotted(s) {
    var parts = s.split('.').map(Number);
    var out = [40 * parts[0] + parts[1]];
    for (var i = 2; i < parts.length; i++) {
      var v = parts[i];
      if (v < 0x80) out.push(v);
      else {
        var tmp = [v & 0x7f]; v >>= 7;
        while (v > 0) { tmp.push(0x80 | (v & 0x7f)); v >>= 7; }
        tmp.reverse();
        for (var t = 0; t < tmp.length; t++) out.push(tmp[t]);
      }
    }
    return tlv(0x06, new Uint8Array(out));
  }
  function derUtf8(str) { return tlv(0x0c, utf8enc.encode(str)); }
  function derUtcTime(d) {
    var s = ('' + d.getUTCFullYear()).slice(2) +
      ('0' + (d.getUTCMonth() + 1)).slice(-2) + ('0' + d.getUTCDate()).slice(-2) +
      ('0' + d.getUTCHours()).slice(-2) + ('0' + d.getUTCMinutes()).slice(-2) +
      ('0' + d.getUTCSeconds()).slice(-2) + 'Z';
    return tlv(0x17, utf8enc.encode(s));
  }
  var OID_SHA256_RSA = '1.2.840.113549.1.1.11';
  var OID_CN = '2.5.4.3';
  function algId() { return derSeq([oidFromDotted(OID_SHA256_RSA), tlv(0x05, new Uint8Array(0))]); }
  function nameFromCn(cn) {
    return derSeq([derSet([derSeq([oidFromDotted(OID_CN), derUtf8(cn)])])]);
  }

  async function makeSelfCert(subtle, cn) {
    var kp = await subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify']);
    var spki = new Uint8Array(await subtle.exportKey('spki', kp.publicKey));
    var serial = new Uint8Array(8);
    global.crypto.getRandomValues(serial);
    serial[0] |= 0x01;
    var now = new Date(Date.now() - 24 * 3600 * 1000);
    var future = new Date(Date.now() + 20 * 365 * 24 * 3600 * 1000);
    var tbs = derSeq([
      tlv(0xA0, derInt(new Uint8Array([2]))),
      derInt(serial),
      algId(),
      nameFromCn(cn),
      derSeq([derUtcTime(now), derUtcTime(future)]),
      nameFromCn(cn),
      new Uint8Array(spki)
    ]);
    var sig = new Uint8Array(await subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, tbs));
    var cert = derSeq([tbs, algId(), tlv(0x03, (function () {
      var b = new Uint8Array(sig.length + 1); b[0] = 0; b.set(sig, 1); return b;
    })())]);
    var pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
    return { cert: cert, spki: spki, pkcs8: pkcs8, kp: kp };
  }

  var V2_BLOCK_ID = 0x7109871a;
  var ALG_RSA_PKCS1_SHA256 = 0x0103;
  var CHUNK_SIZE = 1048576;

  function lp32(bytes) {
    var out = new Uint8Array(4 + bytes.length);
    new DataView(out.buffer).setUint32(0, bytes.length, true);
    out.set(bytes, 4);
    return out;
  }
  function u32le(v) {
    var o = new Uint8Array(4);
    new DataView(o.buffer).setUint32(0, v, true);
    return o;
  }
  async function sha256(subtle, u8) {
    return new Uint8Array(await subtle.digest('SHA-256', u8));
  }

  async function signApkV2(subtle, apk, cert, kp, spkiIn) {
    var parsed = parseZip(apk);
    var eocdOff = apk.length - 22;
    for (var i = apk.length - 22; i >= Math.max(0, apk.length - 22 - 65536); i--) {
      if (new DataView(apk.buffer, apk.byteOffset, apk.byteLength).getUint32(i, true) === 0x06054b50) { eocdOff = i; break; }
    }
    var s1 = apk.subarray(0, parsed.cdOff);
    var cd = apk.subarray(parsed.cdOff, eocdOff);
    var eocd = apk.slice(eocdOff);

    var certLp = lp32(cert);
    var spki = spkiIn ? spkiIn : new Uint8Array(await subtle.exportKey('spki', kp.publicKey));
    var dummyDigest = new Uint8Array(32);
    function blockTotalFor(digestLen) {
      var digestRec = lp32((function () { var a = u32le(ALG_RSA_PKCS1_SHA256), b = lp32(new Uint8Array(digestLen)); var o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; })());
      var digests = lp32(digestRec);
      var certs = lp32(certLp);
      var attrs = lp32(new Uint8Array(0));
      var sdb = new Uint8Array(digests.length + certs.length + attrs.length + 4);
      sdb.set(digests); sdb.set(certs, digests.length); sdb.set(attrs, digests.length + certs.length);
      var signedData = lp32(sdb);
      var sigRecLen = 4 + 4 + 256;
      var signatures = lp32(lp32(new Uint8Array(sigRecLen)));
      var pubkey = lp32(spki);
      var signerLen = signedData.length + signatures.length + pubkey.length;
      var value = lp32(lp32(new Uint8Array(signerLen)));
      var pairLen = 8 + 4 + value.length;
      return { total: pairLen + 32, signedData: signedData, signatures: signatures, pubkey: pubkey, value: value };
    }
    var geo = blockTotalFor(32);

    var eocdNew = new Uint8Array(eocd);
    new DataView(eocdNew.buffer).setUint32(16, parsed.cdOff + geo.total, true);
    var s3 = new Uint8Array(cd.length + eocdNew.length);
    s3.set(cd); s3.set(eocdNew, cd.length);

    async function contentDigest() {
      var parts = [s1, cd, eocd];
      var chunkDigests = [];
      for (var pi = 0; pi < parts.length; pi++) {
        var src = parts[pi];
        for (var off = 0; off < src.length; off += CHUNK_SIZE) {
          var chunk = src.subarray(off, Math.min(off + CHUNK_SIZE, src.length));
          var pre = new Uint8Array(5);
          pre[0] = 0xa5;
          new DataView(pre.buffer).setUint32(1, chunk.length, true);
          chunkDigests.push(await sha256(subtle, concatU8(pre, chunk)));
        }
      }
      var buf = new Uint8Array(5 + chunkDigests.length * 32);
      buf[0] = 0x5a;
      new DataView(buf.buffer).setUint32(1, chunkDigests.length, true);
      var o = 5;
      for (var c = 0; c < chunkDigests.length; c++) { buf.set(chunkDigests[c], o); o += 32; }
      return sha256(subtle, buf);
    }
    var digest = await contentDigest();

    var digestRec = lp32((function () {
      var a = u32le(ALG_RSA_PKCS1_SHA256), b = lp32(digest);
      var o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o;
    })());
    var digests = lp32(digestRec);
    var certs = lp32(certLp);
    var attrs = lp32(new Uint8Array(0));
    var sdb = new Uint8Array(digests.length + certs.length + attrs.length + 4);
    sdb.set(digests); sdb.set(certs, digests.length); sdb.set(attrs, digests.length + certs.length);

    var signedData = lp32(sdb);

    var sigBytes = new Uint8Array(await subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, sdb));
    if (sigBytes.length !== 256) throw new Error('签名长度异常: ' + sigBytes.length);
    var sigRec = new Uint8Array(4 + 4 + 256);
    sigRec.set(u32le(ALG_RSA_PKCS1_SHA256), 0);
    new DataView(sigRec.buffer).setUint32(4, 256, true);
    sigRec.set(sigBytes, 8);
    var signatures = lp32(lp32(sigRec));
    var pubkey = lp32(spki);
    var signer = new Uint8Array(signedData.length + signatures.length + pubkey.length);
    signer.set(signedData); signer.set(signatures, signedData.length); signer.set(pubkey, signedData.length + signatures.length);
    var value = lp32(lp32(signer));

    var pair = new Uint8Array(8 + 4 + value.length);
    var pv = new DataView(pair.buffer);
    pv.setUint32(0, 4 + value.length, true);
    pv.setUint32(8, V2_BLOCK_ID, true);
    pair.set(value, 12);
    var blockSizeField = pair.length + 8 + 16;
    var block = new Uint8Array(8 + pair.length + 8 + 16);
    var bv = new DataView(block.buffer);
    bv.setUint32(0, blockSizeField, true);
    block.set(pair, 8);
    var tailOff = 8 + pair.length;
    bv.setUint32(tailOff, blockSizeField, true);
    var magic = utf8enc.encode('APK Sig Block 42');
    block.set(magic, tailOff + 8);

    var out = new Uint8Array(s1.length + block.length + s3.length);
    out.set(s1, 0); out.set(block, s1.length); out.set(s3, s1.length + block.length);
    return out;
  }

  var ICON_DENSITIES = [
    ['res/mipmap-mdpi-v4/ic_launcher.png', 48],
    ['res/mipmap-hdpi-v4/ic_launcher.png', 72],
    ['res/mipmap-xhdpi-v4/ic_launcher.png', 96],
    ['res/mipmap-xxhdpi-v4/ic_launcher.png', 144],
    ['res/mipmap-xxxhdpi-v4/ic_launcher.png', 192]
  ];

  async function buildApk(templateU8, opts, io) {

    var subtle = global.crypto.subtle;
    var parsed = parseZip(templateU8);
    var entries = [];
    for (var i = 0; i < parsed.entries.length; i++) {
      var e = parsed.entries[i];
      var data = (e.method === 8) ? await io.inflate(e.data) : e.data;
      entries.push({ name: e.name, data: data });
    }
    function find(name) {
      for (var j = 0; j < entries.length; j++) if (entries[j].name === name) return entries[j];
      return null;
    }

    var mf = find('AndroidManifest.xml');
    var doc = parseAxml(mf.data);
    editManifest(doc, {
      packageName: opts.packageName,
      appName: opts.appName,
      versionName: opts.versionName || '1.0',
      versionCode: opts.versionCode || 1,
      mode: opts.mode || 'https',
      warmupHosts: opts.warmupHosts || '',
      permissions: opts.permissions || null,
      metaValues: {
        splash_enabled: opts.splash ? 'true' : 'false',
        splash_type: (opts.splash && opts.splash.type === 'image') ? 'image' : 'icon',
        splash_duration_ms: String(Math.max(0, (opts.splash && opts.splash.durationMs) | 0)),
        splash_icon_size_dp: String(Math.max(24, Math.min(512, (opts.splash && opts.splash.iconSizeDp) || 96))),
        splash_icon_round: (opts.splash && opts.splash.iconRound === false) ? 'false' : 'true'
      }
    });
    mf.data = serializeAxml(doc);

    var html = find('assets/index.html');
    if (!html) throw new Error('模板缺少 assets/index.html');
    html.data = opts.htmlBytes;

    var sp = find('assets/splash_image');
    if (sp) {
      if (opts.splash && opts.splash.type === 'image' && opts.splash.imageBytes && opts.splash.imageBytes.length) {
        sp.data = opts.splash.imageBytes;
      } else {
        for (var si = 0; si < entries.length; si++) if (entries[si].name === 'assets/splash_image') { entries.splice(si, 1); break; }
      }
    }

    if (opts.icons) {
      for (var d = 0; d < ICON_DENSITIES.length; d++) {
        var nm = ICON_DENSITIES[d][0];
        if (opts.icons[nm]) {
          var it = find(nm); if (it) it.data = opts.icons[nm];
        }
      }
    }

    var items = entries.map(function (en) {
      return { name: en.name, data: en.data, store: /\.png$/.test(en.name) };
    });
    var rawApk = await buildZip(items, io.deflate);

    var keyInfo = opts.keyInfo;
    if (!keyInfo) {
      var made = await makeSelfCert(subtle, opts.certCN || 'HTML2APK');
      keyInfo = made;
    }

    var kp;
    if (keyInfo.kp) kp = keyInfo.kp;
    else {
      var priv = await subtle.importKey('pkcs8', keyInfo.pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
      var pub = await subtle.importKey('spki', keyInfo.spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      kp = { privateKey: priv, publicKey: pub };
    }
    var signed = await signApkV2(subtle, rawApk, keyInfo.cert, kp, keyInfo.spki || null);
    return { apk: signed, keyInfo: keyInfo };
  }

  global.PackTool = {
    crc32: crc32, parseZip: parseZip, buildZip: buildZip,
    parseAxml: parseAxml, editManifest: editManifest, serializeAxml: serializeAxml,
    makeSelfCert: makeSelfCert, signApkV2: signApkV2, buildApk: buildApk,
    u8ToB64: u8ToB64, b64ToU8: b64ToU8, ICON_DENSITIES: ICON_DENSITIES
  };
})(typeof window !== 'undefined' ? window : globalThis);

module.exports = (typeof window !== "undefined" ? window : globalThis).PackTool;
