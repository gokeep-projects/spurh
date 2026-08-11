const fs = require('fs');
const wsUrl = process.argv[2];
let expression = process.argv[3];
if (!expression) { console.error('usage: node cdp-eval.cjs <wsurl> <expr-or-file>'); process.exit(1); }
if (expression === '-' ) expression = fs.readFileSync(0, 'utf8');
else if (expression.endsWith('.js') && fs.existsSync(expression)) expression = fs.readFileSync(expression, 'utf8');
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
ws.onopen = async () => {
  try {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) console.error('EXC:', JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
    else console.log(JSON.stringify(r.result.value ?? r.result, null, 1));
  } catch (e) { console.error('ERR:', e.message); }
  ws.close();
  process.exit(0);
};
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
};
ws.onerror = (e) => { console.error('WS ERR', e.message); process.exit(1); };
setTimeout(() => { console.error('timeout'); process.exit(1); }, 20000);
