const fs = require('fs');
const wsUrl = process.argv[2];
const outDir = process.argv[3] || 'shots-final';
const shots = [
  { name: 'final-dark-home', themeIdx: 0 },
  { name: 'final-dark-format', themeIdx: 0, toolIdx: 0 },
  { name: 'final-dark-timestamp', themeIdx: 0, toolIdx: 1 },
  { name: 'final-dark-sql', themeIdx: 0, toolIdx: 8 },
  { name: 'final-dark-network', themeIdx: 0, toolIdx: 9 },
  { name: 'final-about', about: true },
  { name: 'final-light-home', themeIdx: 1 },
  { name: 'final-light-format', themeIdx: 1, toolIdx: 0 },
];
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
let ready = false;
const queue = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    const msg = JSON.stringify({ id: mid, method, params });
    if (ready) ws.send(msg); else queue.push(msg);
  });
}
ws.onopen = () => { ready = true; for (const m of queue) ws.send(m); queue.length = 0; };
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); } };
ws.onerror = () => {};
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result.value;
}
(async () => {
  await send('Page.enable');
  await send('Runtime.enable');
  await new Promise(r => setTimeout(r, 800));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (const s of shots) {
    if (s.toolIdx != null) { await evalJs(`document.querySelectorAll('.tool-list button')[${s.toolIdx}].click()`); await wait(700); }
    if (s.themeIdx != null) {
      await evalJs(`document.querySelectorAll('.app-actions .settings-button')[1].click()`);
      await wait(400);
      await evalJs(`document.querySelectorAll('.theme-choice button')[${s.themeIdx}].click()`);
      await wait(400);
      await evalJs(`(() => { const b = document.querySelector('.settings-header button[aria-label="\u5173\u95ed"]'); if (b) b.click(); return true; })()`);
      await wait(500);
    }
    if (s.about) {
      await evalJs(`document.querySelectorAll('.app-actions .settings-button')[1].click()`);
      await wait(400);
      await evalJs(`(() => { const b = [...document.querySelectorAll('.settings-nav button')].find(x => x.textContent.includes('\u5173\u4e8e')); if (b) b.click(); return true; })()`);
      await wait(1200);
    }
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(outDir + '\\' + s.name + '.png', Buffer.from(r.data, 'base64'));
    console.log('saved', s.name);
  }
  ws.close();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
setTimeout(() => process.exit(1), 90000);
