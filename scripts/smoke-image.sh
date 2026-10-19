#!/usr/bin/env bash
set -Eeuo pipefail
: "${IMAGE:?Missing image}"
: "${IMAGE_KIND:?Missing image kind}"
if [[ "$IMAGE_KIND" == web ]]; then
  container="$(docker run -d -p 127.0.0.1::80 "$IMAGE")"
  trap 'docker rm -f "$container" >/dev/null' EXIT
  port="$(docker port "$container" 80/tcp | cut -d: -f2)"
  curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 "http://127.0.0.1:$port/" > /tmp/cet-image-home.html
  grep -q 'class="home-section container"' /tmp/cet-image-home.html
  for path in cet4 cet6 postgraduate news; do
    curl --fail --silent --show-error "http://127.0.0.1:$port/$path/" > /tmp/cet-image-page.html
    grep -q 'id="library"\|id="news-library"' /tmp/cet-image-page.html
  done
else
  docker run --rm -i -e "CET_IMAGE_KIND=$IMAGE_KIND" --entrypoint node "$IMAGE" --input-type=module < scripts/smoke-image.mjs
fi
