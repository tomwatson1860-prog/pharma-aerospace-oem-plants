#!/usr/bin/env node
/*
 Rebuild the code-protected website from a published page.

   ACCESS_CODE=<code> node tools/build_site.js <page index.html> <data.json | -> [out=index.html]

 Safety rules it enforces (the build stops with an error if any fails):
   - Every outside script is replaced by a copy served from this site (lib/), pinned by version and
     fingerprinted (Subresource Integrity, sha384), so browsers refuse an altered copy. A script that is
     not listed in tools/libs.json stops the build. The lib/ files must still match their fingerprints.
   - Google Fonts are replaced by the self-hosted fonts in fonts/ (fonts.css is fingerprinted too).
   - Nothing else may load from another server: no outside stylesheets, images, frames, @import,
     url(http...) or fetch("http...").
   - The code screen (tools/gate.html) carries a Content Security Policy that only allows this site's
     own files and the page's inline code.
 Then it optionally bundles data.json into the page (a small fetch() shim answers its request for it),
 gzips and encrypts the page with AES-256-GCM (key from the access code via PBKDF2-SHA-256, 1,000,000
 iterations, fresh salt and IV), puts it into tools/gate.html, decrypts its own output to check it, and
 checks no readable company name is left. The access code is read from the environment only; never put it
 in a file in this repository. Uses only Node's built-in modules.
*/
const crypto = require('crypto'), fs = require('fs'), zlib = require('zlib'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const fail = m => { console.error('build_site: ' + m); process.exit(1); };
const [pagePath, dataArg = '-', outPath = 'index.html'] = process.argv.slice(2);
const code = process.env.ACCESS_CODE;
if (!pagePath) fail('usage: ACCESS_CODE=<code> node tools/build_site.js <index.html> <data.json | -> [out]');
if (!code) fail('ACCESS_CODE is not set');
const sri = b => 'sha384-' + crypto.createHash('sha384').update(b).digest('base64');
let page = fs.readFileSync(pagePath, 'utf8');
const libs = JSON.parse(fs.readFileSync(path.join(__dirname, 'libs.json'), 'utf8')).libs || [];

// local copies must still match their fingerprints
for (const l of libs) if (sri(fs.readFileSync(path.join(ROOT, l.local))) !== l.integrity) fail(l.local + ' does not match its fingerprint in tools/libs.json');

// Google Fonts -> self-hosted, fingerprinted fonts.css
const fontsCss = path.join(ROOT, 'fonts', 'fonts.css');
let fontsUsed = false;
page = page.replace(/<link\b[^>]*href="https:\/\/fonts\.(?:googleapis|gstatic)\.com[^"]*"[^>]*>\s*/gi, m => {
  if (!/rel="?stylesheet/i.test(m)) return '';
  if (!fs.existsSync(fontsCss)) fail('the page uses Google Fonts but fonts/fonts.css is missing');
  if (fontsUsed) return '';
  fontsUsed = true;
  return '<link rel="stylesheet" href="fonts/fonts.css" integrity="' + sri(fs.readFileSync(fontsCss)) + '">';
});

// outside scripts -> local fingerprinted copies
const libsUsed = [];
page = page.replace(/<script\b([^>]*?)\bsrc="(https?:\/\/[^"]+)"([^>]*)>/gi, (m, a, url, b) => {
  const l = libs.find(x => x.urls.includes(url));
  if (!l) fail('outside script without a known fingerprint: ' + url + ' (add a pinned, fingerprinted copy to lib/ and tools/libs.json)');
  libsUsed.push(l.name);
  const rest = (a + ' ' + b).replace(/\s(?:integrity|crossorigin|referrerpolicy)="[^"]*"/gi, '').replace(/\s+/g, ' ').trim();
  return '<script' + (rest ? ' ' + rest : '') + ' src="' + l.local + '" integrity="' + l.integrity + '">';
});

// nothing else may load from another server
const outside = [];
for (const m of page.matchAll(/<(script|link|iframe|frame|img|image|source|video|audio|embed|object|track|use)\b[^>]*?\b(?:src|href|data|xlink:href|srcset)="\s*(?:https?:)?\/\/[^"]*"[^>]*>/gi)) outside.push(m[0].slice(0, 140));
for (const m of page.matchAll(/@import[^;]*?(?:https?:)?\/\/[^;]*;|url\(\s*['"]?(?:https?:)?\/\/[^)]*\)|fetch\(\s*['"`](?:https?:)?\/\/[^'"`]*/gi)) outside.push(m[0].slice(0, 140));
if (outside.length) fail('the page still loads from other servers:\n  ' + outside.join('\n  '));

// optional data bundle
let data = null;
if (dataArg !== '-') {
  try { data = JSON.parse(fs.readFileSync(dataArg, 'utf8')); } catch (e) { fail('data.json does not parse: ' + e.message); }
  if (!Array.isArray(data.sites) || !Array.isArray(data.companies) || !data.sites.length || !data.companies.length) fail('data.json has no sites or companies');
  if ((page.match(/<head>/g) || []).length !== 1) fail('the page must contain exactly one <head> tag');
  if (!/fetch\(\s*["']data\.json["']/.test(page)) fail('the page no longer loads data.json with fetch("data.json"); the bundling shim would not apply');
  const js = JSON.stringify(data).replace(/<\//g, '<\\/');
  const shim = '<script>/* data.json is bundled into this page */const __PAO_DATA=' + js + ';(function(){const f=window.fetch.bind(window);' +
    'window.fetch=function(u,o){const s=String(u&&u.url?u.url:u).split("?")[0].replace(/^\\.\\//,"");' +
    'if(s==="data.json"||s.endsWith("/data.json"))return Promise.resolve(new Response(JSON.stringify(__PAO_DATA),{status:200,headers:{"Content-Type":"application/json"}}));return f(u,o);};})();</script>';
  page = page.replace('<head>', () => '<head>' + shim);
}

// encrypt
const gz = zlib.gzipSync(Buffer.from(page, 'utf8'), { level: 9 });
const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), iter = 1000000;
const c = crypto.createCipheriv('aes-256-gcm', crypto.pbkdf2Sync(code, salt, iter, 32, 'sha256'), iv);
const ct = Buffer.concat([c.update(gz), c.final(), c.getAuthTag()]);
const payload = JSON.stringify({ v: 1, iter, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') });

// code screen
const gate = fs.readFileSync(path.join(__dirname, 'gate.html'), 'utf8');
if (gate.split('/*PAYLOAD*/').length !== 2) fail('tools/gate.html must contain /*PAYLOAD*/ exactly once');
if (!/http-equiv="Content-Security-Policy"/i.test(gate)) fail('tools/gate.html has lost its Content Security Policy');
if (/(?:src|href)="\s*(?:https?:)?\/\//i.test(gate)) fail('tools/gate.html loads something from another server');
const out = gate.replace('/*PAYLOAD*/', () => payload);

// self-checks
const d = crypto.createDecipheriv('aes-256-gcm', crypto.pbkdf2Sync(code, salt, iter, 32, 'sha256'), iv);
d.setAuthTag(ct.subarray(ct.length - 16));
if (zlib.gunzipSync(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])).toString('utf8') !== page) fail('self-check failed: decrypting the output does not give back the page');
if (data) for (const co of data.companies) if (co.name && co.name.length >= 6 && out.includes(co.name)) fail('readable data found in the output (' + co.name + ')');
const title = (page.match(/<title>([^<]*)<\/title>/) || [])[1];
if (title && title.length >= 12 && out.split(title).length > 3) fail('the page title appears more often than expected in the output; check that the page is encrypted');

fs.writeFileSync(outPath, out);

// README date (pages built from dated data)
const readme = path.join(path.dirname(path.resolve(outPath)), 'README.md');
const dt = data && new Date((data.updated || '') + 'T12:00:00Z');
if (dt && !isNaN(dt) && fs.existsSync(readme)) {
  const nice = dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const r = fs.readFileSync(readme, 'utf8'), r2 = r.replace(/snapshot of the map as of its .*? data\./, 'snapshot of the map as of its ' + nice + ' data.');
  if (r2 !== r) fs.writeFileSync(readme, r2);
}
const res = { ok: true, out: outPath, bytes: out.length, fingerprintedLibs: libsUsed, selfHostedFonts: fontsUsed, outsideLoads: 0 };
if (data) { const per = {}; for (const s of data.sites) per[s.cc] = (per[s.cc] || 0) + 1; Object.assign(res, { updated: data.updated, companies: data.companies.length, plants: data.sites.length, perCountry: per }); }
console.log(JSON.stringify(res));
