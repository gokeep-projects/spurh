const wsUrl = 'ws://localhost:9333/devtools/page/0498671E510AE37ADAC05554BA650E24';
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
function send(method, params = {}) { return new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }); }
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); } };
ws.onopen = async () => {
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '').slice(0, 150); return r.result.value; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // format tool
  await ev(`document.querySelectorAll('.tool-list button')[0].click()`); await wait(900);
  const fmt = await ev(`(() => {
    const grid = document.querySelector('.editor-grid');
    const panes = [...document.querySelectorAll('.editor-pane')].map(p => { const r = p.getBoundingClientRect(); return Math.round(r.width); });
    const ta = document.querySelector('.editor-input textarea');
    return { gridW: Math.round(grid.getBoundingClientRect().width), panes, cols: getComputedStyle(grid).gridTemplateColumns };
  })()`);
  // type "{" to test auto-close
  const auto = await ev(`(() => {
    const ta = document.querySelector('.editor-input textarea');
    ta.focus();
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    const kd = new KeyboardEvent('keydown', { key: '{', bubbles: true, cancelable: true });
    const handled = !ta.dispatchEvent(kd);
    // simulate insert like the real handler would: handler calls changeInput -> but event is synthetic; instead check handler exists
    return { handled, handlerPresent: typeof ta.onkeydown === 'function' };
  })()`);
  console.log(JSON.stringify({ fmt, auto }, null, 1));
  ws.close(); process.exit(0);
};
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 30000);
