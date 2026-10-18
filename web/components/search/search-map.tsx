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
import { currentTheme } from "@/components/theme-toggle";
import "maplibre-gl/dist/maplibre-gl.css";

export interface MapPoint { id: string; title: string; lat: number; lng: number; photo?: string | null; price?: string | null; per?: string | null;
  place?: string | null; kind?: string | null }

/** The small card a pin opens (D-119): built with DOM calls and textContent only, no HTML strings (safety test). */
function pinCard(p: MapPoint, href: string, open: string): HTMLElement {
  const el = (tag: string, cls: string, text?: string | null) => {
    const e = document.createElement(tag);
    e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const box = el("div", "pin-card");
  if (p.photo) {
    const img = document.createElement("img");
    img.src = p.photo; img.alt = ""; img.loading = "lazy"; img.className = "pin-card-photo";
    img.addEventListener("error", () => img.remove());
    box.append(img);
  }
  const body = el("div", "pin-card-body");
  if (p.kind) body.append(el("p", "pin-card-kind", p.kind));
  body.append(el("p", "pin-card-title", p.title));
  if (p.price) {
    const price = el("p", "pin-card-price", p.price);
    if (p.per) price.append(" ", el("span", "pin-card-per", p.per));
    body.append(price);
  }
  if (p.place) body.append(el("p", "pin-card-place", p.place));
  const a = el("a", "btn btn-primary pin-card-open", open) as HTMLAnchorElement;
  a.href = href;
  body.append(a);
  box.append(body);
  return box;
}

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

export function SearchMap({ locale, country, points, bbox, center, baseHref, className }:
  { locale: string; country: string; points: MapPoint[]; bbox: string; center: { lat: number; lng: number } | null; baseHref: string;
    className?: string }) {
  const t = useTranslations("search");
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<import("maplibre-gl").Map | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const tiles = `/tiles/${country.toLowerCase()}.pmtiles`;

  useEffect(() => {
    let gone = false;
    let onTheme: ((e: Event) => void) | null = null;
    (async () => {
      const head = await fetch(tiles, { method: "HEAD" }).catch(() => null);
      if (gone) return;
      if (!head || !head.ok) { setState("missing"); return; }
      const maplibre = await load();
      const { layers, namedFlavor } = await import("@protomaps/basemaps");
      if (gone || !box.current) return;
      const origin = window.location.origin;
      // the basemap follows the page's theme (D-116); the icons are the light set in both
      const style = (theme: "light" | "dark") => ({
        version: 8 as const,
        glyphs: `${origin}/map/fonts/{fontstack}/{range}.pbf`,
        sprite: `${origin}/map/sprites/v4/light`,
        sources: { protomaps: { type: "vector" as const, url: `pmtiles://${origin}${tiles}`,
          attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>' } },
        layers: layers("protomaps", namedFlavor(theme), { lang: locale }),
      });
      const m = new maplibre.Map({
        container: box.current,
        style: style(currentTheme()),
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
      // Each pin is still a link to the listing. Pointing at it (or focusing it with the keyboard) opens a small card
      // with the photo, price and place and a "View listing" button; on a touch screen the first tap opens the card.
      let openPopup: import("maplibre-gl").Popup | null = null;
      let hideTimer: ReturnType<typeof setTimeout> | null = null;
      const keep = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
      const hideSoon = () => { keep(); hideTimer = setTimeout(() => { openPopup?.remove(); openPopup = null; }, 220); };
      // a finger lifting also counts as "leaving": only a mouse or a pen closes the card that way
      const leave = (e: PointerEvent) => { if (e.pointerType !== "touch") hideSoon(); };
      // a click on the map closes the card, but not the click (or tap) on a pin that just opened it
      m.on("click", (e) => {
        if ((e.originalEvent.target as Element | null)?.closest?.(".map-pin, .pin-popup")) return;
        keep(); openPopup?.remove(); openPopup = null;
      });
      for (const p of points) {
        const href = `/${locale}/listings/${p.id}`;
        const a = document.createElement("a");
        a.href = href;
        a.className = "map-pin";
        a.setAttribute("aria-label", p.title || p.id);
        a.dataset.listing = p.id;
        const popup = new maplibre.Popup({ offset: [0, -30], closeButton: false, closeOnClick: false, maxWidth: "260px",
          className: "pin-popup", focusAfterOpen: false }).setDOMContent(pinCard(p, href, t("mapOpen")));
        const show = () => {
          keep();
          if (openPopup === popup) return;
          openPopup?.remove();
          popup.setLngLat([p.lng, p.lat]).addTo(m);
          openPopup = popup;
          const el = popup.getElement();
          el.addEventListener("pointerenter", keep);
          el.addEventListener("pointerleave", leave);
          el.addEventListener("focusout", (e) => { if (!el.contains((e as FocusEvent).relatedTarget as Node)) hideSoon(); });
        };
        let touch = false;
        a.addEventListener("pointerdown", (e) => { touch = e.pointerType === "touch"; });
        a.addEventListener("click", (e) => { if (touch && openPopup !== popup) { e.preventDefault(); show(); } });
        a.addEventListener("pointerenter", (e) => { if (e.pointerType !== "touch") show(); });
        a.addEventListener("pointerleave", leave);
        a.addEventListener("focus", show);
        a.addEventListener("blur", () => { if (!touch) hideSoon(); });
        new maplibre.Marker({ element: a, anchor: "bottom" }).setLngLat([p.lng, p.lat]).addTo(m);
      }
      m.once("load", () => { if (gone) return; place(); setState("ready"); });
      onTheme = (e: Event) => m.setStyle(style((e as CustomEvent).detail === "dark" ? "dark" : "light"));
      window.addEventListener("themechange", onTheme);
    })();
    // a listing card under the pointer or the keyboard lights up its pin
    const light = (e: Event) => {
      const id = (e.target as Element | null)?.closest?.("article[data-listing]")?.getAttribute("data-listing");
      document.querySelectorAll<HTMLElement>(".map-pin").forEach((pin) => { pin.dataset.active = String(!!id && pin.dataset.listing === id); });
    };
    document.addEventListener("pointerover", light);
    document.addEventListener("focusin", light);
    return () => {
      gone = true; map.current?.remove(); map.current = null;
      document.removeEventListener("pointerover", light); document.removeEventListener("focusin", light);
      if (onTheme) window.removeEventListener("themechange", onTheme);
    };
  }, [tiles, locale, country, bbox, center, points]);

  if (state === "missing") return (
    <div className={`flex flex-col justify-end gap-3 overflow-hidden rounded-[var(--radius-photo)] border border-line bg-raised p-4 ${className ? "min-h-80" : ""} ${className || ""}`}
      style={{ backgroundImage: "linear-gradient(var(--color-line) 1px, transparent 1px), linear-gradient(90deg, var(--color-line) 1px, transparent 1px)", backgroundSize: "28px 28px" }}>
      <Notice>{t("mapMissing")}</Notice>
    </div>
  );
  const searchArea = () => {
    const m = map.current;
    if (!m) return;
    const b = m.getBounds();
    const r = (x: number) => x.toFixed(5);
    router.push(`${baseHref}&bbox=${[r(b.getWest()), r(b.getSouth()), r(b.getEast()), r(b.getNorth())].join(",")}`);
  };
  return (
    <div className={`relative flex flex-col gap-3 ${className || ""}`}>
      <div ref={box} role="region" aria-label={t("mapLabel")} data-state={state}
        className={`w-full flex-1 overflow-hidden rounded-[var(--radius-photo)] border border-line bg-raised ${className ? "min-h-80" : "h-[min(60vh,32rem)]"}`} />
      {state === "loading" && <div aria-hidden="true" className="skeleton absolute inset-0 rounded-[var(--radius-photo)]" />}
      <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
        <Button type="button" variant="secondary" onClick={searchArea} disabled={state !== "ready"} className="pointer-events-auto rounded-full shadow-[var(--shadow-lift)]">
          {t("searchArea")}
        </Button>
      </div>
      <p className="text-sm text-ink-soft">{t("mapHint")}</p>
    </div>
  );
}
