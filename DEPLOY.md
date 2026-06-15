# Deploying Shipping Hub

PersonalWebsite is static, so it lives on GitHub Pages. **Shipping Hub
(`FullStackHub/`) is a full-stack app** (Next.js SSR + Express API + PostgreSQL +
two Python services), so it needs real hosting — GitHub Pages can't run it.

Two paths, same repo:

| | Where everything runs | Best for |
|---|---|---|
| **Option A — all on Render** | Web + API + Python services + PostgreSQL, all on **Render** | One account, one dashboard, one bill. Recommended. |
| **Option B — split** | **Vercel** (web) · **Render** (API + Python) · **Neon** (PostgreSQL) | Squeezing the most out of each platform's free tier. |

Both read the same blueprint ([`render.yaml`](./render.yaml)) and Dockerfiles
that already live in the repo.

---

## Option A — everything on Render

One [`render.yaml`](./render.yaml) blueprint stands up **five** resources: the
web app, the API, the two Python services, and a managed PostgreSQL database.
Most of the wiring is automatic.

### 1. Create the blueprint
1. At [render.com](https://render.com) → **New → Blueprint** → connect this repo.
2. Render parses the root `render.yaml` and shows the plan: a Postgres database
   (`shipping-hub-db`) plus four web services — `shipping-hub-api`,
   `shipping-hub-web`, `shipping-hub-pricing`, `shipping-hub-labels`. Click
   **Apply**.

Render wires these for you automatically:
- **`DATABASE_URL`** → the managed database's internal connection string.
- **`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`** → generated secrets.
- **`PRICING_SERVICE_URL` / `LABELS_SERVICE_URL`** → the API reaches the Python
  services over Render's private network (`http://shipping-hub-pricing:8001`, …).
- **`API_INTERNAL_URL`** → the web app reaches the API the same private way
  (`http://shipping-hub-api:4000`). All real traffic — tracking, quoting, auth,
  wallet — flows through this, so the app works the moment it boots.

The API runs `prisma migrate deploy` on every boot, so the schema is created
automatically.

### 2. Set the four public URLs (one time)
The only values Render can't know until the services exist are the public URLs.
After the first deploy, copy each service's `…onrender.com` URL from its page and
set:

| Service | Variable | Value |
|---|---|---|
| `shipping-hub-api` | `CORS_ORIGINS` | the **web** URL, e.g. `https://shipping-hub-web.onrender.com` |
| `shipping-hub-api` | `PUBLIC_WEB_URL` | the **web** URL (used in tracking links / notifications) |
| `shipping-hub-web` | `NEXT_PUBLIC_API_URL` | the **API** URL, e.g. `https://shipping-hub-api.onrender.com` |
| `shipping-hub-web` | `NEXT_PUBLIC_SITE_URL` | the **web** URL (its own address) |

Save each — Render redeploys the affected service. (`NEXT_PUBLIC_*` are baked
into the web image at build time, so the web service rebuilds; they only drive
the footer "API docs" link and SEO canonical tags.)

### 3. Seed the demo data (optional)
Open the **Shell** tab of `shipping-hub-api` and run:
```bash
pnpm db:seed
```
This loads 10 shipments across every state plus the demo accounts.

Your public link is the **`shipping-hub-web`** URL. 🎉

---

## Option B — Vercel + Render + Neon

Prefer to keep the web on Vercel's edge and use Neon's Postgres? The same repo
supports it.

### 1. Database — Neon
1. Create a project at [neon.tech](https://neon.tech).
2. Copy the **connection string** (`postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`). This is your `DATABASE_URL`.

### 2. Backend — Render (API + Python services only)
1. Deploy the blueprint as in Option A, but **skip / delete** the
   `shipping-hub-web` service and the `shipping-hub-db` database (you're using
   Vercel and Neon for those).
2. On **`shipping-hub-api`**, override:
   - `DATABASE_URL` → your Neon string (step 1)
   - `CORS_ORIGINS` and `PUBLIC_WEB_URL` → your Vercel URL (after step 3)
   - (`PRICING_SERVICE_URL` / `LABELS_SERVICE_URL` already point at the Python
     services over the private network; leave them, or set the public
     `…onrender.com` URLs if you prefer.)
3. Note the API's public URL, e.g. `https://shipping-hub-api.onrender.com`.

### 3. Web — Vercel
1. At [vercel.com](https://vercel.com) → **Add New → Project** → import this repo.
2. **Root Directory:** `FullStackHub/apps/web` (Vercel auto-detects the pnpm workspace and Next.js).
3. **Environment variables:**
   - `API_INTERNAL_URL` → your Render API URL
   - `NEXT_PUBLIC_API_URL` → the same Render API URL
   - `NEXT_PUBLIC_SITE_URL` → your Vercel URL (e.g. `https://shipping-hub.vercel.app`)
4. **Deploy.** Your public link is the Vercel URL.

### 4. Wire them together
Back on Render → `shipping-hub-api`, set `CORS_ORIGINS` and `PUBLIC_WEB_URL` to
your Vercel URL. Save (the API redeploys).

---

## Verify (either option)
- `https://<api-url>/health` → `{"status":"ok"}`
- `https://<web-url>/en/tracking/PTY-2026-001001-0` → the SSR tracking page
- Sign in with a demo account (`ana@example.com` / `Password123!`) and open the wallet.

## Notes
- **Free tiers sleep / expire.** Render free web services spin down after ~15 min
  idle (slow first hit); a free Render/Neon database has limits and the free
  Render database is removed ~90 days after creation. Fine for a portfolio demo —
  bump to a paid plan for anything permanent.
- **Private networking** (Option A) keeps API↔services and web↔API traffic off the
  public internet. If you ever split a service onto another host, just point the
  matching `*_SERVICE_URL` / `API_INTERNAL_URL` at its public `…onrender.com` URL
  instead.
- **Notifications** (`RESEND_API_KEY`, `WEBHOOK_URL`, …) are optional — see
  `FullStackHub/apps/api/.env.example`.
