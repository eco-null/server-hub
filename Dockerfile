# syntax=docker/dockerfile:1

# ---- build stage: install pinned dependencies into a virtualenv ----------------
FROM python:3.14-slim AS build

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.lock /tmp/requirements.lock
# Every file is verified against the sha256 hashes in the lock file.
RUN pip install --require-hashes --no-deps -r /tmp/requirements.lock

COPY serverhub /app/serverhub
COPY web /app/web
# Pre-compile bytecode: the runtime root filesystem is read-only.
RUN python -m compileall -q /app/serverhub /opt/venv/lib

# ---- runtime stage --------------------------------------------------------------
FROM python:3.14-slim

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SERVERHUB_DATA_DIR=/data \
    SERVERHUB_HOST=0.0.0.0 \
    SERVERHUB_PORT=8642

RUN groupadd --system --gid 10001 serverhub \
    && useradd --system --uid 10001 --gid serverhub --home-dir /nonexistent \
       --no-create-home --shell /usr/sbin/nologin serverhub \
    && mkdir -p /data \
    && chown serverhub:serverhub /data \
    && chmod 0700 /data

COPY --from=build /opt/venv /opt/venv
COPY --from=build /app /app

WORKDIR /app
USER serverhub:serverhub
VOLUME ["/data"]
EXPOSE 8642

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "-m", "serverhub", "healthcheck"]

STOPSIGNAL SIGTERM
ENTRYPOINT ["python", "-m", "serverhub"]
CMD ["serve"]
