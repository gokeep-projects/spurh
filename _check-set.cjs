const wsUrl = 'ws://localhost:9333/devtools/page/0498671E510AE37ADAC05554BA650E24';
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
function send(method, params = {}) { return new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }); }
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); } };
ws.onopen = async () => {
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '').slice(0, 150); return r.result.value; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await ev(`document.querySelectorAll('.app-actions .settings-button')[1].click()`); await wait(600);
  const st = await ev(`(() => {
    const modal = document.querySelector('.settings-overlay, .settings-modal, .modal, .settings');
    const visible = [...document.querySelectorAll('div')].filter(d => d.textContent.includes('通用') && d.children.length > 2 && d.getBoundingClientRect().width > 300).map(d => d.className).slice(0, 5);
    const nav = [...document.querySelectorAll('.settings-nav button')].map(b => b.textContent.trim());
    const body = [...document.querySelectorAll('div')].find(d => d.className.includes('settings-body') || d.className.includes('settings-content'));
    return { modal: !!modal, nav, visible: visible.slice(0, 5), body: body ? body.textContent.trim().slice(0, 300) : null, bodyCls: body ? body.className : null };
  })()`);
  console.log(JSON.stringify(st, null, 1));
  await ev(`(() => { const b = document.querySelector('.settings-header button[aria-label="\u5173\u95ed"]'); if (b) b.click(); return true; })()`);
  ws.close(); process.exit(0);
};
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 30000);
