// Copies MapLibre's worker next to the website's other map files (public/map), so the map loads it from the
// website's own origin (CSP: scripts and workers from 'self' only). Runs before every build and dev start.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const dist = path.dirname(require.resolve("maplibre-gl/package.json"));
const out = path.join(process.cwd(), "public", "map");
mkdirSync(out, { recursive: true });
copyFileSync(path.join(dist, "dist", "maplibre-gl-worker.mjs"), path.join(out, "maplibre-gl-worker.mjs"));
console.log("copied maplibre-gl-worker.mjs to public/map");
