-- CXC Performance Analytics Database Schema
-- Supports daily BPO metrics calculation

CREATE TABLE IF NOT EXISTS interactions (
    interaction_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id            INTEGER NOT NULL,
    queue_id            INTEGER NOT NULL,
    channel             TEXT NOT NULL CHECK(channel IN ('voice','email','chat','sms')),
    start_time          TIMESTAMP NOT NULL,
    answer_time         TIMESTAMP,
    end_time            TIMESTAMP,
    handle_time_seconds INTEGER,
    acw_time_seconds    INTEGER DEFAULT 0,
    hold_time_seconds   INTEGER DEFAULT 0,
    transfer_count      INTEGER DEFAULT 0,
    transferred_to      INTEGER,
    abandoned           INTEGER DEFAULT 0 CHECK(abandoned IN (0,1)),
    resolved            INTEGER DEFAULT 0 CHECK(resolved IN (0,1)),
    first_contact       INTEGER DEFAULT 1 CHECK(first_contact IN (0,1)),
    service_level_target INTEGER DEFAULT 20, -- seconds
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_shifts (
    shift_id            INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id            INTEGER NOT NULL,
    shift_date          DATE NOT NULL,
    login_time          TIMESTAMP NOT NULL,
    logout_time         TIMESTAMP,
    scheduled_hours     REAL NOT NULL,
    available_time_seconds INTEGER DEFAULT 0,
    occupied_time_seconds  INTEGER DEFAULT 0,
    break_time_seconds     INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS daily_metrics (
    metric_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_date         DATE NOT NULL,
    metric_name         TEXT NOT NULL,
    metric_value        REAL NOT NULL,
    channel             TEXT,
    queue_id            INTEGER,
    agent_id            INTEGER,
    calculation_basis   TEXT,
    calculated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(metric_date, metric_name, channel, queue_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_interactions_date ON interactions(date(start_time));
CREATE INDEX IF NOT EXISTS idx_interactions_agent ON interactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_interactions_queue ON interactions(queue_id);
CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics(metric_date);
