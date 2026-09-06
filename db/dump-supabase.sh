#!/usr/bin/env bash
# Supabase PostgreSQL 을 로컬 파일로 덤프한다.
#
# 사용법:
#   export SUPABASE_DATABASE_URL='postgresql://postgres.xxx:PASSWORD@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres'
#   ./db/dump-supabase.sh
#
# 중요 — 반드시 포트 5432 연결 문자열을 쓸 것:
#   Supabase 대시보드 > Project Settings > Database > Connection string
#     * "Session pooler"     (...pooler.supabase.com:5432) — IPv4 가능, 권장
#     * "Direct connection"  (db.<ref>.supabase.co:5432)   — IPv6 전용일 수 있음
#     * "Transaction pooler" (...:6543) — pg_dump 가 동작하지 않는다. 쓰지 말 것.
#   비밀번호에 @ : / ? # 등이 있으면 퍼센트 인코딩해야 한다.
#
# 산출물은 backup/<타임스탬프>/ 아래에 생성되고 .gitignore 로 제외된다.
# 신청자 실명·소속이 들어 있으므로 커밋하거나 공유 채널에 올리지 않는다.

set -euo pipefail

if [ -z "${SUPABASE_DATABASE_URL:-}" ]; then
  echo "오류: SUPABASE_DATABASE_URL 환경변수가 없습니다." >&2
  echo "  export SUPABASE_DATABASE_URL='postgresql://...:5432/postgres'" >&2
  exit 1
fi

case "$SUPABASE_DATABASE_URL" in
  *:6543/*)
    echo "오류: 6543(Transaction pooler) 연결로는 pg_dump 가 동작하지 않습니다." >&2
    echo "      5432(Session pooler 또는 Direct connection) 문자열을 쓰세요." >&2
    exit 1
    ;;
esac

# 서버가 더 최신이라 'server version mismatch' 가 나면 이 값을 올린다.
PG_IMAGE="${PG_IMAGE:-postgres:17-alpine}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +'%Y%m%d-%H%M%S')"
OUTDIR="$REPO_ROOT/backup/$STAMP"
mkdir -p "$OUTDIR"

# 연결 문자열을 docker 명령줄(=프로세스 목록)에 노출시키지 않으려고
# 값 대입 없는 --env 환경 상속을 쓴다.
export PGURL="$SUPABASE_DATABASE_URL"

# SQL 은 stdin 으로 넘긴다. 중첩 인용을 없애기 위해서다.
psql_in() {
  docker run --rm -i --env PGURL --user "$(id -u):$(id -g)" \
    -v "$OUTDIR:/out" "$PG_IMAGE" \
    sh -c 'exec psql "$PGURL" -v ON_ERROR_STOP=1 "$@" -f -' sh "$@"
}
pg_dump_run() {
  docker run --rm --env PGURL --user "$(id -u):$(id -g)" \
    -v "$OUTDIR:/out" "$PG_IMAGE" \
    sh -c 'exec pg_dump "$PGURL" "$@"' sh "$@"
}

echo "==> 연결 확인"
if ! psql_in -At <<'SQL' | sed 's/^/    /'
select current_database();
select version();
SQL
then
  echo "연결 실패. 연결 문자열, 비밀번호 퍼센트 인코딩, IPv4 접근 가능 여부를 확인하세요." >&2
  exit 1
fi

APP_TABLES=(-t public.applications -t public.donation_history)

echo "==> 1/5 앱 테이블 custom 포맷 덤프 (복원용)"
pg_dump_run "${APP_TABLES[@]}" --no-owner --no-privileges \
  --format=custom --file=/out/app-tables.dump

echo "==> 2/5 앱 테이블 plain SQL 덤프 (사람이 읽는 용도)"
pg_dump_run "${APP_TABLES[@]}" --no-owner --no-privileges \
  --format=plain --file=/out/app-tables.sql

echo "==> 3/5 public 스키마 전체 덤프 (보관용)"
# 아카이브 목적. Supabase 의 RLS 정책·역할 참조가 섞여 있어 다른 DB 에
# 그대로는 복원되지 않을 수 있다. 실제 복원에는 app-tables.dump 를 쓴다.
pg_dump_run --schema=public --no-owner --no-privileges \
  --format=plain --file=/out/public-full.sql

echo "==> 4/5 테이블별 CSV"
psql_in -q <<'SQL'
\copy public.applications to '/out/applications.csv' with (format csv, header true)
\copy public.donation_history to '/out/donation_history.csv' with (format csv, header true)
SQL

echo "==> 5/5 MANIFEST 작성"
{
  echo "blood-donation Supabase 백업"
  echo "생성 시각 : $STAMP"
  echo "pg_dump   : $PG_IMAGE"
  echo
  echo "행 수:"
  psql_in -At <<'SQL' | sed 's/^/  /'
select 'applications=' || count(*) from public.applications;
select 'donation_history=' || count(*) from public.donation_history;
SQL
  echo
  echo "파일:"
  (cd "$OUTDIR" && ls -l | tail -n +2 | awk '{printf "  %-24s %s bytes\n", $9, $5}')
} > "$OUTDIR/MANIFEST.txt"

cat "$OUTDIR/MANIFEST.txt"
echo
echo "완료: $OUTDIR"
echo "이 디렉터리는 .gitignore 로 제외되어 있습니다. 개인정보 포함 — 커밋 금지."
