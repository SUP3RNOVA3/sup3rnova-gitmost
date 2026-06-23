#!/usr/bin/env bash
#
# git-sync ADVANCED end-to-end suite — authz, protocol hardening, concurrency,
# and structural sync (rename / reparent / delete-cap), driven against a LIVE
# stand. Companion to git-sync-e2e.sh (the basic two-way flows). These cases
# need deeper hooks than a plain clone:
#   - the vault working repo on the host ($VAULT_DIR/<spaceId>) for ref/SHA asserts,
#   - the Redis container ($REDIS_CONTAINER) to inject a held lock (503 path),
#   - DB-created fixture users / a second space (auto-created + torn down).
#
# Came out of a generate->critique subagent pass on "what is NOT covered". The
# critic verified the contracts against the code (e.g. a non-member of an
# ENABLED space gets 403, not 404 — only a missing / sync-disabled space 404s).
#
# Usage:  apps/server/test/git-sync-e2e-advanced.sh
set -uo pipefail

SERVER="${SERVER:-http://localhost:3000}"
SPACE_ID="${SPACE_ID:-019ef1f7-437b-7ae9-9306-809a1729f085}"
EMAIL="${EMAIL:-admin@test.local}"
PASSWORD="${PASSWORD:-Test12345!}"
DB_CONTAINER="${DB_CONTAINER:-gitmost-db}"
DB_USER="${DB_USER:-docmost}"
DB_NAME="${DB_NAME:-docmost}"
REDIS_CONTAINER="${REDIS_CONTAINER:-gitmost-redis}"
VAULT_DIR="${VAULT_DIR:-/tmp/gitmost-vaults}"
LOCK_PREFIX="git-sync:lock:"

BASIC=$(printf '%s:%s' "$EMAIL" "$PASSWORD" | base64 -w0)
GIT_URL="$SERVER/git/$SPACE_ID.git"
VAULT="$VAULT_DIR/$SPACE_ID"
WORK=$(mktemp -d /tmp/git-sync-adv.XXXXXX)
COOKIES="$WORK/cookies.txt"
PASS=0; FAIL=0
READER_ID=""; OUTSIDER_ID=""; SPACE2_ID=""

say(){ printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok(){ printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad(){ printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
psqlq(){ docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }
api(){ curl -s -b "$COOKIES" "$@"; }
gitc(){ git -c http.extraHeader="Authorization: Basic $BASIC" "$@"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }      # print HTTP status
basicfor(){ printf '%s:%s' "$1" "$PASSWORD" | base64 -w0; }
sync_now(){ api -X POST "$SERVER/api/git-sync/trigger" -H 'Content-Type: application/json' -d "{\"spaceId\":\"$SPACE_ID\"}" >/dev/null; }
vault_sha(){ git -C "$VAULT" rev-parse "$1" 2>/dev/null; }
# Push retrying on 503 — the smart-HTTP host returns 503+Retry-After when a sync
# cycle holds the lock (a real git client retries; so do we, to dodge poll races).
gpush(){ local out; for _ in $(seq 1 6); do out=$(gitc push origin main 2>&1); echo "$out" | grep -q '503\|busy' && { sleep 2; continue; }; return 0; done; return 1; }

teardown(){
  # Hard-delete fixtures by EMAIL/NAME pattern (robust against a mid-run abort
  # that never captured an id), so the stand + the basic suite stay clean.
  psqlq "delete from space_members where user_id in (select id from users where email like 'e2e-adv-%@test.local');
         delete from users where email like 'e2e-adv-%@test.local';
         delete from spaces where name like 'E2E-ADV-%';
         delete from pages where space_id='$SPACE_ID' and title like 'E2E-ADV-%';" >/dev/null
  docker exec "$REDIS_CONTAINER" redis-cli del "${LOCK_PREFIX}${SPACE_ID}" >/dev/null 2>&1
  # The delete-cap case intentionally leaves the vault non-convergent (over-cap
  # deletes held, last-pushed pinned). The vault is a CACHE — reset it so the next
  # cycle rebuilds cleanly from Docmost (now that the fixture pages are gone),
  # otherwise every later cycle re-attempts the suppressed deletes forever.
  rm -rf "$VAULT"
  sync_now
  rm -rf "$WORK"
}
trap teardown EXIT

# Create a workspace user that shares the admin's password hash (so it logs in
# with $PASSWORD). $2 = "reader" adds a reader space membership; "none" = no
# membership (non-member). Echoes the new user id.
make_user(){
  local email="$1" role="$2" uid
  # grep the bare uuid out of the RETURNING output (psql may append a status tag).
  uid=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "insert into users (id,email,name,password,workspace_id,created_at,updated_at,has_generated_password,is_agent)
        select gen_random_uuid(),'$email','$email',password,workspace_id,now(),now(),false,false
        from users where email='$EMAIL' returning id;" 2>/dev/null \
        | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  if [ "$role" = "reader" ]; then
    psqlq "insert into space_members (id,user_id,space_id,role,added_by_id,created_at,updated_at)
           values (gen_random_uuid(),'$uid','$SPACE_ID','reader','$uid',now(),now());" >/dev/null
  fi
  printf '%s' "$uid"
}

# ---------------------------------------------------------------------------
say "setup: login + fixtures"
[ "$(code -c "$COOKIES" -X POST "$SERVER/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")" = "200" ] \
  && ok "admin login" || { bad "admin login failed"; exit 1; }
gitc clone -q "$GIT_URL" "$WORK/c" 2>/dev/null && ok "baseline clone" || { bad "baseline clone failed"; exit 1; }
( cd "$WORK/c" && git config user.email e2e@test && git config user.name e2e )

# ===========================================================================
say "protocol: unparseable / wrong-method requests are rejected (never reach git)"
# A recognized git content-type to an UNKNOWN service subpath reaches the handler
# and is rejected as a bad request (resolveServiceKind -> null -> 400).
[ "$(code -X POST -H "Authorization: Basic $BASIC" -H 'Content-Type: application/x-git-upload-pack-request' "$GIT_URL/git-bogus-pack")" = "400" ] \
  && ok "unknown service subpath -> 400" || bad "unknown service subpath not 400"
# An UNKNOWN content-type is rejected by the global content-type allowlist (415)
# before the git handler even runs — also a valid rejection.
[ "$(code -X POST -H "Authorization: Basic $BASIC" -H 'Content-Type: application/x-git-bogus' "$GIT_URL/git-receive-pack")" = "415" ] \
  && ok "unknown content-type -> 415 (global allowlist)" || bad "unknown content-type not 415"
[ "$(code -X PUT -H "Authorization: Basic $BASIC" "$GIT_URL/git-receive-pack")" = "400" ] \
  && ok "PUT on a pack endpoint -> 400" || bad "PUT not 400"
[ "$(code -X DELETE -H "Authorization: Basic $BASIC" "$GIT_URL/info/refs?service=git-upload-pack")" = "400" ] \
  && ok "DELETE on info/refs -> 400" || bad "DELETE not 400"

# ===========================================================================
say "protocol: path-traversal in space-id / subpath is rejected (no escape)"
for u in \
  "$SERVER/git/..%2f..%2f..%2fetc.git/info/refs?service=git-upload-pack" \
  "$GIT_URL/%2e%2e%2finfo/refs?service=git-upload-pack" \
  "$SERVER/git/.git/info/refs?service=git-upload-pack" ; do
  c=$(curl -s --path-as-is -o /dev/null -w '%{http_code}' -H "Authorization: Basic $BASIC" "$u")
  case "$c" in 400|404) ok "traversal '${u##*/git/}' -> $c";; *) bad "traversal '${u##*/git/}' got $c (expected 400/404)";; esac
done

# ===========================================================================
say "authz: a sync-DISABLED space is 404 (existence not revealed), not 403"
SPACE2_ID=$(api -X POST "$SERVER/api/spaces/create" -H 'Content-Type: application/json' -d '{"name":"E2E-ADV-Space2","slug":"e2eadvspace2"}' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$SPACE2_ID" ]; then
  [ "$(code -H "Authorization: Basic $BASIC" "$SERVER/git/$SPACE2_ID.git/info/refs?service=git-upload-pack")" = "404" ] \
    && ok "admin member of a gitSync-disabled space -> 404" || bad "disabled space did not 404"
  # enabling it flips to 200 (proves the per-space flag is the gate)
  psqlq "update spaces set settings = coalesce(settings,'{}'::jsonb) || '{\"gitSync\":{\"enabled\":true}}'::jsonb where id='$SPACE2_ID';" >/dev/null
  [ "$(code -H "Authorization: Basic $BASIC" "$SERVER/git/$SPACE2_ID.git/info/refs?service=git-upload-pack")" = "200" ] \
    && ok "flipping gitSync.enabled=true -> 200" || bad "enabled 2nd space did not 200"
else
  bad "could not create a 2nd space"
fi

# ===========================================================================
say "authz: reader can FETCH (200) but is FORBIDDEN to push (403)"
READER_ID=$(make_user "e2e-adv-reader@test.local" reader)
RBASIC=$(basicfor "e2e-adv-reader@test.local")
[ "$(code -H "Authorization: Basic $RBASIC" "$GIT_URL/info/refs?service=git-upload-pack")" = "200" ] \
  && ok "reader fetch -> 200" || bad "reader fetch not 200"
[ "$(code -H "Authorization: Basic $RBASIC" "$GIT_URL/info/refs?service=git-receive-pack")" = "403" ] \
  && ok "reader push (receive-pack) -> 403" || bad "reader push not 403"

# ===========================================================================
say "authz: a NON-member of an enabled space -> 403 (NOT 404)"
OUTSIDER_ID=$(make_user "e2e-adv-outsider@test.local" none)
OBASIC=$(basicfor "e2e-adv-outsider@test.local")
c=$(code -H "Authorization: Basic $OBASIC" "$GIT_URL/info/refs?service=git-upload-pack")
[ "$c" = "403" ] && ok "non-member fetch -> 403 (existence revealed only to members)" || bad "non-member got $c (contract is 403)"

# ===========================================================================
say "concurrency: a push while the per-space lock is held -> 503 + Retry-After"
docker exec "$REDIS_CONTAINER" redis-cli set "${LOCK_PREFIX}${SPACE_ID}" "held-by-test" PX 8000 NX >/dev/null 2>&1
hdr=$(curl -s -D - -o /dev/null -X POST -H "Authorization: Basic $BASIC" \
      -H 'Content-Type: application/x-git-receive-pack-request' --data-binary '0000' \
      "$GIT_URL/git-receive-pack")
st=$(printf '%s' "$hdr" | head -1 | grep -o '[0-9]\{3\}')
ra=$(printf '%s' "$hdr" | grep -i '^Retry-After:' | tr -d '\r')
main_before=$(vault_sha main)
[ "$st" = "503" ] && ok "push during held lock -> 503" || bad "lock-held push got $st (expected 503)"
[ -n "$ra" ] && ok "503 carries a $ra header" || bad "503 missing Retry-After header"
docker exec "$REDIS_CONTAINER" redis-cli del "${LOCK_PREFIX}${SPACE_ID}" >/dev/null 2>&1
[ "$(vault_sha main)" = "$main_before" ] && ok "receive-pack did not mutate the vault while locked" || bad "vault main changed under a held lock"

# ===========================================================================
say "idempotent re-sync: nothing changes when nothing changed (no churn)"
sync_now
m1=$(vault_sha main); lp1=$(vault_sha refs/docmost/last-pushed)
sync_now; sync_now
m2=$(vault_sha main); lp2=$(vault_sha refs/docmost/last-pushed)
[ "$m1" = "$m2" ] && [ "$lp1" = "$lp2" ] && ok "main + last-pushed SHAs stable across idle cycles" \
  || bad "idle cycles churned refs (main $m1->$m2, last-pushed $lp1->$lp2)"

# (Structural rename/move on the live stand is deliberately NOT scripted here: a
# freshly-API-created page has a meta-only body, so git's rename-similarity
# heuristic classifies a `git mv` of it as delete+add rather than `R`, which is a
# test-fixture artifact, not a feature bug. The rename/move classifier is covered
# deterministically by the engine unit suite — packages/git-sync/test/
# classify-rename-moves.test.ts and node-ops.test.ts.)

# ===========================================================================
say "data-loss guard: deleting MORE than the cap is HELD, not dropped"
# Create cap+2 sibling pages, sync, then git rm all of them in one push.
CAP=$(api "$SERVER/api/git-sync/status" | grep -o '"maxDeletesPerCycle":[0-9]*' | grep -o '[0-9]*')
CAP=${CAP:-5}
N=$((CAP+2))
ids=""
for i in $(seq 1 $N); do
  id=$(api -X POST "$SERVER/api/pages/create" -H 'Content-Type: application/json' -d "{\"spaceId\":\"$SPACE_ID\",\"title\":\"E2E-ADV-Del-$i-$RANDOM\"}" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  ids="$ids $id"
done
sync_now
lp_before=$(vault_sha refs/docmost/last-pushed)
rm -rf "$WORK/cd"; gitc clone -q "$GIT_URL" "$WORK/cd" 2>/dev/null
cd "$WORK/cd"; git config user.email e2e@test; git config user.name e2e
for id in $ids; do f=$(grep -rl "$id" --include='*.md' . | head -1); [ -n "$f" ] && git rm -q "$f"; done
git commit -qm "rm $N pages (over cap $CAP)"
gpush
cd "$WORK"
sleep 2
trashed=$(psqlq "select count(*) from pages where space_id='$SPACE_ID' and deleted_at is not null and ($(echo $ids | sed "s/ \?\([0-9a-f-]\+\)/ or id='\1'/g; s/^ or //"));")
lp_after=$(vault_sha refs/docmost/last-pushed)
[ "${trashed:-0}" = "0" ] && ok "none of the $N over-cap deletes were applied (held)" || bad "$trashed pages trashed despite over-cap (data loss!)"
[ "$lp_before" = "$lp_after" ] && ok "last-pushed ref did NOT advance past the delete commit (retry-safe)" || bad "last-pushed advanced over suppressed deletes ($lp_before -> $lp_after)"
# cleanup these pages (hard-delete; they are E2E-ADV-* so teardown also catches them)

# ===========================================================================
say "RESULTS: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
