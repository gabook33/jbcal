// 데모 모드 저장소: 구글 연결 없이 예시 일정으로 화면을 확인한다.
// 추가·수정·삭제는 이 기기(localStorage)에만 저장된다.
import { P, T, DAY, startOfDay } from './time.js';
import { ruleOf, expand, truncateBefore, untilStr } from './recur.js';

const K = 'nanal.demo.v1';
const KC = 'nanal.demo.cals.v1'; // 데모: 구독·새로 만든 캘린더, 구글 쪽 색(가짜)
export const DEMO_SELF = 'jb@example.com';

const CALS = [
  { id: 'personal', name: '개인', color: '#3b82f6', primary: true, readOnly: false, visible: true },
  { id: 'work', name: '업무', color: '#7c5cff', primary: false, readOnly: false, visible: true },
  { id: 'family', name: '가족', color: '#16a34a', primary: false, readOnly: false, visible: true },
  { id: 'fitness', name: '운동', color: '#f59e0b', primary: false, readOnly: false, visible: true },
  { id: 'holiday', name: '대한민국 공휴일', color: '#e5484d', primary: false, readOnly: true, visible: true },
];

function seed(now) {
  const today = startOfDay(now);
  const evs = [];
  let n = 0;
  const at = (dayOff, h, mi, durMin, calendarId, title, location = '', note = '') => evs.push({
    id: `d${++n}`, calendarId, title, location, note, allDay: false,
    start: today + dayOff * DAY + (h * 60 + mi) * 60e3,
    end: today + dayOff * DAY + (h * 60 + mi + durMin) * 60e3,
  });
  const allDay = (dayOff, days, calendarId, title, location = '') => evs.push({
    id: `d${++n}`, calendarId, title, location, note: '', allDay: true,
    start: today + dayOff * DAY, end: today + (dayOff + days) * DAY,
  });

  // 4주 동안 반복되는 일정
  for (let d = -10; d <= 24; d++) {
    const dow = P(today + d * DAY).dow;
    if (dow === 1 || dow === 3 || dow === 5) at(d, 9, 30, 30, 'work', '팀 스탠드업', '온라인');
    if (dow === 2 || dow === 4) at(d, 7, 0, 60, 'fitness', '아침 수영', '구민체육센터');
  }
  at(0, 10, 30, 90, 'work', 'K-2 보고서 검토', '본관 3층 회의실', '별첨 1 수치 최종 확인');
  at(0, 11, 0, 30, 'work', '전화 · 시청 담당자');
  at(0, 12, 30, 60, 'personal', '점심 · 김 과장', '광화문');
  at(0, 15, 0, 60, 'personal', '치과 정기검진', '서울치과');
  at(0, 19, 0, 60, 'fitness', '필라테스');
  at(1, 14, 0, 90, 'work', '투자 검토 회의', '대회의실');
  at(1, 18, 30, 150, 'personal', '저녁 약속', '강남역');
  at(2, 11, 0, 30, 'family', '부모님 안부 전화');
  at(2, 16, 0, 60, 'work', '뉴스레터 초안 마감');
  allDay(3, 3, 'work', '제주 출장', '제주');
  at(5, 12, 0, 180, 'family', '가족 모임', '본가');
  at(8, 8, 0, 120, 'personal', '건강검진', '국민건강보험공단');
  allDay(7, 1, 'work', 'GeoInsight 위클리 발행');
  at(-1, 19, 30, 90, 'personal', '독서 모임');
  allDay(-2, 1, 'work', '월간 보고 마감');
  at(12, 10, 0, 60, 'work', '분기 전략 회의');
  at(15, 19, 0, 120, 'family', '결혼기념일 저녁', '한남동');
  // 남이 초대한 일정(내 응답·가용 시간 시험용)
  at(9, 10, 0, 60, 'work', '협력사 미팅', '시청 별관', 'Zoom: https://zoom.us/j/123456789?pwd=demo');
  evs[evs.length - 1].attendees = [
    { email: 'partner@example.com', name: '박 대표', status: 'accepted', organizer: true },
    { email: DEMO_SELF, name: 'JB', status: 'needsAction', self: true },
    { email: 'minsu.kim@example.com', name: '김민수', status: 'tentative' },
  ];
  // 반복 일정(구글처럼 원본 하나 + RRULE): 오늘 뒤 첫 목요일부터 매주 목요일 오후 4시
  const thu = today + (((4 - P(today).dow + 7) % 7) || 7) * DAY;
  evs.push({ id: 'r1', calendarId: 'work', title: '주간 업무 회의', location: '소회의실', note: '', allDay: false,
    start: thu + 16 * 3600e3, end: thu + 17 * 3600e3, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'], exdates: [] });

  // 공휴일 (데모 기간 근처의 실제 날짜)
  const y = P(now).y;
  const hol = [[0, 1, '신정'], [2, 1, '삼일절'], [4, 5, '어린이날'], [5, 6, '현충일'], [7, 15, '광복절'],
    [9, 3, '개천절'], [9, 9, '한글날'], [11, 25, '성탄절']];
  for (const yy of [y, y + 1]) {
    for (const [m, d, name] of hol) {
      const s = T(yy, m, d);
      if (Math.abs(s - today) < 120 * DAY) evs.push({ id: `h${yy}${m}${d}`, calendarId: 'holiday', title: name, allDay: true, start: s, end: s + DAY, location: '', note: '' });
    }
  }
  return evs;
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(K) || 'null');
    if (s && Array.isArray(s.events)) return s.events;
  } catch { /* 무시 */ }
  const evs = seed(Date.now());
  save(evs);
  return evs;
}
function save(events) {
  localStorage.setItem(K, JSON.stringify({ events }));
}

export function resetDemo() {
  localStorage.removeItem(K);
  localStorage.removeItem(KT);
  localStorage.removeItem(KC);
}
const loadCals = () => { try { return { extra: [], colors: {}, removed: [], ...JSON.parse(localStorage.getItem(KC) || '{}') }; } catch { return { extra: [], colors: {}, removed: [] }; } };
const saveCals = (c) => localStorage.setItem(KC, JSON.stringify(c));
// 데모 구독 목록(구글에서 쓰는 공개 캘린더 ID와 같은 모양)
const DEMO_PUBLIC = { 'ja.japanese#holiday@group.v.calendar.google.com': '일본 공휴일', 'en.usa#holiday@group.v.calendar.google.com': '미국 공휴일',
  'ht3jlfaac5lfd6263ulfh4tql8@group.calendar.google.com': '달의 위상' };
const DEMO_CONTACTS = [
  { name: '김민수', email: 'minsu.kim@example.com' }, { name: '김민지', email: 'minji@example.org' },
  { name: '박 대표', email: 'partner@example.com' }, { name: '이영희', email: 'younghee.lee@example.com' },
  { name: '최 과장', email: 'choi@example.go.kr' },
];
// 데모 가용 시간: 남의 바쁜 시간은 이메일로 정해지는 가짜 값
const hashOf = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

// 반복 원본(recurrence 있음)은 읽을 때 회차로 펼친다. 회차 id = 원본id_시작(UTC), 회차를 고치면 따로 저장(예외),
// 「이 일정만」 지우면 원본 exdates 에 그 회차 시작을 넣는다(구글과 같은 모양).
const instId = (masterId, ts, allDay) => `${masterId}_${untilStr(ts, allDay)}`;
function expandMaster(m, all, from, to) {
  const dur = m.end - m.start;
  const moved = new Set(all.filter((x) => x.recurringEventId === m.id).map((x) => x.originalStart));
  const { recurrence, exdates, ...base } = m;
  void recurrence;
  return expand(ruleOf(m.recurrence), m.start, from - dur, to, { exdates: exdates || [] })
    .filter((ts) => !moved.has(ts) && ts + dur > from)
    .map((ts) => ({ ...base, id: instId(m.id, ts, m.allDay), start: ts, end: ts + dur, recurringEventId: m.id, originalStart: ts, recurring: true }));
}

export const demoStore = {
  kind: 'demo',
  async calendars() {
    const x = loadCals();
    return [...CALS, ...x.extra].filter((c) => !x.removed.includes(c.id))
      .map((c) => ({ defaultReminders: [10], owner: !c.readOnly, ...c, ...(x.colors[c.id] ? { color: x.colors[c.id] } : {}) }));
  },
  async events(cals, from, to) {
    const ids = new Set(cals.map((c) => c.id));
    const ro = new Set(CALS.filter((c) => c.readOnly).map((c) => c.id));
    const all = load();
    const out = [];
    for (const e of all) {
      if (!ids.has(e.calendarId)) continue;
      if (e.recurrence?.length) out.push(...expandMaster(e, all, from, to));
      else if (e.end > from && e.start < to) out.push({ ...e, ...(e.recurringEventId ? { recurring: true } : {}) });
    }
    return out.map((e) => ({ ...e, readOnly: ro.has(e.calendarId) }));
  },
  async get(calendarId, id) {
    const e = load().find((x) => x.id === id);
    return e ? { ...e, recurring: !!(e.recurrence || e.recurringEventId) } : null;
  },
  async create(e) {
    const evs = load();
    const { notify, addMeet, ...rest } = e;
    void notify;
    const ne = { ...rest, id: `u${Date.now().toString(36)}${evs.length}`, ...(addMeet ? { meet: 'https://meet.google.com/demo-meet-link' } : {}) };
    if (ne.recurrence?.length) ne.exdates = [];
    evs.push(ne);
    save(evs);
    return ne;
  },
  async update(e) {
    const evs = load();
    const { notify, addMeet, recurring, readOnly, ...rest } = e;
    void notify; void recurring; void readOnly;
    const ne = { ...rest, ...(addMeet && !e.meet ? { meet: 'https://meet.google.com/demo-meet-link' } : {}) };
    if (evs.some((x) => x.id === e.id)) save(evs.map((x) => (x.id === e.id ? ne : x)));
    else save([...evs, ne]); // 처음 고친 반복 회차 → 예외로 저장
    return { ...ne, ...(ne.recurringEventId || ne.recurrence ? { recurring: true } : {}) };
  },
  async remove(e) {
    let evs = load().filter((x) => x.id !== e.id);
    if (e.recurringEventId) {
      evs = evs.map((x) => (x.id === e.recurringEventId ? { ...x, exdates: [...(x.exdates || []), e.originalStart] } : x));
    } else {
      evs = evs.filter((x) => x.recurringEventId !== e.id); // 원본을 지우면 예외 회차도
    }
    save(evs);
  },
  async removeFollowing(e) {
    const evs = load();
    const m = evs.find((x) => x.id === e.recurringEventId);
    if (!m) return { deletedAll: true };
    const cut = e.originalStart ?? e.start;
    if (cut <= m.start) {
      save(evs.filter((x) => x.id !== m.id && x.recurringEventId !== m.id));
      return { deletedAll: true };
    }
    const prev = m.recurrence;
    save(evs.filter((x) => !(x.recurringEventId === m.id && x.originalStart >= cut))
      .map((x) => (x.id === m.id ? { ...x, recurrence: truncateBefore(prev, cut, m.allDay) } : x)));
    return { masterId: m.id, prev };
  },
  async setRecurrence(calendarId, masterId, recurrence) {
    save(load().map((x) => (x.id === masterId ? { ...x, recurrence } : x)));
  },
  async restoreInstance(e) {
    save(load().map((x) => (x.id === e.recurringEventId ? { ...x, exdates: (x.exdates || []).filter((t) => t !== e.originalStart) } : x)));
  },
  async respond(e, status) {
    const evs = load();
    const set = (x) => ({ ...x, attendees: (x.attendees || []).map((a) => (a.self ? { ...a, status } : a)) });
    if (evs.some((x) => x.id === e.id)) save(evs.map((x) => (x.id === e.id ? set(x) : x)));
  },
  async freeBusy(ids, from, to) {
    const out = {};
    const mine = (await this.events(CALS.filter((c) => !c.readOnly), from, to)).filter((e) => !e.free && !e.allDay);
    for (const id of ids) {
      if (id === 'primary' || id === DEMO_SELF) { out[id] = { busy: mine.map((e) => ({ start: e.start, end: e.end })) }; continue; }
      if (/nobody|private/.test(id)) { out[id] = { error: 'notFound' }; continue; }
      const h = hashOf(id);
      const busy = [];
      for (let d = startOfDay(from); d < to; d += DAY) {
        busy.push({ start: d + (10 + (h % 3)) * 3600e3, end: d + (11 + (h % 3)) * 3600e3 });
        busy.push({ start: d + (14 + (h % 4)) * 3600e3, end: d + (15.5 + (h % 4)) * 3600e3 });
      }
      out[id] = { busy };
    }
    return out;
  },
  async searchContacts(q) {
    const k = q.trim().toLowerCase();
    return DEMO_CONTACTS.filter((c) => c.name.toLowerCase().includes(k) || c.email.includes(k)).map((c) => ({ ...c }));
  },
  async uploadAttachment(file) {
    const id = `demo-${Date.now().toString(36)}`;
    return { fileUrl: `https://drive.google.com/file/d/${id}/view`, title: file.name, mimeType: file.type || 'application/octet-stream', fileId: id };
  },
  async setCalendarColor(id, hex) { const x = loadCals(); x.colors[id] = hex; saveCals(x); },
  async subscribeCalendar(id) {
    const x = loadCals();
    const c = { id, name: DEMO_PUBLIC[id] || id, color: '#0b8043', primary: false, readOnly: true, visible: true };
    x.removed = x.removed.filter((r) => r !== id);
    if (!CALS.some((k) => k.id === id) && !x.extra.some((k) => k.id === id)) x.extra.push(c);
    saveCals(x);
    return c;
  },
  async unsubscribeCalendar(id) {
    const x = loadCals();
    x.extra = x.extra.filter((k) => k.id !== id);
    if (CALS.some((k) => k.id === id)) x.removed.push(id);
    saveCals(x);
  },
  async createCalendar(name, hex) {
    const x = loadCals();
    const c = { id: `cal-${Date.now().toString(36)}`, name, color: hex || '#4f5bd5', primary: false, readOnly: false, visible: true };
    x.extra.push(c);
    saveCals(x);
    return { ...c, owner: true, defaultReminders: [] };
  },
};

/* ---------- 할 일 (데모) ---------- */
const KT = 'nanal.demo.tasks.v1';
const TLISTS = [{ id: 'tl-my', title: '내 할 일' }, { id: 'tl-home', title: '집안일' }];

function seedTasks(now) {
  const today = startOfDay(now);
  let n = 0;
  const t = (listId, title, dueOff, done = false, notes = '') => ({
    id: `t${++n}`, listId, title, notes, due: dueOff == null ? null : today + dueOff * DAY,
    done, completed: done ? now - 3600e3 : null, parent: null, position: String(n).padStart(8, '0'), link: '',
  });
  return [
    t('tl-my', '별첨 1 수치 확인', -2),
    t('tl-my', 'K-2 보고서 회신', 0, false, '국장님께 메일'),
    t('tl-my', '주간 회의 자료 출력', 0, true),
    t('tl-home', '관리비 납부', 1),
    t('tl-my', '건강검진 문진표 작성', 7),
    t('tl-home', '세탁소 맡긴 옷 찾기', null),
    t('tl-my', '읽을 책 목록 정리', null),
    t('tl-home', '분리수거', -1, true),
  ];
}
function loadTasks() {
  try {
    const s = JSON.parse(localStorage.getItem(KT) || 'null');
    if (s && Array.isArray(s.tasks)) return s.tasks;
  } catch { /* 무시 */ }
  const ts = seedTasks(Date.now());
  saveTasks(ts);
  return ts;
}
function saveTasks(tasks) { localStorage.setItem(KT, JSON.stringify({ tasks })); }

export const demoTasks = {
  kind: 'demo',
  async lists() { return TLISTS.map((l) => ({ ...l })); },
  async tasks() { return loadTasks(); },
  async create(t) {
    const ts = loadTasks();
    const nt = { ...t, id: `ut${Date.now().toString(36)}${ts.length}`, completed: t.done ? Date.now() : null };
    ts.push(nt);
    saveTasks(ts);
    return nt;
  },
  async update(t) {
    const nt = { ...t, completed: t.done ? (t.completed || Date.now()) : null };
    saveTasks(loadTasks().map((x) => (x.id === t.id ? nt : x)));
    return nt;
  },
  async remove(t) { saveTasks(loadTasks().filter((x) => x.id !== t.id)); },
};
