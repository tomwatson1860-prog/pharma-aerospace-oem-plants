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
   - a deliberately altered copy of a fingerprinted file (lib/*.js, fonts/fonts.css) is refused by the browser;
   - if the site has a home-screen icon: the code screen and the unlocked page both carry it (180x180) and
     full-screen mode, and the app manifest loads through the page's security policy with all its icons.
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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const wantsIcon = /rel="apple-touch-icon"/.test(fs.readFileSync(sitePath, 'utf8'));
// home-screen icon and app mode, as a phone reads them from whatever page is showing
const homeScreen = p => p.evaluate(async () => {
  const q = s => document.querySelector(s), size = href => new Promise(res => { const im = new Image(); im.onload = () => res(im.naturalWidth + 'x' + im.naturalHeight); im.onerror = () => res('failed'); im.src = href; });
  const icon = q('link[rel="apple-touch-icon"]');
  return { icon: icon ? await size(icon.href) : 'missing', manifestLinked: !!q('link[rel="manifest"]'),
    appMode: (q('meta[name="apple-mobile-web-app-capable"]') || {}).content || 'missing', title: (q('meta[name="apple-mobile-web-app-title"]') || {}).content || 'missing' };
});
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
    const gateHome = wantsIcon ? await homeScreen(p) : null;
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
    if (wantsIcon) {
      // the same icon and app mode on the code screen and on the unlocked page; the manifest must load
      // through the page's Content Security Policy, and every icon it lists must load at its stated size
      const pageHome = await homeScreen(p);
      for (const [where, h] of [['code screen', gateHome], ['unlocked page', pageHome]]) {
        if (h.icon !== '180x180') problems.push(where + ': home-screen icon ' + h.icon);
        if (h.appMode !== 'yes') problems.push(where + ': full-screen (app) mode is ' + h.appMode);
        if (!h.manifestLinked) problems.push(where + ': no app manifest');
      }
      const cdp = await ctx.newCDPSession(p), am = await cdp.send('Page.getAppManifest');
      let man = null; try { man = JSON.parse(am.data || ''); } catch (e) {}
      if (!man) problems.push('the app manifest did not load' + (am.errors && am.errors.length ? ': ' + am.errors.map(e => e.message).join(' | ') : ''));
      else {
        const sizes = await p.evaluate(async list => Promise.all(list.map(ic => new Promise(res => { const im = new Image(); im.onload = () => res(ic.sizes === im.naturalWidth + 'x' + im.naturalHeight ? 'ok' : ic.src + ' is ' + im.naturalWidth + 'x' + im.naturalHeight); im.onerror = () => res(ic.src + ' failed'); im.src = new URL(ic.src, location.href).href; }))), man.icons || []);
        sizes.filter(s => s !== 'ok').forEach(s => problems.push('manifest icon ' + s));
        if (man.display !== 'standalone') problems.push('manifest display is ' + man.display);
      }
      info.homeScreen = { icon: pageHome.icon, title: pageHome.title, appMode: pageHome.appMode, manifest: man ? man.short_name + ', ' + (man.icons || []).length + ' icons, ' + man.display : 'not loaded' };
    }
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
