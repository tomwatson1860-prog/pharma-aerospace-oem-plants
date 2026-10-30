# Pharma & Aerospace OEM Plants

Website: https://tomwatson1860-prog.github.io/pharma-aerospace-oem-plants/

A map of pharmaceutical and aerospace manufacturing plants run by OEMs in the United States, Canada, Mexico, Germany, Poland and Italy, with each company's plants, products, recent investments and sources.

The site asks for an access code. The map and its data are stored in `index.html` in encrypted form (AES-GCM, with the key derived from the access code) and are decrypted in the visitor's browser, so this repository holds no readable copy of them. Ask the owner for the code.

This is a snapshot of the map as of its October 22, 2026 data.

## On a phone

In Safari on an iPhone, tap Share, then Add to Home Screen. The site gets its own app icon (`icons/`) and opens full-screen like an app (`manifest.webmanifest`, and the tags in `tools/head.html`, which the build adds to both the code screen and the unlocked map). The access code is asked again each time the app starts fresh.

## Updating the site

The monthly update of the map rebuilds this site from the map's published `index.html` and `data.json`:

```
ACCESS_CODE=<code> node tools/build_site.js <map index.html> <map data.json> index.html
ACCESS_CODE=<code> NODE_PATH=$(npm root -g) node tools/check_site.js index.html <map data.json>
```

`build_site.js` applies the safety rules below, bundles the data into the page, encrypts it with the code screen in `tools/gate.html`, checks its own output and updates the date above. `check_site.js` opens the result in a headless browser and only passes when a wrong code is refused, the right code shows the map with the plant and manufacturer counts from the data, nothing loads from other servers, and altered copies of the fingerprinted files are refused. The access code is never stored in this repository.

## Safety

- Everything the page needs is served from this site. The map libraries (d3 7.8.5 and topojson-client 3.1.0) are in `lib/`, with their licences. The fonts are in `fonts/`. Each of these files is fingerprinted (Subresource Integrity, SHA-384), so a browser refuses any copy that has been altered.
- The code screen sets a Content Security Policy that blocks loading anything from other servers, and sends no referrer when visitors follow a link out.
- No cookies, analytics or forms that send data; the access code is checked in the visitor's browser and never leaves it.
- The home-screen icon and app manifest are files on this site too; the build stops if they point anywhere else, and the security policy only lets the manifest load from this site.
- `tools/build_site.js` stops if the page tries to load a script that isn't pinned and fingerprinted in `tools/libs.json`, or anything else from another server. `tools/check_site.js` only passes when the browser makes no outside requests and refuses deliberately altered copies of the fingerprinted files.
