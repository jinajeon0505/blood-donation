# 배포 가이드 (AWS EC2 / ECR / PostgreSQL)

Vercel + Supabase 구성을 걷어내고 Hecto 표준 AWS 토폴로지로 옮기기 위한 문서다.
**2026년 이벤트는 종료된 상태이며, 이 리포지토리는 "준비만 되어 있는" 상태다.**
실제 배포는 `CHANGEME_*` 값을 모두 확정한 뒤에 시작한다.

---

## 1. 선택한 배포 형태

```
인터넷
  → Nginx EC2 (공인, TLS/리버스 프록시)
  → WAS EC2 (프라이빗) : Docker Compose 로 blood-donation 컨테이너 1개
  → RDS PostgreSQL (프라이빗) : TLS
GitHub Actions → ECR 푸시 → SSM SendCommand → WAS 에서 compose up
```

**정적 파일도 컨테이너가 서빙한다.** 이 앱의 프런트엔드는 빌드 단계가 없는
정적 파일이라 원칙대로면 Nginx 가 직접 서빙해야 한다. 하지만 `/admin.html` 은
Express 의 Basic 인증(`requireAdminAuth`)을 통과해야만 내려간다
(`server.js` 의 `app.get('/admin.html', ...)`). Nginx 가 `public/` 을 직접
서빙하면 이 인증이 통째로 우회된다. 그래서 정적 파일을 이미지에 담고 Nginx 는
전부 프록시만 한다. 자산 총량이 244KB 라 빌드 컨텍스트 부담도 없다.

**운영 PostgreSQL 은 Compose 에 넣지 않는다.** RDS 를 `.env.production` 으로
가리킨다. `db/docker-compose.local.yml` 은 로컬 검증 전용이다.

---

## 2. 확정해야 할 값 (`CHANGEME_*`)

배포 전에 전부 실제 값으로 바꾼다. 아래 "제안값"은 조직 컨벤션에서 유도한
것이며, 확정 전까지는 제안일 뿐이다.

| 플레이스홀더 | 제안값 | 확인 방법 |
|---|---|---|
| `CHANGEME_SLUG` | `blood-donation` | 팀 합의. compose project/컨테이너명/경로/태그 접두사에 모두 쓰인다 |
| `CHANGEME_DOMAIN` | `blood-donation.hecto.co.kr` | DNS 담당자 확인 |
| `CHANGEME_HOST_PORT` | `3010` | **표를 믿지 말고 실호스트를 볼 것** (아래 명령) |
| `CHANGEME_PRIVATE_BIND` | `127.0.0.1` 또는 WAS 프라이빗 IP | Nginx 가 같은 호스트면 `127.0.0.1`, 별도 EC2 면 프라이빗 IP |
| `CHANGEME_WAS_PRIVATE_HOST` | — | WAS EC2 프라이빗 DNS/IP |
| `CHANGEME_SHARED_ECR_REPOSITORY` | `hectoadmin` | **앱별 리포지토리를 새로 만들지 않는다.** 하나를 공유하고 태그 접두사로 구분 |
| `CHANGEME_RDS_PRIVATE_ENDPOINT` / `CHANGEME_DATABASE_NAME` / `CHANGEME_DATABASE_USER` | — | RDS 프로비저닝 시 확정 |
| `CHANGEME_SECRET` | — | EC2 에서 생성. 이 리포지토리에 절대 쓰지 않는다 |

호스트 포트는 반드시 실제 호스트에서 확인한다. 컨테이너 포트는 모든 앱이
3000 이고 호스트 쪽만 다르다:

```sh
# SSM 세션에서
ss -lntp | grep :30
docker ps --format '{{.Names}} {{.Ports}}'
```

기록상 `3000~3009`, `8790` 이 사용 중이라 `3010` 을 제안하지만 드리프트한다.
확정 후 `deploy-aws-ec2-ecr-postgres` 스킬의 `references/org-conventions.md`
호스트 포트 표에 항목을 추가한다.

치환은 한 번에 할 수 있다:

```sh
SLUG=blood-donation
grep -rl 'CHANGEME_SLUG' docker .github DEPLOY.md .env.production.example \
  | xargs sed -i '' "s/CHANGEME_SLUG/$SLUG/g"
git mv docker/nginx/CHANGEME_SLUG.conf "docker/nginx/$SLUG.conf"
```

호스트 포트는 **세 곳이 일치해야 한다**: `docker/docker-compose.yml` 의
`ports`, 워크플로의 헬스 체크(`HOST_PORT`), Nginx `upstream`.

---

## 3. 리포지토리에 추가/변경된 파일

| 파일 | 역할 |
|---|---|
| `docker/Dockerfile` | 멀티스테이지 Node 22 이미지. non-root(`node`) 실행 |
| `docker/docker-compose.yml` | WAS 운영 Compose. 이미지 참조는 `ECR_IMAGE` 필수 |
| `docker/nginx/CHANGEME_SLUG.conf` | Nginx 리버스 프록시 서버 블록 |
| `.github/workflows/deploy.yml` | ECR 빌드·푸시 → SSM 배포 → 헬스 검증 |
| `.dockerignore` | 비밀·덤프·로컬 산출물 제외 |
| `.env.production.example` | 운영 환경변수 이름 목록 (값 없음) |
| `db/schema.sql` | 스키마 정본 |
| `db/dump-supabase.sh` | Supabase → 로컬 덤프 |
| `db/restore-postgres.sh` | 덤프 → RDS/로컬 복원 |
| `db/docker-compose.local.yml` | 로컬 검증용 PostgreSQL |
| `DATA-MIGRATION.md` | Supabase 데이터 백업/복원 절차 |
| ~~`vercel.json`~~ | **삭제됨** |
| `server.js` | Vercel 서버리스 export 제거, `/api/health` 추가, DB 접속 설정 개선 |

---

## 4. 최초 1회 AWS / GitHub 준비

리포지토리 파일과 달리 아래는 사람이 직접 하는 작업이다.

### 4.1 ECR

공유 리포지토리(`CHANGEME_SHARED_ECR_REPOSITORY`)를 그대로 쓴다. 새로 만들지 않는다.

라이프사이클 정책을 건드릴 경우 **반드시 `tagPrefixList` 로 범위를 좁힌다.**
접두사 없는 `imageCountMoreThan` 규칙은 다른 앱의 롤백 이미지를 지운다.
`put-lifecycle-policy` 는 정책 전체를 교체하므로 기존 정책과 병합할 것.

```json
{"rules": [{
  "rulePriority": 1,
  "selection": {
    "tagStatus": "tagged",
    "tagPrefixList": ["CHANGEME_SLUG-"],
    "countType": "imageCountMoreThan",
    "countNumber": 20
  },
  "action": {"type": "expire"}
}]}
```

### 4.2 GitHub Secrets

| 이름 | 값 |
|---|---|
| `AWS_ACCESS_KEY_ID` | 배포용 IAM 사용자 액세스 키 |
| `AWS_SECRET_ACCESS_KEY` | 위 시크릿 키 |
| `EC2_INSTANCE_ID` | WAS EC2 인스턴스 ID |

조직은 OIDC 가 아니라 장기 IAM 액세스 키를 쓴다. OIDC 가 더 안전하지만
(액세스 키는 만료되지 않아 유출 시 계속 악용 가능) 이 앱 하나만 방식을
바꾸면 자격증명 로테이션이 더 복잡해진다. 조직 표준을 따랐다.

비밀이 아닌 값(리전, ECR 리포지토리, 앱 경로, 호스트 포트)은 GitHub Variables
가 아니라 워크플로 `env:` 블록에 둔다.

배포 IAM 사용자에게 필요한 권한: ECR 인증/업로드(해당 리포지토리 범위),
`ssm:SendCommand`(대상 인스턴스 + `AWS-RunShellScript`), `ssm:GetCommandInvocation`.
RDS 비밀번호나 광범위한 EC2 변경 권한은 필요 없다.

### 4.3 WAS EC2

인스턴스 역할에 SSM 관리형 인스턴스 연결 + ECR 인증/이미지 풀 권한이 있어야 한다.

```sh
# SSM 에이전트 확인
sudo systemctl status amazon-ssm-agent

# Docker / Compose 확인
docker --version && docker compose version

# 앱 디렉터리
sudo install -d -o CHANGEME_DEPLOY_USER -g CHANGEME_DEPLOY_GROUP -m 750 /app/CHANGEME_SLUG
sudo install -d -o CHANGEME_DEPLOY_USER -g CHANGEME_DEPLOY_GROUP -m 750 /app/CHANGEME_SLUG/docker
```

`docker/docker-compose.yml` 을 `/app/CHANGEME_SLUG/docker/docker-compose.yml`
에 배치한다.

### 4.4 RDS

- 보안 그룹: 5432 를 **WAS 보안 그룹에서만** 허용. 공인 접근 금지.
- DB/사용자 생성 후 스키마는 앱이 부팅 시 자동 생성한다(6절 참고).
- `DB_SSLMODE=require` 는 전송을 암호화하지만 서버 인증서를 검증하지 않는다.
  더 강한 `verify-full` 을 쓰려면 RDS CA 번들을 이미지 밖 경로에 두고
  볼륨 마운트한 뒤 `DB_SSL_CA_PATH` 를 지정한다.

### 4.5 Nginx EC2

`docker/nginx/CHANGEME_SLUG.conf` 를 `/etc/nginx/conf.d/` 에 배치하고:

```sh
sudo nginx -t && sudo systemctl reload nginx
```

TLS 인증서 경로와 도메인은 운영자 소유 값이다. 이 문서는 80 포트 블록만 제공한다.

### 4.6 S3

이 앱은 파일 업로드가 없다. S3 버킷/CORS/라이프사이클 설정은 필요 없다.

---

## 5. `.env.production` 만들기

리포지토리에는 이름만 있는 `.env.production.example` 이 있다. 실제 값이 든
파일은 **WAS EC2 에서 직접** 만든다. 로컬에서 만들어 올리지 않는다.

```sh
sudo install -d -o CHANGEME_DEPLOY_USER -g CHANGEME_DEPLOY_GROUP -m 750 /app/CHANGEME_SLUG
if ! sudo test -e /app/CHANGEME_SLUG/.env.production; then
  sudo install -o CHANGEME_DEPLOY_USER -g CHANGEME_DEPLOY_GROUP -m 600 \
    /dev/null /app/CHANGEME_SLUG/.env.production
fi
sudo chown CHANGEME_DEPLOY_USER:CHANGEME_DEPLOY_GROUP /app/CHANGEME_SLUG/.env.production
sudo chmod 600 /app/CHANGEME_SLUG/.env.production
sudo -u CHANGEME_DEPLOY_USER vi /app/CHANGEME_SLUG/.env.production
```

`ADMIN_PASSWORD` 는 EC2 에서 생성한다. 셸 히스토리나 Actions 로그에 값이
남지 않도록 에디터에 직접 붙여 넣는다:

```sh
openssl rand -base64 32   # 출력만 하고 파일에 리다이렉트하지 않는다
```

### 환경변수 인벤토리

| 이름 | 분류 | 비고 |
|---|---|---|
| `NODE_ENV` | 필수 · 비밀 아님 | `production` |
| `PORT` | 필수 · 비밀 아님 | `3000`. Compose 컨테이너 포트와 일치해야 함 |
| `ADMIN_PASSWORD` | **필수 · 비밀** | 없으면 관리자 API 가 500 을 반환한다 |
| `DB_HOST` | 필수 · 비밀 아님 | RDS 프라이빗 엔드포인트 |
| `DB_PORT` | 선택 (기본 `5432`) | |
| `DB_NAME` | 필수 · 비밀 아님 | |
| `DB_USER` | 필수 · 비밀 아님 | |
| `DB_PASSWORD` | **필수 · 비밀** | |
| `DB_SSLMODE` | 선택 (기본 `require`) | `disable` / `require` / `verify-full` |
| `DB_SSL_CA_PATH` | 선택 | `verify-full` 일 때 필수 |
| `DATABASE_URL` | 폴백 | `DB_HOST` 가 없을 때만 사용. 비밀번호 퍼센트 인코딩 필수 |

`DB_HOST` 방식과 `DATABASE_URL` 방식 중 **하나만** 채운다. 개별 필드 쪽이
퍼센트 인코딩 실수를 피할 수 있어 권장이다.

### 값 노출 없이 검증

```sh
stat -c '%U:%G %a %n' /app/CHANGEME_SLUG/.env.production   # 기대: 배포유저 600

set -eu
ENV_FILE=/app/CHANGEME_SLUG/.env.production
for key in ADMIN_PASSWORD DB_HOST DB_NAME DB_USER DB_PASSWORD; do
  grep -Eq "^${key}=.+" "$ENV_FILE" || { echo "missing or empty: $key" >&2; exit 1; }
done
echo "env ok"

# Compose 가 파일을 읽는지 확인. --quiet 없이 실행하면 값이 로그에 찍힌다.
ECR_IMAGE=example.invalid/CHANGEME_SHARED_ECR_REPOSITORY:test \
  docker compose -p CHANGEME_SLUG -f /app/CHANGEME_SLUG/docker/docker-compose.yml config --quiet
```

---

## 6. 마이그레이션 전략

**선택: 앱 부팅 시 멱등 초기화 (엔트리포인트 방식).**

`server.js` 의 `initDB()` 가 `CREATE TABLE IF NOT EXISTS` 와
`ADD COLUMN IF NOT EXISTS` 로 스키마를 적용한다. 레플리카가 1개이고 모든 문이
멱등이므로 안전하다. 별도 마이그레이션 러너나 원샷 컨테이너는 두지 않았다.

`db/schema.sql` 은 같은 내용의 정본이며 복원 스크립트가 사용한다.
스키마를 바꿀 때 **두 곳을 함께** 고쳐야 한다.

주의:
- 파괴적 변경(컬럼 삭제, 타입 변경, 대량 백필)은 이 경로로 처리하지 않는다.
  RDS 스냅샷을 먼저 뜨고 수동으로 진행한다.
- 스키마를 바꾼 뒤에는 이전 이미지로의 롤백이 안전하지 않을 수 있다.
- `initDB()` 가 실패해도 프로세스는 뜬다. 그래야 `/api/health` 가 503 으로
  원인을 보고하고 배포 파이프라인이 실패로 판정할 수 있다.

---

## 7. 배포 · 검증 · 롤백

### 배포

> **현재 트리거는 `workflow_dispatch` 하나뿐이다.** 2026 이벤트가 끝난
> 상태라 `main` 에 머지하거나 푸시해도 워크플로가 돌지 않는다.
> Actions 탭 > "Deploy to AWS" > Run workflow 로만 실행된다.
>
> **AWS Secrets 는 이미 등록되어 있다.** 즉 `push` 트리거를 켜는 순간부터는
> 머지 = 실제 운영 배포다. 내년 재오픈 준비가 끝나기 전에 켜지 않는다.
>
> 켜는 순서:
> 1. 2절의 `CHANGEME_*` 를 전부 확정 (특히 `ECR_REPOSITORY`, `HOST_PORT`)
> 2. `workflow_dispatch` 로 수동 배포를 한 번 성공시켜 검증
> 3. 그 다음에 `deploy.yml` 의 `on:` 아래에 `push: branches: [main]` 추가
>
> 2번을 건너뛰고 3번부터 하면 첫 머지가 곧 검증 안 된 첫 배포가 된다.

워크플로는 커밋마다 불변 태그
`CHANGEME_SLUG-<YYYYMMDD>-<HHMMSS>-<sha7>` 를 만들어 이 태그로 배포한다.
`CHANGEME_SLUG-latest` 는 편의용 이동 태그일 뿐 배포 참조가 아니다.

`concurrency: production-deploy` 로 동시 배포를 막는다.

### 헬스 검증

`GET /api/health` 는 `SELECT 1` 까지 확인한다.

- DB 정상: `200 {"status":"ok","db":"ok"}`
- DB 불통: `503 {"status":"degraded","db":"error"}` (약 5초 내 응답)

컨테이너가 떴다는 것만으로 성공 처리하지 않는다. 이 엔드포인트는 Nginx
설정에서 404 로 막아 외부에 노출하지 않는다. 검증은 WAS 내부에서 한다:

```sh
curl -fsS --max-time 8 http://127.0.0.1:CHANGEME_HOST_PORT/api/health
```

### 롤백

이전에 성공한 불변 태그로 다시 올린다:

```sh
ECR_IMAGE=<registry>/CHANGEME_SHARED_ECR_REPOSITORY:<이전-태그> \
  docker compose -p CHANGEME_SLUG -f /app/CHANGEME_SLUG/docker/docker-compose.yml up -d
```

사용 가능한 태그 확인:

```sh
aws ecr describe-images --repository-name CHANGEME_SHARED_ECR_REPOSITORY \
  --query 'reverse(sort_by(imageDetails,&imagePushedAt))[:10].imageTags' --output text \
  | tr '\t' '\n' | grep '^CHANGEME_SLUG-'
```

롤백 후에도 헬스를 확인한다. 스키마를 바꾼 릴리스라면 롤백 전에 호환성을 먼저 판단한다.

### 로그 · 상태 · 정리

```sh
docker ps --filter name=CHANGEME_SLUG
docker logs --tail 100 CHANGEME_SLUG
docker compose -p CHANGEME_SLUG -f /app/CHANGEME_SLUG/docker/docker-compose.yml ps
df -h /var/lib/docker
```

공유 Docker 호스트다. **`--remove-orphans` 와 `docker system prune -af` 를
쓰지 않는다.** 다른 앱의 컨테이너와 롤백 이미지를 지운다. 워크플로는 배포
성공 후 `docker image prune -f`(dangling 만) 로 제한한다.

---

## 8. 검증 결과

이 리포지토리에서 실제로 돌려본 것:

| 검사 | 결과 |
|---|---|
| `node --check server.js` | 통과 |
| YAML 파싱 (compose, workflow, local db) | 통과 |
| `docker build -f docker/Dockerfile` | 통과 |
| 컨테이너 구동 + `/api/health` | `200 {"status":"ok","db":"ok"}` |
| DB 불통 시 `/api/health` | `503`, 약 5초 내 응답 |
| Compose 헬스체크 명령(BusyBox `wget`) | 정상(정상 시 exit 0 / 503 시 exit 1) |
| 관리자 API 인증 | 미인증 401, 인증 시 200 |
| non-root 실행 | `uid=1000(node)` |
| `docker compose config --quiet` (치환본) | 통과. `ECR_IMAGE` 미지정 시 거부됨 |
| `nginx -t` (치환본, `nginx:1.27-alpine`) | 통과 |
| 덤프 → 복원 왕복 (로컬 PostgreSQL 17) | 행 수·내용 완전 일치 |

**아직 검증하지 못한 것** (자격증명·인프라 필요):

- 실제 ECR 푸시, SSM 배포, RDS 연결 — 로컬에 AWS 자격증명이 없다.
- Supabase 실덤프 — 연결 문자열을 받지 않았다. `DATA-MIGRATION.md` 참고.
- `actionlint` 미실행 (미설치).

`CHANGEME_*` 가 하나라도 남아 있으면 배포 가능한 상태가 아니다.
