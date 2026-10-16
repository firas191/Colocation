# Map tiles for the website (platform P2, PLATFORM_SPEC 6.5)

One [PMTiles](https://docs.protomaps.com/pmtiles/) file per country, named after the country code in lower case
(`tn.pmtiles`, later `fr.pmtiles`, `gb.pmtiles`). The proxy serves this folder at `http://localhost:3000/tiles/`;
the search page's map reads the file of the search's country with range requests, so no tile server outside the
machine sees which area anyone looks at.

The files are cut from the Protomaps daily build of the OpenStreetMap basemap by `scripts/windows/map.ps1` on the
owner's PC (the cloud sandbox cannot reach build.protomaps.com). They are not committed (`.gitignore`): they are
large and can be made again.

Data © OpenStreetMap contributors, Open Database Licence (ODbL); basemap © Protomaps. The map shows this attribution.
