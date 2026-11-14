"""Command line: serve, create-admin, reset-password, backup, healthcheck."""

from __future__ import annotations

import argparse
import getpass
import os
import ssl
import sys
import urllib.request
from pathlib import Path

from pydantic import TypeAdapter, ValidationError

from serverhub.api import schemas
from serverhub.auth.crypto import Passwords
from serverhub.config import ConfigError, load_config
from serverhub.db import Database, backup_to, repo
from serverhub.errors import ApiError


def _password(args: argparse.Namespace) -> str:
    if args.password_stdin:
        pw = sys.stdin.readline().rstrip("\r\n")
    else:
        pw = getpass.getpass("New password: ")
        if getpass.getpass("Repeat password: ") != pw:
            raise SystemExit("Passwords do not match")
    try:
        TypeAdapter(schemas.NewPassword).validate_python(pw)
    except ValidationError:
        raise SystemExit("Password must be 10-128 characters") from None
    return pw


def cmd_create_admin(args: argparse.Namespace) -> int:
    cfg = load_config()
    try:
        email = TypeAdapter(schemas.Email).validate_python(args.email)
        username = TypeAdapter(schemas.Username).validate_python(args.username)
    except ValidationError as exc:
        raise SystemExit(f"Invalid input: {exc.errors()[0]['msg']}") from None
    pw_hash = Passwords().hash_sync(_password(args))
    db = Database(cfg.db_path)
    try:
        user = db.call(repo.create_user, email, username, pw_hash, "admin")
    except ApiError as exc:
        raise SystemExit(exc.message) from None
    finally:
        db.close()
    print(f"Created admin {user['username']} <{user['email']}>")
    return 0


def cmd_reset_password(args: argparse.Namespace) -> int:
    cfg = load_config()
    db = Database(cfg.db_path)
    try:
        user = db.call(repo.get_user_by_identifier, args.user)
        if user is None:
            raise SystemExit(f"No user matches {args.user!r}")
        pw_hash = Passwords().hash_sync(_password(args))
        db.call(repo.set_password, user["id"], pw_hash, None)

        db.call(repo.rate_reset_user, user["id"])
        if args.disable_2fa:
            db.call(repo.disable_totp, user["id"])
    finally:
        db.close()
    print(f"Password reset for {user['username']}; all of their sessions were revoked")
    return 0


def cmd_backup(args: argparse.Namespace) -> int:
    cfg = load_config()
    if not cfg.db_path.is_file():
        raise SystemExit(f"No database at {cfg.db_path}")
    dest = Path(args.output)
    if dest.exists() and not args.force:
        raise SystemExit(f"{dest} exists (use --force to overwrite)")
    backup_to(cfg.db_path, dest)
    print(f"Wrote consistent database copy to {dest}")
    return 0


def cmd_healthcheck(args: argparse.Namespace) -> int:
    """Used by the Docker HEALTHCHECK; needs no secrets."""
    port = int(os.environ.get("SERVERHUB_PORT", "8642"))
    tls = bool(os.environ.get("SERVERHUB_TLS_CERT_FILE"))
    url = f"{'https' if tls else 'http'}://127.0.0.1:{port}/healthz"
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # local self-check against our own listener
    try:
        with urllib.request.urlopen(url, timeout=4, context=ctx if tls else None) as r:  # noqa: S310
            return 0 if r.status == 200 else 1
    except OSError:
        return 1


def cmd_serve(args: argparse.Namespace) -> int:
    from serverhub.main import run

    run(load_config())
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m serverhub")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("serve", help="run the web server (default)").set_defaults(fn=cmd_serve)

    p = sub.add_parser("create-admin", help="create an admin account")
    p.add_argument("--email", required=True)
    p.add_argument("--username", required=True)
    p.add_argument("--password-stdin", action="store_true", help="read the password from stdin")
    p.set_defaults(fn=cmd_create_admin)

    p = sub.add_parser("reset-password", help="set a new password and revoke sessions")
    p.add_argument("--user", required=True, help="username or email")
    p.add_argument("--password-stdin", action="store_true")
    p.add_argument("--disable-2fa", action="store_true", help="also turn off two-factor auth")
    p.set_defaults(fn=cmd_reset_password)

    p = sub.add_parser("backup", help="write a consistent copy of the SQLite database")
    p.add_argument("output", help="destination file, e.g. /data/backup-2026-01-01.db")
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_backup)

    sub.add_parser("healthcheck", help="exit 0 if /healthz answers").set_defaults(
        fn=cmd_healthcheck
    )

    args = parser.parse_args(argv)
    fn = getattr(args, "fn", cmd_serve)
    try:
        return fn(args)
    except ConfigError as exc:
        print(exc, file=sys.stderr)
        return 2
