// 内置工具与通用 UI 图标（内联 SVG，24×24 线性风格，stroke=currentColor 随主题着色）
const S = (inner: string, filled = false) =>
  `<svg viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="${filled ? 'none' : 'currentColor'}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

// ── 品牌 Logo ──────────────────────────────────────────────
export const BRAND_MARK = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <defs><linearGradient id="spurh-g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#3ecf8e"/><stop offset="1" stop-color="#2f9de4"/>
  </linearGradient></defs>
  <rect x="1.6" y="1.6" width="20.8" height="20.8" rx="6.2" fill="url(#spurh-g)"/>
  <path d="M13.4 5.4 7.4 13.1h4.1l-1 5.5 6-7.7h-4.1z" fill="#fff"/>
</svg>`;

// ── 工具图标（按插件 id） ──────────────────────────────────
export const TOOL_ICONS: Record<string, string> = {
  'spurh.json': S('<path d="M9 4.2c-1.9 0-2.6 1.4-2.6 2.8 0 1.7-.8 2.7-2.4 3 .3.4.3 1.6 0 2 1.6.3 2.4 1.3 2.4 3 0 1.4.7 2.8 2.6 2.8"/><path d="M15 4.2c1.9 0 2.6 1.4 2.6 2.8 0 1.7.8 2.7 2.4 3-.3.4-.3 1.6 0 2-1.6.3-2.4 1.3-2.4 3 0 1.4-.7 2.8-2.6 2.8"/>'),
  'spurh.timestamp': S('<circle cx="12" cy="12" r="8.3"/><path d="M12 7.4V12l3.1 2"/>'),
  'spurh.text': S('<path d="M6.5 3.5h7.2L18 8v12.5H6.5z"/><path d="M13.5 3.5V8H18"/><path d="M9.2 12.6h5.6M9.2 16h5.6"/>'),
  'spurh.random': S('<rect x="4.4" y="4.4" width="15.2" height="15.2" rx="3.6"/><circle cx="9" cy="9" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1" fill="currentColor" stroke="none"/>'),
  'spurh.crypto': S('<rect x="5.4" y="10.6" width="13.2" height="9" rx="2.6"/><path d="M8.5 10.6V8a3.5 3.5 0 0 1 7 0v2.6"/><circle cx="12" cy="15.1" r="1.4"/>'),
  'spurh.cron': S('<path d="M20 12a8 8 0 1 1-2.35-5.65"/><path d="M20 3.4V7.5h-4.1"/><path d="M12 8v4l2.6 1.5"/>'),
  'spurh.encoder': S('<path d="M4.2 8h11.8"/><path d="m13.2 4.8 3.2 3.2-3.2 3.2"/><path d="M19.8 16H8"/><path d="m10.8 12.8-3.2 3.2 3.2 3.2"/>'),
  'spurh.regex': S('<path d="M5.2 18.8 18.8 5.2"/><path d="M12 3.6l1.4 5.3L18.6 12l-5.2 3.1L12 20.4l-1.4-5.3L5.4 12l5.2-3.1z" fill="currentColor" stroke="none"/>'),
  'spurh.sql': S('<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>'),
  'spurh.network': S('<circle cx="12" cy="12" r="3"/><path d="M12 9V4.5M12 15v4.5M9 12H4.5M15 12h4.5"/><path d="M7.8 7.8 5 5M16.2 7.8 19 5M7.8 16.2 5 19M16.2 16.2 19 19"/>'),
  'spurh.clipboard': S('<rect width="13" height="16" x="5.5" y="4.5" rx="2"/><path d="M9 4.5a3 3 0 0 1 6 0"/><path d="M9 10.5h6M9 14h6"/>'),
  'spurh.remote': S('<rect x="3" y="4.5" width="18" height="13" rx="2.4"/><path d="m7.5 9 3 2.5-3 2.5"/><path d="M12.5 14h4"/><path d="M7 20.5h10"/>'),
  'spurh.log': S('<path d="M5 4.5h14M5 9.5h14M5 14.5h14M5 19.5h14"/><circle cx="8" cy="9.5" r=".6" fill="currentColor" stroke="none"/><circle cx="8" cy="14.5" r=".6" fill="currentColor" stroke="none"/><circle cx="8" cy="19.5" r=".6" fill="currentColor" stroke="none"/>'),
};

// ── 通用 UI 图标 ───────────────────────────────────────────
export const UI_ICONS = {
  settings: S('<circle cx="12" cy="12" r="3.2"/><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>'),
  search: S('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  sparkle: S('<path d="M9.94 15.5a2 2 0 0 0-1.44-1.44l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94a2 2 0 0 0 1.44-1.44l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z" fill="currentColor"/>'),
  copy: S('<rect width="13" height="13" x="9" y="9" rx="2.2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  sun: S('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'),
  moon: S('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
  contrast: S('<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/>'),
  keyboard: S('<rect width="20" height="15" x="2" y="4.5" rx="2.4"/><path d="M6 8.5h.01M10 8.5h.01M14 8.5h.01M18 8.5h.01M6 12.5h.01M10 12.5h.01M14 12.5h.01M18 12.5h.01M7 16h10"/>'),
  info: S('<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>'),
  close: S('<path d="M18 6 6 18M6 6l12 12"/>'),
  plus: S('<path d="M5 12h14M12 5v14"/>'),
  refresh: S('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>'),
  trash: S('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>'),
  sliders: S('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1.5 14h5M9.5 8h5M17.5 16h5"/>'),
  file: S('<path d="M6.5 3.5h7.2L18 8v12.5H6.5z"/><path d="M13.5 3.5V8H18"/>'),
  play: S('<path d="m7 5 12 7-12 7z"/>'),
  key: S('<circle cx="7.5" cy="15.5" r="4.5"/><path d="m11.2 11.8 8.3-8.3"/><path d="M16.5 7l2.8 2.8M13.7 9.8 16.5 12.6"/>'),
  lock: S('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><circle cx="12" cy="15.5" r="1.3"/>'),
  ticket: S('<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>'),
  hash: S('<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>'),
  shield: S('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>'),
  eye: S('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: S('<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/>'),
  users: S('<circle cx="9" cy="8" r="3.4"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.4a5.5 5.5 0 0 1 5 4.6"/>'),
} as const;

/** 插件 icon 字段：兼容内联 SVG 与纯文本（第三方插件可能只给文本，需转义防注入） */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function iconHtml(icon: string): string {
  const trimmed = icon.trim();
  // 只放行纯 SVG 标记：拒绝事件属性、脚本/样式标签、javascript: URL 与 href 属性（防实体编码绕过），其余按文本转义渲染
  if (trimmed.startsWith('<svg') && !/on\w+\s*=|<\s*(script|style)|javascript:|(?:xlink:)?href\s*=/i.test(trimmed)) return trimmed;
  return `<span class="icon-fallback">${escapeHtml(trimmed.slice(0, 12))}</span>`;
}
