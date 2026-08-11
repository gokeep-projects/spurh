const fs = require('fs');
const wsUrl = process.argv[2];
const outDir = 'shots-full-' + Date.now();
fs.mkdirSync(outDir, { recursive: true });
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map(); let ready = false; const queue = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    const msg = JSON.stringify({ id: mid, method, params });
    if (ready) ws.send(msg); else queue.push(msg);
  });
}
ws.onopen = () => { ready = true; for (const m of queue) ws.send(m); queue.length = 0; };
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); } };
ws.onerror = () => {};
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 120);
  return r.result.value;
}
(async () => {
  await send('Page.enable'); await send('Runtime.enable');
  await new Promise(r => setTimeout(r, 600));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const themeLabels = ['深色', '明亮', '极光', '护眼'];
  const toolCount = await evalJs(`document.querySelectorAll('.tool-list button').length`);
  console.log('tools:', toolCount);
  // home first (theme 0 default)
  let shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${outDir}/home-dark.png`, Buffer.from(shot.data, 'base64'));
  for (let t = 0; t < 4; t++) {
    if (t > 0) {
      await evalJs(`document.querySelectorAll('.app-actions .settings-button')[1].click()`); await wait(350);
      await evalJs(`(() => { const b = [...document.querySelectorAll('.theme-choice button')].find(x => x.textContent.includes(${JSON.stringify(themeLabels[t])})); if (b) b.click(); return !!b; })()`); await wait(350);
      await evalJs(`(() => { const b = document.querySelector('.settings-header button[aria-label="\u5173\u95ed"]'); if (b) b.click(); return true; })()`); await wait(400);
    }
    if (t > 0) { shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${outDir}/home-${['dark','light','aurora','forest'][t]}.png`, Buffer.from(shot.data, 'base64')); }
    for (let i = 0; i < toolCount; i++) {
      await evalJs(`document.querySelectorAll('.tool-list button')[${i}].click()`); await wait(550);
      const name = await evalJs(`document.querySelectorAll('.tool-list button')[${i}].textContent.trim()`);
      shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(`${outDir}/t${['dark','light','aurora','forest'][t]}-${i}-${name.replace(/[\\/:*?"<>|]/g, '_')}.png`, Buffer.from(shot.data, 'base64'));
    }
  }
  // about
  await evalJs(`document.querySelectorAll('.app-actions .settings-button')[1].click()`); await wait(350);
  await evalJs(`(() => { const b = [...document.querySelectorAll('.settings-nav button')].find(x => x.textContent.includes('关于')); if (b) b.click(); return true; })()`); await wait(1000);
  shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${outDir}/about.png`, Buffer.from(shot.data, 'base64'));
  console.log('saved to', outDir);
  ws.close(); process.exit(0);
})().catch(e => { console.error('FATAL', e); ws.close(); process.exit(1); });
