# Deployment guide

This guide is for the person who runs Server Hub. The short version is in the [README](../README.md); this page explains the choices behind it. Every variable is listed in the [configuration table](../README.md#configuration) and in [`.env.example`](../.env.example).

Contents: [Compose file](#the-compose-file) · [Data volume](#data-volume-and-bind-mounts) · [Port](#changing-the-port) · [TLS](#tls) · [Tunnel or proxy](#running-behind-a-tunnel-or-proxy) · [First run and users](#first-run-and-users) · [Backups](#backups) · [Upgrades](#upgrades-and-rollback) · [Secret key](#secret-key) · [Outbound requests](#outbound-request-policy) · [Docker discovery](#docker-discovery) · [Connection limits](#connection-limits) · [Health check and logs](#health-check-and-logs) · [Troubleshooting](#troubleshooting)

## The compose file

`compose.yaml` defines one service, `server-hub`, built from the `Dockerfile` in this repository. There is no reverse proxy, database server or other container. The one optional exception is `docker-proxy`, a socket proxy that only starts when you enable the `docker` profile for [Docker discovery](#docker-discovery).

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

Restoring replaces the whole database with the snapshot. Use the same `SERVERHUB_SECRET_KEY` the backup was made with. The one-shot container below runs as the same user (uid `10001`) so file ownership stays correct.

```bash
docker compose stop server-hub
docker compose run --rm --no-deps --pull never \
  -v "$PWD/backups/backup-2026-11-14.db:/restore/backup.db:ro" \
  server-hub restore /restore/backup.db
docker compose up -d --no-build --wait
```

Replace the file name with your backup. The command checks SQLite integrity, foreign keys and the schema version before atomically replacing the database. It refuses to proceed if SQLite journal files are present. Stop the running version cleanly so SQLite can close the database before retrying. Check `docker compose logs server-hub` and sign in after the restart.

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

If the upgrade applied a migration, an older build refuses to open that database. To roll back, stop the app and restore the pre-upgrade snapshot using the current build as described in [Restoring a backup](#restoring-a-backup). Run the stop and restore commands, then check out the previous version and rebuild:

```bash
git checkout <previous-tag-or-commit>
docker compose up -d --build --wait
```

If a release has no schema change, you can roll back the code alone without restoring.

### Prebuilt images

Publishing a GitHub release with a tag such as `v2.1.0` builds and tests AMD64 and ARM64 images before publishing to `ghcr.io/eco-null/server-hub:<tag>`. The image uses the exact version tag. On the first release, confirm that the GHCR package is public before advertising anonymous pulls.

Use the current `compose.yaml` and keep your existing Compose project, data volume, and secret key. Record the old `SERVERHUB_IMAGE` value (or `server-hub:latest` for a local build). Set `SERVERHUB_IMAGE` in `.env` to the new tag, then run:

```bash
mkdir -p -m 700 backups
backup="pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ).db"
docker compose exec -T server-hub python -m serverhub backup "/data/$backup" &&
docker compose cp "server-hub:/data/$backup" "./backups/$backup" &&
docker compose pull server-hub &&
docker compose run --rm --no-deps --pull never \
  -v "$PWD/backups/$backup:/restore/backup.db:ro" \
  server-hub verify-backup /restore/backup.db &&
docker compose exec -T server-hub rm "/data/$backup" &&
docker compose up -d --no-build --pull never --wait --wait-timeout 120 server-hub
```

The sequence stops before replacing the running container if a backup, pull or validation step fails. If the new version fails its health check, inspect its logs. If it migrated the database, stop it and use its image to [restore the pre-upgrade snapshot](#restoring-a-backup). Run the stop and restore commands, then set the previous image reference in `.env` before starting again with `docker compose up -d --no-build --pull never --wait server-hub`. Restoring the snapshot discards writes made after the backup.

### Moving links from the previous version

Export a JSON backup from the old dashboard, then open **Settings → Backup → Import links** in the new installation. The preview shows how services and bookmarks will merge into the signed-in user's account. Old settings, Beszel credentials and accounts must be set up separately. See [API.md](API.md#bulk-link-import) for the YAML format and matching rules.

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

Docker discovery adds one more rule: the endpoint in `SERVERHUB_DOCKER_HOST` is never contacted by status checks or Beszel, whatever the settings (see [Docker discovery](#docker-discovery)).

Because loopback is always blocked, a service on the same machine cannot be checked through `localhost`. Use the machine's LAN address. Inside the container, the host is reachable only through its network address, never `127.0.0.1`.

## Docker discovery

Docker discovery shows the containers you label as service cards on the dashboard, and gives admins one-click suggestions for other running containers that publish a port. Nothing is stored: Server Hub reads the container list from Docker every few seconds, and a card disappears with its container.

It is off by default. Until you set `SERVERHUB_DOCKER_HOST`, Server Hub makes no Docker request, and the proxy container described below is not started.

### How access works

Server Hub never mounts the Docker socket and never talks to it. It asks a separate container, `docker-proxy` (the image `wollomatic/socket-proxy`, pinned to a release tag in `compose.yaml`), which has the socket mounted. The two containers share an internal Compose network (`docker-proxy`) that has no route to the outside, and the proxy's port is not published on the host.

The proxy allows exactly one request: `GET /containers/json`, optionally with an API version prefix such as `/v1.47/`. Server Hub sends `GET /containers/json?all=true`. Everything else is refused: inspecting a container (which includes its environment variables and mounts), stats, logs, attach, exec, creating, starting, stopping or deleting containers, images, volumes, networks, events, `/version`, `/info`, and every method other than `GET`. Only the container named `server-hub` may connect (`-allowfrom=server-hub`). The proxy runs as uid `65534` (not root) with the group that owns the socket, with a read-only root filesystem, no capabilities, and process and memory limits.

Mounting the socket with `:ro` would not give you this. `:ro` only stops file operations on the socket file; the Docker API spoken over it still accepts writes, `exec` and attach. Anything that can reach the socket can control the host. The proxy's allow-list is the protection, which is why Server Hub does not get the socket at all.

### Turn it on

1. Find the numeric group that owns the Docker socket. On a Linux host:

   ```bash
   stat -c %g /var/run/docker.sock
   ```

   If `stat` is not available there, this prints the same number through Docker:

   ```bash
   docker run --rm -v /var/run/docker.sock:/s:ro busybox:1.37 stat -c %g /s
   ```

2. Add these lines to `.env` (`.env.example` has them as a commented block). Replace `998` with the number from step 1:

   ```bash
   COMPOSE_PROFILES=docker
   SERVERHUB_DOCKER_HOST=tcp://docker-proxy:2375
   DOCKER_GID=998
   ```

   - `COMPOSE_PROFILES=docker` makes Compose start the `docker-proxy` service, which belongs to the `docker` profile.
   - `SERVERHUB_DOCKER_HOST` is where Server Hub reaches the proxy: `tcp://host:port` or `http://host:port`. `unix://` sockets are refused.
   - `DOCKER_GID` is read by Docker Compose only, not by Server Hub. If it is unset or wrong, the proxy cannot open the socket and exits at start (see [Troubleshooting](#docker-discovery-troubleshooting)). It never falls back to root.

3. Optional: set the host name or IP address your browser uses for this machine. Suggestions use it to build their URL (see [Suggestions](#suggestions)):

   ```bash
   SERVERHUB_DOCKER_PUBLIC_HOST=nas.lan
   ```

   Give a host name or IP address only, without a scheme, port or path.

4. Start the proxy and restart Server Hub:

   ```bash
   docker compose up -d
   docker compose ps
   ```

   `docker-proxy` should be listed and become healthy.

5. Sign in as an admin and open Settings, then Docker. A **Connected** tag means Server Hub can read the container list. The same page shows the label reference, the containers that were skipped and why, and the suggestions.

### Label a container

A container becomes a card when it has **both** `serverhub.enable` (a true value) and `serverhub.url`. Add the labels, then recreate the container so Docker applies them (`docker compose up -d` does that for a changed Compose file).

| Label | Required | Default | Notes |
|---|---|---|---|
| `serverhub.enable` | yes | none | `true`, `1`, `yes` or `on`, in any letter case. Any other value, including `false`, means the container is not discovered, and no note is shown for it. |
| `serverhub.url` | yes | none | An `http` or `https` address, at most 2000 characters, without `user:password@`. If it is missing or invalid, the container is skipped and admins see the reason. The card opens this address, and the server requests it for status checks. |
| `serverhub.name` | no | the container name, prettified (`my_app-1` becomes `My App`) | At most 200 characters. |
| `serverhub.description` | no | empty | At most 500 characters. |
| `serverhub.icon` | no | guessed from the image and name, otherwise `box` | An icon id that Server Hub knows, for example `chart` or `database`. |
| `serverhub.category` | no | automatic | A known category, for example `Monitoring`; letter case is ignored. |
| `serverhub.check` | no | `true` | `true`/`1`/`yes`/`on` or `false`/`0`/`no`/`off`. `false` turns status checks off for this card. |

A label value longer than 2048 characters counts as invalid. An invalid `name`, `description`, `icon`, `category` or `check` does not skip the container: Server Hub uses the default and admins see a warning in Settings, Docker. At most 500 containers are examined.

A complete example for another app, in that app's own Compose file:

```yaml
services:
  grafana:
    image: grafana/grafana
    ports:
      - "3000:3000"
    labels:
      serverhub.enable: "true"
      serverhub.url: "http://nas.lan:3000"
      serverhub.name: "Grafana"
      serverhub.description: "Dashboards and alerts"
      serverhub.icon: "chart"
      serverhub.category: "Monitoring"
      serverhub.check: "true"
```

Quote the values so YAML passes them as text. Use an address that Server Hub's own container can reach (see [Status checks](#status-checks-for-discovered-services)). Discovered cards are read-only: change the labels and recreate the container to change a card. They are not part of backups or the JSON export.

### Suggestions

Admins see suggestions in Settings, Docker. A container is suggested when it:

- is running;
- has no `serverhub.enable` label at all (a label with any value, including `false`, hides it);
- publishes at least one TCP port that is not bound only to the host's loopback address.

Server Hub itself and the socket proxy are never suggested (`compose.yaml` labels both `serverhub.enable=false`, and they are also recognized by Compose service name and image), and neither is a container whose suggested address is already one of your services.

The suggested URL is `http://<SERVERHUB_DOCKER_PUBLIC_HOST>:<published port>`. Server Hub picks the most likely web port of the container (it prefers well-known ones such as 80, 443, 8080, 3000 and 8000, otherwise the lowest) and uses `https` for container ports 443, 8443 and 9443. If `SERVERHUB_DOCKER_PUBLIC_HOST` is empty, the suggestion has no URL and you type it in when you add it.

Add opens the usual add-service dialog with the suggestion filled in. The result is an ordinary service owned by that admin: you can edit or delete it, and it is part of backups. It is not linked to the container afterwards.

### Who sees discovered services

Admins always. Other users only after an admin turns on **Show discovered services to all users** in Settings, Docker (off by default; stored in the database, not in `.env`). The switch has no effect while discovery is not configured. Suggestions, the skipped list and the warnings are visible to admins only.

### Status checks for discovered services

Discovered cards show a status like any other service, with these differences:

- A container that is not running (exited, paused, restarting, created, dead or removing) shows as `down`. No request is made.
- For a running container, the server requests `serverhub.url` itself, under the [outbound request policy](#outbound-request-policy). All viewers see the same result, cached for about 20 seconds, and discovered services do not use any user's own request budget.
- `serverhub.check: "false"` turns the check off for that card.
- Only the first 100 running discovered services, in order of name, are checked. The rest show `unknown`, and admins get a warning that says so.
- Status checks never contact the endpoint in `SERVERHUB_DOCKER_HOST`, on any port.

### When Docker or the proxy is unavailable

Server Hub refreshes the container list in the background at most every 10 seconds. If a refresh fails, it keeps serving the last good list for up to 120 seconds, and admins see a note that the list is that many seconds old. After 120 seconds without a good list, discovered cards disappear and Settings, Docker shows **Unavailable** with a reason. Server Hub keeps retrying, and the cards return when the proxy answers again. Your own services and the rest of the dashboard are not affected. The proxy exits, and Docker restarts it, when the socket goes away (for example after a Docker engine restart), so a short gap is normal then.

### Security considerations

- **Labels are trusted input.** Anyone who can start a container on the Docker host can attach labels to it. They choose the URL the card opens, which every user who can see discovered services may click, and the URL your Server Hub server requests for status checks. The outbound policy still applies: loopback, link-local and cloud-metadata addresses are never contacted, and private ranges only while `SERVERHUB_ALLOW_PRIVATE_NETWORK_TARGETS` is `true`. Within that policy a label can make the server send a `GET` request to any address on your LAN, and viewers see whether it answered (admins also see its HTTP status and latency). If you do not trust everyone who can start containers on the host, keep the visibility switch off or do not use discovery there.
- **What the proxy exposes.** The list of all containers on the host, labeled or not: name, image, labels, published ports and state. It does not expose environment variables, mounts, logs or anything else. Do not put secrets in labels, because they are part of that list.
- **What a compromised Server Hub could do.** Read that same container list. It could not inspect containers, read their environment variables, start, stop, create or delete anything, run commands in a container, or reach the socket, because the only request the proxy lets through is `GET /containers/json` and the socket is mounted into the proxy only.
- **What a compromised proxy could do.** It holds the socket, so everything depends on its allow-list. What limits the damage is a pinned upstream image (`wollomatic/socket-proxy`), a non-root user, no capabilities, a read-only filesystem and no published port. You are trusting that project's code to enforce the allow-list.
- **What CI checks.** CI starts the stack with the profile enabled on a real Docker engine. It checks the rendered Compose configuration (the socket is mounted into the proxy only, no published proxy port, an internal network, exactly one allow rule) and sends requests to the running proxy: the container list is answered; container inspect, stats, logs, the attach WebSocket, a path-traversal variant, images, `/version`, `/info`, `HEAD`, create, stop and delete are refused (`403` or `405`); and so is `GET /containers/json` from any other container on the network. It does not audit the proxy image's own code.

### Docker discovery troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `docker-proxy` exits at start, and `docker compose logs docker-proxy` shows `socket not available ... permission denied` | `DOCKER_GID` is unset or is not the group that owns the socket | Print the group (step 1 above), put it in `.env` as `DOCKER_GID`, then `docker compose up -d`. |
| Settings, Docker says "The socket proxy refused to list containers" | The proxy answered `401` or `403`: its allow rule was changed, or the request does not come from the `server-hub` container | Restore the `-allowGET` and `-allowfrom=server-hub` lines of `docker-proxy` in `compose.yaml`, and do not rename the `server-hub` container. Server Hub must reach the proxy over the `docker-proxy` network. |
| "Could not connect to the Docker API" | The proxy is not running, or `SERVERHUB_DOCKER_HOST` does not match it | Check `docker compose ps` and that `COMPOSE_PROFILES=docker` is set. With the shipped `compose.yaml` the host is `tcp://docker-proxy:2375`. |
| Settings, Docker says Docker discovery is not set up | `SERVERHUB_DOCKER_HOST` is empty, or Server Hub was not restarted after you set it | Set it, then `docker compose up -d`. |
| A container has labels but no card | It is listed under **Skipped containers**, or `serverhub.enable` is not a true value (then it is not listed at all) | Open Settings, Docker. Reasons include `serverhub.url is missing`, `serverhub.url is not a valid http(s) URL`, `serverhub.url must not contain credentials (user:password@)`, `serverhub.url is longer than 2000 characters` and `duplicate container name; only the first one is listed`. Fix the label and recreate the container. |
| The card shows `down` although the app works | The server requests `serverhub.url` from inside the Server Hub container, and the address is not reachable from there | Use the host's LAN address and published port, not `localhost` or `127.0.0.1`. Or set `serverhub.check: "false"`. A stopped container is `down` by design. |
| The card shows `unknown` | The address is refused by the outbound policy (loopback, link-local, or a private address while `SERVERHUB_ALLOW_PRIVATE_NETWORK_TARGETS=false`), or the service is beyond the first 100 checked | See [Outbound request policy](#outbound-request-policy). |
| Suggestions have no URL | `SERVERHUB_DOCKER_PUBLIC_HOST` is empty | Set it in `.env` and restart Server Hub, or type the URL when you add the service. |
| Settings, Docker stays "Unavailable" after a Docker restart | The proxy exits when the socket goes away and Docker restarts it; it may not have come back | `docker compose ps`, then `docker compose restart docker-proxy`. |

### Turn it off

Remove (or comment out) `COMPOSE_PROFILES=docker`, `SERVERHUB_DOCKER_HOST` and `DOCKER_GID` in `.env`, restart Server Hub, and remove the proxy container:

```bash
docker compose up -d
docker compose --profile docker stop docker-proxy
docker compose --profile docker rm -f docker-proxy
```

Discovered cards disappear. Services you added from suggestions stay, because they are ordinary services.

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
