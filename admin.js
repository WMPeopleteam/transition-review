(function () {
  const appEl = document.getElementById('app');
  const topbar = document.getElementById('topbar');
  const whoBox = document.getElementById('whoBox');

  let state = {
    code: sessionStorage.getItem('tr_admin_code') || '',
    view: sessionStorage.getItem('tr_admin_code') ? 'dashboard' : 'login',
    interns: []
  };

  function apiGet(action, params) {
    const url = new URL(CONFIG.API_URL);
    url.searchParams.set('action', action);
    Object.keys(params || {}).forEach(k => url.searchParams.set(k, params[k]));
    return fetch(url.toString()).then(r => r.json());
  }

  function configured() {
    return CONFIG.API_URL && CONFIG.API_URL.indexOf('PASTE_YOUR') === -1;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function updateTopbar() {
    if (state.view === 'login') { topbar.style.display = 'none'; return; }
    topbar.style.display = 'flex';
    whoBox.innerHTML = `<button id="logoutBtn">로그아웃</button>
      <a href="index.html" style="margin-left:10px;color:#cfd8ea;font-size:12px;">← 평가자 화면</a>`;
    document.getElementById('logoutBtn').onclick = logout;
  }

  function logout() {
    sessionStorage.removeItem('tr_admin_code');
    state = { code: '', view: 'login', interns: [] };
    render();
  }

  function renderLogin() {
    appEl.innerHTML = `
    <div class="center-wrap">
      <div class="login-card">
        <div class="mark">관리</div>
        <h1>관리자 접속</h1>
        <p class="sub">인사담당자에게 전달받은 접속 코드를 입력하세요.</p>
        ${!configured() ? `<p class="error-msg" style="margin-bottom:14px;">⚠ 서버(Apps Script) 연결이 설정되지 않았습니다. config.js를 확인해주세요.</p>` : ''}
        <div class="field-row" style="text-align:left;">
          <input type="password" id="codeInput" placeholder="접속 코드" />
        </div>
        <button class="btn" id="loginBtn">입장</button>
        <div class="error-msg" id="loginError"></div>
      </div>
    </div>`;
    document.getElementById('loginBtn').onclick = doLogin;
    document.getElementById('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  }

  function doLogin() {
    const code = document.getElementById('codeInput').value.trim();
    const errEl = document.getElementById('loginError');
    if (!code) { errEl.textContent = '접속 코드를 입력해주세요.'; return; }
    apiGet('adminLogin', { code }).then(res => {
      if (!res.ok) { errEl.textContent = res.error || '접속 코드가 올바르지 않습니다.'; return; }
      state.code = code;
      sessionStorage.setItem('tr_admin_code', code);
      state.view = 'dashboard';
      loadDashboard();
    }).catch(() => { errEl.textContent = '서버에 연결할 수 없습니다.'; });
  }

  function loadDashboard() {
    appEl.innerHTML = `<div class="wrap"><div class="empty-state">불러오는 중...</div></div>`;
    updateTopbar();
    apiGet('adminData', { code: state.code }).then(res => {
      if (!res.ok) { logout(); return; }
      state.interns = res.interns;
      renderDashboard();
    });
  }

  function renderDashboard() {
    const total = state.interns.length;
    const fullyDone = state.interns.filter(i => i.doneCount === i.total).length;
    const totalSlots = state.interns.reduce((s, i) => s + i.total, 0);
    const doneSlots = state.interns.reduce((s, i) => s + i.doneCount, 0);

    appEl.innerHTML = `
    <div class="wrap">
      <div class="toolbar">
        <div class="hello">평가 진행 현황</div>
        <div class="actions">
          <button class="btn secondary small" id="refreshBtn">새로고침</button>
          <button class="btn secondary small" id="exportBtn">엑셀 다운로드</button>
        </div>
      </div>
      <div class="stat-row">
        <div class="stat-box"><div class="num">${total}</div><div class="lbl">전체 인턴</div></div>
        <div class="stat-box"><div class="num">${fullyDone}</div><div class="lbl">4명 평가 모두 완료</div></div>
        <div class="stat-box"><div class="num">${doneSlots} / ${totalSlots}</div><div class="lbl">전체 제출 건수</div></div>
      </div>
      <table class="admin-table">
        <thead><tr><th>인턴</th><th>배치현장</th><th>진행률</th><th>평가자별 제출 현황</th><th></th></tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>`;

    document.getElementById('refreshBtn').onclick = loadDashboard;
    document.getElementById('exportBtn').onclick = exportExcel;

    const tbody = document.getElementById('tbody');
    tbody.innerHTML = state.interns.map(intern => {
      const pct = intern.doneCount === intern.total ? 'full' : (intern.doneCount === 0 ? 'zero' : 'partial');
      return `
      <tr>
        <td><strong>${escapeHtml(intern.intern)}</strong></td>
        <td>${escapeHtml(intern.site || '')}</td>
        <td><span class="progress-pill ${pct}">${intern.doneCount} / ${intern.total}</span></td>
        <td>${intern.roles.map(r => `<span class="role-chip ${r.submitted ? 'on' : ''}">${escapeHtml(r.role)}${r.submitted ? ' ✓' : ''}</span>`).join('')}</td>
        <td><button class="btn secondary small" data-intern="${escapeHtml(intern.intern)}">리포트 보기</button></td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('button[data-intern]').forEach(btn => {
      btn.onclick = () => {
        window.location.href = `report.html?intern=${encodeURIComponent(btn.dataset.intern)}`;
      };
    });
  }

  function exportExcel() {
    apiGet('adminAllRecords', { code: state.code }).then(res => {
      if (!res.ok) { alert(res.error || '내보내기에 실패했습니다.'); return; }
      const records = res.records;
      if (!records.length) { alert('아직 제출된 평가가 없습니다.'); return; }
      const rows = records.map(r => {
        const row = Object.assign({}, r);
        if (typeof row['위험요인_JSON'] === 'string') {
          try {
            const risk = JSON.parse(row['위험요인_JSON']);
            const flagged = Object.keys(risk).filter(i => risk[i].level && risk[i].level !== '해당없음');
            row['위험요인_요약'] = flagged.map(i => `${RISK_ITEMS[i]}(${risk[i].level})`).join('; ');
          } catch (e) { row['위험요인_요약'] = ''; }
        }
        return row;
      });
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '평가결과');
      const ts = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `인턴평가결과_${ts}.xlsx`);
    });
  }

  function render() {
    updateTopbar();
    if (state.view === 'login') renderLogin();
    else loadDashboard();
  }

  render();
})();
