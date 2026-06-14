"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import { cityCoords } from "@/lib/geo";

export function TrackingMap({
  origin,
  destination,
}: {
  origin: { city: string };
  destination: { city: string };
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const from = cityCoords(origin.city);
    const to = cityCoords(destination.city);
    if (!ref.current || !from || !to) return;

    let cancelled = false;
    let map: import("leaflet").Map | undefined;

    void import("leaflet").then((mod) => {
      const L = mod.default;
      if (cancelled || !ref.current) return;
      const m = L.map(ref.current, { scrollWheelZoom: false });
      map = m;
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 18,
      }).addTo(m);
      const marker = (coords: [number, number], color: string, label: string) =>
        L.circleMarker(coords, { radius: 8, color, fillColor: color, fillOpacity: 0.9, weight: 2 })
          .addTo(m)
          .bindTooltip(label);
      marker(from, "#4f46e5", origin.city);
      marker(to, "#10b981", destination.city);
      L.polyline([from, to], { color: "#6366f1", weight: 3, dashArray: "6 6" }).addTo(m);
      m.fitBounds([from, to], { padding: [40, 40] });
    });

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [origin.city, destination.city]);

  return (
    <div ref={ref} className="h-72 w-full overflow-hidden rounded-xl border border-slate-200" />
  );
}
