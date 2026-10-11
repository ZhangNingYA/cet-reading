-- Persist operator-controlled analysis queue settings so API and Worker can
-- apply changes without rebuilding or restarting containers.
CREATE TABLE IF NOT EXISTS analysis_runtime_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  worker_concurrency INTEGER NOT NULL CHECK (worker_concurrency BETWEEN 1 AND 4),
  queue_capacity INTEGER NOT NULL CHECK (queue_capacity BETWEEN 1 AND 32),
  background_target INTEGER NOT NULL CHECK (background_target BETWEEN 0 AND 32),
  backfill_paused BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (background_target <= queue_capacity)
);

INSERT INTO analysis_runtime_settings
  (id, worker_concurrency, queue_capacity, background_target, backfill_paused)
VALUES (TRUE, 4, 8, 8, FALSE)
ON CONFLICT (id) DO NOTHING;
