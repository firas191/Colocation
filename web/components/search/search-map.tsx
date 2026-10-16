"use client";
// The map of the search (platform P2, PLATFORM_SPEC 6.5). MapLibre draws the OpenStreetMap basemap from one PMTiles
// file per country served by our own proxy (/tiles/<country>.pmtiles), with fonts and icons served by the website:
// no outside tile server sees which area anyone looks at. Markers are the listings' public points, which the
// database moved away from the address (the exact point never reaches the website). "Search this area" puts the
// visible area into the page's address (bbox), and the server searches again.
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/field";
import "maplibre-gl/dist/maplibre-gl.css";

export interface MapPoint { id: string; title: string; lat: number; lng: number }

// Rough view of each country when there is nothing else to fit (centre, zoom).
const COUNTRY_VIEW: Record<string, [number, number, number]> = { TN: [9.6, 34.2, 5.6], FR: [2.4, 46.6, 4.8], GB: [-2.5, 54.0, 4.8] };
let setup: Promise<typeof import("maplibre-gl")> | null = null;

async function load() {
  if (!setup) {
    setup = (async () => {
      const maplibre = await import("maplibre-gl");
      const { Protocol } = await import("pmtiles");
      maplibre.setWorkerUrl(`${window.location.origin}/map/maplibre-gl-worker.mjs`);
      maplibre.addProtocol("pmtiles", new Protocol().tile);
      return maplibre;
    })();
  }
  return setup;
}

export function SearchMap({ locale, country, points, bbox, center, baseHref }:
  { locale: string; country: string; points: MapPoint[]; bbox: string; center: { lat: number; lng: number } | null; baseHref: string }) {
  const t = useTranslations("search");
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<import("maplibre-gl").Map | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const tiles = `/tiles/${country.toLowerCase()}.pmtiles`;

  useEffect(() => {
    let gone = false;
    (async () => {
      const head = await fetch(tiles, { method: "HEAD" }).catch(() => null);
      if (gone) return;
      if (!head || !head.ok) { setState("missing"); return; }
      const maplibre = await load();
      const { layers, namedFlavor } = await import("@protomaps/basemaps");
      if (gone || !box.current) return;
      const origin = window.location.origin;
      const m = new maplibre.Map({
        container: box.current,
        style: {
          version: 8,
          glyphs: `${origin}/map/fonts/{fontstack}/{range}.pbf`,
          sprite: `${origin}/map/sprites/v4/light`,
          sources: { protomaps: { type: "vector", url: `pmtiles://${origin}${tiles}`,
            attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>' } },
          layers: layers("protomaps", namedFlavor("light"), { lang: locale }),
        },
        center: COUNTRY_VIEW[country] ? [COUNTRY_VIEW[country][0], COUNTRY_VIEW[country][1]] : [center?.lng ?? 10, center?.lat ?? 36],
        zoom: COUNTRY_VIEW[country]?.[2] ?? 6,
        attributionControl: { compact: false },
        cooperativeGestures: true,
      });
      map.current = m;
      m.addControl(new maplibre.NavigationControl({ showCompass: false }), locale === "ar" ? "top-left" : "top-right");
      // Place the view once the map has its final size (F-075: on desktop the first fit ran against a container that
      // was not laid out yet and silently kept the whole-country view). One point: centre on it; several: fit them.
      const place = () => {
        m.resize();
        const b = bbox.split(",").map(Number);
        if (b.length === 4 && b.every(Number.isFinite)) { m.fitBounds([[b[0], b[1]], [b[2], b[3]]], { animate: false }); return; }
        if (points.length === 1) { m.jumpTo({ center: [points[0].lng, points[0].lat], zoom: 14 }); return; }
        if (points.length > 1) {
          const lngs = points.map((p) => p.lng), lats = points.map((p) => p.lat);
          const c = m.getContainer();
          const pad = Math.max(0, Math.min(48, c.clientWidth / 4, c.clientHeight / 4));
          m.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: pad, maxZoom: 14, animate: false });
          return;
        }
        if (center) m.jumpTo({ center: [center.lng, center.lat], zoom: 12 });
      };
      for (const p of points) {
        const a = document.createElement("a");
        a.href = `/${locale}/listings/${p.id}`;
        a.className = "map-pin";
        a.setAttribute("aria-label", p.title || p.id);
        a.dataset.listing = p.id;
        new maplibre.Marker({ element: a, anchor: "bottom" }).setLngLat([p.lng, p.lat]).addTo(m);
      }
      m.once("load", () => { if (gone) return; place(); setState("ready"); });
    })();
    return () => { gone = true; map.current?.remove(); map.current = null; };
  }, [tiles, locale, country, bbox, center, points]);

  if (state === "missing") return <Notice>{t("mapMissing")}</Notice>;
  const searchArea = () => {
    const m = map.current;
    if (!m) return;
    const b = m.getBounds();
    const r = (x: number) => x.toFixed(5);
    router.push(`${baseHref}&bbox=${[r(b.getWest()), r(b.getSouth()), r(b.getEast()), r(b.getNorth())].join(",")}`);
  };
  return (
    <div className="flex flex-col gap-3">
      <div ref={box} role="region" aria-label={t("mapLabel")} data-state={state}
        className="h-[min(60vh,32rem)] w-full overflow-hidden rounded-field border border-line bg-plaster" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{t("mapHint")}</p>
        <Button type="button" variant="secondary" onClick={searchArea} disabled={state !== "ready"}>{t("searchArea")}</Button>
      </div>
    </div>
  );
}
