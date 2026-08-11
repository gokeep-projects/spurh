const wsUrl = 'ws://localhost:9333/devtools/page/0498671E510AE37ADAC05554BA650E24';
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
function send(method, params = {}) { return new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }); }
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); } };
ws.onopen = async () => {
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '').slice(0, 150); return r.result.value; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await ev(`document.querySelectorAll('.tool-list button')[0].click()`); await wait(900);
  // perf: set large JSON and measure format time
  const perf = await ev(`(async () => {
    const ta = document.querySelector('.editor-input textarea');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    const big = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ id: i, name: 'item' + i, tags: ['a', 'b', 'c'], nested: { x: i * 2 } })));
    set.call(ta, big); ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    const t0 = performance.now();
    const btn = [...document.querySelectorAll('.workspace .actions button')].find(b => b.textContent.includes('格式化'));
    btn.click();
    await new Promise(r => setTimeout(r, 800));
    const dt = Math.round(performance.now() - t0 - 800);
    const out = document.querySelector('.output-pane')?.textContent || '';
    return { inputLen: big.length, outLen: out.length, clickToRenderMs: dt, hasTree: out.includes('树视图') };
  })()`);
  console.log(JSON.stringify(perf, null, 1));
  ws.close(); process.exit(0);
};
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 30000);
