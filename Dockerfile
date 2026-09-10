FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

RUN groupadd --system hermes && useradd --system --gid hermes --home /app hermes \
    && mkdir -p /data && chown hermes:hermes /data

COPY --chown=hermes:hermes . /app
USER hermes

EXPOSE 8080
CMD ["python3", "-m", "backend.cli", "server"]
