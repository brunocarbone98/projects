# services/labels

Microservicio FastAPI de etiquetas: `POST /label` recibe los datos del envío y devuelve un PDF 4×6 con código de barras Code-128 (`reportlab` + `python-barcode`) y QR a la URL pública de rastreo. Se implementa en la **Fase 4** — ver `ROADMAP.md`.

**Regla de oro:** este servicio es sin estado y **nunca toca la base de datos**. Solo `apps/api` escribe en PostgreSQL.
