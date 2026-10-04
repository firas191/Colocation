# External data sources and their terms

Terms read on the date shown; check again before a public launch (D-004: none planned).

| Data | Source | Used for | Terms (read 2026-10-02) | What the project does |
|---|---|---|---|---|
| Exchange rates | ECB euro foreign exchange reference rates, daily XML `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml` | budget conversion between currencies (D-057) | `https://www.ecb.europa.eu/services/disclaimer/html/index.en.html`: free use, the ECB must be cited as source, modifications must be stated; reference rates are for information purposes only | every row in `app.fx_rates` names the ECB; cross rates are labelled `cross_eur` in API answers; no TND rate (not published by the ECB) |
| Place coordinates | OpenStreetMap through the public Nominatim API, once per place, cached in `geo/places_osm.csv` | gazetteer for anchors and search areas (D-058) | `https://operations.osmfoundation.org/policies/nominatim/`: max 1 request/s, identifying User-Agent, cache results, attribution, no autocomplete or systematic queries; data under ODbL | 271 queries at 1 per 1.2 s, once; answers carry `data_attribution: ["openstreetmap"]`; user text is never sent to Nominatim |
| Legal texts and guides (TN) | sources listed in `kb/packs/TN/sources.csv` | knowledge base (phase 2) | per source, robots.txt honoured (D-033) | see `kb/packs/TN/notes.md` |
| Language models | Ollama library: qwen3.5:4b, granite4.2:3b, phi4-mini:3.8b, bge-m3 | P1, P2, embeddings | model licences: Apache 2.0 (Qwen3.5 card, Granite 4.2 page); phi4-mini and bge-m3 licences not re-read in phase 3 | local inference only (D-002) |
| Tunisian dinar rates | Central Bank of Tunisia (bct.gov.tn) | not used | not read: the page could not be fetched on 2026-10-02 (robots.txt not readable, then HTTP 503) | a TND source needs its terms read first |
