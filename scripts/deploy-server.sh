#!/usr/bin/env bash
set -Eeuo pipefail

deploy_path="${1:-/home/cyan/cet-reading}"
repository_url="${REPOSITORY_URL:-https://github.com/ZhangNingYA/cet-reading.git}"

cd "$deploy_path"

if [[ ! -f .env ]]; then
  echo "Missing $deploy_path/.env; refusing to deploy without server secrets." >&2
  exit 1
fi

# Keep the queue tuning explicit on the server while leaving API credentials
# and all other operator-owned settings untouched.
set_env_value() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s/^${key}=.*/${key}=${value}/" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}
set_env_value WORKER_CONCURRENCY 4
set_env_value ANALYSIS_MAX_ATTEMPTS 3
set_env_value BACKFILL_TARGET 8

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git init -b main
fi
if ! git config --get remote.origin.url >/dev/null 2>&1; then
  git remote add origin "$repository_url"
fi

git fetch --prune origin main
git checkout --force -B main origin/main
git reset --hard origin/main

docker compose config --quiet
docker compose build
docker compose up -d postgres --wait --wait-timeout 120
# Apply schema changes before starting the API and workers.
docker compose stop api worker news
# A forced worker stop must not leave jobs looking active until their leases expire.
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading <<'SQL'
UPDATE analysis_jobs
SET status = 'pending', lease_expires_at = NULL,
    next_attempt_at = NOW(), updated_at = NOW()
WHERE status = 'running';
SQL
# A production database already contains the historical seed. Replaying the
# multi-thousand-row seed on every deploy can hold locks long enough to take
# the API offline. Only a genuinely new database needs the bootstrap chain.
has_papers="$(docker compose exec -T postgres psql -At \
  -U cet_reading -d cet_reading -c "SELECT to_regclass('public.papers')" | tr -d '[:space:]')"
if [[ "$has_papers" != "papers" ]]; then
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U cet_reading -d cet_reading < db/migrations/003_paper_modes.sql
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U cet_reading -d cet_reading < db/migrations/005_original_practice.sql
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U cet_reading -d cet_reading < db/migrations/008_imported_papers.sql
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U cet_reading -d cet_reading < db/migrations/013_exam_materials.sql
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U cet_reading -d cet_reading < db/migrations/009_seed_papers.sql
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U cet_reading -d cet_reading < db/migrations/010_replace_simulated_paper.sql
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U cet_reading -d cet_reading < db/migrations/011_analysis_regeneration.sql
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U cet_reading -d cet_reading < db/migrations/012_remove_quote_only_sentence.sql
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U cet_reading -d cet_reading < db/migrations/014_news.sql
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U cet_reading -d cet_reading < db/migrations/015_analysis_queue_resilience.sql
  # Shared reading chapters are hidden in the UI and must not consume analysis work.
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U cet_reading -d cet_reading < db/migrations/016_shared_reading.sql
fi
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/017_analysis_runtime_settings.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/018_analysis_admin_phase2.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/019_analysis_news_priorities.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/020_question_analysis.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/021_analysis_priority_target.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/022_analysis_priority_queue.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/023_analysis_priority_news.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/024_analysis_queue_capacity.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading <<'SQL'
DELETE FROM analysis_jobs job
USING sentences sentence
JOIN shared_paper_sections shared
  ON shared.paper_id = sentence.paper_id
 AND shared.section_id = sentence.section_id
WHERE job.sentence_id = sentence.id
  AND job.status IN ('pending', 'running', 'failed');
SQL
docker compose up -d --no-build --remove-orphans --wait --wait-timeout 120
docker compose ps

curl --fail --silent --show-error --retry 10 --retry-delay 2 \
  http://127.0.0.1:8081/ >/dev/null
curl --fail --silent --show-error --retry 10 --retry-delay 2 \
  http://127.0.0.1:8081/api/papers >/dev/null

echo "Deployment verified at $(git rev-parse --short HEAD)."
