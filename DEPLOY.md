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
On the **app** service (not the database) → **Variables**, add just two:
```
DATABASE_URL       = ${{Postgres.DATABASE_URL}}
JWT_ACCESS_SECRET  = <a long random string, at least 32 characters>
```

> **`JWT_REFRESH_SECRET` is no longer read.** Refresh tokens are opaque random strings that the API
> stores as SHA-256 hashes, so they never needed a key. A deployment that still has the variable
> starts as before (the API ignores variables it does not read); delete it from the service's
> **Variables** whenever convenient.

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
public domain, used for tracking links / CORS.) Generate the secret with e.g.
`openssl rand -hex 32` (64 characters): the API refuses to start with a secret shorter than 32
characters, and its boot log names the variable.

## 3. One port, one domain
The container exposes the web on port **8080**. Service → Settings →
**Networking → Generate Domain** (if it asks for the port, enter **8080**).
**That domain is your public URL.** 🎉

## 4. Deploy, migrate, seed
- Railway builds the image and starts it. The container **runs `prisma migrate
  deploy` on boot**, so the schema is created automatically.
- **Health check:** `railway.json` makes Railway wait for `GET /api/health` to answer `200`
  — the web server and the API behind it both up — before a new deployment takes traffic
  (up to 300 s). A release that cannot start (a missing variable, a short JWT secret, a failed
  migration) never replaces the running one; its deploy log says why.
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
the new table — never a second issue. The next healthy run (every probe passed) comments
`Recovered — all probes green at <UTC time>` with the run link and closes the issue as completed.

**Unobserved runs.** Railway's edge (server `railway-hikari`) may answer automated clients with
its bot protection instead of the app: HTTP 429, or an HTTP 200 "Checking your browser…" page.
The probe reports such answers as `🛡️ challenged`; when no probe failed and at least one was
challenged, the run ends as **Unobserved** (`healthy=unknown`): the job ends green with a warning annotation and an
explanation in its summary, no incident is opened, updated or closed, and the badge turns red only
on a confirmed failure. Open
the app in a browser to see its real state, and decide in Railway's service settings whether
automated monitors should be allowed through.

**What a human does.**

1. Railway → the app service → **Deployments** → read the latest deploy log. If the boot log
   says `FATAL: DATABASE_URL is empty`, fix the variable as described in section 2 (pick the
   Postgres service from the `${{` dropdown; never type the reference by hand) and redeploy.
2. Otherwise **Restart** the latest deployment (or redeploy) and watch the log until the web
   answers on `/en`. The container already restarts itself when a process exits
   (`restartPolicyType: ON_FAILURE` in `railway.json`), so a persistent incident usually means
   configuration or the database.
3. If the database is the problem, open the Postgres service in Railway and check its status.
4. Nothing to do on GitHub: the issue closes itself on the next healthy run.

The **SRE patrol** shift (every 6 hours) reads these results: when the cause is in the
repository (the workflow, a URL, `start.sh`, `Dockerfile`) it opens a fix PR; when it is the
hosting it comments the diagnosis and the human action once on the incident issue. The whole
loop is described in [`OPERATIONS.md`](./OPERATIONS.md) → Incident flow.

## Notes
- **One container, several processes:** the web, API and Python services run
  together (the web is the public entrypoint, the rest stay on `localhost`). It's a
  pragmatic packaging for a portfolio — the code is still four separate apps. If
  any process exits, the container restarts. Every process runs as the image's unprivileged
  `node` user, never root.
- **Rate limits per visitor:** the web reaches the API over `localhost` (Railway publishes only
  the web's port), so the web forwards each visitor's address and the API trusts it from loopback only. The address is
  the public one Railway's edge puts in `X-Real-IP` (Railway docs: Networking → Public Networking →
  Specs & Limits → Request Headers); `X-Forwarded-For` is not read. Tracking and quotes are limited
  per visitor; every 15 minutes a visitor gets 10 failed logins per account and 30 in all, 10
  registrations, 60 session refreshes and 60 sign-outs (a signed-in browser refreshes about once
  every 15 minutes). Every limit counts per visitor address, so nobody can lock anyone else out of
  an account (the public demo accounts included). Visitors who share one public address (an office
  network, a mobile carrier's NAT) share its budget too: past 60 refreshes in 15 minutes from that
  address, the next visitor whose access token expires is sent to the login page (a `429` is not
  a lost session, so the cookies stay) and signing in again works, because login counts only
  failures. The limits live in memory: a restart clears them. To check after a deploy:
  the 11th wrong password in a row for one account answers "Too many attempts", and the right
  password still signs in from another network (a phone on mobile data).
- **Local dev is unchanged:** `docker compose up -d` (Postgres + the Python
  services) and `pnpm dev` (web + api) — see `FullStackHub/README.md`. An `apps/api/.env`
  copied before #74 needs the `JWT_ACCESS_SECRET` line from `.env.example` again: the API refuses
  a secret shorter than 32 characters (SecureGate's `run-local-stack.ps1` updates it itself). A
  `JWT_REFRESH_SECRET` line left in it is ignored.
- **Sessions:** the web's session cookies live exactly as long as their tokens: the API sends both
  lifetimes with every token pair (`expiresIn`, and `refreshExpiresIn` from
  `REFRESH_TOKEN_TTL_DAYS`, 7 days by default). A refresh token is single use, and the tokens one
  sign-in produces by rotation form a family. A token presented again more than 30 seconds after it
  was used or revoked is taken for a stolen copy: the live refresh token of its family is revoked, so
  that sign-in ends; the user's other sign-ins, and other visitors of a shared demo account, are not
  touched. Access tokens already issued stay valid until they expire (`ACCESS_TOKEN_TTL`, 15 minutes
  by default). The API log says `reuse of a revoked refresh token of user <id>`. A refresh token that
  can never work again (unknown, expired, or replayed past those 30 seconds) gets
  `401 SESSION_ENDED`, and the web then deletes the session cookies, so a browser stops sending it.
  Within the 30 seconds (two tabs of one browser refreshing at once) the answer is a plain
  `401 INVALID_TOKEN`, nothing else is revoked and the cookies stay. The web shares one refresh
  among the requests one browser sends at once, and hands the new pair only to requests from the
  same address and `User-Agent`; a copy of the old token sent from anywhere else reaches the API
  and is refused there. The token family is a database column: the migrations
  `20261111120000_refresh_token_families` and `20261111130000_refresh_token_family_default` run on
  the next deploy (`pnpm db:deploy` in `start.sh`), and each token issued before them is a family of
  its own. The column has a database default, so the previous release keeps signing people in
  while the new one boots, and again after a **rollback** (Railway's redeploy of an earlier
  deployment, or a revert): migrations are never reverted, and nothing needs undoing by hand.
- Railway is usage-based (a small trial credit, then pay-as-you-go); nothing sleeps.
- **Notifications** (`RESEND_API_KEY`, `WEBHOOK_URL`, …) are optional — see
  `FullStackHub/apps/api/.env.example`.
