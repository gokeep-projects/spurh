const wsUrl = 'ws://localhost:9333/devtools/page/0498671E510AE37ADAC05554BA650E24';
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
function send(method, params = {}) { return new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }); }
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); } };
ws.onopen = async () => {
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '').slice(0, 150); return r.result.value; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // network tool (index 9)
  await ev(`document.querySelectorAll('.tool-list button')[9].click()`); await wait(1000);
  const net = await ev(`(() => {
    const ws = document.querySelector('.workspace');
    const inputs = [...ws.querySelectorAll('input')].map(i => i.value || i.placeholder).slice(0, 8);
    const btns = [...ws.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean).slice(0, 12);
    return { inputs, btns, body: ws.textContent.trim().slice(0, 100) };
  })()`);
  // start port scan on localhost common ports
  const scan = await ev(`(() => {
    const ws = document.querySelector('.workspace');
    const host = [...ws.querySelectorAll('input')].find(i => (i.placeholder || '').includes('127.0.0.1') || (i.value || '').includes('127.0.0.1'));
    if (host) { host.value = '127.0.0.1'; host.dispatchEvent(new Event('input', { bubbles: true })); }
    const start = [...ws.querySelectorAll('button')].find(b => b.textContent.includes('开始扫描'));
    if (start) { start.click(); return 'clicked'; }
    return 'no-scan-btn';
  })()`);
  await wait(6000);
  const scanState = await ev(`(() => {
    const ws = document.querySelector('.workspace');
    const rows = [...ws.querySelectorAll('tr, .scan-row, .port-row')].map(r => r.textContent.trim().slice(0, 40));
    return { rows: rows.slice(0, 12), hasProgress: !!document.querySelector('.scan-progress, progress'), body: ws.textContent.includes('开放') ? 'has-open' : ws.textContent.slice(0, 80) };
  })()`);
  console.log(JSON.stringify({ net, scan, scanState }, null, 1));
  ws.close(); process.exit(0);
};
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 30000);
