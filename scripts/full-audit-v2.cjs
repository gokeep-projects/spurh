// Comprehensive audit: 4 themes x 11 tools - layout + contrast + function smoke + console errors
// Usage: node scripts/full-audit-v2.cjs <cdp-ws-url>
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
const LAYOUT_JS = `(() => {
  const parseC = (c) => { const m = c.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/); if (!m) return null; return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] }; };
  const lum = (r, g, b) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const cr = (fg, bg) => { const f = lum(fg.r, fg.g, fg.b), b = lum(bg.r, bg.g, bg.b); const [hi, lo] = f > b ? [f, b] : [b, f]; return (hi + 0.05) / (lo + 0.05); };
  const issues = [];
  const wsEl = document.querySelector('.workspace');
  const doc = document.documentElement;
  if (wsEl) {
    const wsR = wsEl.getBoundingClientRect();
    if (doc.scrollWidth > doc.clientWidth + 2) issues.push({ k: 'doc-overflow-x', v: '' + (doc.scrollWidth - doc.clientWidth) });
    if (wsEl.scrollWidth > wsEl.clientWidth + 2) issues.push({ k: 'ws-overflow-x', v: '' + (wsEl.scrollWidth - wsEl.clientWidth) });
    const vis = [...wsEl.querySelectorAll('*')].filter(el => {
      const c = getComputedStyle(el); const r = el.getBoundingClientRect();
      return c.display !== 'none' && c.visibility !== 'hidden' && r.width > 4 && r.height > 4;
    });
    for (const el of vis) {
      const r = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : '');
      if (r.right > wsR.right + 3 || r.left < wsR.left - 3) {
        if (r.width > 8 && r.height > 8) issues.push({ k: 'outside-ws', v: tag + ' L' + Math.round(r.left) + ' R' + Math.round(r.right) + ' wsR' + Math.round(wsR.right) });
      }
      if (el.children.length === 0) {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs > 0 && fs < 11.5 && el.textContent.trim()) issues.push({ k: 'tiny-font', v: tag + ' ' + fs + 'px "' + el.textContent.trim().slice(0, 20) + '"' });
      }
    }
    // contrast: leaf text vs effective bg
    const effBg = (el) => {
      let node = el; let color = null;
      while (node && node !== document.documentElement) {
        const c = getComputedStyle(node);
        if (c.backgroundColor && c.backgroundColor !== 'transparent' && c.backgroundColor !== 'rgba(0, 0, 0, 0)') {
          const p = parseC(c.backgroundColor);
          if (p && p.a > 0.02) { color = p; break; }
        }
        node = node.parentElement;
      }
      return color;
    };
    for (const el of vis) {
      const c = getComputedStyle(el);
      if (el.children.length === 0) {
        const txt = (el.textContent || '').trim();
        const fg = parseC(c.color);
        const fs = parseFloat(c.fontSize);
        if (fg && txt && fg.a > 0.4 && fs > 0) {
          const bg = effBg(el);
          if (bg) {
            const ratio = cr(fg, bg);
            const need = fs >= 18 ? 2 : (fs >= 14 ? 2.6 : 3);
            if (ratio < need && !el.closest('.tool-list') && !el.closest('.app-bar') && !el.closest('.dispatcher') && !el.closest('.about-stage')) {
              const tag = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : '');
              issues.push({ k: 'weak-contrast', v: tag + ' cr=' + ratio.toFixed(2) + ' fg=' + c.color + ' bg=' + c.backgroundColor + ' "' + txt.slice(0, 22) + '"' });
            }
          }
        }
      }
    }
  }
  return issues.slice(0, 40);
})()`;
ws.onopen = async () => {
  try {
    await send('Runtime.enable'); await send('Page.enable');
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 200); return r.result.value; };
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const report = { themes: [] };
    const themes = [
      { key: 'dark', label: '深色' },
      { key: 'light', label: '明亮' },
      { key: 'aurora', label: '极光' },
      { key: 'forest', label: '护眼' }
    ];
    const setInput = async (sel, txt) => {
      const js = JSON.stringify(txt).replace(/</g, '\\x3C');
      return ev(`(() => { const ta = document.querySelector(${JSON.stringify(sel)}); if (!ta) return 'NO-EL'; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(ta, ${js}); ta.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    };
    const clickBtn = async (sel, text) => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => (x.textContent || '').includes(${JSON.stringify(text)})); if (!b) return 'NO-BTN'; b.click(); return 'ok'; })()`);
    const resultState = () => ev(`(() => {
      const os = document.querySelector('.output-scroll');
      const raw = document.querySelector('.result-raw');
      const jsonv = document.querySelector('.result-view, .json-view, .kv-view');
      const err = document.querySelector('.error-box');
      const empty = document.querySelector('.output-empty');
      const txt = os ? os.textContent.trim().slice(0, 80) : '';
      return { hasRaw: !!raw, hasView: !!jsonv, err: err ? err.textContent.trim().slice(0, 90) : '', empty: !!empty, txt };
    })()`);
    for (const t of themes) {
      await ev(`(() => { const b = [...document.querySelectorAll('.app-actions button')].find(x => (x.textContent || '').includes('设置')); if (b) b.click(); return !!b; })()`);
      await wait(350);
      await ev(`(() => { const b = [...document.querySelectorAll('.theme-choice button')].find(x => (x.textContent || '').includes(${JSON.stringify(t.label)})); if (b) b.click(); return !!b; })()`);
      await wait(350);
      await ev(`(() => { const b = document.querySelector('.settings-header button[aria-label="关闭"]'); if (b) b.click(); return true; })()`);
      await wait(450);
      const toolTests = [];
      const n = await ev(`document.querySelectorAll('.tool-list button').length`);
      for (let i = 0; i < n; i++) {
        const name = await ev(`document.querySelectorAll('.tool-list button')[${i}].textContent.trim()`);
        await ev(`document.querySelectorAll('.tool-list button')[${i}].click()`);
        await wait(350);
        const layout = await ev(LAYOUT_JS);
        let func = {};
        if (i === 0) { // 格式化 JSON
          await setInput('.editor-input textarea', '{"a": 1, "b": [1,2]}');
          await wait(400);
          const c = await clickBtn('.workspace .actions button, .workspace .tool-controls button', '格式化');
          await wait(600);
          func = { click: c, res: await resultState() };
        } else if (i === 1) { // 时间戳
          func = { live: await ev(`!!document.querySelector('.ts-live-clock')`), res: await resultState() };
        } else if (i === 2) { // 文本处理
          await setInput('.editor-input textarea', 'hello world');
          await wait(500);
          func = { res: await resultState() };
        } else if (i === 3) { // 随机生成
          const c = await clickBtn('.workspace .actions button', '安全密码');
          await wait(700);
          func = { click: c, res: await resultState() };
        } else if (i === 4) { // 加解密
          await setInput('.editor-input textarea, .crypto-input textarea', 'hello secret');
          await wait(300);
          const c = await clickBtn('.workspace .crypto-chips button, .workspace .actions button', '加密');
          await wait(700);
          func = { click: c, res: await resultState() };
        } else if (i === 5) { // Cron
          const c = await clickBtn('.workspace .cron-actions button', '生成');
          await wait(600);
          func = { click: c, res: await resultState() };
        } else if (i === 6) { // 编码转换
          await setInput('.editor-input textarea', 'hello');
          await wait(300);
          const c = await clickBtn('.workspace .actions button', 'Base64 编码');
          await wait(600);
          func = { click: c, res: await resultState() };
        } else if (i === 7) { // 正则
          await setInput('.editor-input textarea, .regex-input textarea', 'abc123');
          await wait(300);
          const p = await setInput('.regex-pat input, .regex-row input, .regex-pattern input', '\\d+');
          await wait(300);
          const c = await clickBtn('.workspace .regex-actions button, .workspace .actions button', '测试');
          await wait(600);
          func = { click: c, res: await resultState() };
        } else if (i === 8) { // 数据库
          func = { conns: await ev(`document.querySelectorAll('.sql-conn').length`) };
        } else if (i === 9) { // 网络
          func = { modes: await ev(`[...document.querySelectorAll('.net-modes button')].map(b => (b.textContent || '').trim().slice(0, 8))`) };
        } else if (i === 10) { // 远程连接
          func = { hasTerm: await ev(`!!document.querySelector('.remote-panel, .xterm')`) };
        }
        toolTests.push({ i, name, layout, func });
      }
      const base = await ev(`(() => { const app = document.querySelector('.app'); const c = app ? getComputedStyle(app) : null; return { cls: app ? app.className : null, bg: c ? c.backgroundColor : null }; })()`);
      report.themes.push({ key: t.key, cls: base.cls, bg: base.bg, tools: toolTests });
      console.log('theme', t.key, 'done, tool pages:', n);
    }
    report.consoleErrors = consoleMsgs.slice(0, 60);
    fs.writeFileSync('full-audit-v2.json', JSON.stringify(report, null, 1));
    console.log('saved full-audit-v2.json; console errors:', consoleMsgs.length);
  } catch (e) { console.error('FATAL', e.message); }
  ws.close(); process.exit(0);
};
ws.onerror = () => { console.error('WS ERR'); process.exit(1); };
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 300000);
