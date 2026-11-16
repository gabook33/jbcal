// 구글 캘린더 연동 (서버 없이 브라우저에서 직접 호출).
// 로그인은 OAuth 2.0 "클라이언트 측 웹 앱" 방식(리디렉션 + access token)이다.
// 아이폰 홈 화면 앱(standalone)에서는 팝업이 잘 안 되므로 팝업 대신 같은 창 리디렉션을 쓴다.
// 토큰은 1시간짜리라 만료되면 조용히(prompt=none) 다시 받아 온다. 비밀값(client secret)은 쓰지 않는다.
import { TZ, rfc3339, dayKey, fromDayKey, DAY } from './time.js';

const API = 'https://www.googleapis.com/calendar/v3';
const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
export const CAL_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];
export const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
export const SCOPES = [...CAL_SCOPES, TASKS_SCOPE].join(' ');
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
    recurring: !!ev.recurringEventId,
    readOnly: cal.readOnly || ev.locked === true,
    link: ev.htmlLink || '',
    // 오른쪽 클릭 메뉴(색상·보기 방식·공개 범위)용. 구글에 값이 있을 때만 둔다
    ...(ev.colorId ? { colorId: ev.colorId } : {}),
    ...(ev.transparency === 'transparent' ? { free: true } : {}),
    ...(ev.visibility && ev.visibility !== 'default' ? { visibility: ev.visibility } : {}),
    ...(ev.reminders ? { reminder: reminderFromGoogle(ev.reminders) } : {}),
  };
}

/** 알림: 'default'(캘린더 기본) | 'none' | 분(팝업 1개) | 'custom'(앱에서 못 고치는 설정: 그대로 둔다) */
export function reminderFromGoogle(r) {
  if (!r || r.useDefault) return 'default';
  const o = r.overrides || [];
  if (!o.length) return 'none';
  if (o.length === 1 && o[0].method === 'popup') return o[0].minutes;
  return 'custom';
}
export function reminderToGoogle(v) {
  if (v === 'default') return { useDefault: true };
  if (v === 'none') return { useDefault: false, overrides: [] };
  if (Number.isFinite(v)) return { useDefault: false, overrides: [{ method: 'popup', minutes: v }] };
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
    body.start = { dateTime: rfc3339(e.start), timeZone: TZ };
    body.end = { dateTime: rfc3339(e.end), timeZone: TZ };
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

/** 로그인 화면으로 보낸다.
 *  조용한 갱신(prompt=none)은 캘린더 권한만 청한다: 아직 허락받지 않은 할 일 권한을 섞으면 구글이 동의 화면이 필요하다며
 *  거절하므로 캘린더까지 끊긴다. include_granted_scopes 덕분에 이미 허락한 할 일 권한은 새 토큰에 그대로 따라온다.
 *  사용자가 누른 로그인(silent 아님)은 캘린더 + 할 일을 같이 청한다 → 기존 사용자는 할 일 권한만 한 번 더 묻는다. */
export function beginLogin(clientId, { silent = false } = {}) {
  const state = crypto.getRandomValues(new Uint32Array(4)).join('-');
  sessionStorage.setItem(K_STATE, state);
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: silent ? CAL_SCOPES.join(' ') : SCOPES,
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
/** 할 일: 토큰에 Tasks 권한이 없음(다시 동의 필요) */
export class ScopeError extends Error {}
/** 할 일: 구글 클라우드 프로젝트에서 Tasks API 가 꺼져 있음 */
export class ApiDisabledError extends Error {}

async function call(path, { method = 'GET', body, query, base = API, label = '구글 캘린더' } = {}) {
  const token = getToken();
  if (!token) throw new AuthError('로그인이 필요합니다');
  const url = `${base}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
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
        localStorage.setItem(K_SCOPES, grantedScopes().filter((x) => x !== TASKS_SCOPE).join(' '));
        throw new ScopeError(msg);
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
    const r = await call(`/calendars/${enc(e.calendarId)}/events`, { method: 'POST', body: toGoogle(e) });
    return fromGoogle(r, cal);
  },
  async update(e, cal, prevCalendarId) {
    // 캘린더를 바꿨으면 먼저 옮긴다(move) → 내용 수정(patch)
    if (prevCalendarId && prevCalendarId !== e.calendarId) {
      await call(`/calendars/${enc(prevCalendarId)}/events/${enc(e.id)}/move`, {
        method: 'POST', query: { destination: e.calendarId },
      });
    }
    const r = await call(`/calendars/${enc(e.calendarId)}/events/${enc(e.id)}`, { method: 'PATCH', body: toGoogle(e) });
    return fromGoogle(r, cal);
  },
  async remove(e) {
    await call(`/calendars/${enc(e.calendarId)}/events/${enc(e.id)}`, { method: 'DELETE' });
  },
};

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

const tcall = (path, opts = {}) => call(path, { ...opts, base: TASKS_API, label: '구글 할 일' });

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
