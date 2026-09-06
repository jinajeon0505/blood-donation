#!/usr/bin/env bash
# db/dump-supabase.sh 산출물을 대상 PostgreSQL(RDS 또는 로컬 Docker)에 복원한다.
#
# 사용법:
#   export TARGET_DATABASE_URL='postgresql://user:PASSWORD@host:5432/dbname?sslmode=require'
#   ./db/restore-postgres.sh backup/20260904-153000/app-tables.dump
#
# 대상 DB 에 이미 데이터가 있으면 중단한다. 덮어쓰려면 CONFIRM_OVERWRITE=yes.
#
# RDS 가 프라이빗 서브넷이면 로컬에서 직접 붙을 수 없다. 덤프 파일과 이
# 스크립트를 WAS EC2 로 옮겨 실행하거나 SSM 포트 포워딩 세션을 먼저 연다.
# 자세한 절차는 DATA-MIGRATION.md 참고.

set -euo pipefail

DUMP_FILE="${1:-}"
if [ -z "$DUMP_FILE" ] || [ ! -f "$DUMP_FILE" ]; then
  echo "사용법: $0 <경로>/app-tables.dump" >&2
  exit 1
fi
if [ -z "${TARGET_DATABASE_URL:-}" ]; then
  echo "오류: TARGET_DATABASE_URL 환경변수가 없습니다." >&2
  exit 1
fi

PG_IMAGE="${PG_IMAGE:-postgres:17-alpine}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DUMP_ABS="$(cd "$(dirname "$DUMP_FILE")" && pwd)/$(basename "$DUMP_FILE")"

export PGURL="$TARGET_DATABASE_URL"

DOCKER_ARGS=(--rm --env PGURL --user "$(id -u):$(id -g)"
             -v "$DUMP_ABS:/in/dump:ro" -v "$REPO_ROOT/db:/db:ro")
# 로컬 Docker Postgres 로 복원할 때: host.docker.internal 를 쓰거나
# NETWORK=<compose 네트워크명> 을 지정한다.
[ -n "${NETWORK:-}" ] && DOCKER_ARGS+=(--network "$NETWORK")

psql_in() {
  docker run -i "${DOCKER_ARGS[@]}" "$PG_IMAGE" \
    sh -c 'exec psql "$PGURL" -v ON_ERROR_STOP=1 "$@" -f -' sh "$@"
}
psql_run() {
  docker run "${DOCKER_ARGS[@]}" "$PG_IMAGE" \
    sh -c 'exec psql "$PGURL" -v ON_ERROR_STOP=1 "$@"' sh "$@"
}
pg_restore_run() {
  docker run "${DOCKER_ARGS[@]}" "$PG_IMAGE" \
    sh -c 'exec pg_restore --dbname "$PGURL" "$@"' sh "$@"
}

echo "==> 대상 DB 확인"
psql_in -At <<'SQL' | sed 's/^/    /'
select current_database();
select version();
SQL

echo "==> 스키마 적용 (db/schema.sql, 멱등)"
psql_run -q -f /db/schema.sql

echo "==> 기존 데이터 확인"
EXISTING="$(psql_in -At <<'SQL'
select (select count(*) from public.applications)
     + (select count(*) from public.donation_history);
SQL
)"
if [ "${EXISTING:-0}" != "0" ]; then
  echo "경고: 대상 DB 에 이미 ${EXISTING} 건이 있습니다." >&2
  if [ "${CONFIRM_OVERWRITE:-}" != "yes" ]; then
    echo "      덮어쓰려면 CONFIRM_OVERWRITE=yes 로 다시 실행하세요." >&2
    exit 1
  fi
  echo "==> CONFIRM_OVERWRITE=yes — 기존 데이터를 비웁니다"
  psql_in -q <<'SQL'
truncate table public.applications, public.donation_history restart identity;
SQL
fi

echo "==> 데이터 복원"
# 스키마는 위에서 적용했으므로 --data-only.
# --disable-triggers 는 superuser 가 필요해 RDS 에서 실패하므로 쓰지 않는다.
pg_restore_run --data-only --no-owner --no-privileges --single-transaction /in/dump

echo "==> 시퀀스 정렬 (donation_history.id 는 SERIAL)"
psql_in -q <<'SQL'
select setval(pg_get_serial_sequence('public.donation_history', 'id'),
              coalesce(max(id), 1),
              max(id) is not null)
from public.donation_history;
SQL

echo "==> 복원 결과"
psql_in <<'SQL'
select 'applications' as table_name, count(*) from public.applications
union all
select 'donation_history', count(*) from public.donation_history;
SQL

echo
echo "완료. 원본 MANIFEST.txt 의 행 수와 일치하는지 확인하세요."
