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
On the service → **Variables**, add just three:
```
DATABASE_URL       = ${{Postgres.DATABASE_URL}}
JWT_ACCESS_SECRET  = <a long random string>
JWT_REFRESH_SECRET = <a different long random string>
```
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
- `https://<your-domain>/en/tracking/PTY-2026-001001-0` → the SSR tracking page
- Sign in with a demo account (`ana@example.com` / `Password123!`) and open the wallet.

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
