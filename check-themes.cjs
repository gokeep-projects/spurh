const fs = require('fs');
const wsUrl = 'ws://localhost:9333/devtools/page/793AD406505E64CE7384AAF0A9385F79';
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
function send(method, params = {}) { return new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }); }
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); } };
ws.onopen = async () => {
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result.value; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const labels = ['深色', '明亮', '极光', '护眼'];
  const vars = ['--bg', '--panel', '--text', '--accent', '--panel-2', '--line'];
  const out = [];
  for (const l of labels) {
    await ev(`(() => { const b = [...document.querySelectorAll('.theme-choice button')].find(x => x.textContent.includes(${JSON.stringify(l)})); if (b) b.click(); return !!b; })()`);
    await wait(400);
    const vals = await ev(`(() => { const cs = getComputedStyle(document.documentElement); return { ${vars.map(v => `'${v}': cs.getPropertyValue('${v}').trim()`).join(',')}, app: document.querySelector('.app').className }; })()`);
    out.push({ label: l, ...vals });
  }
  console.log(JSON.stringify(out, null, 1));
  ws.close(); process.exit(0);
};
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 30000);
