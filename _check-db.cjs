const wsUrl = 'ws://localhost:9333/devtools/page/0498671E510AE37ADAC05554BA650E24';
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
function send(method, params = {}) { return new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }); }
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); } };
ws.onopen = async () => {
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '').slice(0, 150); return r.result.value; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // DB tool (index 8)
  await ev(`document.querySelectorAll('.tool-list button')[8].click()`); await wait(900);
  const db = await ev(`(() => {
    const text = document.querySelector('.workspace')?.textContent || '';
    return {
      hasNewConn: text.includes('新建连接'),
      hasUserMgmt: text.includes('用户管理'),
      hasSqlTab: text.includes('SQL'),
      connCount: (text.match(/MySQL|PostgreSQL|SQLite/g) || []).length,
      body: text.trim().slice(0, 150)
    };
  })()`);
  // click 新建连接 to see form
  await ev(`(() => { const b = [...document.querySelectorAll('.workspace button')].find(x => x.textContent.includes('新建连接')); if (b) b.click(); return !!b; })()`); await wait(500);
  const form = await ev(`(() => {
    const ws = document.querySelector('.workspace');
    const inputs = [...ws.querySelectorAll('input')].map(i => i.placeholder || i.type);
    const hasPwdToggle = [...ws.querySelectorAll('button')].some(b => b.title === '显示' || b.title.includes('显'));
    const hasSsl = (ws.textContent || '').includes('SSL');
    return { inputs, hasPwdToggle, hasSsl, body: ws.textContent.trim().slice(0, 120) };
  })()`);
  console.log(JSON.stringify({ db, form }, null, 1));
  ws.close(); process.exit(0);
};
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 30000);
