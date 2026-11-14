-- Initial schema.

CREATE TABLE users (
    id                TEXT PRIMARY KEY,
    email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    username          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash     TEXT NOT NULL,
    role              TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    totp_secret_enc   TEXT,
    totp_last_step    INTEGER,
    totp_pending_enc  TEXT,
    totp_pending_exp  INTEGER,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
) STRICT;

CREATE TABLE recovery_codes (
    id         INTEGER PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    used_at    TEXT
) STRICT;
CREATE INDEX recovery_codes_user ON recovery_codes(user_id);

CREATE TABLE sessions (
    id_hash     TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

-- Password verified, second factor outstanding. Never usable as a session.
CREATE TABLE pending_logins (
    id_hash     TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE user_settings (
    user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data        TEXT NOT NULL,
    updated_at  TEXT NOT NULL
) STRICT;

CREATE TABLE services (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    url           TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    icon          TEXT NOT NULL,
    category      TEXT,
    check_enabled INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL
) STRICT;
CREATE INDEX services_user ON services(user_id);

CREATE TABLE bookmarks (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    color       TEXT NOT NULL,
    created_at  TEXT NOT NULL
) STRICT;
CREATE INDEX bookmarks_user ON bookmarks(user_id);

CREATE TABLE beszel_instances (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    url           TEXT NOT NULL,
    username      TEXT NOT NULL,
    password_enc  TEXT NOT NULL,
    revision      INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL
) STRICT;
CREATE INDEX beszel_user ON beszel_instances(user_id);

CREATE TABLE app_config (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
) STRICT;

-- Persistent failure counters for login / 2FA / setup / register throttling.
CREATE TABLE rate_limits (
    key           TEXT PRIMARY KEY,
    count         INTEGER NOT NULL,
    window_start  INTEGER NOT NULL,
    locked_until  INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX rate_limits_window ON rate_limits(window_start);
