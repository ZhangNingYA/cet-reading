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
docker compose up -d --build --remove-orphans --wait --wait-timeout 120
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/003_paper_modes.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/005_original_practice.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/006_seed_original_papers.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U cet_reading -d cet_reading < db/migrations/007_keep_first_cet4_paper.sql
docker compose ps

curl --fail --silent --show-error --retry 10 --retry-delay 2 \
  http://127.0.0.1:8081/ >/dev/null
curl --fail --silent --show-error --retry 10 --retry-delay 2 \
  http://127.0.0.1:8081/api/papers >/dev/null

echo "Deployment verified at $(git rev-parse --short HEAD)."
