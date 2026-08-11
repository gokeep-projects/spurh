const wsUrl = 'ws://localhost:9333/devtools/page/0498671E510AE37ADAC05554BA650E24';
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
function send(method, params = {}) { return new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }); }
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); } };
ws.onopen = async () => {
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '').slice(0, 120); return r.result.value; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // open settings -> about
  await ev(`document.querySelectorAll('.app-actions .settings-button')[1].click()`); await wait(400);
  await ev(`(() => { const b = [...document.querySelectorAll('.settings-nav button')].find(x => x.textContent.includes('关于')); if (b) b.click(); return !!b; })()`); await wait(900);
  const about = await ev(`(() => {
    const q = (s) => !!document.querySelector(s);
    return {
      canvas: q('.about-canvas, canvas'),
      glow: q('.about-glow'),
      scanline: q('.about-scanline'),
      aurora: q('.about-aurora'),
      clock: q('.about-clock'),
      hero: q('.about-hero'),
      logo: q('.about-logo, .brand-mark'),
      panels: document.querySelectorAll('.about-panel, .about-stats, .about-grid > *').length,
      bodyText: document.querySelector('.settings-body, .about-body')?.textContent.trim().slice(0, 80) || ''
    };
  })()`);
  // close settings
  await ev(`(() => { const b = document.querySelector('.settings-header button[aria-label="\u5173\u95ed"]'); if (b) b.click(); return true; })()`); await wait(400);
  console.log(JSON.stringify(about, null, 1));
  ws.close(); process.exit(0);
};
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 30000);
