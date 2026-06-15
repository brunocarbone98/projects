// Router + bootstrap. Hash-based routing keeps the app a single static file set
// that works on GitHub Pages from any sub-path. Each navigation re-renders the
// header, the matched view and the footer, then runs the view's hydrate step.

import { createT } from "./i18n.js";
import * as store from "./store.js";
import { demoBanner, renderFooter, renderHeader, toast } from "./ui.js";
import * as views from "./views.js";

const VIEWS = {
  home: views.home, track: views.track, quote: views.quote, coverage: views.coverage,
  faq: views.faq, login: views.login, register: views.register, dashboard: views.dashboard,
  shipments: views.shipments, shipmentDetail: views.shipmentDetail, newShipment: views.newShipment,
  wallet: views.wallet, notFound: views.notFound,
};

const PUBLIC_ROUTES = { home: "home", track: "track", quote: "quote", coverage: "coverage", faq: "faq" };

function resolve(hash) {
  const raw = (hash || "").replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const segs = pathPart.split("/").filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryPart || ""));
  if (segs.length === 0) return { name: "home", params: {} };
  switch (segs[0]) {
    case "track": return { name: "track", params: { code: segs[1] } };
    case "quote": return { name: "quote", params: {} };
    case "coverage": return { name: "coverage", params: {} };
    case "faq": return { name: "faq", params: {} };
    case "login": return { name: "login", params: {} };
    case "register": return { name: "register", params: {} };
    case "app":
      if (!segs[1]) return { name: "dashboard", params: {}, app: true };
      if (segs[1] === "shipments") {
        return segs[2]
          ? { name: "shipmentDetail", params: { id: segs[2] }, app: true }
          : { name: "shipments", params: { query }, app: true };
      }
      if (segs[1] === "new") return { name: "newShipment", params: {}, app: true };
      if (segs[1] === "wallet") return { name: "wallet", params: {}, app: true };
      return { name: "notFound", params: {} };
    default: return { name: "notFound", params: {} };
  }
}

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function render() {
  const app = document.getElementById("app");
  const route = resolve(location.hash);
  const locale = store.getLocale();
  const t = createT(locale);
  const user = store.currentUser();

  // Guard authenticated routes.
  if (route.app && !user) {
    location.hash = "#/login";
    return;
  }

  const view = VIEWS[route.name] || views.notFound;
  const ctx = { t, locale, user, params: route.params, navigate, rerender: render };

  app.innerHTML =
    demoBanner(t) +
    renderHeader({ t, locale, user, route: PUBLIC_ROUTES[route.name] || "" }) +
    view.render(ctx) +
    renderFooter({ t });

  view.hydrate?.(ctx, app);
  window.scrollTo(0, 0);
}

function main() {
  store.init();
  document.documentElement.lang = store.getLocale();

  // Global actions present in the header / demo banner on every page.
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    switch (el.dataset.action) {
      case "locale":
        store.setLocale(el.dataset.locale);
        document.documentElement.lang = el.dataset.locale;
        render();
        break;
      case "logout":
        store.logout();
        navigate("#/");
        break;
      case "reset":
        store.resetDemo();
        render();
        toast(createT(store.getLocale())("Demo.reseted"));
        break;
      default:
        break; // view-specific data-action handlers are wired in hydrate
    }
  });

  window.addEventListener("hashchange", render);
  render();
}

main();
