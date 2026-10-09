#!/usr/bin/env bash
set -Eeuo pipefail

deploy_path="${1:-/home/cyan/cet-reading}"
repository_url="${REPOSITORY_URL:-https://github.com/ZhangNingYA/cet-reading.git}"

cd "$deploy_path"

if [[ ! -f .env ]]; then
  echo "Missing $deploy_path/.env; refusing to deploy without server secrets." >&2
  exit 1
fi

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
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/003_paper_modes.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/005_original_practice.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/008_imported_papers.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/013_exam_materials.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/009_seed_papers.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/010_replace_simulated_paper.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/011_analysis_regeneration.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/012_remove_quote_only_sentence.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/014_news.sql
docker compose up -d --no-build --remove-orphans --wait --wait-timeout 120
docker compose ps

curl --fail --silent --show-error --retry 10 --retry-delay 2 \
  http://127.0.0.1:8081/ >/dev/null
curl --fail --silent --show-error --retry 10 --retry-delay 2 \
  http://127.0.0.1:8081/api/papers >/dev/null

echo "Deployment verified at $(git rev-parse --short HEAD)."
