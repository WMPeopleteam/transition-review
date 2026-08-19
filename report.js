(function () {
  const appEl = document.getElementById('app');
  const params = new URLSearchParams(window.location.search);
  const internName = params.get('intern');
  const code = sessionStorage.getItem('tr_admin_code');

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  if (!code) {
    window.location.href = 'admin.html';
    return;
  }
  if (!internName) {
    appEl.innerHTML = `<div class="wrap"><div class="empty-state">인턴명이 지정되지 않았습니다.</div></div>`;
    return;
  }

  function apiGet(action, p) {
    const url = new URL(CONFIG.API_URL);
    url.searchParams.set('action', action);
    Object.keys(p || {}).forEach(k => url.searchParams.set(k, p[k]));
    return fetch(url.toString()).then(r => r.json());
  }

  const ROLE_ORDER = ['현장소장', '공사책임자', '멘토', '동료'];

  apiGet('report', { code, intern: internName }).then(res => {
    if (!res.ok) {
      if (String(res.error || '').indexOf('코드') !== -1) { window.location.href = 'admin.html'; return; }
      appEl.innerHTML = `<div class="wrap"><div class="empty-state">${escapeHtml(res.error || '불러오기 실패')}</div></div>`;
      return;
    }
    renderReport(res);
  }).catch(() => {
    appEl.innerHTML = `<div class="wrap"><div class="empty-state">서버에 연결할 수 없습니다.</div></div>`;
  });

  function byRole(records, role) {
    return records.find(r => r['역할'] === role) || null;
  }

  function scoreTable(records) {
    let rows = RUBRIC_AREAS.map(area => {
      const scoreField = AREA_FIELD_MAP.find(m => m[0] === area.key)[1];
      const cells = ROLE_ORDER.map(role => {
        const rec = byRole(records, role);
        const val = rec ? rec[scoreField] : '';
        return `<td>${val ? val + '점' : '-'}</td>`;
      });
      const scored = ROLE_ORDER.map(role => byRole(records, role)).filter(Boolean)
        .map(rec => Number(rec[scoreField])).filter(n => !isNaN(n) && n > 0);
      const avg = scored.length ? (scored.reduce((a, b) => a + b, 0) / scored.length) : null;
      return `<tr>
        <td class="text-cell"><strong>${area.no} ${escapeHtml(area.title)}</strong><br><span style="color:#6b7484;">배점 ${area.maxPoints}점</span></td>
        ${cells.join('')}
        <td><strong>${avg !== null ? avg.toFixed(1) : '-'}</strong></td>
      </tr>`;
    }).join('');
    return `
    <table class="report-table">
      <thead><tr><th style="text-align:left;">평가영역</th>${ROLE_ORDER.map(r => `<th>${r}</th>`).join('')}<th>평균(4점척도)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  function notesBlock(records) {
    return RUBRIC_AREAS.map(area => {
      const noteField = AREA_FIELD_MAP.find(m => m[0] === area.key)[2];
      const items = ROLE_ORDER.map(role => {
        const rec = byRole(records, role);
        const note = rec ? rec[noteField] : '';
        if (!note) return '';
        return `<div style="margin-bottom:4px;"><strong>${role}</strong>: ${escapeHtml(note)}</div>`;
      }).filter(Boolean).join('');
      if (!items) return '';
      return `<div style="margin-bottom:8px;"><div style="font-weight:700;font-size:12.5px;">${area.no} ${escapeHtml(area.title)} 근거</div>${items}</div>`;
    }).join('');
  }

  function riskBlock(records) {
    const rows = [];
    RISK_ITEMS.forEach((item, idx) => {
      ROLE_ORDER.forEach(role => {
        const rec = byRole(records, role);
        if (!rec) return;
        const risk = rec['위험요인_JSON'] || {};
        const entry = risk[idx];
        if (entry && entry.level && entry.level !== '해당없음') {
          rows.push(`<tr><td>${escapeHtml(item)}</td><td>${role}</td><td>${entry.level}</td><td class="text-cell">${escapeHtml(entry.detail || '')}</td></tr>`);
        }
      });
    });
    if (!rows.length) return `<p style="font-size:13px;color:#1e8a5f;">체크된 위험요인이 없습니다.</p>`;
    return `
    <table class="report-table">
      <thead><tr><th>위험요인</th><th>평가자</th><th>단계</th><th style="text-align:left;">구체적 사실</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;
  }

  function opinionsBlock(records) {
    return ROLE_ORDER.map(role => {
      const rec = byRole(records, role);
      if (!rec) return `<div class="report-grid" style="margin-bottom:10px;"><div><span class="k">${role}</span> 미제출</div></div>`;
      return `
      <div style="margin-bottom:12px;">
        <div style="font-weight:700;font-size:13px;">${role} (${escapeHtml(rec['평가자명'])})</div>
        <div style="font-size:12.5px;color:#40495a;margin:4px 0;">${escapeHtml(rec['종합의견'] || '')}</div>
        <div class="badge role">추천의견: ${escapeHtml(rec['평가자추천의견'] || '-')}</div>
      </div>`;
    }).join('');
  }

  function renderReport(data) {
    const records = data.records;
    document.getElementById('printBtn').onclick = () => window.print();

    appEl.innerHTML = `
    <div class="report-page">
      <h1>채용연계형 인턴 역량평가 리포트</h1>
      <div class="sub">정규직 전환 심의용 · 4개 평가주체(현장소장/공사책임자/멘토/동료) 종합</div>
      <div class="report-grid">
        <div><span class="k">성명</span><strong>${escapeHtml(data.intern)}</strong></div>
        <div><span class="k">배치현장</span>${escapeHtml(data.site || '')}</div>
        <div><span class="k">제출 현황</span>${records.length} / 4명</div>
      </div>

      <div class="section-title" style="margin-top:8px;">역량평가 (100점 만점)</div>
      ${scoreTable(records)}

      <div class="section-title">영역별 근거 / 구체적 사례</div>
      <div style="font-size:12.5px;">${notesBlock(records) || '<p style="color:#6b7484;">기재된 근거가 없습니다.</p>'}</div>

      <div class="section-title" style="margin-top:10px;">위험요인 체크리스트</div>
      ${riskBlock(records)}

      <div class="section-title" style="margin-top:10px;">평가자별 종합의견 및 추천</div>
      ${opinionsBlock(records)}

      <div class="section-title" style="margin-top:10px;">전환기준 매트릭스 (참고)</div>
      <table class="report-table">
        <thead><tr><th>구분</th><th style="text-align:left;">기준</th></tr></thead>
        <tbody>
        ${TRANSITION_MATRIX.map(m => `<tr><td><strong>${m.label}</strong></td><td class="text-cell">${escapeHtml(m.desc)}</td></tr>`).join('')}
        </tbody>
      </table>
      <p style="font-size:11.5px;color:#6b7484;">허위보고, 무단결근, 부적절한 언행, 피드백 후 동일 문제 반복 등은 총점과 관계없이 미전환을 검토할 수 있습니다. 최종 판정은 4개 평가주체 의견을 종합하여 인사부서 협의로 확정합니다.</p>
    </div>`;
  }
})();
