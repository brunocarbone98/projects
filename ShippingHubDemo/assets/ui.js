// Shared UI helpers: formatting, status badges, the header/footer chrome, the
// tracking timeline, and the Leaflet route map. Views build HTML strings and
// call these; event wiring happens in each view's hydrate step.

import { coordsFor } from "./seed.js";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

export function formatMoney(cents, locale) {
  return new Intl.NumberFormat(locale === "es" ? "es-PA" : "en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function formatDate(iso, locale, withTime = false) {
  const opts = withTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" };
  return new Intl.DateTimeFormat(locale === "es" ? "es-PA" : "en-US", opts).format(new Date(iso));
}

const STATUS_CLASSES = {
  CREATED: "bg-slate-100 text-slate-700",
  LABEL_PAID: "bg-brand-100 text-brand-700",
  PICKED_UP: "bg-sky-100 text-sky-700",
  IN_TRANSIT: "bg-accent-400/20 text-accent-600",
  AT_DESTINATION_HUB: "bg-violet-100 text-violet-700",
  OUT_FOR_DELIVERY: "bg-cyan-100 text-cyan-700",
  DELIVERED: "bg-emerald-100 text-emerald-700",
  EXCEPTION: "bg-red-100 text-red-700",
  RETURNED_TO_SENDER: "bg-orange-100 text-orange-700",
  CANCELLED: "bg-slate-200 text-slate-500",
};

const STATUS_DOT = {
  CREATED: "bg-slate-400", LABEL_PAID: "bg-brand-500", PICKED_UP: "bg-sky-500",
  IN_TRANSIT: "bg-accent-500", AT_DESTINATION_HUB: "bg-violet-500", OUT_FOR_DELIVERY: "bg-cyan-500",
  DELIVERED: "bg-emerald-500", EXCEPTION: "bg-red-500", RETURNED_TO_SENDER: "bg-orange-500",
  CANCELLED: "bg-slate-400",
};

export function statusBadge(status, t) {
  const cls = STATUS_CLASSES[status] ?? "bg-slate-100 text-slate-700";
  return `<span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}">${escapeHtml(t(`Status.${status}`))}</span>`;
}

/** Newest-first vertical timeline of tracking events. Events are stored in
 * append (chronological) order, so reversing is correct even when two events
 * share a timestamp — the later-recorded one stays "latest". */
export function renderTimeline(events, t, locale) {
  const ordered = [...events].reverse();
  return `<ol class="relative space-y-5 border-l border-slate-200 pl-6">
    ${ordered
      .map((event, index) => {
        const dot = STATUS_DOT[event.status] ?? "bg-slate-400";
        const ring = index === 0 ? "ring-4 ring-brand-100" : "";
        return `<li class="relative">
          <span class="absolute -left-[31px] top-1 h-3.5 w-3.5 rounded-full ${dot} ${ring}"></span>
          <div class="flex flex-wrap items-center gap-2">
            <p class="font-semibold text-slate-800">${escapeHtml(t(`Status.${event.status}`))}</p>
            ${index === 0 ? `<span class="text-xs font-medium text-brand-600">${escapeHtml(t("Tracking.result.latest"))}</span>` : ""}
          </div>
          ${event.description ? `<p class="text-sm text-slate-600">${escapeHtml(event.description)}</p>` : ""}
          <p class="mt-0.5 text-xs text-slate-400">${escapeHtml(event.location)}${event.location ? " · " : ""}${escapeHtml(formatDate(event.occurredAt, locale, true))}</p>
        </li>`;
      })
      .join("")}
  </ol>`;
}

/** Mount a Leaflet route map (origin → destination) into `container`. */
export function mountRouteMap(container, originAddress, destinationAddress) {
  if (!container || typeof L === "undefined") return;
  const origin = coordsFor(originAddress.city, originAddress.country);
  const destination = coordsFor(destinationAddress.city, destinationAddress.country);
  const map = L.map(container, { scrollWheelZoom: false, attributionControl: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  const pin = (color) =>
    L.divIcon({
      className: "",
      html: `<span style="display:block;width:16px;height:16px;border-radius:9999px;background:${color};border:3px solid white;box-shadow:0 1px 4px rgba(0,0,0,.4)"></span>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });

  const a = L.marker(origin, { icon: pin("#4f46e5") }).addTo(map).bindPopup(`${escapeHtml(originAddress.city)}, ${escapeHtml(originAddress.country)}`);
  const b = L.marker(destination, { icon: pin("#f59e0b") }).addTo(map).bindPopup(`${escapeHtml(destinationAddress.city)}, ${escapeHtml(destinationAddress.country)}`);
  L.polyline([origin, destination], { color: "#6366f1", weight: 3, dashArray: "6 6", opacity: 0.8 }).addTo(map);

  const group = L.featureGroup([a, b]);
  map.fitBounds(group.getBounds().pad(0.35));
  // Leaflet needs a nudge when mounted into freshly-inserted DOM.
  setTimeout(() => map.invalidateSize(), 80);
  return map;
}

let toastTimer = null;
export function toast(message) {
  let host = document.getElementById("toast");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast";
    host.className = "fixed bottom-5 left-1/2 z-[1000] -translate-x-1/2";
    document.body.appendChild(host);
  }
  host.innerHTML = `<div class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-lg">${escapeHtml(message)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (host.innerHTML = ""), 2600);
}

/* ---------------------------------------------------- header / footer ----- */

function navLink(href, label, active) {
  const cls = active
    ? "text-brand-700 font-semibold"
    : "text-slate-600 hover:text-brand-700";
  return `<a href="${href}" class="text-sm ${cls}">${escapeHtml(label)}</a>`;
}

export function renderHeader({ t, locale, user, route }) {
  const otherLocale = locale === "es" ? "en" : "es";
  const publicNav = [
    navLink("#/", t("Nav.home"), route === "home"),
    navLink("#/track", t("Nav.track"), route === "track"),
    navLink("#/quote", t("Nav.quote"), route === "quote"),
    navLink("#/coverage", t("Nav.coverage"), route === "coverage"),
    navLink("#/faq", t("Nav.faq"), route === "faq"),
  ].join("");

  const account = user
    ? `<a href="#/app" class="text-sm font-semibold text-brand-700 hover:text-brand-800">${escapeHtml(t("Dashboard.nav.overview"))}</a>
       <button data-action="logout" class="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50">${escapeHtml(t("Dashboard.signOut"))}</button>`
    : `<a href="#/login" class="rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700">${escapeHtml(t("Nav.signIn"))}</a>`;

  return `<header class="sticky top-0 z-50 border-b border-slate-200/70 bg-white/85 backdrop-blur">
    <div class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
      <a href="#/" class="flex items-center gap-2 font-bold text-slate-900">
        <span class="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-white">📦</span>
        <span>Shipping Hub</span>
      </a>
      <nav class="hidden items-center gap-6 md:flex">${publicNav}</nav>
      <div class="flex items-center gap-3">
        <button data-action="locale" data-locale="${otherLocale}" class="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50" title="${escapeHtml(t("Locale.label"))}">${otherLocale.toUpperCase()}</button>
        ${account}
      </div>
    </div>
  </header>`;
}

export function renderFooter({ t }) {
  return `<footer class="mt-16 border-t border-slate-200 bg-white">
    <div class="mx-auto max-w-6xl px-4 py-8 text-sm text-slate-500">
      <div class="flex flex-col items-start justify-between gap-3 md:flex-row md:items-center">
        <div>
          <p class="font-semibold text-slate-700">Shipping Hub</p>
          <p>${escapeHtml(t("Footer.tagline"))}</p>
        </div>
        <div class="text-left md:text-right">
          <p>${escapeHtml(t("Footer.rights", { year: new Date().getFullYear() }))}</p>
          <p class="text-xs text-slate-400">${escapeHtml(t("Footer.builtWith"))}</p>
        </div>
      </div>
    </div>
  </footer>`;
}

export function demoBanner(t) {
  return `<div class="bg-slate-900 text-white">
    <div class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-1.5 text-xs">
      <span>⚙️ ${escapeHtml(t("Demo.banner"))}</span>
      <button data-action="reset" class="font-semibold underline decoration-dotted underline-offset-2 hover:text-accent-400">${escapeHtml(t("Demo.reset"))}</button>
    </div>
  </div>`;
}

/* ---------------------------------------------------------- options ------- */

export function countryOptions(t, selected) {
  return ["PA", "US", "CO", "MX", "PE", "CL", "CR", "AR", "EC"]
    .map((c) => `<option value="${c}" ${c === selected ? "selected" : ""}>${escapeHtml(t(`Countries.${c}`))}</option>`)
    .join("");
}

export function serviceOptions(t, selected) {
  return ["EXPRESS", "STANDARD", "ECONOMY"]
    .map((s) => `<option value="${s}" ${s === selected ? "selected" : ""}>${escapeHtml(t(`ServiceLevel.${s}`))}</option>`)
    .join("");
}

export function countryName(t, code) {
  const key = `Countries.${code}`;
  const name = t(key);
  return name === key ? code : name;
}
