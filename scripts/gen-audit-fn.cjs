const fs = require('fs');
// Run via playwright MCP browser_run_code_unsafe
const auditFn = `() => {
  const issues = [];
  const wsEl = document.querySelector('.workspace');
  const wsR = wsEl.getBoundingClientRect();
  if (wsEl.scrollWidth > wsEl.clientWidth + 2) issues.push('ws-overflow-x:' + (wsEl.scrollWidth - wsEl.clientWidth));
  const vis = [...wsEl.querySelectorAll('*')].filter(el => {
    const c = getComputedStyle(el); const r = el.getBoundingClientRect();
    return c.display !== 'none' && c.visibility !== 'hidden' && r.width > 4 && r.height > 4;
  });
  for (const el of vis) {
    const r = el.getBoundingClientRect();
    if (r.right > wsR.right + 2 || r.left < wsR.left - 2) {
      const tag = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0,2).join('.') : '');
      if (r.width > 8 && r.height > 8) issues.push('outside:' + tag + ' L' + Math.round(r.left) + ' R' + Math.round(r.right));
    }
    if (el.children.length === 0) {
      const fs2 = parseFloat(getComputedStyle(el).fontSize);
      if (fs2 > 0 && fs2 < 11.5 && el.textContent.trim()) issues.push('tiny:' + fs2 + 'px "' + el.textContent.trim().slice(0, 14) + '"');
    }
  }
  const leaves = vis.filter(el => el.children.length === 0 || ['BUTTON','INPUT','TEXTAREA','SELECT'].includes(el.tagName));
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i].getBoundingClientRect(), b = leaves[j].getBoundingClientRect();
      const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      if (ix > 4 && iy > 4) {
        const area = ix * iy;
        const minArea = Math.min(a.width * a.height, b.width * b.height);
        if (minArea > 0 && area / minArea > 0.4) {
          const tagA = leaves[i].tagName.toLowerCase() + (leaves[i].textContent || '').trim().slice(0, 10);
          const tagB = leaves[j].tagName.toLowerCase() + (leaves[j].textContent || '').trim().slice(0, 10);
          if (tagA !== tagB && !leaves[i].contains(leaves[j]) && !leaves[j].contains(leaves[i])) issues.push('overlap:' + tagA + '<>' + tagB);
        }
      }
    }
  }
  const disabled = [...wsEl.querySelectorAll('button:disabled, input:disabled, select:disabled')].map(el => (el.textContent || el.placeholder || '').trim().slice(0, 14));
  return { issues: issues.slice(0, 20), disabled, vis: vis.length };
}`;
fs.writeFileSync('scripts/audit-fn.js', auditFn);
console.log('written');
