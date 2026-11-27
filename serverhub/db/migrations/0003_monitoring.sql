-- Opt-in service monitoring. Existing services have no monitor until enabled.

CREATE TABLE service_monitors (
    service_id    TEXT PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
    enabled       INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    generation    TEXT NOT NULL,
    started_at    INTEGER NOT NULL,
    last_slot     INTEGER,
    down_streak   INTEGER NOT NULL DEFAULT 0 CHECK (down_streak >= 0),
    first_down_at INTEGER
) STRICT;

CREATE TABLE monitor_samples (
    service_id  TEXT NOT NULL REFERENCES service_monitors(service_id) ON DELETE CASCADE,
    slot        INTEGER NOT NULL,
    state       TEXT NOT NULL CHECK (state IN ('up', 'down', 'unknown')),
    checked_at  TEXT,
    http_status INTEGER,
    latency_ms  INTEGER,
    PRIMARY KEY (service_id, slot)
) STRICT;
CREATE INDEX monitor_samples_by_slot ON monitor_samples(slot);

CREATE TABLE monitor_incidents (
    id         TEXT PRIMARY KEY,
    service_id TEXT NOT NULL REFERENCES service_monitors(service_id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER,
    end_reason TEXT CHECK (end_reason IN ('recovered', 'paused')),
    CHECK ((ended_at IS NULL) = (end_reason IS NULL))
) STRICT;
CREATE UNIQUE INDEX monitor_incidents_one_open ON monitor_incidents(service_id)
    WHERE ended_at IS NULL;
CREATE INDEX monitor_incidents_by_service_time ON monitor_incidents(service_id, started_at);

CREATE TABLE monitor_webhook (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    url_enc  TEXT NOT NULL,
    revision TEXT NOT NULL
) STRICT;

CREATE TABLE monitor_deliveries (
    id               TEXT PRIMARY KEY,
    service_id       TEXT NOT NULL REFERENCES service_monitors(service_id) ON DELETE CASCADE,
    incident_id      TEXT NOT NULL REFERENCES monitor_incidents(id) ON DELETE CASCADE,
    webhook_revision TEXT NOT NULL,
    kind             TEXT NOT NULL CHECK (kind IN ('down', 'recovered')),
    occurred_at      INTEGER NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt     INTEGER NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    last_error       TEXT,
    UNIQUE (incident_id, kind)
) STRICT;
CREATE INDEX monitor_deliveries_by_service ON monitor_deliveries(service_id);
CREATE INDEX monitor_deliveries_by_time ON monitor_deliveries(occurred_at);
CREATE INDEX monitor_deliveries_pending ON monitor_deliveries(next_attempt) WHERE status = 'pending';

-- Apply equally to service edits and link imports. A new address is a new
-- monitoring target. A check toggle leaves the old history paused.
CREATE TRIGGER monitor_service_changed AFTER UPDATE OF url, check_enabled ON services
WHEN OLD.url <> NEW.url OR OLD.check_enabled <> NEW.check_enabled
BEGIN
    DELETE FROM service_monitors WHERE service_id = OLD.id AND OLD.url <> NEW.url;
    UPDATE service_monitors
        SET enabled = 0, generation = lower(hex(randomblob(16))), down_streak = 0, first_down_at = NULL
        WHERE service_id = OLD.id AND OLD.check_enabled <> NEW.check_enabled;
    UPDATE monitor_incidents
        SET ended_at = max(started_at, CAST(strftime('%s', 'now') AS INTEGER)), end_reason = 'paused'
        WHERE service_id = OLD.id AND ended_at IS NULL;
    DELETE FROM monitor_deliveries WHERE service_id = OLD.id AND status = 'pending';
END;
