"use client";
// A listing photo from a signed URL. If it cannot be loaded (expired link, object missing), the reader sees the
// "no photo" panel instead of a broken image.
import { useState, type ImgHTMLAttributes } from "react";

export function Photo({ fallback, ...p }: ImgHTMLAttributes<HTMLImageElement> & { fallback: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <div className={`grid place-items-center bg-raised text-sm text-ink-soft ${p.className || ""}`}>{fallback}</div>;
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  return <img {...p} onError={() => setBroken(true)} />;
}
