#!/usr/bin/env node
/*
 Rebuild the code-protected website from the map's published files.

   ACCESS_CODE=<code> node tools/build_site.js <map index.html> <map data.json> [out=index.html]

 1. Bundles data.json into the page (a small fetch() shim answers the page's request for data.json).
 2. Gzips the page and encrypts it with AES-256-GCM; the key comes from the access code via
    PBKDF2-SHA-256 (1,000,000 iterations) with a fresh random salt and IV.
 3. Puts the encrypted payload into tools/gate.html, which asks visitors for the code and decrypts in the browser.
 4. Decrypts its own output and checks it matches, and checks no readable company name is left in it.
 5. Updates the data date in README.md.
 The access code is read from the environment only; never put it in a file in this repository.
 Uses only Node's built-in modules.
*/
const crypto = require('crypto'), fs = require('fs'), zlib = require('zlib'), path = require('path');
const fail = m => { console.error('build_site: ' + m); process.exit(1); };
const [pagePath, dataPath, outPath = 'index.html'] = process.argv.slice(2);
const code = process.env.ACCESS_CODE;
if (!pagePath || !dataPath) fail('usage: ACCESS_CODE=<code> node tools/build_site.js <index.html> <data.json> [out]');
if (!code) fail('ACCESS_CODE is not set');

const page = fs.readFileSync(pagePath, 'utf8');
let data;
try { data = JSON.parse(fs.readFileSync(dataPath, 'utf8')); } catch (e) { fail('data.json does not parse: ' + e.message); }
if (!Array.isArray(data.sites) || !Array.isArray(data.companies) || !data.sites.length || !data.companies.length) fail('data.json has no sites or companies');
if ((page.match(/<head>/g) || []).length !== 1) fail('the page must contain exactly one <head> tag');
if (!/fetch\(\s*["']data\.json["']/.test(page)) fail('the page no longer loads data.json with fetch("data.json"); the bundling shim would not apply');

// 1. bundle the data
const js = JSON.stringify(data).replace(/<\//g, '<\\/');
const shim = '<script>/* data.json is bundled into this page */const __PAO_DATA=' + js + ';(function(){const f=window.fetch.bind(window);' +
  'window.fetch=function(u,o){const s=String(u&&u.url?u.url:u).split("?")[0].replace(/^\\.\\//,"");' +
  'if(s==="data.json"||s.endsWith("/data.json"))return Promise.resolve(new Response(JSON.stringify(__PAO_DATA),{status:200,headers:{"Content-Type":"application/json"}}));return f(u,o);};})();</script>';
const bundled = page.replace('<head>', () => '<head>' + shim);

// 2. encrypt
const gz = zlib.gzipSync(Buffer.from(bundled, 'utf8'), { level: 9 });
const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), iter = 1000000;
const key = crypto.pbkdf2Sync(code, salt, iter, 32, 'sha256');
const c = crypto.createCipheriv('aes-256-gcm', key, iv);
const ct = Buffer.concat([c.update(gz), c.final(), c.getAuthTag()]);
const payload = JSON.stringify({ v: 1, iter, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') });

// 3. fill the code screen
const gate = fs.readFileSync(path.join(__dirname, 'gate.html'), 'utf8');
if (gate.split('/*PAYLOAD*/').length !== 2) fail('tools/gate.html must contain /*PAYLOAD*/ exactly once');
const out = gate.replace('/*PAYLOAD*/', () => payload);

// 4. self-checks
const d = crypto.createDecipheriv('aes-256-gcm', crypto.pbkdf2Sync(code, salt, iter, 32, 'sha256'), iv);
d.setAuthTag(ct.subarray(ct.length - 16));
const back = zlib.gunzipSync(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])).toString('utf8');
if (back !== bundled) fail('self-check failed: decrypting the output does not give back the page');
for (const co of data.companies) if (co.name && co.name.length >= 6 && out.includes(co.name)) fail('readable data found in the output (' + co.name + ')');

fs.writeFileSync(outPath, out);

// 5. README date
const readme = path.join(path.dirname(path.resolve(outPath)), 'README.md');
const dt = new Date((data.updated || '') + 'T12:00:00Z');
if (fs.existsSync(readme) && !isNaN(dt)) {
  const nice = dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const r = fs.readFileSync(readme, 'utf8'), r2 = r.replace(/snapshot of the map as of its .*? data\./, 'snapshot of the map as of its ' + nice + ' data.');
  if (r2 !== r) fs.writeFileSync(readme, r2);
}
const per = {}; for (const s of data.sites) per[s.cc] = (per[s.cc] || 0) + 1;
console.log(JSON.stringify({ ok: true, out: outPath, bytes: out.length, updated: data.updated, companies: data.companies.length, plants: data.sites.length, perCountry: per }));
