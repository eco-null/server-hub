# Host on Proxmox LXC + Cloudflare Tunnel

Goal: a single Debian LXC container on your Proxmox node runs nginx serving `index.html` + `categorize.js` + `settings.js` + `tests.html` + `settings.html`, exposed to the internet only via `cloudflared` — no public inbound port, no router port-forward, fully TLS-terminated at Cloudflare's edge. Pair with `SETUP.md` for Access SSO.

```
┌────────────────────────────────┐         ┌──────────────────────────┐
│  Proxmox host                  │         │  Cloudflare edge         │
│  ┌──────────────────────────┐  │  tunnel │  Access SSO + TLS        │
│  │ LXC: server-hub          │  │ ◀─────▶ │  https://hub.example.com │
│  │  - nginx  :80 (loopback) │  │         │                          │
│  │  - cloudflared (daemon)  │  │         │  → routed into tunnel     │
│  └──────────────────────────┘  │         └──────────────────────────┘
│  No 0.0.0.0:80 exposed         │
└────────────────────────────────┘
```

Total cost: ~30 MB RAM, ~10 MB disk. ~10 minutes to set up.

---

## 0. Prerequisites

- Proxmox VE 7+ (any version that supports Debian 12 LXC templates).
- A Cloudflare account with the hostname owned by you (`example.com`).
- The 5 Server Hub files copied somewhere accessible: `index.html`, `categorize.js`, `settings.js`, `tests.html`, `settings.html` (and previously-mentioned `SETUP.md`).

---

## 1. Create the LXC container

In the Proxmox Web UI:

1. Top-right **Create CT**.
2. **General**
   - **Hostname:** `server-hub`
   - **Password / SSH key:** set root password + paste your public key for easy `ssh root@<container-ip>`.
3. **Template** — Download a Debian 12 template once if needed (`Storage → vmbr0 → Templates → Debian-12`), then select it.
4. **Disks** — 4 GB root disk is plenty.
5. **CPU** — 1 core.
6. **Memory** — 512 MB (swap 0). The container will idle at ~30 MB.
7. **Network**
   - DHCP is fine; or static `192.168.x.x/24`, gateway `192.168.x.1`.
   - **DNS:** inherit from host.
8. **Confirm → Create.**

Start it, then enter the console or `ssh` in.

---

## 2. Install nginx + upload the files

In the container:

```bash
apt update && apt install -y nginx

mkdir -p /var/www/server-hub
chown -R www-data:www-data /var/www/server-hub
```

Copy the 5 files into `/var/www/server-hub/`. Pick **one** method:

**A. From your desktop via scp (easiest):**
```bash
# from your workstation, in the project folder:
scp index.html categorize.js settings.js tests.html settings.html SETUP.md \
  root@<container-ip>:/var/www/server-hub/
```

**B. Or fetch a tarball you uploaded to a private gist:**
```bash
cd /var/www/server-hub && curl -fsSL https://your-gist-url/raw -o files.tgz && tar xzf files.tgz
```

**C. Or clone from a private Git repo:**
```bash
apt install -y git
git clone https://github.com/you/server-hub.git /tmp/hub && cp /tmp/hub/*.html /tmp/hub/*.js /var/www/server-hub/
```

Then:
```bash
chown -R www-data:www-data /var/www/server-hub
chmod -R 644 /var/www/server-hub/*
find /var/www/server-hub -type d -exec chmod 755 {} \;
```

---

## 3. nginx config — bind to 127.0.0.1, not 0.0.0.0

We bind to localhost so the homepage is **only** reachable via the tunnel, never directly from your LAN (even less the internet).

`/etc/nginx/sites-available/server-hub`:

```nginx
server {
    listen 127.0.0.1:80;
    server_name hub.example.com;   # set to your real hostname
    root /var/www/server-hub;
    index index.html;

    # Static UI files
    location / { try_files $uri /index.html; }

    # /api/me shim — use Cloudflare's injected header (see SETUP.md §5)
    location = /api/me {
        default_type application/json;
        if ($http_cf_access_client_email = "") { return 401 '{"error":"unauthenticated"}'; }
        return 200 '{"email":"$http_cf_access_client_email"}';
    }

    # /api/stats placeholder — replace with your real endpoint
    # (the bar widget stays in "—" placeholder state if this 404s)
    location = /api/stats {
        default_type application/json;
        return 503 '{"error":"stats endpoint not configured"}';
    }

    # Sensible caching for the static files
    location ~* \.(js|css|html|svg)$ {
        expires 1h;
        add_header Cache-Control "public, must-revalidate";
    }

    # Never expose dotfiles
    location ~ /\. { deny all; return 404; }
}
```

Enable + reload:

```bash
ln -s /etc/nginx/sites-available/server-hub /etc/nginx/sites-enabled/server-hub
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

Sanity check from inside the container:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1/   # → 200
```

---

## 4. Install cloudflared and create the tunnel

Two ways — pick the easier one for you:

### Option A — Quick tunnel (no dashboard setup, perfect for first try)

```bash
# install
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cfd.deb
apt install -y /tmp/cfd.deb

# run a temporary URL (random-words.trycloudflare.com)
cloudflared tunnel --url http://127.0.0.1:80
```

You'll see a `https://<random>.trycloudflare.com` URL in the logs. Open it — Server Hub is live, no DNS, no CF dashboard steps. **Note:** this URL dies when the process stops. For permanent DNS, do Option B.

### Option B — Permanent named tunnel (recommended)

Create the tunnel and an creds file once:

```bash
cloudflared tunnel login                # opens a browser to authorize your domain
cloudflared tunnel create server-hub   # writes /root/.cloudflared/<tunnel-id>.json
```

Then create the DNS record Cloudflare will proxy:

```bash
cloudflared tunnel route dns server-hub hub.example.com
```

Configure ingress in `/root/.cloudflared/config.yml`:

```yaml
tunnel: <paste-tunnel-id>
credentials-file: /root/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: hub.example.com
    service: http://127.0.0.1:80
    originRequest:
      noTLSVerify: true

  - service: http_status:404     # catch-all, MUST be last
```

Test it:

```bash
cloudflared tunnel --config /root/.cloudflared/config.yml run server-hub
# visit https://hub.example.com — loads your dashboard
```

### Make it a systemd service so it survives reboots

```bash
cloudflared service install
systemctl enable --now cloudflared
systemctl status cloudflared --no-pager
```

`cloudflared service install` copies the current config to `/etc/cloudflared/config.yml` and runs as root. If you prefer, run as a dedicated user — see `man cloudflared`.

---

## 5. Lock it down with Cloudflare Access (the personal login)

Server Hub is now reachable from the whole internet. **Do this step before sharing the URL** — otherwise anyone who lands on `hub.example.com` sees your dashboard and the IPs of every service you link to.

Follow `SETUP.md` §1–§2 to add a Cloudflare Access application:

1. Cloudflare Zero Trust → Access → Applications → **Add application → Self-hosted**.
2. Public hostname: `hub.example.com`, leave path blank.
3. Identity providers: enable Google + One-time PIN (PIN emails you a code — zero setup).
4. Policy name `Just Me`, action `Allow`, rule Include Emails → `you@example.com`.
5. Save.

The next time you visit `https://hub.example.com`, you'll be redirected to an Access login page. After the one-time PIN, the signed-in cookie lasts for the session duration you set.

> The optional `cf-chip` in the header already reads `$http_cf_access_client_email` from the `/api/me` shim (configured in step 3) and shows your email — pure UX, auth is enforced at the edge.

---

## 6. Restart / update checklist

```bash
# Restart services after editing files
systemctl reload nginx
systemctl restart cloudflared

# Update the homepage contents: scp the new files, then:
chown -R www-data:www-data /var/www/server-hub
# No reload needed — nginx serves files fresh on each request (1 h cache max)
```

To bump settings across all devices:

1. Open `https://hub.example.com/settings.html` on your phone or laptop browser.
2. Change theme / accent / add links → each device's localStorage is touched independently.
3. The bundled `index.html` `SERVICES_DEFAULT` array is shared; per-device additions (added via the **+** button) live in each browser's localStorage.

If you want settings **synced** across all your devices (not just defaults), the next step is a tiny `/api/settings` backend. Tell me if you want me to write that backend (a 50-line Node/Python server would handle it).

---

## 7. Optional hardening

| Concern | Action |
|--------|--------|
| Don't trust the tunnel with root | Create a `cloudflared` user and `chown -R cloudflared:cloudflared /etc/cloudflared /root/.cloudflared` (move the dir), then `cloudflared service install` as that user. |
| Want stats widget working | Write a 10-line `/api/stats` shim reading `/proc/stat`, `/proc/meminfo`, `df` — return `{ host, cpu, mem, disk }` numbers 0–100. Add it as an nginx `location` with a small Lua block, or proxy to a tiny systemd service. |
| Container backup | Proxmox → Containers → snapshot weekly: `vzdump <ctid> --storage <pbs-or-local> --mode snapshot --compress zstd` |
| Network isolation | Put the container on a separate vmbr0 VLAN / Proxmox SDN zone so even LAN clients can't bypass the tunnel and reach 127.0.0.1 directly. Bind nginx to `127.0.0.1:80` only — already done above. |
| Refresh tunnel creds on cert rotation | `cloudflared tunnel token` rotates the underlying cert; store the JWT in `/root/.cloudflared/cert.pem`. |

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `502 Bad Gateway` on the public URL | nginx not running or not bound on 127.0.0.1 | `systemctl status nginx`, `ss -ltnp \| grep :80`, confirm config has `listen 127.0.0.1:80` |
| `404` from `cloudflared` | Missing catch-all `http_status:404` rule in `config.yml` | Add the trailing `service: http_status:404` line, restart cloudflared |
| Access login loops infinitely | Cloudflare's cf-access cookie blocked as third-party | Use a dedicated browser profile, or allow third-party cookies on `*.cloudflareaccess.com` |
| Settings saved but gone after reload | You're still on `file://` — opaque origin blocks localStorage | Visit via `https://hub.example.com`, not by opening the file from disk. Verify with DevTools → Application → Local Storage — `server-hub:settings` should be present |
| Tunnel works but dashboard has no stats bars | `/api/stats` returns 503 by default | Wire up a real stats shim (see §6 hardening), or toggle OFF the "System stats widget" switch in Settings |
| Cloudflared won't start | Credentials file path wrong | `ls /root/.cloudflared/*.json` — confirm `credentials-file:` in `config.yml` matches the actual filename |
| Container can't reach cloudflared download URL | Outbound port 443 blocked on your LAN firewall | `apt install` worked earlier — same path. Otherwise download on host and `scp` into container |

---

## 9. One-paragraph summary

Create a tiny Debian LXC, `apt install nginx`, drop the 5 files at `/var/www/server-hub`, bind nginx to `127.0.0.1:80` with the bundled config, then `cloudflared tunnel create server-hub` and route a hostname (`cloudflared tunnel route dns server-hub hub.example.com`), wire it into `config.yml` with hostname ingress pointing at `http://127.0.0.1:80`, install as a systemd service, and finally add a Cloudflare Access policy permitting only your email. Total: ten minutes to a fully TLS-terminated, SSO-protected, zero-inbound-port homepage dashboard reachable from anywhere on the public internet.