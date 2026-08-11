// Theme audit: detect low-contrast/invisible text, layout overlap, misalignment
// Usage: node scripts/theme-audit.cjs <cdp-ws-url>
const fs = require('fs');
const wsUrl = process.argv[2];
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); return; }
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });
}
function luminance(r, g, b) {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function parseColor(c) {
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}
function contrast(fg, bg) {
  const f = luminance(fg.r, fg.g, fg.b), b = luminance(bg.r, bg.g, bg.b);
  const [l1, l2] = f > b ? [f, b] : [b, f];
  return (l1 + 0.05) / (l2 + 0.05);
}
ws.onopen = async () => {
  try {
    await send('Runtime.enable'); await send('Page.enable');
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '').slice(0, 150); return r.result.value; };
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const themes = [
      { key: 'dark', label: '深色' },
      { key: 'light', label: '明亮' },
      { key: 'aurora', label: '极光' },
      { key: 'forest', label: '护眼' }
    ];
    const report = {};
    for (const t of themes) {
      // open settings, pick theme
      await ev(`(() => { const b = [...document.querySelectorAll('.app-actions button')].find(x => x.textContent.includes('设置')); if (b) b.click(); return !!b; })()`);
      await wait(400);
      await ev(`(() => { const b = [...document.querySelectorAll('.theme-choice button')].find(x => x.textContent.includes(${JSON.stringify(t.label)})); if (b) b.click(); return !!b; })()`);
      await wait(400);
      await ev(`(() => { const b = document.querySelector('.settings-header button[aria-label="关闭"]'); if (b) b.click(); return true; })()`);
      await wait(500);
      const audit = await ev(`(() => {
        const issues = [];
        const app = document.querySelector('.app');
        const seen = new Set();
        const walk = (el, depth) => {
          if (depth > 40 || seen.has(el)) return;
          seen.add(el);
          const c = getComputedStyle(el);
          if (c.display === 'none' || c.visibility === 'hidden') return;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) return;
          const tag = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : '');
          const txt = (el.textContent || '').trim().slice(0, 30);
          const bg = c.backgroundColor;
          const fg = c.color;
          if (bg && fg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
            const bgc = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
            const fgc = fg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
            if (bgc && fgc && el.children.length === 0 && txt) {
              const bgA = bgc[4] === undefined ? 1 : +bgc[4];
              const fgA = fgc[4] === undefined ? 1 : +fgc[4];
              if (bgA > 0.5 && fgA > 0.5) {
                const cr = contrast({ r: +bgc[1], g: +bgc[2], b: +bgc[3] }, { r: +fgc[1], g: +fgc[2], b: +fgc[3] });
                if (cr < 1.6) issues.push({ k: 'low-contrast', v: tag + ' bg=' + bg + ' fg=' + fg + ' cr=' + cr.toFixed(2) + ' "' + txt + '"' });
              }
            }
          }
          if (c.position === 'fixed' || c.position === 'absolute') {
            const parent = el.parentElement;
            if (parent && parent !== document.body) {
              const pr = parent.getBoundingClientRect();
              if (pr.width > 50 && pr.height > 50 && (r.top < pr.top - 60 || r.left < pr.left - 60 || r.right > pr.right + 60 || r.bottom > pr.bottom + 60)) {
                // likely a popup, skip
              }
            }
          }
          for (const ch of el.children) walk(ch, depth + 1);
        };
        walk(document.querySelector('.app') || document.body, 0);
        // top-level geometry check
        const bar = document.querySelector('.app-bar');
        const side = document.querySelector('.sidebar');
        const main = document.querySelector('.workspace') || document.querySelector('main');
        const info = {
          appBg: app ? getComputedStyle(app).backgroundColor : null,
          appCls: app ? app.className : null,
          bodyBg: getComputedStyle(document.body).backgroundColor,
          bodyCls: document.body.className
        };
        if (bar && side && main) {
          const br = bar.getBoundingClientRect(), sr = side.getBoundingClientRect(), mr = main.getBoundingClientRect();
          info.bar = { top: Math.round(br.top), left: Math.round(br.left), w: Math.round(br.width), h: Math.round(br.height), bg: getComputedStyle(bar).backgroundColor, color: getComputedStyle(bar).color };
          info.side = { top: Math.round(sr.top), left: Math.round(sr.left), w: Math.round(sr.width), h: Math.round(sr.height), bg: getComputedStyle(side).backgroundColor, color: getComputedStyle(side).color };
          info.main = { top: Math.round(mr.top), left: Math.round(mr.left), w: Math.round(mr.width), h: Math.round(mr.height) };
          if (mr.top < br.bottom - 2) issues.push({ k: 'main-under-bar', v: 'main.top=' + Math.round(mr.top) + ' bar.bottom=' + Math.round(br.bottom) });
          if (br.left !== sr.left) issues.push({ k: 'bar-side-misalign', v: 'bar.left=' + Math.round(br.left) + ' side.left=' + Math.round(sr.left) });
        }
        return { issues: issues.slice(0, 60), info };
      })()`);
      report[t.key] = audit;
      console.log('theme', t.key, 'issues:', audit.issues.length);
    }
    fs.writeFileSync('theme-audit.json', JSON.stringify(report, null, 1));
    console.log('saved theme-audit.json');
  } catch (e) { console.error('FATAL', e.message); }
  ws.close(); process.exit(0);
};
ws.onerror = () => { console.error('WS ERR'); process.exit(1); };
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 180000);
