#!/usr/bin/env node
/*
 Browser check of the code-protected website before it is pushed.

   ACCESS_CODE=<code> NODE_PATH=$(npm root -g) node tools/check_site.js <built index.html> [<data.json> | -] [--expect "<css selector>"]

 Serves the site folder on 127.0.0.1 and opens it in headless Chromium (Playwright). Passes only when:
   - a wrong code is refused and the right code opens the page;
   - with data.json: the header shows its plant and manufacturer counts and the map is drawn;
     without: the --expect selector (default "#list .row") is found;
   - the page makes no request to any other server, and has no script errors, blocked loads or
     fingerprint failures;
   - a deliberately altered copy of a fingerprinted file (lib/*.js, fonts/fonts.css) is refused by the browser.
 Prints PASS or FAIL.
*/
const fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('playwright');
const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) if (args[i] === '--expect') opt.expect = args[++i]; else (opt.pos = opt.pos || []).push(args[i]);
const [sitePath, dataArg = '-'] = opt.pos || [];
const code = process.env.ACCESS_CODE;
if (!sitePath || !code) { console.error('usage: ACCESS_CODE=<code> node tools/check_site.js <index.html> [data.json|-] [--expect selector]'); process.exit(2); }
const data = dataArg !== '-' && fs.existsSync(dataArg) && dataArg.endsWith('.json') ? JSON.parse(fs.readFileSync(dataArg, 'utf8')) : null;
const dir = path.dirname(path.resolve(sitePath)), file = path.basename(sitePath);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain' };
const srv = http.createServer((q, r) => {
  const p = path.join(dir, decodeURIComponent(q.url.split('?')[0]));
  if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(r);
});
const wrong = code === '0000' ? '9999' : '0000';
async function open(ctx, base) {
  const p = await ctx.newPage(), log = { errs: [], console: [], outside: [] };
  p.on('pageerror', e => log.errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') log.console.push(m.text()); });
  p.on('request', q => { const u = new URL(q.url()); if (u.hostname !== '127.0.0.1' && u.protocol !== 'data:' && u.protocol !== 'blob:') log.outside.push(q.url()); });
  await p.goto(base + '/' + file);
  return { p, log };
}
(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port, b = await chromium.launch(), problems = [], info = {};
  try {
    // normal visit
    const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } });
    const { p, log } = await open(ctx, base);
    await p.fill('#code', wrong); await p.click('#go');
    await p.waitForFunction(() => /not right/.test((document.getElementById('err') || {}).textContent || ''), null, { timeout: 30000 }).catch(() => problems.push('a wrong code was not refused'));
    await p.fill('#code', code); await p.click('#go');
    if (data) {
      const want = data.sites.length.toLocaleString('en-US') + ' plants', makers = new Set(data.sites.map(x => x.c)).size;
      await p.waitForFunction(w => document.body && document.body.innerText.includes(w), want, { timeout: 60000 }).catch(() => problems.push('the map did not open or does not show "' + want + '"'));
      await p.waitForTimeout(1500);
      const s = await p.evaluate(() => ({ text: document.body.innerText, paths: document.querySelectorAll('svg path').length, dots: document.querySelectorAll('svg circle').length }));
      if (!s.text.includes(makers.toLocaleString('en-US') + ' manufacturers')) problems.push('header does not show ' + makers + ' manufacturers');
      if (s.paths < 10 || s.dots < 10) problems.push('map not drawn (' + s.paths + ' outlines, ' + s.dots + ' dots)');
      Object.assign(info, { plants: data.sites.length, manufacturers: makers, outlines: s.paths, dots: s.dots });
    } else {
      const sel = opt.expect || '#list .row';
      await p.waitForSelector(sel, { timeout: 60000 }).catch(() => problems.push('the page did not open (no "' + sel + '")'));
      await p.waitForTimeout(1500);
      info.found = await p.evaluate(s => document.querySelectorAll(s).length, sel);
    }
    info.fontsLoaded = await p.evaluate(() => document.fonts ? [...document.fonts].filter(f => f.status === 'loaded').length : -1);
    if (log.outside.length) problems.push('requests to other servers: ' + [...new Set(log.outside)].slice(0, 5).join(', '));
    if (log.errs.length) problems.push('page errors: ' + log.errs.slice(0, 3).join(' | '));
    const bad = log.console.filter(t => /integrity|digest|Content Security Policy|Refused to|Failed to load/i.test(t));
    if (bad.length) problems.push('blocked or failed loads: ' + bad.slice(0, 3).join(' | '));
    await ctx.close();

    // tamper test: an altered copy of a fingerprinted file must be refused
    const t = await b.newContext({ viewport: { width: 1200, height: 900 } });
    const altered = new Set();
    await t.route(/\/(lib\/[^/]+\.js|fonts\/fonts\.css)$/, async r => { altered.add(new URL(r.request().url()).pathname); const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()) + '\n/* altered */' }); });
    const T = await open(t, base);
    await T.p.fill('#code', code); await T.p.click('#go');
    await T.p.waitForTimeout(5000);
    const notRefused = [...altered].filter(f => !T.log.console.some(x => /integrity|digest/i.test(x) && x.includes(f)));
    info.tamperTest = altered.size ? 'altered ' + [...altered].join(', ') + (notRefused.length ? '; NOT refused: ' + notRefused.join(', ') : '; all refused') : 'no fingerprinted file requested';
    if (!altered.size || notRefused.length) problems.push('tamper test failed: ' + info.tamperTest);
    await t.close();
  } catch (e) { problems.push(e.message); }
  await b.close(); srv.close();
  console.log((problems.length ? 'FAIL ' : 'PASS ') + JSON.stringify(Object.assign(info, { problems })));
  process.exit(problems.length ? 1 : 0);
})();
