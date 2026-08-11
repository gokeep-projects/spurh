const fs = require('fs');
const auditFn = fs.readFileSync('scripts/audit-fn.js', 'utf8').replace(/^\(\) =>/, '() =>');
// build a single browser_evaluate function string
const fn = `async () => {
  const audit = ${auditFn};
  const results = [];
  const count = document.querySelectorAll('.tool-list button').length;
  for (let i = 0; i < count; i++) {
    const name = document.querySelectorAll('.tool-list button')[i].textContent.trim();
    document.querySelectorAll('.tool-list button')[i].click();
    await new Promise(r => setTimeout(r, 450));
    const st = audit();
    results.push({ i, name, ...st });
  }
  window.__layoutAudit = results;
  return results;
}`;
fs.writeFileSync('scripts/audit-eval.js', fn);
console.log('ok');
