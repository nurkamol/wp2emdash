#!/usr/bin/env bash
# WordPress end-to-end test (docs/e2e.md): a throwaway WordPress in Docker, seeded with synthetic content, migrated by
# the kit (init → audit → extract → transform → scaffold, then load + verify against the project's local dev server),
# checked, reported. Nothing is deployed and Cloudflare is never contacted.
#
#   e2e/run.sh              full run; report in e2e/wordpress/.work/report (E2E_OUT to change)
#   e2e/run.sh --keep       leave WordPress running afterwards (http://localhost:8080, admin via `wp` in the wpcli service)
#   e2e/run.sh --skip-load  stop after scaffold (no dev server, no load/verify)
#
# Exit codes: 0 passed · 2 a required gate or assertion failed · 1 setup failed (Docker, downloads, seed, runner).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WPD="${ROOT}/e2e/wordpress"
WORK="${WPD}/.work"
export E2E_WP_PORT="${E2E_WP_PORT:-8080}"
export E2E_WP_URL="http://localhost:${E2E_WP_PORT}"
export E2E_OUT="${E2E_OUT:-${WORK}/report}"
export E2E_WORK_DIR="${WORK}"
KEEP=0
for arg in "$@"; do
	case "${arg}" in
	--keep) KEEP=1 ;;
	--skip-load) export E2E_SKIP_LOAD=1 ;;
	*)
		echo "usage: e2e/run.sh [--keep] [--skip-load]" >&2
		exit 1
		;;
	esac
done

log() { printf '\n[e2e] %s\n' "$*"; }
compose() { docker compose -f "${WPD}/docker-compose.yml" "$@"; }

# ── Preconditions ────────────────────────────────────────────────────────────────────────────────────────────
for bin in docker node pnpm curl; do
	command -v "${bin}" >/dev/null 2>&1 || {
		echo "[e2e] ${bin} is required" >&2
		exit 1
	}
done
docker compose version >/dev/null 2>&1 || {
	echo "[e2e] docker compose (v2) is required" >&2
	exit 1
}
if env | grep -Eq '^(CLOUDFLARE_|CF_API|EMDASH_TOKEN|EMDASH_WP_MIGRATION_KEY)[A-Z_]*=.'; then
	echo "[e2e] refusing to run with Cloudflare / EmDash credentials in the environment; unset them first" >&2
	exit 1
fi

# shellcheck disable=SC2329 # called from teardown (EXIT trap)
collect_logs() {
	mkdir -p "${E2E_OUT}/logs"
	compose logs --no-color --timestamps db wordpress >"${E2E_OUT}/logs/docker.log" 2>&1 || true
	compose ps --all >"${E2E_OUT}/logs/docker-ps.txt" 2>&1 || true
	[ -f "${WORK}/seed.log" ] && cp "${WORK}/seed.log" "${E2E_OUT}/logs/seed.log"
	[ -f "${WORK}/seed-summary.txt" ] && cp "${WORK}/seed-summary.txt" "${E2E_OUT}/seed-summary.txt"
	return 0
}
# shellcheck disable=SC2329 # EXIT trap
teardown() {
	local code=$?
	collect_logs
	if [ "${KEEP}" = "1" ]; then
		log "WordPress left running at ${E2E_WP_URL} (stop: docker compose -f e2e/wordpress/docker-compose.yml down -v)"
	else
		compose --profile tools down -v --remove-orphans >/dev/null 2>&1 || true
	fi
	exit "${code}"
}
setup_failed() {
	mkdir -p "${E2E_OUT}"
	{
		echo "# WordPress end-to-end: FAILED (setup)"
		echo
		echo "$1"
		echo
		echo "The kit pipeline did not run. Look at logs/seed.log and logs/docker.log in this report."
		if [ -f "${WORK}/seed.log" ]; then
			echo
			echo '## Last lines of the seed log'
			echo
			echo '```'
			tail -n 60 "${WORK}/seed.log"
			echo '```'
		fi
	} >"${E2E_OUT}/report.md"
	echo "[e2e] $1" >&2
	exit 1
}

# ── Fresh start ──────────────────────────────────────────────────────────────────────────────────────────────
log "cleaning up any earlier run"
compose --profile tools down -v --remove-orphans >/dev/null 2>&1 || true
rm -rf "${WORK}"
mkdir -p "${WORK}"
trap teardown EXIT

log "preparing the seed plan, images and pinned plugin zips"
(cd "${ROOT}" && pnpm exec tsx e2e/run.ts prepare) || setup_failed "prepare failed (downloads or checksum): see the output above"
# The WordPress containers write as uid 33 (www-data) into .work.
chmod -R a+rwX "${WORK}"

log "starting WordPress (pinned images: e2e/wordpress/docker-compose.yml)"
compose up -d db wordpress || setup_failed "docker compose up failed"
for i in $(seq 1 90); do
	code="$(curl -s -o /dev/null -w '%{http_code}' "${E2E_WP_URL}/wp-admin/install.php" || true)"
	if [ "${code}" = "200" ]; then break; fi
	if [ "${i}" -eq 90 ]; then setup_failed "WordPress did not answer at ${E2E_WP_URL} (last HTTP ${code})"; fi
	sleep 2
done

log "seeding WordPress (log: ${WORK}/seed.log)"
compose --profile tools run --rm -T wpcli bash /seed/seed.sh 2>&1 | tee "${WORK}/seed.log" || setup_failed "seed failed"

log "smoke checks against the seeded site"
for path in "/" "/fr/" "/about/" "/shop/" "/wp-json/emdash/v1/probe"; do
	code="$(curl -s -o /dev/null -w '%{http_code}' "${E2E_WP_URL}${path}" || true)"
	echo "  ${path} → HTTP ${code}"
	[ "${code}" = "200" ] || setup_failed "seeded site: ${path} answered HTTP ${code} (expected 200)"
done

log "running the kit pipeline"
set +e
(cd "${ROOT}" && pnpm exec tsx e2e/run.ts pipeline)
status=$?
set -e
log "report: ${E2E_OUT}/report.md (exit ${status})"
exit "${status}"
