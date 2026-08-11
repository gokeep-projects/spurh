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
    const auditJs = `(() => {
      const issues = [];
      const wsEl = document.querySelector('.workspace');
      if (!wsEl) return { issues, note: 'no workspace' };
      const wsR = wsEl.getBoundingClientRect();
      // 1. horizontal overflow of workspace
      if (wsEl.scrollWidth > wsEl.clientWidth + 2) issues.push({ k: 'ws-overflow-x', v: wsEl.scrollWidth - wsEl.clientWidth });
      // 2. visible interactive/text elements outside workspace
      const vis = [...wsEl.querySelectorAll('*')].filter(el => {
        const c = getComputedStyle(el); const r = el.getBoundingClientRect();
        return c.display !== 'none' && c.visibility !== 'hidden' && r.width > 4 && r.height > 4;
      });
      for (const el of vis) {
        const r = el.getBoundingClientRect();
        if (r.right > wsR.right + 2 || r.left < wsR.left - 2) {
          const tag = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0,2).join('.') : '');
          if (r.width > 8 && r.height > 8) issues.push({ k: 'outside-ws', v: tag + ' L' + Math.round(r.left) + ' R' + Math.round(r.right) + ' wsR' + Math.round(wsR.right) });
        }
        // small font on text
        if (el.children.length === 0) {
          const fs = parseFloat(getComputedStyle(el).fontSize);
          if (fs > 0 && fs < 11.5 && el.textContent.trim()) issues.push({ k: 'tiny-font', v: tag + ' ' + fs + 'px "' + el.textContent.trim().slice(0, 20) + '"' });
        }
      }
      // 3. overlap: pairs of leaf-ish visible elements intersecting > 30% of smaller area
      const leaves = vis.filter(el => el.children.length === 0 || el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
      for (let i = 0; i < leaves.length; i++) {
        for (let j = i + 1; j < leaves.length; j++) {
          const a = leaves[i].getBoundingClientRect(), b = leaves[j].getBoundingClientRect();
          const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
          const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          if (ix > 4 && iy > 4) {
            const area = ix * iy;
            const minArea = Math.min(a.width * a.height, b.width * b.height);
            if (minArea > 0 && area / minArea > 0.4) {
              const tagA = leaves[i].tagName.toLowerCase() + (leaves[i].textContent || '').trim().slice(0, 12);
              const tagB = leaves[j].tagName.toLowerCase() + (leaves[j].textContent || '').trim().slice(0, 12);
              if (tagA !== tagB && !leaves[i].contains(leaves[j]) && !leaves[j].contains(leaves[i])) {
                issues.push({ k: 'overlap', v: tagA + ' <> ' + tagB });
              }
            }
          }
        }
      }
      // 4. disabled state summary
      const disabled = [...wsEl.querySelectorAll('button:disabled, input:disabled, select:disabled')].map(el => (el.tagName.toLowerCase()) + (el.textContent || el.placeholder || '').trim().slice(0, 16));
      return { issues: issues.slice(0, 25), disabled, vis: vis.length, ws: Math.round(wsR.width) + 'x' + Math.round(wsR.height) };
    })()`;
    const report = { tools: [] };
    const n = await ev(`document.querySelectorAll('.tool-list button').length`);
    for (let i = 0; i < n; i++) {
      const name = await ev(`document.querySelectorAll('.tool-list button')[${i}].textContent.trim()`);
      await ev(`document.querySelectorAll('.tool-list button')[${i}].click()`);
      await wait(400);
      const st = await ev(auditJs);
      report.tools.push({ i, name, ...st });
    }
    report.consoleErrors = consoleMsgs;
    fs.writeFileSync('layout-audit.json', JSON.stringify(report, null, 1));
    console.log('done', report.tools.map(t => t.issues.length).join(','));
  } catch (e) { console.error('FATAL', e.message); }
  ws.close(); process.exit(0);
};
ws.onerror = () => { console.error('WS ERR'); process.exit(1); };
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 120000);
