/**
 * transition-review 백엔드 (Google Apps Script)
 *
 * 이 스크립트는 Google Sheets를 데이터 저장소로 사용합니다.
 * 필요한 시트 (이름 정확히 일치해야 함):
 *   - "평가대상"  : 성명 | 통합조직명 | 현장소장 | 공사책임자 | 멘토 | 동료   (제공된 xlsx 그대로)
 *   - "연락처"    : 소속법인 | 개인고유사번 | 사용자 ID | 성명 | 메일주소 | ... (제공된 xlsx 그대로)
 *   - "평가결과"  : 없으면 스크립트가 첫 제출 시 자동 생성합니다.
 *
 * 설치 방법은 README.md 참고.
 */

const SHEET_TARGET = '평가대상';
const SHEET_CONTACT = '연락처';
const SHEET_RESULT = '평가결과';
const ROLE_COLUMNS = ['현장소장', '공사책임자', '멘토', '동료'];

// 제출/수정 마감 시각 (한국시간). 이 시각 이후에는 submit_ 에서 거부합니다.
const SUBMIT_DEADLINE = new Date('2026-08-26T12:00:00+09:00');

// 배포 전 반드시 변경하세요. (Apps Script 편집기 상단 '프로젝트 설정 > 스크립트 속성'에
// ADMIN_CODE 를 넣어두면 코드에 그대로 두지 않아도 됩니다. 둘 다 없으면 아래 기본값 사용.)
function getAdminCode_() {
  const prop = PropertiesService.getScriptProperties().getProperty('ADMIN_CODE');
  return prop || 'CHANGE-ME-1234';
}

function doGet(e) {
  try {
    const action = e.parameter.action;
    if (action === 'lookup') return json_(lookup_(e.parameter.sabun));
    if (action === 'adminLogin') return json_(adminLogin_(e.parameter.code));
    if (action === 'adminData') return json_(adminData_(e.parameter.code));
    if (action === 'report') return json_(reportData_(e.parameter.code, e.parameter.intern));
    if (action === 'adminAllRecords') return json_(adminAllRecords_(e.parameter.code));
    if (action === 'myRecord') return json_(myRecord_(e.parameter.sabun, e.parameter.intern));
    if (action === 'adminIssueOtp') return json_(adminIssueOtp_(e.parameter.code, e.parameter.sabun));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'submit') return json_(submit_(body));
    if (body.action === 'requestOtp') return json_(requestOtp_(body.sabun));
    if (body.action === 'verifyOtp') return json_(verifyOtp_(body.sabun, body.code));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 사번으로 평가자 이름과 배정된 인턴 목록을 조회 */
function lookup_(sabun) {
  if (!sabun) return { ok: false, error: '사번을 입력해주세요.' };
  sabun = String(sabun).trim();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const contactRows = ss.getSheetByName(SHEET_CONTACT).getDataRange().getValues();
  const header = contactRows[0];
  const idxSabun = header.indexOf('개인고유사번');
  const idxName = header.indexOf('성명');

  let evaluatorName = null;
  for (let i = 1; i < contactRows.length; i++) {
    if (String(contactRows[i][idxSabun]).trim() === sabun) {
      evaluatorName = contactRows[i][idxName];
      break;
    }
  }
  if (!evaluatorName) {
    return { ok: false, error: '등록되지 않은 사번입니다. 인사담당자에게 문의해주세요.' };
  }

  const targetRows = ss.getSheetByName(SHEET_TARGET).getDataRange().getValues();
  const tHeader = targetRows[0];
  const idxIntern = tHeader.indexOf('성명');
  const idxSite = tHeader.indexOf('통합조직명');
  const roleIdx = {};
  ROLE_COLUMNS.forEach(r => roleIdx[r] = tHeader.indexOf(r));

  const assignments = [];
  for (let i = 1; i < targetRows.length; i++) {
    const row = targetRows[i];
    ROLE_COLUMNS.forEach(role => {
      if (String(row[roleIdx[role]]).trim() === String(evaluatorName).trim()) {
        assignments.push({
          intern: row[idxIntern],
          site: row[idxSite],
          role: role
        });
      }
    });
  }

  // 이미 제출한 평가가 있으면 상태 표시
  const existing = getResultMap_();
  assignments.forEach(a => {
    const key = sabun + '||' + a.intern;
    a.submitted = existing.has(key);
    a.submittedAt = existing.has(key) ? existing.get(key).timestamp : null;
  });

  return { ok: true, evaluatorName: evaluatorName, sabun: sabun, assignments: assignments };
}

/** 사번으로 연락처 시트에서 이름+메일을 조회 */
function findContact_(sabun) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rows = ss.getSheetByName(SHEET_CONTACT).getDataRange().getValues();
  const header = rows[0];
  const idxSabun = header.indexOf('개인고유사번');
  const idxName = header.indexOf('성명');
  const idxMail = header.indexOf('메일주소');
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][idxSabun]).trim() === String(sabun).trim()) {
      return { name: rows[i][idxName], email: rows[i][idxMail] };
    }
  }
  return null;
}

function maskEmail_(email) {
  if (!email || email.indexOf('@') === -1) return email || '';
  const [user, domain] = email.split('@');
  const masked = user.length <= 2 ? user[0] + '*' : user.slice(0, 2) + '*'.repeat(Math.max(user.length - 2, 1));
  return masked + '@' + domain;
}

/** 사번 → 인증번호 발급 및 메일 발송 (5분 유효) */
function requestOtp_(sabun) {
  if (!sabun) return { ok: false, error: '사번을 입력해주세요.' };
  sabun = String(sabun).trim();
  const contact = findContact_(sabun);
  if (!contact) return { ok: false, error: '등록되지 않은 사번입니다. 인사담당자에게 문의해주세요.' };
  if (!contact.email) return { ok: false, error: '등록된 메일주소가 없습니다. 인사담당자에게 문의해주세요.' };

  const code = String(Math.floor(1000 + Math.random() * 9000));
  CacheService.getScriptCache().put('otp_' + sabun, code, 300); // 5분

  MailApp.sendEmail({
    to: contact.email,
    subject: '[채용연계형 인턴 리뷰] 로그인 인증번호',
    body: `${contact.name}님, 안녕하세요.\n\n인증번호는 [${code}] 입니다. 5분간 유효합니다.\n\n본인이 요청하지 않았다면 이 메일을 무시해주세요.`
  });

  return { ok: true, maskedEmail: maskEmail_(contact.email) };
}

/** 인증번호 확인 후 로그인 처리 (성공 시 lookup_와 동일한 결과 반환) */
function verifyOtp_(sabun, code) {
  if (!sabun || !code) return { ok: false, error: '사번과 인증번호를 입력해주세요.' };
  sabun = String(sabun).trim();
  const cache = CacheService.getScriptCache();
  const stored = cache.get('otp_' + sabun);
  if (!stored) return { ok: false, error: '인증번호가 만료되었습니다. 다시 요청해주세요.' };
  if (String(code).trim() !== stored) return { ok: false, error: '인증번호가 일치하지 않습니다.' };
  cache.remove('otp_' + sabun); // 1회용
  return lookup_(sabun);
}

/** 관리자 전용: 이메일 발송 없이 특정 사번에 대한 인증번호를 즉시 발급 (테스트/지원용) */
function adminIssueOtp_(code, sabun) {
  const auth = adminLogin_(code);
  if (!auth.ok) return auth;
  if (!sabun) return { ok: false, error: '사번이 필요합니다.' };
  sabun = String(sabun).trim();
  const contact = findContact_(sabun);
  if (!contact) return { ok: false, error: '등록되지 않은 사번입니다.' };
  const otp = String(Math.floor(1000 + Math.random() * 9000));
  CacheService.getScriptCache().put('otp_' + sabun, otp, 300); // 5분
  return { ok: true, otp: otp, name: contact.name };
}

function getResultMap_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_RESULT);
  const map = new Map();
  if (!sheet) return map;
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return map;
  const header = rows[0];
  const idxSabun = header.indexOf('사번');
  const idxIntern = header.indexOf('피평가자');
  const idxTs = header.indexOf('제출시각');
  for (let i = 1; i < rows.length; i++) {
    const key = String(rows[i][idxSabun]).trim() + '||' + rows[i][idxIntern];
    map.set(key, { rowIndex: i + 1, timestamp: rows[i][idxTs] });
  }
  return map;
}

const RESULT_HEADER = [
  '제출시각', '사번', '평가자명', '역할', '피평가자',
  '①기본근무태도_점수', '①근거',
  '②학습태도피드백_점수', '②근거',
  '③현장적응협업_점수', '③근거',
  '④업무수행기초역량_점수', '④근거',
  '⑤성장가능성직무적합성_점수', '⑤근거',
  '위험요인_JSON', '종합의견', '평가자추천의견'
];

function ensureResultSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_RESULT);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_RESULT);
    sheet.appendRow(RESULT_HEADER);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** 평가 제출 (동일 사번+피평가자 재제출 시 덮어쓰기) */
function submit_(body) {
  const required = ['sabun', 'evaluatorName', 'role', 'intern', 'scores'];
  for (const k of required) {
    if (!body[k]) return { ok: false, error: '필수 항목 누락: ' + k };
  }
  if (new Date() > SUBMIT_DEADLINE) {
    return { ok: false, error: '제출 마감(2026-08-26 12:00)이 지나 더 이상 제출/수정할 수 없습니다. 문의는 인사담당자에게 해주세요.' };
  }
  const sheet = ensureResultSheet_();
  const rowData = [
    new Date(),
    body.sabun,
    body.evaluatorName,
    body.role,
    body.intern,
    body.scores.area1 || '', body.notes && body.notes.area1 || '',
    body.scores.area2 || '', body.notes && body.notes.area2 || '',
    body.scores.area3 || '', body.notes && body.notes.area3 || '',
    body.scores.area4 || '', body.notes && body.notes.area4 || '',
    body.scores.area5 || '', body.notes && body.notes.area5 || '',
    JSON.stringify(body.risk || {}),
    body.opinion || '',
    body.recommendation || ''
  ];

  const existing = getResultMap_();
  const key = String(body.sabun).trim() + '||' + body.intern;
  if (existing.has(key)) {
    const r = existing.get(key).rowIndex;
    sheet.getRange(r, 1, 1, rowData.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }
  return { ok: true };
}

/** 본인이 이미 제출한 평가 내용을 다시 불러와 수정할 수 있게 함 */
function myRecord_(sabun, internName) {
  if (!sabun || !internName) return { ok: false, error: 'sabun/intern 필요' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_RESULT);
  if (!sheet) return { ok: true, record: null };
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return { ok: true, record: null };
  const header = rows[0];
  const idxSabun = header.indexOf('사번');
  const idxIntern = header.indexOf('피평가자');
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][idxSabun]).trim() === String(sabun).trim() && rows[i][idxIntern] === internName) {
      const rec = {};
      header.forEach((h, idx) => rec[h] = rows[i][idx]);
      try { rec['위험요인_JSON'] = JSON.parse(rec['위험요인_JSON'] || '{}'); } catch (e) { rec['위험요인_JSON'] = {}; }
      return { ok: true, record: rec };
    }
  }
  return { ok: true, record: null };
}

function adminLogin_(code) {
  if (String(code) === getAdminCode_()) return { ok: true };
  return { ok: false, error: '관리자 코드가 올바르지 않습니다.' };
}

/** 관리자 대시보드: 인턴별 진행 현황 (14명 x 4명 배정) */
function adminData_(code) {
  const auth = adminLogin_(code);
  if (!auth.ok) return auth;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const targetRows = ss.getSheetByName(SHEET_TARGET).getDataRange().getValues();
  const tHeader = targetRows[0];
  const idxIntern = tHeader.indexOf('성명');
  const idxSite = tHeader.indexOf('통합조직명');
  const roleIdx = {};
  ROLE_COLUMNS.forEach(r => roleIdx[r] = tHeader.indexOf(r));

  const resultSheet = ss.getSheetByName(SHEET_RESULT);
  const submittedKeys = new Set(); // intern||role
  if (resultSheet) {
    const rows = resultSheet.getDataRange().getValues();
    const header = rows[0];
    const idxIntern2 = header.indexOf('피평가자');
    const idxRole = header.indexOf('역할');
    for (let i = 1; i < rows.length; i++) {
      submittedKeys.add(rows[i][idxIntern2] + '||' + rows[i][idxRole]);
    }
  }

  const interns = [];
  for (let i = 1; i < targetRows.length; i++) {
    const row = targetRows[i];
    const name = row[idxIntern];
    if (!name) continue;
    const roles = ROLE_COLUMNS.map(role => ({
      role: role,
      evaluator: row[roleIdx[role]],
      submitted: submittedKeys.has(name + '||' + role)
    }));
    const doneCount = roles.filter(r => r.submitted).length;
    interns.push({ intern: name, site: row[idxSite], roles: roles, doneCount: doneCount, total: 4 });
  }

  return { ok: true, interns: interns };
}

/** 특정 인턴에 대한 4개 평가 전체 (리포트/엑셀용) */
function reportData_(code, internName) {
  const auth = adminLogin_(code);
  if (!auth.ok) return auth;
  if (!internName) return { ok: false, error: '인턴명이 필요합니다.' };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const resultSheet = ss.getSheetByName(SHEET_RESULT);
  const records = [];
  if (resultSheet) {
    const rows = resultSheet.getDataRange().getValues();
    const header = rows[0];
    const idxIntern = header.indexOf('피평가자');
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][idxIntern] === internName) {
        const rec = {};
        header.forEach((h, idx) => rec[h] = rows[i][idx]);
        try { rec['위험요인_JSON'] = JSON.parse(rec['위험요인_JSON'] || '{}'); } catch (e) { rec['위험요인_JSON'] = {}; }
        records.push(rec);
      }
    }
  }
  const targetRows = ss.getSheetByName(SHEET_TARGET).getDataRange().getValues();
  const tHeader = targetRows[0];
  const idxIntern = tHeader.indexOf('성명');
  const idxSite = tHeader.indexOf('통합조직명');
  let site = '';
  for (let i = 1; i < targetRows.length; i++) {
    if (targetRows[i][idxIntern] === internName) { site = targetRows[i][idxSite]; break; }
  }

  return { ok: true, intern: internName, site: site, records: records };
}

/** 전체 평가결과를 admin이 한 번에 받아 엑셀(xlsx) 생성에 사용 */
function adminAllRecords_(code) {
  const auth = adminLogin_(code);
  if (!auth.ok) return auth;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const resultSheet = ss.getSheetByName(SHEET_RESULT);
  if (!resultSheet) return { ok: true, records: [] };
  const rows = resultSheet.getDataRange().getValues();
  if (rows.length < 2) return { ok: true, records: [] };
  const header = rows[0];
  const records = rows.slice(1).map(row => {
    const rec = {};
    header.forEach((h, idx) => rec[h] = row[idx]);
    return rec;
  });
  return { ok: true, records: records };
}
