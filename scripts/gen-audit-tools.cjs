const fs = require('fs');
const auditFn = fs.readFileSync('scripts/audit-fn.js', 'utf8');
const code = `async (page) => {
  const audit = async () => {
    const fn = ${auditFn};
    return page.evaluate(fn);
  };
  const results = [];
  const count = await page.evaluate(() => document.querySelectorAll('.tool-list button').length);
  for (let i = 0; i < count; i++) {
    const name = await page.evaluate((idx) => document.querySelectorAll('.tool-list button')[idx].textContent.trim(), i);
    await page.evaluate((idx) => document.querySelectorAll('.tool-list button')[idx].click(), i);
    await page.waitForTimeout(450);
    const st = await audit();
    results.push({ i, name, ...st });
  }
  require('fs').writeFileSync('layout-audit-dev.json', JSON.stringify(results, null, 1));
  return results;
}`;
fs.writeFileSync('scripts/audit-all-tools.js', code);
console.log('ok');
