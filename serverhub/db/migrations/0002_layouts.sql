-- Optional customizable dashboard layout, one row per user. Kept apart from
-- user_settings so older builds never see an unknown settings key.
CREATE TABLE user_layouts (
    user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data        TEXT NOT NULL,
    updated_at  TEXT NOT NULL
) STRICT;
