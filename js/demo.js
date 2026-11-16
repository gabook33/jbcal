// 데모 모드 저장소: 구글 연결 없이 예시 일정으로 화면을 확인한다.
// 추가·수정·삭제는 이 기기(localStorage)에만 저장된다.
import { P, T, DAY, startOfDay } from './time.js';

const K = 'nanal.demo.v1';

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
}

export const demoStore = {
  kind: 'demo',
  async calendars() {
    return CALS.map((c) => ({ ...c }));
  },
  async events(cals, from, to) {
    const ids = new Set(cals.map((c) => c.id));
    const ro = new Set(CALS.filter((c) => c.readOnly).map((c) => c.id));
    return load()
      .filter((e) => ids.has(e.calendarId) && e.end > from && e.start < to)
      .map((e) => ({ ...e, readOnly: ro.has(e.calendarId) }));
  },
  async create(e) {
    const evs = load();
    const ne = { ...e, id: `u${Date.now().toString(36)}` };
    evs.push(ne);
    save(evs);
    return ne;
  },
  async update(e) {
    const evs = load().map((x) => (x.id === e.id ? { ...e } : x));
    save(evs);
    return e;
  },
  async remove(e) {
    save(load().filter((x) => x.id !== e.id));
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
