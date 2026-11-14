# Deployment guide

This guide is for the person who runs Server Hub. The short version is in the [README](../README.md); this page explains the choices behind it. Every variable is listed in the [configuration table](../README.md#configuration) and in [`.env.example`](../.env.example).

Contents: [Compose file](#the-compose-file) · [Data volume](#data-volume-and-bind-mounts) · [Port](#changing-the-port) · [TLS](#tls) · [Tunnel or proxy](#running-behind-a-tunnel-or-proxy) · [First run and users](#first-run-and-users) · [Backups](#backups) · [Upgrades](#upgrades-and-rollback) · [Secret key](#secret-key) · [Outbound requests](#outbound-request-policy) · [Connection limits](#connection-limits) · [Health check and logs](#health-check-and-logs) · [Troubleshooting](#troubleshooting)

## The compose file

`compose.yaml` defines one service, `server-hub`, built from the `Dockerfile` in this repository. There is no reverse proxy, database server or other container.

| Setting | What it does |
|---|---|
| `build: .` and `image: server-hub:latest` | The image is built locally; nothing is pulled from a registry except the Python base image. |
| `env_file: .env` | Loads your configuration. |
| `environment:` `SERVERHUB_DATA_DIR`, `SERVERHUB_HOST`, `SERVERHUB_PORT` | Fixed inside the container (`/data`, `0.0.0.0`, `8642`). They override the same names in `.env`. Change the published port instead (below). |
| `ports: "${SERVERHUB_PUBLISH_PORT:-8642}:8642"` | Publishes the container port on all host interfaces. To bind it to one address, replace the list in `compose.override.yaml` (see [Local changes](#local-changes-composeoverrideyaml)), for example `"192.168.1.10:8642:8642"`. |
| `volumes: server-hub-data:/data` | Named volume with the SQLite database. |
| `read_only: true` and `tmpfs: /tmp` | The root filesystem cannot be written; only `/data` and a 16 MB in-memory `/tmp` can. The application files in the image cannot be modified at runtime. |
| `cap_drop: ALL` | Removes every Linux capability; the app needs none (it listens on a port above 1024). |
| `security_opt: no-new-privileges` | Processes in the container cannot gain privileges. |
| `pids_limit: 256` | Caps the number of processes. |
| `stop_grace_period: 20s` | Time Docker waits for a clean shutdown (the server allows 15 s for open requests). |
| `restart: unless-stopped` | Starts the container again after a crash or a reboot. |

The `Dockerfile` creates a system user `serverhub` with uid and gid `10001`, sets `/data` to mode `0700` owned by that user, and runs the server as that user. It declares a `HEALTHCHECK` (see [Health check and logs](#health-check-and-logs)).

### Local changes: compose.override.yaml

Do not edit `compose.yaml`: your edit would conflict on the next `git pull`. Put local changes (TLS certificates, a bind-mounted data directory, a restricted port binding) in a file named `compose.override.yaml` next to it. Docker Compose reads that file automatically on every `docker compose` command, merges it over `compose.yaml`, and Git ignores it (see `.gitignore`). Without the file, `compose.yaml` works as it is.

How the merge works: `environment` entries are merged by name; `volumes` entries are merged by the container path, so an entry for `/data` replaces the named volume and an entry for a new path such as `/certs` is added; a plain `ports` list is added to the original one (to replace it, tag the list `!override`, which needs Docker Compose 2.24 or newer). Check the result with `docker compose config`. If you start Compose with explicit `-f` options, the override file is not read automatically; list it yourself (`-f compose.yaml -f compose.override.yaml`).

## Data volume and bind mounts

The default is a named volume (`server-hub-data`). Docker creates it with the right owner, so nothing needs to be done.

If you prefer a directory on the host, mount it in `compose.override.yaml` (it replaces the named volume for `/data`) and set the owner yourself. The container runs as uid `10001` with a read-only root filesystem, so it cannot fix permissions:

```bash
mkdir -p data
sudo chown -R 10001:10001 data
chmod 700 data
```

```yaml
# compose.override.yaml
services:
  server-hub:
    volumes:
      - ./data:/data
```

The database is `serverhub.db` plus the SQLite journal files `serverhub.db-wal` and `serverhub.db-shm`. Do not copy these files while the server runs; use the `backup` command ([Backups](#backups)).

## Changing the port

Set the host port in `.env`:

```bash
SERVERHUB_PUBLISH_PORT=9000
```

Leave `SERVERHUB_PORT` alone: the container always listens on 8642. If you also use `SERVERHUB_PUBLIC_URL`, include the new port in it (`https://hub.example.org:9000`) and restart:

```bash
docker compose up -d
```

## TLS

Server Hub serves HTTPS itself when it has a certificate and a key. Set both `SERVERHUB_TLS_CERT_FILE` and `SERVERHUB_TLS_KEY_FILE`; the server refuses to start if only one is set or if a file does not exist. With TLS on, cookies are Secure (and use the `__Host-` prefix) and the server sends `Strict-Transport-Security` (`max-age=31536000; includeSubDomains`). Browsers remember that header for the host name, so only use TLS on a name where you intend to keep HTTPS.

The certificate and key are read once at start. After renewing, restart: `docker compose restart server-hub`.

### TLS with your own certificate

Use a full-chain PEM certificate and its private key from your own CA, from Let's Encrypt (for a private name, use the DNS challenge) or from a tool such as `tailscale cert`.

1. Put the files in a `certs` directory next to `compose.yaml`, and make them readable by uid `10001`, the user the container runs as. The container has no capabilities, so not even its root user could bypass file permissions; only the file mode and owner count. Copy real files, not symlinks: a symlink that points outside `certs` (as in Let's Encrypt's `live/` directory) is not visible inside the container.

   ```bash
   mkdir -p certs
   cp -L fullchain.pem privkey.pem certs/
   sudo chown 10001:10001 certs/privkey.pem
   chmod 600 certs/privkey.pem
   chmod 644 certs/fullchain.pem
   chmod 755 certs
   ```

   Create `certs` before the first start: if the host directory is missing, Docker creates an empty root-owned one and the server stops with `TLS file not found`.

2. Create `compose.override.yaml` next to `compose.yaml` (Git ignores it, so updates never conflict). Copy it as it is; the two paths are inside the container:

   ```yaml
   # compose.override.yaml: local settings, merged into compose.yaml automatically
   services:
     server-hub:
       volumes:
         - ./certs:/certs:ro
       environment:
         SERVERHUB_TLS_CERT_FILE: /certs/fullchain.pem
         SERVERHUB_TLS_KEY_FILE: /certs/privkey.pem
   ```

   The mount is read-only, which is all the server needs: it reads both files once at start and writes nothing to `/certs`. The container's root filesystem is read-only too, so there is nowhere else to put certificates; the volume is the only way in. (Setting the two variables in `.env` also works; use one place, not both.) With a different file name, change the paths to match.

3. In `.env`:

   ```bash
   SERVERHUB_PUBLIC_URL=https://hub.example.org:8642
   ```

   If you open the hub by a name, that name must be allowed: the host of `SERVERHUB_PUBLIC_URL` is allowed automatically; other names go into `SERVERHUB_ALLOWED_HOSTS`.

4. Restart and check:

   ```bash
   docker compose config -q   # the override file is valid
   docker compose up -d
   docker compose logs server-hub | grep listening
   ```

   The log line reads `Server Hub listening on https://0.0.0.0:8642`.

### TLS with a self-signed certificate

For a lab or a LAN name you do not want a public certificate for. Replace `hub.lan` and the IP address with your own:

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:4096 -sha256 -nodes -days 365 \
  -keyout certs/privkey.pem -out certs/fullchain.pem \
  -subj "/CN=hub.lan" \
  -addext "subjectAltName=DNS:hub.lan,IP:192.168.1.10"
sudo chown 10001:10001 certs/privkey.pem
chmod 600 certs/privkey.pem
```

Then follow steps 2 to 4 above (`chmod 755 certs` as in step 1 too, and `chmod 644 certs/fullchain.pem`). Browsers will warn until you trust `certs/fullchain.pem` on each client device. The `-addext` option needs OpenSSL 1.1.1 or newer.

## Running behind a tunnel or proxy

If you already run something that terminates TLS (a tunnel client, a proxy, a VPN gateway), leave the TLS variables empty and tell Server Hub about it:

```bash
SERVERHUB_PUBLIC_URL=https://hub.example.org
SERVERHUB_TRUSTED_PROXIES=172.18.0.0/16
SERVERHUB_ALLOWED_HOSTS=hub.example.org
```

- `SERVERHUB_PUBLIC_URL`: the URL people use. Its host is allowed, it is accepted as the `Origin` of state-changing requests, and an `https` URL turns Secure cookies on.
- `SERVERHUB_TRUSTED_PROXIES`: the source address (CIDR) of the proxy as Server Hub sees it (`172.18.0.0/16` above is only an example of a Docker network range). Only connections from these ranges may set `X-Forwarded-For` and `X-Forwarded-Proto`. Find the address in the proxy's own logs, or check the peer address the server sees. If you leave this empty, every visitor appears to come from the proxy, so rate limits and connection caps are shared by all of them. The proxy must overwrite `X-Forwarded-For` and `X-Forwarded-Proto` rather than pass client-supplied values through.
- `SERVERHUB_ALLOWED_HOSTS`: any other host name the proxy forwards in the `Host` header. If the proxy rewrites `Host` to an address or `localhost`, nothing is needed.

With an `https` public URL, no TLS in Server Hub and no trusted proxies configured, the server logs the "Secure cookies are on ... plain HTTP" warning. It is harmless if users only ever open the `https://` URL; setting `SERVERHUB_TRUSTED_PROXIES` silences it. Publish the port only to the proxy so nobody can bypass it: in `compose.override.yaml` write `ports: !override` followed by `- "127.0.0.1:8642:8642"` under the `server-hub` service (see [Local changes](#local-changes-composeoverrideyaml)).

## First run and users

While no account exists, the server prints a banner containing a setup token each time it starts:

```bash
docker compose logs server-hub | grep "SETUP TOKEN"
```

Open the site, and the login page shows the first-run form. Enter the token with an e-mail address, a username (3 to 20 letters, digits or underscores) and a password (10 to 128 characters). This account is the admin. The token is random per start; set `SERVERHUB_SETUP_TOKEN` (16 or more characters) in `.env` to fix it. Wrong tokens are rate limited to 10 attempts per hour per client address. Once an account exists the token is no longer used.

You can skip the web form and create the admin from the command line. This needs no token:

```bash
docker compose exec server-hub python -m serverhub create-admin --email you@example.org --username you
```

**Creating users.** Registration is closed by default. An admin can create accounts in the settings page (user management), or open registration there so people can sign up themselves (rate limited to 5 sign-ups per hour per client address). Opening registration on an instance that is reachable from the internet is a decision to make deliberately; consider also setting `SERVERHUB_ALLOW_PRIVATE_NETWORK_TARGETS=false` (see [Outbound requests](#outbound-request-policy)). The same switch is available over the API (`PUT /api/admin/config`, see [API.md](API.md#admin-role-admin)). The first account is always the admin; admins can promote other users, and the last admin cannot be removed or demoted.

## Backups

Everything (accounts, settings, services, bookmarks, encrypted 2FA secrets and Beszel passwords) is in the SQLite database. The `backup` command writes a consistent copy even while the server is running. The output file must not exist yet unless you pass `--force`.

```bash
docker compose exec server-hub python -m serverhub backup /data/backup-$(date +%F).db
docker compose cp server-hub:/data/backup-$(date +%F).db ./backups/
docker compose exec server-hub rm /data/backup-$(date +%F).db
```

The first command writes inside the data volume (the only writable place), the second copies the file to the host, the third removes the copy in the volume. Create `./backups` first.

A backup is only useful together with `SERVERHUB_SECRET_KEY`: store the key with it, but not in the same place as an off-site copy of the database if that location is not trusted.

**Schedule example (cron on the host).** Daily at 03:15, keeping 14 days. Run `crontab -e` and adjust the path:

```cron
15 3 * * * cd /opt/server-hub && f=backup-$(date +\%F).db && docker compose exec -T server-hub python -m serverhub backup /data/$f --force && docker compose cp server-hub:/data/$f ./backups/ && docker compose exec -T server-hub rm /data/$f && find ./backups -name 'backup-*.db' -mtime +14 -delete
```

Users can additionally export their own data (settings, services, bookmarks, no secrets) as JSON from the settings page; that is a per-user convenience and not a replacement for a database backup.

### Restoring a backup

Restoring replaces the whole database. Stop the server, copy the backup over `serverhub.db`, remove stale journal files, and start again. The one-shot container below runs as the same user (uid `10001`) so file ownership stays correct. Use the same `SERVERHUB_SECRET_KEY` the backup was made with.

```bash
docker compose stop server-hub
docker compose run --rm --no-deps \
  -v "$PWD/backups/backup-2026-11-14.db:/restore/backup.db:ro" \
  --entrypoint python server-hub -c \
  "import os, shutil; [os.path.exists('/data/serverhub.db'+s) and os.remove('/data/serverhub.db'+s) for s in ('-wal','-shm')]; shutil.copyfile('/restore/backup.db', '/data/serverhub.db')"
docker compose up -d
```

Replace the file name with your backup. Check `docker compose logs server-hub` and sign in. If you use a bind-mounted data directory you can instead stop the container, delete `serverhub.db-wal` and `serverhub.db-shm`, and copy the file over `serverhub.db` as the owner uid `10001`.

## Upgrades and rollback

Upgrade:

```bash
docker compose exec server-hub python -m serverhub backup /data/pre-upgrade.db
docker compose cp server-hub:/data/pre-upgrade.db ./backups/
git pull
docker compose up -d --build
docker compose logs --tail 50 server-hub
```

Schema migrations are numbered SQL files applied automatically at start; each one runs in a transaction. Read [CHANGELOG.md](../CHANGELOG.md) before upgrading.

Rollback: there are no down-migrations. If the new version applied a migration, an older build refuses to start on that database (`database schema version N is newer than this build supports`). To go back, check out the previous version, restore the backup you took before upgrading ([Restoring a backup](#restoring-a-backup)), and rebuild:

```bash
docker compose down
git checkout <previous-tag-or-commit>
# restore the pre-upgrade backup here
docker compose up -d --build
```

If a release has no schema change, you can roll back the code alone without restoring.

Version 2 does not migrate data from the previous (Supabase) version; it starts with an empty database.

## Secret key

`SERVERHUB_SECRET_KEY` must be at least 32 characters and is required. Generate one:

```bash
openssl rand -hex 24
# without openssl:
python -c "import secrets; print(secrets.token_hex(24))"
```

Sub-keys are derived from it for two purposes: encrypting TOTP secrets and Beszel passwords, and keying the hashes of 2FA recovery codes. Passwords (Argon2id) and sessions do not depend on it.

If you change or lose the key:

- everyone keeps their password and their sessions stay valid;
- every account with 2FA can no longer finish signing in, because the stored secret and recovery codes become unreadable (the 2FA step answers `invalid_code`). Recover each account on the server, then let the user enrol 2FA again:

  ```bash
  docker compose exec server-hub python -m serverhub reset-password --user NAME --disable-2fa
  ```

  An admin can also clear another user's 2FA in the settings page;
- Beszel instances show "Stored password cannot be decrypted"; re-enter their passwords in the Beszel settings.

Rotating the key is therefore a manual, disruptive operation: change the value in `.env`, `docker compose up -d`, then repair 2FA and Beszel entries as above. There is no re-encryption tool.

## Outbound request policy

Status checks and Beszel requests are made by the server, so they are restricted:

- Only `http` and `https` URLs without embedded credentials. Redirects are never followed and proxy environment variables are ignored.
- The host name is resolved once per connection and the connection goes to the validated address, which prevents DNS rebinding.
- Always blocked, whatever the settings: loopback (`127.0.0.0/8`, `::1`), link-local including cloud metadata (`169.254.0.0/16`, `fe80::/10`), "this network" (`0.0.0.0/8`), multicast, reserved and broadcast ranges, and addresses of known metadata services. IPv4 addresses embedded in IPv6 forms (mapped, NAT64, 6to4, Teredo) are checked as IPv4.
- Private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `fc00::/7`) are allowed while `SERVERHUB_ALLOW_PRIVATE_NETWORK_TARGETS=true` (the default, because a homelab dashboard points at LAN services). Set it to `false` on an internet-facing instance with open registration; status checks of LAN services then show `unknown`.
- Limits: 4 s connect, 6 s read, 10 s total per request, 2 MiB response cap, at most 8 concurrent and 240 requests per minute per user, 32 concurrent overall.

Because loopback is always blocked, a service on the same machine cannot be checked through `localhost`. Use the machine's LAN address. Inside the container, the host is reachable only through its network address, never `127.0.0.1`.

## Connection limits

The server answers many clients but protects itself from slow ones: a connection must send a complete request head (request line and headers) within 10 seconds; while a body is received, bytes must arrive at least every 10 seconds and the whole body within 120 seconds; idle keep-alive connections close after 5 seconds. Request bodies are limited to 64 KiB (4 MiB for backup import). Two caps limit open connections:

| Variable | Default | Meaning |
|---|---|---|
| `SERVERHUB_MAX_CONNECTIONS` | `512` | Total open connections. |
| `SERVERHUB_MAX_CONNECTIONS_PER_IP` | `32` | Per client address (IPv6 per /64). Loopback and trusted proxies are exempt from this cap, not from the total. |

Excess connections are closed immediately. Raise the per-address cap only if many users share one address (office NAT) and you see dropped connections.

## Health check and logs

`GET /healthz` returns `{"status":"ok"}` without authentication. The image's health check runs `python -m serverhub healthcheck` every 30 s (5 s timeout, 15 s start period, 3 retries). It requests `/healthz` on `127.0.0.1` over HTTPS if `SERVERHUB_TLS_CERT_FILE` is set and HTTP otherwise, without verifying the certificate. Status:

```bash
docker compose ps
docker inspect --format '{{.State.Health.Status}}' server-hub
```

Logs go to standard output:

```bash
docker compose logs -f server-hub
```

`SERVERHUB_LOG_LEVEL=info` is the default and prints start-up information, the setup token while no account exists, warnings and errors. Access logs are printed only at `debug`, which also turns on verbose output from the HTTP libraries; use it for troubleshooting only. The allowed values are `critical`, `error`, `warning`, `info` and `debug`. The setup token and the configuration warnings are logged as warnings, so `warning` is the quietest level that still shows them; `error` and `critical` hide them.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The server exits with `Invalid configuration:` and a variable name | A value failed validation, or `SERVERHUB_SECRET_KEY` is missing or shorter than 32 characters | Fix the named variable in `.env`, then `docker compose up -d`. |
| Sign-in returns to the login page over and over | Secure cookies are on (TLS, an `https` `SERVERHUB_PUBLIC_URL`, or `SERVERHUB_COOKIE_SECURE=true`) but you opened the hub over `http://`; the browser drops the cookie | Open the `https://` URL, enable TLS, or set `SERVERHUB_COOKIE_SECURE=false` on a plain HTTP setup. The server warns about this at start. |
| `400` with `Host '...' is not allowed` | The name in the address bar is not allowed | Add it to `SERVERHUB_ALLOWED_HOSTS` or use it in `SERVERHUB_PUBLIC_URL`, then restart. IP addresses and `localhost` always work. |
| `403` "Cross-origin request blocked" after putting a proxy or tunnel in front | The `Origin` of the page does not match what the server expects | Set `SERVERHUB_PUBLIC_URL` to the exact URL users type, including a non-default port. |
| Locked out, forgot the password | No e-mail reset exists | `docker compose exec server-hub python -m serverhub reset-password --user NAME` |
| Lost the 2FA device and the recovery codes | | `docker compose exec server-hub python -m serverhub reset-password --user NAME --disable-2fa`, or another admin clears it in the settings page. |
| `429` "rate limited" when signing in | Too many failed attempts from your address or for the account | Wait for the time in the `Retry-After` header (15 minutes for sign-in). Limits are stored in the database and survive restarts. A successful sign-in resets the account's counters. |
| Setup token lost or never seen | The token is printed at start and changes at each start | `docker compose logs server-hub \| grep "SETUP TOKEN"` (restart the container for a new one), set `SERVERHUB_SETUP_TOKEN`, or create the admin with the CLI. |
| Services show `unknown` | The target is refused by the outbound policy (loopback, link-local, a private range while `SERVERHUB_ALLOW_PRIVATE_NETWORK_TARGETS=false`, or an invalid URL), the per-user request cap is hit, or the check did not finish in time | Use the LAN address instead of `localhost`; allow private targets if intended. `down` means the check ran and the target did not answer (or answered with a status of 500 or above). |
| Beszel: "Stored password cannot be decrypted" | `SERVERHUB_SECRET_KEY` changed | Restore the old key, or re-enter the Beszel password. |
| Host CPU, memory or disk show no values | Host statistics are read from `/proc` (Linux) and are admin-only | Use a Linux host and an admin account. |
| Permission denied on `/data` with a bind mount | The host directory is not owned by uid `10001` | `sudo chown -R 10001:10001 ./data` |
| TLS: `TLS file not found` or "must be set together" at start | Wrong path inside the container, volume not mounted, or only one of the two variables set | Check that `compose.override.yaml` mounts `./certs:/certs:ro` and sets both variables (`docker compose config` shows the merged result). |
| TLS: the container is unhealthy or the key cannot be read | The key file is not readable by uid `10001` | `sudo chown 10001:10001 certs/privkey.pem && chmod 600 certs/privkey.pem` |
