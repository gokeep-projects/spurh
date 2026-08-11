const fs = require('fs');
const wsUrl = process.argv[2];
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map(); const consoleMsgs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') consoleMsgs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 200));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleMsgs.push('ERR: ' + m.params.args.map(a => a.value || a.description || '').join(' ').slice(0, 200));
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });
}
ws.onopen = async () => {
  try {
    await send('Runtime.enable'); await send('Page.enable');
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '').slice(0, 150); return r.result.value; };
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const report = { themes: [], consoleErrors: [] };
    const themes = [
      { key: 'dark', label: '\u6df1\u8272' },
      { key: 'light', label: '\u660e\u4eae' },
      { key: 'aurora', label: '\u6781\u5149' },
      { key: 'forest', label: '\u62a4\u773c' }
    ];
    for (const t of themes) {
      await ev(`document.querySelectorAll('.app-actions .settings-button')[1].click()`); await wait(400);
      await ev(`(() => { const b = [...document.querySelectorAll('.theme-choice button')].find(x => x.textContent.includes(${JSON.stringify(t.label)})); if (b) b.click(); return !!b; })()`); await wait(400);
      await ev(`(() => { const b = document.querySelector('.settings-header button[aria-label="\u5173\u95ed"]'); if (b) b.click(); return true; })()`); await wait(400);
      const base = await ev(`(() => { const app = document.querySelector('.app'); const ws = document.querySelector('.workspace'); const gs = (el) => { if (!el) return null; const c = getComputedStyle(el); return { bg: c.backgroundColor, color: c.color, grad: c.backgroundImage.slice(0, 60) }; }; return { cls: app ? app.className : 'NO-APP', ws: gs(ws), bar: gs(document.querySelector('.app-bar')), sidebar: gs(document.querySelector('.sidebar')) }; })()`);
      const tools = [];
      const n = await ev(`document.querySelectorAll('.tool-list button').length`);
      for (let i = 0; i < n; i++) {
        const name = await ev(`document.querySelectorAll('.tool-list button')[${i}].textContent.trim()`);
        await ev(`document.querySelectorAll('.tool-list button')[${i}].click()`); await wait(300);
        const st = await ev(`(() => {
          const d = document.documentElement;
          const overflowX = d.scrollWidth > d.clientWidth + 1;
          const ws = document.querySelector('.workspace');
          const wsR = ws.getBoundingClientRect();
          const visible = [...ws.querySelectorAll('*')].filter(el => { const c = getComputedStyle(el); const r = el.getBoundingClientRect(); return c.display !== 'none' && r.width > 4 && r.height > 4; }).length;
          const disabled = [...ws.querySelectorAll('button:disabled, input:disabled, select:disabled')].length;
          return { overflowX, wsW: Math.round(wsR.width), wsH: Math.round(wsR.height), visibleEls: visible, disabled };
        })()`);
        tools.push({ i, name, ...st });
      }
      report.themes.push({ key: t.key, ...base, tools });
    }
    report.consoleErrors = consoleMsgs.slice(0, 40);
    fs.writeFileSync('audit-full.json', JSON.stringify(report, null, 1));
    console.log('saved audit-full.json; console errors:', consoleMsgs.length);
  } catch (e) { console.error('FATAL', e.message); }
  ws.close(); process.exit(0);
};
ws.onerror = () => { console.error('WS ERR'); process.exit(1); };
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 200000);
