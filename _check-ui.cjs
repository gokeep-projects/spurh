const wsUrl = 'ws://localhost:9333/devtools/page/0498671E510AE37ADAC05554BA650E24';
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
function send(method, params = {}) { return new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }); }
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); } };
ws.onopen = async () => {
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '').slice(0, 150); return r.result.value; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // focus dispatcher, type something
  await ev(`(() => { const ta = document.querySelector('.dispatcher textarea'); ta.focus(); return true; })()`); await wait(200);
  const drop = await ev(`(() => {
    const ta = document.querySelector('.dispatcher textarea');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, 'hello'); ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`); await wait(600);
  const dd = await ev(`(() => {
    const m = document.querySelector('.dispatch-matches');
    if (!m) return { open: false };
    const r = m.getBoundingClientRect();
    const bar = document.querySelector('.app-bar').getBoundingClientRect();
    const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
    const overlapSidebar = r.left < sidebar.right - 2;
    const overlapBar = r.top < bar.bottom - 2;
    const z = getComputedStyle(m).zIndex;
    return { open: true, box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], overlapSidebar, overlapBar, z, bg: getComputedStyle(m).backgroundColor, items: [...m.querySelectorAll('button')].map(b => b.textContent.trim().slice(0, 20)).slice(0, 5) };
  })()`);
  await ev(`(() => { const ta = document.querySelector('.dispatcher textarea'); ta.blur(); return true; })()`); await wait(300);
  // settings -> 通用
  await ev(`document.querySelectorAll('.app-actions .settings-button')[1].click()`); await wait(400);
  const settings = await ev(`(() => {
    const body = document.querySelector('.settings-body, .settings')?.textContent || '';
    return {
      hasTopBar: body.includes('顶栏'),
      hasMenuBar: body.includes('菜单栏'),
      hasTheme: body.includes('主题'),
      hasFont: body.includes('字体'),
      snippet: body.trim().slice(0, 200)
    };
  })()`);
  await ev(`(() => { const b = document.querySelector('.settings-header button[aria-label="\u5173\u95ed"]'); if (b) b.click(); return true; })()`);
  console.log(JSON.stringify({ drop: dd, settings }, null, 1));
  ws.close(); process.exit(0);
};
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 30000);
