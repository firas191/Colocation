# Map assets served by the website (platform P2)

- `fonts/`: glyph files (Noto Sans Regular, Medium, Italic; Latin, Greek and Arabic ranges) from
  https://github.com/protomaps/basemaps-assets, fetched 2026-10-16. SIL Open Font License, `fonts/OFL.txt`.
- `sprites/v4/`: the light map icons from the same repository, fetched 2026-10-16. The basemaps-assets README says
  the sprites are derived from the MIT-licensed tangrams/icons; that licence is `sprites/tangrams-icons-LICENSE.md`.
- `maplibre-gl-worker.mjs` (not committed): copied from `node_modules/maplibre-gl` before each build
  (`scripts/copy-map-assets.mjs`), so it always matches the installed MapLibre.

The map data itself (`/tiles/<country>.pmtiles`) is served by the proxy from `geo/tiles` (see `geo/tiles/README.md`).
