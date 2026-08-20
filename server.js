const express = require('express');
const path    = require('path');
const { Pool } = require('pg');

const app  = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB Init ───────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id         BIGINT PRIMARY KEY,
      code       VARCHAR(8) UNIQUE NOT NULL,
      date       VARCHAR(10),
      time       VARCHAR(5),
      company    TEXT NOT NULL,
      team       TEXT NOT NULL,
      name       TEXT NOT NULL,
      type       VARCHAR(10) NOT NULL DEFAULT 'group',
      created_at VARCHAR(19) NOT NULL
    )
  `);
  // 기존 테이블 마이그레이션 (컬럼이 이미 있으면 무시됨)
  await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS type VARCHAR(10) NOT NULL DEFAULT 'group'`);
  await pool.query(`ALTER TABLE applications ALTER COLUMN date DROP NOT NULL`);
  await pool.query(`ALTER TABLE applications ALTER COLUMN time DROP NOT NULL`);
}

// ── 상수 ──────────────────────────────────────────────────────────────
const VALID_DATES = ['2026-08-31', '2026-09-01'];
const TIMES = [
  '09:00','09:30','10:00','10:30','11:00','11:30',
  '12:00','12:30','13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30',
];
const MAX_PER_SLOT = 6;

const EXTRA_COUNTS = [];
const BLOCKED_DATES = [];
const BLOCKED_SLOTS = [
  { date: '2026-08-31', time: '12:00' },
  { date: '2026-08-31', time: '12:30' },
  { date: '2026-09-01', time: '12:00' },
  { date: '2026-09-01', time: '12:30' },
];

function validate(date, time) {
  if (!VALID_DATES.includes(date)) return '유효하지 않은 날짜입니다.';
  if (!TIMES.includes(time))       return '유효하지 않은 시간입니다.';
  if (BLOCKED_DATES.some(b => b.date === date))
    return '해당 날짜는 운영하지 않습니다.';
  if (BLOCKED_SLOTS.some(b => b.date === date && b.time === time))
    return '해당 슬롯은 운영하지 않습니다.';
  return null;
}

function generateCode(existingCodes) {
  for (let i = 0; i < 20; i++) {
    const code = Math.random().toString(36).substr(2, 8).toUpperCase();
    if (!existingCodes.has(code)) return code;
  }
  throw new Error('code_gen_failed');
}

// ── API: 슬롯 현황 ────────────────────────────────────────────────────
app.get('/api/slots', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT date, time FROM applications WHERE type='group'");
    const slots = {};
    VALID_DATES.forEach(date => {
      slots[date] = {};
      TIMES.forEach(time => { slots[date][time] = { count: 0 }; });
    });
    rows.forEach(r => {
      if (slots[r.date]?.[r.time] !== undefined) slots[r.date][r.time].count++;
    });
    res.json(slots);
  } catch (e) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// ── API: 신청 생성 ────────────────────────────────────────────────────
app.post('/api/applications', async (req, res) => {
  const { company, team, name } = req.body;
  const type = req.body.type === 'individual' ? 'individual' : 'group';
  const date = type === 'group' ? req.body.date : null;
  const time = type === 'group' ? req.body.time : null;

  if (type === 'group') {
    const err = validate(date, time);
    if (err) return res.status(400).json({ error: err });
  }
  if (!company?.trim() || !team?.trim() || !name?.trim())
    return res.status(400).json({ error: '모든 정보를 입력해주세요.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (type === 'group') {
      const { rows: cnt } = await client.query(
        'SELECT COUNT(*) FROM applications WHERE date=$1 AND time=$2 AND type=\'group\'',
        [date, time]
      );
      const extraPost = EXTRA_COUNTS.find(e => e.date === date && e.time === time)?.extra ?? 0;
      if (parseInt(cnt[0].count) + extraPost >= MAX_PER_SLOT) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: '해당 슬롯이 마감되었습니다.' });
      }
    }
    const { rows: existing } = await client.query('SELECT code FROM applications');
    const existingCodes = new Set(existing.map(r => r.code));
    let code;
    try { code = generateCode(existingCodes); }
    catch { await client.query('ROLLBACK'); return res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }

    const id = Date.now();
    const created_at = new Date().toISOString().replace('T', ' ').substring(0, 19);
    await client.query(
      'INSERT INTO applications (id,code,date,time,company,team,name,type,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, code, date, time, company.trim(), team.trim(), name.trim(), type, created_at]
    );
    await client.query('COMMIT');
    res.json({ id, code });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  } finally {
    client.release();
  }
});

// ── API: 팀 + 이름으로 신청 검색 ─────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const team = req.query.team?.trim();
  const name = req.query.name?.trim();
  if (!team || !name) return res.status(400).json({ error: '팀과 이름을 입력해주세요.' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM applications WHERE team=$1 AND name=$2 ORDER BY date, time',
      [team, name]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// ── API: 코드로 신청 조회 ─────────────────────────────────────────────
app.get('/api/applications/:code', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM applications WHERE code=$1',
      [req.params.code.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: '신청 내역을 찾을 수 없습니다.' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// ── API: 신청 수정 ────────────────────────────────────────────────────
app.put('/api/applications/:code', async (req, res) => {
  const code = req.params.code.toUpperCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM applications WHERE code=$1', [code]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '신청 내역을 찾을 수 없습니다.' });
    }
    const cur = rows[0];
    const company = (req.body.company ?? cur.company).trim();
    const team    = (req.body.team    ?? cur.team).trim();
    const name    = (req.body.name    ?? cur.name).trim();
    if (!company || !team || !name) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '모든 정보를 입력해주세요.' });
    }

    let date = cur.date, time = cur.time;
    if (cur.type === 'group') {
      date = req.body.date ?? cur.date;
      time = req.body.time ?? cur.time;
      const err = validate(date, time);
      if (err) { await client.query('ROLLBACK'); return res.status(400).json({ error: err }); }

      const slotChanged = date !== cur.date || time !== cur.time;
      if (slotChanged) {
        const { rows: cnt } = await client.query(
          'SELECT COUNT(*) FROM applications WHERE date=$1 AND time=$2 AND code!=$3 AND type=\'group\'',
          [date, time, code]
        );
        const extraPut = EXTRA_COUNTS.find(e => e.date === date && e.time === time)?.extra ?? 0;
        if (parseInt(cnt[0].count) + extraPut >= MAX_PER_SLOT) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: '해당 슬롯이 마감되었습니다.' });
        }
      }
    }

    await client.query(
      'UPDATE applications SET date=$1, time=$2, company=$3, team=$4, name=$5 WHERE code=$6',
      [date, time, company, team, name, code]
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  } finally {
    client.release();
  }
});

// ── API: 신청 취소 ────────────────────────────────────────────────────
app.delete('/api/applications/:code', async (req, res) => {
  const code = req.params.code.toUpperCase();
  try {
    const { rowCount } = await pool.query('DELETE FROM applications WHERE code=$1', [code]);
    if (!rowCount) return res.status(404).json({ error: '신청 내역을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// ── API: 관리자 전체 조회 ─────────────────────────────────────────────
app.get('/api/admin/applications', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM applications ORDER BY date, time'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// ── Start / Export ────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  initDB()
    .catch(e => console.warn('⚠️  DB 초기화 실패 (DATABASE_URL 확인):', e.message))
    .finally(() => {
      app.listen(PORT, () => {
        console.log(`\n✅ 서버 실행 중: http://localhost:${PORT}`);
        console.log(`⚙️  관리자 페이지: http://localhost:${PORT}/admin.html\n`);
      });
    });
} else {
  initDB().catch(console.error);
  module.exports = app;
}
