const DATES = [
  { value: '2026-08-31', month: '8', day: '31', dow: '월' },
  { value: '2026-09-01', month: '9', day: '1',  dow: '화' },
];
const TIMES = [
  '08:00','08:30','09:00','09:30','10:00','10:30','11:00','11:30',
  '12:00','12:30','13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30',
];
const MAX = 6;
const EXTRA_COUNTS = [];
const BLOCKED_DATES = [];
const BLOCKED_SLOTS = [];
const COMPANIES = [
  '헥토', '헥토이노베이션', '헥토파이낸셜', '헥토헬스케어', '헥토데이터',
  '헥토미디어', '헥토큐앤엠', '헥토월렛원', '드림베이',
];

const S = { step: 1, date: null, time: null, slots: null };

// ── Init ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  fetchSlots().then(() => renderDateGrid());
  document.getElementById('inp-company').innerHTML = companyOptionsHtml();
});

function companyOptionsHtml(selected) {
  const placeholder = `<option value="" disabled${selected ? '' : ' selected'}>선택하세요</option>`;
  return placeholder + COMPANIES.map(c =>
    `<option value="${c}"${c === selected ? ' selected' : ''}>${c}</option>`
  ).join('');
}

async function fetchSlots() {
  try {
    const res = await fetch('/api/slots');
    S.slots = await res.json();
  } catch (e) { /* 슬롯 로드 실패 시 빈 값으로 유지 */ }
}

// ── Tabs ──────────────────────────────────────────────────────────────
function showTab(tab) {
  document.getElementById('tab-reserve').style.display = tab === 'reserve' ? '' : 'none';
  document.getElementById('tab-lookup').style.display  = tab === 'lookup'  ? '' : 'none';
  document.getElementById('tab-btn-reserve').classList.toggle('active', tab === 'reserve');
  document.getElementById('tab-btn-lookup').classList.toggle('active',  tab === 'lookup');
  if (tab === 'lookup') {
    document.getElementById('lookup-err').style.display = 'none';
    document.getElementById('lookup-results').innerHTML = '';
    document.getElementById('lookup-team').value = '';
    document.getElementById('lookup-name').value = '';
  }
}

// ── Step Navigation ───────────────────────────────────────────────────
function goStep(n) {
  document.getElementById(`step-${S.step}`).style.display = 'none';
  S.step = n;
  document.getElementById(`step-${n}`).style.display = '';
  updateStepIndicator();
  if (n === 1) fetchSlots().then(() => renderDateGrid());
  if (n === 2) { fetchSlots().then(() => renderTimeGrid()); renderSummary(2); }
  if (n === 3) renderSummary(3);
}

function updateStepIndicator() {
  document.querySelectorAll('#steps-indicator .step').forEach(el => {
    const s = +el.dataset.step;
    el.classList.toggle('active', s === S.step);
    el.classList.toggle('completed', s < S.step);
  });
}

function renderSummary(step) {
  const chips = [];
  if (S.date) {
    const d = DATES.find(d => d.value === S.date);
    if (d) chips.push(`${d.month}/${d.day} (${d.dow})`);
  }
  if (S.time) chips.push(S.time);
  const el = document.getElementById(`sum-${step}`);
  if (el) el.innerHTML = chips.map(c => `<span class="sel-chip">${c}</span>`).join('');
}

// ── Step 1: Date ──────────────────────────────────────────────────────
function renderDateGrid() {
  const grid = document.getElementById('date-grid');
  grid.innerHTML = '';
  DATES.forEach(d => {
    const isBlocked = BLOCKED_DATES.some(b => b.date === d.value);
    const totalAvail = TIMES.reduce((sum, t) => {
      const base  = S.slots?.[d.value]?.[t]?.count ?? 0;
      const extra = EXTRA_COUNTS.find(e => e.date === d.value && e.time === t)?.extra ?? 0;
      return sum + Math.max(0, MAX - base - extra);
    }, 0);
    const availCls  = totalAvail === 0 ? 'full' : totalAvail <= 20 ? 'warn' : 'ok';
    const availText = totalAvail === 0 ? '마감' : `잔여 ${totalAvail}석`;

    const btn = document.createElement('button');
    btn.className = 'date-select-card' + (S.date === d.value ? ' selected' : '');
    btn.innerHTML = `
      <div class="dsc-dow">${d.month}월</div>
      <div class="dsc-date">${d.day}일 (${d.dow})</div>
      <div class="dsc-avail ${availCls}">${availText}</div>`;
    if (isBlocked || totalAvail === 0) btn.disabled = true;
    else btn.onclick = () => { S.date = d.value; goStep(2); };
    grid.appendChild(btn);
  });
}

// ── Step 2: Time ──────────────────────────────────────────────────────
function renderTimeGrid() {
  const grid = document.getElementById('time-grid');
  grid.innerHTML = '';
  TIMES.forEach(time => {
    const isBlockedDate = BLOCKED_DATES.some(b => b.date === S.date);
    const blockedDateReason = BLOCKED_DATES.find(b => b.date === S.date)?.reason;
    const isBlocked = isBlockedDate || BLOCKED_SLOTS.some(b => b.date === S.date && b.time === time);
    const base  = S.slots?.[S.date]?.[time]?.count ?? 0;
    const extra = EXTRA_COUNTS.find(e => e.date === S.date && e.time === time)?.extra ?? 0;
    const count = base + extra;
    const avail = MAX - count;
    const isFull = isBlocked || avail <= 0;
    const isWarn = !isBlocked && avail <= 2;
    const cls   = isFull ? 'avail-full' : isWarn ? 'avail-warn' : 'avail-ok';
    const label = isBlockedDate ? blockedDateReason : isBlocked ? '운영없음' : isFull ? '마감' : `잔여 ${avail}석`;

    const dots = Array.from({ length: MAX }, (_, i) =>
      `<div class="seat-dot ${i < count ? 'filled' : 'empty'}"></div>`
    ).join('');

    const btn = document.createElement('button');
    btn.className = `time-btn ${cls}${S.time === time ? ' selected' : ''}`;
    btn.disabled = isFull;
    btn.innerHTML = `
      <div class="tv">${time}</div>
      <div class="seat-dots">${dots}</div>
      <div class="ta">${label}</div>`;
    if (!isFull) btn.onclick = () => { S.time = time; goStep(3); };
    grid.appendChild(btn);
  });
}

// ── Step 3: Submit ────────────────────────────────────────────────────
async function submitApplication() {
  const company = document.getElementById('inp-company').value;
  const team    = document.getElementById('inp-team').value.trim();
  const name    = document.getElementById('inp-name').value.trim();
  const errEl   = document.getElementById('form-err');
  errEl.style.display = 'none';

  if (!company || !team || !name) {
    errEl.textContent = '모든 항목을 입력해주세요.';
    errEl.style.display = '';
    return;
  }

  try {
    const res = await fetch('/api/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: S.date, time: S.time, company, team, name }),
    });
    const data = await res.json();

    if (!res.ok) {
      errEl.textContent = data.error || '신청에 실패했습니다.';
      errEl.style.display = '';
      if (res.status === 409) { await fetchSlots(); renderTimeGrid(); }
      return;
    }

    await fetchSlots();
    showConfirm(data.code, { company, team, name });
  } catch {
    errEl.textContent = '서버 오류가 발생했습니다. 다시 시도해 주세요.';
    errEl.style.display = '';
  }
}

function showConfirm(code, info) {
  const d = DATES.find(d => d.value === S.date);
  document.getElementById('done-detail').innerHTML = `
    <div style="text-align:center;padding:16px 0 4px">
      <div class="dl" style="display:block;margin-bottom:4px">신청 코드</div>
      <div class="code-display">${code}</div>
    </div>` + detailRows([
    ['날짜', d ? `${d.month}/${d.day} (${d.dow})` : S.date],
    ['시간', S.time],
    ['소속 회사', info.company],
    ['소속 부서(팀)', info.team],
    ['이름', info.name],
  ]);
  goStep(4);
}

function resetApplication() {
  S.step = 1; S.date = null; S.time = null;
  document.getElementById('inp-company').value = '';
  ['inp-team', 'inp-name'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('form-err').style.display = 'none';
  for (let i = 2; i <= 4; i++) document.getElementById(`step-${i}`).style.display = 'none';
  document.getElementById('step-1').style.display = '';
  updateStepIndicator();
  fetchSlots().then(() => renderDateGrid());
}

// ── Lookup ────────────────────────────────────────────────────────────
async function lookupApplication() {
  const team  = document.getElementById('lookup-team').value.trim();
  const name  = document.getElementById('lookup-name').value.trim();
  const errEl = document.getElementById('lookup-err');
  errEl.style.display = 'none';
  document.getElementById('lookup-results').innerHTML = '';

  if (!team || !name) {
    errEl.textContent = '팀과 이름을 모두 입력해주세요.';
    errEl.style.display = '';
    return;
  }

  try {
    const res  = await fetch(`/api/search?team=${encodeURIComponent(team)}&name=${encodeURIComponent(name)}`);
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || '조회 중 오류가 발생했습니다.';
      errEl.style.display = '';
      return;
    }
    if (data.length === 0) {
      errEl.textContent = `'${team}' 팀 '${name}'님의 신청 내역이 없습니다.`;
      errEl.style.display = '';
      return;
    }
    renderLookupResults(data);
  } catch {
    errEl.textContent = '서버 오류가 발생했습니다.';
    errEl.style.display = '';
  }
}

function renderLookupResults(list) {
  const container = document.getElementById('lookup-results');
  container.innerHTML = '';

  if (list.length > 1) {
    const notice = document.createElement('p');
    notice.style.cssText = 'font-size:13px;color:var(--text-muted);font-weight:600;margin-bottom:12px';
    notice.textContent = `${list.length}건의 신청이 조회되었습니다.`;
    container.appendChild(notice);
  }

  list.forEach(r => {
    const d    = DATES.find(d => d.value === r.date);
    const wrap = document.createElement('div');
    wrap.id = `result-wrap-${r.code}`;

    // 결과 카드
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-title">신청 정보</div>
      <div class="detail-table">${detailRows([
        ['날짜', d ? `${d.month}/${d.day} (${d.dow})` : r.date],
        ['시간', r.time],
        ['소속 회사', r.company],
        ['소속 부서(팀)', r.team],
        ['이름', r.name],
      ])}</div>
      <div class="nav-btns" style="margin-top:16px">
        <button class="btn btn-secondary" onclick="openEditForm('${r.code}')">수정</button>
        <button class="btn btn-danger"    onclick="confirmCancel('${r.code}')">취소</button>
      </div>
      <div id="msg-${r.code}" class="msg" style="display:none;margin-top:10px"></div>
    `;
    wrap.appendChild(card);

    // 수정 폼 (카드 아래 숨김)
    const editCard = document.createElement('div');
    editCard.className = 'card';
    editCard.id = `edit-${r.code}`;
    editCard.style.display = 'none';
    editCard.innerHTML = `
      <div class="card-title">신청 수정</div>
      <div id="edit-err-${r.code}" class="msg msg-error" style="display:none"></div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">날짜</label>
          <select class="form-input" id="ed-${r.code}"></select>
        </div>
        <div class="form-group">
          <label class="form-label">시간</label>
          <select class="form-input" id="et-${r.code}"></select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">소속 회사</label>
          <select class="form-input" id="ec-${r.code}">${companyOptionsHtml(r.company)}</select>
        </div>
        <div class="form-group">
          <label class="form-label">소속 부서(팀)</label>
          <input type="text" class="form-input" id="eteam-${r.code}" value="${r.team}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">이름</label>
        <input type="text" class="form-input" id="en-${r.code}" value="${r.name}">
      </div>
      <div class="nav-btns">
        <button class="btn btn-secondary" onclick="closeEditForm('${r.code}')">취소</button>
        <button class="btn btn-primary" style="flex:1;width:auto" onclick="submitEdit('${r.code}')">저장</button>
      </div>
    `;
    wrap.appendChild(editCard);
    container.appendChild(wrap);
  });
}

// ── Cancel ────────────────────────────────────────────────────────────
async function confirmCancel(code) {
  if (!confirm('신청을 취소하시겠습니까?')) return;
  const msgEl = document.getElementById(`msg-${code}`);
  try {
    const res  = await fetch(`/api/applications/${code}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
      msgEl.className = 'msg msg-error';
      msgEl.textContent = data.error || '취소에 실패했습니다.';
    } else {
      const wrap = document.getElementById(`result-wrap-${code}`);
      wrap.innerHTML = `
        <div class="card">
          <div class="msg msg-success" style="margin:0">신청이 취소되었습니다.</div>
        </div>`;
      await fetchSlots();
      return;
    }
    msgEl.style.display = '';
  } catch {
    msgEl.className = 'msg msg-error';
    msgEl.textContent = '서버 오류가 발생했습니다.';
    msgEl.style.display = '';
  }
}

// ── Edit ──────────────────────────────────────────────────────────────
async function openEditForm(code) {
  document.getElementById(`edit-err-${code}`).style.display = 'none';
  await fetchSlots();
  const r = await (await fetch(`/api/applications/${code}`)).json();
  const origDate = r.date, origTime = r.time;

  document.getElementById(`ec-${code}`).value = r.company;
  document.getElementById(`eteam-${code}`).value = r.team;
  document.getElementById(`en-${code}`).value = r.name;

  updateEditDateSelect(code, origDate);
  updateEditTimeSelect(code, origDate, origDate, origTime);

  document.getElementById(`ed-${code}`).onchange = () => {
    const date = document.getElementById(`ed-${code}`).value;
    updateEditTimeSelect(code, date, origDate, origTime);
  };

  document.getElementById(`edit-${code}`).style.display = '';
  document.getElementById(`edit-${code}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updateEditDateSelect(code, selectedDate) {
  const sel = document.getElementById(`ed-${code}`);
  sel.innerHTML = DATES.map(d => {
    const totalAvail = TIMES.reduce((sum, t) => {
      const count = S.slots?.[d.value]?.[t]?.count ?? 0;
      return sum + Math.max(0, MAX - count);
    }, 0);
    const label = totalAvail === 0 ? '마감' : `잔여 ${totalAvail}석`;
    return `<option value="${d.value}"${d.value === selectedDate ? ' selected' : ''}>${d.month}/${d.day} (${d.dow})  ·  ${label}</option>`;
  }).join('');
}

function updateEditTimeSelect(code, date, origDate, origTime) {
  const sel = document.getElementById(`et-${code}`);
  sel.innerHTML = TIMES.map(t => {
    const count = S.slots?.[date]?.[t]?.count ?? 0;
    const avail = MAX - count;
    const full  = avail <= 0;
    const isCurrent = date === origDate && t === origTime;
    let label;
    if (isCurrent)       label = `${t}  ·  현재 신청`;
    else if (full)       label = `${t}  ·  마감`;
    else                 label = `${t}  ·  잔여 ${avail}석`;
    return `<option value="${t}"${t === origTime ? ' selected' : ''}${full && !isCurrent ? ' disabled' : ''}>${label}</option>`;
  }).join('');
}

function closeEditForm(code) {
  document.getElementById(`edit-${code}`).style.display = 'none';
}

async function submitEdit(code) {
  const errEl = document.getElementById(`edit-err-${code}`);
  errEl.style.display = 'none';

  const body = {
    date:    document.getElementById(`ed-${code}`).value,
    time:    document.getElementById(`et-${code}`).value,
    company: document.getElementById(`ec-${code}`).value,
    team:    document.getElementById(`eteam-${code}`).value.trim(),
    name:    document.getElementById(`en-${code}`).value.trim(),
  };

  if (!body.company || !body.team || !body.name) {
    errEl.textContent = '모든 항목을 입력해주세요.';
    errEl.style.display = '';
    return;
  }

  try {
    const res  = await fetch(`/api/applications/${code}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || '수정에 실패했습니다.';
      errEl.style.display = '';
      return;
    }
    await fetchSlots();
    const updated = await (await fetch(`/api/applications/${code}`)).json();
    renderLookupResults([updated]);
    document.getElementById('lookup-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    errEl.textContent = '서버 오류가 발생했습니다.';
    errEl.style.display = '';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────
function detailRows(pairs) {
  return pairs.map(([l, v]) =>
    `<div class="detail-row"><span class="dl">${l}</span><span class="dv">${v}</span></div>`
  ).join('');
}
