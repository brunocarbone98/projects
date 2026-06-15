# Shipping Hub — interactive static demo

A **client-side, zero-backend** version of [Shipping Hub](../FullStackHub) that runs
entirely in the browser, so it can be hosted as plain static files on **GitHub Pages**
(just like the personal site) and explored in one click — no servers to spin up.

**▶ Live:** <https://brunocarbone98.github.io/projects/ShippingHubDemo/>

> This is one of **two** versions of the same product:
>
> | | [`../FullStackHub`](../FullStackHub) | `ShippingHubDemo` (this folder) |
> |---|---|---|
> | What | The real distributed system | A browser-only simulation of it |
> | Stack | Next.js · Express · PostgreSQL · FastAPI | Vanilla ES modules + localStorage |
> | Data | PostgreSQL (shared, server-side) | `localStorage` (per browser, on your device) |
> | Hosting | [Railway](https://shipping-hub.up.railway.app/) (needs a runtime) | GitHub Pages (static files) |
> | Use it for | Showing the architecture | Letting anyone try the UX instantly |

The full-stack version is live at **<https://shipping-hub.up.railway.app/>**.

## What you can do

Everything is interactive and persists in your browser:

- **Track a parcel** — paste `PTY-2026-001001-0` (or any seeded code) to see status, a
  route map and the full append-only event timeline.
- **Get a quote** — zone pricing + business-day ETA, computed live.
- **Sign in** and use the dashboard: shipment history, a **4-step create-shipment wizard**
  (which mints a real Luhn-checked tracking number), and a **wallet** with a double-entry
  ledger you top up and pay labels from.
- **Staff view** — sign in as an admin/courier to see every shipment and register tracking
  events (only transitions the state machine allows).
- Switch **es / en** any time, and **Reset demo data** from the top bar.

### Demo accounts (password `Password123!`)

| Email | Role |
|---|---|
| `ana@example.com`, `luis@example.com` | Customer |
| `admin@shippinghub.test` | Admin |
| `courier@shippinghub.test` | Courier |

…plus 20 more seeded customer profiles, each with their own shipments and wallet activity (so the staff "all shipments" view and the data feel realistic).

## How it works

The "backend" is reimplemented in the browser, reusing the **exact domain logic** of the
full-stack app:

- [`assets/domain.js`](assets/domain.js) — a faithful port of `packages/shared`
  (Luhn tracking codes, the shipment **state machine**, enums) and `services/pricing`
  (zone pricing + business-day/holiday ETA). The Node checks confirm the maths matches.
- [`assets/store.js`](assets/store.js) — a `localStorage`-backed store that plays the role
  of the Express API + PostgreSQL: **append-only** tracking events and ledger,
  **idempotent** money movements (double-click safe), and **state-machine-validated**
  transitions.
- [`assets/i18n.js`](assets/i18n.js) — the es/en copy, lifted from the app's `next-intl`
  message catalogs.
- `views.js` / `ui.js` / `app.js` — a tiny hash router and the views.

Styling uses Tailwind (Play CDN) with the same brand palette; the map uses Leaflet +
OpenStreetMap.

## Run it locally

It's just static files — serve the folder with anything:

```bash
cd ShippingHubDemo
python3 -m http.server 8099   # then open http://localhost:8099
```

(ES modules need to be served over HTTP, not opened as `file://`.)

## Honest limitations

- It's a **simulation**, not the real system: there's no server, no real authentication,
  and the data is **only in your browser** (not shared between devices, and cleared if you
  wipe site data or hit **Reset demo data**).
- The map tiles and the CSS load from public CDNs, so the live demo needs internet.
- For the production-grade architecture (real DB, services, JWT auth, double-entry ledger
  enforced server-side), see the live app at <https://shipping-hub.up.railway.app/>,
  [`../FullStackHub`](../FullStackHub) and `../DEPLOY.md`.
