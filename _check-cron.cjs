const wsUrl = 'ws://localhost:9333/devtools/page/0498671E510AE37ADAC05554BA650E24';
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
function send(method, params = {}) { return new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }); }
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); } };
ws.onopen = async () => {
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '').slice(0, 150); return r.result.value; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await ev(`document.querySelectorAll('.tool-list button')[5].click()`); await wait(900);
  const cron = await ev(`(() => {
    const ws = document.querySelector('.workspace');
    return { hasIntro: (ws.textContent || '').includes('定时任务'), body: ws.textContent.trim().slice(0, 160) };
  })()`);
  console.log(JSON.stringify(cron, null, 1));
  ws.close(); process.exit(0);
};
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 30000);
