#!/usr/bin/env node
/*
 Browser check of the code-protected website before it is pushed.

   ACCESS_CODE=<code> NODE_PATH=$(npm root -g) node tools/check_site.js <built index.html> <data.json> <libs dir>

 <libs dir> must hold node_modules/d3 (7.8.5) and node_modules/topojson-client (3.1.0), for example from
   npm install --prefix <libs dir> d3@7.8.5 topojson-client@3.1.0
 so the check works without reaching the CDNs. Needs Playwright with Chromium.
 Passes when a wrong code is refused, the right code opens the map, the header shows the plant and
 manufacturer counts from data.json, the map is drawn, and the page raises no errors. Prints PASS or FAIL.
*/
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const [sitePath, dataPath, libs] = process.argv.slice(2);
const code = process.env.ACCESS_CODE;
if (!sitePath || !dataPath || !libs || !code) { console.error('usage: ACCESS_CODE=<code> node tools/check_site.js <index.html> <data.json> <libs dir>'); process.exit(2); }
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const lib = p => fs.readFileSync(path.join(libs, 'node_modules', p));
(async () => {
  const b = await chromium.launch(); const problems = [];
  try {
    const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } });
    await ctx.route('**/cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js', r => r.fulfill({ contentType: 'application/javascript', body: lib('d3/dist/d3.min.js') }));
    await ctx.route('**/cdn.jsdelivr.net/npm/topojson-client@3.1.0/dist/topojson-client.min.js', r => r.fulfill({ contentType: 'application/javascript', body: lib('topojson-client/dist/topojson-client.min.js') }));
    await ctx.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await ctx.route('**/fonts.gstatic.com/**', r => r.abort());
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('file://' + path.resolve(sitePath));
    await p.fill('#code', code === '0000' ? '9999' : '0000'); await p.click('#go');
    await p.waitForFunction(() => /not right/.test((document.getElementById('err') || {}).textContent || ''), null, { timeout: 30000 }).catch(() => problems.push('a wrong code was not refused'));
    await p.fill('#code', code); await p.click('#go');
    const want = data.sites.length.toLocaleString('en-US') + ' plants';
    await p.waitForFunction(w => document.body && document.body.innerText.includes(w), want, { timeout: 60000 }).catch(() => problems.push('the map did not open or does not show "' + want + '"'));
    await p.waitForTimeout(1500);
    const s = await p.evaluate(() => ({ text: document.body.innerText, paths: document.querySelectorAll('svg path').length, dots: document.querySelectorAll('svg circle').length }));
    const makers = new Set(data.sites.map(x => x.c)).size;
    if (!s.text.includes(makers.toLocaleString('en-US') + ' manufacturers')) problems.push('header does not show ' + makers + ' manufacturers');
    if (s.paths < 10 || s.dots < 10) problems.push('map not drawn (' + s.paths + ' outlines, ' + s.dots + ' dots)');
    if (errs.length) problems.push('page errors: ' + errs.slice(0, 3).join(' | '));
    console.log((problems.length ? 'FAIL ' : 'PASS ') + JSON.stringify({ plants: data.sites.length, manufacturers: new Set(data.sites.map(x => x.c)).size, outlines: s.paths, dots: s.dots, problems }));
  } catch (e) { console.log('FAIL ' + e.message); problems.push(e.message); }
  await b.close(); process.exit(problems.length ? 1 : 0);
})();
