# Deploying Shipping Hub on Railway

PersonalWebsite is static, so it lives on GitHub Pages. **Shipping Hub
(`FullStackHub/`)** is a full-stack app (Next.js SSR + Express API + PostgreSQL +
two Python services), so it needs real hosting. We run the whole thing on
**[Railway](https://railway.app)** — one project, one dashboard, one bill.

Railway gives every service a private hostname (`<service>.railway.internal`) and
a managed PostgreSQL, so the pieces talk over a **private network** and only the
web app is exposed publicly.

```
            ┌──────────────── Railway project ─────────────────┐
 Internet ─▶│  web (Next.js, public)                           │
            │     └─ API_INTERNAL_URL ─▶ api (Express, private) │
            │                              ├─▶ pricing (private)│
            │                              ├─▶ labels  (private)│
            │                              └─▶ Postgres (managed)
            └──────────────────────────────────────────────────┘
```

## 0. Prerequisites
- A Railway account (railway.app) connected to your GitHub.
- This repo pushed to GitHub.

## 1. Create the project + database
1. Railway → **New Project** → **Deploy from GitHub repo** → pick this repo.
   (You can delete the service Railway auto-creates; we add each one explicitly.)
2. In the project, **New → Database → Add PostgreSQL**. Railway provisions it and
   exposes a `DATABASE_URL` you can reference as `${{Postgres.DATABASE_URL}}`.

## 2. Add the four services
Each service's **build (Dockerfile) and deploy settings are codified in a
`railway.json`** (Dockerfile builder, no-sleep, IPv6 egress, restart-on-failure,
SFO region), so you mostly just point Railway at the right folder.

For each: **New → GitHub Repo → this repo**, then in **Settings** set the **Root
Directory** and the **Config-as-code** path:

| Service name | Root Directory | Config file |
|---|---|---|
| `api` | `FullStackHub` | `apps/api/railway.json` |
| `web` | `FullStackHub` | `apps/web/railway.json` |
| `pricing` | `FullStackHub/services/pricing` | `railway.json` (auto) |
| `labels` | `FullStackHub/services/labels` | `railway.json` (auto) |

The `api`/`web` Dockerfiles need the whole `FullStackHub` folder as their build
context, so their Root Directory is `FullStackHub` and you set the Config-as-code
path to their `railway.json` under `apps/`. `pricing`/`labels` build from their own
folder and read `railway.json` automatically.

> **Name the services exactly `api`, `web`, `pricing`, `labels`** — the reference
> variables below use those names.

## 3. Environment variables
Railway **reference variables** wire the services together. In each service →
**Variables**, add:

**`api`**
```
DATABASE_URL        = ${{Postgres.DATABASE_URL}}
JWT_ACCESS_SECRET   = <a long random string>
JWT_REFRESH_SECRET  = <a different long random string>
PRICING_SERVICE_URL = http://${{pricing.RAILWAY_PRIVATE_DOMAIN}}:${{pricing.PORT}}
LABELS_SERVICE_URL  = http://${{labels.RAILWAY_PRIVATE_DOMAIN}}:${{labels.PORT}}
CORS_ORIGINS        = https://${{web.RAILWAY_PUBLIC_DOMAIN}}
PUBLIC_WEB_URL      = https://${{web.RAILWAY_PUBLIC_DOMAIN}}
```

**`web`**
```
API_INTERNAL_URL    = http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}
```

**`pricing` / `labels`** — nothing; they bind Railway's `$PORT` automatically.

Generate the two secrets with e.g. `openssl rand -hex 32`. The `api` ↔ services
and `web` → `api` traffic all stays on the private network.

> **`NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_SITE_URL` are optional.** They're baked
> into the web image at build time (Docker builds don't read runtime variables),
> and only drive the footer "API docs" link and SEO canonical tags — the app is
> fully functional over the private network without them.

## 4. Public domains
- **`web`** → Settings → **Networking → Generate Domain**. **That domain is your public site URL.**
- **`api`** → Generate a domain too (so you can curl `/health` and open `/api/v1/docs`). Recommended.
- **`pricing` / `labels`** → no public domain (private only).

Private networking and `RAILWAY_PRIVATE_DOMAIN` are on by default; the Python
services listen on IPv6 (`::`) so they're reachable internally.

## 5. Deploy, migrate, seed
- Railway builds and deploys each service. The **`api` runs `prisma migrate deploy`
  on boot**, so the schema is created automatically.
- Load the demo data (22 customers, 60 shipments, wallet activity) once — easiest
  with the Railway CLI:
  ```bash
  npm i -g @railway/cli
  railway login
  railway link                      # pick this project
  railway run --service api pnpm db:seed
  ```
  (Or temporarily set the `api` start command to
  `pnpm prisma migrate deploy && pnpm db:seed && pnpm start` for one deploy, then revert.)

## 6. Your URL 🎉
Open the **`web`** service's generated domain — that's the public site.

## Verify
- `https://<api-domain>/health` → `{"status":"ok"}`
- `https://<web-domain>/en/tracking/PTY-2026-001001-0` → the SSR tracking page
- Sign in with a demo account (`ana@example.com` / `Password123!`) and open the wallet.

## Notes
- **Pricing:** Railway is usage-based (a small trial credit, then pay-as-you-go);
  services don't sleep.
- **Container images** are in `apps/api/Dockerfile`, `apps/web/Dockerfile` and
  `services/*/Dockerfile` — the same ones used for local `docker compose`.
- **Notifications** (`RESEND_API_KEY`, `WEBHOOK_URL`, …) are optional — see
  `FullStackHub/apps/api/.env.example`.
