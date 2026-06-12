# services/pricing

Microservicio FastAPI de cotización: `POST /quote` recibe origen/destino/peso/servicio y devuelve precio + ETA (reglas por zona, días hábiles, festivos). Se implementa en la **Fase 4** — ver `ROADMAP.md`.

**Regla de oro:** este servicio es sin estado y **nunca toca la base de datos**. Solo `apps/api` escribe en PostgreSQL.
