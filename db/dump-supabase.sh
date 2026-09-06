#!/usr/bin/env bash
# Supabase PostgreSQL 을 로컬 파일로 덤프한다.
#
# 사용법 — 둘 중 편한 쪽을 쓴다.
#
# (A) 개별 필드 (권장). 비밀번호 퍼센트 인코딩이 필요 없다.
#   export PGHOST=aws-0-ap-southeast-1.pooler.supabase.com
#   export PGPORT=5432
#   export PGUSER=postgres.xxxxxxxxxxxx
#   export PGDATABASE=postgres
#   ./db/dump-supabase.sh          # 비밀번호는 입력 프롬프트로 받는다
#
# (B) 커넥션 스트링
#   export SUPABASE_DATABASE_URL='postgresql://user:PASSWORD@host:5432/postgres'
#   ./db/dump-supabase.sh
#
# 중요 — 반드시 포트 5432 로 접속할 것:
#   Supabase 대시보드 > Connect (또는 Settings > Database > Connection string)
#     * "Session pooler"     (...pooler.supabase.com:5432) — IPv4 가능, 권장
#     * "Direct connection"  (db.<ref>.supabase.co:5432)   — IPv6 전용일 수 있음
#     * "Transaction pooler" (...:6543) — pg_dump 가 동작하지 않는다. 쓰지 말 것.
#
# 산출물은 backup/<타임스탬프>/ 아래에 생성되고 .gitignore 로 제외된다.
# 신청자 실명·소속이 들어 있으므로 커밋하거나 공유 채널에 올리지 않는다.

set -euo pipefail

# ── 접속 정보 확정 ────────────────────────────────────────────────────
# URL 이 있으면 URL 모드, 없으면 개별 PG* 필드 모드로 동작한다.

# 둘 다 설정되어 있으면 어느 쪽이 쓰이는지 불분명하다. 예전 시도에서 남은
# SUPABASE_DATABASE_URL 이 방금 고친 PGHOST 를 조용히 덮어쓰면, 값을 고쳐도
# 같은 오류가 반복되어 원인을 찾기 어렵다. 명시적으로 하나만 남기게 한다.
if [ -n "${SUPABASE_DATABASE_URL:-}" ] && [ -n "${PGHOST:-}" ]; then
  echo "오류: SUPABASE_DATABASE_URL 과 PGHOST 가 둘 다 설정되어 있습니다." >&2
  echo "      둘 중 하나만 남기세요." >&2
  echo >&2
  echo "  개별 필드로 쓰려면 :  unset SUPABASE_DATABASE_URL" >&2
  echo "  URL 로 쓰려면      :  unset PGHOST PGPORT PGUSER PGDATABASE" >&2
  exit 1
fi

if [ -n "${SUPABASE_DATABASE_URL:-}" ]; then
  MODE=url

  # URL 형식 검증. 특히 '@' 개수 — 비밀번호에 @ 가 인코딩 없이 들어가거나
  # 템플릿의 @ 가 중복되면 libpq 가 호스트를 소켓 경로로 오인해서
  # "Is the server running locally" 라는 엉뚱한 오류를 낸다.
  case "$SUPABASE_DATABASE_URL" in
    postgres://*|postgresql://*) ;;
    *)
      echo "오류: SUPABASE_DATABASE_URL 이 postgresql:// 로 시작하지 않습니다." >&2
      exit 1
      ;;
  esac
  _rest="${SUPABASE_DATABASE_URL#*://}"
  _authority="${_rest%%/*}"
  _ats="$(printf '%s' "$_authority" | tr -cd '@' | wc -c | tr -d ' ')"
  if [ "$_ats" != "1" ]; then
    echo "오류: URL 의 '@' 가 ${_ats}개입니다. 정확히 1개여야 합니다." >&2
    echo "      형식: postgresql://<유저>:<비밀번호>@<호스트>:5432/postgres" >&2
    if [ "$_ats" -gt 1 ]; then
      echo "      비밀번호에 '@' 가 있으면 %40 으로 인코딩해야 합니다." >&2
      echo "      인코딩이 번거로우면 개별 필드 방식을 쓰세요:" >&2
      echo "        unset SUPABASE_DATABASE_URL" >&2
      echo "        export PGHOST=... PGUSER=... PGDATABASE=postgres" >&2
    fi
    exit 1
  fi
  EFFECTIVE_HOST="${_authority##*@}"

  export PGURL="$SUPABASE_DATABASE_URL"
  PORT_CHECK="$SUPABASE_DATABASE_URL"
  DOCKER_ENV=(--env PGURL)
else
  MODE=fields
  : "${PGPORT:=5432}"
  : "${PGDATABASE:=postgres}"
  MISSING=""
  [ -z "${PGHOST:-}" ] && MISSING="$MISSING PGHOST"
  [ -z "${PGUSER:-}" ] && MISSING="$MISSING PGUSER"
  if [ -n "$MISSING" ]; then
    echo "오류: 접속 정보가 없습니다. 빠진 값:$MISSING" >&2
    echo >&2
    echo "  export PGHOST=aws-0-<리전>.pooler.supabase.com" >&2
    echo "  export PGPORT=5432" >&2
    echo "  export PGUSER=postgres.<프로젝트ref>" >&2
    echo "  export PGDATABASE=postgres" >&2
    echo >&2
    echo "또는 SUPABASE_DATABASE_URL 에 커넥션 스트링 전체를 넣으세요." >&2
    exit 1
  fi
  # 커넥션 스트링 조각을 필드에 그대로 붙여 넣는 실수를 잡는다.
  # libpq 는 호스트가 @ 또는 / 로 시작하면 유닉스 소켓 경로로 해석하기 때문에
  # "Connection refused ... Is the server running locally" 라는 엉뚱한 오류가 난다.
  hint_and_die() {
    echo "오류: $1" >&2
    echo "      PGHOST 에는 호스트 이름만 넣습니다. 예:" >&2
    echo "        export PGHOST=aws-0-ap-southeast-1.pooler.supabase.com" >&2
    echo "      커넥션 스트링을 통째로 쓰려면 SUPABASE_DATABASE_URL 을 쓰세요." >&2
    exit 1
  }
  case "$PGHOST" in
    *"://"*)  hint_and_die "PGHOST 에 URL 스킴이 들어 있습니다: [$PGHOST]" ;;
    *@*)      hint_and_die "PGHOST 에 '@' 가 들어 있습니다: [$PGHOST]" ;;
    /*)       hint_and_die "PGHOST 가 '/' 로 시작해 소켓 경로로 해석됩니다: [$PGHOST]" ;;
    *:*)      hint_and_die "PGHOST 에 포트가 붙어 있습니다. 포트는 PGPORT 로: [$PGHOST]" ;;
    */*)      hint_and_die "PGHOST 에 경로가 들어 있습니다: [$PGHOST]" ;;
    *[![:print:]]*|*" "*) hint_and_die "PGHOST 에 공백/제어문자가 있습니다: [$PGHOST]" ;;
  esac
  case "$PGUSER" in
    *@*|*:*)  hint_and_die "PGUSER 에 '@' 나 ':' 가 들어 있습니다: [$PGUSER]" ;;
  esac
  case "$PGPORT" in
    ''|*[!0-9]*) hint_and_die "PGPORT 가 숫자가 아닙니다: [$PGPORT]" ;;
  esac

  # 비밀번호는 프롬프트로 받는다. 셸 히스토리에 남지 않는다.
  if [ -z "${PGPASSWORD:-}" ]; then
    printf 'DB 비밀번호 (%s@%s): ' "$PGUSER" "$PGHOST" >&2
    stty -echo 2>/dev/null || true
    read -r PGPASSWORD
    stty echo 2>/dev/null || true
    printf '\n' >&2
    [ -n "$PGPASSWORD" ] || { echo "오류: 비밀번호가 비어 있습니다." >&2; exit 1; }
  fi
  export PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD
  EFFECTIVE_HOST="$PGHOST:$PGPORT"
  PORT_CHECK=":$PGPORT/"
  DOCKER_ENV=(--env PGHOST --env PGPORT --env PGUSER --env PGDATABASE --env PGPASSWORD --env PGSSLMODE)
fi

case "$PORT_CHECK" in
  *:6543*)
    echo "오류: 6543(Transaction pooler) 으로는 pg_dump 가 동작하지 않습니다." >&2
    echo "      5432(Session pooler 또는 Direct connection) 로 접속하세요." >&2
    exit 1
    ;;
esac

# 서버가 더 최신이라 'server version mismatch' 가 나면 이 값을 올린다.
PG_IMAGE="${PG_IMAGE:-postgres:17-alpine}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +'%Y%m%d-%H%M%S')"
OUTDIR="$REPO_ROOT/backup/$STAMP"
mkdir -p "$OUTDIR"

# 접속 정보는 --env 환경 상속으로 넘긴다. docker 명령줄(=프로세스 목록)에
# 값이 노출되지 않는다. SQL 은 stdin 으로 넘겨 중첩 인용을 피한다.
# URL 모드면 psql/pg_dump 에 URL 을 넘기고, 필드 모드면 libpq 가 PG* 를 읽는다.
psql_in() {
  docker run --rm -i "${DOCKER_ENV[@]}" --user "$(id -u):$(id -g)" \
    -v "$OUTDIR:/out" "$PG_IMAGE" \
    sh -c 'if [ -n "${PGURL:-}" ]; then exec psql "$PGURL" -v ON_ERROR_STOP=1 "$@" -f -; \
           else exec psql -v ON_ERROR_STOP=1 "$@" -f -; fi' sh "$@"
}
pg_dump_run() {
  docker run --rm "${DOCKER_ENV[@]}" --user "$(id -u):$(id -g)" \
    -v "$OUTDIR:/out" "$PG_IMAGE" \
    sh -c 'if [ -n "${PGURL:-}" ]; then exec pg_dump "$PGURL" "$@"; \
           else exec pg_dump "$@"; fi' sh "$@"
}

echo "==> 연결 확인 (모드=$MODE, 대상=$EFFECTIVE_HOST)"
if ! psql_in -At <<'SQL' | sed 's/^/    /'
select current_database();
select version();
SQL
then
  echo "연결 실패 (대상=$EFFECTIVE_HOST)." >&2
  echo "  * \"Is the server running locally\" 가 보이면 호스트가 소켓 경로로 해석된 것이다." >&2
  echo "    PGHOST 앞의 '@' 나 URL 의 '@' 중복을 확인하세요." >&2
  echo "  * \"password authentication failed\" 는 비밀번호 문제다." >&2
  echo "    Supabase 풀러는 postgres.<ref> 에서 접미사를 떼어내므로," >&2
  echo "    오류에 user \"postgres\" 로 표시되는 것은 정상이다. PGUSER 문제가 아니다." >&2
  echo "  * 타임아웃이면 IPv4 접근 가능 여부를 확인하세요." >&2

  # 비밀번호 진단. 값은 절대 출력하지 않고 형태만 알려준다.
  if [ "$MODE" = fields ] && [ -n "${PGPASSWORD:-}" ]; then
    echo >&2
    echo "  입력한 비밀번호 형태 (값은 표시하지 않음):" >&2
    echo "    길이       : ${#PGPASSWORD}자" >&2
    case "$PGPASSWORD" in
      " "*|*" ") echo "    ⚠ 앞이나 뒤에 공백이 있습니다. 복사할 때 딸려온 것일 수 있습니다." >&2 ;;
    esac
    case "$PGPASSWORD" in
      *%[0-9A-Fa-f][0-9A-Fa-f]*)
        echo "    ⚠ 퍼센트 인코딩(%XX)처럼 보입니다." >&2
        echo "      URL 에서 복사했다면 디코딩한 원본을 입력해야 합니다 (%40 → @)." >&2
        ;;
    esac
    case "$PGPASSWORD" in
      *"["*|*"]"*)
        echo "    ⚠ 대괄호가 있습니다. [YOUR-PASSWORD] 같은 자리표시자를 그대로 넣지 않았는지 확인하세요." >&2
        ;;
    esac
  fi
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
  echo "접속 모드 : $MODE"
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
