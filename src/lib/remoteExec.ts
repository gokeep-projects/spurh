/**
 * SSH 远程面板的纯函数工具：路径转义与 ssh_exec 返回值的解码。
 * 独立成模块以便单元测试（修复过下载双重 base64 解码的问题）。
 */

/** 转义 shell 单引号，防止路径注入（sh 兼容：' → '\''） */
export function escPath(path: string): string {
  return path.replace(/'/g, `'\\''`);
}

/**
 * 解码 ssh_exec 返回：base64 主体 + 可选 __STDERR__ / __TRUNCATED__ 标记。
 * 注意：主体是「外层 base64(stdout)」，本函数只解外层；若 stdout 本身是
 * base64（如文件下载），调用方需再 atob 一次得到原始字节。
 */
export function decodeExecResult(raw: string): { text: string; truncated: boolean; stderr: string } {
  let truncated = raw.endsWith('__TRUNCATED__');
  let body = truncated ? raw.slice(0, raw.length - 13) : raw;
  let stderr = '';
  const sep = body.indexOf('__STDERR__');
  if (sep >= 0) {
    stderr = atob(body.slice(sep + 10));
    body = body.slice(0, sep);
  }
  return { text: atob(body), truncated, stderr };
}

/** base64 文本 → Uint8Array（atob 忽略空白，兼容 GNU/BSD base64 换行输出） */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** bytes → 字符串（用于比对测试） */
export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
