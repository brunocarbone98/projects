# Deploying Shipping Hub (Option B)

PersonalWebsite is static, so it lives on GitHub Pages. **Shipping Hub
(`FullStackHub/`) is a full-stack app** (Next.js SSR + Express API + PostgreSQL +
two Python services), so it needs real hosting — GitHub Pages can't run it.

**Option B** splits it across the best free-tier homes:

| Piece | Platform |
|---|---|
| Web (Next.js) | **Vercel** |
| API + pricing + labels | **Render** (via [`render.yaml`](./render.yaml)) |
| PostgreSQL | **Neon** |

All the configs are already in the repo; below is the click-path. You only need
free accounts on Neon, Render and Vercel (all connect to this GitHub repo).

---

## 1. Database — Neon
1. Create a project at [neon.tech](https://neon.tech).
2. Copy the **connection string** (looks like `postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`). This is your `DATABASE_URL`.

## 2. Backend — Render (API + Python services)
1. At [render.com](https://render.com) → **New → Blueprint** → pick this repo. Render reads the root [`render.yaml`](./render.yaml) and creates three services: `shipping-hub-api`, `shipping-hub-pricing`, `shipping-hub-labels`.
2. On **`shipping-hub-api`**, set the env vars marked manual:
   - `DATABASE_URL` → your Neon string (step 1)
   - `PRICING_SERVICE_URL` → `https://shipping-hub-pricing.onrender.com`
   - `LABELS_SERVICE_URL` → `https://shipping-hub-labels.onrender.com`
   - `CORS_ORIGINS` and `PUBLIC_WEB_URL` → leave blank for now (you'll fill them with the Vercel URL in step 4)
   - (`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` are auto-generated)
3. The API runs `prisma migrate deploy` automatically on boot. To load the demo data, open the **Shell** tab of `shipping-hub-api` and run:
   ```bash
   pnpm db:seed
   ```
4. Note the API's public URL, e.g. `https://shipping-hub-api.onrender.com`.

## 3. Web — Vercel
1. At [vercel.com](https://vercel.com) → **Add New → Project** → import this repo.
2. **Root Directory:** `FullStackHub/apps/web` (Vercel auto-detects the pnpm workspace and Next.js).
3. **Environment variables:**
   - `API_INTERNAL_URL` → your Render API URL (`https://shipping-hub-api.onrender.com`)
   - `NEXT_PUBLIC_API_URL` → the same Render API URL
   - `NEXT_PUBLIC_SITE_URL` → your Vercel URL (e.g. `https://shipping-hub.vercel.app`)
4. **Deploy.** Your public link is the Vercel URL. 🎉

## 4. Wire the two together (one-time)
Back on Render → `shipping-hub-api`, set:
- `CORS_ORIGINS` → your Vercel URL
- `PUBLIC_WEB_URL` → your Vercel URL

Save (the API redeploys). Now the public tracking links and notifications point at the live web app.

---

## Verify
- `https://shipping-hub-api.onrender.com/health` → `{"status":"ok"}`
- `https://<your-vercel-url>/en/tracking/PTY-2026-001001-0` → the SSR tracking page
- Sign in with a demo account (`ana@example.com` / `Password123!`) and open the wallet.

## Notes
- **Free tiers sleep:** Render free services spin down after ~15 min idle (slow first hit); Neon free has compute limits. Fine for a portfolio demo.
- **Notifications** (`RESEND_API_KEY`, `WEBHOOK_URL`, …) are optional — see `FullStackHub/apps/api/.env.example`.
- The `services/*/Dockerfile` and `apps/*/Dockerfile` also work for an all-in-one Render or any container host if you prefer not to split across platforms.
