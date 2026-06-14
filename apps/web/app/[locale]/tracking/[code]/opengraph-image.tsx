import { getTranslations } from "next-intl/server";
import { ImageResponse } from "next/og";
import { fetchTracking } from "@/lib/api";

export const alt = "Shipping Hub — shipment tracking";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const TONE_COLOR: Record<string, string> = {
  DELIVERED: "#10b981",
  CANCELLED: "#f43f5e",
  RETURNED_TO_SENDER: "#f43f5e",
  EXCEPTION: "#f59e0b",
};

export default async function Image({
  params,
}: {
  params: Promise<{ locale: string; code: string }>;
}) {
  const { locale, code } = await params;
  let data = null;
  try {
    data = await fetchTracking(code);
  } catch {
    data = null;
  }
  const t = await getTranslations({ locale, namespace: "Status" });
  const statusLabel = data ? t(data.status) : "Shipping Hub";
  const accent = data ? (TONE_COLOR[data.status] ?? "#a5b4fc") : "#a5b4fc";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px",
          background: "linear-gradient(135deg, #312e81 0%, #4f46e5 100%)",
          color: "white",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "64px",
              height: "64px",
              borderRadius: "16px",
              background: "rgba(255,255,255,0.15)",
              fontSize: "36px",
            }}
          >
            📦
          </div>
          <div style={{ fontSize: "34px", fontWeight: 700 }}>Shipping Hub</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={{ fontSize: "30px", color: "#c7d2fe" }}>
            {data ? code : "International parcel tracking"}
          </div>
          <div style={{ fontSize: "76px", fontWeight: 800, letterSpacing: "-2px" }}>
            {data ? statusLabel : "Track any package"}
          </div>
          {data && (
            <div style={{ display: "flex", alignItems: "center", gap: "16px", fontSize: "30px" }}>
              <span
                style={{
                  display: "flex",
                  width: "18px",
                  height: "18px",
                  borderRadius: "9999px",
                  background: accent,
                }}
              />
              <span style={{ color: "#e0e7ff" }}>
                {data.origin.city}, {data.origin.country} → {data.destination.city},{" "}
                {data.destination.country}
              </span>
            </div>
          )}
        </div>

        <div style={{ display: "flex", fontSize: "26px", color: "#c7d2fe" }}>
          Panama · United States · Latin America
        </div>
      </div>
    ),
    { ...size },
  );
}
