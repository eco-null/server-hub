# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 2.x | Yes |
| 1.x (the previous Supabase/Vercel implementation) | No |

Security fixes go into the latest 2.x release. Run the newest version.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub private vulnerability reporting for this repository:

1. Go to <https://github.com/eco-null/server-hub/security/advisories/new> (or the **Security** tab, then **Report a vulnerability**).
2. Describe the problem, the affected version or commit, and the steps to reproduce it. A proof of concept helps.

The [live demo](https://eco-null.github.io/server-hub/) is a static page with a simulated backend and no real accounts. Its simulated behavior (for example, no rate limiting) is not a vulnerability in the server; a flaw in the web interface code itself is in scope.

You will get an answer through the advisory thread. Please allow reasonable time for a fix before you disclose the issue publicly.

## Security model

Server Hub is meant to be reachable by people you trust (or by the internet, with TLS and closed registration). These are the protections, as implemented.

**Sessions.** A sign-in creates a random 256-bit token. Only its SHA-256 hash is stored; the token lives in an `HttpOnly`, `SameSite=Lax` cookie that JavaScript cannot read. With Secure cookies (TLS, an `https` public URL, or `SERVERHUB_COOKIE_SECURE=true`) the cookie also has the `Secure` flag and the `__Host-` name prefix. Each sign-in issues a fresh session and revokes the one the browser had. Sessions expire after 7 idle days or 30 days in total (configurable); a user keeps at most 20; changing a password signs out the other sessions; resetting it with the CLI signs out all of them.

**Passwords.** Argon2id (3 iterations, 64 MiB, 4 lanes), run in worker threads with a cap of four concurrent hashes. Unknown accounts are verified against a dummy hash so timing does not reveal whether an account exists. Passwords are 10 to 128 characters. Login failures return the same error for unknown users and wrong passwords.

**Two-factor authentication.** Optional TOTP (RFC 6238, 6 digits, 30 s steps, one step of clock drift accepted). A code cannot be used twice: the last accepted step is stored. Ten single-use recovery codes are generated on enabling; only keyed HMAC-SHA-256 hashes are stored. The TOTP secret is encrypted with Fernet. After the password is accepted, the pending second step is held server-side for 5 minutes and allows 5 attempts; it can never act as a session. Starting 2FA setup, disabling 2FA and changing the password need the current password.

**CSRF.** For every method except GET, HEAD and OPTIONS: if `Origin` is present it must match `SERVERHUB_PUBLIC_URL` or the request's own allowed host and scheme; otherwise `Sec-Fetch-Site` must be `same-origin`; otherwise a request that carries a session cookie must send an `X-ServerHub-Client` header. API bodies must be `application/json`. GET requests never change state.

**Content Security Policy and headers.** Every response carries `Content-Security-Policy` (scripts, styles, fonts and connections from the same origin only, no frames, no objects, no `base` tag), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin`. When the request arrived over HTTPS, `Strict-Transport-Security` (one year, `includeSubDomains`) is added. API responses are `Cache-Control: no-store`. The frontend builds DOM with `createElement` and `textContent` only.

**Host allowlist.** The `Host` header must be an IP address, `localhost`, the host of `SERVERHUB_PUBLIC_URL` or a name in `SERVERHUB_ALLOWED_HOSTS`, which defeats DNS rebinding. Anything else gets `400`.

**Rate limiting.** Counters are stored in SQLite, so they survive restarts, and each attempt is counted before the secret is checked, so parallel requests cannot exceed the budget. Per client address (IPv6 per /64): 20 sign-in attempts and 20 2FA attempts per 15 minutes. Per account and address: 8 sign-in attempts per 15 minutes, then a 15-minute lock. Account-wide limits are soft: above 30 sign-in attempts per 15 minutes each attempt is delayed (up to 4 s) but never refused, so someone spraying from many addresses cannot lock the owner out. 2FA codes: 6 per 15 minutes per account. Setup token: 10 per hour per address. Registration: 5 per hour per address. At most 2 password checks run at once per address. Client addresses come from the TCP peer, or from `X-Forwarded-For` / `X-Forwarded-Proto` only when the peer is in `SERVERHUB_TRUSTED_PROXIES`.

**First-run setup.** Creating the first (admin) account requires the setup token that the server prints in its log at start (or `SERVERHUB_SETUP_TOKEN`), so nobody who reaches a fresh install can claim it. Registration is closed by default and only an admin can open it.

**Outbound requests (SSRF).** Status checks and Beszel requests use one hardened client: http(s) only, no credentials in URLs, no redirects, no proxy environment variables; the host name is resolved once and the connection goes to the validated address. Loopback, link-local and cloud-metadata ranges, multicast, reserved ranges and addresses embedded in IPv6 forms of those are always blocked. Private ranges (RFC 1918, ULA, CGNAT) are allowed by default and can be disabled with `SERVERHUB_ALLOW_PRIVATE_NETWORK_TARGETS=false`. Time, size and concurrency limits apply, and callers only receive short generic error messages; non-admin users get one message for every Beszel failure so the endpoints cannot be used to probe the network.

**Connection gate.** The server closes connections that do not deliver a complete request head within 10 s, stall a request body for 10 s or take over 120 s for it, and caps open connections overall (default 512) and per client address (default 32). Request bodies are limited to 64 KiB (4 MiB for backup import).

**Secrets at rest.** `SERVERHUB_SECRET_KEY` is never stored by the app. HKDF-SHA-256 derives one key for Fernet encryption of TOTP secrets and Beszel passwords and one for the recovery-code hashes. Passwords are Argon2id hashes; session and pending-login tokens are SHA-256 hashes. The database file itself is not encrypted, and it holds service addresses, settings and e-mail addresses in clear text. In the Docker image the data directory is mode `0700` and owned by an unprivileged user.

**Container.** The compose file runs a single non-root container with a read-only root filesystem, no capabilities, `no-new-privileges` and a process limit.

## Known limitations

- **Plain HTTP by default.** Without a certificate and key (or a TLS-terminating tunnel or proxy), passwords and session cookies cross the network unencrypted. The server warns at start when it listens on a non-loopback address this way. Use TLS unless the network is trusted.
- **The setup token is in the log.** Anyone who can read the container log before the first account exists can see it. Create the admin promptly, or set `SERVERHUB_SETUP_TOKEN` or use the CLI.
- **Private networks are reachable by default.** Any signed-in user can make the server send requests to LAN addresses through status checks and Beszel. Disable `SERVERHUB_ALLOW_PRIVATE_NETWORK_TARGETS` if you open registration to people you do not trust.
- **Soft account-wide limits.** A distributed attack against one account is slowed down, not blocked; strong passwords and 2FA are the defence. Behind a proxy without `SERVERHUB_TRUSTED_PROXIES`, all visitors share the proxy's address and its limits.
- **Remote images.** The policy lets pages load images from any `https:` host, which is how custom wallpaper URLs work; the host serving such an image sees the viewer's IP address.
- **Secret key loss.** If the key is lost or changed, 2FA secrets and stored Beszel passwords cannot be decrypted; accounts with 2FA must be recovered with the CLI. Backups of the database are useless for those values without the key.
- **No password reset by e-mail.** Recovery needs access to the server (`python -m serverhub reset-password`) or an admin.
- **Single instance.** One process with one SQLite connection; it is not designed for clustering or for very large user counts.
- **Host statistics** are read from `/proc`, so they reflect Linux only, and are shown to admins only.
