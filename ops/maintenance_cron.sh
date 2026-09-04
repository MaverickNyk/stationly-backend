#!/usr/bin/env bash
#
# Crontab entry point for the two nightly session-maintenance jobs.
#
#   maintenance_cron.sh sweep
#   maintenance_cron.sh reconcile
#
# ## Why a wrapper instead of a bare curl line in the crontab
# Three reasons, none of them cosmetic.
#
# 1. The secret. `curl -H "X-Internal-Secret: $S"` puts the secret in argv,
#    where any user on the box can read it out of `ps` for the life of the
#    request. Passing the same header through `curl -K -` keeps it in a pipe.
#    The crontab itself then holds no secret either, so it can be read, backed
#    up and pasted into a handover doc without redacting anything.
# 2. The port and the secret both already live in `.env`, which is the file the
#    server itself reads. A crontab that hardcodes either is a second source of
#    truth that goes stale silently the first time one of them is rotated.
# 3. `/internal/*` is loopback-only by design (the guard checks the raw socket
#    address, and nginx has no catch-all `location /`). So this must run ON the
#    host and must address 127.0.0.1 — never the public hostname, which cannot
#    reach these routes at all.
#
# ## Where this file has to be, and why it lives in `ops/`
# It derives APP_DIR from its own location and reads `.env` from the directory
# one level up, so it must sit in a directory directly beneath the deploy root.
#
# It used to live in `.scripts/`, and that was a production outage waiting to
# happen: `.gitignore` ignores `.scripts/`, so ZERO files under it were tracked.
# Staging never noticed, because `staging_deploy.sh` rsyncs the working tree and
# copies untracked files. Production builds from `actions/checkout`, which
# contains only TRACKED files — so this script would never have arrived there,
# and a crontab installed on prod would have pointed at a path that does not
# exist. `ops/` is tracked, and is excluded by neither deploy path.
#
# The executable bit is part of the contract. If it is ever lost, cron fails
# with "Permission denied" at 3am and nothing else reports it — check with
# `git ls-files -s ops/maintenance_cron.sh` (must be mode 100755).
#
# Both jobs still fail loudly into the log below rather than silently skipping a
# night, so a future exclude list that dropped this file would be visible.
#
# Both jobs are idempotent, so a retry, an overlapping run, or a manual
# invocation during an incident are all harmless.

set -uo pipefail

JOB="${1:-}"
if [[ "$JOB" != "sweep" && "$JOB" != "reconcile" ]]; then
    echo "usage: $(basename "$0") <sweep|reconcile>" >&2
    exit 64
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
LOG_FILE="${MAINTENANCE_LOG:-$HOME/logs/maintenance.log}"

mkdir -p "$(dirname "$LOG_FILE")"

stamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log()   { echo "[$(stamp)] $JOB: $*" >> "$LOG_FILE"; }

if [[ ! -r "$ENV_FILE" ]]; then
    log "FATAL — cannot read $ENV_FILE"
    exit 78
fi

# Read the two values out of .env directly rather than sourcing it. Sourcing
# would execute the file, and a value containing a space, a `#`, or a `$` would
# either break the shell or expand into something else.
read_env() {
    sed -n "s/^$1=//p" "$ENV_FILE" \
        | head -n1 \
        | tr -d '\r' \
        | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

PORT="$(read_env PORT)"
PORT="${PORT:-3000}"
SECRET="$(read_env LIVESTREAM_INGEST_SECRET)"

if [[ -z "$SECRET" ]]; then
    log "FATAL — LIVESTREAM_INGEST_SECRET is not set in $ENV_FILE"
    exit 78
fi

URL="http://127.0.0.1:${PORT}/internal/maintenance/${JOB}"

# `-K -` takes the whole request off stdin, so neither the URL nor the header
# reaches argv. `fail` turns a 4xx/5xx into a non-zero exit so cron notices.
BODY="$(
    curl -K - <<CURLCFG 2>&1
url = "$URL"
request = "POST"
header = "X-Internal-Secret: $SECRET"
max-time = 600
silent
show-error
fail
CURLCFG
)"
RC=$?

if [[ $RC -eq 0 ]]; then
    log "ok $BODY"
else
    log "FAILED (curl exit $RC) $BODY"
fi
exit $RC
