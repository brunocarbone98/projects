// Page renderers. Each view exposes render(ctx) -> HTML string and an optional
// hydrate(ctx, root) that wires events after the HTML is inserted. ctx carries
// the translator, locale, current user, route params and navigation helpers.

import {
  computeQuote,
  hasTrackingCodeShape,
  isValidTrackingCode,
  nextStatuses,
  RATES,
} from "./domain.js";
import * as store from "./store.js";
import {
  countryName,
  countryOptions,
  escapeHtml,
  formatDate,
  formatMoney,
  mountRouteMap,
  renderTimeline,
  serviceOptions,
  statusBadge,
  toast,
} from "./ui.js";

const card = (inner, extra = "") =>
  `<div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm ${extra}">${inner}</div>`;

const sectionWrap = (inner) => `<div class="mx-auto max-w-6xl px-4 py-10">${inner}</div>`;

/* ============================================================== home ====== */

export const home = {
  render({ t }) {
    const feature = (key, icon) => `
      <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div class="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-brand-50 text-xl">${icon}</div>
        <h3 class="font-semibold text-slate-900">${escapeHtml(t(`Home.features.${key}.title`))}</h3>
        <p class="mt-1 text-sm text-slate-600">${escapeHtml(t(`Home.features.${key}.description`))}</p>
      </div>`;
    const step = (key, n) => `
      <div class="relative rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <span class="absolute -top-3 left-5 grid h-7 w-7 place-items-center rounded-full bg-brand-600 text-sm font-bold text-white">${n}</span>
        <h3 class="mt-2 font-semibold text-slate-900">${escapeHtml(t(`Home.steps.${key}.title`))}</h3>
        <p class="mt-1 text-sm text-slate-600">${escapeHtml(t(`Home.steps.${key}.description`))}</p>
      </div>`;

    return `
      <section class="relative overflow-hidden bg-gradient-to-b from-brand-950 via-brand-900 to-brand-800 text-white">
        <div class="mx-auto max-w-6xl px-4 py-20">
          <span class="inline-flex items-center rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-brand-100">${escapeHtml(t("Home.hero.badge"))}</span>
          <h1 class="mt-5 max-w-2xl text-4xl font-extrabold tracking-tight sm:text-5xl">${escapeHtml(t("Home.hero.title"))}</h1>
          <p class="mt-4 max-w-xl text-lg text-brand-100">${escapeHtml(t("Home.hero.subtitle"))}</p>
          <form id="hero-track" class="mt-8 flex max-w-xl flex-col gap-3 sm:flex-row">
            <input name="code" placeholder="${escapeHtml(t("Home.hero.trackPlaceholder"))}"
              class="w-full rounded-xl border-0 px-4 py-3 text-slate-900 shadow-sm focus:ring-2 focus:ring-accent-400" aria-label="${escapeHtml(t("Home.hero.trackLabel"))}" />
            <button class="rounded-xl bg-accent-500 px-6 py-3 font-semibold text-slate-900 shadow-sm transition hover:bg-accent-400">${escapeHtml(t("Home.hero.trackButton"))}</button>
          </form>
          <div class="mt-3 flex items-center gap-3 text-sm text-brand-200">
            <span>${escapeHtml(t("Home.hero.example"))}</span>
            <button data-demo-code="PTY-2026-001001-0" class="rounded-md bg-white/10 px-2 py-1 font-mono text-xs text-white hover:bg-white/20">PTY-2026-001001-0</button>
            <a href="#/quote" class="font-semibold text-accent-400 hover:underline">${escapeHtml(t("Home.hero.quoteButton"))} →</a>
          </div>
        </div>
      </section>
      ${sectionWrap(`
        <h2 class="text-2xl font-bold text-slate-900">${escapeHtml(t("Home.features.title"))}</h2>
        <div class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          ${feature("tracking", "📍")}${feature("coverage", "🌎")}${feature("pricing", "🏷️")}${feature("api", "🧩")}
        </div>
        <h2 class="mt-14 text-2xl font-bold text-slate-900">${escapeHtml(t("Home.steps.title"))}</h2>
        <div class="mt-8 grid gap-4 sm:grid-cols-3">
          ${step("one", 1)}${step("two", 2)}${step("three", 3)}
        </div>
        <div class="mt-14 rounded-2xl bg-brand-600 px-6 py-10 text-center text-white">
          <h2 class="text-2xl font-bold">${escapeHtml(t("Home.cta.title"))}</h2>
          <p class="mt-2 text-brand-100">${escapeHtml(t("Home.cta.subtitle"))}</p>
          <a href="#/track" class="mt-5 inline-block rounded-xl bg-white px-6 py-3 font-semibold text-brand-700 hover:bg-brand-50">${escapeHtml(t("Home.cta.button"))}</a>
        </div>
      `)}`;
  },
  hydrate(ctx, root) {
    root.querySelector("#hero-track")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const code = new FormData(e.target).get("code")?.toString().trim();
      if (code) ctx.navigate(`#/track/${encodeURIComponent(code)}`);
    });
    root.querySelector("[data-demo-code]")?.addEventListener("click", (e) => {
      ctx.navigate(`#/track/${e.currentTarget.dataset.demoCode}`);
    });
  },
};

/* ============================================================= track ====== */

export const track = {
  render({ t, locale, params }) {
    const code = params.code ? decodeURIComponent(params.code) : "";
    const search = `
      <div class="mx-auto max-w-2xl">
        <h1 class="text-3xl font-bold text-slate-900">${escapeHtml(t("Tracking.search.title"))}</h1>
        <p class="mt-2 text-slate-600">${escapeHtml(t("Tracking.search.subtitle"))}</p>
        <form id="track-form" class="mt-6 flex flex-col gap-3 sm:flex-row">
          <input name="code" value="${escapeHtml(code)}" placeholder="${escapeHtml(t("Tracking.search.placeholder"))}"
            class="w-full rounded-xl border border-slate-300 px-4 py-3 shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-200" />
          <button class="rounded-xl bg-brand-600 px-6 py-3 font-semibold text-white hover:bg-brand-700">${escapeHtml(t("Tracking.search.button"))}</button>
        </form>
        <p class="mt-2 text-sm text-slate-500">${escapeHtml(t("Tracking.search.example"))}
          <button data-demo-code="PTY-2026-001001-0" class="font-mono text-brand-600 hover:underline">PTY-2026-001001-0</button>
        </p>
      </div>`;

    let result = "";
    if (code) {
      if (!hasTrackingCodeShape(code) || !isValidTrackingCode(code)) {
        result = `<div class="mx-auto mt-8 max-w-2xl rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">${escapeHtml(t("Tracking.search.invalid"))}</div>`;
      } else {
        const shipment = store.trackByCode(code);
        result = shipment ? track.result(t, locale, shipment) : track.notFound(t, code);
      }
    }
    return sectionWrap(search + result);
  },
  result(t, locale, s) {
    const eta = s.estimatedDeliveryAt ? formatDate(s.estimatedDeliveryAt, locale) : t("Tracking.result.noEstimate");
    return `
      <div class="mx-auto mt-10 max-w-3xl">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="text-xs font-semibold uppercase tracking-wide text-brand-600">${escapeHtml(t("Tracking.result.eyebrow"))}</p>
            <p class="font-mono text-lg font-bold text-slate-900">${escapeHtml(s.trackingCode)}</p>
          </div>
          ${statusBadge(s.status, t)}
        </div>
        ${card(`
          <div class="grid gap-4 sm:grid-cols-2">
            <div><p class="text-xs text-slate-500">${escapeHtml(t("Tracking.result.from"))}</p><p class="font-medium text-slate-800">${escapeHtml(s.originAddress.city)}, ${escapeHtml(countryName(t, s.originAddress.country))}</p></div>
            <div><p class="text-xs text-slate-500">${escapeHtml(t("Tracking.result.to"))}</p><p class="font-medium text-slate-800">${escapeHtml(s.destinationAddress.city)}, ${escapeHtml(countryName(t, s.destinationAddress.country))}</p></div>
            <div><p class="text-xs text-slate-500">${escapeHtml(t("Tracking.result.service"))}</p><p class="font-medium text-slate-800">${escapeHtml(t(`ServiceLevel.${s.serviceLevel}`))}</p></div>
            <div><p class="text-xs text-slate-500">${escapeHtml(t("Tracking.result.estimated"))}</p><p class="font-medium text-slate-800">${escapeHtml(eta)}</p></div>
          </div>
        `, "mt-4")}
        <div id="map" class="mt-4 h-64 w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-100"></div>
        ${card(`<h3 class="mb-4 font-semibold text-slate-900">${escapeHtml(t("Tracking.result.timelineTitle"))}</h3>${renderTimeline(s.events, t, locale)}`, "mt-4")}
        <div class="mt-4 flex flex-wrap gap-3">
          <a href="#/track" class="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">${escapeHtml(t("Tracking.result.searchAnother"))}</a>
          <button data-action="share" class="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">${escapeHtml(t("Tracking.result.share"))}</button>
        </div>
      </div>`;
  },
  notFound(t, code) {
    return `<div class="mx-auto mt-10 max-w-2xl rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <p class="text-4xl">🔍</p>
      <h3 class="mt-3 text-xl font-bold text-slate-900">${escapeHtml(t("Tracking.notFound.title"))}</h3>
      <p class="mt-2 text-slate-600">${escapeHtml(t("Tracking.notFound.body", { code }))}</p>
    </div>`;
  },
  hydrate(ctx, root) {
    root.querySelector("#track-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const code = new FormData(e.target).get("code")?.toString().trim();
      ctx.navigate(code ? `#/track/${encodeURIComponent(code)}` : "#/track");
    });
    root.querySelector("[data-demo-code]")?.addEventListener("click", (e) =>
      ctx.navigate(`#/track/${e.currentTarget.dataset.demoCode}`),
    );
    root.querySelector('[data-action="share"]')?.addEventListener("click", () => {
      navigator.clipboard?.writeText(location.href).catch(() => {});
      toast(ctx.t("Tracking.result.shared"));
    });
    const mapEl = root.querySelector("#map");
    if (mapEl && ctx.params.code) {
      const s = store.trackByCode(decodeURIComponent(ctx.params.code));
      if (s) mountRouteMap(mapEl, s.originAddress, s.destinationAddress);
    }
  },
};

/* ============================================================= quote ====== */

export const quote = {
  render({ t }) {
    return sectionWrap(`
      <div class="mx-auto max-w-2xl">
        <h1 class="text-3xl font-bold text-slate-900">${escapeHtml(t("Quote.title"))}</h1>
        <p class="mt-2 text-slate-600">${escapeHtml(t("Quote.subtitle"))}</p>
        ${card(`
          <form id="quote-form" class="grid gap-4 sm:grid-cols-2">
            <label class="sm:col-span-2 text-sm font-medium text-slate-700">${escapeHtml(t("Quote.form.destination"))}
              <select name="country" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">${countryOptions(t, "US")}</select></label>
            <label class="text-sm font-medium text-slate-700">${escapeHtml(t("Quote.form.weight"))}
              <input name="weight" type="number" min="0.1" step="0.1" value="2" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
            <label class="text-sm font-medium text-slate-700">${escapeHtml(t("Quote.form.service"))}
              <select name="service" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">${serviceOptions(t, "STANDARD")}</select></label>
            <label class="text-sm font-medium text-slate-700">${escapeHtml(t("Quote.form.length"))}
              <input name="length" type="number" min="1" value="30" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
            <label class="text-sm font-medium text-slate-700">${escapeHtml(t("Quote.form.width"))}
              <input name="width" type="number" min="1" value="20" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
            <label class="text-sm font-medium text-slate-700">${escapeHtml(t("Quote.form.height"))}
              <input name="height" type="number" min="1" value="15" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
            <div class="sm:col-span-2"><button class="rounded-xl bg-brand-600 px-6 py-3 font-semibold text-white hover:bg-brand-700">${escapeHtml(t("Quote.form.calculate"))}</button></div>
          </form>
        `, "mt-6")}
        <div id="quote-result" class="mt-4"></div>
      </div>`);
  },
  hydrate(ctx, root) {
    const form = root.querySelector("#quote-form");
    const out = root.querySelector("#quote-result");
    const t = ctx.t;
    const run = () => {
      const f = new FormData(form);
      const q = computeQuote({
        destinationCountry: f.get("country"),
        weightGrams: Math.round(Number(f.get("weight")) * 1000),
        lengthCm: Number(f.get("length")), widthCm: Number(f.get("width")), heightCm: Number(f.get("height")),
        serviceLevel: f.get("service"),
      });
      out.innerHTML = card(`
        <h3 class="font-semibold text-slate-900">${escapeHtml(t("Quote.result.title"))}</h3>
        <div class="mt-4 grid gap-4 sm:grid-cols-2">
          <div><p class="text-xs text-slate-500">${escapeHtml(t("Quote.result.price"))}</p><p class="text-2xl font-bold text-brand-700">${escapeHtml(formatMoney(q.priceCents, ctx.locale))}</p></div>
          <div><p class="text-xs text-slate-500">${escapeHtml(t("Quote.result.eta"))}</p><p class="text-lg font-semibold text-slate-800">${escapeHtml(t("Quote.result.etaDays", { min: q.etaMinDays, max: q.etaMaxDays }))}</p></div>
          <div><p class="text-xs text-slate-500">${escapeHtml(t("Quote.result.zone"))}</p><p class="font-medium text-slate-800">${escapeHtml(q.zoneCode)}</p></div>
          <div><p class="text-xs text-slate-500">${escapeHtml(t("Quote.result.billable"))}</p><p class="font-medium text-slate-800">${(q.billableWeightGrams / 1000).toFixed(1)} kg</p></div>
        </div>
        <p class="mt-4 text-xs text-slate-400">${escapeHtml(t("Quote.result.disclaimer"))}</p>
      `);
    };
    form.addEventListener("submit", (e) => { e.preventDefault(); run(); });
    run();
  },
};

/* ========================================================== coverage ====== */

export const coverage = {
  render({ t }) {
    const row = (zone) => {
      const r = RATES[zone];
      const days = (lvl) => t("Coverage.table.days", { min: r[lvl][2], max: r[lvl][3] });
      return `<tr class="border-t border-slate-200">
        <td class="px-4 py-3"><p class="font-semibold text-slate-800">${escapeHtml(t(`Coverage.zones.${zone}.name`))}</p><p class="text-xs text-slate-500">${escapeHtml(t(`Coverage.zones.${zone}.countries`))}</p></td>
        <td class="px-4 py-3 text-sm text-slate-600">${escapeHtml(days("EXPRESS"))}</td>
        <td class="px-4 py-3 text-sm text-slate-600">${escapeHtml(days("STANDARD"))}</td>
        <td class="px-4 py-3 text-sm text-slate-600">${escapeHtml(days("ECONOMY"))}</td>
      </tr>`;
    };
    return sectionWrap(`
      <div class="mx-auto max-w-3xl">
        <h1 class="text-3xl font-bold text-slate-900">${escapeHtml(t("Coverage.title"))}</h1>
        <p class="mt-2 text-slate-600">${escapeHtml(t("Coverage.subtitle"))}</p>
        ${card(`
          <table class="w-full text-left">
            <thead><tr class="text-xs uppercase tracking-wide text-slate-500">
              <th class="px-4 py-2">${escapeHtml(t("Coverage.table.zone"))}</th>
              <th class="px-4 py-2">${escapeHtml(t("Coverage.table.express"))}</th>
              <th class="px-4 py-2">${escapeHtml(t("Coverage.table.standard"))}</th>
              <th class="px-4 py-2">${escapeHtml(t("Coverage.table.economy"))}</th>
            </tr></thead>
            <tbody>${row("PA")}${row("US")}${row("LATAM")}</tbody>
          </table>
        `, "mt-6 overflow-x-auto")}
        <p class="mt-3 text-xs text-slate-400">${escapeHtml(t("Coverage.note"))}</p>
      </div>`);
  },
};

/* ============================================================== faq ======= */

export const faq = {
  render({ t }) {
    const items = t.raw("Faq.items") || [];
    return sectionWrap(`
      <div class="mx-auto max-w-2xl">
        <h1 class="text-3xl font-bold text-slate-900">${escapeHtml(t("Faq.title"))}</h1>
        <p class="mt-2 text-slate-600">${escapeHtml(t("Faq.subtitle"))}</p>
        <div class="mt-6 space-y-3">
          ${items.map((it) => `
            <details class="group rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <summary class="flex cursor-pointer items-center justify-between font-medium text-slate-800">${escapeHtml(it.question)}<span class="text-brand-500 group-open:rotate-45 transition">+</span></summary>
              <p class="mt-2 text-sm text-slate-600">${escapeHtml(it.answer)}</p>
            </details>`).join("")}
        </div>
      </div>`);
  },
};

/* ============================================================= auth ======= */

function authError(t, code) {
  return code ? `<div class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">${escapeHtml(t(`Auth.errors.${code}`))}</div>` : "";
}

export const login = {
  render({ t }) {
    return sectionWrap(`
      <div class="mx-auto max-w-md">
        ${card(`
          <h1 class="text-2xl font-bold text-slate-900">${escapeHtml(t("Auth.login.title"))}</h1>
          <p class="mt-1 text-sm text-slate-600">${escapeHtml(t("Auth.login.subtitle"))}</p>
          <form id="login-form" class="mt-5 space-y-4">
            <div id="login-error"></div>
            <label class="block text-sm font-medium text-slate-700">${escapeHtml(t("Auth.login.email"))}
              <input name="email" type="email" value="ana@example.com" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
            <label class="block text-sm font-medium text-slate-700">${escapeHtml(t("Auth.login.password"))}
              <input name="password" type="password" value="Password123!" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
            <button class="w-full rounded-xl bg-brand-600 px-4 py-2.5 font-semibold text-white hover:bg-brand-700">${escapeHtml(t("Auth.login.submit"))}</button>
          </form>
          <div class="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
            <p class="font-semibold text-slate-600">${escapeHtml(t("Auth.login.demoHint"))}</p>
            <p class="mt-1 font-mono">ana@example.com · luis@example.com</p>
            <p class="font-mono">admin@shippinghub.test · courier@shippinghub.test</p>
          </div>
          <p class="mt-4 text-center text-sm text-slate-600">${escapeHtml(t("Auth.login.noAccount"))}
            <a href="#/register" class="font-semibold text-brand-600 hover:underline">${escapeHtml(t("Auth.login.registerLink"))}</a></p>
        `)}
      </div>`);
  },
  hydrate(ctx, root) {
    root.querySelector("#login-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const res = store.login(f.get("email"), f.get("password"));
      if (res.error) {
        root.querySelector("#login-error").innerHTML = authError(ctx.t, res.error);
      } else {
        ctx.navigate("#/app");
      }
    });
  },
};

export const register = {
  render({ t }) {
    return sectionWrap(`
      <div class="mx-auto max-w-md">
        ${card(`
          <h1 class="text-2xl font-bold text-slate-900">${escapeHtml(t("Auth.register.title"))}</h1>
          <p class="mt-1 text-sm text-slate-600">${escapeHtml(t("Auth.register.subtitle"))}</p>
          <form id="register-form" class="mt-5 space-y-4">
            <div id="register-error"></div>
            <label class="block text-sm font-medium text-slate-700">${escapeHtml(t("Auth.register.name"))}
              <input name="name" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
            <label class="block text-sm font-medium text-slate-700">${escapeHtml(t("Auth.register.email"))}
              <input name="email" type="email" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
            <label class="block text-sm font-medium text-slate-700">${escapeHtml(t("Auth.register.password"))}
              <input name="password" type="password" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
              <span class="text-xs font-normal text-slate-400">${escapeHtml(t("Auth.register.passwordHint"))}</span></label>
            <button class="w-full rounded-xl bg-brand-600 px-4 py-2.5 font-semibold text-white hover:bg-brand-700">${escapeHtml(t("Auth.register.submit"))}</button>
          </form>
          <p class="mt-4 text-center text-sm text-slate-600">${escapeHtml(t("Auth.register.hasAccount"))}
            <a href="#/login" class="font-semibold text-brand-600 hover:underline">${escapeHtml(t("Auth.register.loginLink"))}</a></p>
        `)}
      </div>`);
  },
  hydrate(ctx, root) {
    root.querySelector("#register-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const res = store.register(f.get("name"), f.get("email"), f.get("password"));
      if (res.error) {
        root.querySelector("#register-error").innerHTML = authError(ctx.t, res.error);
      } else {
        ctx.navigate("#/app");
      }
    });
  },
};

/* ====================================================== dashboard shell === */

function appShell(ctx, active, content) {
  const { t, user } = ctx;
  const isStaff = store.isStaff(user);
  const link = (href, key, show = true) =>
    show
      ? `<a href="${href}" class="block rounded-lg px-3 py-2 text-sm font-medium ${active === key ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50"}">${escapeHtml(t(`Dashboard.nav.${key}`))}</a>`
      : "";
  return sectionWrap(`
    <div class="grid gap-6 lg:grid-cols-[220px_1fr]">
      <aside class="space-y-4">
        <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p class="text-xs text-slate-500">${escapeHtml(t("Dashboard.signedInAs"))}</p>
          <p class="font-semibold text-slate-800">${escapeHtml(user.name)}</p>
          <span class="mt-1 inline-flex rounded-full bg-brand-100 px-2 py-0.5 text-xs font-semibold text-brand-700">${escapeHtml(t(`Dashboard.roles.${user.role}`))}</span>
        </div>
        <nav class="rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
          ${link("#/app", "overview")}
          ${link("#/app/shipments", "shipments")}
          ${link("#/app/new", "newShipment", !isStaff)}
          ${link("#/app/wallet", "wallet", !isStaff)}
        </nav>
      </aside>
      <main>${content}</main>
    </div>`);
}

/* ======================================================== dashboard ======= */

export const dashboard = {
  render(ctx) {
    const { t, user } = ctx;
    const isStaff = store.isStaff(user);
    const count = isStaff ? store.allShipments().length : store.listForUser(user.id).length;
    const content = `
      <h1 class="text-2xl font-bold text-slate-900">${escapeHtml(t("Dashboard.overview.title"))}</h1>
      <p class="mt-1 text-slate-600">${escapeHtml(t("Dashboard.overview.welcome", { name: user.name }))}</p>
      <p class="text-sm text-slate-500">${escapeHtml(isStaff ? t("Dashboard.overview.staffLead") : t("Dashboard.overview.customerLead"))}</p>
      <div class="mt-6 grid gap-4 sm:grid-cols-2">
        ${card(`<p class="text-xs text-slate-500">${escapeHtml(t("Dashboard.overview.totalShipments"))}</p><p class="mt-1 text-3xl font-bold text-brand-700">${count}</p>
          <a href="#/app/shipments" class="mt-3 inline-block text-sm font-semibold text-brand-600 hover:underline">${escapeHtml(t("Dashboard.overview.viewAll"))} →</a>`)}
        ${isStaff ? "" : card(`<p class="font-semibold text-slate-800">${escapeHtml(t("Dashboard.overview.createCta"))}</p>
          <a href="#/app/new" class="mt-3 inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">${escapeHtml(t("Shipments.newShipment"))}</a>`)}
      </div>`;
    return appShell(ctx, "overview", content);
  },
};

/* ====================================================== shipments list ==== */

function shipmentRow(ctx, s) {
  const { t, locale } = ctx;
  return `<tr class="border-t border-slate-200 hover:bg-slate-50">
    <td class="px-3 py-3 font-mono text-xs text-slate-700">${escapeHtml(s.trackingCode)}</td>
    <td class="px-3 py-3">${statusBadge(s.status, t)}</td>
    <td class="px-3 py-3 text-sm text-slate-600">${escapeHtml(s.originAddress.country)} → ${escapeHtml(s.destinationAddress.country)}</td>
    <td class="px-3 py-3 text-sm text-slate-600">${escapeHtml(t(`ServiceLevel.${s.serviceLevel}`))}</td>
    <td class="px-3 py-3 text-sm text-slate-500">${escapeHtml(formatDate(s.createdAt, locale))}</td>
    <td class="px-3 py-3 text-sm font-medium text-slate-800">${escapeHtml(formatMoney(s.priceCents, locale))}</td>
    <td class="px-3 py-3 text-right"><a href="#/app/shipments/${s.id}" class="text-sm font-semibold text-brand-600 hover:underline">${escapeHtml(t("Shipments.view"))}</a></td>
  </tr>`;
}

export const shipments = {
  render(ctx) {
    const { t, user, params } = ctx;
    const isStaff = store.isStaff(user);
    const status = params.query?.status || "";
    const list = isStaff ? store.allShipments(status) : store.listForUser(user.id, status);
    const statusFilter = `
      <form id="filter-form" class="flex items-end gap-2">
        <label class="text-sm font-medium text-slate-700">${escapeHtml(t("Shipments.search.statusLabel"))}
          <select name="status" class="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="">${escapeHtml(t("Shipments.search.all"))}</option>
            ${["CREATED","LABEL_PAID","PICKED_UP","IN_TRANSIT","AT_DESTINATION_HUB","OUT_FOR_DELIVERY","DELIVERED","EXCEPTION","RETURNED_TO_SENDER","CANCELLED"]
              .map((st) => `<option value="${st}" ${st === status ? "selected" : ""}>${escapeHtml(t(`Status.${st}`))}</option>`).join("")}
          </select></label>
      </form>`;

    const body = list.length
      ? `<div class="overflow-x-auto">${card(`<table class="w-full text-left"><thead><tr class="text-xs uppercase tracking-wide text-slate-500">
            <th class="px-3 py-2">${escapeHtml(t("Shipments.table.code"))}</th><th class="px-3 py-2">${escapeHtml(t("Shipments.table.status"))}</th>
            <th class="px-3 py-2">${escapeHtml(t("Shipments.table.route"))}</th><th class="px-3 py-2">${escapeHtml(t("Shipments.table.service"))}</th>
            <th class="px-3 py-2">${escapeHtml(t("Shipments.table.created"))}</th><th class="px-3 py-2">${escapeHtml(t("Shipments.table.price"))}</th><th></th>
          </tr></thead><tbody>${list.map((s) => shipmentRow(ctx, s)).join("")}</tbody></table>`, "p-2")}</div>`
      : card(`<p class="text-center text-slate-500">${escapeHtml(t("Shipments.empty"))}</p>`);

    const content = `
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="text-2xl font-bold text-slate-900">${escapeHtml(isStaff ? t("Shipments.allTitle") : t("Shipments.mineTitle"))}</h1>
          <p class="text-sm text-slate-500">${escapeHtml(t("Shipments.resultCount", { count: list.length }))}</p>
        </div>
        ${isStaff ? "" : `<a href="#/app/new" class="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">${escapeHtml(t("Shipments.newShipment"))}</a>`}
      </div>
      <div class="mt-4">${statusFilter}</div>
      <div class="mt-4">${body}</div>`;
    return appShell(ctx, "shipments", content);
  },
  hydrate(ctx, root) {
    root.querySelector("#filter-form select")?.addEventListener("change", (e) => {
      const status = e.target.value;
      ctx.navigate(status ? `#/app/shipments?status=${status}` : "#/app/shipments");
    });
  },
};

/* ===================================================== shipment detail ==== */

export const shipmentDetail = {
  render(ctx) {
    const { t, locale, user, params } = ctx;
    const s = store.getById(params.id);
    if (!s) return appShell(ctx, "shipments", card(`<p class="text-slate-500">${escapeHtml(t("NotFound.body"))}</p><a href="#/app/shipments" class="mt-3 inline-block text-sm font-semibold text-brand-600">${escapeHtml(t("ShipmentDetail.back"))}</a>`));

    const isOwner = s.userId === user.id;
    const isStaff = store.isStaff(user);
    const eta = s.estimatedDeliveryAt ? formatDate(s.estimatedDeliveryAt, locale) : t("ShipmentDetail.noEstimate");

    const info = (label, value) => `<div><p class="text-xs text-slate-500">${escapeHtml(label)}</p><p class="font-medium text-slate-800">${value}</p></div>`;

    let actions = "";
    if (isOwner && s.status === "CREATED") {
      const balance = store.balanceForUser(user.id);
      const enough = balance >= s.priceCents;
      actions = card(`
        <h3 class="font-semibold text-slate-900">${escapeHtml(t("ShipmentDetail.downloadLabel"))} / ${escapeHtml(t("Wallet.title"))}</h3>
        <p class="mt-1 text-sm text-slate-500">${escapeHtml(t("Wallet.balance"))}: <span class="font-semibold text-slate-700">${escapeHtml(formatMoney(balance, locale))}</span></p>
        ${enough
          ? `<button data-action="pay" class="mt-3 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">${escapeHtml(t("ShipmentDetail.pay", { amount: formatMoney(s.priceCents, locale) }))}</button>`
          : `<p class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">${escapeHtml(t("ShipmentDetail.payInsufficient"))}</p>
             <a href="#/app/wallet" class="mt-2 inline-block text-sm font-semibold text-brand-600 hover:underline">${escapeHtml(t("Wallet.addFunds"))} →</a>`}
      `, "mt-4");
    }

    let staffForm = "";
    if (isStaff) {
      const options = nextStatuses(s.status);
      staffForm = card(
        options.length
          ? `<h3 class="font-semibold text-slate-900">${escapeHtml(t("ShipmentDetail.registerEvent.title"))}</h3>
             <form id="event-form" class="mt-3 space-y-3">
               <div id="event-error"></div>
               <label class="block text-sm font-medium text-slate-700">${escapeHtml(t("ShipmentDetail.registerEvent.status"))}
                 <select name="status" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">${options.map((st) => `<option value="${st}">${escapeHtml(t(`Status.${st}`))}</option>`).join("")}</select></label>
               <label class="block text-sm font-medium text-slate-700">${escapeHtml(t("ShipmentDetail.registerEvent.location"))}
                 <input name="location" placeholder="${escapeHtml(t("ShipmentDetail.registerEvent.locationPlaceholder"))}" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
               <label class="block text-sm font-medium text-slate-700">${escapeHtml(t("ShipmentDetail.registerEvent.description"))}
                 <input name="description" placeholder="${escapeHtml(t("ShipmentDetail.registerEvent.descriptionPlaceholder"))}" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
               <button class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">${escapeHtml(t("ShipmentDetail.registerEvent.submit"))}</button>
             </form>`
          : `<p class="text-sm text-slate-500">${escapeHtml(t("ShipmentDetail.registerEvent.noTransitions"))}</p>`,
        "mt-4",
      );
    }

    const content = `
      <a href="#/app/shipments" class="text-sm font-medium text-brand-600 hover:underline">← ${escapeHtml(t("ShipmentDetail.back"))}</a>
      <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p class="font-mono text-lg font-bold text-slate-900">${escapeHtml(s.trackingCode)}</p>
        ${statusBadge(s.status, t)}
      </div>
      ${card(`<div class="grid gap-4 sm:grid-cols-2">
        ${info(t("ShipmentDetail.from"), `${escapeHtml(s.originAddress.city)}, ${escapeHtml(countryName(t, s.originAddress.country))}`)}
        ${info(t("ShipmentDetail.to"), `${escapeHtml(s.destinationAddress.city)}, ${escapeHtml(countryName(t, s.destinationAddress.country))}`)}
        ${info(t("ShipmentDetail.service"), escapeHtml(t(`ServiceLevel.${s.serviceLevel}`)))}
        ${info(t("ShipmentDetail.estimated"), escapeHtml(eta))}
        ${info(t("ShipmentDetail.price"), escapeHtml(formatMoney(s.priceCents, locale)))}
        ${info(t("ShipmentDetail.weight"), `${(s.weightGrams / 1000).toFixed(1)} kg`)}
        ${info(t("ShipmentDetail.dimensions"), `${s.lengthCm}×${s.widthCm}×${s.heightCm} cm`)}
      </div>
      <button data-action="label" class="mt-4 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">⬇ ${escapeHtml(t("ShipmentDetail.downloadLabel"))}</button>`, "mt-4")}
      <div id="map" class="mt-4 h-56 w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-100"></div>
      ${actions}
      ${staffForm}
      ${card(`<h3 class="mb-4 font-semibold text-slate-900">${escapeHtml(t("ShipmentDetail.timeline"))}</h3>${renderTimeline(s.events, t, locale)}`, "mt-4")}`;
    return appShell(ctx, "shipments", content);
  },
  hydrate(ctx, root) {
    const s = store.getById(ctx.params.id);
    if (!s) return;
    const mapEl = root.querySelector("#map");
    if (mapEl) mountRouteMap(mapEl, s.originAddress, s.destinationAddress);

    root.querySelector('[data-action="label"]')?.addEventListener("click", () => downloadLabel(s, ctx));

    const payBtn = root.querySelector('[data-action="pay"]');
    if (payBtn) {
      const key = store.newIdempotencyKey();
      payBtn.addEventListener("click", () => {
        const res = store.payLabel(s.id, key);
        if (res.error === "insufficient_funds") toast(ctx.t("ShipmentDetail.payInsufficient"));
        else { toast(ctx.t("ShipmentDetail.paid")); ctx.rerender(); }
      });
    }

    root.querySelector("#event-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const res = store.addEvent(s.id, { status: f.get("status"), location: f.get("location"), description: f.get("description") });
      if (res.error) root.querySelector("#event-error").innerHTML = `<div class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">${escapeHtml(ctx.t("ShipmentDetail.registerEvent.errorInvalid"))}</div>`;
      else ctx.rerender();
    });
  },
};

/** Build a printable 4×6 SVG shipping label and download it. */
function downloadLabel(s, ctx) {
  const bars = s.trackingCode.replace(/\D/g, "").split("").map((d, i) => {
    const w = 2 + (Number(d) % 4);
    return `<rect x="${20 + i * 9}" y="430" width="${w}" height="70" fill="#0f172a"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="384" height="576" viewBox="0 0 384 576">
    <rect width="384" height="576" fill="white" stroke="#0f172a" stroke-width="2"/>
    <text x="20" y="40" font-family="sans-serif" font-size="22" font-weight="bold" fill="#4f46e5">Shipping Hub</text>
    <text x="20" y="64" font-family="sans-serif" font-size="12" fill="#64748b">${escapeHtml(ctx.t(`ServiceLevel.${s.serviceLevel}`))}</text>
    <line x1="20" y1="80" x2="364" y2="80" stroke="#e2e8f0"/>
    <text x="20" y="110" font-family="sans-serif" font-size="11" fill="#64748b">FROM</text>
    <text x="20" y="130" font-family="sans-serif" font-size="13" fill="#0f172a">${escapeHtml(s.originAddress.city)}, ${escapeHtml(s.originAddress.country)}</text>
    <text x="20" y="180" font-family="sans-serif" font-size="11" fill="#64748b">TO</text>
    <text x="20" y="202" font-family="sans-serif" font-size="16" font-weight="bold" fill="#0f172a">${escapeHtml(s.destinationAddress.contactName)}</text>
    <text x="20" y="224" font-family="sans-serif" font-size="13" fill="#0f172a">${escapeHtml(s.destinationAddress.line1)}</text>
    <text x="20" y="244" font-family="sans-serif" font-size="13" fill="#0f172a">${escapeHtml(s.destinationAddress.city)}, ${escapeHtml(s.destinationAddress.country)} ${escapeHtml(s.destinationAddress.postalCode)}</text>
    <line x1="20" y1="280" x2="364" y2="280" stroke="#e2e8f0"/>
    <text x="20" y="320" font-family="sans-serif" font-size="11" fill="#64748b">WEIGHT</text>
    <text x="20" y="340" font-family="sans-serif" font-size="14" fill="#0f172a">${(s.weightGrams / 1000).toFixed(1)} kg · ${s.lengthCm}×${s.widthCm}×${s.heightCm} cm</text>
    ${bars}
    <text x="20" y="525" font-family="monospace" font-size="16" font-weight="bold" fill="#0f172a">${escapeHtml(s.trackingCode)}</text>
  </svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `label-${s.trackingCode}.svg`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ============================================================ wallet ====== */

export const wallet = {
  render(ctx) {
    const { t, locale, user } = ctx;
    const balance = store.balanceForUser(user.id);
    const entries = store.ledgerForUser(user.id);
    const history = entries.length
      ? entries.map((e) => {
          const positive = e.amountCents >= 0;
          return `<li class="flex items-center justify-between border-t border-slate-100 py-3">
            <div>
              <p class="text-sm font-medium text-slate-800">${escapeHtml(t(`Wallet.kinds.${e.kind}`))}</p>
              <p class="text-xs text-slate-400">${escapeHtml(formatDate(e.createdAt, locale, true))}</p>
            </div>
            <span class="font-semibold ${positive ? "text-emerald-600" : "text-slate-700"}">${positive ? "+" : "−"}${escapeHtml(formatMoney(Math.abs(e.amountCents), locale))}</span>
          </li>`;
        }).join("")
      : `<li class="py-6 text-center text-sm text-slate-500">${escapeHtml(t("Wallet.empty"))}</li>`;

    const content = `
      <h1 class="text-2xl font-bold text-slate-900">${escapeHtml(t("Wallet.title"))}</h1>
      <div class="mt-4 grid gap-4 sm:grid-cols-2">
        ${card(`<p class="text-xs text-slate-500">${escapeHtml(t("Wallet.balance"))}</p><p class="mt-1 text-3xl font-bold text-brand-700">${escapeHtml(formatMoney(balance, locale))}</p>`)}
        ${card(`
          <form id="topup-form" class="space-y-3">
            <div id="topup-error"></div>
            <label class="block text-sm font-medium text-slate-700">${escapeHtml(t("Wallet.amount"))}
              <input name="amount" type="number" min="1" step="1" value="50" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
            <button class="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">${escapeHtml(t("Wallet.addFunds"))}</button>
          </form>`)}
      </div>
      ${card(`<h3 class="font-semibold text-slate-900">${escapeHtml(t("Wallet.history"))}</h3><ul class="mt-2">${history}</ul>`, "mt-4")}`;
    return appShell(ctx, "wallet", content);
  },
  hydrate(ctx, root) {
    const form = root.querySelector("#topup-form");
    let key = store.newIdempotencyKey();
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      const dollars = Number(new FormData(form).get("amount"));
      if (!Number.isFinite(dollars) || dollars <= 0) {
        root.querySelector("#topup-error").innerHTML = `<div class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">${escapeHtml(ctx.t("Wallet.invalidAmount"))}</div>`;
        return;
      }
      store.topUp(Math.round(dollars * 100), key);
      key = store.newIdempotencyKey(); // fresh key for the next, distinct top-up
      ctx.rerender();
    });
  },
};

/* ====================================================== new shipment ====== */

let wizardState = null;

export const newShipment = {
  render(ctx) {
    wizardState = { step: 0, data: {
      contactName: "", line1: "", city: "", state: "", postalCode: "", country: "US",
      weight: "2", length: "30", width: "20", height: "15", serviceLevel: "STANDARD",
    } };
    return appShell(ctx, "newShipment", `<h1 class="text-2xl font-bold text-slate-900">${escapeHtml(ctx.t("Wizard.title"))}</h1><div id="wizard" class="mt-4"></div>`);
  },
  hydrate(ctx, root) {
    const { t, locale } = ctx;
    const host = root.querySelector("#wizard");
    const steps = ["addresses", "parcel", "service", "review"];

    const stepper = () => `<div class="mb-5 flex items-center gap-2">${steps.map((s, i) =>
      `<div class="flex items-center gap-2 ${i <= wizardState.step ? "text-brand-700" : "text-slate-400"}">
        <span class="grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${i <= wizardState.step ? "bg-brand-600 text-white" : "bg-slate-200"}">${i + 1}</span>
        <span class="hidden text-sm font-medium sm:inline">${escapeHtml(t(`Wizard.steps.${s}`))}</span>
        ${i < steps.length - 1 ? '<span class="mx-1 h-px w-5 bg-slate-200"></span>' : ""}
      </div>`).join("")}</div>`;

    const field = (name, labelKey, type = "text") =>
      `<label class="block text-sm font-medium text-slate-700">${escapeHtml(t(`Wizard.fields.${labelKey}`))}
        <input name="${name}" type="${type}" value="${escapeHtml(wizardState.data[name])}" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label>`;

    const captureInputs = () => {
      host.querySelectorAll("input, select").forEach((el) => { wizardState.data[el.name] = el.value; });
    };

    const liveQuote = () => computeQuote({
      destinationCountry: wizardState.data.country,
      weightGrams: Math.round(Number(wizardState.data.weight) * 1000),
      lengthCm: Number(wizardState.data.length), widthCm: Number(wizardState.data.width), heightCm: Number(wizardState.data.height),
      serviceLevel: wizardState.data.serviceLevel,
    });

    const renderStep = () => {
      const d = wizardState.data;
      let body = "";
      if (wizardState.step === 0) {
        body = `<div class="grid gap-4 sm:grid-cols-2">
          <p class="sm:col-span-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">${escapeHtml(t("Wizard.origin"))}: Shipping Hub Warehouse · Panama City, PA</p>
          ${field("contactName", "contactName")}${field("line1", "line1")}
          ${field("city", "city")}
          <label class="block text-sm font-medium text-slate-700">${escapeHtml(t("Wizard.fields.country"))}
            <select name="country" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">${countryOptions(t, d.country)}</select></label>
          ${field("state", "state")}${field("postalCode", "postalCode")}
        </div>`;
      } else if (wizardState.step === 1) {
        body = `<div class="grid gap-4 sm:grid-cols-2">
          ${field("weight", "weight", "number")}${field("length", "length", "number")}
          ${field("width", "width", "number")}${field("height", "height", "number")}
        </div>`;
      } else if (wizardState.step === 2) {
        const q = liveQuote();
        body = `<div class="space-y-4">
          <label class="block text-sm font-medium text-slate-700">${escapeHtml(t("Wizard.fields.serviceLevel"))}
            <select name="serviceLevel" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">${serviceOptions(t, d.serviceLevel)}</select></label>
          <div class="rounded-xl bg-brand-50 p-4">
            <p class="text-xs text-slate-500">${escapeHtml(t("Wizard.estimate.title"))}</p>
            <p class="text-2xl font-bold text-brand-700">${escapeHtml(formatMoney(q.priceCents, locale))}</p>
            <p class="text-sm text-slate-600">${escapeHtml(t("Wizard.estimate.eta"))}: ${escapeHtml(t("Wizard.estimate.etaDays", { min: q.etaMinDays, max: q.etaMaxDays }))}</p>
          </div>
        </div>`;
      } else {
        const q = liveQuote();
        body = `<div class="space-y-3 text-sm">
          <p class="font-semibold text-slate-900">${escapeHtml(t("Wizard.review.title"))}</p>
          <div class="rounded-xl border border-slate-200 p-4">
            <p><span class="text-slate-500">${escapeHtml(t("Wizard.destination"))}:</span> ${escapeHtml(d.contactName)} — ${escapeHtml(d.line1)}, ${escapeHtml(d.city)}, ${escapeHtml(countryName(t, d.country))} ${escapeHtml(d.postalCode)}</p>
            <p class="mt-1"><span class="text-slate-500">${escapeHtml(t("Wizard.steps.parcel"))}:</span> ${escapeHtml(t("Wizard.review.parcelSummary", { weight: d.weight, l: d.length, w: d.width, h: d.height }))}</p>
            <p class="mt-1"><span class="text-slate-500">${escapeHtml(t("Wizard.fields.serviceLevel"))}:</span> ${escapeHtml(t(`ServiceLevel.${d.serviceLevel}`))}</p>
            <p class="mt-2 text-lg font-bold text-brand-700">${escapeHtml(formatMoney(q.priceCents, locale))}</p>
          </div>
        </div>`;
      }

      const isLast = wizardState.step === steps.length - 1;
      host.innerHTML = card(`${stepper()}<div id="wizard-error"></div>${body}
        <div class="mt-6 flex justify-between">
          <button data-nav="back" class="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 ${wizardState.step === 0 ? "invisible" : ""}">${escapeHtml(t("Wizard.back"))}</button>
          <button data-nav="next" class="rounded-lg bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700">${escapeHtml(isLast ? t("Wizard.submit") : t("Wizard.next"))}</button>
        </div>`);

      host.querySelector('[data-nav="back"]').addEventListener("click", () => {
        captureInputs();
        if (wizardState.step > 0) { wizardState.step -= 1; renderStep(); }
      });
      host.querySelector('[data-nav="next"]').addEventListener("click", () => {
        captureInputs();
        if (!validateStep()) {
          host.querySelector("#wizard-error").innerHTML = `<div class="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">${escapeHtml(t("Wizard.error"))}</div>`;
          return;
        }
        if (isLast) {
          const d = wizardState.data;
          const res = store.createShipment({
            destination: { contactName: d.contactName, line1: d.line1, city: d.city, state: d.state, postalCode: d.postalCode, country: d.country },
            weightGrams: Math.round(Number(d.weight) * 1000),
            lengthCm: Number(d.length), widthCm: Number(d.width), heightCm: Number(d.height),
            serviceLevel: d.serviceLevel,
          });
          if (res.shipment) { toast(t("Wizard.created", { code: res.shipment.trackingCode })); ctx.navigate(`#/app/shipments/${res.shipment.id}`); }
        } else {
          wizardState.step += 1;
          renderStep();
        }
      });
    };

    const validateStep = () => {
      const d = wizardState.data;
      if (wizardState.step === 0) return d.contactName && d.line1 && d.city && d.postalCode && d.country;
      if (wizardState.step === 1) return [d.weight, d.length, d.width, d.height].every((v) => Number(v) > 0);
      return true;
    };

    renderStep();
  },
};

export const notFound = {
  render({ t }) {
    return sectionWrap(`<div class="mx-auto max-w-lg text-center">
      <p class="text-5xl">🛰️</p>
      <h1 class="mt-4 text-2xl font-bold text-slate-900">${escapeHtml(t("NotFound.title"))}</h1>
      <p class="mt-2 text-slate-600">${escapeHtml(t("NotFound.body"))}</p>
      <a href="#/" class="mt-5 inline-block rounded-xl bg-brand-600 px-5 py-2.5 font-semibold text-white hover:bg-brand-700">${escapeHtml(t("NotFound.home"))}</a>
    </div>`);
  },
};
