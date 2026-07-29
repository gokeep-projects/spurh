import type { PluginResult, SpurhPlugin } from '../types';

function decodePart(value: string): unknown {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('JWT 片段不是有效的 Base64URL JSON');
  }
}

function formatTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return new Date(value * 1000).toLocaleString('zh-CN', { hour12: false });
}

function encodePart(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signatureBytes(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer as ArrayBuffer;
}

function hashForAlgorithm(algorithm: unknown): string {
  if (algorithm === 'HS256') return 'SHA-256';
  if (algorithm === 'HS384') return 'SHA-384';
  if (algorithm === 'HS512') return 'SHA-512';
  throw new Error(`当前仅支持 HS256 / HS384 / HS512，收到 ${String(algorithm)}`);
}

async function importSecret(secret: string, hash: string): Promise<CryptoKey> {
  if (!secret) throw new Error('请输入签名密钥');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash }, false, ['sign', 'verify']);
}

function bytesToBase64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export const jwtPlugin: SpurhPlugin = {
  id: 'spurh.jwt',
  name: 'JWT 令牌',
  description: '在本地安全解码令牌',
  icon: 'JWT',
  version: '0.1.0',
  category: '安全',
  priority: 90,
  actions: [
    { id: 'decode', label: '解码', description: '查看 Header 与 Payload' },
    { id: 'verify', label: '验签', description: '验证 HMAC 签名' },
    { id: 'generate', label: '生成', description: '从 JSON Payload 生成 HS256 JWT' },
  ],
  options: [
    { id: 'secret', label: 'Secret', type: 'text', placeholder: '仅在本地使用', defaultValue: '', actions: ['verify', 'generate'] },
  ],
  detect(input) {
    const parts = input.trim().split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
    try {
      decodePart(parts[0]);
      decodePart(parts[1]);
      return { confidence: 0.98, reason: '检测到三个有效的 JWT 片段' };
    } catch {
      return { confidence: 0.72, reason: '内容符合 JWT 的三段式结构' };
    }
  },
  async execute(actionId, input, options = {}): Promise<PluginResult> {
    if (actionId === 'generate') {
      let payload: unknown;
      try { payload = JSON.parse(input); } catch { throw new Error('生成 JWT 时请输入 JSON Payload'); }
      const header = { alg: 'HS256', typ: 'JWT' };
      const signingInput = `${encodePart(header)}.${encodePart(payload)}`;
      const key = await importSecret(options.secret ?? '', 'SHA-256');
      const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
      return {
        output: `${signingInput}.${bytesToBase64Url(signature)}`,
        language: 'text', summary: '已在本地生成 HS256 JWT', meta: { 算法: 'HS256', 签名: '已生成' },
        view: 'text',
      };
    }
    const parts = input.trim().split('.');
    if (parts.length !== 3) throw new Error('JWT 必须由三个点分隔的片段组成');
    const header = decodePart(parts[0]) as Record<string, unknown>;
    const payload = decodePart(parts[1]) as Record<string, unknown>;
    if (actionId === 'verify') {
      const hash = hashForAlgorithm(header.alg);
      const key = await importSecret(options.secret ?? '', hash);
      const valid = await crypto.subtle.verify(
        'HMAC', key, signatureBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      );
      return {
        output: JSON.stringify({ valid, algorithm: header.alg, payload }, null, 2),
        language: 'json', summary: valid ? '签名验证通过' : '签名验证失败',
        meta: { 算法: String(header.alg), 签名: valid ? '有效' : '无效' },
        view: 'jwt',
        data: {
          header,
          payload,
          valid,
          token: input.trim(),
          expiresAt: formatTimestamp(payload.exp),
          expired: typeof payload.exp === 'number' ? payload.exp * 1000 < Date.now() : undefined,
        },
      };
    }
    const expired = typeof payload.exp === 'number' ? payload.exp * 1000 < Date.now() : undefined;
    return {
      output: JSON.stringify({ header, payload }, null, 2),
      language: 'json',
      summary: expired === undefined ? 'JWT 已在本地解码，未验证签名' : expired ? 'JWT 已过期，未验证签名' : 'JWT 尚未过期，未验证签名',
      meta: {
        签名: '未验证',
        ...(formatTimestamp(payload.iat) ? { 签发时间: formatTimestamp(payload.iat)! } : {}),
        ...(formatTimestamp(payload.exp) ? { 过期时间: formatTimestamp(payload.exp)! } : {}),
      },
      view: 'jwt',
      data: {
        header,
        payload,
        expired,
        token: input.trim(),
        expiresAt: formatTimestamp(payload.exp),
      },
    };
  },
};
