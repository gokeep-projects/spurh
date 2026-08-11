const fs = require('fs');
const path = require('path');
const wsUrl = process.argv[2];
const outDir = process.argv[3] || 'shots-audit';
const themeFilter = process.argv[4] || 'all';
fs.mkdirSync(outDir, { recursive: true });
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
let ready = false;
const queue = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    const msg = JSON.stringify({ id: mid, method, params });
    if (ready) ws.send(msg); else queue.push(msg);
  });
}
ws.onopen = () => { ready = true; for (const m of queue) ws.send(m); queue.length = 0; };
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
};
ws.onerror = (e) => { console.error('WS ERR', e.message); };
ws.onclose = () => { console.error('WS CLOSED'); process.exit(1); };

const AUDIT = `(() => {
  const out = { overflow: [], clip: [], smallFont: [], lowContrast: [], stats: {} };
  const d = document.documentElement;
  out.stats.viewport = innerWidth + 'x' + innerHeight;
  out.stats.pageOverflowX = d.scrollWidth > d.clientWidth + 1;
  const vw = d.clientWidth;
  document.querySelectorAll('.workspace *').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    if (r.right > vw + 2 || r.left < -2) {
      if (!el.closest('.dispatch-matches')) out.overflow.push({ tag: el.tagName, cls: String(el.className).slice(0, 50), right: Math.round(r.right), left: Math.round(r.left) });
    }
    const txt = (el.textContent || '').trim();
    if (txt && (cs.overflow === 'hidden' || cs.overflowX === 'hidden') && cs.whiteSpace === 'nowrap') {
      if (el.scrollWidth > el.clientWidth + 2 && r.width < vw - 10) out.clip.push({ tag: el.tagName, cls: String(el.className).slice(0, 50), sw: el.scrollWidth, cw: el.clientWidth, text: txt.slice(0, 30) });
    }
    if (txt && cs.fontSize) {
      const px = parseFloat(cs.fontSize);
      if (px < 12 && !el.closest('.dispatch-matches') && out.smallFont.length < 30) out.smallFont.push({ tag: el.tagName, cls: String(el.className).slice(0, 50), fs: cs.fontSize, text: txt.slice(0, 20) });
    }
  });
  const parse = (c) => { const m = c.match(/rgba?\\(([\\d.]+), ([\\d.]+), ([\\d.]+)(?:, ([\\d.]+))?\\)/); if (!m) return null; return { r:+m[1], g:+m[2], b:+m[3], a: m[4] === undefined ? 1 : +m[4] }; };
  const composite = (fg, bg) => ({ r: fg.r*fg.a + bg.r*(1-fg.a), g: fg.g*fg.a + bg.g*(1-fg.a), b: fg.b*fg.a + bg.b*(1-fg.a) });
  const lum = (c) => { const v = c/255; return v <= .03928 ? v/12.92 : Math.pow((v+.055)/1.055, 2.4); };
  const L = (c) => .2126*lum(c.r) + .7152*lum(c.g) + .0722*lum(c.b);
  const sat = (c) => { const mx = Math.max(c.r,c.g,c.b), mn = Math.min(c.r,c.g,c.b); return mx === 0 ? 0 : (mx-mn)/mx; };
  const isColored = (c) => sat(c) > 0.35;
  const samples = [];
  document.querySelectorAll('.workspace *').forEach(el => {
    if (samples.length > 260) return;
    const txt = (el.childNodes.length === 1 ? (el.textContent || '') : '').trim();
    if (!txt || txt.length > 40) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const color = parse(cs.color);
    if (!color || color.a === 0) return;
    let bg = { r:255, g:255, b:255, a:0 };
    let node = el;
    let guard = 0;
    while (node && bg.a < 1 && guard++ < 12) {
      const b = parse(getComputedStyle(node).backgroundColor);
      if (b && b.a > 0) bg = composite(b, bg);
      node = node.parentElement;
    }
    if (bg.a < 1) bg = composite({ r:0, g:0, b:0, a:1 }, bg);
    const ratio = (Math.max(L(color),L(bg)) + .05) / (Math.min(L(color),L(bg)) + .05);
    if (ratio < 2.4 && !isColored(color)) samples.push({ tag: el.tagName, cls: String(el.className).slice(0, 50), ratio: Math.round(ratio*100)/100, text: txt.slice(0, 24), color: cs.color, bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')' });
  });
  samples.sort((a,b) => a.ratio - b.ratio);
  out.lowContrast = samples.slice(0, 20);
  return out;
})()`;

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
  return r.result.value;
}
async function click(selector, index = 0) {
  await evalJs(`(() => { const els = document.querySelectorAll(${JSON.stringify(selector)}); const el = els[${index}]; if (!el) return false; el.click(); return true; })()`);
  await new Promise(r => setTimeout(r, 300));
}
async function shot(name) {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(r.data, 'base64'));
  } catch (e) { console.log('    shot failed:', e.message); }
}

(async () => {
  await send('Page.enable');
  await send('Runtime.enable');
  await new Promise(r => setTimeout(r, 1000));
  const themes = [
    { key: 'dark', idx: 0 },
    { key: 'light', idx: 1 },
    { key: 'aurora', idx: 2 },
    { key: 'forest', idx: 3 },
  ].filter(t => themeFilter === 'all' || t.key === themeFilter);
  const toolCount = await evalJs(`document.querySelectorAll('.tool-list button').length`);
  console.log('tools:', toolCount, 'themes:', themes.map(t => t.key).join(','));
  for (const theme of themes) {
    await click('.app-actions .settings-button', 1);
    await click('.theme-choice button', theme.idx);
    await evalJs(`(() => { const b = document.querySelector('.settings-header button[aria-label="关闭"]'); if (b) b.click(); return true; })()`);
    await new Promise(r => setTimeout(r, 600));
    const cls = await evalJs(`document.querySelector('.app')?.className`);
    console.log('== theme', theme.key, 'appClass:', cls);
    for (let i = 0; i < toolCount; i++) {
      const name = await evalJs(`document.querySelectorAll('.tool-list button .tool-name b')[${i}]?.textContent`);
      await click('.tool-list button', i);
      await new Promise(r => setTimeout(r, 450));
      const audit = await evalJs(AUDIT);
      const issues = [];
      const details = [];
      if (audit.stats.pageOverflowX) issues.push('PAGE-OVERFLOW');
      if (audit.overflow.length) { issues.push('OVERFLOW:' + audit.overflow.length); details.push(JSON.stringify(audit.overflow.slice(0,3))); }
      if (audit.clip.length) { issues.push('CLIP:' + audit.clip.length); details.push(JSON.stringify(audit.clip.slice(0,2))); }
      if (audit.smallFont.length) { issues.push('SMALLFONT:' + audit.smallFont.length); details.push(JSON.stringify(audit.smallFont.slice(0,4))); }
      if (audit.lowContrast.length) { issues.push('CONTRAST:' + audit.lowContrast.length); details.push(JSON.stringify(audit.lowContrast.slice(0,3))); }
      await shot(`${theme.key}-${String(i+1).padStart(2,'0')}-${String(name).replace(/[\\/:*?"<>|]/g,'_')}`);
      console.log('  [' + theme.key + ']', name, issues.length ? '!!! ' + issues.join(' | ') + (details.length ? ' :: ' + details.join(' :: ') : '') : 'ok');
    }
  }
  ws.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 180000);
