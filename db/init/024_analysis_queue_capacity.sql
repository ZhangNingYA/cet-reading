BEGIN;

UPDATE analysis_runtime_settings
SET queue_capacity = LEAST(32, GREATEST(queue_capacity, worker_concurrency * 2)),
    background_target = LEAST(background_target, LEAST(32, GREATEST(queue_capacity, worker_concurrency * 2))),
    updated_at = NOW()
WHERE id=TRUE;

COMMIT;
