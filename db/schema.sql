-- blood-donation 애플리케이션 스키마 (server.js 의 initDB() 와 동일)
--
-- 앱은 부팅 시 이 스키마를 멱등하게 직접 적용한다(단일 레플리카 전제).
-- 이 파일은 그 정본(canonical) 참조이며, 백업 복원 대상 DB 를 미리
-- 준비하거나 스키마를 리뷰할 때 사용한다.

CREATE TABLE IF NOT EXISTS applications (
  id         BIGINT      PRIMARY KEY,
  code       VARCHAR(8)  UNIQUE NOT NULL,
  date       VARCHAR(10),
  time       VARCHAR(5),
  company    TEXT        NOT NULL,
  team       TEXT        NOT NULL,
  name       TEXT        NOT NULL,
  type       VARCHAR(10) NOT NULL DEFAULT 'group',
  created_at VARCHAR(19) NOT NULL
);

-- 개인 신청(individual)은 date/time 이 없다.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS type VARCHAR(10) NOT NULL DEFAULT 'group';
ALTER TABLE applications ALTER COLUMN date DROP NOT NULL;
ALTER TABLE applications ALTER COLUMN time DROP NOT NULL;

CREATE TABLE IF NOT EXISTS donation_history (
  id      SERIAL PRIMARY KEY,
  round   INTEGER NOT NULL,
  company TEXT    NOT NULL,
  team    TEXT,
  name    TEXT    NOT NULL
);
