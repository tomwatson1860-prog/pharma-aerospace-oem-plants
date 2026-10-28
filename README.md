# Pharma & Aerospace OEM Plants

Website: https://tomwatson1860-prog.github.io/pharma-aerospace-oem-plants/

A map of pharmaceutical and aerospace manufacturing plants run by OEMs in the United States, Canada, Mexico, Germany, Poland and Italy, with each company's plants, products, recent investments and sources.

The site asks for an access code. The map and its data are stored in `index.html` in encrypted form (AES-GCM, with the key derived from the access code) and are decrypted in the visitor's browser, so this repository holds no readable copy of them. Ask the owner for the code.

This is a snapshot of the map as of its October 22, 2026 data. The map libraries (d3, topojson-client) and fonts load from public CDNs.

## Updating the site

The monthly update of the map rebuilds this site from the map's published `index.html` and `data.json`:

```
ACCESS_CODE=<code> node tools/build_site.js <map index.html> <map data.json> index.html
npm install --prefix <libs> d3@7.8.5 topojson-client@3.1.0
ACCESS_CODE=<code> NODE_PATH=$(npm root -g) node tools/check_site.js index.html <map data.json> <libs>
```

`build_site.js` bundles the data into the page, encrypts it with the code screen in `tools/gate.html`, checks its own output and updates the date above. `check_site.js` opens the result in a headless browser and only passes when a wrong code is refused and the right code shows the map with the plant and manufacturer counts from the data. The access code is never stored in this repository.
