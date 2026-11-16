// 구글 캘린더 연동 (서버 없이 브라우저에서 직접 호출).
// 로그인은 OAuth 2.0 "클라이언트 측 웹 앱" 방식(리디렉션 + access token)이다.
// 아이폰 홈 화면 앱(standalone)에서는 팝업이 잘 안 되므로 팝업 대신 같은 창 리디렉션을 쓴다.
// 토큰은 1시간짜리라 만료되면 조용히(prompt=none) 다시 받아 온다. 비밀값(client secret)은 쓰지 않는다.
import { TZ, rfc3339, dayKey, fromDayKey, DAY } from './time.js';

const API = 'https://www.googleapis.com/calendar/v3';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
].join(' ');
const K_TOKEN = 'nanal.gtoken';
const K_STATE = 'nanal.oauthState';
const K_LINKED = 'nanal.linked';

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
  };
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
  // reminders를 보내지 않으면 구글 캘린더의 기본 알림이 그대로 적용된다.
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

export function beginLogin(clientId, { silent = false } = {}) {
  const state = crypto.getRandomValues(new Uint32Array(4)).join('-');
  sessionStorage.setItem(K_STATE, state);
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPES,
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
  return { ok: true };
}

export async function logout() {
  const t = getToken();
  localStorage.removeItem(K_TOKEN);
  localStorage.removeItem(K_LINKED);
  if (t) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: 'POST' });
    } catch { /* 오프라인이어도 로컬 로그아웃은 된다 */ }
  }
}

/* ---------- API ---------- */

export class AuthError extends Error {}

async function call(path, { method = 'GET', body, query } = {}) {
  const token = getToken();
  if (!token) throw new AuthError('로그인이 필요합니다');
  const url = `${API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
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
    try { msg = (await res.json()).error?.message || msg; } catch { /* 무시 */ }
    throw new Error(`구글 캘린더 오류: ${msg}`);
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
