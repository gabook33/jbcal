// 구글 캘린더 연동 (서버 없이 브라우저에서 직접 호출).
// 로그인은 OAuth 2.0 "클라이언트 측 웹 앱" 방식(리디렉션 + access token)이다.
// 아이폰 홈 화면 앱(standalone)에서는 팝업이 잘 안 되므로 팝업 대신 같은 창 리디렉션을 쓴다.
// 토큰은 1시간짜리라 만료되면 조용히(prompt=none) 다시 받아 온다. 비밀값(client secret)은 쓰지 않는다.
import { TZ, rfc3339, dayKey, fromDayKey, DAY } from './time.js';
import { truncateBefore } from './recur.js';

const API = 'https://www.googleapis.com/calendar/v3';
const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';
const PEOPLE_API = 'https://people.googleapis.com/v1';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
export const CAL_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];
export const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
export const SCOPES = [...CAL_SCOPES, TASKS_SCOPE].join(' ');
/** 기능별 추가 권한: 그 기능을 처음 쓸 때만 따로 동의를 받는다(incremental auth). 기존 기능은 위 권한만으로 동작한다 */
export const SCOPE = {
  drive: 'https://www.googleapis.com/auth/drive.file', // 이 앱으로 올린 파일만
  contacts: 'https://www.googleapis.com/auth/contacts.readonly',
  otherContacts: 'https://www.googleapis.com/auth/contacts.other.readonly', // 메일 주고받은 「기타 연락처」
  freebusy: 'https://www.googleapis.com/auth/calendar.freebusy',
  calList: 'https://www.googleapis.com/auth/calendar.calendarlist', // 캘린더 목록 색·구독
  calCreate: 'https://www.googleapis.com/auth/calendar.app.created', // 이 앱이 만든 캘린더만
};
export const FEATURES = {
  attach: { name: '드라이브 파일 첨부', scopes: [SCOPE.drive], what: '이 앱으로 올린 구글 드라이브 파일만 보고 관리(다른 드라이브 파일은 못 봄)' },
  contacts: { name: '연락처 이름으로 참석자 찾기', scopes: [SCOPE.contacts, SCOPE.otherContacts], what: '구글 주소록과 기타 연락처 읽기(바꾸지 않음)' },
  freebusy: { name: '가용 시간 조회', scopes: [SCOPE.freebusy], what: '내 캘린더와 참석자 캘린더의 바쁜 시간만 보기(일정 내용은 안 봄)' },
  calendars: { name: '구글 캘린더 색·구독·새 캘린더', scopes: [SCOPE.calList, SCOPE.calCreate], what: '캘린더 목록 색 바꾸기·구독 추가, 이 앱이 만든 새 캘린더 관리' },
};
const K_TOKEN = 'nanal.gtoken';
const K_STATE = 'nanal.oauthState';
const K_LINKED = 'nanal.linked';
const K_SCOPES = 'nanal.gscopes'; // 구글이 마지막으로 허락해 준 권한 범위(공백으로 구분)

// 구글 일정 색(colorId 1~11)
export const EVENT_COLORS = {
  1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e',
  7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000',
};

/* ---------- 변환 (순수 함수, 테스트 대상) ---------- */

export function fromGoogle(ev, cal) {
  const allDay = !!ev.start?.date;
  const start = allDay ? fromDayKey(ev.start.date) : Date.parse(ev.start.dateTime);
  let end = allDay ? fromDayKey(ev.end?.date || ev.start.date) : Date.parse(ev.end?.dateTime || ev.start.dateTime);
  if (allDay && end <= start) end = start + DAY;
  return {
    id: ev.id,
    calendarId: cal.id,
    title: ev.summary || '(제목 없음)',
    start, end, allDay,
    location: ev.location || '',
    note: ev.description || '',
    color: ev.colorId ? EVENT_COLORS[ev.colorId] : null,
    recurring: !!ev.recurringEventId || !!ev.recurrence,
    readOnly: cal.readOnly || ev.locked === true,
    link: ev.htmlLink || '',
    // 반복: 회차(instance)는 원본(master) id 와 원래 시작 시각, 원본은 RRULE 줄
    ...(ev.recurringEventId ? { recurringEventId: ev.recurringEventId } : {}),
    ...(ev.originalStartTime ? { originalStart: ev.originalStartTime.date ? fromDayKey(ev.originalStartTime.date) : Date.parse(ev.originalStartTime.dateTime) } : {}),
    ...(ev.recurrence ? { recurrence: ev.recurrence } : {}),
    // URL(구글 source), 참석자, 일정 시간대(서울이 아닐 때만), 화상회의 링크
    ...(ev.source?.url ? { url: ev.source.url } : {}),
    ...(ev.attendees?.length ? { attendees: ev.attendees.map(attFromGoogle) } : {}),
    ...(ev.start?.timeZone && ev.start.timeZone !== TZ ? { tz: ev.start.timeZone } : {}),
    ...(meetOf(ev) ? { meet: meetOf(ev) } : {}),
    // 오른쪽 클릭 메뉴(색상·보기 방식·공개 범위)용. 구글에 값이 있을 때만 둔다
    ...(ev.colorId ? { colorId: ev.colorId } : {}),
    ...(ev.transparency === 'transparent' ? { free: true } : {}),
    ...(ev.visibility && ev.visibility !== 'default' ? { visibility: ev.visibility } : {}),
    ...(ev.reminders ? { reminder: reminderFromGoogle(ev.reminders) } : {}),
    ...(ev.attachments?.length ? { attachments: ev.attachments.map(attachFromGoogle) } : {}),
  };
}
/** 첨부(구글 드라이브 파일 링크) */
export const attachFromGoogle = (a) => ({
  fileUrl: a.fileUrl, title: a.title || '첨부 파일',
  ...(a.mimeType ? { mimeType: a.mimeType } : {}), ...(a.iconLink ? { iconLink: a.iconLink } : {}), ...(a.fileId ? { fileId: a.fileId } : {}),
});

const attFromGoogle = (a) => ({
  email: a.email || '', name: a.displayName || '', status: a.responseStatus || 'needsAction',
  ...(a.self ? { self: true } : {}), ...(a.organizer ? { organizer: true } : {}), ...(a.optional ? { optional: true } : {}),
});
/** 화상회의(구글 Meet 등) 참가 주소 */
export function meetOf(ev) {
  if (ev.hangoutLink) return ev.hangoutLink;
  return ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri || '';
}

/** 알림: 'default'(캘린더 기본) | 'none' | 분(팝업 1개) | [분, 분…](팝업 여러 개) | 'custom'(이메일 알림 등: 그대로 둔다) */
export function reminderFromGoogle(r) {
  if (!r || r.useDefault) return 'default';
  const o = r.overrides || [];
  if (!o.length) return 'none';
  if (o.every((x) => x.method === 'popup')) {
    const mins = [...new Set(o.map((x) => x.minutes))].sort((a, b) => a - b);
    return mins.length === 1 ? mins[0] : mins;
  }
  return 'custom';
}
export function reminderToGoogle(v) {
  if (v === 'default') return { useDefault: true };
  if (v === 'none') return { useDefault: false, overrides: [] };
  if (Number.isFinite(v)) return { useDefault: false, overrides: [{ method: 'popup', minutes: v }] };
  // 구글은 알림을 일정 하나에 다섯 개까지 받는다
  if (Array.isArray(v)) return { useDefault: false, overrides: [...new Set(v)].slice(0, 5).map((minutes) => ({ method: 'popup', minutes })) };
  return undefined; // undefined·'custom': 보내지 않으면 구글에 있던 알림이 그대로 남는다
}

export function toGoogle(e) {
  const body = {
    summary: e.title,
    location: e.location || '',
    description: e.note || '',
  };
  if (e.allDay) {
    body.start = { date: dayKey(e.start) };
    body.end = { date: dayKey(Math.max(e.end, e.start + DAY)) };
  } else {
    // 시각은 늘 +09:00 으로 보내고(절대 시각), 시간대 이름은 일정 시간대(없으면 서울)로 둔다
    body.start = { dateTime: rfc3339(e.start), timeZone: e.tz || TZ };
    body.end = { dateTime: rfc3339(e.end), timeZone: e.tz || TZ };
  }
  // 반복 규칙·URL 은 앱에서 정했을 때만 보낸다(안 보내면 구글 값 그대로)
  if (e.recurrence !== undefined) body.recurrence = e.recurrence;
  if (e.url !== undefined) body.source = e.url ? { title: e.title || 'URL', url: e.url } : null;
  // 참석자는 앱에서 바꿨을 때만 보낸다(남이 만든 일정의 참석자 목록을 건드리지 않게)
  if (e.attendeesChanged && e.attendees) {
    body.attendees = e.attendees.map((a) => ({
      email: a.email, ...(a.status ? { responseStatus: a.status } : {}), ...(a.optional ? { optional: true } : {}),
      ...(a.name ? { displayName: a.name } : {}),
    }));
  }
  // 첨부: 앱에서 바꿨을 때만 보낸다(빈 배열 = 모두 빼기)
  if (e.attachments !== undefined && e.attachmentsChanged) body.attachments = e.attachments.map(attachFromGoogle);
  if (e.addMeet) {
    body.conferenceData = { createRequest: { requestId: `jbcal-${Date.now().toString(36)}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  }
  // reminders를 보내지 않으면 새 일정은 캘린더 기본 알림, 고칠 때는 원래 알림이 그대로 남는다.
  const reminders = reminderToGoogle(e.reminder);
  if (reminders) body.reminders = reminders;
  // 색(colorId null = 캘린더 색으로), 보기 방식(바쁨/한가함), 공개 범위: 앱에서 정했을 때만 보낸다
  if (e.colorId !== undefined) body.colorId = e.colorId;
  if (e.free !== undefined) body.transparency = e.free ? 'transparent' : 'opaque';
  if (e.visibility !== undefined) body.visibility = e.visibility;
  return body;
}

export function calFromGoogle(c) {
  return {
    id: c.id,
    name: c.summaryOverride || c.summary,
    color: c.backgroundColor || '#4f5bd5',
    primary: !!c.primary,
    readOnly: !['owner', 'writer'].includes(c.accessRole),
    visible: c.selected !== false,
    owner: c.accessRole === 'owner',
    // 캘린더 기본 알림(이 기기 알림에서 「기본」 알림 시각으로 쓴다)
    defaultReminders: (c.defaultReminders || []).filter((r) => r.method === 'popup').map((r) => r.minutes),
  };
}

/* ---------- 로그인 ---------- */

export function getToken() {
  try {
    const t = JSON.parse(localStorage.getItem(K_TOKEN) || 'null');
    if (t && t.exp > Date.now() + 60e3) return t.value;
  } catch { /* 무시 */ }
  return null;
}
export const wasLinked = () => localStorage.getItem(K_LINKED) === '1';

export function redirectUri() {
  // GitHub Pages 하위 경로(/jbcal/)와 localhost 모두에서, index.html 유무와 무관하게 폴더 주소(+ 끝 /)를 쓴다.
  let path = location.pathname.replace(/\/index\.html$/, '/');
  if (!path.endsWith('/')) path += '/';
  return location.origin + path;
}

/** 구글이 허락한 권한 범위. 할 일(Tasks) 권한이 생기기 전에 연결한 기기는 비어 있다 */
export const grantedScopes = () => (localStorage.getItem(K_SCOPES) || '').split(/\s+/).filter(Boolean);
export const hasTasksScope = () => grantedScopes().includes(TASKS_SCOPE);
/** 기능 권한: all=모든 권한 / some=하나라도(연락처처럼 동의 화면에서 일부만 고를 수 있는 것) */
export const hasScope = (s) => grantedScopes().includes(s);
export const hasFeature = (f, some = false) => FEATURES[f].scopes[some ? 'some' : 'every'](hasScope);

/** 로그인 화면으로 보낸다.
 *  조용한 갱신(prompt=none)은 캘린더 권한만 청한다: 아직 허락받지 않은 할 일 권한을 섞으면 구글이 동의 화면이 필요하다며
 *  거절하므로 캘린더까지 끊긴다. include_granted_scopes 덕분에 이미 허락한 할 일 권한은 새 토큰에 그대로 따라온다.
 *  사용자가 누른 로그인(silent 아님)은 캘린더 + 할 일을 같이 청한다 → 기존 사용자는 할 일 권한만 한 번 더 묻는다. */
export function beginLogin(clientId, { silent = false, scopes = null } = {}) {
  const state = crypto.getRandomValues(new Uint32Array(4)).join('-');
  sessionStorage.setItem(K_STATE, state);
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    // scopes: 기능 추가 동의(캘린더 권한 + 그 기능 권한만 청한다. 이미 허락한 할 일 권한은 include_granted_scopes 로 따라온다)
    scope: scopes ? [...CAL_SCOPES, ...scopes].join(' ') : silent ? CAL_SCOPES.join(' ') : SCOPES,
    include_granted_scopes: 'true',
    state,
  });
  if (silent) q.set('prompt', 'none');
  location.assign(`${AUTH}?${q}`);
}

/** 로그인에서 돌아왔을 때 주소 # 뒤의 토큰을 꺼내 저장하고 주소창에서 지운다. */
export function consumeRedirect() {
  if (!location.hash || location.hash.length < 2) return null;
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has('access_token') && !h.has('error')) return null;
  const expected = sessionStorage.getItem(K_STATE);
  sessionStorage.removeItem(K_STATE);
  history.replaceState(null, '', location.pathname + location.search);
  if (h.get('state') !== expected) return { error: 'state_mismatch' };
  if (h.has('error')) return { error: h.get('error') };
  localStorage.setItem(K_TOKEN, JSON.stringify({
    value: h.get('access_token'),
    exp: Date.now() + (Number(h.get('expires_in')) || 3600) * 1000,
  }));
  localStorage.setItem(K_LINKED, '1');
  if (h.has('scope')) localStorage.setItem(K_SCOPES, h.get('scope'));
  return { ok: true };
}

export async function logout() {
  const t = getToken();
  localStorage.removeItem(K_TOKEN);
  localStorage.removeItem(K_LINKED);
  localStorage.removeItem(K_SCOPES);
  if (t) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: 'POST' });
    } catch { /* 오프라인이어도 로컬 로그아웃은 된다 */ }
  }
}

/* ---------- API ---------- */

export class AuthError extends Error {}
/** 토큰에 그 기능 권한이 없음(다시 동의 필요). scopes: 빠진 권한 */
export class ScopeError extends Error {
  constructor(msg, scopes = []) { super(msg); this.scopes = scopes; }
}
/** 할 일: 구글 클라우드 프로젝트에서 Tasks API 가 꺼져 있음 */
export class ApiDisabledError extends Error {}

/** need: 이 요청에 드는 기능 권한(권한 부족 오류면 저장해 둔 허락 목록에서 뺀다) */
async function call(path, { method = 'GET', body, raw, headers = {}, query, base = API, label = '구글 캘린더', need = [] } = {}) {
  const token = getToken();
  if (!token) throw new AuthError('로그인이 필요합니다');
  const url = `${base}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  if (res.status === 401) {
    localStorage.removeItem(K_TOKEN);
    throw new AuthError('로그인이 만료되었습니다');
  }
  if (!res.ok) {
    let msg = `${res.status}`;
    let err = null;
    try { err = (await res.json()).error; msg = err?.message || msg; } catch { /* 무시 */ }
    if (res.status === 403) {
      const why = JSON.stringify(err || {});
      if (/SERVICE_DISABLED|accessNotConfigured|has not been used|is disabled/i.test(why)) throw new ApiDisabledError(msg);
      if (/insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(why)) {
        localStorage.setItem(K_SCOPES, grantedScopes().filter((x) => !need.includes(x)).join(' '));
        throw new ScopeError(msg, need);
      }
    }
    throw new Error(`${label} 오류: ${msg}`);
  }
  return res.status === 204 ? null : res.json();
}

const enc = encodeURIComponent;

/** 구글 캘린더 저장소: demo.js 와 같은 모양(인터페이스)이다. */
export const googleStore = {
  kind: 'google',
  async calendars() {
    const items = [];
    let pageToken;
    do {
      const r = await call('/users/me/calendarList', { query: { maxResults: 250, ...(pageToken ? { pageToken } : {}) } });
      items.push(...(r.items || []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return items.map(calFromGoogle).sort((a, b) => (b.primary - a.primary) || (a.readOnly - b.readOnly));
  },
  async events(cals, from, to) {
    const lists = await Promise.all(cals.map(async (cal) => {
      const out = [];
      let pageToken;
      do {
        const r = await call(`/calendars/${enc(cal.id)}/events`, {
          query: {
            timeMin: new Date(from).toISOString(),
            timeMax: new Date(to).toISOString(),
            singleEvents: 'true',
            orderBy: 'startTime',
            maxResults: 2500,
            timeZone: TZ,
            ...(pageToken ? { pageToken } : {}),
          },
        });
        out.push(...(r.items || []).filter((e) => e.status !== 'cancelled').map((e) => fromGoogle(e, cal)));
        pageToken = r.nextPageToken;
      } while (pageToken);
      return out;
    }));
    return lists.flat();
  },
  async create(e, cal) {
    const r = await call(`/calendars/${enc(e.calendarId)}/events`, { method: 'POST', body: toGoogle(e), query: writeQuery(e) });
    return fromGoogle(r, cal);
  },
  async update(e, cal, prevCalendarId) {
    // 캘린더를 바꿨으면 먼저 옮긴다(move) → 내용 수정(patch)
    if (prevCalendarId && prevCalendarId !== e.calendarId) {
      await call(`/calendars/${enc(prevCalendarId)}/events/${enc(e.id)}/move`, {
        method: 'POST', query: { destination: e.calendarId },
      });
    }
    const r = await call(`/calendars/${enc(e.calendarId)}/events/${enc(e.id)}`, { method: 'PATCH', body: toGoogle(e), query: writeQuery(e) });
    return fromGoogle(r, cal);
  },
  async remove(e) {
    await call(`/calendars/${enc(e.calendarId)}/events/${enc(e.id)}`, { method: 'DELETE', query: { sendUpdates: e.notify ? 'all' : 'none' } });
  },
  /** 한 일정(반복 원본 포함) 그대로 읽기 */
  async get(calendarId, id, cal) {
    return fromGoogle(await call(`/calendars/${enc(calendarId)}/events/${enc(id)}`), cal || { id: calendarId });
  },
  /** 반복 일정 「이후 모든 일정」 삭제: 원본 규칙을 이 회차 앞에서 끝낸다. 첫 회차면 원본을 지운다.
   *  되돌리기에 쓸 값을 돌려준다: {masterId, prev}(규칙 되돌림) 또는 {deletedAll: true} */
  async removeFollowing(e) {
    const path = `/calendars/${enc(e.calendarId)}/events/${enc(e.recurringEventId)}`;
    const master = await call(path);
    const ms = master.start.date ? fromDayKey(master.start.date) : Date.parse(master.start.dateTime);
    if ((e.originalStart ?? e.start) <= ms) {
      await call(path, { method: 'DELETE', query: { sendUpdates: 'none' } });
      return { deletedAll: true };
    }
    const prev = master.recurrence || [];
    await call(path, { method: 'PATCH', body: { recurrence: truncateBefore(prev, e.originalStart ?? e.start, !!master.start.date) }, query: { sendUpdates: 'none' } });
    return { masterId: master.id, prev };
  },
  /** 반복 원본 규칙 바꾸기(「이후 모두」 되돌리기) */
  async setRecurrence(calendarId, masterId, recurrence) {
    await call(`/calendars/${enc(calendarId)}/events/${enc(masterId)}`, { method: 'PATCH', body: { recurrence }, query: { sendUpdates: 'none' } });
  },
  /** 「이 일정만」 지운 반복 회차 되살리기 */
  async restoreInstance(e) {
    await call(`/calendars/${enc(e.calendarId)}/events/${enc(e.id)}`, { method: 'PATCH', body: { status: 'confirmed' }, query: { sendUpdates: 'none' } });
  },

  /** 내 응답(수락·미정·거절): 참석자 목록에서 내 응답만 바꿔 보낸다(지금 권한으로 됨, 메일은 보내지 않음) */
  async respond(e, status) {
    const attendees = e.attendees.map((a) => ({
      email: a.email, responseStatus: a.self ? status : a.status || 'needsAction',
      ...(a.optional ? { optional: true } : {}), ...(a.name ? { displayName: a.name } : {}),
    }));
    await call(`/calendars/${enc(e.calendarId)}/events/${enc(e.id)}`, { method: 'PATCH', body: { attendees }, query: { sendUpdates: 'none' } });
  },

  /* ----- 아래는 기능별 추가 권한이 드는 것(처음 쓸 때 동의) ----- */

  /** 가용 시간: {이메일·캘린더ID: [{start, end}]}. 볼 수 없는 캘린더는 {error} */
  async freeBusy(ids, from, to) {
    const r = await call('/freeBusy', {
      method: 'POST', need: [SCOPE.freebusy],
      body: { timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), timeZone: TZ, items: ids.map((id) => ({ id })) },
    });
    return freeBusyFromGoogle(r);
  },
  /** 연락처 이름·이메일 찾기: 주소록 + 기타 연락처(허락한 것만) */
  async searchContacts(q) {
    const out = [];
    const jobs = [];
    // 구글 안내대로 처음 한 번은 빈 검색으로 캐시를 데운다
    if (!peopleWarm) {
      peopleWarm = true;
      await Promise.all([
        hasScope(SCOPE.contacts) && peopleSearch('/people:searchContacts', '', 'names', [SCOPE.contacts]).catch(() => null),
        hasScope(SCOPE.otherContacts) && peopleSearch('/otherContacts:search', '', 'names', [SCOPE.otherContacts]).catch(() => null),
      ]);
    }
    if (hasScope(SCOPE.contacts)) jobs.push(peopleSearch('/people:searchContacts', q, 'names,emailAddresses', [SCOPE.contacts]));
    if (hasScope(SCOPE.otherContacts)) jobs.push(peopleSearch('/otherContacts:search', q, 'names,emailAddresses', [SCOPE.otherContacts]));
    if (!jobs.length) throw new ScopeError('연락처 권한이 없습니다', FEATURES.contacts.scopes);
    for (const r of await Promise.all(jobs)) out.push(...peopleFromGoogle(r));
    return dedupeContacts(out);
  },
  /** 이 기기 파일을 구글 드라이브(내 드라이브)에 올리고 첨부 모양으로 돌려준다(5MB까지, 한 번에 올리기) */
  async uploadAttachment(file) {
    const boundary = `jbcal${Date.now().toString(36)}`;
    const meta = { name: file.name, mimeType: file.type || 'application/octet-stream', description: "JB's 캘린더에서 첨부" };
    const raw = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: ${meta.mimeType}\r\n\r\n`, file, `\r\n--${boundary}--`,
    ]);
    const r = await call('/files', {
      base: UPLOAD_API, method: 'POST', raw, need: [SCOPE.drive], label: '구글 드라이브',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      query: { uploadType: 'multipart', fields: 'id,name,mimeType,webViewLink,iconLink' },
    });
    return { fileUrl: r.webViewLink || `https://drive.google.com/open?id=${r.id}`, title: r.name, mimeType: r.mimeType, fileId: r.id, ...(r.iconLink ? { iconLink: r.iconLink } : {}) };
  },
  /** 구글 쪽 캘린더 색(모든 기기) */
  async setCalendarColor(id, hex) {
    await call(`/users/me/calendarList/${enc(id)}`, {
      method: 'PATCH', need: [SCOPE.calList], query: { colorRgbFormat: 'true' },
      body: { backgroundColor: hex, foregroundColor: readableOn(hex) },
    });
  },
  /** 캘린더 구독(공휴일·공개 캘린더 ID·다른 사람 이메일) */
  async subscribeCalendar(id) {
    return calFromGoogle(await call('/users/me/calendarList', { method: 'POST', need: [SCOPE.calList], body: { id } }));
  },
  /** 구독 해제(내 목록에서만 빠짐. 캘린더 자체는 그대로) */
  async unsubscribeCalendar(id) {
    await call(`/users/me/calendarList/${enc(id)}`, { method: 'DELETE', need: [SCOPE.calList] });
  },
  /** 새 캘린더 만들기(색은 목록 권한이 있으면 같이) */
  async createCalendar(name, hex) {
    const c = await call('/calendars', { method: 'POST', need: [SCOPE.calCreate], body: { summary: name, timeZone: TZ } });
    if (hex && hasScope(SCOPE.calList)) { try { await this.setCalendarColor(c.id, hex); } catch { /* 색은 나중에 */ } }
    return { id: c.id, name: c.summary, color: hex || '#4f5bd5', primary: false, readOnly: false, visible: true, owner: true, defaultReminders: [] };
  },
};

let peopleWarm = false;
function peopleSearch(path, query, readMask, need) {
  return call(path, { base: PEOPLE_API, need, label: '구글 연락처', query: { query, readMask, pageSize: 10 } });
}
/** People API 검색 결과 → [{name, email}] */
export function peopleFromGoogle(r) {
  const out = [];
  for (const x of r?.results || []) {
    const p = x.person || {};
    const name = p.names?.[0]?.displayName || '';
    for (const em of p.emailAddresses || []) if (em.value) out.push({ name, email: em.value });
  }
  return out;
}
export function dedupeContacts(list) {
  const seen = new Set();
  return list.filter((c) => { const k = c.email.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}
/** freeBusy 응답 → {id: {busy:[{start,end}]} | {error}} (시각은 ms) */
export function freeBusyFromGoogle(r) {
  const out = {};
  for (const [id, v] of Object.entries(r?.calendars || {})) {
    out[id] = v.errors?.length ? { error: v.errors[0].reason || 'error' }
      : { busy: (v.busy || []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })) };
  }
  return out;
}
/** 배경색에 맞는 글자색(흰색/검정) */
export function readableOn(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (r * 299 + g * 587 + b * 114) / 1000 > 160 ? '#000000' : '#ffffff';
}
/** 쓰기 요청 덧붙임: 참석자에게 메일(사용자가 고른 때만), 구글 Meet 만들기 */
function writeQuery(e) {
  // supportsAttachments: 첨부를 아는 앱이라고 알린다(보내지 않은 첨부는 구글 쪽 그대로)
  return { sendUpdates: e.notify ? 'all' : 'none', supportsAttachments: 'true', ...(e.addMeet || e.meet ? { conferenceDataVersion: 1 } : {}) };
}

/* ---------- 할 일 (Google Tasks) ---------- */
// 구글 할 일의 마감일은 날짜만 쓴다(시각은 구글이 버린다). 'YYYY-MM-DDT00:00:00.000Z' 의 날짜 부분이 그 날이다.

export function taskFromGoogle(t, list) {
  return {
    id: t.id,
    listId: list.id,
    title: t.title || '',
    notes: t.notes || '',
    due: t.due ? fromDayKey(t.due.slice(0, 10)) : null,
    done: t.status === 'completed',
    completed: t.completed ? Date.parse(t.completed) : null,
    parent: t.parent || null,
    position: t.position || '',
    link: t.webViewLink || '',
  };
}

/** 앱 → 구글. create 가 아니면(수정) 빈 마감일·완료 시각을 null 로 보내 구글 쪽 값도 지운다 */
export function taskToGoogle(t, { create = false } = {}) {
  const body = {
    title: t.title,
    notes: t.notes || '',
    status: t.done ? 'completed' : 'needsAction',
  };
  if (t.due != null) body.due = `${dayKey(t.due)}T00:00:00.000Z`;
  else if (!create) body.due = null;
  if (!t.done && !create) body.completed = null;
  return body;
}

const tcall = (path, opts = {}) => call(path, { ...opts, base: TASKS_API, label: '구글 할 일', need: [TASKS_SCOPE] });

export const googleTasks = {
  kind: 'google',
  async lists() {
    const out = [];
    let pageToken;
    do {
      const r = await tcall('/users/@me/lists', { query: { maxResults: 100, ...(pageToken ? { pageToken } : {}) } });
      out.push(...(r.items || []).map((l) => ({ id: l.id, title: l.title || '할 일' })));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  },
  async tasks(lists) {
    const per = await Promise.all(lists.map(async (list) => {
      const out = [];
      let pageToken;
      let pages = 0;
      do {
        // 완료한 할 일은 구글 앱에서 「숨김」으로 바뀌므로 showHidden 도 켠다
        const r = await tcall(`/lists/${enc(list.id)}/tasks`, {
          query: { maxResults: 100, showCompleted: 'true', showHidden: 'true', ...(pageToken ? { pageToken } : {}) },
        });
        out.push(...(r.items || []).filter((t) => !t.deleted).map((t) => taskFromGoogle(t, list)));
        pageToken = r.nextPageToken;
      } while (pageToken && ++pages < 20);
      return out;
    }));
    return per.flat();
  },
  async create(t) {
    const r = await tcall(`/lists/${enc(t.listId)}/tasks`, { method: 'POST', body: taskToGoogle(t, { create: true }) });
    return taskFromGoogle(r, { id: t.listId });
  },
  async update(t, prevListId) {
    // 목록을 바꿨으면 먼저 옮긴다(move, destinationTasklist) → 내용 수정(patch)
    if (prevListId && prevListId !== t.listId) {
      await tcall(`/lists/${enc(prevListId)}/tasks/${enc(t.id)}/move`, { method: 'POST', query: { destinationTasklist: t.listId } });
    }
    const r = await tcall(`/lists/${enc(t.listId)}/tasks/${enc(t.id)}`, { method: 'PATCH', body: taskToGoogle(t) });
    return taskFromGoogle(r, { id: t.listId });
  },
  async remove(t) {
    await tcall(`/lists/${enc(t.listId)}/tasks/${enc(t.id)}`, { method: 'DELETE' });
  },
};
