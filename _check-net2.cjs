const wsUrl = 'ws://localhost:9333/devtools/page/0498671E510AE37ADAC05554BA650E24';
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
function send(method, params = {}) { return new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }); }
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); } };
ws.onopen = async () => {
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '').slice(0, 150); return r.result.value; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const clickTab = async (label) => ev(`(() => { const b = [...document.querySelectorAll('.workspace button')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (b) { b.click(); return 'ok'; } return 'NO'; })()`);
  // TCP/UDP tab
  await clickTab('TCP / UDP'); await wait(600);
  const tcp = await ev(`(() => {
    const ws = document.querySelector('.workspace');
    const inputs = [...ws.querySelectorAll('input')].map(i => i.value || i.placeholder).slice(0, 6);
    const areas = [...ws.querySelectorAll('textarea')].map(t => t.rows + '行 ' + (t.placeholder || ''));
    const btns = [...ws.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean).slice(0, 14);
    return { inputs, areas, btns, body: ws.textContent.trim().slice(0, 120) };
  })()`);
  // trace tab
  await clickTab('链路追踪'); await wait(800);
  const trace = await ev(`(() => {
    const ws = document.querySelector('.workspace');
    return {
      hasSvg: !!ws.querySelector('svg'),
      hasTopo: !!ws.querySelector('.topo, .trace-canvas, .topology'),
      hostDefault: [...ws.querySelectorAll('input')].map(i => i.value || i.placeholder).slice(0, 4),
      btns: [...ws.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean).slice(0, 8),
      body: ws.textContent.trim().slice(0, 100)
    };
  })()`);
  console.log(JSON.stringify({ tcp, trace }, null, 1));
  ws.close(); process.exit(0);
};
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 30000);
