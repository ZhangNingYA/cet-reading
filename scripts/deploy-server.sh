#!/usr/bin/env bash
set -Eeuo pipefail

deploy_path="${1:-/home/cyan/cet-reading}"
phase="${2:-}"
commit="${3:-}"
script_path="$(realpath "$0")"
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || { echo 'An exact release commit is required.' >&2; exit 1; }
[[ -f "$deploy_path/.env" ]] || { echo "Missing server .env in $deploy_path" >&2; exit 1; }
cd "$deploy_path"
mkdir -p .deployment
candidate=".deployment/$commit.env"
SECONDS=0
registry_config=''
database_client_env=''
# prepare runs before the production checkout contains newly added helper files.
database_mode="$(node "$(dirname "$script_path")/database-config.mjs" mode "$deploy_path/.env")"
trap 'result=$?; if [[ -n "$registry_config" ]]; then rm -rf -- "$registry_config"; fi; if [[ -n "$database_client_env" ]]; then rm -f -- "$database_client_env"; fi; printf "Deployment phase %s finished in %ss (status %s).\n" "$phase" "$SECONDS" "$result"' EXIT

compose() {
  local files=(-f docker-compose.yml -f docker-compose.production.yml)
  if [[ "$database_mode" == external ]]; then files+=(-f docker-compose.external-db.yml); fi
  docker compose --env-file .env --env-file "$candidate" "${files[@]}" "$@"
}
database_psql() {
  if [[ "$database_mode" == external ]]; then
    database_client_env="$(mktemp .deployment/pg-client.XXXXXX)"
    node scripts/database-config.mjs client-env .env "$database_client_env"
    local result=0
    docker run --rm -i --pull never --memory 128m --env-file "$database_client_env" \
      --entrypoint psql postgres:18-alpine -X -v ON_ERROR_STOP=1 "$@" || result=$?
    rm -f -- "$database_client_env"
    database_client_env=''
    return "$result"
  fi
  compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U cet_reading -d cet_reading "$@"
}
load_release() {
  node scripts/deployment-release.mjs validate "$candidate" "${1:-}"
  # This file is generated and validated; it only contains commit/image references.
  set -a
  # shellcheck source=/dev/null
  source "$candidate"
  set +a
  [[ "$CET_RELEASE_COMMIT" == "$commit" || "$phase" == rollback ]] || { echo 'Release commit mismatch' >&2; exit 1; }
}
set_env_value() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then sed -i "s/^${key}=.*/${key}=${value}/" .env
  else printf '%s=%s\n' "$key" "$value" >> .env; fi
}
report_resources() {
  node --input-type=module -e 'import os from "node:os"; console.log(JSON.stringify({event:"deployment_resources",cpus:os.cpus().length,load:os.loadavg(),freeMiB:Math.round(os.freemem()/1048576),totalMiB:Math.round(os.totalmem()/1048576)}))'
  df -h .
  timeout 5s docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} memory={{.MemUsage}} io={{.BlockIO}}' || true
}
recover_on_error() {
  local result=$?
  trap - ERR
  bash "$script_path" "$deploy_path" rollback "$commit" || true
  exit "$result"
}

prepare() {
  local artifacts="${4:?Missing release artifacts}" prefix="${5:?Missing registry prefix}"
  report_resources
  local old_commit
  old_commit="$(git rev-parse HEAD)"
  if [[ -f .deployment/current.env ]]; then
    cp .deployment/current.env .deployment/rollback.env
  else
    local complete=1 container image service
    printf 'CET_RELEASE_COMMIT=%s\n' "$old_commit" > .deployment/baseline.env
    for service in api worker news web; do
      container="$(docker compose ps -a -q "$service" | head -1)"
      if [[ -z "$container" ]]; then complete=0; break; fi
      image="$(docker inspect --format '{{.Image}}' "$container")"
      printf 'CET_%s_IMAGE=%s\n' "${service^^}" "$image" >> .deployment/baseline.env
      docker image inspect --format "$service previous image size: {{.Size}} bytes" "$image"
    done
    if (( complete )); then
      cp .deployment/baseline.env .deployment/rollback.env
      cp .deployment/baseline.env .deployment/previous.env
    else
      rm -f .deployment/baseline.env
    fi
  fi
  git fetch --prune origin main
  git cat-file -e "$commit^{commit}"
  git checkout --force -B main "$commit"
  if [[ ! -f .deployment/previous.env && -f .deployment/baseline.env ]]; then
    node scripts/deployment-release.mjs validate .deployment/baseline.env --local
    cp .deployment/baseline.env .deployment/previous.env
  fi
  node scripts/deployment-release.mjs prepare "$artifacts" "$prefix" "$commit" "$candidate"
  load_release
  set_env_value WORKER_CONCURRENCY 4
  set_env_value ANALYSIS_MAX_ATTEMPTS 3
  set_env_value BACKFILL_TARGET 8
  compose config --quiet
  node scripts/deployment-release.mjs plan .deployment/current.env "$candidate" > ".deployment/$commit.plan"
  cat ".deployment/$commit.plan"
}
pull_images() {
  load_release
  report_resources
  registry_config="$(mktemp -d)"
  local docker_settings="${DOCKER_CONFIG:-$HOME/.docker}"
  if [[ -d "$docker_settings/cli-plugins" ]]; then ln -s "$docker_settings/cli-plugins" "$registry_config/cli-plugins"; fi
  printf '%s' "${GH_TOKEN:?Missing registry token}" | DOCKER_CONFIG="$registry_config" docker login ghcr.io --username "${GITHUB_ACTOR:?Missing registry user}" --password-stdin
  # Worker and News use the same digest, so download it only once.
  DOCKER_CONFIG="$registry_config" compose pull --policy always api worker web
  if [[ "$database_mode" == external ]]; then docker pull postgres:18-alpine; fi
  for image in "$CET_API_IMAGE" "$CET_WORKER_IMAGE" "$CET_WEB_IMAGE"; do
    docker image inspect --format '{{index .RepoDigests 0}}: {{.Size}} bytes' "$image"
  done
}
migrate_database() {
# A production database already contains the historical seed. Only run the
# paper seed when the database is new, its paper count is stale, or this
# revision changes the paper source/seed. The generated SQL is idempotent, but
# avoiding needless replays keeps the API outage during deploys short.
has_papers="$(database_psql -At -c "SELECT to_regclass('public.papers')" | tr -d '[:space:]')"
seed_required=0
if [[ "$has_papers" != "papers" ]]; then
  seed_required=1
  database_psql < db/init/001_schema.sql
  database_psql < db/migrations/003_paper_modes.sql
  database_psql < db/migrations/005_original_practice.sql
  database_psql < db/migrations/008_imported_papers.sql
  database_psql < db/migrations/013_exam_materials.sql
  database_psql < db/migrations/010_replace_simulated_paper.sql
  database_psql < db/migrations/011_analysis_regeneration.sql
  database_psql < db/migrations/012_remove_quote_only_sentence.sql
  database_psql < db/migrations/014_news.sql
  database_psql < db/migrations/015_analysis_queue_resilience.sql
  # Shared reading chapters are hidden in the UI and must not consume analysis work.
  database_psql < db/migrations/016_shared_reading.sql
else
  expected_papers="$(find data/papers -type f -name '*.json' | wc -l | tr -d '[:space:]')"
  actual_papers="$(database_psql -At -c 'SELECT COUNT(*) FROM papers' | tr -d '[:space:]')"
  if [[ "$actual_papers" != "$expected_papers" ]]; then
    seed_required=1
  fi
  if git diff --name-only "${base_commit:-$commit}" "$commit" -- | grep -qE '^(data/papers/|db/migrations/009_seed_papers.sql$)'; then
    seed_required=1
  fi
fi
if [[ "$seed_required" == 1 ]]; then
  database_psql < db/migrations/009_seed_papers.sql
fi
database_psql < db/migrations/017_analysis_runtime_settings.sql
database_psql < db/migrations/018_analysis_admin_phase2.sql
database_psql < db/migrations/019_analysis_news_priorities.sql
database_psql < db/migrations/020_question_analysis.sql
database_psql < db/migrations/021_analysis_priority_target.sql
database_psql < db/migrations/022_analysis_priority_queue.sql
database_psql < db/migrations/023_analysis_priority_news.sql
database_psql < db/migrations/024_analysis_queue_capacity.sql
database_psql < db/migrations/025_analysis_backfill_retries.sql
database_psql < db/migrations/026_reading_progress.sql
database_psql < db/migrations/027_analysis_request_traces.sql
database_psql < db/migrations/028_approval_foundation.sql
database_psql < db/migrations/029_approval_result_body.sql
  database_psql < db/migrations/030_approval_account.sql
database_psql < db/migrations/031_approval_media.sql
database_psql < db/migrations/032_approval_friends_executor.sql
database_psql < db/migrations/033_approval_deadlines_scores.sql
database_psql < db/migrations/034_approval_integrity.sql
database_psql <<'SQL'
DELETE FROM analysis_jobs job
USING sentences sentence
JOIN shared_paper_sections shared
  ON shared.paper_id = sentence.paper_id
 AND shared.section_id = sentence.section_id
WHERE job.sentence_id = sentence.id
  AND job.status IN ('pending', 'running', 'failed');
SQL

}
apply_release() {
  load_release
  trap recover_on_error ERR
  local migrate reset_jobs stop_services start_services
  # shellcheck source=/dev/null
  source ".deployment/$commit.plan"
  local base_commit
  base_commit="$(sed -n 's/^CET_RELEASE_COMMIT=//p' .deployment/rollback.env 2>/dev/null || true)"
  touch ".deployment/$commit.applying"
  if [[ "$database_mode" == local ]]; then
    compose up -d --no-build --pull never --wait --wait-timeout 120 postgres
  fi
  local services=()
  read -r -a services <<< "$stop_services"
  if (( ${#services[@]} )); then compose stop "${services[@]}"; fi
  if (( reset_jobs )); then
    database_psql <<'SQL'
UPDATE analysis_jobs SET status='pending', lease_expires_at=NULL,
  next_attempt_at=NOW(), updated_at=NOW() WHERE status='running';
SQL
  fi
  if (( migrate )); then migrate_database; fi
  read -r -a services <<< "$start_services"
  if (( ${#services[@]} )); then
    compose up -d --no-build --pull never --no-deps --wait --wait-timeout 120 "${services[@]}"
  else echo 'Images unchanged; existing services remain running.'; fi
}
verify_release() {
  load_release
  trap recover_on_error ERR
  local service container
  for service in api worker news web; do
    container="$(compose ps -q "$service")"
    [[ -n "$container" && "$(docker inspect --format '{{.State.Status}}' "$container")" == running ]]
  done
  curl --fail --silent --show-error --retry 10 --retry-delay 2 --max-time 15 http://127.0.0.1:8081/ >/dev/null
  curl --fail --silent --show-error --retry 10 --retry-delay 2 --max-time 15 http://127.0.0.1:8081/api/papers >/dev/null
  if [[ "$database_mode" == external ]]; then compose --profile local-database stop postgres; fi
  if [[ -f .deployment/rollback.env ]] && ! diff -q <(grep '_IMAGE=' "$candidate" | sort) <(grep '_IMAGE=' .deployment/rollback.env | sort) >/dev/null; then
    cp .deployment/rollback.env .deployment/previous.env
  fi
  cp "$candidate" .deployment/current.env.next
  mv .deployment/current.env.next .deployment/current.env
  rm -f ".deployment/$commit.applying"
  compose ps
  echo "Deployment verified at $commit."
}
rollback() {
  if [[ ! -f ".deployment/$commit.applying" && "${4:-}" != force ]]; then
    echo 'No service changes to roll back.'; return
  fi
  if [[ ! -f .deployment/rollback.env ]]; then echo 'No previous release manifest is available.' >&2; return 1; fi
  candidate=.deployment/rollback.env
  if [[ "${4:-}" == force && -f .deployment/previous.env ]]; then candidate=.deployment/previous.env; fi
  load_release --local
  compose up -d --no-build --pull never --wait --wait-timeout 120 api worker news web
  cp "$candidate" .deployment/current.env
  rm -f ".deployment/$commit.applying"
  echo 'Previous application images restored; database contents retained.'
}
case "$phase" in
  prepare) prepare "$@" ;;
  pull) pull_images ;;
  apply) apply_release ;;
  verify) verify_release ;;
  rollback) rollback "$@" ;;
  *) echo 'Expected prepare, pull, apply, verify or rollback.' >&2; exit 1 ;;
esac
