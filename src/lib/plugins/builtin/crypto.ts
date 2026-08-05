import { TOOL_ICONS as ICONS } from '../../icons';
import type { PluginResult, SpurhPlugin } from '../types';

/* ── AES ── */
async function importAesKey(rawKey: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', rawKey as BufferSource, { name: 'AES-GCM' }, false, usage);
}
function keyBytes(secret: string): Uint8Array {
  const base = new TextEncoder().encode(secret.trim().slice(0, 32));
  const key = new Uint8Array(32);
  key.set(base.slice(0, Math.min(base.length, 32)));
  return key;
}
function bytesToBase64(bytes: Uint8Array): string {
  let b = ''; for (const byte of bytes) b += String.fromCharCode(byte);
  return btoa(b);
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim().replace(/\s/g, ''));
  return Uint8Array.from(bin, ch => ch.charCodeAt(0));
}
async function aesEncrypt(input: string, secret: string): Promise<string> {
  if (!secret.trim()) throw new Error('请输入密钥');
  const key = await importAesKey(keyBytes(secret), ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(input));
  const combined = new Uint8Array(iv.length + new Uint8Array(ct).length);
  combined.set(iv); combined.set(new Uint8Array(ct), iv.length);
  return bytesToBase64(combined);
}
async function aesDecrypt(input: string, secret: string): Promise<string> {
  if (!secret.trim()) throw new Error('请输入密钥');
  const key = await importAesKey(keyBytes(secret), ['decrypt']);
  const combined = base64ToBytes(input);
  if (combined.length < 13) throw new Error('密文不完整');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: combined.slice(0, 12) }, key, combined.slice(12));
  return new TextDecoder().decode(pt);
}

/* ── RSA Key Gen ── */
function pemEncode(base64Key: string, label: string): string {
  const lines = base64Key.match(/.{1,64}/g) ?? [base64Key];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

async function generateRsaKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['encrypt', 'decrypt'],
  );
  const pub = await crypto.subtle.exportKey('spki', pair.publicKey);
  const priv = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return {
    publicKey: pemEncode(bytesToBase64(new Uint8Array(pub)), 'PUBLIC KEY'),
    privateKey: pemEncode(bytesToBase64(new Uint8Array(priv)), 'PRIVATE KEY'),
  };
}

/* ── JWT ── */
function jwtDecodePart(part: string): unknown {
  const n = part.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(n.padEnd(Math.ceil(n.length / 4) * 4, '='));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
}
function jwtEncodePart(val: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(val));
  let b = ''; for (const byte of bytes) b += String.fromCharCode(byte);
  return btoa(b).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function jwtSigBytes(v: string): ArrayBuffer {
  const n = v.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(n.padEnd(Math.ceil(n.length / 4) * 4, '='));
  return Uint8Array.from(bin, c => c.charCodeAt(0)).buffer as ArrayBuffer;
}
function jwtHash(alg: unknown): string {
  if (alg === 'HS256') return 'SHA-256';
  if (alg === 'HS384') return 'SHA-384';
  if (alg === 'HS512') return 'SHA-512';
  throw new Error(`仅支持 HS256/HS384/HS512，收到 ${String(alg)}`);
}
async function jwtImportSecret(secret: string, hash: string): Promise<CryptoKey> {
  if (!secret) throw new Error('请输入签名密钥');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash }, false, ['sign', 'verify']);
}
function jwtBytesToB64Url(bytes: ArrayBuffer): string {
  let b = ''; for (const byte of new Uint8Array(bytes)) b += String.fromCharCode(byte);
  return btoa(b).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/* ── MD5 ── */
function md5(input: string): string {
  const data = new TextEncoder().encode(input);
  const len = data.length;
  const padded = new Uint8Array((Math.floor((len + 8) / 64) + 1) * 64);
  padded.set(data); padded[len] = 0x80;
  new DataView(padded.buffer).setUint32(padded.length - 8, len * 8, true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = new Uint32Array(64); for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  for (let p = 0; p < padded.length; p += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) M[j] = padded[p + j * 4] | (padded[p + j * 4 + 1] << 8) | (padded[p + j * 4 + 2] << 16) | (padded[p + j * 4 + 3] << 24);
    let A = a0, B = b0, C = c0, D = d0;
    for (let j = 0; j < 64; j++) {
      let F: number, g: number;
      if (j < 16) { F = (B & C) | (~B & D); g = j; }
      else if (j < 32) { F = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
      else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * j) % 16; }
      F = (F + A + K[j] + M[g]) >>> 0; A = D; D = C; C = B;
      B = (B + ((F << S[j]) | (F >>> (32 - S[j])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

/* ── SHA / HMAC ── */
async function shaDigest(alg: string, input: string): Promise<string> {
  const v = await crypto.subtle.digest(alg, new TextEncoder().encode(input));
  return [...new Uint8Array(v)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hmacDigest(alg: string, key: string, input: string): Promise<string> {
  const ck = await crypto.subtle.importKey('raw', new TextEncoder().encode(key) as BufferSource, { name: 'HMAC', hash: alg }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', ck, new TextEncoder().encode(input));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ── Plugin ── */
export const cryptoPlugin: SpurhPlugin = {
  id: 'spurh.crypto',
  name: '加解密',
  description: 'AES·RSA·JWT·哈希·HMAC — 本地安全工具箱',
  icon: ICONS['spurh.crypto'],
  version: '0.1.0',
  category: '安全',
  priority: 88,
  actions: [
    { id: 'aes-encrypt', label: 'AES 加密', description: 'AES-256-GCM 加密' },
    { id: 'aes-decrypt', label: 'AES 解密', description: 'AES-256-GCM 解密' },
    { id: 'rsa-gen', label: 'RSA 密钥', description: '生成 2048 位 RSA 密钥对' },
    { id: 'jwt-decode', label: 'JWT 解码', description: '查看 Header/Payload' },
    { id: 'jwt-verify', label: 'JWT 验签', description: '验证 HMAC JWT' },
    { id: 'jwt-gen', label: 'JWT 生成', description: '本地生成 HS256 JWT' },
    { id: 'MD5', label: 'MD5', description: '128 位摘要' },
    { id: 'SHA-1', label: 'SHA-1', description: '160 位摘要' },
    { id: 'SHA-256', label: 'SHA-256', description: '256 位摘要' },
    { id: 'SHA-512', label: 'SHA-512', description: '512 位摘要' },
    { id: 'HMAC-SHA256', label: 'HMAC-SHA256', description: 'HMAC 256' },
    { id: 'HMAC-SHA512', label: 'HMAC-SHA512', description: 'HMAC 512' },
  ],
  options: [
    { id: 'secret', label: '密钥', type: 'text', defaultValue: '', placeholder: '加解密/JWT 密钥', actions: ['aes-encrypt', 'aes-decrypt', 'jwt-verify', 'jwt-gen', 'HMAC-SHA256', 'HMAC-SHA512'] },
  ],
  detect(input) {
    const t = input.trim();
    if (/^(encrypt|decrypt|aes|rsa|jwt|hash|hmac|md5)[:：]/i.test(t)) return { confidence: 0.85, reason: '安全指令' };
    const parts = t.split('.');
    if (parts.length === 3 && parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) {
      try { jwtDecodePart(parts[0]); jwtDecodePart(parts[1]); return { confidence: 0.98, reason: 'JWT 令牌' }; } catch {}
    }
    if (t.length > 40 && /^[A-Za-z0-9+/]+={0,2}$/.test(t)) return { confidence: 0.45, reason: '可能是加密数据' };
    return null;
  },
  async execute(actionId, input, options = {}): Promise<PluginResult> {
    const secret = options.secret ?? '';

    if (actionId === 'aes-encrypt') {
      const out = await aesEncrypt(input, secret);
      return { output: out, language: 'text', summary: 'AES-256-GCM 加密完成', meta: { 算法: 'AES-256-GCM', 模式: 'GCM' } };
    }
    if (actionId === 'aes-decrypt') {
      try { const out = await aesDecrypt(input, secret); return { output: out, language: 'text', summary: '解密成功', meta: { 算法: 'AES-256-GCM' } }; }
      catch { throw new Error('解密失败：密钥不对或密文损坏'); }
    }
    if (actionId === 'rsa-gen') {
      const pair = await generateRsaKeyPair();
      return { output: `PUBLIC KEY:\n${pair.publicKey}\n\nPRIVATE KEY:\n${pair.privateKey}`, language: 'text', summary: '2048 位 RSA 密钥对', meta: { 算法: 'RSA-OAEP', 长度: 2048 } };
    }
    if (actionId === 'jwt-gen') {
      let payload: unknown;
      try { payload = JSON.parse(input); } catch { throw new Error('请输入 JSON Payload'); }
      const header = { alg: 'HS256', typ: 'JWT' };
      const si = `${jwtEncodePart(header)}.${jwtEncodePart(payload)}`;
      const k = await jwtImportSecret(secret, 'SHA-256');
      const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(si));
      return { output: `${si}.${jwtBytesToB64Url(sig)}`, language: 'text', summary: 'HS256 JWT 已生成', meta: { 算法: 'HS256' }, view: 'text' };
    }
    if (actionId === 'jwt-decode' || actionId === 'jwt-verify') {
      const parts = input.trim().split('.');
      if (parts.length !== 3) throw new Error('无效 JWT 格式');
      const header = jwtDecodePart(parts[0]) as Record<string, unknown>;
      const payload = jwtDecodePart(parts[1]) as Record<string, unknown>;
      if (actionId === 'jwt-decode') {
        const expired = typeof payload.exp === 'number' ? payload.exp * 1000 < Date.now() : undefined;
        return {
          output: JSON.stringify({ header, payload }, null, 2), language: 'json',
          summary: expired ? 'JWT 已过期' : 'JWT 已解码', view: 'jwt',
          data: { header, payload, expired, token: input.trim() },
          meta: { 算法: String(header.alg || '?'), 签名: '未验证' },
        };
      }
      const hash = jwtHash(header.alg);
      const k = await jwtImportSecret(secret, hash);
      const valid = await crypto.subtle.verify('HMAC', k, jwtSigBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
      const expired = typeof payload.exp === 'number' ? payload.exp * 1000 < Date.now() : undefined;
      return {
        output: JSON.stringify({ valid, algorithm: header.alg, payload }, null, 2), language: 'json',
        summary: valid ? (expired ? '签名有效但已过期' : '签名验证通过') : '签名无效',
        view: 'jwt',
        data: { header, payload, valid, expired, token: input.trim() },
        meta: { 算法: String(header.alg || '?'), 签名: valid ? '有效' : '无效', ...(expired ? { 过期: '是' } : {}) },
      };
    }
    if (actionId === 'MD5') {
      const out = md5(input);
      return { output: out, language: 'text', view: 'hash', summary: 'MD5 (128位)', data: { algorithm: 'MD5', bits: 128, digest: out }, meta: { 算法: 'MD5', 位: 128 } };
    }
    if (actionId === 'SHA-1' || actionId === 'SHA-256' || actionId === 'SHA-512') {
      const bits = actionId === 'SHA-256' ? 256 : actionId === 'SHA-1' ? 160 : 512;
      const out = await shaDigest(actionId, input);
      return { output: out, language: 'text', view: 'hash', summary: `${actionId} (${bits}位)`, data: { algorithm: actionId, bits, digest: out }, meta: { 算法: actionId, 位: bits } };
    }
    if (actionId === 'HMAC-SHA256' || actionId === 'HMAC-SHA512') {
      if (!secret.trim()) throw new Error('HMAC 需要密钥');
      const h = actionId === 'HMAC-SHA256' ? 'SHA-256' : 'SHA-512';
      const bits = actionId === 'HMAC-SHA256' ? 256 : 512;
      const out = await hmacDigest(h, secret, input);
      return { output: out, language: 'text', view: 'hash', summary: `${actionId} (${bits}位)`, data: { algorithm: actionId, bits, digest: out }, meta: { 算法: actionId, 位: bits } };
    }
    throw new Error(`未知操作 ${actionId}`);
  },
};
