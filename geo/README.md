# Gazetteer (DECISIONS D-058)

- `places.csv`: the places people name when they look for a room in TN, FR and GB (271 rows:
  cities, neighbourhoods, campuses, stations, landmarks), with every name people write for them
  (`fr:`, `en:`, `ar:`, `aeb-Latn:` for Tunisian in Latin letters...) and the query sent to Nominatim.
  Written without looking at the evaluation sets.
- `places_osm.csv`: what OpenStreetMap Nominatim returned for each query (coordinates, OSM type and
  id, display name, date). Written by `scripts/p3.py geo-fetch` on the owner's PC (the cloud sandbox
  cannot reach Nominatim), one request per 1.2 s with an identifying User-Agent, and committed so it
  is fetched once (Nominatim usage policy: cache results, no bulk or repeated queries).
- `scripts/p3.py geo-load` loads them into `app.places` and `app.place_names`, skipping a place more
  than 40 km from its city's point (a wrong match); `geo-coverage` reports how many anchors of the P2
  golden set are resolved.

Data © OpenStreetMap contributors, available under the Open Database Licence (ODbL). Any page that
shows places or maps from this data must show that attribution (`data_attribution: ["openstreetmap"]`
in API answers).
