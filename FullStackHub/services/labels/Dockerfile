# Stateless label microservice (FastAPI + ReportLab).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Install dependencies first to leverage Docker layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application source (pure rendering helpers + FastAPI wiring).
COPY label.py main.py ./

# Run as an unprivileged user: the service only reads its code and answers HTTP.
RUN useradd --system --no-create-home --shell /usr/sbin/nologin app
USER app

EXPOSE 8002

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8002"]
