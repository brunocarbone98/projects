# Stateless pricing microservice (FastAPI). Origin is always Panama.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Install dependencies first to leverage Docker layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application source (pure helpers + FastAPI wiring).
COPY holidays.py pricing.py main.py ./

EXPOSE 8001

# Bind IPv6 (::) and the platform's $PORT so the service is reachable over
# Railway's private network; falls back to 8001 for local `docker compose`.
CMD ["sh", "-c", "uvicorn main:app --host :: --port ${PORT:-8001}"]
