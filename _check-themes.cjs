const fs = require('fs');
const wsUrl = 'ws://localhost:9333/devtools/page/0498671E510AE37ADAC05554BA650E24';
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
function send(method, params = {}) { return new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }); }
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); } };
ws.onopen = async () => {
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result.value; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await ev(`document.querySelectorAll('.app-actions button')[1].click()`); await wait(500);
  const labels = ['深色', '明亮', '极光', '护眼'];
  const out = [];
  for (const l of labels) {
    await ev(`(() => { const b = [...document.querySelectorAll('.theme-choice button')].find(x => x.textContent.includes(${JSON.stringify(l)})); if (b) b.click(); return !!b; })()`);
    await wait(450);
    const vals = await ev(`(() => { const app = document.querySelector('.app'); const cs = getComputedStyle(app); return { bg1: cs.getPropertyValue('--bg1').trim(), text: cs.getPropertyValue('--text').trim(), accent: cs.getPropertyValue('--accent').trim(), wsBg: getComputedStyle(document.querySelector('.workspace')).backgroundColor }; })()`);
    out.push({ label: l, ...vals });
  }
  await ev(`(() => { const b = document.querySelector('.settings-header button[aria-label="\u5173\u95ed"]'); if (b) b.click(); return true; })()`);
  console.log(JSON.stringify(out, null, 1));
  ws.close(); process.exit(0);
};
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 30000);
