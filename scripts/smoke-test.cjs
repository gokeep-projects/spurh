const fs = require('fs');
const wsUrl = process.argv[2];
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map(); const consoleMsgs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') consoleMsgs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleMsgs.push('ERR: ' + m.params.args.map(a => a.value || a.description || '').join(' ').slice(0, 300));
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });
}
ws.onopen = async () => {
  try {
    await send('Runtime.enable'); await send('Page.enable');
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '').slice(0, 200); return r.result.value; };
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const setInput = async (txt) => {
      const js = JSON.stringify(txt).replace(/</g, '\\x3C');
      return ev(`(() => { const ta = document.querySelector('.editor-input textarea'); if (!ta) return 'NO-TA'; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, ${js}); ta.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    };
    const resultState = () => ev(`(() => {
      const os = document.querySelector('.output-scroll');
      const raw = document.querySelector('.result-raw');
      const jsonv = document.querySelector('.result-view, .json-view, .kv-view');
      const err = document.querySelector('.error-box');
      const empty = document.querySelector('.output-empty');
      const txt = os ? os.textContent.trim().slice(0, 60) : '';
      return { hasRaw: !!raw, hasView: !!jsonv, err: err ? err.textContent.trim().slice(0, 80) : '', empty: !!empty, txt };
    })()`);
    const report = { tests: [], consoleErrors: [] };
    const run = async (name, fn) => {
      try { const r = await fn(); report.tests.push({ name, ...r }); }
      catch (e) { report.tests.push({ name, error: e.message }); }
    };
    const clickTool = async (i) => { await ev(`document.querySelectorAll('.tool-list button')[${i}].click()`); await wait(400); };
    const clickBtn = async (sel, text) => ev(`(() => { const b = [...document.querySelectorAll('.workspace ${sel}')].find(x => (x.textContent || '').includes(${JSON.stringify(text)})); if (!b) return 'NO-BTN:' + ${JSON.stringify(text)}; b.click(); return 'ok'; })()`);

    // T0 json format
    await clickTool(0);
    await run('json-format', async () => { const r = await clickBtn('.actions button', '\u683c\u5f0f\u5316'); await wait(800); const s = await resultState(); return { click: r, hasRaw: s.hasRaw, err: s.err, txt: s.txt }; });

    // T1 timestamp now
    await clickTool(1);
    await run('timestamp-now', async () => { await wait(300); const s = await resultState(); const live = await ev(`!!document.querySelector('.ts-live-clock')`); return { live, hasRaw: s.hasRaw, err: s.err }; });

    // T2 text stats
    await clickTool(2);
    await run('text-stats', async () => { const r = await setInput('hello\nworld\nhello'); await wait(1000); const s = await resultState(); return { set: r, hasRaw: s.hasRaw, err: s.err, txt: s.txt }; });

    // T3 random password
    await clickTool(3);
    await run('random-password', async () => { const r = await clickBtn('.actions button', '\u5b89\u5168\u5bc6\u7801'); await wait(800); const s = await resultState(); return { click: r, hasRaw: s.hasRaw, err: s.err, txt: s.txt }; });

    // T4 crypto AES encrypt
    await clickTool(4);
    await run('crypto-aes', async () => { await setInput('hello secret'); const key = await ev(`(() => { const i = document.querySelector('.crypto-key-row input, .secret-wrap input'); if (!i) return 'NO-KEY'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'test-key-123456'); i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`); await wait(300); const r = await clickBtn('.crypto-chips button', '\u52a0\u5bc6'); await wait(900); const s = await resultState(); return { key, click: r, hasRaw: s.hasRaw, err: s.err, txt: s.txt }; });

    // T5 cron generate
    await clickTool(5);
    await run('cron-generate', async () => { const r = await clickBtn('.cron-actions button', '\u751f\u6210'); await wait(900); const s = await resultState(); const preview = await ev(`!!document.querySelector('.cron-preview-panel, .preview-runs, .cron-preview')`); return { click: r, preview, err: s.err, txt: s.txt }; });

    // T6 encoder base64
    await clickTool(6);
    await run('encoder-b64', async () => { const r = await setInput('hello'); await wait(600); const c = await clickBtn('.actions button', 'Base64 \u7f16\u7801'); await wait(900); const s = await resultState(); return { set: r, click: c, hasRaw: s.hasRaw, err: s.err, txt: s.txt }; });

    // T7 regex test
    await clickTool(7);
    await run('regex-test', async () => { const r = await setInput('abc123\nxyz456'); await wait(400); const p = await ev(`(() => { const i = document.querySelector('.regex-pat input, .regex-pat textarea, .regex-row input'); if (!i) return 'NO-PAT'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(i, '\\d+'); i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`); await wait(500); const c = await clickBtn('.regex-actions button', '\u6d4b\u8bd5\u5339\u914d'); await wait(900); const s = await resultState(); return { set: r, pat: p, click: c, hasRaw: s.hasRaw, err: s.err, txt: s.txt }; });

    // T8 sql panel render
    await clickTool(8);
    await run('sql-render', async () => { await wait(500); const conns = await ev(`document.querySelectorAll('.sql-conn').length`); const tree = await ev(`!!document.querySelector('.sql-tree, .sql-tables')`); return { conns, tree }; });

    // T9 network render + mode switch
    await clickTool(9);
    await run('network-render', async () => { await wait(400); const modes = await ev(`[...document.querySelectorAll('.net-modes button, .net-tools button')].map(b => (b.textContent || '').trim().slice(0, 10))`); const r = await clickBtn('.net-modes button', '\u94fe\u8def\u8ffd\u8e2a'); await wait(600); const topo = await ev(`!!document.querySelector('.net-topo, .topo, .net-trace')`); return { modes, switchClick: r, topo }; });

    // T10 remote render
    await clickTool(10);
    await run('remote-render', async () => { await wait(400); const side = await ev(`!!document.querySelector('.remote-side')`); const main = await ev(`!!document.querySelector('.remote-main')`); const add = await ev(`!!document.querySelector('.remote-add')`); return { side, main, add }; });

    report.consoleErrors = consoleMsgs.slice(0, 30);
    fs.writeFileSync('smoke-test.json', JSON.stringify(report, null, 1));
    console.log('saved smoke-test.json; console errors:', consoleMsgs.length);
  } catch (e) { console.error('FATAL', e.message); }
  ws.close(); process.exit(0);
};
ws.onerror = () => { console.error('WS ERR'); process.exit(1); };
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 120000);
