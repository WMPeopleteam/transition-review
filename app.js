(function () {
  const appEl = document.getElementById('app');
  const topbar = document.getElementById('topbar');
  const whoBox = document.getElementById('whoBox');

  let state = {
    sabun: sessionStorage.getItem('tr_sabun') || '',
    evaluatorName: sessionStorage.getItem('tr_name') || '',
    assignments: [],
    view: 'login' // login | dashboard | form
  };

  function apiGet(action, params) {
    const url = new URL(CONFIG.API_URL);
    url.searchParams.set('action', action);
    Object.keys(params || {}).forEach(k => url.searchParams.set(k, params[k]));
    return fetch(url.toString()).then(r => r.json());
  }

  function apiPost(payload) {
    return fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight to Apps Script
      body: JSON.stringify(payload)
    }).then(r => r.json());
  }

  function configured() {
    return CONFIG.API_URL && CONFIG.API_URL.indexOf('PASTE_YOUR') === -1;
  }

  function updateTopbar() {
    if (state.view === 'login') {
      topbar.style.display = 'none';
    } else {
      topbar.style.display = 'flex';
      whoBox.innerHTML = `<strong>${escapeHtml(state.evaluatorName)}</strong>님 (사번 ${escapeHtml(state.sabun)})
        <button id="logoutBtn">로그아웃</button>
        <a href="admin.html" style="margin-left:10px;color:#cfd8ea;font-size:12px;">관리자 화면 →</a>`;
      document.getElementById('logoutBtn').onclick = logout;
    }
  }

  function logout() {
    sessionStorage.removeItem('tr_sabun');
    sessionStorage.removeItem('tr_name');
    state = { sabun: '', evaluatorName: '', assignments: [], view: 'login' };
    render();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ---------- LOGIN ----------
  function renderLogin() {
    appEl.innerHTML = `
    <div class="center-wrap">
      <div class="login-card">
        <div class="mark">평가</div>
        <h1>채용연계형 인턴 평가</h1>
        <p class="sub">사번을 입력하면 본인이 평가할 인턴 목록이 표시됩니다.</p>
        ${!configured() ? `<p class="error-msg" style="margin-bottom:14px;">⚠ 관리자가 아직 서버(Apps Script) 연결을 완료하지 않았습니다. config.js를 확인해주세요.</p>` : ''}
        <div class="field-row" style="text-align:left;">
          <input type="text" id="sabunInput" placeholder="사번 입력 (예: 20031139)" inputmode="numeric" />
        </div>
        <button class="btn" id="loginBtn">조회</button>
        <div class="error-msg" id="loginError"></div>
      </div>
    </div>`;
    const btn = document.getElementById('loginBtn');
    const input = document.getElementById('sabunInput');
    btn.onclick = doLogin;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    input.focus();
  }

  function doLogin() {
    const val = document.getElementById('sabunInput').value.trim();
    const errEl = document.getElementById('loginError');
    errEl.textContent = '';
    if (!val) { errEl.textContent = '사번을 입력해주세요.'; return; }
    if (!configured()) { errEl.textContent = '서버 연결이 설정되지 않았습니다.'; return; }
    document.getElementById('loginBtn').disabled = true;
    document.getElementById('loginBtn').textContent = '조회 중...';
    apiGet('lookup', { sabun: val }).then(res => {
      if (!res.ok) {
        errEl.textContent = res.error || '조회에 실패했습니다.';
        document.getElementById('loginBtn').disabled = false;
        document.getElementById('loginBtn').textContent = '조회';
        return;
      }
      state.sabun = res.sabun;
      state.evaluatorName = res.evaluatorName;
      state.assignments = res.assignments;
      state.view = 'dashboard';
      sessionStorage.setItem('tr_sabun', state.sabun);
      sessionStorage.setItem('tr_name', state.evaluatorName);
      render();
    }).catch(() => {
      errEl.textContent = '서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.';
      document.getElementById('loginBtn').disabled = false;
      document.getElementById('loginBtn').textContent = '조회';
    });
  }

  // ---------- DASHBOARD ----------
  function refreshAssignments() {
    return apiGet('lookup', { sabun: state.sabun }).then(res => {
      if (res.ok) state.assignments = res.assignments;
    });
  }

  function renderDashboard() {
    const done = state.assignments.filter(a => a.submitted).length;
    const total = state.assignments.length;
    appEl.innerHTML = `
    <div class="wrap">
      <div class="hello">안녕하세요, <strong>${escapeHtml(state.evaluatorName)}</strong>님</div>
      <div class="page-desc">평가 대상 ${total}명 중 ${done}명 제출 완료. 카드를 클릭해 평가를 작성하세요.</div>
      <div class="assign-list" id="assignList"></div>
    </div>`;
    const listEl = document.getElementById('assignList');
    if (total === 0) {
      listEl.innerHTML = `<div class="card empty-state">배정된 평가 대상이 없습니다. 인사담당자에게 문의해주세요.</div>`;
      return;
    }
    listEl.innerHTML = state.assignments.map((a, i) => `
      <div class="assign-item" data-idx="${i}" style="cursor:pointer;">
        <div class="info">
          <div class="intern-name">${escapeHtml(a.intern)} <span class="badge role" style="margin-left:6px;">${escapeHtml(a.site || '')}</span></div>
          <div class="meta">평가자 역할: ${escapeHtml(a.role)}</div>
        </div>
        <div>
          ${a.submitted
            ? `<span class="badge done">제출완료</span>`
            : `<span class="badge pending">작성 대기</span>`}
        </div>
      </div>
    `).join('');
    Array.from(listEl.querySelectorAll('.assign-item')).forEach(el => {
      el.onclick = () => openForm(state.assignments[Number(el.dataset.idx)]);
    });
  }

  // ---------- FORM ----------
  let formState = null; // { intern, role, scores:{}, notes:{}, risk:{}, opinion, recommendation }

  function openForm(assignment) {
    state.view = 'form';
    formState = {
      intern: assignment.intern,
      role: assignment.role,
      scores: {}, notes: {}, risk: {}, opinion: '', recommendation: ''
    };
    render();
    // Try to load previous answer for editing
    apiGet('myRecord', { sabun: state.sabun, intern: assignment.intern }).then(res => {
      if (res.ok && res.record) {
        const r = res.record;
        AREA_FIELD_MAP.forEach(([key, sk, nk]) => {
          if (r[sk]) formState.scores[key] = Number(r[sk]);
          if (r[nk]) formState.notes[key] = r[nk];
        });
        formState.risk = r['위험요인_JSON'] || {};
        formState.opinion = r['종합의견'] || '';
        formState.recommendation = r['평가자추천의견'] || '';
        renderFormBody();
      }
    }).catch(() => {});
  }

  function renderForm() {
    appEl.innerHTML = `
    <div class="wrap">
      <button class="btn secondary small" id="backBtn" style="margin-bottom:14px;">← 목록으로</button>
      <div class="hello"><strong>${escapeHtml(formState.intern)}</strong> 평가 (${escapeHtml(formState.role)} 평가)</div>
      <div class="page-desc">각 영역에서 관찰된 사실과 가장 가까운 항목 1개를 선택하세요. 애매한 경우 낮은 단계를 우선 적용합니다. 우수(4점)·미흡(1점) 선택 시 구체적 사례 기재가 필요합니다.</div>
      <div id="formBody"></div>
    </div>`;
    document.getElementById('backBtn').onclick = () => {
      state.view = 'dashboard';
      refreshAssignments().then(render);
    };
    renderFormBody();
  }

  function renderFormBody() {
    const body = document.getElementById('formBody');
    if (!body) return;

    const areasHtml = RUBRIC_AREAS.map(area => {
      const selected = formState.scores[area.key];
      const needsNote = selected === 4 || selected === 1;
      return `
      <div class="card">
        <div class="section-title">${area.no} ${area.title} <span class="pts">배점 ${area.maxPoints}점</span></div>
        <div class="level-group" data-area="${area.key}">
          ${area.levels.map(lv => `
            <label class="level-option ${selected === lv.score ? 'selected' : ''}" data-area="${area.key}" data-score="${lv.score}">
              <input type="radio" name="${area.key}" value="${lv.score}" ${selected === lv.score ? 'checked' : ''}/>
              <div>
                <div class="lv-head">${lv.score}점 · ${lv.grade}<span class="lv-pts">(환산 ${lv.converted}점)</span></div>
                <div class="lv-text">${escapeHtml(lv.text)}</div>
              </div>
            </label>
          `).join('')}
        </div>
        <div class="note-field" ${needsNote ? '' : 'style="display:none;"'} data-note-for="${area.key}">
          <label>근거 / 구체적 사례 ${needsNote ? '(필수)' : ''}</label>
          <textarea data-note="${area.key}" placeholder="관찰된 구체적 사실을 작성해주세요.">${escapeHtml(formState.notes[area.key] || '')}</textarea>
        </div>
      </div>`;
    }).join('');

    const riskHtml = `
      <div class="card">
        <div class="section-title">위험요인 체크리스트</div>
        <div class="page-desc" style="margin-bottom:8px;">'주의' 또는 '중대'로 체크한 항목은 구체적 사실(발생시점·상황·지도내용·개선여부)을 반드시 작성합니다. 위험요인은 점수로 상쇄하지 않습니다.</div>
        <table class="risk-table">
          <thead><tr><th style="width:34%;">위험요인</th><th style="width:22%;">해당 여부</th><th>구체적 사실</th></tr></thead>
          <tbody>
          ${RISK_ITEMS.map((item, i) => {
            const cur = formState.risk[i] || { level: '해당없음', detail: '' };
            const needsDetail = cur.level !== '해당없음';
            return `
            <tr>
              <td>${escapeHtml(item)}</td>
              <td>
                <div class="risk-radio-group">
                ${RISK_LEVELS.map(lv => `
                  <label><input type="radio" name="risk_${i}" value="${lv}" ${cur.level === lv ? 'checked' : ''} data-risk-idx="${i}"/> ${lv}</label>
                `).join('')}
                </div>
              </td>
              <td>
                <input type="text" class="risk-detail" data-risk-detail="${i}" ${needsDetail ? '' : 'style="display:none;"'} value="${escapeHtml(cur.detail || '')}" placeholder="발생시점 · 상황 · 지도내용 · 개선여부" />
              </td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>`;

    const opinionHtml = `
      <div class="card">
        <div class="section-title">종합의견</div>
        <textarea id="opinionInput" placeholder="관찰된 행동과 업무수행 사실을 바탕으로 종합의견을 작성해주세요.">${escapeHtml(formState.opinion)}</textarea>
      </div>
      <div class="card">
        <div class="section-title">평가자 추천의견</div>
        <div class="reco-group" id="recoGroup">
          ${RECOMMENDATION_OPTIONS.map(opt => `
            <label class="${formState.recommendation === opt ? 'selected' : ''}" data-reco="${opt}">
              <input type="radio" name="reco" value="${opt}" ${formState.recommendation === opt ? 'checked' : ''}/>${opt}
            </label>
          `).join('')}
        </div>
      </div>`;

    body.innerHTML = areasHtml + riskHtml + opinionHtml + `
      <div class="form-actions">
        <button class="btn secondary" id="cancelBtn">취소</button>
        <button class="btn" id="submitBtn" style="width:auto;">제출하기</button>
      </div>
      <div class="error-msg" id="formError" style="text-align:right;"></div>
    `;

    // bind level selection
    body.querySelectorAll('.level-option').forEach(el => {
      el.addEventListener('click', () => {
        const area = el.dataset.area;
        const score = Number(el.dataset.score);
        formState.scores[area] = score;
        renderFormBody();
      });
    });
    // bind notes
    body.querySelectorAll('[data-note]').forEach(el => {
      el.addEventListener('input', () => { formState.notes[el.dataset.note] = el.value; });
    });
    // bind risk radios
    body.querySelectorAll('[data-risk-idx]').forEach(el => {
      el.addEventListener('change', () => {
        const idx = el.dataset.riskIdx;
        const cur = formState.risk[idx] || {};
        cur.level = el.value;
        formState.risk[idx] = cur;
        renderFormBody();
      });
    });
    body.querySelectorAll('[data-risk-detail]').forEach(el => {
      el.addEventListener('input', () => {
        const idx = el.dataset.riskDetail;
        const cur = formState.risk[idx] || { level: '해당없음' };
        cur.detail = el.value;
        formState.risk[idx] = cur;
      });
    });
    // opinion
    const opinionEl = document.getElementById('opinionInput');
    if (opinionEl) opinionEl.addEventListener('input', () => { formState.opinion = opinionEl.value; });
    // recommendation
    body.querySelectorAll('#recoGroup label').forEach(el => {
      el.addEventListener('click', () => {
        formState.recommendation = el.dataset.reco;
        renderFormBody();
      });
    });

    document.getElementById('cancelBtn').onclick = () => {
      state.view = 'dashboard';
      refreshAssignments().then(render);
    };
    document.getElementById('submitBtn').onclick = submitForm;
  }

  function validateForm() {
    for (const area of RUBRIC_AREAS) {
      const s = formState.scores[area.key];
      if (!s) return `"${area.title}" 항목을 선택해주세요.`;
      if ((s === 4 || s === 1) && !(formState.notes[area.key] || '').trim()) {
        return `"${area.title}" — 4점 또는 1점 선택 시 근거를 작성해야 합니다.`;
      }
    }
    for (let i = 0; i < RISK_ITEMS.length; i++) {
      const r = formState.risk[i];
      if (r && r.level !== '해당없음' && !(r.detail || '').trim()) {
        return `위험요인 "${RISK_ITEMS[i]}" — '${r.level}' 체크 시 구체적 사실을 작성해야 합니다.`;
      }
    }
    if (!formState.opinion.trim()) return '종합의견을 작성해주세요.';
    if (!formState.recommendation) return '평가자 추천의견을 선택해주세요.';
    return null;
  }

  function submitForm() {
    const err = validateForm();
    const errEl = document.getElementById('formError');
    if (err) { errEl.textContent = err; return; }
    errEl.textContent = '';
    const btn = document.getElementById('submitBtn');
    btn.disabled = true;
    btn.textContent = '제출 중...';
    apiPost({
      action: 'submit',
      sabun: state.sabun,
      evaluatorName: state.evaluatorName,
      role: formState.role,
      intern: formState.intern,
      scores: formState.scores,
      notes: formState.notes,
      risk: formState.risk,
      opinion: formState.opinion,
      recommendation: formState.recommendation
    }).then(res => {
      if (!res.ok) {
        errEl.textContent = res.error || '제출 중 오류가 발생했습니다.';
        btn.disabled = false;
        btn.textContent = '제출하기';
        return;
      }
      state.view = 'dashboard';
      refreshAssignments().then(render);
    }).catch(() => {
      errEl.textContent = '서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.';
      btn.disabled = false;
      btn.textContent = '제출하기';
    });
  }

  // ---------- ROUTER ----------
  function render() {
    updateTopbar();
    if (state.view === 'login') renderLogin();
    else if (state.view === 'dashboard') renderDashboard();
    else if (state.view === 'form') renderForm();
  }

  // Restore session if sabun already known
  if (state.sabun && configured()) {
    state.view = 'dashboard';
    apiGet('lookup', { sabun: state.sabun }).then(res => {
      if (res.ok) {
        state.evaluatorName = res.evaluatorName;
        state.assignments = res.assignments;
        render();
      } else {
        logout();
      }
    }).catch(() => render());
  }

  render();
})();
