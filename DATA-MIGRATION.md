# Supabase → AWS PostgreSQL 데이터 이관

2026년 이벤트 신청 데이터를 Supabase 에서 내려받아 보관하고, 내년 재오픈 때
AWS RDS 로 복원하기 위한 절차다.

**현재 단계: 덤프 파일 확보까지.** RDS 복원은 인스턴스가 준비된 뒤에 한다.

> `backup/` 아래 산출물에는 신청자 실명·소속·팀이 들어 있다.
> `.gitignore` 로 제외되어 있다. 커밋하거나 공유 채널·이슈에 올리지 않는다.

---

## 0. 준비

Docker 만 있으면 된다. `psql` / `pg_dump` 를 로컬에 설치할 필요가 없다.
스크립트가 `postgres:17-alpine` 컨테이너로 실행한다.

```sh
docker --version
```

---

## 1. Supabase 연결 문자열 얻기

Supabase 대시보드 → **Project Settings → Database → Connection string**

세 가지가 보이는데 **포트가 중요하다**:

| 종류 | 포트 | pg_dump |
|---|---|---|
| Session pooler (`...pooler.supabase.com`) | 5432 | ✅ 권장. IPv4 접근 가능 |
| Direct connection (`db.<ref>.supabase.co`) | 5432 | ✅ 단, 프로젝트에 따라 IPv6 전용 |
| Transaction pooler | **6543** | ❌ **동작하지 않는다** |

Transaction pooler(6543)는 prepared statement 를 지원하지 않아 `pg_dump` 가
실패한다. 스크립트가 이 경우를 감지해 먼저 막는다.

비밀번호에 `@ : / ? #` 가 들어 있으면 URL 에서 퍼센트 인코딩해야 한다
(`@` → `%40`, `#` → `%23`). 대시보드가 주는 문자열은 보통 이미 처리되어 있다.

---

## 2. 덤프 실행

두 가지 방법이 있다. **개별 필드 방식(A)을 권장한다** — 비밀번호에 특수문자가
있어도 퍼센트 인코딩을 신경 쓸 필요가 없고, 비밀번호가 셸 히스토리에 남지 않는다.

### (A) 개별 필드 — 권장

```sh
cd ~/source/blood-donation

export PGHOST=aws-0-ap-southeast-1.pooler.supabase.com
export PGPORT=5432
export PGUSER=postgres.<프로젝트ref>
export PGDATABASE=postgres

./db/dump-supabase.sh
# DB 비밀번호 (postgres.xxx@aws-0-...): ← 여기서 입력. 화면에 표시되지 않는다
```

### (B) 커넥션 스트링

```sh
# 앞에 공백 한 칸을 두면 zsh 히스토리에 남지 않는다
 export SUPABASE_DATABASE_URL='postgresql://postgres.xxxx:PASSWORD@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres'

./db/dump-supabase.sh
```

비밀번호에 `@ : / ? #` 가 들어 있으면 URL 에서 퍼센트 인코딩해야 한다
(`@` → `%40`, `#` → `%23`). 이게 번거로우면 (A) 를 쓴다.

`backup/<타임스탬프>/` 에 다음이 생성된다:

| 파일 | 용도 |
|---|---|
| `app-tables.dump` | **복원용.** custom 포맷, `applications` + `donation_history` |
| `app-tables.sql` | 같은 내용의 plain SQL. 사람이 읽거나 diff 할 때 |
| `public-full.sql` | `public` 스키마 전체. **보관용** |
| `applications.csv`, `donation_history.csv` | 엑셀에서 열어볼 용도 |
| `MANIFEST.txt` | 생성 시각, 행 수, 파일 목록 |

`public-full.sql` 은 아카이브 목적이다. Supabase 의 RLS 정책과 역할 참조가
섞여 있어 다른 PostgreSQL 에 그대로 복원하면 실패할 수 있다. 복원에는
`app-tables.dump` 를 쓴다.

**`MANIFEST.txt` 의 행 수를 Supabase 대시보드 Table Editor 에서 눈으로
대조한다.** 이후 모든 검증의 기준이 된다.

### 자주 걸리는 문제

| 증상 | 원인 / 대응 |
|---|---|
| `server version mismatch` | Supabase 가 더 최신. `PG_IMAGE=postgres:18-alpine ./db/dump-supabase.sh` |
| `could not connect` / 타임아웃 | Direct connection 이 IPv6 전용. Session pooler 문자열로 바꾼다 |
| `password authentication failed` | 비밀번호 퍼센트 인코딩 확인. 대시보드에서 재설정 가능 |
| 6543 오류 메시지 | Transaction pooler. 5432 문자열을 쓴다 |

---

## 3. 덤프 검증 (권장)

RDS 가 없어도 로컬에서 왕복 검증을 할 수 있다. 내년에 복원이 실제로
되는지를 지금 확인해 두는 게 이 단계의 목적이다.

```sh
# 로컬 PostgreSQL 기동 (5432 가 이미 쓰이면 LOCAL_DB_PORT 를 바꾼다)
LOCAL_DB_PORT=55432 docker compose -f db/docker-compose.local.yml up -d

export TARGET_DATABASE_URL='postgresql://postgres:postgres@host.docker.internal:55432/blood_donation?sslmode=disable'
./db/restore-postgres.sh backup/<타임스탬프>/app-tables.dump
```

스크립트가 마지막에 테이블별 행 수를 출력한다. `MANIFEST.txt` 와 일치하는지 본다.

내용까지 대조하려면:

```sh
BK=backup/<타임스탬프>
docker exec blood-donation-local-db psql -U postgres -d blood_donation \
  -Atc "\copy (select * from applications order by id) to stdout with (format csv, header true)" \
  > /tmp/restored.csv
diff "$BK/applications.csv" /tmp/restored.csv && echo "원본과 완전 일치"
```

앱까지 붙여서 확인:

```sh
docker build -f docker/Dockerfile -t blood-donation:local .
docker run --rm -p 127.0.0.1:3000:3000 \
  -e ADMIN_PASSWORD=local-pw \
  -e DB_HOST=host.docker.internal -e DB_PORT=55432 \
  -e DB_NAME=blood_donation -e DB_USER=postgres -e DB_PASSWORD=postgres \
  -e DB_SSLMODE=disable \
  blood-donation:local

# 다른 터미널에서
curl -s http://127.0.0.1:3000/api/health
curl -s -u ":local-pw" http://127.0.0.1:3000/api/admin/applications | head -c 400
```

정리:

```sh
LOCAL_DB_PORT=55432 docker compose -f db/docker-compose.local.yml down -v
```

---

## 4. 보관

이벤트가 끝났으므로 덤프 파일 자체가 당분간의 백업이다.

- `backup/<타임스탬프>/` 를 사내 보안 저장소(예: 접근 통제된 공유 드라이브)로
  옮긴다. 개인 노트북에만 두지 않는다.
- 리포지토리에 커밋하지 않는다. `.gitignore` 가 `backup/`, `*.dump`,
  `*.sql.gz` 를 막고 있다.
- 개인정보 보유 기간이 정해져 있다면 그 정책을 따른다. 내년 이벤트에
  작년 신청 데이터가 실제로 필요한지 먼저 판단한다. 필요 없다면
  `donation_history`(이력) 만 남기고 `applications`(신청 내역)는 파기하는 쪽이
  보유 최소화 원칙에 맞는다.

---

## 5. 내년: RDS 로 복원

RDS 인스턴스와 DB/사용자가 준비된 뒤에 실행한다.

### RDS 가 프라이빗 서브넷일 때 (일반적)

로컬에서 직접 붙을 수 없다. 두 가지 방법이 있다.

**방법 A — WAS EC2 에서 실행 (권장)**

```sh
# 덤프와 스크립트를 EC2 로 옮긴다
scp -r backup/<타임스탬프> db ec2-user@<WAS>:/tmp/restore/

# EC2 에서
cd /tmp/restore
 export TARGET_DATABASE_URL='postgresql://USER:URL_ENCODED_PW@<RDS 엔드포인트>:5432/<DB>?sslmode=require'
./db/restore-postgres.sh backup/<타임스탬프>/app-tables.dump

# 끝나면 반드시 지운다 — 개인정보가 EC2 디스크에 남는다
shred -u backup/<타임스탬프>/* 2>/dev/null || rm -rf /tmp/restore
```

**방법 B — SSM 포트 포워딩**

```sh
aws ssm start-session --target <INSTANCE_ID> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["<RDS 엔드포인트>"],"portNumber":["5432"],"localPortNumber":["55433"]}'

# 다른 터미널에서
 export TARGET_DATABASE_URL='postgresql://USER:URL_ENCODED_PW@host.docker.internal:55433/<DB>?sslmode=require'
./db/restore-postgres.sh backup/<타임스탬프>/app-tables.dump
```

### 스크립트 동작

1. 대상 DB 연결 확인
2. `db/schema.sql` 적용 (멱등)
3. **기존 데이터가 있으면 중단한다.** 덮어쓰려면 `CONFIRM_OVERWRITE=yes`
   (이 경우 두 테이블을 `TRUNCATE ... RESTART IDENTITY` 후 복원)
4. `pg_restore --data-only --single-transaction` 로 복원
5. `donation_history.id` 시퀀스를 `max(id)` 로 정렬 —
   이걸 빠뜨리면 새 이력 INSERT 가 기본키 충돌로 실패한다
6. 테이블별 행 수 출력

`--disable-triggers` 는 superuser 권한이 필요해 RDS 에서 실패하므로 쓰지 않는다.

### 복원 후

```sh
# WAS 내부에서
curl -fsS --max-time 8 http://127.0.0.1:CHANGEME_HOST_PORT/api/health
```

`{"status":"ok","db":"ok"}` 와 관리자 페이지의 신청 목록을 확인한다.

---

## 6. 내년 이벤트 재오픈 시 코드에서 바꿀 것

데이터 이관과 별개로 `server.js` 상단 상수를 갱신해야 한다:

| 상수 | 현재 값 | 비고 |
|---|---|---|
| `VALID_DATES` | `['2026-08-31', '2026-09-01']` | 2027년 행사일로 교체 |
| `BLOCKED_SLOTS` | 위 날짜의 12:00 / 12:30 | 새 날짜 기준으로 다시 작성 |
| `TIMES`, `MAX_PER_SLOT` | 09:00~16:30, 슬롯당 6명 | 운영 조건 변경 시 |
| `EXTRA_COUNTS`, `BLOCKED_DATES` | 빈 배열 | 필요 시 |

`VALID_DATES` 를 바꾸면 **작년 신청 데이터는 `/api/slots` 집계에서 자동으로
빠진다**(날짜가 매칭되지 않으므로). 다만 `/api/search` 와 관리자 목록에는
계속 노출된다. 작년 데이터를 남긴 채 재오픈하려면 이 동작이 의도한 것인지
먼저 판단한다. 대안은 4절의 보유 최소화 — 새 이벤트 전에 `applications` 를
비우고 시작하는 것이다.
