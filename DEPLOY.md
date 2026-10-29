# Deploying Shipping Hub on Railway

PersonalWebsite is static (GitHub Pages). **Shipping Hub (`FullStackHub/`)** is a
full-stack app (Next.js SSR + Express API + PostgreSQL + two Python services). It
deploys to **[Railway](https://railway.app)** as **one service**: the root
[`Dockerfile`](./Dockerfile) builds and runs all four processes in a single
container — the Next.js **web** is the only public process (on Railway's `$PORT`),
and the API + the two Python services run on fixed `localhost` ports inside the
container. PostgreSQL is Railway's managed database.

```
        ┌──────── one Railway service (the root Dockerfile) ────────┐
Internet ─▶ web :$PORT (public)
        │      └─ http://127.0.0.1:4000 ─▶ api                       │
        │                                   ├─▶ 127.0.0.1:8001 pricing
        │                                   └─▶ 127.0.0.1:8002 labels │
        └───────────────────────────────────────────────────────────┘
                                  └─▶ Postgres (managed · DATABASE_URL)
```

## 0. Prerequisites
- A Railway account connected to your GitHub.
- This repo on GitHub.

## 1. Create the project + database
1. Railway → **New Project → Deploy from GitHub repo** → pick this repo. Railway
   auto-detects the root **`Dockerfile`** and **`railway.json`** beside it — no root
   directory or Dockerfile path to set. The config pins the Dockerfile builder,
   no-sleep, restart-on-failure, the SFO region, and **watch paths** so only
   changes under `FullStackHub/**` (or the Dockerfile/start script) trigger a redeploy.
2. **New → Database → Add PostgreSQL.**

## 2. Environment variables
On the **app** service (not the database) → **Variables**, add just three:
```
DATABASE_URL       = ${{Postgres.DATABASE_URL}}
JWT_ACCESS_SECRET  = <a long random string>
JWT_REFRESH_SECRET = <a different long random string>
```

> **Get `DATABASE_URL` right — this is the #1 deploy gotcha.** `${{Postgres.…}}`
> only resolves if `Postgres` is the **exact** name of your database service; if
> yours is called `PostgreSQL` (or anything else) a hand-typed reference resolves
> to an **empty string** and the API crash-loops. So don't type it by hand:
> click **New Variable**, name it `DATABASE_URL`, and in the value field type
> `${{` — Railway pops a **dropdown**; pick your Postgres service → `DATABASE_URL`.
> After saving, the variable should show a resolved `postgresql://…` value, not
> the literal `${{…}}` text. (If it's empty, the boot log now says exactly this.)

That's all — the internal URLs (web→api, api→pricing/labels) are hard-wired to
`localhost` inside the image. (Optional: `PUBLIC_WEB_URL` / `CORS_ORIGINS` = your
public domain, used for tracking links / CORS.) Generate the secrets with e.g.
`openssl rand -hex 32`.

## 3. One port, one domain
The container exposes the web on port **8080**. Service → Settings →
**Networking → Generate Domain** (if it asks for the port, enter **8080**).
**That domain is your public URL.** 🎉

## 4. Deploy, migrate, seed
- Railway builds the image and starts it. The container **runs `prisma migrate
  deploy` on boot**, so the schema is created automatically.
- Load the demo data (22 customers, 60 shipments, wallet activity) once from your
  machine, using the database's **public** URL (Railway → your Postgres →
  Variables → `DATABASE_PUBLIC_URL`):
  ```bash
  cd FullStackHub && pnpm install
  DATABASE_URL="<paste DATABASE_PUBLIC_URL>" pnpm --filter @shipping-hub/api db:seed
  ```

## Verify
This project is deployed live at **<https://shipping-hub.up.railway.app/>**. On your own
domain:
- `https://<your-domain>/en/tracking/PTY-2026-001001-0` → the SSR tracking page
- Sign in with a demo account (`ana@example.com` / `Password123!`) and open the wallet.

## Monitoring & incidents
The live app is watched by the **Uptime patrol** workflow
([`.github/workflows/uptime-patrol.yml`](./.github/workflows/uptime-patrol.yml)): every 30
minutes, and on demand from the Actions tab (Uptime patrol → **Run workflow**). It checks out one commit (`fetch-depth: 1`) only to run
[`.github/scripts/uptime-probe.sh`](./.github/scripts/uptime-probe.sh) — the probe logic, runnable
locally with `BASE_URL=https://shipping-hub.up.railway.app .github/scripts/uptime-probe.sh` — needs
no repository secrets, and only probes `https://shipping-hub.up.railway.app`:

| Probe | Expected |
| --- | --- |
| `/en` | 200 — the landing page renders |
| `/en/tracking/PTY-2026-001001-0` | 200 **and** the body contains `PTY-2026-001001-0` — SSR plus a real database read of the seeded demo shipment |
| `/es/quote` | 200 — the Spanish quote page |
| `/sitemap.xml` | 200 — the generated sitemap |

Each probe is a `curl` with two retries. The results (endpoint · status · time · result) go to
the run's step summary, and the run fails when any probe fails, so the README badge turns red.

**Incident issue lifecycle.** When a probe fails, the workflow opens
`🚨 Production incident: Shipping Hub is unhealthy` (label `incident`) with the probe table,
the run link and what a human should check. Every further failing run adds one comment with
the new table — never a second issue. The first green run afterwards comments
`Recovered — all probes green at <UTC time>` with the run link and closes the issue as completed.

**What a human does.**

1. Railway → the app service → **Deployments** → read the latest deploy log. If the boot log
   says `FATAL: DATABASE_URL is empty`, fix the variable as described in section 2 (pick the
   Postgres service from the `${{` dropdown; never type the reference by hand) and redeploy.
2. Otherwise **Restart** the latest deployment (or redeploy) and watch the log until the web
   answers on `/en`. The container already restarts itself when a process exits
   (`restartPolicyType: ON_FAILURE` in `railway.json`), so a persistent incident usually means
   configuration or the database.
3. If the database is the problem, open the Postgres service in Railway and check its status.
4. Nothing to do on GitHub: the issue closes itself on the next green run.

The **SRE patrol** shift (every 6 hours) reads these results: when the cause is in the
repository (the workflow, a URL, `start.sh`, `Dockerfile`) it opens a fix PR; when it is the
hosting it comments the diagnosis and the human action once on the incident issue. The whole
loop is described in [`OPERATIONS.md`](./OPERATIONS.md) → Incident flow.

## Notes
- **One container, several processes:** the web, API and Python services run
  together (the web is the public entrypoint, the rest stay on `localhost`). It's a
  pragmatic packaging for a portfolio — the code is still four separate apps. If
  any process exits, the container restarts.
- **Local dev is unchanged:** `docker compose up -d` (Postgres + the Python
  services) and `pnpm dev` (web + api) — see `FullStackHub/README.md`.
- Railway is usage-based (a small trial credit, then pay-as-you-go); nothing sleeps.
- **Notifications** (`RESEND_API_KEY`, `WEBHOOK_URL`, …) are optional — see
  `FullStackHub/apps/api/.env.example`.
