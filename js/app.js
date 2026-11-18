import { CONFIG } from '../config.js';
import {
  P, T, DAY, WD, startOfDay, startOfWeek, startOfMonth, addMonths, dayKey, fromDayKey,
  fmtTime, fmtHourLabel, fmtDate, fmtDayHeading, hm, fromInputs, sameDay,
} from './time.js';
import { parseQuick } from './nlp.js';
import { demoStore, demoTasks, resetDemo } from './demo.js';
import {
  googleStore, getToken, wasLinked, beginLogin, consumeRedirect, logout, AuthError, EVENT_COLORS,
  googleTasks, hasTasksScope, ScopeError, ApiDisabledError,
} from './gcal.js';
import { tasksForDay, groupTasks } from './tasks.js';
import { ruleOf, buildRRule, describeRule, presetRule, presetOf, REPEAT_OPTIONS } from './recur.js';

/* ---------- 준비 ---------- */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HH = 52; // 시간 한 칸 높이(px)
const mq = matchMedia('(max-width: 760px)');
const params = new URLSearchParams(location.search);
const K_VIEW = 'nanal.view';
const K_HIDDEN = 'nanal.hiddenCals';
const K_MODE = 'nanal.mode';
const K_TK = 'nanal.tickerOpen';
const K_WS = 'nanal.weekStart'; // 데스크톱 주 시작 요일: '1' 월요일(기본) / '0' 일요일
const K_HIDEV = 'nanal.hiddenEvents'; // 오른쪽 클릭 「숨기기」로 이 기기에서만 감춘 일정
const K_SBTAB = 'nanal.sbTab'; // 데스크톱 왼쪽 목록: 'ev' 날짜별 일정(기본) / 'tasks' 할 일
const K_TLIST = 'nanal.taskList'; // 새 할 일을 넣을 목록(마지막에 고른 것)
const K_ASK = 'nanal.tasksAskLater'; // 할 일 권한 안내 띠에서 「나중에」를 눌렀음
const K_CALCOL = 'nanal.calColors'; // 캘린더 색(이 기기에서만 바꾼 색)
const K_SETS = 'nanal.calSets'; // 캘린더 묶음 [{name, hidden:[…]}]
const K_DEFCAL = 'nanal.defCal'; // 새 일정 기본 캘린더
const K_DUR = 'nanal.defDur'; // 새 일정 기본 길이(분)
const K_WKNUM = 'nanal.weekNum'; // 월 보기 주 번호
const K_TPL = 'nanal.templates'; // 일정 템플릿
const jget = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const TASKS_KEY = '__tasks'; // 캘린더 켜기·끄기 목록에서 「할 일」 줄(S.hidden 에 같이 저장)

if (params.has('reset-demo')) resetDemo();
if (params.get('demo') === '1') localStorage.setItem(K_MODE, 'demo');
if (params.get('demo') === '0') localStorage.removeItem(K_MODE);

const redirect = consumeRedirect();
const useGoogle = !!CONFIG.clientId && localStorage.getItem(K_MODE) !== 'demo';

const S = {
  store: useGoogle ? googleStore : demoStore,
  cals: [],
  hidden: new Set(JSON.parse(localStorage.getItem(K_HIDDEN) || '[]')),
  events: [],
  loaded: null, // {from, to, at}
  view: params.get('view') || localStorage.getItem(K_VIEW) || (mq.matches ? 'list' : 'week'),
  cursor: params.get('date') ? fromDayKey(params.get('date')) : startOfDay(Date.now()),
  miniMonth: null,
  needsLogin: false,
  tickerOpen: localStorage.getItem(K_TK) !== '0', // 휴대폰 위 달력: 한 달(기본) / 한 주로 접힘
  listFrom: null, // 연속 목록이 시작하는 날
  listDays: 0,
  jump: true, // 다음 렌더링 때 목록·월 보기를 S.cursor 날짜로 스크롤
  mvFrom: null, // 월 보기 연속 스크롤이 시작하는 주(일요일)
  mvWeeks: 0,
  mcFrom: null, // 미니 달력 연속 스크롤이 시작하는 주
  mcWeeks: 0,
  selDay: null, // 사용자가 눌러 고른 날(0시). 빠른 입력에 날짜 말이 없으면 이 날에 넣는다. null 이면 오늘
  weekStart: localStorage.getItem(K_WS) === '0' ? 0 : 1,
  hiddenEv: new Set(JSON.parse(localStorage.getItem(K_HIDEV) || '[]')),
  picked: null, // 오른쪽 클릭으로 고른 일정 id(채운 칩으로 표시)
  clip: null, // 복사·잘라내기한 일정 {e, cut}
  // 할 일(Google Tasks)
  tStore: useGoogle ? googleTasks : demoTasks,
  tasks: [],
  taskLists: [],
  tasksState: 'idle', // idle | ok | need-scope(권한 다시 동의) | disabled(Tasks API 꺼짐) | error
  tasksAt: 0,
  tasksErr: '',
  showDone: false,
  sbTab: localStorage.getItem(K_SBTAB) === 'tasks' ? 'tasks' : 'ev',
  calColors: jget(K_CALCOL, {}),
  sets: jget(K_SETS, []),
  defDur: +(localStorage.getItem(K_DUR) || 60),
  weekNum: localStorage.getItem(K_WKNUM) === '1',
  templates: jget(K_TPL, []),
};
// 옛 「목록」 보기 값은 데스크톱에서 월 보기로(목록은 L 키로 계속 쓸 수 있다)

S.miniMonth = startOfMonth(S.cursor);

document.title = CONFIG.appName;
$('#appName').textContent = CONFIG.appName;

/* ---------- 데이터 ---------- */

const calById = (id) => S.cals.find((c) => c.id === id);
const colorOf = (e) => e.color || calById(e.calendarId)?.color || '#888';
const writableCals = () => S.cals.filter((c) => !c.readOnly);
const defaultCal = () => writableCals().find((c) => c.id === localStorage.getItem(K_DEFCAL))
  || writableCals().find((c) => c.primary) || writableCals()[0];
/** 캘린더 목록을 받으면 이 기기에서 바꾼 색을 입힌다(구글 쪽 색은 그대로) */
function paintCals() {
  S.cals.forEach((c) => { c.origColor ??= c.color; c.color = S.calColors[c.id] || c.origColor; });
}
const isHoliday = (e) => e.calendarId === 'holiday' || /holiday/.test(e.calendarId);

/** 휴대폰에서는 월 보기를 위 날짜 줄(펼친 달력)이 대신하므로 목록으로 보여 준다 */
const effView = () => (mq.matches && ['month', 'quarter', 'year'].includes(S.view) ? 'list' : S.view);

/** 연속 목록 범위를 S.cursor 근처로 다시 잡는다(범위를 벗어났을 때만) */
function anchorList() {
  const c = startOfDay(S.cursor);
  const end = S.listFrom + S.listDays * DAY;
  if (S.listFrom == null || c < S.listFrom || c > end - 30 * DAY) {
    S.listFrom = startOfWeek(c) - 14 * DAY;
    S.listDays = 84;
  }
}

const WEEK = 7 * DAY;
/** 주 시작 요일: 데스크톱은 설정(기본 월요일), 휴대폰은 늘 일요일 */
const wsDay = () => (mq.matches ? 0 : S.weekStart);
/** 그 날이 속한 주의 첫날(0시) */
const sow = (ts) => { const s0 = startOfDay(ts); return s0 - ((P(s0).dow - wsDay() + 7) % 7) * DAY; };
/** 요일 순서(0=일) */
const wdOrder = () => Array.from({ length: 7 }, (_, i) => (i + wsDay()) % 7);
const startOfQuarter = (ts) => { const p = P(ts); return T(p.y, p.m - (p.m % 3), 1); };
const startOfYear = (ts) => T(P(ts).y, 0, 1);
// 미니 달력이 지금 스크롤로 보여 주는 달. S.miniMonth 와 같으면 다시 그려도 스크롤 위치를 지킨다.
let miniShown = null;
const weeksTo = (from, to) => Math.round((sow(to) - from) / WEEK) + 1;

/** 월 보기 연속 스크롤 범위. 스크롤 중에는 onMonthScroll 이 늘리고,
 *  날짜로 바로 갈 때(S.jump)만 그 달 앞뒤로 여유가 없으면 다시 잡는다 */
function anchorMonthView() {
  const m = startOfMonth(S.cursor);
  const first = sow(m);
  const end = S.mvFrom + S.mvWeeks * WEEK;
  if (S.mvFrom == null || (S.jump && (first < S.mvFrom + 4 * WEEK || first + 10 * WEEK > end))) {
    S.mvFrom = sow(addMonths(m, -3));
    S.mvWeeks = weeksTo(S.mvFrom, addMonths(m, 5));
  }
}

/** 미니 달력 연속 스크롤 범위. 사용자가 미니 달력을 스크롤하는 중(miniShown === S.miniMonth)에는 그대로 둔다 */
function anchorMini() {
  const first = sow(S.miniMonth);
  const end = S.mcFrom + S.mcWeeks * WEEK;
  if (S.mcFrom == null
    || (miniShown !== S.miniMonth && (first < S.mcFrom + 2 * WEEK || first + 8 * WEEK > end))) {
    S.mcFrom = sow(addMonths(S.miniMonth, -3));
    S.mcWeeks = weeksTo(S.mcFrom, addMonths(S.miniMonth, 4));
  }
}

function viewRange(view = effView(), cursor = S.cursor) {
  if (view === 'day') return [startOfDay(cursor), startOfDay(cursor) + DAY];
  if (view === 'week') {
    const start = mq.matches ? startOfDay(cursor) : sow(cursor);
    return [start, start + (mq.matches ? 3 : 7) * DAY];
  }
  if (view === 'month') {
    anchorMonthView();
    return [S.mvFrom, S.mvFrom + S.mvWeeks * WEEK];
  }
  if (view === 'quarter') {
    const q = startOfQuarter(cursor);
    return [sow(q), sow(addMonths(q, 3)) + WEEK];
  }
  if (view === 'year') {
    const y = startOfYear(cursor);
    return [sow(y), sow(addMonths(y, 12)) + WEEK];
  }
  anchorList();
  return [S.listFrom, S.listFrom + S.listDays * DAY]; // list
}

async function ensureEvents(force = false) {
  const today = startOfDay(Date.now());
  const [vs, ve] = viewRange();
  anchorMini();
  const cm = sow(startOfMonth(S.cursor));
  const ms = Math.min(S.mcFrom, cm);
  const me = Math.max(S.mcFrom + S.mcWeeks * WEEK, cm + 42 * DAY);
  const from = Math.min(vs, ms, today);
  const to = Math.max(ve, me, today + 15 * DAY, (S.selDay ?? today) + 22 * DAY);
  const L = S.loaded;
  if (!force && L && L.from <= from && L.to >= to) return;
  const f = addMonths(startOfMonth(from), -1);
  const t = addMonths(startOfMonth(to), 2);
  try {
    if (!S.cals.length) { S.cals = await S.store.calendars(); paintCals(); }
    S.events = await S.store.events(S.cals, f, t);
    S.loaded = { from: f, to: t, at: Date.now() };
    hideBanner();
  } catch (err) {
    handleError(err);
  }
}

function visibleEvents(from, to) {
  return S.events
    .filter((e) => !S.hidden.has(e.calendarId) && !S.hiddenEv.has(e.id) && e.end > from && e.start < to)
    .sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start) || (b.end - a.end));
}

/* ---------- 할 일 (Google Tasks) 데이터 ---------- */

/** 할 일 불러오기. 권한이 없거나(이전에 연결한 기기) Tasks API 가 꺼져 있으면 상태만 바꾸고 일정 화면은 그대로 둔다 */
async function ensureTasks(force = false) {
  if (S.needsLogin) return;
  if (useGoogle && !hasTasksScope()) { S.tasksState = 'need-scope'; return; }
  if (!force && S.tasksAt && (S.tasksState === 'ok' || Date.now() - S.tasksAt < 60e3)) return;
  S.tasksAt = Date.now();
  try {
    const lists = await S.tStore.lists();
    const tasks = await S.tStore.tasks(lists);
    S.taskLists = lists;
    S.tasks = tasks;
    S.tasksState = 'ok';
  } catch (err) {
    if (err instanceof ScopeError) S.tasksState = 'need-scope';
    else if (err instanceof ApiDisabledError) S.tasksState = 'disabled';
    else if (!(err instanceof AuthError) && S.tasksState !== 'ok') { S.tasksState = 'error'; S.tasksErr = err.message || ''; }
    console.warn('할 일:', err.message);
  }
}
/** 할 일 색: 기본 캘린더 색(구글 할 일에는 색이 없다) */
const taskColor = () => defaultCal()?.color || '#3a87f2';
const tasksShown = () => S.tasksState === 'ok' && !S.hidden.has(TASKS_KEY);
/** 날짜별 목록에 넣을 그날 할 일(오늘 칸에는 마감 지난 것 포함) */
const dayTasks = (d, today = startOfDay(Date.now())) => (tasksShown() ? tasksForDay(S.tasks, d, today) : []);

function handleError(err) {
  console.error(err);
  if (err instanceof AuthError) {
    S.loaded = null;
    showBanner(`${err.message}. <button class="btn small" data-act="login">다시 연결</button>`);
  } else {
    showBanner(esc(err.message || '일정을 불러오지 못했습니다'));
  }
}

/* ---------- 렌더링 ---------- */

let renderSeq = 0;
async function render({ refetch = false } = {}) {
  const seq = ++renderSeq;
  document.body.classList.toggle('needs-login', S.needsLogin);
  if (S.needsLogin) { renderWelcome(); renderChrome(); return; }
  await Promise.all([ensureEvents(refetch), ensureTasks(refetch)]);
  if (seq !== renderSeq) return;
  renderChrome();
  renderMini();
  renderTicker();
  renderUpcoming();
  renderCals();
  renderView();
  renderTasks();
  syncAsk();
  if (document.body.classList.contains('search-open')) runSearch();
  S.jump = false;
}

function renderChrome() {
  const view = effView();
  document.querySelectorAll('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
  const mv = $('#mViewBtn');
  mv.classList.toggle('on', view !== 'list');
  mv.setAttribute('aria-label', view === 'list' ? '3일 보기로 전환' : '목록 보기로 전환');
  const [vs, ve] = viewRange();
  const a = P(vs);
  const b = P(ve - 1);
  let title;
  if (view === 'day') title = `${a.m + 1}월 ${a.d}일 ${WD[a.dow]}요일`;
  else if (view === 'month' || view === 'list') { const c = P(S.cursor); title = `${c.y}년 ${c.m + 1}월`; }
  else if (view === 'quarter') { const c = P(S.cursor); title = `${c.y}년 ${Math.floor(c.m / 3) + 1}분기`; }
  else if (view === 'year') title = `${P(S.cursor).y}년`;
  else if (a.m === b.m) title = `${a.y}년 ${a.m + 1}월`;
  else title = `${a.y}년 ${a.m + 1}월 – ${a.y !== b.y ? `${b.y}년 ` : ''}${b.m + 1}월`;
  $('#title').textContent = title;

  const badge = $('#modeBadge');
  const btn = $('#authBtn');
  if (!useGoogle) {
    badge.hidden = false;
    badge.textContent = '데모';
    btn.textContent = '구글 연결';
    btn.dataset.act = 'connect';
  } else if (getToken()) {
    badge.hidden = true;
    btn.textContent = '연결 해제';
    btn.dataset.act = 'logout';
  } else {
    badge.hidden = true;
    btn.textContent = '구글 연결';
    btn.dataset.act = 'login';
  }
}

/** 왼쪽 큰 제목: 「2026년」(빨강) 「11월」(굵은 흰색) */
const bigTitle = (m) => { const p = P(m); return `<span class="y">${p.y}년</span> <b>${p.m + 1}월</b>`; };

function miniHTML() {
  anchorMini();
  const mp = P(S.miniMonth);
  const today = startOfDay(Date.now());
  const sel = S.selDay;
  const band = sow(S.selDay ?? S.cursor); // 고른 날(없으면 보는 날)이 든 주에 회색 띠
  const [vs, ve] = viewRange();
  const view = effView();
  let rows = '';
  for (let w = 0; w < S.mcWeeks; w++) {
    const ws = S.mcFrom + w * WEEK;
    let cells = '';
    for (let i = 0; i < 7; i++) {
      const d = ws + i * DAY;
      const p = P(d);
      const evs = visibleEvents(d, d + DAY);
      const dots = evs.slice(0, 3).map((e) => `<i style="background:${colorOf(e)}"></i>`).join('');
      const cls = [
        'mc-day',
        (p.m !== mp.m || p.y !== mp.y) && 'other',
        d === today && 'today',
        d === sel && 'sel',
        d >= vs && d < ve && (view === 'week' || view === 'day') && 'inrange',
      ].filter(Boolean).join(' ');
      cells += `<button class="${cls}" data-day="${dayKey(d)}"><span>${p.d}</span><b>${dots}</b></button>`;
    }
    rows += `<div class="mc-week${ws === band ? ' cur' : ''}" data-date="${dayKey(ws)}">${cells}</div>`;
  }
  return `
    <div class="mc-head">
      <h2 class="mc-title" id="mcTitle">${bigTitle(S.miniMonth)}</h2>
      <span class="mc-arrows">
        <button class="icon-btn sm" data-mini="-1" aria-label="이전 달"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button class="icon-btn sm" data-mini="1" aria-label="다음 달"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </span>
    </div>
    <div class="mc-grid">${wdOrder().map((i) => `<span class="mc-wd">${WD[i]}</span>`).join('')}</div>
    <div class="mc-scroll">${rows}</div>`;
}

function renderMini() {
  const box = $('#mini');
  const prev = box.querySelector('.mc-scroll');
  const keep = prev && miniShown === S.miniMonth && prev.getClientRects().length
    ? topDay(prev, '.mc-week') : null;
  box.innerHTML = miniHTML();
  const c = box.querySelector('.mc-scroll');
  if (!keep || !scrollToDay(c, keep.key, keep.off, '.mc-week')) scrollToDay(c, dayKey(sow(S.miniMonth)), 0, '.mc-week');
  miniShown = S.miniMonth;
  c.addEventListener('scroll', onMiniScroll, { passive: true });
}

/** 스크롤 상자 한가운데 줄의 수요일이 속한 달 = 지금 보이는 달 */
function centerMonth(c) {
  const row = c.firstElementChild;
  if (!row || !c.isConnected || !row.offsetHeight) return null;
  const idx = Math.floor((c.scrollTop + c.clientHeight / 2) / row.offsetHeight);
  const r = c.children[Math.min(Math.max(idx, 0), c.children.length - 1)];
  return startOfMonth(fromDayKey(r.dataset.date) + 3 * DAY);
}
/** 보이는 달이 아닌 날짜는 흐리게 */
function markMonth(c, m, sel) {
  const mk = dayKey(m).slice(0, 7);
  c.querySelectorAll(sel).forEach((el) => el.classList.toggle('other', el.dataset.day.slice(0, 7) !== mk));
}

let miniTick = 0;
let miniExtending = false;
function onMiniScroll(ev) {
  const c = ev.currentTarget;
  if (miniTick) return;
  miniTick = requestAnimationFrame(() => {
    miniTick = 0;
    if (!c.isConnected) return; // 그사이 다시 그려진 옛 상자
    const m = centerMonth(c);
    if (m != null && m !== S.miniMonth) {
      S.miniMonth = m;
      miniShown = m;
      $('#mcTitle').innerHTML = bigTitle(m);
      markMonth(c, m, '.mc-day');
    }
    if (miniExtending) return;
    const rh = c.firstElementChild?.offsetHeight || 36;
    // 끝에 가까워지면 석 달씩 더 붙이고, 너무 길어지면 반대쪽을 덜어 낸다
    if (c.scrollHeight - c.scrollTop - c.clientHeight < 4 * rh) {
      S.mcWeeks += 13;
      if (S.mcWeeks > 52) { S.mcFrom += 13 * WEEK; S.mcWeeks -= 13; }
    } else if (c.scrollTop < 4 * rh) {
      S.mcFrom -= 13 * WEEK;
      S.mcWeeks = Math.min(S.mcWeeks + 13, 52);
    } else return;
    miniExtending = true;
    render().finally(() => { miniExtending = false; });
  });
}

/** 미니 달력 ‹ › : 이웃 달 첫 주로 부드럽게 스크롤 */
function miniStep(dir) {
  const c = $('#mini .mc-scroll');
  const target = addMonths(S.miniMonth, dir);
  const row = c?.querySelector(`.mc-week[data-date="${dayKey(sow(target))}"]`);
  if (!row || !c.getClientRects().length) { S.miniMonth = target; render(); return; }
  c.scrollTo({ top: row.offsetTop, behavior: 'smooth' });
}

/* ---------- 휴대폰 위 달력 (기본은 한 달 여섯 주, 손잡이로 고른 주 한 줄까지 접힘) ---------- */

const tickerMonth = () => (S.tickerOpen ? S.miniMonth : startOfMonth(S.cursor));
const TK_WEEKS = 6; // 달마다 높이가 바뀌지 않게 늘 여섯 주

function renderTicker() {
  const el = $('#ticker');
  const m = tickerMonth();
  const mp = P(m);
  const gs = sow(m);
  const today = startOfDay(Date.now());
  const tdow = P(today).dow;
  const sel = startOfDay(S.cursor);
  let rows = '';
  for (let w = 0; w < TK_WEEKS; w++) {
    let cells = '';
    for (let i = 0; i < 7; i++) {
      const d = gs + (w * 7 + i) * DAY;
      const p = P(d);
      const evs = visibleEvents(d, d + DAY);
      // 일정 하나에 점 하나(캘린더 색), 그날 마감인 안 끝낸 할 일도 점 하나씩, 최대 넷
      const tks = tasksShown() ? S.tasks.filter((t) => t.due === d && !t.done) : [];
      const dots = [...evs.map(colorOf), ...tks.map(taskColor)].slice(0, 4).map((c) => `<i style="background:${c}"></i>`).join('');
      const cls = [
        'tk-day',
        p.m !== mp.m && 'other',
        d === today && 'today',
        d === sel && 'sel',
        (i === 0 || i === 6) && 'wkend',
      ].filter(Boolean).join(' ');
      cells += `<button class="${cls}" data-day="${dayKey(d)}" aria-label="${p.m + 1}월 ${p.d}일${evs.length ? `, 일정 ${evs.length}개` : ''}"><span class="n">${p.d}</span><b>${dots}</b></button>`;
    }
    rows += `<div class="tk-row${d0InWeek(sel, gs + w * 7 * DAY) ? ' cur' : ''}">${cells}</div>`;
  }
  const selRow = Math.min(Math.max(Math.floor((sow(sel) - gs) / (7 * DAY)), 0), TK_WEEKS - 1);
  el.innerHTML = `
    <div class="tk-wd">${WD.map((w, i) => `<span class="${[(i === 0 || i === 6) && 'wkend', i === tdow && 'tdow'].filter(Boolean).join(' ')}">${w}</span>`).join('')}</div>
    <div class="tk-clip"><div class="tk-grid">${rows}</div></div>
    <button class="tk-grab" id="tkGrab" aria-label="${S.tickerOpen ? '달력 접기' : '달력 펼치기'}"><i></i></button>`;
  el.style.setProperty('--weeks', TK_WEEKS);
  el.style.setProperty('--row', selRow);
  el.classList.toggle('expanded', S.tickerOpen);
  syncTickerHead();
}
function d0InWeek(day, weekStart) { return day >= weekStart && day < weekStart + 7 * DAY; }

function syncTickerHead() {
  const mp = P(tickerMonth());
  $('#mTitle').innerHTML = `<span class="y">${mp.y}년</span> <b>${mp.m + 1}월</b>`;
}

function toggleTicker(open = !S.tickerOpen) {
  if (open === S.tickerOpen) return;
  const el = $('#ticker');
  if (open) {
    S.miniMonth = startOfMonth(S.cursor);
    S.tickerOpen = true;
  } else {
    // 다른 달로 넘겨 본 상태면 선택한 날의 달로 먼저 바꾼 뒤 접는다
    if (S.miniMonth !== startOfMonth(S.cursor)) {
      S.miniMonth = startOfMonth(S.cursor);
      renderTicker();
      void el.offsetHeight;
    }
    S.tickerOpen = false;
  }
  localStorage.setItem(K_TK, S.tickerOpen ? '1' : '0');
  el.classList.toggle('expanded', S.tickerOpen);
  el.querySelector('#tkGrab')?.setAttribute('aria-label', S.tickerOpen ? '달력 접기' : '달력 펼치기');
  syncTickerHead();
}

/** 달력 좌우 이동: 펼친 상태는 한 달, 접힌 상태는 한 주 */
function tickerStep(dir) {
  if (S.tickerOpen) {
    S.miniMonth = addMonths(S.miniMonth, dir);
  } else {
    S.cursor = startOfDay(S.cursor) + dir * 7 * DAY;
    S.miniMonth = startOfMonth(S.cursor);
    S.jump = true;
  }
  render();
}

/* 데스크톱 왼쪽 어두운 일정 목록: 고른 날(없으면 오늘)부터 3주, 일정 있는 날만.
   머리 「금요일 11/13」 + 날씨, 종일 = 색 이름표, 시간 일정 = 점 + 시간 + 제목, 지금·다음 일정은 색을 채운 막대 */
function renderUpcoming() {
  if (mq.matches) { $('#upcoming').innerHTML = ''; return; }
  const now = Date.now();
  const today = startOfDay(now);
  const from = S.selDay ?? today;
  const days = 21;
  const all = visibleEvents(from, from + days * DAY);
  const hl = all.find((e) => !e.allDay && e.end > now && e.start < from + days * DAY)?.id;
  let html = '';
  for (let i = 0; i < days; i++) {
    const d = from + i * DAY;
    const p = P(d);
    const evs = visibleEvents(d, d + DAY);
    const tks = dayTasks(d, today);
    if (!evs.length && !tks.length && i) continue;
    const name = d === today ? '오늘' : d === today + DAY ? '내일' : `${WD[p.dow]}요일`;
    html += `<div class="ag-day sa-day${d === today ? ' today' : ''}" data-date="${dayKey(d)}">
      <h3 class="sa-h"><span><b>${name}</b> ${p.m + 1}/${p.d}</span>${wxHTML(d)}</h3>`;
    if (!evs.length && !tks.length) html += '<div class="ag-empty">일정 없음</div>';
    const ads = evs.filter((e) => e.allDay);
    if (ads.length) html += `<div class="sa-ads">${ads.map((e) => `<button class="ag-ev sa-ad" data-id="${esc(e.id)}" style="--c:${colorOf(e)}"${tipAttr(evTip(e))}>${esc(e.title)}</button>`).join('')}</div>`;
    html += tks.map((t) => taskRowHTML(t, 'sa-task', today)).join('');
    for (const e of evs) {
      if (e.allDay) continue;
      const cls = ['ag-ev', 'sa-ev', e.id === hl && 'hl', e.end < now && 'past'].filter(Boolean).join(' ');
      html += `<button class="${cls}" data-id="${esc(e.id)}" style="--c:${colorOf(e)}"${tipAttr(evTip(e))}>
        <i></i><span class="sa-t">${mTimeRange(e, d)}</span><span class="sa-title">${esc(e.title)}</span>
      </button>`;
    }
    html += '</div>';
  }
  $('#upcoming').innerHTML = html;
}

/* ---------- 날짜별 연속 목록 (휴대폰 기본 화면 · 데스크톱 목록 보기) ---------- */

function listHTML(from, days) {
  if (mq.matches) return mListHTML(from, days);
  const now = Date.now();
  const today = startOfDay(now);
  let html = '';
  for (let i = 0; i < days; i++) {
    const d = from + i * DAY;
    const p = P(d);
    const evs = visibleEvents(d, d + DAY);
    const holiday = evs.some(isHoliday);
    const cls = ['ag-day', d === today && 'today', d < today && 'before',
      (p.dow === 0 || holiday) && 'sun', p.dow === 6 && 'sat'].filter(Boolean).join(' ');
    const head = esc(fmtDayHeading(d, now)).replace(/^(오늘|내일|어제) · /, '<b>$1</b>');
    html += `<section class="${cls}" data-date="${dayKey(d)}"><h3 class="ag-h">${head}</h3>`;
    const tks = dayTasks(d, today);
    if (!evs.length && !tks.length) html += '<div class="ag-empty">일정 없음</div>';
    html += tks.map((t) => taskRowHTML(t, 'ag-task', today)).join('');
    let nowShown = d !== today;
    for (const e of evs) {
      if (!nowShown && !e.allDay && e.start > now) { html += nowLineHTML(now); nowShown = true; }
      const time = e.allDay
        ? '<span class="ag-t1">종일</span>'
        : `<span class="ag-t1">${e.start < d ? '…' : fmtTime(e.start)}</span><small>${e.end > d + DAY ? '…' : fmtTime(e.end)}</small>`;
      const past = !e.allDay && e.end < now ? ' past' : '';
      html += `<button class="ag-ev${past}${e.allDay ? ' allday' : ''}" data-id="${esc(e.id)}" style="--c:${colorOf(e)}"${tipAttr(evTip(e))}>
        <span class="ag-time">${time}</span>
        <span class="ag-bar"></span>
        <span class="ag-body"><span class="ag-title">${esc(e.title)}</span>${e.location ? `<span class="ag-loc">${esc(e.location)}</span>` : ''}</span>
      </button>`;
    }
    if (!nowShown) html += nowLineHTML(now);
    html += '</section>';
  }
  return html;
}

/* 휴대폰 목록(어두운 바탕): 일정 있는 날만 + 오늘·고른 날.
   「금요일 2026. 11. 13.」 머리, 시간 일정은 점 + 「3:30 – 오후 4:30」 + 제목 + 장소, 종일 일정은 색 이름표 */
const ampm = (ts) => (P(ts).h < 12 ? '오전' : '오후');
function mTimeRange(e, d) {
  const s = e.start < d ? null : e.start;
  const en = e.end > d + DAY ? null : e.end;
  if (s == null && en == null) return '하루 종일';
  if (s == null) return `… – ${fmtTime(en)}`;
  if (en == null) return `${fmtTime(s)} – …`;
  // 오전/오후가 같으면 앞 시각의 오전/오후는 뺀다
  return `${ampm(s) === ampm(en) ? fmtTime(s).replace(/^오[전후] /, '') : fmtTime(s)} – ${fmtTime(en)}`;
}
function mEventsHTML(evs, d, now, tasks = []) {
  const ads = evs.filter((e) => e.allDay);
  let html = ads.length ? `<div class="m-ads">${ads.map((e) => `<button class="ag-ev m-allday" data-id="${esc(e.id)}" style="--c:${colorOf(e)}"${tipAttr(evTip(e))}><span class="ag-title">${esc(e.title)}</span></button>`).join('')}</div>` : '';
  // 할 일: 종일 이름표 다음, 시간 일정 앞에 체크 상자 모양으로
  html += tasks.map((t) => taskRowHTML(t, 'm-task', startOfDay(now))).join('');
  for (const e of evs) {
    if (e.allDay) continue;
    const past = e.end < now ? ' past' : '';
    html += `<button class="ag-ev m-ev${past}" data-id="${esc(e.id)}" style="--c:${colorOf(e)}"${tipAttr(evTip(e))}>
      <i class="m-dot"></i><span class="m-time">${mTimeRange(e, d)}</span>
      <span class="ag-title">${esc(e.title)}${badges(e)}</span>${e.location ? `<span class="ag-loc">${esc(e.location)}</span>` : ''}
    </button>`;
  }
  return html;
}
/** 제목 뒤 작은 표시: 반복(↻), 참석자(👥), 화상회의 「참가」 */
function badges(e) {
  return `${e.recurring ? '<span class="bdg" title="반복 일정" aria-label="반복">↻</span>' : ''}${e.attendees?.length ? `<span class="bdg" title="참석자 ${e.attendees.length}명" aria-label="참석자">👥</span>` : ''}${e.meet ? `<span class="bdg join" role="link" data-join="${esc(e.meet)}" aria-label="화상회의 참가">참가</span>` : ''}`;
}
const mDayLabel = (d, today) => {
  const p = P(d);
  return `<b>${d === today ? '오늘' : `${WD[p.dow]}요일`}</b> ${p.y}. ${p.m + 1}. ${p.d}.`;
};
function mListHTML(from, days) {
  const now = Date.now();
  const today = startOfDay(now);
  const keep = new Set([today, S.selDay, startOfDay(S.cursor)]);
  let html = '';
  for (let i = 0; i < days; i++) {
    const d = from + i * DAY;
    const evs = visibleEvents(d, d + DAY);
    const tks = dayTasks(d, today);
    if (!evs.length && !tks.length && !keep.has(d)) continue;
    const cls = ['ag-day', 'm-day', d === today && 'today', d < today && 'before'].filter(Boolean).join(' ');
    html += `<section class="${cls}" data-date="${dayKey(d)}"><h3 class="ag-h">${mDayLabel(d, today)}${wxHTML(d)}</h3>`;
    html += evs.length || tks.length ? mEventsHTML(evs, d, now, tks) : '<div class="ag-empty">일정 없음</div>';
    html += '</section>';
  }
  return html;
}

/* ---------- 날씨 (Open-Meteo: 키 없이 쓰는 공개 예보. 위치는 config.js weather, 없으면 대구) ---------- */
const WX = CONFIG.weather === false ? null : { lat: 35.85, lon: 128.58, ...(CONFIG.weather || {}) };
const K_WX = 'nanal.wx.v1';
let wxData = params.has('nowx') ? null : (() => { try { return JSON.parse(localStorage.getItem(K_WX)); } catch { return null; } })();
let wxBusy = false;
async function loadWeather() {
  if (!WX || wxBusy || params.has('nowx')) return;
  if (wxData && Date.now() - wxData.at < 3 * 3600e3 && wxData.lat === WX.lat && wxData.lon === WX.lon) return;
  wxBusy = true;
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${WX.lat}&longitude=${WX.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Asia%2FSeoul&forecast_days=10`;
    const r = await fetch(u);
    if (!r.ok) return;
    const j = await r.json();
    const days = {};
    j.daily.time.forEach((k, i) => { days[k] = [Math.round(j.daily.temperature_2m_max[i]), Math.round(j.daily.temperature_2m_min[i]), j.daily.weather_code[i]]; });
    wxData = { at: Date.now(), lat: WX.lat, lon: WX.lon, days };
    localStorage.setItem(K_WX, JSON.stringify(wxData));
    document.querySelectorAll('.m-day[data-date] > .ag-h').forEach((h) => {
      h.querySelector('.m-wx')?.remove();
      h.insertAdjacentHTML('beforeend', wxHTML(fromDayKey(h.parentElement.dataset.date)));
    });
    if (!mq.matches && !S.needsLogin) render(); // 데스크톱: 왼쪽 목록 머리·월 칸에 날씨
  } catch { /* 날씨는 없어도 된다 */ } finally { wxBusy = false; }
}
function wxIcon(code) {
  if (code === 0) return '☀️';
  if (code <= 2) return '⛅';
  if (code === 3 || code === 45 || code === 48) return '☁️';
  if (code >= 95) return '⛈️';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '🌨️';
  if (code >= 51) return '🌧️';
  return '☁️';
}
function wxHTML(d) {
  const w = wxData?.days?.[dayKey(d)];
  if (!w || d < startOfDay(Date.now())) return '';
  return `<span class="m-wx" aria-label="최고 ${w[0]}도 최저 ${w[1]}도"><b>${w[0]}°</b>/${w[1]}° <i>${wxIcon(w[2])}</i></span>`;
}

const nowLineHTML = (now) => `<div class="ag-now"><span>${fmtTime(now)}</span></div>`;

/** 목록 맨 위에 보이는 날과 그 날의 화면상 위치 */
function topDay(c, sel = '.ag-day') {
  const top = c.getBoundingClientRect().top;
  for (const el of c.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top + 2) return { key: el.dataset.date, off: r.top - top };
  }
  return null;
}
function scrollToDay(c, key, off = 0, sel = '.ag-day') {
  const el = c.querySelector(`${sel}[data-date="${key}"]`);
  if (el) c.scrollTop += el.getBoundingClientRect().top - c.getBoundingClientRect().top - off;
  return !!el;
}

let listTick = 0;
let listStale = false;
let extending = false;
function onListScroll(ev) {
  const c = ev.currentTarget;
  if (listTick) return;
  listTick = requestAnimationFrame(() => {
    listTick = 0;
    // 목록을 넘기면 위 날짜 줄·미니 달력도 맨 위 날짜를 따라간다
    const t = topDay(c);
    if (t && fromDayKey(t.key) !== startOfDay(S.cursor)) {
      S.cursor = fromDayKey(t.key);
      S.miniMonth = startOfMonth(S.cursor);
      renderChrome();
      renderTicker();
      renderMini();
    }
    if (extending) return;
    const days = c.querySelectorAll('.ag-day');
    const last = days[days.length - 1];
    const cr = c.getBoundingClientRect();
    if (last && last.getBoundingClientRect().bottom - cr.bottom < 700) {
      S.listDays += 35;
    } else if (c.scrollTop < 500) {
      S.listFrom -= 35 * DAY;
      S.listDays += 35;
    } else return;
    extending = true;
    render().finally(() => { extending = false; });
  });
}

function renderCals() {
  $('#calList').innerHTML = S.cals.map((c) => `
    <label class="cal-item" style="--c:${c.color}">
      <input type="checkbox" data-cal="${esc(c.id)}" ${S.hidden.has(c.id) ? '' : 'checked'}>
      <span class="cal-check"></span>
      <span class="cal-name"${tipAttr(c.name)}>${esc(c.name)}</span>
      ${c.readOnly ? '<span class="cal-ro">읽기 전용</span>' : ''}
      <button type="button" class="cal-color" data-calcolor="${esc(c.id)}" aria-label="${esc(c.name)} 색 바꾸기" title="색 바꾸기(이 기기)"></button>
    </label>`).join('')
    // 할 일(Google Tasks)도 날짜별 목록에서 켜고 끌 수 있게
    + (S.tasksState === 'ok' ? `<label class="cal-item tasks-item" style="--c:${taskColor()}">
      <input type="checkbox" data-cal="${TASKS_KEY}" ${S.hidden.has(TASKS_KEY) ? '' : 'checked'}>
      <span class="cal-check"></span><span class="cal-name">할 일</span><span class="cal-sub">Google Tasks</span>
    </label>` : '')
    + (useGoogle ? '' : '<button class="link-btn" data-act="reset-demo">예시 일정 초기화</button>');
  // 왼쪽 아래 「모든 캘린더 ⌄」: 켠 캘린더 수, 체크 상자는 전부 켜기/끄기
  const on = S.cals.filter((c) => !S.hidden.has(c.id)).length;
  $('#calSetLabel').textContent = on === S.cals.length ? '모든 캘린더' : on ? `캘린더 ${on}/${S.cals.length}개` : '캘린더 꺼짐';
  const all = $('#allCals');
  all.checked = on === S.cals.length;
  all.indeterminate = on > 0 && on < S.cals.length;
  $('#weekStartSel').value = String(S.weekStart);
  // 새 일정 기본값·주 번호·캘린더 묶음
  const dc = $('#defCalSel');
  const dcHTML = writableCals().map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  if (dc.dataset.sig !== dcHTML) { dc.innerHTML = dcHTML; dc.dataset.sig = dcHTML; }
  dc.value = defaultCal()?.id || '';
  $('#defDurSel').value = String(S.defDur);
  $('#weekNumChk').checked = S.weekNum;
  const cur = [...S.cals.map((c) => c.id).filter((id) => S.hidden.has(id))].sort().join('|');
  const hit = S.sets.findIndex((x) => [...x.hidden].sort().join('|') === cur);
  $('#setSel').innerHTML = `<option value="">${S.sets.length ? (hit < 0 ? '(지금 상태)' : '') : '저장한 묶음 없음'}</option>`
    + S.sets.map((x, i) => `<option value="${i}">${esc(x.name)}</option>`).join('');
  $('#setSel').value = hit < 0 ? '' : String(hit);
  $('#setDel').hidden = hit < 0;
  const ub = $('#unhideBtn');
  ub.hidden = !S.hiddenEv.size;
  ub.textContent = `숨긴 일정 ${S.hiddenEv.size}개 다시 보이기`;
}

function renderView() {
  const el = $('#view');
  const view = effView();
  if (view === 'list') {
    // 화면에 안 보일 때(다른 탭) 다시 그린 목록은 다음에 보일 때 선택한 날로 맞춘다
    const shown = el.getClientRects().length > 0;
    const prev = el.querySelector('.ag-main');
    const keep = prev && shown && !S.jump && !listStale ? topDay(prev) : null;
    el.className = 'view v-list';
    el.innerHTML = `<div class="ag-main${mq.matches ? ' m-list' : ''}" id="list">${listHTML(S.listFrom, S.listDays)}<div class="ag-tail"></div></div>`;
    const c = el.querySelector('.ag-main');
    if (keep) scrollToDay(c, keep.key, keep.off);
    else scrollToDay(c, dayKey(S.cursor));
    listStale = !shown;
    c.addEventListener('scroll', onListScroll, { passive: true });
    return;
  }
  if (view === 'month') {
    const prev = el.querySelector('.mv-scroll');
    const keep = prev && prev.getClientRects().length ? topDay(prev, '.mv-week') : null;
    el.className = 'view v-month';
    el.innerHTML = monthHTML();
    const c = el.querySelector('.mv-scroll');
    if (!mq.matches) fitMonth(c, monthRowH());
    const kept = !!keep && scrollToDay(c, keep.key, keep.off, '.mv-week');
    if (S.jump || !kept) {
      const row = c.querySelector(`.mv-week[data-date="${dayKey(sow(startOfMonth(S.cursor)))}"]`);
      // 가까운 달로 옮길 때(‹ › · 방향키)는 부드럽게, 멀리 가면 바로
      if (row && kept && Math.abs(row.offsetTop - c.scrollTop) < 12 * row.offsetHeight) {
        c.scrollTo({ top: row.offsetTop, behavior: 'smooth' });
      } else if (row) c.scrollTop = row.offsetTop;
    }
    c.addEventListener('scroll', onMonthScroll, { passive: true });
    return;
  }
  if (view === 'quarter' || view === 'year') {
    el.className = `view v-${view}`;
    el.innerHTML = view === 'quarter' ? quarterHTML() : yearHTML();
    return;
  }
  el.className = `view v-${view}`;
  const [vs, ve] = viewRange();
  const days = [];
  for (let d = vs; d < ve; d += DAY) days.push(d);
  el.innerHTML = timeGridHTML(days);
  const sc = el.querySelector('.tg-scroll');
  const nowP = P(Date.now());
  const target = days.some((d) => d === startOfDay(Date.now())) ? Math.max(nowP.h - 2, 0) : 8;
  sc.scrollTop = target * HH - 4;
}

/* 겹치는 일정은 옆으로 나눠 배치 */
function layoutDay(items) {
  let cols = [];
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => { cluster.forEach((x) => { x.n = cols.length; }); cluster = []; cols = []; };
  for (const it of items) {
    if (it.s >= clusterEnd) { flush(); clusterEnd = -1; }
    let ci = cols.findIndex((end) => end <= it.s);
    if (ci < 0) { ci = cols.length; cols.push(0); }
    cols[ci] = it.e;
    it.col = ci;
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  flush();
  return items;
}

function timeGridHTML(days) {
  const now = Date.now();
  const today = startOfDay(now);
  const n = days.length;
  const head = days.map((d) => {
    const p = P(d);
    const cls = ['tg-dh', d === today && 'today', d === S.selDay && 'sel', p.dow === 0 && 'sun', p.dow === 6 && 'sat'].filter(Boolean).join(' ');
    return `<button class="${cls}" data-day="${dayKey(d)}"><span class="dow">${WD[p.dow]}</span><span class="dnum">${p.d}</span></button>`;
  }).join('');
  const allday = days.map((d) => {
    const evs = visibleEvents(d, d + DAY).filter((e) => e.allDay);
    return `<div class="tg-ad" data-day="${dayKey(d)}">${evs.map((e) => chipHTML(e, true)).join('')}</div>`;
  }).join('');
  const hours = Array.from({ length: 24 }, (_, h) => `<div class="tg-hl"><span>${h ? fmtHourLabel(h) : ''}</span></div>`).join('');
  const cols = days.map((d) => {
    // s/end: 그날 0시부터의 분, e: 겹침 계산용 끝(아주 짧은 일정도 최소 높이만큼 차지)
    const laid = layoutDay(visibleEvents(d, d + DAY).filter((e) => !e.allDay).map((ev) => {
      const s = Math.max(0, (ev.start - d) / 60e3);
      const end = Math.min(1440, (ev.end - d) / 60e3);
      return { ev, s, end, e: Math.max(end, s + 24) };
    }));
    const blocks = laid.map(({ ev, s, end, col, n: cnt }) => {
      const top = (s / 60) * HH;
      const h = Math.max(((end - s) / 60) * HH - 2, 18);
      const short = h < 36;
      const w = 100 / cnt;
      return `<button class="tg-ev${short ? ' short' : ''}${ev.end < now ? ' past' : ''}" data-id="${esc(ev.id)}"${tipAttr(evTip(ev))}
        style="--c:${colorOf(ev)};top:${top}px;height:${h}px;left:calc(${col * w}% + 1px);width:calc(${w}% - 3px)">
        <span class="t">${esc(ev.title)}</span>
        ${short ? `<span class="tm">${fmtTime(ev.start)}</span>` : `<span class="tm">${fmtTime(ev.start)} – ${fmtTime(ev.end)}</span>`}
        ${!short && ev.location && h > 54 ? `<span class="loc">${esc(ev.location)}</span>` : ''}
        ${ev.readOnly ? '' : '<span class="rz" aria-hidden="true"></span>'}
      </button>`;
    }).join('');
    const nowLine = d === today
      ? `<div class="now-line" style="top:${((now - d) / 3600e3) * HH}px"></div>` : '';
    return `<div class="tg-col${d === today ? ' today' : ''}${d === S.selDay ? ' sel' : ''}" data-day="${dayKey(d)}">${blocks}${nowLine}</div>`;
  }).join('');
  return `<div class="tg" style="--n:${n};--hh:${HH}px">
    <div class="tg-row tg-head"><div class="tg-gutter"></div>${head}</div>
    <div class="tg-row tg-allday"><div class="tg-gutter">종일</div>${allday}</div>
    <div class="tg-scroll"><div class="tg-row tg-body"><div class="tg-hours">${hours}</div>${cols}</div></div>
  </div>`;
}

/** 짧은 시각: 오전 10시 / 오후 3:30 */
function fmtShort(ts) {
  const { h, mi } = P(ts);
  return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}${mi ? `:${String(mi).padStart(2, '0')}` : '시'}`;
}
/** 지금 진행 중이거나 오른쪽 클릭으로 고른 일정: 색을 채워 보인다 */
const isLive = (e, now = Date.now()) => e.id === S.picked || (!e.allDay && e.start <= now && e.end > now);

/* ---------- 마우스를 올리면 뜨는 설명(title): 잘린 제목도 전체 제목·시간·장소를 볼 수 있게 ---------- */
const tipAttr = (s) => (s ? ` title="${esc(s)}"` : '');
/** 일정: 제목 / 날짜·시간 / 장소 */
const evTip = (e) => eventText(e, false);
/** 할 일: 제목 / 마감일 / 목록(여럿일 때) */
function taskTip(t) {
  return [t.title || '(제목 없음)', t.done ? '완료함' : '', t.due != null ? `마감: ${fmtDate(t.due, true)}` : '마감일 없음',
    S.taskLists.length > 1 && listName(t.listId) ? `목록: ${listName(t.listId)}` : ''].filter(Boolean).join('\n');
}
/** 하루 여러 일정 요약(「+N개 더」·연 보기 날짜): 머리 + 「· 시각 제목 (장소)」 줄 */
function dayTip(d, evs, n = evs.length) {
  const p = P(d);
  const line = (e) => `· ${e.allDay || e.start < d ? '종일' : fmtTime(e.start)} ${e.title}${e.location ? ` (${e.location})` : ''}`;
  return [`${p.m + 1}월 ${p.d}일 (${WD[p.dow]}) ${n === evs.length ? '' : '그 밖에 '}일정 ${n}개`, ...evs.map(line)].join('\n');
}

function chipHTML(e, filled = false) {
  const c = colorOf(e);
  if (filled || e.allDay) {
    return `<button class="chip fill" data-id="${esc(e.id)}" style="--c:${c}"${tipAttr(evTip(e))}>${esc(e.title)}</button>`;
  }
  // 월 보기: 한 줄 = 색 점 + 제목(넘치면 …) + 오른쪽 작은 회색 시각
  // 칸이 좁으면 CSS 가 시각 앞 「오전/오후」(.ap)를 숨겨 제목 자리를 넓힌다(전체 시각은 툴팁에)
  const [ap, hm] = fmtShort(e.start).split(' ');
  return `<button class="chip${isLive(e) ? ' live' : ''}" data-id="${esc(e.id)}" style="--c:${c}"${tipAttr(evTip(e))}><i></i><span class="tt">${esc(e.title)}</span><span class="ct"><span class="ap">${ap} </span>${hm}</span></button>`;
}

/** 월 보기 한 주 줄 높이: 화면에 여섯 주가 보이게(원본처럼). 낮은 창은 최소 92px */
function monthRowH() {
  const h = $('#view').clientHeight - 27;
  return Math.max(92, Math.floor(h / 6));
}

const BAR_H = 19; // 종일 막대 한 줄(18px + 사이 1px)
const MAX_LANES = 3; // 한 주에 종일 막대는 세 줄까지, 나머지는 「+N개 더」

/** 월 보기 칸마다 칩 높이를 재서 줄 높이(--wh) 안에 들어가는 만큼만 남기고 나머지는 「+N개 더」로.
 *  첫 일정 하나는 늘 다 보이게: 그것조차 안 들어가면 그 주 줄을 늘린다. 읽기를 먼저 다 하고 고친다. */
function fitMonth(root, rowH) {
  const MORE = 17; // 「+N개 더」 16px + 사이 1px
  const plan = [];
  for (const cell of root.querySelectorAll('.mv-cell')) {
    const chips = cell.querySelectorAll('.chip');
    const extra = +(cell.dataset.extra || 0); // 줄이 모자라 못 그린 종일 막대
    if (!chips.length && !extra) continue;
    const top = cell.offsetTop;
    const limit = rowH - 3; // 아래 여백 2px + 테두리 1px
    const bottoms = [...chips].map((x) => x.offsetTop + x.offsetHeight - top);
    const sp = cell.querySelector('.mv-sp');
    const base = sp ? sp.offsetTop + sp.offsetHeight - top : 28;
    let n = chips.length;
    if (n && bottoms[n - 1] + (extra ? MORE : 0) > limit) {
      const i = bottoms.findIndex((x) => x + MORE > limit);
      n = Math.max(1, i < 0 ? n : i);
    }
    const hidden = chips.length - n + extra;
    if (!hidden) continue;
    plan.push({ cell, chips, n, hidden, need: (n ? bottoms[n - 1] : base) + MORE + 3 });
  }
  const grow = new Map();
  for (const { cell, chips, n, hidden, need } of plan) {
    for (let i = n; i < chips.length; i++) chips[i].remove();
    const d = fromDayKey(cell.dataset.day);
    const p = P(d);
    // 툴팁: 칸에 안 보이는 일정(잘라낸 칩 + 줄이 모자라 못 그린 종일 막대)
    const seen = new Set([...cell.querySelectorAll('.chip'), ...cell.parentElement.querySelectorAll(':scope > .mv-bar')].map((x) => x.dataset.id));
    const rest = visibleEvents(d, d + DAY).filter((e) => !seen.has(e.id));
    cell.insertAdjacentHTML('beforeend', `<button class="more" data-more="${cell.dataset.day}" aria-label="${p.m + 1}월 ${p.d}일 일정 모두 보기"${tipAttr(dayTip(d, rest, hidden))}>+${hidden}개 더</button>`);
    if (need > rowH) grow.set(cell.parentElement, Math.max(grow.get(cell.parentElement) || 0, need));
  }
  grow.forEach((h, week) => { week.style.height = `${Math.ceil(h)}px`; });
}

/** 여러 날·종일 일정: 그 주 안에서 이어지는 막대로. 줄(lane)을 겹치지 않게 나눠 준다 */
const isBar = (e) => e.allDay || startOfDay(e.end - 1) > startOfDay(e.start);
function weekBars(w, now) {
  const evs = visibleEvents(w, w + WEEK).filter(isBar)
    .sort((a, b) => (a.start - b.start) || (b.end - a.end));
  const laneEnd = [];
  const bars = [];
  const extra = Array(7).fill(0);
  for (const e of evs) {
    const sc = Math.max(0, Math.round((startOfDay(e.start) - w) / DAY));
    const ec = Math.min(6, Math.round((startOfDay(e.end - 1) - w) / DAY));
    if (ec < sc) continue;
    let lane = laneEnd.findIndex((x) => x < sc);
    if (lane < 0) { lane = laneEnd.length; laneEnd.push(-1); }
    if (lane >= MAX_LANES) { for (let i = sc; i <= ec; i++) extra[i]++; laneEnd.pop(); continue; }
    laneEnd[lane] = ec;
    const multi = Math.round((startOfDay(e.end - 1) - startOfDay(e.start)) / DAY) >= 1;
    const cls = ['mv-bar', multi && 'multi', e.start < w && 'cl', e.end > w + WEEK && 'cr', isLive(e, now) && 'live',
      !e.allDay && 'timed'].filter(Boolean).join(' ');
    bars.push(`<button class="${cls}" data-id="${esc(e.id)}" style="--c:${colorOf(e)};--l:${lane};left:calc(${sc} * 100% / 7 + 3px);width:calc(${ec - sc + 1} * 100% / 7 - 6px)"${tipAttr(evTip(e))}>${esc(e.title)}</button>`);
  }
  return { bars: bars.join(''), lanes: Math.min(laneEnd.length, MAX_LANES), extra };
}

function monthHTML() {
  const [gs, ge] = viewRange('month');
  const cur = startOfMonth(S.cursor);
  const now = Date.now();
  const today = startOfDay(now);
  const rowH = monthRowH();
  let rows = '';
  for (let w = gs; w < ge; w += WEEK) {
    const { bars, lanes, extra } = weekBars(w, now);
    let cells = '';
    for (let i = 0, d = w; i < 7; i++, d += DAY) {
      const p = P(d);
      const evs = visibleEvents(d, d + DAY);
      const holiday = evs.some(isHoliday);
      const cls = ['mv-cell', startOfMonth(d) !== cur && 'other', d === today && 'today', d === S.selDay && 'sel',
        (p.dow === 0 || p.dow === 6) && 'wkend', holiday && 'hol'].filter(Boolean).join(' ');
      // 제목이 한 줄이라 몇 개가 들어갈지는 그린 뒤 fitMonth 가 재서 정한다
      const shown = evs.filter((e) => !isBar(e)).map((e) => chipHTML(e)).join('');
      // 달의 첫날은 「12월 1」 회색 알약, 오늘은 빨간 원
      const num = p.d === 1 ? `<span class="mv-date mv-pill">${p.m + 1}월 ${p.d}</span>` : `<span class="mv-date">${p.d}</span>`;
      cells += `<div class="${cls}" data-day="${dayKey(d)}"${extra[i] ? ` data-extra="${extra[i]}"` : ''}><span class="mv-dl">${mvWx(d)}${num}</span>${lanes ? `<span class="mv-sp" style="height:${lanes * BAR_H}px"></span>` : ''}${shown}</div>`;
    }
    rows += `<div class="mv-week" data-date="${dayKey(w)}">${cells}${bars}${S.weekNum ? `<span class="mv-wk" title="ISO 주 번호">${isoWeek(w + 3 * DAY)}주</span>` : ''}</div>`;
  }
  return `<div class="mv" style="--wh:${rowH}px">
    <div class="mv-head">${wdOrder().map((i) => `<span class="${i === 0 || i === 6 ? 'wkend' : ''}">${WD[i]}</span>`).join('')}</div>
    <div class="mv-scroll">${rows}</div>
  </div>`;
}
/** ISO 주 번호(월요일 시작, 목요일이 든 해 기준) */
function isoWeek(ts) {
  const d = startOfDay(ts);
  const thu = d + (3 - ((P(d).dow + 6) % 7)) * DAY;
  const y0 = T(P(thu).y, 0, 1);
  return Math.floor((thu - y0) / WEEK) + 1;
}
/** 월 칸 왼쪽 위 작은 날씨(예보가 있는 날만) */
function mvWx(d) {
  const w = wxData?.days?.[dayKey(d)];
  if (!w || d < startOfDay(Date.now())) return '';
  return `<span class="mv-wx" title="최고 ${w[0]}도 최저 ${w[1]}도">${wxIcon(w[2])} ${w[0]}°/${w[1]}°</span>`;
}

/* ---------- 분기 보기: 석 달을 나란히, 칸마다 일정 몇 줄 ---------- */
function quarterHTML() {
  const q = startOfQuarter(S.cursor);
  const now = Date.now();
  const today = startOfDay(now);
  // 석 달의 줄 높이가 맞도록 가장 긴 달의 주 수로 맞춘다
  const weeks = Math.max(...[0, 1, 2].map((k) => Math.ceil((addMonths(q, k + 1) - sow(addMonths(q, k))) / WEEK)));
  const months = [0, 1, 2].map((k) => {
    const m = addMonths(q, k);
    const mp = P(m);
    const gs = sow(m);
    let cells = '';
    for (let i = 0; i < weeks * 7; i++) {
      const d = gs + i * DAY;
      const p = P(d);
      const inM = p.m === mp.m;
      const evs = inM ? visibleEvents(d, d + DAY) : [];
      const cls = ['qv-cell', !inM && 'other', d === today && 'today', d === S.selDay && 'sel', (p.dow === 0 || p.dow === 6) && 'wkend'].filter(Boolean).join(' ');
      const items = evs.slice(0, 3).map((e) => `<button class="qv-ev${e.allDay ? ' ad' : ''}${isLive(e, now) ? ' live' : ''}" data-id="${esc(e.id)}" style="--c:${colorOf(e)}"${tipAttr(evTip(e))}>${esc(e.title)}</button>`).join('');
      cells += `<div class="${cls}" data-day="${dayKey(d)}"><span class="qv-d">${inM ? p.d : ''}</span>${items}${evs.length > 3 ? `<button class="more" data-more="${dayKey(d)}"${tipAttr(dayTip(d, evs.slice(3), evs.length - 3))}>+${evs.length - 3}</button>` : ''}</div>`;
    }
    return `<section class="qv-m"><h3 class="qv-t">${mp.m + 1}월</h3>
      <div class="qv-wd">${wdOrder().map((i) => `<span>${WD[i]}</span>`).join('')}</div>
      <div class="qv-grid" style="--weeks:${weeks}">${cells}</div></section>`;
  }).join('');
  return `<div class="qv">${months}</div>`;
}

/* ---------- 연 보기: 열두 달 작은 달력, 일정 있는 날 아래 점 ---------- */
function yearHTML() {
  const y0 = startOfYear(S.cursor);
  const today = startOfDay(Date.now());
  const months = Array.from({ length: 12 }, (_, k) => {
    const m = addMonths(y0, k);
    const mp = P(m);
    const gs = sow(m);
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = gs + i * DAY;
      const p = P(d);
      if (p.m !== mp.m) { cells += '<span class="yv-day other"></span>'; continue; }
      const evs = visibleEvents(d, d + DAY);
      const cls = ['yv-day', d === today && 'today', d === S.selDay && 'sel', evs.some(isHoliday) && 'hol', evs.length && 'has'].filter(Boolean).join(' ');
      cells += `<button class="${cls}" data-day="${dayKey(d)}" style="--c:${evs.length ? colorOf(evs[0]) : 'transparent'}" aria-label="${p.m + 1}월 ${p.d}일${evs.length ? `, 일정 ${evs.length}개` : ''}"${evs.length ? tipAttr(dayTip(d, evs)) : ''}>${p.d}</button>`;
    }
    return `<section class="yv-m${P(today).y === mp.y && P(today).m === mp.m ? ' now' : ''}"><h3 class="yv-t" data-goto-month="${dayKey(m)}">${mp.m + 1}월</h3>
      <div class="yv-grid">${wdOrder().map((i) => `<span class="yv-wd">${WD[i]}</span>`).join('')}${cells}</div></section>`;
  }).join('');
  return `<div class="yv">${months}</div>`;
}

let mvTick = 0;
function onMonthScroll(ev) {
  const c = ev.currentTarget;
  closeDayPop();
  if (mvTick) return;
  mvTick = requestAnimationFrame(() => {
    mvTick = 0;
    if (!c.isConnected) return; // 그사이 다시 그려진 옛 상자
    // 스크롤로 보이는 달이 바뀌면 제목·미니 달력·흐린 날짜를 따라 바꾼다
    const m = centerMonth(c);
    if (m != null && m !== startOfMonth(S.cursor)) {
      S.cursor = m;
      S.miniMonth = m;
      markMonth(c, m, '.mv-cell');
      renderChrome();
      renderMini();
    }
    if (extending) return;
    const rh = c.firstElementChild?.offsetHeight || 100;
    if (c.scrollHeight - c.scrollTop - c.clientHeight < 3 * rh) {
      S.mvWeeks += 9;
      if (S.mvWeeks > 54) { S.mvFrom += 9 * WEEK; S.mvWeeks -= 9; }
    } else if (c.scrollTop < 3 * rh) {
      S.mvFrom -= 9 * WEEK;
      S.mvWeeks = Math.min(S.mvWeeks + 9, 54);
    } else return;
    extending = true;
    render().finally(() => { extending = false; });
  });
}

/* ---------- 「+N개 더」: 그날 일정 전체를 작은 창으로 ---------- */

function openDayPop(d, anchor) {
  closeDayPop();
  const evs = visibleEvents(d, d + DAY);
  const now = Date.now();
  const p = P(d);
  const items = evs.map((e) => {
    const time = e.allDay
      ? '종일'
      : `${e.start < d ? '…' : fmtTime(e.start)}<small>${e.end > d + DAY ? '…' : fmtTime(e.end)}</small>`;
    return `<button class="ag-ev${!e.allDay && e.end < now ? ' past' : ''}" data-id="${esc(e.id)}" style="--c:${colorOf(e)}"${tipAttr(evTip(e))}>
      <span class="ag-time">${time}</span>
      <span class="ag-bar"></span>
      <span class="ag-body"><span class="ag-title">${esc(e.title)}</span>${e.location ? `<span class="ag-loc">${esc(e.location)}</span>` : ''}</span>
    </button>`;
  }).join('');
  const pop = document.createElement('div');
  pop.className = 'day-pop';
  pop.id = 'dayPop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', `${p.m + 1}월 ${p.d}일 일정`);
  pop.innerHTML = `
    <div class="dp-head">
      <button class="dp-title${p.dow === 0 ? ' sun' : p.dow === 6 ? ' sat' : ''}" data-act="day-view" data-goto="${dayKey(d)}" title="일 보기로 열기">
        <b>${p.d}</b><span>${p.m + 1}월 ${WD[p.dow]}요일</span>
      </button>
      <button class="icon-btn sm" data-act="close-pop" aria-label="닫기">×</button>
    </div>
    <div class="dp-list">${items || '<div class="ag-empty">일정 없음</div>'}</div>`;
  document.body.append(pop);
  // 누른 칸 위에 겹쳐 띄우고 화면 밖으로 나가지 않게 맞춘다
  const cell = anchor.closest('.mv-cell') || anchor;
  const r = cell.getBoundingClientRect();
  const w = Math.max(r.width + 40, 280);
  pop.style.width = `${w}px`;
  const h = pop.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  const top = Math.min(Math.max(8, r.top - 6), innerHeight - h - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.tabIndex = -1;
  pop.focus({ preventScroll: true });
}
function closeDayPop() {
  $('#dayPop')?.remove();
}

function renderWelcome() {
  $('#view').className = 'view';
  $('#view').innerHTML = `<div class="welcome">
    <img src="icons/icon-v14.svg" alt="" width="72" height="72">
    <h2>${esc(CONFIG.appName)}에 오신 것을 환영합니다</h2>
    <p>구글 캘린더를 연결하면 일정을 보고, 추가하고, 고칠 수 있어요.</p>
    <button class="btn primary big" data-act="login">구글 캘린더 연결</button>
    <button class="link-btn" data-act="demo">예시 일정으로 둘러보기</button>
  </div>`;
  ['#mini', '#upcoming', '#calList', '#ticker'].forEach((s) => { $(s).innerHTML = ''; });
}

/* ---------- 배너 · 토스트 ---------- */

function showBanner(html) { const b = $('#banner'); b.innerHTML = html; b.hidden = false; }
function hideBanner() { $('#banner').hidden = true; }

let toastTimer;
/** 알림 띠. action(실행 취소·되돌리기)이 있으면 실행 취소 목록에도 넣는다(⌘Z / Ctrl+Z 로도 된다) */
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="btn small">${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  if (action) {
    const u = pushUndo(msg, action.run);
    t.querySelector('button').onclick = () => { t.hidden = true; runUndo(u); };
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

/* ---------- 실행 취소: 최근 작업 20개까지 ---------- */
const undoStack = [];
function pushUndo(label, run) {
  const u = { label, run };
  undoStack.push(u);
  if (undoStack.length > 20) undoStack.shift();
  return u;
}
async function runUndo(u = undoStack[undoStack.length - 1]) {
  if (!u) { toast('실행 취소할 작업이 없습니다'); return; }
  const i = undoStack.indexOf(u);
  if (i >= 0) undoStack.splice(i, 1);
  await u.run();
  $('#toast').hidden = true;
}

/* ---------- 일정 저장 ---------- */

async function createEvent(e) {
  const cal = calById(e.calendarId);
  const saved = await S.store.create(e, cal);
  S.events.push(saved);
  searchPool?.evs.push(saved);
  return saved;
}
async function updateEvent(e, prevCalendarId) {
  const saved = await S.store.update(e, calById(e.calendarId), prevCalendarId);
  S.events = S.events.map((x) => (x.id === e.id ? saved : x));
  if (searchPool) searchPool.evs = searchPool.evs.map((x) => (x.id === e.id ? saved : x));
  return saved;
}
async function removeEvent(e) {
  await S.store.remove(e);
  S.events = S.events.filter((x) => x.id !== e.id);
  if (searchPool) searchPool.evs = searchPool.evs.filter((x) => x.id !== e.id);
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    handleError(err);
    toast(err instanceof AuthError ? '로그인이 필요합니다' : '저장하지 못했습니다');
    return null;
  }
}

/* ---------- 빠른 입력 ---------- */

function matchCal(hint) {
  if (!hint) return defaultCal();
  const h = hint.toLowerCase();
  return writableCals().find((c) => c.name.toLowerCase() === h)
    || writableCals().find((c) => c.name.toLowerCase().includes(h))
    || defaultCal();
}

/** 날짜 말이 없는 빠른 입력이 들어갈 날: 고른 날(없으면 오늘) */
const parseQ = (v) => parseQuick(v, Date.now(), { baseDay: S.selDay, defaultDur: S.defDur });

function describe(r) {
  const row = (cls, label, html) => `<span class="pv-row ${cls}"><em>${label}</em>${html}</span>`;
  // 날짜 말이 없으면 어느 날에 들어가는지(고른 날·오늘) 같이 보여 준다
  const today = startOfDay(Date.now());
  const why = r.hasDate ? ''
    : S.selDay != null ? (S.selDay === today ? '고른 날 · 오늘' : '고른 날')
      : startOfDay(r.start) === today ? '오늘' : '';
  const parts = [row('pv-date', '날짜', `${esc(fmtDate(r.start, P(r.start).y !== P(today).y))}${why ? ` <small class="pv-why">${why}</small>` : ''}`)];
  if (r.allDay) {
    const days = Math.round((r.end - r.start) / DAY);
    parts.push(row('pv-time', '시간', `종일${days > 1 ? ` · ${days}일` : ''}`));
  } else {
    parts.push(row('pv-time', '시간', `${fmtTime(r.start)} – ${fmtTime(r.end)}${sameDay(r.start, r.end - 1) ? '' : ' (다음 날)'}`));
  }
  if (r.repeatText) parts.push(row('pv-rep', '반복', `↻ ${esc(r.repeatText)}`));
  if (r.reminders) parts.push(row('pv-al', '알림', r.reminders === 'none' ? '없음' : esc(r.reminders.map(alertLabel).join(', '))));
  if (r.location) parts.push(row('pv-loc', '장소', `📍 ${esc(r.location)}`));
  if (r.url) parts.push(row('pv-url', 'URL', esc(r.url)));
  if (r.attendees.length) parts.push(row('pv-att', '참석자', esc(r.attendees.join(', '))));
  if (r.note) parts.push(row('pv-note', '메모', esc(r.note)));
  if (quickTpl) parts.push(row('pv-tpl', '템플릿', esc(quickTpl.title)));
  if (r.isTask) {
    return `<strong style="--c:${taskColor()}">☐ ${esc(r.title || '새 할 일')}</strong>${row('pv-task', '할 일', r.hasDate ? `마감 ${esc(fmtDate(r.start))}` : '마감일 없음')}<kbd>Enter</kbd>`;
  }
  const tc = !r.calendarHint && quickTpl ? calById(quickTpl.calendarId) : null;
  const cal = tc && !tc.readOnly ? tc : matchCal(r.calendarHint);
  if (cal) parts.push(row('pv-cal', '캘린더', `<span style="--c:${cal.color}"><i></i>${esc(cal.name)}</span>`));
  return `<strong style="--c:${cal?.color || 'var(--accent)'}">${esc(r.title || '새 일정')}</strong>${parts.join('')}<kbd>Enter</kbd>`;
}

const quick = $('#quick');
const pvEl = $('#quickPreview');
quick.addEventListener('input', () => {
  const v = quick.value.trim();
  if (!v || S.needsLogin) { pvEl.hidden = true; return; }
  pvEl.innerHTML = describe(parseQ(v));
  pvEl.hidden = false;
});
quick.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { closeQuick(); }
});
// 미리보기는 빠른 입력 창(데스크톱 ＋ 창 · 휴대폰 시트)이 열려 있는 동안 계속 보인다
quick.addEventListener('blur', () => setTimeout(() => { if (!document.body.classList.contains('quick-open')) pvEl.hidden = true; }, 150));
quick.addEventListener('focus', () => quick.dispatchEvent(new Event('input')));

/** 빠른 입력 열기: 휴대폰은 아래에서 올라오는 시트, 데스크톱은 왼쪽 위 ＋ 아래 작은 창 */
let quickTpl = null; // 빠른 입력에서 고른 템플릿
function openQuick(text = '') {
  if (S.needsLogin) return;
  if (text) quick.value = text;
  quickTpl = null;
  renderTemplates();
  closeCtx();
  document.body.classList.add('quick-open');
  if (mq.matches) fitSheetToKeyboard();
  quick.focus();
  quick.dispatchEvent(new Event('input'));
}
function closeQuick() {
  quick.value = '';
  quickTpl = null;
  pvEl.hidden = true;
  document.body.classList.remove('quick-open');
  $('#quickSheet').style.removeProperty('--kb');
  quick.blur();
}
// 아이폰 키보드가 올라오면 시트를 키보드 위로 올린다
function fitSheetToKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  $('#quickSheet').style.setProperty('--kb', `${kb}px`);
}
window.visualViewport?.addEventListener('resize', () => { if (document.body.classList.contains('quick-open')) fitSheetToKeyboard(); });
$('#qsCancel').onclick = closeQuick;
$('#qsScrim').onclick = () => { closeQuick(); closeMenu(); };

/** 알림 분 → 「10분 전」「1시간 전」「1일 전」 */
function alertLabel(v) {
  if (v === 0) return '일정 시작';
  if (v >= 10080 && v % 10080 === 0) return `${v / 10080}주 전`;
  if (v >= 1440 && v % 1440 === 0) return `${v / 1440}일 전`;
  if (v >= 60 && v % 60 === 0) return `${v / 60}시간 전`;
  return `${v}분 전`;
}
/** 자연어 알림 → 저장 값(하나면 분, 여럿이면 배열) */
const reminderFromParse = (x) => (x == null ? undefined : x === 'none' ? 'none' : x.length === 1 ? x[0] : x);

$('#quickForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const v = quick.value.trim();
  if (!v || S.needsLogin) return;
  const r = parseQ(v);
  // 「할 일: …」「todo …」 → 구글 할 일(권한이 없으면 일정으로 넣지 않고 안내만)
  if (r.isTask) {
    if (S.tasksState !== 'ok') { toast('할 일(Google Tasks)을 쓸 수 없는 상태입니다 · ☰ → 할 일에서 확인'); return; }
    const listId = localStorage.getItem(K_TLIST) && S.taskLists.some((l) => l.id === localStorage.getItem(K_TLIST)) ? localStorage.getItem(K_TLIST) : S.taskLists[0]?.id;
    if (await addTask(v.replace(/^\s*(?:할\s?일|todo|task|투두|리마인더)\s*[:：]?\s*/i, ''), listId)) { closeQuick(); closeMenu(); }
    return;
  }
  const tpl = quickTpl;
  const cal = (r.calendarHint ? matchCal(r.calendarHint) : tpl && calById(tpl.calendarId) && !calById(tpl.calendarId).readOnly ? calById(tpl.calendarId) : null) || matchCal(r.calendarHint);
  if (!cal) { toast('일정을 넣을 수 있는 캘린더가 없습니다'); return; }
  // 템플릿을 골랐으면 문장에 없는 값(길이·장소·메모·알림·URL)을 템플릿에서
  const end = tpl && r.hasTime && !r.allDay && r.end - r.start === S.defDur * 60e3 ? r.start + tpl.dur * 60e3 : r.end;
  const saved = await guarded(() => createEvent({
    calendarId: cal.id, title: r.title || tpl?.title || '새 일정', start: r.start, end,
    allDay: r.allDay, location: r.location || tpl?.location || '', note: r.note || tpl?.note || '',
    ...(r.recurrence ? { recurrence: r.recurrence } : {}),
    ...(reminderFromParse(r.reminders) !== undefined ? { reminder: reminderFromParse(r.reminders) } : tpl?.reminder != null ? { reminder: tpl.reminder } : {}),
    ...(r.url || tpl?.url ? { url: r.url || tpl.url } : {}),
    ...(r.attendees.length ? { attendees: r.attendees.map((email) => ({ email, status: 'needsAction' })), attendeesChanged: true } : {}),
  }));
  if (!saved) return;
  closeQuick();
  closeMenu();
  S.cursor = startOfDay(saved.start);
  S.miniMonth = startOfMonth(S.cursor);
  S.jump = true;
  if (r.recurrence) searchPool = null;
  await render({ refetch: !!r.recurrence });
  flash(saved.id);
  toast(`‘${saved.title}’ 추가 · ${fmtDate(saved.start)}${saved.allDay ? '' : ` ${fmtTime(saved.start)}`}`, {
    label: '실행 취소',
    run: async () => { await guarded(() => removeEvent(saved)); searchPool = null; render({ refetch: !!r.recurrence }); },
  });
});

function flash(id) {
  document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach((n) => {
    n.classList.add('flash');
    n.scrollIntoView({ block: 'nearest' });
  });
}

/* ---------- 편집 창 ---------- */

const dlg = $('#editor');
const form = $('#editorForm');
let editing = null; // {event, isNew}

function openEditor(e, isNew = false) {
  editing = { event: e, isNew, reminder: String(e.reminder ?? 'default'), parsed: null, whenTouched: false,
    rule: null, ruleLoaded: !e.recurringEventId, ruleRaw: '', repTouched: false, master: null,
    attendees: (e.attendees || []).map((a) => ({ ...a })), attTouched: false, tz: e.tz || TZ_SEOUL, tzShown: e.tz || TZ_SEOUL };
  const ro = !!e.readOnly;
  const cals = ro ? S.cals.filter((c) => c.id === e.calendarId) : writableCals();
  form.calendarId.innerHTML = cals.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  form.calendarId.value = e.calendarId;
  form.title.value = isNew ? '' : e.title;
  form.title.placeholder = isNew ? '제목 (예: 회의 14:00, 매주 월수금 9시 스탠드업)' : '제목';
  $('#edParse').hidden = true;
  form.allDay.checked = e.allDay;
  form.tz.innerHTML = tzOptions(editing.tz);
  form.tz.value = editing.tz;
  showWhen(e.start, e.end, e.allDay);
  form.location.value = e.location || '';
  form.url.value = e.url || '';
  form.note.value = e.note || '';
  form.avail.value = e.free ? 'free' : 'busy';
  form.attIn.value = '';
  form.notify.checked = false;
  form.addMeet.checked = false;
  setReminderField(e.reminder);
  // 반복: 원본이 있으면(반복 회차) 원본 규칙을 읽어 와서 보여 준다
  const rec = e.recurrence || null;
  if (rec) { editing.rule = ruleOf(rec); editing.ruleRaw = rec.join('\n'); }
  setRepeatFields(editing.rule, e.start);
  if (e.recurringEventId) {
    form.repeat.disabled = true;
    const ed = editing;
    S.store.get(e.calendarId, e.recurringEventId, calById(e.calendarId)).then((m) => {
      if (editing !== ed || !m) return;
      ed.master = m;
      ed.rule = ruleOf(m.recurrence);
      ed.ruleRaw = (m.recurrence || []).join('\n');
      ed.ruleLoaded = true;
      setRepeatFields(ed.rule, e.start);
      form.repeat.disabled = ro;
    }).catch(() => { if (editing === ed) form.repeat.disabled = true; });
  }
  [...form.elements].forEach((el) => { if (el.name && el.name !== 'repeat') el.disabled = ro; });
  if (ro) form.repeat.disabled = true;
  // 반복 회차는 다른 캘린더로 옮길 수 없다(구글 제한)
  if (e.recurringEventId) form.calendarId.disabled = true;
  $('#edAlAdd').hidden = ro;
  $('#edSave').hidden = ro;
  $('#edDelete').hidden = isNew || ro;
  $('#edCancel').textContent = ro ? '닫기' : '취소';
  const note = $('#edNote');
  note.hidden = !(ro || e.recurringEventId);
  note.textContent = ro ? '읽기 전용 캘린더의 일정입니다.' : '반복 일정입니다. 저장·삭제할 때 「이 일정만」 또는 「이후 모든 일정」을 고릅니다.';
  const link = $('#edLink');
  link.hidden = !e.link;
  if (e.link) link.href = e.link;
  $('#edMeet').hidden = !e.meet;
  if (e.meet) $('#edMeet').href = e.meet;
  $('#edMeetRow').hidden = !!e.meet || ro;
  syncUrlLink();
  renderAttendees();
  syncEditor();
  dlg.showModal();
  edOpenedAt = Date.now();
  if (isNew) form.title.focus();
}

/* ---------- 편집 창: 시간대 ---------- */
const TZ_SEOUL = 'Asia/Seoul';
const TZS = [['Asia/Seoul', '서울'], ['Asia/Tokyo', '도쿄'], ['Asia/Shanghai', '베이징'], ['Asia/Singapore', '싱가포르'],
  ['Asia/Dubai', '두바이'], ['Europe/London', '런던'], ['Europe/Paris', '파리·베를린'], ['America/New_York', '뉴욕'],
  ['America/Chicago', '시카고'], ['America/Los_Angeles', '로스앤젤레스'], ['Pacific/Honolulu', '호놀룰루'], ['UTC', 'UTC']];
const tzName = (tz) => TZS.find(([k]) => k === tz)?.[1] || tz;
function tzOptions(cur) {
  const list = TZS.some(([k]) => k === cur) ? TZS : [...TZS, [cur, cur]];
  return list.map(([k, l]) => `<option value="${esc(k)}">${esc(l)}${k === TZ_SEOUL ? '' : ` (${esc(k)})`}</option>`).join('');
}
/** 그 시각의 그 시간대 벽시계 값 {y, m(1~12), d, h, mi} */
function wallIn(ts, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const o = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute };
}
const pad2 = (n) => String(n).padStart(2, '0');
/** 그 시간대의 날짜·시각 입력값 → 타임스탬프 */
function fromWall(dateStr, timeStr, tz) {
  if (tz === TZ_SEOUL) return fromInputs(dateStr, timeStr);
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = (timeStr || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = (ts) => { const w = wallIn(ts, tz); return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi) - ts; };
  let ts = guess - off(guess);
  ts = guess - off(ts); // 서머타임 경계 보정
  return ts;
}
/** 시작·종료를 편집 창 칸에 넣는다(시간 일정은 고른 시간대의 벽시계로) */
function showWhen(start, end, allDay) {
  const tz = allDay ? TZ_SEOUL : form.tz.value || TZ_SEOUL;
  const w = (ts) => (tz === TZ_SEOUL ? { date: dayKey(ts), time: hm(ts) } : (() => { const x = wallIn(ts, tz); return { date: `${x.y}-${pad2(x.m)}-${pad2(x.d)}`, time: `${pad2(x.h)}:${pad2(x.mi)}` }; })());
  const a = w(start);
  const b = w(allDay ? end - DAY : end);
  form.sDate.value = a.date;
  form.sTime.value = a.time;
  form.eDate.value = allDay ? dayKey(end - DAY) : b.date;
  form.eTime.value = allDay ? hm(end) : w(end).time;
}
/** 편집 창 칸 → {start, end} (tz: 칸에 보이는 시간대) */
function readWhen(tz = form.tz.value || TZ_SEOUL) {
  const allDay = form.allDay.checked;
  if (allDay) return { allDay, start: fromDayKey(form.sDate.value), end: fromDayKey(form.eDate.value) + DAY };
  return { allDay, start: fromWall(form.sDate.value, form.sTime.value, tz), end: fromWall(form.eDate.value, form.eTime.value, tz) };
}
function syncTzText() {
  const el = $('#edTzText');
  const tz = form.tz.value;
  const show = !form.allDay.checked && tz && tz !== TZ_SEOUL && form.sDate.value && form.sTime.value;
  el.hidden = !show;
  if (show) { const { start, end } = readWhen(); el.textContent = `서울 시간: ${fmtDate(start)} ${fmtTime(start)} – ${fmtTime(end)}`; }
}
form.tz.addEventListener('change', () => {
  // 시간대를 바꾸면 같은 순간을 새 시간대 벽시계로 다시 보여 준다
  if (!editing) return;
  const w = readWhen(editing.tzShown);
  showWhen(w.start, w.end, w.allDay);
  editing.tzShown = form.tz.value;
  syncTzText();
});

/* ---------- 편집 창: 반복 ---------- */
function setRepeatFields(rule, start) {
  const kind = presetOf(rule, start);
  const custom = kind === 'custom' ? `<option value="custom">${esc(describeRule({ ...rule, until: null, count: null }, start))}</option>` : '';
  form.repeat.innerHTML = REPEAT_OPTIONS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('') + custom;
  form.repeat.value = kind;
  editing.customRule = kind === 'custom' ? rule : null;
  form.repeatEnd.value = rule?.count ? 'count' : rule?.until != null ? 'until' : 'never';
  form.repeatUntil.value = dayKey(rule?.until != null ? rule.until : start + 30 * DAY);
  form.repeatCount.value = String(rule?.count || 10);
  syncRepeat();
}
/** 편집 창 칸 → 반복 규칙(없으면 null) */
function readRule(start) {
  const kind = form.repeat.value;
  let r = kind === 'none' ? null : kind === 'custom' ? { ...editing.customRule } : presetRule(kind, start);
  if (!r) return null;
  delete r.until; delete r.count;
  r.until = null; r.count = null;
  if (form.repeatEnd.value === 'until' && form.repeatUntil.value) r.until = fromDayKey(form.repeatUntil.value) + DAY - 1;
  if (form.repeatEnd.value === 'count') r.count = Math.max(1, Math.min(730, +form.repeatCount.value || 1));
  return r;
}
function syncRepeat() {
  const on = form.repeat.value !== 'none';
  $('#edRepEnd').hidden = !on;
  form.repeatUntil.hidden = form.repeatEnd.value !== 'until';
  form.repeatCount.hidden = form.repeatEnd.value !== 'count';
  const t = $('#edRepText');
  t.hidden = !on;
  if (on && form.sDate.value) { const { start } = readWhen(); const r = readRule(start); t.textContent = `↻ ${describeRule(r, start)}`; }
}
['repeat', 'repeatEnd', 'repeatUntil', 'repeatCount'].forEach((n) => form[n].addEventListener('change', () => { if (editing) editing.repTouched = true; syncRepeat(); }));
form.repeatCount.addEventListener('input', syncRepeat);

/* ---------- 편집 창: 알림 여러 개(구글은 다섯 개까지) ---------- */
const alertSels = () => [...$('#edAlerts').querySelectorAll('.al-sel')];
function addAlertSel(v) {
  const first = form.reminder;
  const sel = first.cloneNode(true);
  sel.removeAttribute('name');
  sel.querySelectorAll('[data-extra], [value=none], [value=default]').forEach((o) => o.remove());
  ensureOpt(sel, v);
  sel.value = String(v);
  sel.setAttribute('aria-label', '알림 더');
  const wrap = document.createElement('span');
  wrap.className = 'al-more';
  wrap.append(sel);
  wrap.insertAdjacentHTML('beforeend', '<button type="button" class="al-del" aria-label="이 알림 빼기">×</button>');
  $('#edAlAdd').before(wrap);
  syncAlerts();
}
function ensureOpt(sel, v) {
  const val = String(v);
  if (![...sel.options].some((o) => o.value === val)) {
    const label = v === 'custom' ? '구글에 설정된 알림 그대로' : alertLabel(+v);
    sel.insertAdjacentHTML('beforeend', `<option value="${esc(val)}" data-extra>${esc(label)}</option>`);
  }
}
function syncAlerts() {
  const n = alertSels().length;
  const v = form.reminder.value;
  $('#edAlAdd').hidden = n >= 5 || ['none', 'default', 'custom'].includes(v) || !!form.reminder.disabled;
}
/** 지금 고른 알림 값: 'default' | 'none' | 'custom' | 분 | [분…] */
function readAlerts() {
  const v = form.reminder.value;
  if (['none', 'default', 'custom'].includes(v)) return v;
  const mins = [...new Set(alertSels().map((x) => +x.value))].sort((a, b) => a - b);
  return mins.length === 1 ? mins[0] : mins;
}
$('#edAlAdd').addEventListener('click', () => {
  const used = new Set(alertSels().map((x) => +x.value));
  addAlertSel([10, 60, 1440, 30, 5, 15, 120, 2880].find((m) => !used.has(m)) ?? 10);
});
$('#edAlerts').addEventListener('click', (ev) => { const d = ev.target.closest('.al-del'); if (d) { d.parentElement.remove(); syncAlerts(); } });
$('#edAlerts').addEventListener('change', syncAlerts);

/* ---------- 편집 창: 참석자·URL ---------- */
const RSVP = { accepted: ['✓', '수락'], declined: ['✕', '거절'], tentative: ['?', '미정'], needsAction: ['·', '응답 없음'] };
function renderAttendees() {
  const box = $('#edAtt');
  const ro = !!editing.event.readOnly;
  box.innerHTML = editing.attendees.map((a, i) => {
    const [ic, label] = RSVP[a.status] || RSVP.needsAction;
    return `<span class="att att-${esc(a.status || 'needsAction')}" title="${esc(a.email)} · ${label}${a.organizer ? ' · 주최자' : ''}"><b>${ic}</b>${esc(a.name || a.email)}${a.organizer ? ' <small>주최</small>' : ''}${ro || a.organizer ? '' : `<button type="button" class="att-del" data-att="${i}" aria-label="${esc(a.email)} 빼기">×</button>`}</span>`;
  }).join('');
  $('#edNotifyRow').hidden = ro || !(editing.attendees.some((a) => !a.self) && (editing.attTouched || editing.isNew));
}
function addAttendee() {
  const v = form.attIn.value.trim();
  if (!v) return;
  const list = v.split(/[\s,;]+/).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  if (!list.length) { toast('이메일 주소를 확인해 주세요'); return; }
  for (const email of list) if (!editing.attendees.some((a) => a.email.toLowerCase() === email.toLowerCase())) editing.attendees.push({ email, status: 'needsAction' });
  editing.attTouched = true;
  form.attIn.value = '';
  renderAttendees();
}
form.attIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addAttendee(); } });
form.attIn.addEventListener('change', addAttendee);
$('#edAtt').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-att]');
  if (!b) return;
  editing.attendees.splice(+b.dataset.att, 1);
  editing.attTouched = true;
  renderAttendees();
});
function syncUrlLink() {
  const u = form.url.value.trim();
  const ok = /^https?:\/\//i.test(u);
  $('#edUrl').hidden = !ok;
  if (ok) $('#edUrl').href = u;
  // 장소가 있으면 지도(네이버 지도 검색)로
  const loc = form.location.value.trim();
  $('#edMap').hidden = !loc;
  if (loc) $('#edMap').href = `https://map.naver.com/p/search/${encodeURIComponent(loc)}`;
}
form.url.addEventListener('input', syncUrlLink);
form.location.addEventListener('input', syncUrlLink);

/** 알림 고르기: 목록에 없는 값(20분 전 등)은 그 일정에만 보기 하나를 더 붙인다. 여러 개면 칸을 늘린다 */
function setReminderField(v = 'default') {
  const sel = form.reminder;
  sel.querySelectorAll('[data-extra]').forEach((o) => o.remove());
  $('#edAlerts').querySelectorAll('.al-more').forEach((x) => x.remove());
  const list = Array.isArray(v) ? v : [v];
  ensureOpt(sel, list[0]);
  sel.value = String(list[0]);
  list.slice(1).forEach((m) => addAlertSel(m));
  syncAlerts();
}
const reminderOf = (v) => (/^\d+$/.test(v) ? +v : v);

/**
 * 새 일정 제목에 적은 날짜·시간 말(「고병수 부위원장 14:00」, 「내일 3시 회의」)을 Fantastical처럼
 * 시작·종료 칸에 바로 넣고, 저장할 때 제목에서 그 말을 뺀다. 말을 지우면 처음 값으로 돌아간다.
 * 시간 칸을 직접 고친 뒤에는 칸을 더 건드리지 않는다(제목 정리는 그대로).
 */
function applyTitleWhen() {
  if (!editing?.isNew) return;
  const b = editing.event;
  const text = form.title.value;
  const r = text.trim() ? parseQuick(text, Date.now(), { baseDay: startOfDay(b.start) }) : null;
  // 「점심」「저녁」처럼 끼니 말로 짐작한 시간은 쓰지 않는다(고른 칸 시간을 지킨다)
  const hasTime = !!r && r.hasTime && !r.timeGuessed;
  const hit = !!r && (hasTime || r.hasDate || !!r.recurrence || !!r.reminders || !!r.url || r.attendees.length > 0 || !!r.note);
  editing.parsed = hit ? r : null;
  const note = $('#edParse');
  note.hidden = !hit;
  if (hit) {
    const when = hasTime ? `${fmtDate(r.start)} ${fmtTime(r.start)} – ${fmtTime(r.end)}` : r.hasDate ? fmtDate(r.start) : '';
    note.textContent = [when && `⏱ ${when}`, r.repeatText && `↻ ${r.repeatText}`, Array.isArray(r.reminders) && `🔔 ${r.reminders.map(alertLabel).join(', ')}`, `제목: ${r.title || '새 일정'}`].filter(Boolean).join(' · ');
  }
  if (editing.whenTouched) return;
  let { start, end, allDay } = b;
  if (hasTime) {
    ({ start, end } = r);
    allDay = false;
  } else if (hit && r.hasDate) {
    // 날짜만 적었으면 고른 시각·길이는 그대로 두고 날짜만 옮긴다
    start = r.start + (b.start - startOfDay(b.start));
    end = start + (b.end - b.start);
    if (/종일/.test(text)) { allDay = true; end = r.end; start = r.start; }
  }
  form.allDay.checked = allDay;
  showWhen(start, end, allDay);
  syncEditor();
}
/** 제목에 적은 반복·알림 말(「매주 월수금」「알림 10분 전」)도 칸에 넣는다(직접 고친 칸은 그대로) */
function applyTitleExtras(r) {
  if (!editing.repTouched) {
    const rule = r?.recurrence ? ruleOf(r.recurrence) : null;
    setRepeatFields(rule, r?.start ?? editing.event.start);
  }
  if (!editing.alTouched && r?.reminders) setReminderField(reminderFromParse(r.reminders));
}
form.title.addEventListener('input', () => {
  applyTitleWhen();
  if (editing?.isNew) {
    const text = form.title.value;
    const r = text.trim() ? parseQuick(text, Date.now(), { baseDay: startOfDay(editing.event.start) }) : null;
    applyTitleExtras(r);
  }
});
$('#edAlerts').addEventListener('change', () => { if (editing) editing.alTouched = true; });
['allDay', 'sDate', 'sTime', 'eDate', 'eTime'].forEach((n) => {
  form[n].addEventListener('input', () => { if (editing) editing.whenTouched = true; });
  form[n].addEventListener('change', () => { if (editing) editing.whenTouched = true; });
});

function syncEditor() {
  const ad = form.allDay.checked;
  form.sTime.hidden = ad;
  form.eTime.hidden = ad;
  const c = calById(form.calendarId.value);
  $('#edDot').style.background = c?.color || '#888';
}
form.allDay.addEventListener('change', syncEditor);
form.calendarId.addEventListener('change', syncEditor);
form.sDate.addEventListener('change', () => {
  // 시작 날짜를 옮기면 종료 날짜도 같은 간격만큼 옮긴다
  const prev = editing.event;
  const ns = fromDayKey(form.sDate.value);
  const shift = ns - startOfDay(prev.start);
  const curEnd = fromDayKey(form.eDate.value);
  if (curEnd < ns) form.eDate.value = dayKey(curEnd + shift);
});
$('#edCancel').addEventListener('click', () => dlg.close());
// 바깥(배경) 클릭으로 닫기. 단, 일정을 더블클릭해 연 직후의 두 번째 클릭은 무시한다
let edOpenedAt = 0;
dlg.addEventListener('click', (ev) => {
  if (ev.target === dlg && ev.detail < 2 && Date.now() - edOpenedAt > 400) dlg.close();
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const ed = editing;
  const { event: orig, isNew } = ed;
  if (isNew) applyTitleWhen();
  const parsed = isNew ? ed.parsed : null;
  const { allDay, start, end } = readWhen();
  if (!(end > start)) { toast('종료가 시작보다 늦어야 합니다'); return; }
  const tz = allDay ? TZ_SEOUL : form.tz.value || TZ_SEOUL;
  const rem = readAlerts();
  const e = {
    ...orig,
    title: (parsed ? parsed.title : form.title.value.trim()) || '새 일정',
    calendarId: form.calendarId.value,
    allDay, start, end,
    location: form.location.value.trim() || parsed?.location || '',
    note: form.note.value || parsed?.note || '',
    url: form.url.value.trim() || parsed?.url || (orig.url ? '' : undefined),
    // 알림을 안 건드렸으면 원래 값(없으면 보내지 않아 구글 쪽 그대로)
    reminder: String(rem) === ed.reminder ? orig.reminder : rem,
    // 바쁨/한가함: 바꿨을 때만 보낸다
    free: (form.avail.value === 'free') !== !!orig.free ? form.avail.value === 'free' : orig.free,
    tz: tz === TZ_SEOUL ? undefined : tz,
    ...(form.addMeet.checked && !orig.meet ? { addMeet: true } : {}),
  };
  if (e.url === undefined) delete e.url;
  // 참석자: 제목에 적은 이메일도 더한다. 바꿨을 때만 구글에 보낸다
  if (parsed?.attendees?.length) for (const email of parsed.attendees) if (!ed.attendees.some((a) => a.email === email)) { ed.attendees.push({ email, status: 'needsAction' }); ed.attTouched = true; }
  if (ed.attTouched) { e.attendees = ed.attendees; e.attendeesChanged = true; e.notify = form.notify.checked; }
  // 반복
  const rule = ed.ruleLoaded ? readRule(start) : null;
  const keepUnknown = form.repeat.value === 'custom' && ed.customRule?.unknown && !ed.repTouched;
  const newRec = keepUnknown ? ed.ruleRaw.split('\n') : rule ? [buildRRule(rule, allDay)] : null;
  const recChanged = ed.ruleLoaded && (newRec ? newRec.join('\n') : '') !== ed.ruleRaw;
  $('#edSave').disabled = true;
  try {
    let saved;
    let refetch = false;
    if (isNew) {
      if (newRec) { e.recurrence = newRec; refetch = true; }
      saved = await guarded(() => createEvent(e));
    } else if (orig.recurringEventId) {
      // 반복 회차: 이 일정만 / 이후 모든 일정
      const mode = await ask({
        title: '반복 일정 저장',
        msg: recChanged ? '반복 규칙을 바꾸면 이 일정부터 이후 모든 일정에 적용됩니다.' : '어느 일정에 저장할까요?',
        items: recChanged ? [{ label: '이후 모든 일정에 저장', value: 'following' }]
          : [{ label: '이 일정만 저장', value: 'one' }, { label: '이후 모든 일정에 저장', value: 'following' }],
      });
      if (!mode) return;
      if (mode === 'one') saved = await guarded(() => updateEvent(e, orig.calendarId));
      else { saved = await saveFollowing(orig, e, newRec); refetch = true; }
    } else {
      if (recChanged) { e.recurrence = newRec || []; refetch = true; }
      saved = await guarded(() => updateEvent(e, orig.calendarId));
    }
    if (!saved) return;
    dlg.close();
    if (refetch) searchPool = null;
    await render({ refetch });
    flash(saved.id);
    if (isNew) toast('일정을 추가했습니다', { label: '실행 취소', run: async () => { await guarded(() => removeEvent(saved)); searchPool = null; render({ refetch }); } });
    else if (refetch) toast('일정을 수정했습니다');
    else toast('일정을 수정했습니다', { label: '실행 취소', run: async () => { const back = await guarded(() => updateEvent({ ...orig, ...(orig.attendees ? { attendeesChanged: !!e.attendeesChanged } : {}) }, saved.calendarId)); if (back) { await render(); flash(back.id); } } });
  } finally {
    $('#edSave').disabled = false;
  }
});

/** 반복 일정 「이후 모든 일정」 저장. 첫 회차면 원본을 고치고, 아니면 원본을 이 회차 앞에서 끝낸 뒤 새 반복을 만든다 */
async function saveFollowing(orig, e, newRec) {
  return guarded(async () => {
    const m = editing.master || await S.store.get(orig.calendarId, orig.recurringEventId, calById(orig.calendarId));
    const first = (orig.originalStart ?? orig.start) <= m.start;
    if (first) {
      const body = { ...copyOf(e), id: m.id, calendarId: m.calendarId || orig.calendarId };
      if (e.attendeesChanged) { body.attendees = e.attendees; body.attendeesChanged = true; }
      if (newRec) return S.store.update({ ...body, recurrence: newRec }, calById(body.calendarId), body.calendarId);
      // 반복을 끄면: 원본을 지우고 단일 일정으로
      await S.store.remove({ ...m, calendarId: body.calendarId });
      return S.store.create(body, calById(body.calendarId));
    }
    await S.store.removeFollowing(orig);
    const body = { ...copyOf(e), ...(newRec ? { recurrence: newRec } : {}) };
    if (e.attendeesChanged || orig.attendees) { body.attendees = e.attendees || orig.attendees; body.attendeesChanged = true; }
    return S.store.create(body, calById(body.calendarId));
  });
}

/** 삭제(확인 후) + 되돌리기. 편집 창·오른쪽 클릭 메뉴가 같이 쓴다 */
async function deleteEvent(e) {
  if (e.readOnly) { toast('읽기 전용 캘린더의 일정은 지울 수 없습니다'); return false; }
  const guests = (e.attendees || []).some((a) => !a.self);
  // 되돌리기 어려운 동작이라 늘 확인창을 거친다. 반복 일정은 이 일정만 / 이후 모든 일정
  const mode = await ask({
    title: '삭제할까요?',
    msg: `‘${e.title}’ · ${eventText(e, false).split('\n')[1]}${e.recurringEventId ? '\n반복 일정입니다.' : ''}`,
    items: e.recurringEventId
      ? [{ label: '이 일정만 삭제', value: 'one', danger: true }, { label: '이후 모든 일정 삭제', value: 'following', danger: true }]
      : [{ label: '삭제', value: 'one', danger: true }],
    check: guests ? '참석자에게 취소 메일 보내기' : '',
  });
  if (!mode) return false;
  const notify = guests && askChecked();
  if (mode === 'following') {
    const info = await guarded(() => S.store.removeFollowing(e));
    if (!info) return false;
    searchPool = null;
    await render({ refetch: true });
    toast(info.deletedAll ? '반복 일정을 모두 삭제했습니다' : '이 일정부터 이후 반복을 삭제했습니다', info.masterId ? {
      label: '되돌리기',
      run: async () => { await guarded(() => S.store.setRecurrence(e.calendarId, info.masterId, info.prev)); searchPool = null; render({ refetch: true }); },
    } : null);
    return true;
  }
  const ok = await guarded(async () => { await removeEvent({ ...e, notify }); return true; });
  if (!ok) return false;
  render();
  toast('일정을 삭제했습니다', {
    label: '되돌리기',
    run: e.recurringEventId
      ? async () => { await guarded(() => S.store.restoreInstance(e)); searchPool = null; render({ refetch: true }); }
      : async () => { await guarded(() => createEvent({ ...copyOf(e), ...(e.attendees ? { attendees: e.attendees, attendeesChanged: true } : {}) })); render(); },
  });
  return true;
}
/** 새로 만들 때 쓸 사본(구글 쪽 id·링크·반복 표시는 뺀다) */
function copyOf(e, patch = {}) {
  // 반복 회차 표시·화상회의 링크·참석자(복제해도 초대가 나가지 않게)는 빼고 만든다
  const { id, link, recurring, readOnly, recurringEventId, originalStart, recurrence, exdates, meet, attendees, ...rest } = e;
  void id; void link; void recurring; void readOnly; void recurringEventId; void originalStart; void recurrence; void exdates; void meet; void attendees;
  return { ...rest, ...patch };
}
$('#edDelete').addEventListener('click', async () => {
  if (await deleteEvent(editing.event)) dlg.close();
});

function newEventAt(start, allDay = false) {
  const cal = defaultCal();
  if (!cal) { toast('일정을 넣을 수 있는 캘린더가 없습니다'); return; }
  openEditor({
    id: null, calendarId: cal.id, title: '', allDay,
    start, end: allDay ? start + DAY : start + 3600e3, location: '', note: '',
  }, true);
}
function nextHour() {
  const p = P(Date.now());
  return T(p.y, p.m, p.d, p.h + 1);
}

/* ---------- 할 일 (Google Tasks) 화면 ---------- */

/** 마감일 말: 오늘 / 내일 / 어제 / 11월 14일 (토) */
function dueLabel(d, today) {
  if (d === today) return '오늘';
  if (d === today + DAY) return '내일';
  if (d === today - DAY) return '어제';
  return fmtDate(d, P(d).y !== P(today).y);
}
const listName = (id) => S.taskLists.find((l) => l.id === id)?.title || '';

/** 할 일 한 줄: 체크 상자 + 제목(+ 마감일·목록). kind: m-task(휴대폰 목록) sa-task(데스크톱 왼쪽) ag-task(목록 보기) tp-task(할 일 화면) */
function taskRowHTML(t, kind, today) {
  const over = !t.done && t.due != null && t.due < today;
  const meta = kind === 'tp-task'
    // 할 일 화면: 「오늘」「내일」 묶음 안에서는 마감일을 다시 쓰지 않는다
    ? [t.due != null && (t.done || t.due < today || t.due > today + DAY) ? dueLabel(t.due, today) : '', S.taskLists.length > 1 ? listName(t.listId) : ''].filter(Boolean).join(' · ')
    : over ? `${dueLabel(t.due, today)} 마감` : '';
  return `<div class="tsk ${kind}${t.done ? ' done' : ''}${over ? ' over' : ''}" data-task="${esc(t.id)}" role="button" tabindex="0" style="--c:${taskColor()}"${tipAttr(taskTip(t))}>
    <button type="button" class="tsk-box" data-tcheck="${esc(t.id)}" role="checkbox" aria-checked="${t.done}" aria-label="${t.done ? '완료 취소' : '완료로 표시'}"></button>
    <span class="tsk-title">${esc(t.title || '(제목 없음)')}</span>${meta ? `<span class="tsk-meta">${esc(meta)}</span>` : ''}
  </div>`;
}

const TP_SECS = [['overdue', '지난 마감'], ['today', '오늘'], ['tomorrow', '내일'], ['later', '예정'], ['none', '마감일 없음']];
function tasksPanelInner() {
  if (S.tasksState === 'need-scope') {
    return `<div class="tp-msg"><p>할 일(Google Tasks)을 보려면 구글 권한을 한 번 더 허용해 주세요. 캘린더 연결은 그대로입니다.</p>
      <button type="button" class="btn primary" data-act="tasks-consent">Google 할 일 권한 허용</button></div>`;
  }
  if (S.tasksState === 'disabled') {
    return `<div class="tp-msg"><p>구글 클라우드 프로젝트(jbs-calendar)에서 Google Tasks API 가 아직 꺼져 있습니다. 사용 설정 뒤 다시 시도하면 보입니다.</p>
      <button type="button" class="btn" data-act="tasks-retry">다시 시도</button></div>`;
  }
  if (S.tasksState === 'error') {
    return `<div class="tp-msg"><p>할 일을 불러오지 못했습니다. ${esc(S.tasksErr)}</p><button type="button" class="btn" data-act="tasks-retry">다시 시도</button></div>`;
  }
  if (S.tasksState !== 'ok') return '<div class="tp-msg"><p>할 일을 불러오는 중…</p></div>';
  const today = startOfDay(Date.now());
  const g = groupTasks(S.tasks, today);
  let html = '';
  for (const [k, label] of TP_SECS) {
    if (!g[k].length) continue;
    html += `<section class="tp-sec tp-${k}"><h3 class="tp-h">${label}<span>${g[k].length}</span></h3>${g[k].map((t) => taskRowHTML(t, 'tp-task', today)).join('')}</section>`;
  }
  if (!html) html = '<div class="tp-msg"><p>남은 할 일이 없습니다.</p></div>';
  if (g.doneTotal) {
    html += `<section class="tp-sec tp-done"><h3 class="tp-h"><button type="button" class="tp-more" data-act="tasks-done-toggle">완료됨 ${g.doneTotal}개 ${S.showDone ? '숨기기' : '보기'}</button></h3>
      ${S.showDone ? g.done.map((t) => taskRowHTML(t, 'tp-task', today)).join('') : ''}</section>`;
  }
  return html;
}

/** 할 일 화면(휴대폰 시트·데스크톱 왼쪽)을 그린다. 입력칸은 처음 한 번만 만들어 쓰던 글자가 지워지지 않게 한다 */
function renderTasks() {
  const lists = S.taskLists.map((l) => `<option value="${esc(l.id)}">${esc(l.title)}</option>`).join('');
  const pick = S.taskLists.some((l) => l.id === localStorage.getItem(K_TLIST)) ? localStorage.getItem(K_TLIST) : S.taskLists[0]?.id;
  document.querySelectorAll('.tp-host').forEach((host) => {
    if (!host.querySelector('.tp-add')) {
      host.innerHTML = `<form class="tp-add" autocomplete="off">
          <span class="tsk-box" aria-hidden="true"></span>
          <input name="t" type="text" enterkeyhint="done" placeholder="새 할 일 · 예) 내일 보고서 제출" aria-label="새 할 일">
          <select name="list" aria-label="넣을 목록"></select>
        </form><div class="tp-list"></div>`;
    }
    const sel = host.querySelector('select[name=list]');
    if (sel.dataset.sig !== lists) { sel.innerHTML = lists; sel.dataset.sig = lists; }
    if (pick && sel.value !== pick) sel.value = pick;
    sel.hidden = S.taskLists.length < 2;
    host.querySelector('.tp-add').hidden = S.tasksState !== 'ok';
    host.querySelector('.tp-list').innerHTML = tasksPanelInner();
  });
  // 데스크톱 왼쪽 「일정 | 할 일」
  $('#sbEvTab').classList.toggle('on', S.sbTab === 'ev');
  $('#sbTasksTab').classList.toggle('on', S.sbTab === 'tasks');
  $('#sbEvTab').setAttribute('aria-selected', String(S.sbTab === 'ev'));
  $('#sbTasksTab').setAttribute('aria-selected', String(S.sbTab === 'tasks'));
  $('#sidebar').classList.toggle('tasks-tab', S.sbTab === 'tasks');
  $('#sbTasks').hidden = S.sbTab !== 'tasks';
}

/** 다시 동의 안내 띠: 할 일 권한이 없는 기존 연결(구글 모드)에서, 「나중에」를 누르기 전까지 */
function syncAsk() {
  $('#askBanner').hidden = !(useGoogle && !S.needsLogin && S.tasksState === 'need-scope' && localStorage.getItem(K_ASK) !== '1');
}

/** 할 일 저장 도우미: 권한·API 문제면 화면 상태도 바꾼다 */
async function guardedTask(fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn('할 일 저장:', err.message);
    if (err instanceof ScopeError) { S.tasksState = 'need-scope'; render(); toast('할 일 권한을 한 번 더 허용해 주세요'); }
    else if (err instanceof ApiDisabledError) { S.tasksState = 'disabled'; render(); toast('Google Tasks API 가 꺼져 있습니다'); }
    else if (err instanceof AuthError) { handleError(err); toast('로그인이 필요합니다'); }
    else toast('할 일을 저장하지 못했습니다');
    return null;
  }
}
const putTask = (t) => { S.tasks = S.tasks.some((x) => x.id === t.id) ? S.tasks.map((x) => (x.id === t.id ? t : x)) : [...S.tasks, t]; };

async function toggleTask(id) {
  const t = S.tasks.find((x) => x.id === id);
  if (!t) return;
  const next = { ...t, done: !t.done, completed: t.done ? null : Date.now() };
  putTask(next); // 먼저 화면에 반영하고, 실패하면 되돌린다
  render();
  const saved = await guardedTask(() => S.tStore.update(next, t.listId));
  putTask(saved || t);
  render();
  if (saved && saved.done) toast(`‘${t.title}’ 완료`, { label: '되돌리기', run: () => toggleTask(id) });
}

async function addTask(text, listId) {
  // 「내일 보고서 제출」 → 마감일 내일. 날짜·시각 말이 없으면 마감일 없음
  const r = parseQuick(text, Date.now(), { baseDay: null });
  let title = text;
  let due = null;
  if (r.hasDate || r.hasTime) {
    title = [r.title, r.location && `@${r.location}`].filter(Boolean).join(' ') || text;
    due = startOfDay(r.start);
  }
  const saved = await guardedTask(() => S.tStore.create({ listId, title, notes: '', due, done: false }));
  if (!saved) return null;
  putTask(saved);
  render();
  toast(`할 일 추가 · ${saved.title}${due != null ? ` · ${dueLabel(due, startOfDay(Date.now()))}` : ''}`, {
    label: '실행 취소',
    run: async () => { await guardedTask(() => S.tStore.remove(saved)); S.tasks = S.tasks.filter((x) => x.id !== saved.id); render(); },
  });
  return saved;
}
document.addEventListener('submit', async (ev) => {
  const f = ev.target.closest?.('.tp-add');
  if (!f) return;
  ev.preventDefault();
  const v = f.t.value.trim();
  if (!v || S.tasksState !== 'ok') return;
  const listId = f.list.value || S.taskLists[0]?.id;
  localStorage.setItem(K_TLIST, listId);
  f.t.value = '';
  if (!(await addTask(v, listId))) f.t.value = v;
});
document.addEventListener('change', (ev) => {
  if (ev.target.matches?.('.tp-add select')) localStorage.setItem(K_TLIST, ev.target.value);
});

// 할 일 편집 창
const tdlg = $('#taskEditor');
const tform = $('#taskForm');
let tEditing = null;
function openTaskEditor(t) {
  tEditing = t;
  tform.listId.innerHTML = S.taskLists.map((l) => `<option value="${esc(l.id)}">${esc(l.title)}</option>`).join('');
  tform.listId.value = t.listId;
  tform.title.value = t.title;
  tform.hasDue.checked = t.due != null;
  tform.due.value = dayKey(t.due ?? S.selDay ?? startOfDay(Date.now()));
  tform.done.checked = t.done;
  tform.notes.value = t.notes || '';
  $('#tfLink').hidden = !t.link;
  if (t.link) $('#tfLink').href = t.link;
  syncTaskEditor();
  tdlg.showModal();
}
function syncTaskEditor() {
  $('#tfDueRow').hidden = !tform.hasDue.checked;
  $('#tfBox').style.setProperty('--c', taskColor());
  $('#tfBox').classList.toggle('on', tform.done.checked);
}
tform.hasDue.addEventListener('change', syncTaskEditor);
tform.done.addEventListener('change', syncTaskEditor);
$('#tfCancel').onclick = () => tdlg.close();
tdlg.addEventListener('click', (ev) => { if (ev.target === tdlg) tdlg.close(); });
tform.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const orig = tEditing;
  const done = tform.done.checked;
  const next = {
    ...orig,
    title: tform.title.value.trim() || orig.title || '할 일',
    listId: tform.listId.value,
    due: tform.hasDue.checked && tform.due.value ? fromDayKey(tform.due.value) : null,
    done,
    completed: done ? (orig.completed || Date.now()) : null,
    notes: tform.notes.value,
  };
  $('#tfSave').disabled = true;
  const saved = await guardedTask(() => S.tStore.update(next, orig.listId));
  $('#tfSave').disabled = false;
  if (!saved) return;
  putTask(saved);
  tdlg.close();
  render();
  toast('할 일을 수정했습니다');
});
$('#tfDelete').onclick = async () => { if (await deleteTask(tEditing)) tdlg.close(); };
/** 할 일 삭제(확인 후) + 되돌리기 */
async function deleteTask(t) {
  if (await ask({ title: '삭제할까요?', msg: `‘${t.title || '(제목 없음)'}’ 할 일`, items: [{ label: '삭제', value: 'ok', danger: true }] }) !== 'ok') return false;
  const ok = await guardedTask(async () => { await S.tStore.remove(t); return true; });
  if (!ok) return false;
  S.tasks = S.tasks.filter((x) => x.id !== t.id);
  render();
  toast('할 일을 삭제했습니다', {
    label: '되돌리기',
    run: async () => {
      const { id, link, ...rest } = t;
      void id; void link;
      const back = await guardedTask(() => S.tStore.create(rest));
      if (back) { putTask(back); render(); }
    },
  });
  return true;
}

/** 휴대폰: ☰ → 할 일 (어두운 전체 화면) */
function openTasks() {
  if (S.needsLogin) return;
  closeMenu();
  closeSearch();
  document.body.classList.add('tasks-open');
  renderTasks();
  ensureTasks(true).then(() => render());
}
function closeTasks() {
  document.body.classList.remove('tasks-open');
  document.activeElement?.blur?.();
}
$('#mTasksBtn').onclick = openTasks;
$('#tasksDone').onclick = closeTasks;
$('#sbTabs').onclick = (ev) => {
  const b = ev.target.closest('[data-sbtab]');
  if (!b) return;
  S.sbTab = b.dataset.sbtab;
  localStorage.setItem(K_SBTAB, S.sbTab);
  renderTasks();
  if (S.sbTab === 'tasks') ensureTasks(true).then(() => render());
};

/* ---------- 날짜가 바뀌었거나 오래 쉬었다 열면 오늘로 ---------- */
// 아이폰 홈 화면 앱은 닫아도 메모리에 남아 있다가 그대로 다시 열린다 → 어제 고른 날이 남지 않게 한다.
const AWAY_RESET = 5 * 60e3; // 5분 넘게 다른 앱에 있다가 돌아오면 「새로 연 것」으로 본다
let lastToday = startOfDay(Date.now());
let hiddenAt = 0;
function backToTodayIfStale() {
  const today = startOfDay(Date.now());
  const dayChanged = today !== lastToday;
  const away = hiddenAt > 0 && Date.now() - hiddenAt >= AWAY_RESET;
  lastToday = today;
  if (!dayChanged && !away) return false;
  // 입력 중이면 건드리지 않는다
  if (dlg.open || tdlg.open || document.body.classList.contains('quick-open')) return false;
  S.cursor = today;
  S.selDay = null;
  S.miniMonth = startOfMonth(today);
  S.jump = true;
  syncQuickHint();
  return true;
}

/* ---------- 이벤트 연결 ---------- */

function setView(v) {
  S.view = v;
  S.jump = true;
  localStorage.setItem(K_VIEW, v);
  render();
}
function go(dir) {
  const c = S.cursor;
  const view = effView();
  if (view === 'month') S.cursor = addMonths(c, dir);
  else if (view === 'quarter') S.cursor = addMonths(startOfQuarter(c), 3 * dir);
  else if (view === 'year') S.cursor = addMonths(startOfYear(c), 12 * dir);
  else if (view === 'week') S.cursor = c + dir * (mq.matches ? 3 : 7) * DAY;
  else if (view === 'list') S.cursor = startOfDay(c) + dir * 7 * DAY;
  else { S.cursor = c + dir * DAY; S.selDay = startOfDay(S.cursor); syncQuickHint(); } // 일 보기: 보이는 날 = 고른 날
  S.miniMonth = startOfMonth(S.cursor);
  S.jump = true;
  render();
}
function goToday() {
  S.cursor = startOfDay(Date.now());
  S.selDay = null;
  syncQuickHint();
  S.miniMonth = startOfMonth(S.cursor);
  S.jump = true;
  render();
}
function selectDay(d) {
  S.cursor = d;
  S.selDay = d;
  if (P(d).m !== P(S.miniMonth).m) S.miniMonth = startOfMonth(d);
  S.jump = true;
  syncQuickHint();
  render();
}

/** 날짜 고르기: 화면을 다시 그리지 않고 표시만 바꾼다.
 *  (다시 그리면 두 번째 클릭이 새 칸에 떨어져 브라우저가 더블클릭으로 치지 않는다) */
function setSel(d) {
  S.selDay = d;
  const key = d == null ? '' : dayKey(d);
  document.querySelectorAll('.mv-cell[data-day], .mc-day[data-day], .tg-dh[data-day], .tg-col[data-day], .qv-cell[data-day], .yv-day[data-day]')
    .forEach((el) => el.classList.toggle('sel', el.dataset.day === key));
  syncQuickHint();
}

/** 빠른 입력 안내 글: 고른 날이 오늘이 아니면 그 날짜를 보여 준다 */
const QUICK_PH = quick.placeholder;
function syncQuickHint() {
  const d = S.selDay;
  if (d == null || d === startOfDay(Date.now())) quick.placeholder = QUICK_PH;
  else { const p = P(d); quick.placeholder = `빠른 입력 · ${p.m + 1}월 ${p.d}일 (${WD[p.dow]}): 회의 오후 3시 @본관`; }
  if (quick.value.trim()) quick.dispatchEvent(new Event('input'));
}

/* ---------- 휴대폰: ☰ 캘린더·설정 시트, 검색 ---------- */

function openMenu() {
  if (S.needsLogin) return;
  closeSearch();
  const v = effView();
  $('#mViewBtn').textContent = v === 'list' ? '3일 보기' : '목록 보기';
  $('#mDayBtn').textContent = v === 'day' ? '목록 보기' : '일 보기';
  document.body.classList.add('menu-open');
}
function closeMenu() { document.body.classList.remove('menu-open'); }

// 검색: 열 때 앞뒤로 넓게(6달 전 ~ 1년 뒤) 한 번 불러와 제목·장소·메모에서 찾는다
let searchPool = null;
async function openSearch() {
  if (S.needsLogin) return;
  closeMenu();
  document.body.classList.add('search-open');
  const inp = $('#searchInput');
  inp.focus();
  runSearch();
  if (await loadPool()) runSearch();
}
/** 검색용 일정(6달 전 ~ 1년 뒤)을 5분에 한 번 불러온다. 새로 불러왔으면 true */
async function loadPool() {
  if (searchPool && Date.now() - searchPool.at < 5 * 60e3) return false;
  const today = startOfDay(Date.now());
  try {
    const evs = await S.store.events(S.cals, addMonths(startOfMonth(today), -6), addMonths(startOfMonth(today), 13));
    searchPool = { at: Date.now(), evs };
    return true;
  } catch (err) { handleError(err); return false; }
}
/** 불러온 일정(검색용 + 화면용)에서 제목·장소·메모로 찾기. 같은 일정은 한 번만, 화면용 S.events 우선 */
function searchHits(q) {
  const byId = new Map();
  for (const e of [...(searchPool?.evs || []), ...S.events]) byId.set(e.id, e);
  return [...byId.values()]
    .filter((e) => !S.hidden.has(e.calendarId) && !S.hiddenEv.has(e.id)
      && [e.title, e.location, e.note].some((t) => (t || '').toLowerCase().includes(q)))
    .sort((a, b) => a.start - b.start);
}
function closeSearch() {
  document.body.classList.remove('search-open');
  $('#searchInput').blur();
  $('#dSearchPop').hidden = true;
}
function runSearch() {
  const q = $('#searchInput').value.trim().toLowerCase();
  const box = $('#searchList');
  if (!q) { box.innerHTML = '<div class="ms-hint">제목·장소·메모로 찾습니다</div>'; return; }
  const hits = searchHits(q);
  if (!hits.length) { box.innerHTML = `<div class="ms-hint">‘${esc(q)}’ 일정이 없습니다</div>`; return; }
  const now = Date.now();
  const today = startOfDay(now);
  const days = new Map();
  hits.slice(0, 200).forEach((e) => { const d = startOfDay(e.start); if (!days.has(d)) days.set(d, []); days.get(d).push(e); });
  let html = '';
  for (const [d, evs] of days) {
    html += `<section class="ag-day m-day${d === today ? ' today' : ''}" data-sdate="${dayKey(d)}"><h3 class="ag-h">${mDayLabel(d, today)}</h3>${mEventsHTML(evs.sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start)), d, now)}</section>`;
  }
  box.innerHTML = html;
  // 지난 일정도 찾되, 처음에는 오늘 이후 첫 결과가 맨 위에 오게
  const next = [...box.querySelectorAll('[data-sdate]')].find((el) => fromDayKey(el.dataset.sdate) >= today);
  box.scrollTop = next ? next.offsetTop - box.offsetTop : box.scrollHeight;
}
$('#searchInput').addEventListener('input', runSearch);
$('#searchCancel').onclick = () => { $('#searchInput').value = ''; closeSearch(); };


/* ---------- 데스크톱: 오른쪽 위 검색 ---------- */

async function runDSearch() {
  const q = $('#dSearch').value.trim().toLowerCase();
  const pop = $('#dSearchPop');
  const box = $('#dSearchList');
  if (!q) { pop.hidden = true; return; }
  pop.hidden = false;
  const hits = searchHits(q);
  if (!hits.length) box.innerHTML = `<div class="ds-hint">‘${esc(q)}’ 일정이 없습니다</div>`;
  else {
    const now = Date.now();
    const today = startOfDay(now);
    const days = new Map();
    hits.slice(0, 200).forEach((e) => { const d = startOfDay(e.start); if (!days.has(d)) days.set(d, []); days.get(d).push(e); });
    let html = '';
    for (const [d, evs] of days) {
      html += `<section class="ag-day${d === today ? ' today' : ''}" data-sdate="${dayKey(d)}"><h3 class="ag-h">${esc(fmtDayHeading(d, now))}${P(d).y !== P(today).y ? ` ${P(d).y}` : ''}</h3>`;
      for (const e of evs) {
        html += `<button class="ag-ev${!e.allDay && e.end < now ? ' past' : ''}" data-id="${esc(e.id)}" style="--c:${colorOf(e)}"${tipAttr(evTip(e))}>
          <span class="ag-time">${e.allDay ? '종일' : fmtTime(e.start)}</span><span class="ag-bar"></span>
          <span class="ag-body"><span class="ag-title">${esc(e.title)}</span>${e.location ? `<span class="ag-loc">${esc(e.location)}</span>` : ''}</span>
        </button>`;
      }
      html += '</section>';
    }
    box.innerHTML = html;
    const next = [...box.querySelectorAll('[data-sdate]')].find((el) => fromDayKey(el.dataset.sdate) >= today);
    pop.scrollTop = next ? next.getBoundingClientRect().top - box.getBoundingClientRect().top : pop.scrollHeight;
  }
  if (await loadPool() && $('#dSearch').value.trim().toLowerCase() === q) runDSearch();
}
$('#dSearch').addEventListener('input', runDSearch);
$('#dSearch').addEventListener('focus', () => { if ($('#dSearch').value.trim()) runDSearch(); });
$('#dSearch').addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { $('#dSearch').value = ''; $('#dSearchPop').hidden = true; $('#dSearch').blur(); }
});

/* ---------- 데스크톱: 왼쪽 아래 캘린더 묶음 창 ---------- */

function toggleCalPanel(open = !document.body.classList.contains('cals-open')) {
  document.body.classList.toggle('cals-open', open);
}
$('#calSetBtn').onclick = () => toggleCalPanel();
$('#allCals').addEventListener('change', (ev) => {
  // 하나라도 꺼져 있으면 모두 켜고, 모두 켜져 있으면 모두 끈다
  const showAll = ev.target.checked;
  const keepTasks = S.hidden.has(TASKS_KEY) ? [TASKS_KEY] : []; // 할 일 켜기·끄기는 따로 둔다
  S.hidden = new Set([...keepTasks, ...(showAll ? [] : S.cals.map((c) => c.id))]);
  localStorage.setItem(K_HIDDEN, JSON.stringify([...S.hidden]));
  render();
});
$('#weekStartSel').addEventListener('change', (ev) => {
  S.weekStart = +ev.target.value;
  localStorage.setItem(K_WS, String(S.weekStart));
  S.mvFrom = null; S.mcFrom = null; S.jump = true;
  render();
});
$('#unhideBtn').onclick = () => {
  const n = S.hiddenEv.size;
  S.hiddenEv.clear();
  localStorage.removeItem(K_HIDEV);
  render();
  toast(`숨긴 일정 ${n}개를 다시 보입니다`);
};

/* ---------- 오른쪽 클릭 메뉴 (데스크톱) ---------- */

// 구글 일정 색 이름(colorId 1~11)
const COLOR_NAMES = { 1: '라벤더', 2: '세이지', 3: '포도', 4: '플라밍고', 5: '바나나', 6: '귤', 7: '공작', 8: '흑연', 9: '블루베리', 10: '바질', 11: '토마토' };
let ctxActs = [];

/** items: {label, act, sub, disabled, checked, dot, sep, hint} */
function menuHTML(items) {
  return items.map((it) => {
    if (it.sep) return '<div class="ctx-sep"></div>';
    const k = ctxActs.push(it.act || null) - 1;
    const cls = ['ctx-i', it.disabled && 'off', it.sub && 'has-sub'].filter(Boolean).join(' ');
    const mark = it.checked ? '<span class="ctx-ck">✓</span>' : '<span class="ctx-ck"></span>';
    const dot = it.dot ? `<i class="ctx-dot" style="background:${it.dot}"></i>` : '';
    return `<div class="${cls}" role="menuitem" data-k="${k}"${it.disabled ? ' aria-disabled="true"' : ''}${it.hint ? ` title="${esc(it.hint)}"` : ''}>${mark}${dot}<span class="ctx-l">${esc(it.label)}</span>${it.sub ? '<span class="ctx-arr">›</span>' : ''}${it.sub && !it.disabled ? `<div class="ctx ctx-sub" role="menu">${menuHTML(it.sub)}</div>` : ''}</div>`;
  }).join('');
}
function openCtx(x, y, items) {
  closeCtx();
  ctxActs = [];
  const m = document.createElement('div');
  m.className = 'ctx';
  m.id = 'ctx';
  m.setAttribute('role', 'menu');
  m.innerHTML = menuHTML(items);
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 6)}px`;
  m.style.top = `${Math.min(y, innerHeight - r.height - 6)}px`;
  // 하위 메뉴가 화면 오른쪽 밖으로 나가면 왼쪽으로 연다
  if (x + r.width * 2 + 10 > innerWidth) m.classList.add('flip');
}
function closeCtx() { $('#ctx')?.remove(); }

function pick(id) {
  S.picked = id;
  document.querySelectorAll('.picked').forEach((n) => n.classList.remove('picked'));
  if (id) document.querySelectorAll(`.chip[data-id="${CSS.escape(id)}"], .mv-bar[data-id="${CSS.escape(id)}"], .qv-ev[data-id="${CSS.escape(id)}"], .tg-ev[data-id="${CSS.escape(id)}"]`).forEach((n) => n.classList.add('picked'));
}

/** 일정 속성 바꾸기(캘린더 이동·색·보기 방식·공개 범위) */
async function patchEvent(e, patch, msg) {
  const saved = await guarded(() => updateEvent({ ...e, ...patch }, e.calendarId));
  if (!saved) return;
  await render();
  flash(saved.id);
  toast(msg);
}

function eventMenu(e) {
  const ro = !!e.readOnly;
  const roHint = ro ? '읽기 전용 캘린더의 일정입니다' : '';
  const cals = writableCals();
  return [
    { label: '캘린더', disabled: ro || e.recurring || cals.length < 2,
      hint: ro ? roHint : e.recurring ? '반복 일정은 다른 캘린더로 옮길 수 없습니다(구글 제한)' : '',
      sub: cals.map((c) => ({ label: c.name, dot: c.color, checked: c.id === e.calendarId,
        act: () => c.id !== e.calendarId && guarded(() => updateEvent({ ...e, calendarId: c.id }, e.calendarId))
          .then((sv) => { if (sv) { render().then(() => flash(sv.id)); toast(`‘${c.name}’ 캘린더로 옮겼습니다`); } }) })) },
    { label: '색상', disabled: ro, hint: roHint,
      sub: [{ label: '캘린더 색', dot: calById(e.calendarId)?.color, checked: !e.colorId,
        act: () => patchEvent(e, { colorId: null, color: null }, '캘린더 색으로 되돌렸습니다') },
      ...Object.entries(EVENT_COLORS).map(([id, hex]) => ({ label: COLOR_NAMES[id], dot: hex, checked: e.colorId === id,
        act: () => patchEvent(e, { colorId: id, color: hex }, `색을 ‘${COLOR_NAMES[id]}’(으)로 바꿨습니다`) }))] },
    { label: '보기 방식', disabled: ro, hint: roHint,
      sub: [{ label: '바쁨', checked: !e.free, act: () => patchEvent(e, { free: false }, '바쁨으로 표시합니다') },
        { label: '한가함', checked: !!e.free, act: () => patchEvent(e, { free: true }, '한가함으로 표시합니다') }] },
    { label: '공개 범위', disabled: ro, hint: roHint,
      sub: [['default', '캘린더 기본값'], ['public', '공개'], ['private', '비공개']].map(([v, l]) => ({
        label: l, checked: (e.visibility || 'default') === v,
        act: () => patchEvent(e, { visibility: v }, `공개 범위: ${l}`) })) },
    { sep: true },
    { label: '잘라내기', disabled: ro, hint: roHint || '날짜를 고른 뒤 ⌘V(Ctrl+V)로 옮깁니다',
      act: () => { S.clip = { e, cut: true }; toast('잘라냈습니다 · 옮길 날짜를 누르고 ⌘V(Ctrl+V)'); } },
    { label: '복사', hint: '날짜를 고른 뒤 ⌘V(Ctrl+V)로 붙여넣습니다',
      act: () => { S.clip = { e, cut: false }; navigator.clipboard?.writeText(eventText(e)).catch(() => {}); toast('복사했습니다 · 날짜를 누르고 ⌘V(Ctrl+V)로 붙여넣기'); } },
    { label: '복제', disabled: !defaultCal(), act: () => duplicateEvent(e) },
    { label: '다른 날로 옮기기…', disabled: ro, hint: roHint, act: () => moveEventAsk(e) },
    { label: '템플릿으로 저장', hint: '빠른 입력 창에서 골라 쓰는 일정 틀', act: () => saveTemplate(e) },
    { label: '삭제', disabled: ro, hint: roHint, act: () => deleteEvent(e) },
    { label: '숨기기', hint: '이 기기 화면에서만 감춥니다(구글에는 그대로)', act: () => hideEvent(e) },
    { sep: true },
    { label: '이메일로 보내기', act: () => { location.href = `mailto:?subject=${encodeURIComponent(e.title)}&body=${encodeURIComponent(eventText(e))}`; } },
  ];
}
function eventText(e, withNote = true) {
  const when = e.allDay
    ? `${fmtDate(e.start, true)}${e.end - e.start > DAY ? ` – ${fmtDate(e.end - DAY, true)}` : ''} (종일)`
    : `${fmtDate(e.start, true)} ${fmtTime(e.start)} – ${sameDay(e.start, e.end - 1) ? '' : `${fmtDate(e.end)} `}${fmtTime(e.end)}`;
  return [e.title, when, e.location && `장소: ${e.location}`, withNote && e.note].filter(Boolean).join('\n');
}
async function duplicateEvent(e) {
  const cal = e.readOnly ? defaultCal() : calById(e.calendarId);
  const saved = await guarded(() => createEvent(copyOf(e, { calendarId: cal.id })));
  if (!saved) return;
  await render();
  flash(saved.id);
  toast(`‘${saved.title}’ 복제했습니다`, { label: '실행 취소', run: async () => { await guarded(() => removeEvent(saved)); render(); } });
}
function hideEvent(e) {
  S.hiddenEv.add(e.id);
  localStorage.setItem(K_HIDEV, JSON.stringify([...S.hiddenEv]));
  render();
  toast(`‘${e.title}’ 숨김 (이 기기만)`, { label: '되돌리기', run: () => { S.hiddenEv.delete(e.id); localStorage.setItem(K_HIDEV, JSON.stringify([...S.hiddenEv])); render(); } });
}
/** 붙여넣기: 복사한 일정을 고른 날 같은 시각에 새로 만들거나(복사), 옮긴다(잘라내기) */
async function pasteTo(d) {
  const c = S.clip;
  if (!c || d == null) return;
  const shift = d - startOfDay(c.e.start);
  if (c.cut) {
    const saved = await guarded(() => updateEvent({ ...c.e, start: c.e.start + shift, end: c.e.end + shift }, c.e.calendarId));
    if (!saved) return;
    S.clip = null;
    await render();
    flash(saved.id);
    toast(`‘${saved.title}’ ${fmtDate(saved.start)}(으)로 옮겼습니다`);
  } else {
    const cal = c.e.readOnly ? defaultCal() : calById(c.e.calendarId) || defaultCal();
    const saved = await guarded(() => createEvent(copyOf(c.e, { calendarId: cal.id, start: c.e.start + shift, end: c.e.end + shift })));
    if (!saved) return;
    await render();
    flash(saved.id);
    toast(`‘${saved.title}’ ${fmtDate(saved.start)}에 붙여넣었습니다`, { label: '실행 취소', run: async () => { await guarded(() => removeEvent(saved)); render(); } });
  }
}

document.addEventListener('contextmenu', (ev) => {
  if (mq.matches || S.needsLogin) return;
  const t = ev.target;
  if (t.closest('input, textarea, select, dialog, #ctx')) return;
  const evBtn = t.closest('[data-id]');
  const e = evBtn && (S.events.find((x) => x.id === evBtn.dataset.id) || searchPool?.evs.find((x) => x.id === evBtn.dataset.id));
  if (e) {
    ev.preventDefault();
    pick(e.id);
    openCtx(ev.clientX, ev.clientY, eventMenu(e));
    return;
  }
  const dayEl = t.closest('.mv-cell[data-day], .qv-cell[data-day], .tg-col[data-day], .tg-ad[data-day], .yv-day[data-day]');
  if (!dayEl) return;
  ev.preventDefault();
  const d = fromDayKey(dayEl.dataset.day);
  setSel(d);
  const p = P(d);
  openCtx(ev.clientX, ev.clientY, [
    { label: `${p.m + 1}월 ${p.d}일 새 일정…`, act: () => newEventAt(d + 9 * 3600e3) },
    { label: '빠른 입력…', act: () => openQuick() },
    { sep: true },
    { label: S.clip ? `붙여넣기: ${S.clip.e.title}` : '붙여넣기', disabled: !S.clip, act: () => pasteTo(d) },
  ]);
});
document.addEventListener('mousedown', (ev) => {
  const m = $('#ctx');
  if (m && !ev.target.closest('#ctx')) closeCtx();
}, true);
document.addEventListener('wheel', () => closeCtx(), { passive: true });

/** 계정 표시(데모 배지·구글 연결 버튼): 데스크톱은 위쪽 막대, 휴대폰은 「캘린더」 탭 */
function placeAccount() {
  const slot = $('#acctSlot');
  const a = $('#account');
  if (a.parentElement !== slot) slot.append(a);
}

$('#prevBtn').onclick = () => go(-1);
$('#nextBtn').onclick = () => go(1);
$('#todayBtn').onclick = goToday;
$('#mTodayBtn').onclick = () => { closeMenu(); if (S.tickerOpen) S.miniMonth = startOfMonth(Date.now()); goToday(); };
$('#viewSeg').onclick = (ev) => { const b = ev.target.closest('button'); if (b) setView(b.dataset.view); };
$('#mViewBtn').onclick = () => { closeMenu(); setView(effView() === 'list' ? 'week' : 'list'); };
$('#mDayBtn').onclick = () => { closeMenu(); if (effView() === 'day') setView('list'); else { S.selDay = startOfDay(S.cursor); setView('day'); } };
$('#monthToggle').onclick = () => { if (S.tickerOpen) S.miniMonth = startOfMonth(Date.now()); goToday(); };
$('#menuBtn').onclick = openMenu;
$('#menuDone').onclick = closeMenu;
$('#quickBtn').onclick = () => openQuick();
$('#searchBtn').onclick = openSearch;
// ＋ : 고른 날(없으면 오늘)에 새 일정 편집 창. 오늘이면 다음 정시, 다른 날이면 오전 9시
$('#addBtn').onclick = () => {
  const d = S.selDay ?? startOfDay(S.cursor);
  newEventAt(d === startOfDay(Date.now()) ? nextHour() : d + 9 * 3600e3);
};

// 위 달력: 좌우로 밀면 달(접힌 상태는 주) 이동, 아래로 당기면 펼침, 위로 밀면 접힘
let swipe = null;
let swallowClickUntil = 0;
const tickerEl = $('#ticker');
tickerEl.addEventListener('pointerdown', (ev) => { swipe = { x: ev.clientX, y: ev.clientY }; });
tickerEl.addEventListener('pointercancel', () => { swipe = null; });
tickerEl.addEventListener('pointerup', (ev) => {
  if (!swipe) return;
  const dx = ev.clientX - swipe.x;
  const dy = ev.clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2) {
    swallowClickUntil = Date.now() + 400;
    tickerStep(dx < 0 ? 1 : -1);
  } else if (Math.abs(dy) > 28 && Math.abs(dy) > Math.abs(dx)) {
    swallowClickUntil = Date.now() + 400;
    toggleTicker(dy > 0);
  }
});

document.addEventListener('click', async (ev) => {
  const t = ev.target;
  // 끌어 옮긴 뒤·밀기·길게 누름 뒤에 따라오는 클릭은 무시
  if (Date.now() < dragBlock && t.closest('.tg-ev, .chip, .mv-bar')) return;
  // 밀어서 연 버튼(더 보기·삭제·완료)
  const swb = t.closest('[data-sw]');
  if (swb) {
    const row = swb.closest('.sw')?.querySelector('.ag-ev, .tsk');
    if (row) swipeAct(swb.dataset.sw, rowItem(row), row);
    return;
  }
  if (Date.now() < swBlockClick && t.closest(`${SW_ROWS}, .tg`)) return;
  if (swOpen && t.closest(SW_ROWS) === swOpen.row) { closeSwipe(); return; }
  // 화상회의 「참가」
  const join = t.closest('[data-join]');
  if (join) { window.open(join.dataset.join, '_blank', 'noopener'); return; }
  // 캘린더 색 바꾸기(이 기기)
  const cc = t.closest('[data-calcolor]');
  if (cc) { ev.preventDefault(); pickCalColor(cc.dataset.calcolor); return; }
  // 오른쪽 클릭 메뉴 항목
  const ci = t.closest('#ctx .ctx-i');
  if (ci) {
    if (ci.classList.contains('off') || ci.classList.contains('has-sub')) return;
    const fn = ctxActs[+ci.dataset.k];
    closeCtx();
    fn?.();
    return;
  }
  // 데스크톱 작은 창(빠른 입력·캘린더 묶음·검색 결과)은 바깥을 누르면 닫는다
  if (!mq.matches) {
    if (t.closest('#plusBtn')) { if (document.body.classList.contains('quick-open')) closeQuick(); else openQuick(); return; }
    // (누른 단추가 그사이 다시 그려져 문서에서 빠졌으면 바깥 클릭으로 치지 않는다)
    if (document.body.classList.contains('quick-open') && t.isConnected && !t.closest('#quickPop')) closeQuick();
    if (document.body.classList.contains('cals-open') && t.isConnected && !t.closest('#calsPanel, .sb-foot')) toggleCalPanel(false);
    if (!t.closest('#dSearchBox')) $('#dSearchPop').hidden = true;
  }
  const act = t.closest('[data-act]')?.dataset.act;
  if (act === 'login') { beginLogin(CONFIG.clientId); return; }
  if (act === 'connect') { toast('config.js 에 구글 클라이언트 ID를 넣으면 연결됩니다 (SETUP.md 참고)'); return; }
  if (act === 'logout') {
    if (!confirm('구글 캘린더 연결을 해제할까요?')) return;
    await logout();
    location.reload();
    return;
  }
  if (act === 'demo') { localStorage.setItem(K_MODE, 'demo'); location.reload(); return; }
  if (act === 'tasks-consent') { sessionStorage.setItem('nanal.askedTasks', '1'); beginLogin(CONFIG.clientId); return; }
  if (act === 'tasks-later') {
    localStorage.setItem(K_ASK, '1');
    syncAsk();
    toast(mq.matches ? '☰ → 할 일에서 언제든 허용할 수 있습니다' : '왼쪽 「할 일」에서 언제든 허용할 수 있습니다');
    return;
  }
  if (act === 'tasks-retry') { S.tasksAt = 0; S.tasksState = 'idle'; renderTasks(); await ensureTasks(true); render(); return; }
  if (act === 'tasks-done-toggle') { S.showDone = !S.showDone; renderTasks(); return; }
  // 할 일: 체크 상자 = 완료/취소, 줄 = 편집 창
  const tcheck = t.closest('[data-tcheck]');
  if (tcheck) { toggleTask(tcheck.dataset.tcheck); return; }
  const trow = t.closest('[data-task]');
  if (trow && !t.closest('dialog')) {
    const task = S.tasks.find((x) => x.id === trow.dataset.task);
    if (task) openTaskEditor(task);
    return;
  }
  if (act === 'close-pop') { closeDayPop(); return; }
  if (act === 'day-view') { const k = t.closest('[data-goto]').dataset.goto; closeDayPop(); S.cursor = fromDayKey(k); S.selDay = S.cursor; syncQuickHint(); S.miniMonth = startOfMonth(S.cursor); setView('day'); return; }
  const pop = $('#dayPop');
  if (pop && !t.closest('#dayPop')) closeDayPop();
  const moreBtn = t.closest('[data-more]');
  if (moreBtn) { openDayPop(fromDayKey(moreBtn.dataset.more), moreBtn); return; }
  if (act === 'reset-demo') { resetDemo(); S.loaded = null; searchPool = null; render(); toast('예시 일정을 처음 상태로 되돌렸습니다'); return; }

  if (t.closest('#ticker')) {
    if (Date.now() < swallowClickUntil) return;
    if (t.closest('#tkGrab')) { toggleTicker(); return; }
  }

  const sDay = t.closest('[data-sdate]');
  if (sDay && !t.closest('[data-id]')) { closeSearch(); selectDay(fromDayKey(sDay.dataset.sdate)); return; }
  const gm = t.closest('[data-goto-month]');
  if (gm) { S.cursor = fromDayKey(gm.dataset.gotoMonth); S.miniMonth = S.cursor; setView('month'); return; }
  const evBtn = t.closest('[data-id]');
  if (evBtn && !t.closest('dialog')) {
    const e = S.events.find((x) => x.id === evBtn.dataset.id) || searchPool?.evs.find((x) => x.id === evBtn.dataset.id);
    closeDayPop();
    if (e) openEditor(e);
    return;
  }
  const mini = t.closest('[data-mini]');
  if (mini) { miniStep(+mini.dataset.mini); return; }

  const dayEl = t.closest('[data-day]');
  if (!dayEl) return;
  const d = fromDayKey(dayEl.dataset.day);
  if (dayEl.classList.contains('mc-day') || dayEl.classList.contains('tk-day')) {
    selectDay(d);
  } else if (dayEl.classList.contains('tg-dh')) {
    // 한 번 누르면 고르기, 두 번 누르면 그날 일 보기
    if (ev.detail >= 2) { S.cursor = d; setSel(d); setView('day'); } else setSel(d);
  } else if (dayEl.classList.contains('yv-day')) {
    // 연 보기: 한 번 = 고르기, 두 번 = 그날 일 보기
    if (ev.detail >= 2) { S.cursor = d; setSel(d); setView('day'); } else { setSel(d); S.cursor = d; S.miniMonth = startOfMonth(d); renderMini(); renderUpcoming(); }
  } else if (dayEl.classList.contains('qv-cell')) {
    setSel(d);
    S.cursor = d;
    renderUpcoming();
    if (ev.detail >= 2) newOnDay(d);
  } else if (dayEl.classList.contains('mv-cell')) {
    if (mq.matches) { S.cursor = d; S.selDay = d; setView('day'); return; }
    setSel(d);
    if (ev.detail < 2) renderUpcoming(); // 왼쪽 일정 목록이 고른 날부터 보이게
    // 두 번째 클릭(ev.detail 2)에서 바로 새 일정: dblclick 이 안 오는 경우(그사이 화면 갱신 등)도 열린다
    if (ev.detail >= 2) newOnDay(d);
  } else if (dayEl.classList.contains('tg-col')) {
    // 빈 시간 칸 클릭 → 30분 단위로 새 일정
    setSel(d);
    const y = ev.clientY - dayEl.getBoundingClientRect().top;
    const min = Math.floor((y / HH) * 2) * 30;
    newEventAt(d + min * 60e3);
  } else if (dayEl.classList.contains('tg-ad')) {
    setSel(d);
    newEventAt(d, true);
  }
});

/** 월 보기 빈 곳 더블클릭 → 그날 오전 9시 새 일정 (click 의 detail 2 와 dblclick 중 먼저 온 쪽 한 번만) */
function newOnDay(d) {
  if (dlg.open) return;
  newEventAt(d + 9 * 3600e3);
}
document.addEventListener('dblclick', (ev) => {
  const cell = ev.target.closest?.('.mv-cell, .qv-cell');
  if (!cell || mq.matches || ev.target.closest('[data-id], [data-more]')) return;
  newOnDay(fromDayKey(cell.dataset.day));
});

document.addEventListener('change', (ev) => {
  const id = ev.target.dataset?.cal;
  if (!id) return;
  if (ev.target.checked) S.hidden.delete(id); else S.hidden.add(id);
  localStorage.setItem(K_HIDDEN, JSON.stringify([...S.hidden]));
  render();
});

// 단축키: t 오늘, d/w/m/l 보기, ←/→ 이동, n 빠른 입력
document.addEventListener('keydown', (ev) => {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches?.('.tsk[data-task]')) { ev.preventDefault(); ev.target.click(); return; }
  if (ev.key === 'Escape' && document.body.classList.contains('tasks-open') && !tdlg.open) { closeTasks(); return; }
  if (ev.key === 'Escape' && $('#ctx')) { closeCtx(); return; }
  if (ev.key === 'Escape' && $('#dayPop')) { closeDayPop(); return; }
  if (ev.key === 'Escape' && document.body.classList.contains('cals-open')) { toggleCalPanel(false); return; }
  // ⌘V / Ctrl+V: 복사·잘라낸 일정을 고른 날에 붙여넣기
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'v' && S.clip && !dlg.open
    && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
    ev.preventDefault();
    pasteTo(S.selDay ?? startOfDay(S.cursor));
    return;
  }
  if (ev.key === 'Escape' && document.body.matches('.menu-open, .search-open')) { closeMenu(); closeSearch(); return; }
  // ⌘Z / Ctrl+Z: 마지막 작업 실행 취소(입력 칸 밖에서)
  if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && ev.key.toLowerCase() === 'z' && !dlg.open && !tdlg.open && !askDlg.open
    && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
    ev.preventDefault();
    runUndo();
    return;
  }
  if (ev.metaKey || ev.ctrlKey || ev.altKey || dlg.open || tdlg.open || askDlg.open) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  const k = ev.key;
  if (k === 't') goToday();
  else if (k === 'd') setView('day');
  else if (k === 'w') setView('week');
  else if (k === 'm') setView('month');
  else if (k === 'q') setView('quarter');
  else if (k === 'y') setView('year');
  else if (k === 'l') setView('list');
  else if (k === 'ArrowLeft') go(-1);
  else if (k === 'ArrowRight') go(1);
  else if (k === 'n' || k === '/') { ev.preventDefault(); openQuick(); }
});

// 창 크기가 바뀌면 월 보기 줄 높이(한 화면 다섯 주)를 다시 잡는다
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (effView() === 'month' && !S.needsLogin) { closeDayPop(); render(); } }, 150);
});

mq.addEventListener('change', () => {
  placeAccount();
  S.mvFrom = null; S.mcFrom = null; // 주 시작 요일이 휴대폰(일)·데스크톱(설정)에서 다를 수 있다
  if (!mq.matches) { closeQuick(); closeMenu(); closeSearch(); closeTasks(); } else { closeCtx(); toggleCalPanel(false); }
  S.jump = true;
  render();
});

// 현재 시각 선 갱신 + 다른 기기에서 바뀐 일정 반영
setInterval(() => {
  if (S.needsLogin) return;
  backToTodayIfStale(); // 자정이 지나면 오늘로
  const stale = useGoogle && S.loaded && Date.now() - S.loaded.at > 5 * 60e3;
  render({ refetch: stale });
}, 60e3);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
  const moved = backToTodayIfStale();
  hiddenAt = 0;
  if (useGoogle && !S.needsLogin) { searchPool = null; render({ refetch: true }); } else if (moved && !S.needsLogin) render();
  loadWeather();
});
// 아이폰이 앱을 메모리에서 그대로 되살린 경우(bfcache)
addEventListener('pageshow', (ev) => { if (ev.persisted && backToTodayIfStale() && !S.needsLogin) render(); });

/* ---------- 확인·선택 시트 (삭제할까요? · 이 일정만/이후 모두 · 길게 누름 메뉴) ---------- */

const askDlg = $('#ask');
let askDone = null;
/** items: [{label, value, danger, dot}]. 고른 value(취소·바깥 누름은 null)로 끝나는 약속을 돌려준다.
 *  input: 시트 안에 넣을 입력 칸 HTML, check: 아래 체크 상자 글(있으면) */
function ask({ title = '', msg = '', items = [], cancel = '취소', input = '', check = '' }) {
  if (askDone) closeAsk(null);
  return new Promise((resolve) => {
    askDone = resolve;
    askDlg.innerHTML = `<div class="ask-box" role="document">
      ${title || msg || input ? `<div class="ask-head">${title ? `<strong id="askTitle">${esc(title)}</strong>` : ''}${msg ? `<p>${esc(msg).replace(/\n/g, '<br>')}</p>` : ''}${input ? `<div class="ask-in">${input}</div>` : ''}${check ? `<label class="ask-ck"><input type="checkbox" id="askCk"> ${esc(check)}</label>` : ''}</div>` : ''}
      <div class="ask-items">${items.map((it, i) => `<button type="button" class="ask-i${it.danger ? ' danger' : ''}${i === 0 ? ' ask-go' : ''}" data-v="${esc(it.value)}"${it.dot ? ` style="--c:${it.dot}"` : ''}>${it.dot ? '<i></i>' : ''}${esc(it.label)}</button>`).join('')}</div>
      <button type="button" class="ask-i ask-cancel" data-v="">${esc(cancel)}</button></div>`;
    askDlg.showModal();
    askDlg.querySelector('.ask-in input')?.focus();
  });
}
const askChecked = () => !!askDlg.querySelector('#askCk')?.checked;
function closeAsk(v) {
  const f = askDone;
  askDone = null;
  if (askDlg.open) askDlg.close();
  f?.(v);
}
let askGuard = 0; // 길게 눌러 연 직후, 손을 뗄 때 따라오는 클릭이 바깥(배경) 클릭으로 닫지 않게
askDlg.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-v]');
  if (Date.now() < askGuard || lpHeld) return;
  if (b) { closeAsk(b.dataset.v || null); return; }
  if (ev.target === askDlg) closeAsk(null);
});
askDlg.addEventListener('cancel', (ev) => { ev.preventDefault(); closeAsk(null); });
askDlg.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.matches?.('.ask-in input')) { ev.preventDefault(); askDlg.querySelector('.ask-go')?.click(); }
});

/* ---------- 일정 「더 보기」 메뉴(휴대폰: 길게 누름·왼쪽 밀기) ---------- */

const eventById = (id) => S.events.find((x) => x.id === id) || searchPool?.evs.find((x) => x.id === id);

async function eventActions(e) {
  const ro = !!e.readOnly;
  const items = [
    { label: '편집', value: 'edit' },
    { label: '복제', value: 'dup' },
    ...(ro ? [] : [{ label: '다른 날로 옮기기…', value: 'move' }]),
    { label: '템플릿으로 저장', value: 'tpl' },
    ...(e.meet ? [{ label: '화상회의 참가', value: 'join' }] : []),
    { label: navigator.share ? '공유…' : '글자로 복사', value: 'share' },
    { label: '숨기기(이 기기만)', value: 'hide' },
    ...(ro ? [] : [{ label: '삭제', value: 'delete', danger: true }]),
  ];
  const v = await ask({ title: e.title, msg: eventText(e, false).split('\n').slice(1).join('\n'), items, cancel: '닫기' });
  if (v === 'edit') openEditor(e);
  else if (v === 'dup') duplicateEvent(e);
  else if (v === 'move') moveEventAsk(e);
  else if (v === 'tpl') saveTemplate(e);
  else if (v === 'join') window.open(e.meet, '_blank', 'noopener');
  else if (v === 'share') shareEvent(e);
  else if (v === 'hide') hideEvent(e);
  else if (v === 'delete') deleteEvent(e);
}
async function shareEvent(e) {
  const text = eventText(e);
  if (navigator.share) { try { await navigator.share({ title: e.title, text }); } catch { /* 취소 */ } return; }
  try { await navigator.clipboard.writeText(text); toast('일정 내용을 복사했습니다'); } catch { toast('복사하지 못했습니다'); }
}

/** 다른 날·시각으로 옮기기(길이는 그대로). 반복 회차는 이 일정만 옮긴다 */
async function moveEventAsk(e) {
  const v = await ask({
    title: '다른 날로 옮기기',
    msg: e.recurringEventId ? '반복 일정 중 이 일정만 옮깁니다.' : '',
    input: `<input type="date" name="mvDate" value="${dayKey(e.start)}" aria-label="날짜">${e.allDay ? '' : `<input type="time" name="mvTime" value="${hm(e.start)}" step="300" aria-label="시각">`}`,
    items: [{ label: '옮기기', value: 'ok' }],
  });
  if (v !== 'ok') return;
  const d = askDlg.querySelector('[name=mvDate]').value;
  if (!d) return;
  const ns = e.allDay ? fromDayKey(d) : fromInputs(d, askDlg.querySelector('[name=mvTime]').value || hm(e.start));
  moveEventTo(e, ns, ns + (e.end - e.start));
}
/** 일정 시각 바꾸기 + 실행 취소(드래그·옮기기 공용) */
async function moveEventTo(e, start, end) {
  if (start === e.start && end === e.end) return;
  const saved = await guarded(() => updateEvent({ ...e, start, end }, e.calendarId));
  if (!saved) return;
  await render();
  flash(saved.id);
  toast(`‘${saved.title}’ ${fmtDate(saved.start)}${saved.allDay ? '' : ` ${fmtTime(saved.start)}`}(으)로${e.recurringEventId ? ' (이 일정만)' : ''}`, {
    label: '실행 취소',
    run: async () => { const back = await guarded(() => updateEvent({ ...saved, start: e.start, end: e.end }, saved.calendarId)); if (back) { await render(); flash(back.id); } },
  });
}

/* ---------- 템플릿: 자주 쓰는 일정(제목·길이·캘린더·장소·메모·알림·URL)을 빠른 입력에서 한 번에 ---------- */
function saveTemplate(e) {
  const t = { title: e.title, dur: e.allDay ? S.defDur : Math.round((e.end - e.start) / 60e3), calendarId: e.calendarId,
    location: e.location || '', note: e.note || '', reminder: e.reminder ?? null, url: e.url || '' };
  S.templates = [t, ...S.templates.filter((x) => x.title !== t.title)].slice(0, 12);
  localStorage.setItem(K_TPL, JSON.stringify(S.templates));
  toast(`‘${e.title}’ 템플릿 저장 · 새 일정 입력 창에서 고릅니다`);
}
function renderTemplates() {
  const box = $('#qsTpl');
  box.hidden = !S.templates.length;
  box.innerHTML = S.templates.length ? `<span class="tpl-h">템플릿</span>${S.templates.map((t, i) => `<span class="tpl${quickTpl === t ? ' on' : ''}"><button type="button" data-tpl="${i}" style="--c:${calById(t.calendarId)?.color || 'var(--accent)'}">${esc(t.title)}</button><button type="button" class="tpl-del" data-tpldel="${i}" aria-label="${esc(t.title)} 템플릿 지우기">×</button></span>`).join('')}` : '';
}
$('#qsTpl').addEventListener('click', async (ev) => {
  const d = ev.target.closest('[data-tpldel]');
  if (d) {
    const t = S.templates[+d.dataset.tpldel];
    if (await ask({ title: '템플릿을 지울까요?', msg: `‘${t.title}’`, items: [{ label: '지우기', value: 'ok', danger: true }] }) !== 'ok') return;
    S.templates = S.templates.filter((x) => x !== t);
    localStorage.setItem(K_TPL, JSON.stringify(S.templates));
    if (quickTpl === t) quickTpl = null;
    renderTemplates();
    return;
  }
  const b = ev.target.closest('[data-tpl]');
  if (!b) return;
  const t = S.templates[+b.dataset.tpl];
  quickTpl = quickTpl === t ? null : t;
  // 제목이 비어 있으면 템플릿 제목을 넣고, 시간만 덧붙이면 되게 한다
  if (quickTpl && !quick.value.trim()) quick.value = `${t.title} `;
  renderTemplates();
  quick.focus();
  quick.dispatchEvent(new Event('input'));
});

/* ---------- 휴대폰 목록: 왼쪽으로 밀면 「더 보기」·「삭제」, 할 일은 오른쪽으로 밀어 완료, 길게 눌러 메뉴 ---------- */

const SW_ROWS = '.m-list .ag-ev, .m-list .tsk, #tasksBody .tsk';
const SW_BTN = 74; // 버튼 하나 너비
let sw = null; // 지금 미는 줄
let swOpen = null; // 버튼이 열린 줄 {row, wrap, off}
let lpTimer = 0;
let lpHeld = false; // 길게 눌러 메뉴를 연 손가락이 아직 화면에 있음
let swBlockClick = 0; // 밀기·길게 누름 뒤 따라오는 click 은 무시

function rowItem(row) {
  if (row.dataset.task) { const t = S.tasks.find((x) => x.id === row.dataset.task); return t ? { kind: 'task', t } : null; }
  const e = row.dataset.id && eventById(row.dataset.id);
  return e ? { kind: 'ev', e } : null;
}
/** 줄을 감싸고 뒤에 버튼을 깐다(밀기 시작할 때만) */
function wrapRow(row) {
  if (row.parentElement?.classList.contains('sw')) return row.parentElement;
  const it = rowItem(row);
  if (!it) return null;
  const wrap = document.createElement('div');
  wrap.className = 'sw';
  const right = it.kind === 'ev'
    ? `<button type="button" class="sw-b sw-more" data-sw="more">더 보기</button>${it.e.readOnly ? '' : '<button type="button" class="sw-b del" data-sw="delete">삭제</button>'}`
    : '<button type="button" class="sw-b del" data-sw="tdelete">삭제</button>';
  const left = it.kind === 'task' ? `<button type="button" class="sw-b done" data-sw="tdone">${it.t.done ? '완료 취소' : '완료'}</button>` : '';
  wrap.innerHTML = `<div class="sw-acts sw-l">${left}</div><div class="sw-acts sw-r">${right}</div>`;
  row.before(wrap);
  wrap.append(row);
  wrap.dataset.r = String(wrap.querySelectorAll('.sw-r .sw-b').length);
  wrap.dataset.l = String(wrap.querySelectorAll('.sw-l .sw-b').length);
  return wrap;
}
function setRowX(row, x, anim) {
  row.style.transition = anim ? 'transform .22s cubic-bezier(.2,.9,.3,1)' : 'none';
  row.style.transform = x ? `translateX(${x}px)` : '';
  const wrap = row.parentElement;
  if (wrap?.classList.contains('sw')) { wrap.classList.toggle('show-r', x < 0); wrap.classList.toggle('show-l', x > 0); }
}
function closeSwipe(anim = true) {
  const o = swOpen;
  swOpen = null;
  if (!o) return;
  setRowX(o.row, 0, anim);
  setTimeout(() => { if (o.wrap.isConnected && swOpen?.row !== o.row && !sw) { o.row.style.transition = ''; o.wrap.replaceWith(o.row); } }, anim ? 240 : 0);
}
document.addEventListener('pointerdown', (ev) => {
  if (!mq.matches || ev.button > 0) return;
  const row = ev.target.closest(SW_ROWS);
  if (swOpen && !ev.target.closest('.sw-acts') && row !== swOpen.row) { closeSwipe(); swBlockClick = Date.now() + 350; }
  if (!row || ev.target.closest('.sw-acts, [data-join]')) return;
  sw = { row, id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, mode: null, base: swOpen?.row === row ? swOpen.off : 0, x: 0 };
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => {
    if (!sw || sw.mode || sw.row !== row) return;
    sw = null;
    lpHeld = true;
    swBlockClick = Date.now() + 700;
    navigator.vibrate?.(8);
    row.classList.add('lp');
    setTimeout(() => row.classList.remove('lp'), 300);
    const it = rowItem(row);
    if (it?.kind === 'ev') eventActions(it.e);
    else if (it?.kind === 'task') taskActions(it.t);
  }, 520);
}, true);
document.addEventListener('pointermove', (ev) => {
  if (!sw || ev.pointerId !== sw.id) return;
  const dx = ev.clientX - sw.x0;
  const dy = ev.clientY - sw.y0;
  if (!sw.mode) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    clearTimeout(lpTimer);
    if (Math.abs(dx) <= Math.abs(dy) * 1.2) { sw = null; return; } // 세로: 목록 스크롤
    sw.mode = 'h';
    if (swOpen && swOpen.row !== sw.row) closeSwipe(false);
    sw.wrap = wrapRow(sw.row);
    if (!sw.wrap) { sw = null; return; }
  }
  const maxR = +sw.wrap.dataset.r * SW_BTN;
  const maxL = +sw.wrap.dataset.l * SW_BTN;
  let x = sw.base + dx;
  if (x > 0 && !maxL) x = 0;
  const w = sw.row.offsetWidth;
  if (x < -maxR) x = -maxR + (x + maxR) * (sw.wrap.dataset.r ? 0.55 : 0.2); // 끝까지 밀면 계속 따라오되 무겁게
  if (x > maxL && maxL) x = maxL + (x - maxL) * 0.55;
  sw.x = Math.max(-w, Math.min(w, x));
  setRowX(sw.row, sw.x, false);
}, true);
function endSwipe(ev) {
  clearTimeout(lpTimer);
  if (lpHeld) { lpHeld = false; askGuard = Date.now() + 300; }
  const s0 = sw;
  sw = null;
  if (!s0 || s0.mode !== 'h' || (ev && ev.pointerId !== s0.id)) return;
  swBlockClick = Date.now() + 350;
  const { row, wrap, x } = s0;
  const w = row.offsetWidth;
  const maxR = +wrap.dataset.r * SW_BTN;
  const maxL = +wrap.dataset.l * SW_BTN;
  const it = rowItem(row);
  // 끝까지 민 경우: 왼쪽 = 삭제(확인창), 오른쪽 = 할 일 완료
  if (x < -w * 0.62 && wrap.querySelector('[data-sw$=delete]')) {
    swOpen = { row, wrap, off: -maxR };
    setRowX(row, -maxR, true);
    swipeAct(wrap.querySelector('[data-sw$=delete]').dataset.sw, it, row);
    return;
  }
  if (x > maxL * 0.6 && maxL) {
    swOpen = { row, wrap, off: 0 };
    closeSwipe();
    if (it?.kind === 'task') toggleTask(it.t.id);
    return;
  }
  if (x < -maxR / 2) { swOpen = { row, wrap, off: -maxR }; setRowX(row, -maxR, true); return; }
  swOpen = { row, wrap, off: 0 };
  closeSwipe();
}
document.addEventListener('pointerup', endSwipe, true);
document.addEventListener('pointercancel', (ev) => { if (sw?.mode === 'h') endSwipe(ev); else { clearTimeout(lpTimer); sw = null; if (lpHeld) { lpHeld = false; askGuard = Date.now() + 300; } } }, true);
// 아이폰: 길게 누를 때 글자 고르기·미리보기 대신 앱 메뉴
document.addEventListener('contextmenu', (ev) => { if (mq.matches && ev.target.closest?.(SW_ROWS)) ev.preventDefault(); });

async function swipeAct(act, it, row) {
  if (!it) return;
  if (act === 'more') { closeSwipe(); eventActions(it.e); return; }
  if (act === 'delete') { const ok = await deleteEvent(it.e); if (!ok) closeSwipe(); return; }
  if (act === 'tdone') { closeSwipe(); toggleTask(it.t.id); return; }
  if (act === 'tdelete') { const ok = await deleteTask(it.t); if (!ok) closeSwipe(); }
}
async function taskActions(t) {
  const v = await ask({ title: t.title || '(제목 없음)', msg: t.due != null ? `마감 ${fmtDate(t.due)}` : '마감일 없음',
    items: [{ label: t.done ? '완료 취소' : '완료', value: 'done' }, { label: '편집', value: 'edit' }, { label: '삭제', value: 'delete', danger: true }], cancel: '닫기' });
  if (v === 'done') toggleTask(t.id);
  else if (v === 'edit') openTaskEditor(t);
  else if (v === 'delete') deleteTask(t);
}

/* ---------- 휴대폰 일·3일 보기: 좌우로 밀면 앞뒤 날 ---------- */
let gsw = null;
document.addEventListener('pointerdown', (ev) => {
  if (!mq.matches || !ev.target.closest('#view.v-day .tg, #view.v-week .tg')) { gsw = null; return; }
  gsw = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
});
document.addEventListener('pointerup', (ev) => {
  const g = gsw;
  gsw = null;
  if (!g || ev.pointerId !== g.id) return;
  const dx = ev.clientX - g.x;
  const dy = ev.clientY - g.y;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { swBlockClick = Date.now() + 350; go(dx < 0 ? 1 : -1); }
});
document.addEventListener('pointercancel', () => { gsw = null; });

/* ---------- 데스크톱: 끌어서 옮기기(주·일 보기 시간 칸 15분 단위, 월 보기 날짜), 아래 끝을 끌어 길이 바꾸기 ---------- */
let drag = null;
let dragBlock = 0;
document.addEventListener('pointerdown', (ev) => {
  if (mq.matches || ev.button !== 0 || ev.pointerType === 'touch' || dlg.open) return;
  const el = ev.target.closest('.tg-ev, .mv-cell .chip, .mv-bar');
  if (!el) return;
  const e = S.events.find((x) => x.id === el.dataset.id);
  if (!e || e.readOnly) return;
  const grid = el.classList.contains('tg-ev');
  drag = { el, e, x0: ev.clientX, y0: ev.clientY, id: ev.pointerId, started: false,
    mode: grid ? (ev.target.closest('.rz') ? 'resize' : 'move') : 'day',
    col: grid ? el.closest('.tg-col') : null, h0: el.offsetHeight };
});
document.addEventListener('pointermove', (ev) => {
  const d = drag;
  if (!d || ev.pointerId !== d.id) return;
  const dx = ev.clientX - d.x0;
  const dy = ev.clientY - d.y0;
  if (!d.started) {
    if (Math.hypot(dx, dy) < 5) return;
    d.started = true;
    closeCtx();
    d.el.classList.add('dragging');
    document.body.classList.add('is-dragging');
  }
  d.el.style.pointerEvents = 'none';
  const under = document.elementFromPoint(ev.clientX, ev.clientY);
  if (d.mode === 'day') {
    // 종일 막대 위에 놓아도 그 아래 날짜 칸을 찾는다
    const cell = document.elementsFromPoint(ev.clientX, ev.clientY).map((n) => n.closest?.('.mv-cell[data-day]')).find(Boolean);
    document.querySelectorAll('.mv-cell.drop').forEach((c) => c !== cell && c.classList.remove('drop'));
    cell?.classList.add('drop');
    d.day = cell ? fromDayKey(cell.dataset.day) : null;
    d.el.style.transform = `translate(${dx}px, ${dy}px)`;
    return;
  }
  const dm = Math.round((dy / HH) * 4) * 15; // 15분 단위
  if (d.mode === 'resize') {
    const dur = Math.max(15, Math.round((d.e.end - d.e.start) / 60e3) + dm);
    d.el.style.height = `${Math.max((dur / 60) * HH - 2, 16)}px`;
    d.next = { start: d.e.start, end: d.e.start + dur * 60e3 };
  } else {
    const col = under?.closest('.tg-col[data-day]') || d.col;
    const days = Math.round((fromDayKey(col.dataset.day) - fromDayKey(d.col.dataset.day)) / DAY);
    const shift = days * DAY + dm * 60e3;
    d.el.style.transform = `translate(${col.getBoundingClientRect().left - d.col.getBoundingClientRect().left}px, ${(dm / 60) * HH}px)`;
    d.next = { start: d.e.start + shift, end: d.e.end + shift };
  }
  const tm = d.el.querySelector('.tm');
  if (tm && d.next) tm.textContent = `${fmtTime(d.next.start)} – ${fmtTime(d.next.end)}`;
});
document.addEventListener('pointerup', (ev) => {
  const d = drag;
  drag = null;
  if (!d || ev.pointerId !== d.id) return;
  if (!d.started) return;
  dragBlock = Date.now() + 300;
  document.body.classList.remove('is-dragging');
  document.querySelectorAll('.mv-cell.drop').forEach((c) => c.classList.remove('drop'));
  let next = d.next;
  if (d.mode === 'day' && d.day != null) {
    const shift = d.day - startOfDay(d.e.start);
    next = { start: d.e.start + shift, end: d.e.end + shift };
  }
  if (!next || (next.start === d.e.start && next.end === d.e.end)) { render(); return; }
  moveEventTo(d.e, next.start, next.end);
});

/* ---------- 캘린더 색(이 기기)·묶음·기본값 ---------- */
const PALETTE = [['토마토', '#d50000'], ['플라밍고', '#e67c73'], ['귤', '#f4511e'], ['바나나', '#f6bf26'], ['세이지', '#33b679'], ['바질', '#0b8043'],
  ['공작', '#039be5'], ['블루베리', '#3f51b5'], ['라벤더', '#7986cb'], ['포도', '#8e24aa'], ['흑연', '#616161'], ['빨강', '#e5413a'], ['하늘', '#3a87f2'], ['초록', '#16a34a'], ['보라', '#7c5cff'], ['주황', '#f59e0b']];
async function pickCalColor(id) {
  const c = calById(id);
  if (!c) return;
  const v = await ask({ title: `‘${c.name}’ 색`, msg: '이 기기에서만 바뀝니다(구글 캘린더 색은 그대로).',
    items: [{ label: '원래 색', value: 'reset', dot: c.origColor }, ...PALETTE.map(([l, hex]) => ({ label: l, value: hex, dot: hex }))] });
  if (!v) return;
  if (v === 'reset') delete S.calColors[id]; else S.calColors[id] = v;
  localStorage.setItem(K_CALCOL, JSON.stringify(S.calColors));
  paintCals();
  render();
}
$('#defCalSel').addEventListener('change', (ev) => { localStorage.setItem(K_DEFCAL, ev.target.value); toast(`새 일정 기본 캘린더: ${calById(ev.target.value)?.name || ''}`); });
$('#defDurSel').addEventListener('change', (ev) => { S.defDur = +ev.target.value; localStorage.setItem(K_DUR, String(S.defDur)); });
$('#weekNumChk').addEventListener('change', (ev) => { S.weekNum = ev.target.checked; localStorage.setItem(K_WKNUM, S.weekNum ? '1' : '0'); render(); });
$('#setSel').addEventListener('change', (ev) => {
  const x = S.sets[+ev.target.value];
  if (!x || ev.target.value === '') return;
  const keepTasks = S.hidden.has(TASKS_KEY) ? [TASKS_KEY] : [];
  S.hidden = new Set([...keepTasks, ...x.hidden]);
  localStorage.setItem(K_HIDDEN, JSON.stringify([...S.hidden]));
  render();
  toast(`캘린더 묶음: ${x.name}`);
});
$('#setSave').addEventListener('click', async () => {
  const v = await ask({ title: '캘린더 묶음 저장', msg: '지금 켜 둔 캘린더 조합을 이름 붙여 저장합니다.',
    input: '<input type="text" name="setName" placeholder="예: 업무만" aria-label="묶음 이름">', items: [{ label: '저장', value: 'ok' }] });
  const name = askDlg.querySelector('[name=setName]')?.value.trim();
  if (v !== 'ok' || !name) return;
  const hidden = S.cals.map((c) => c.id).filter((id) => S.hidden.has(id));
  S.sets = [...S.sets.filter((x) => x.name !== name), { name, hidden }];
  localStorage.setItem(K_SETS, JSON.stringify(S.sets));
  renderCals();
  toast(`‘${name}’ 묶음을 저장했습니다`);
});
$('#setDel').addEventListener('click', async () => {
  const x = S.sets[+$('#setSel').value];
  if (!x) return;
  if (await ask({ title: '묶음을 지울까요?', msg: `‘${x.name}’ (캘린더·일정은 그대로)`, items: [{ label: '지우기', value: 'ok', danger: true }] }) !== 'ok') return;
  S.sets = S.sets.filter((y) => y !== x);
  localStorage.setItem(K_SETS, JSON.stringify(S.sets));
  renderCals();
});

/* ---------- 시작 ---------- */

async function start() {
  if (useGoogle && !getToken()) {
    const silentTried = sessionStorage.getItem('nanal.silentTried');
    if (wasLinked() && !silentTried && !redirect?.error) {
      sessionStorage.setItem('nanal.silentTried', '1');
      beginLogin(CONFIG.clientId, { silent: true });
      return;
    }
    S.needsLogin = true;
    if (redirect?.error && !/interaction_required|login_required|consent_required/.test(redirect.error)) {
      showBanner(`구글 로그인 실패: ${esc(redirect.error)}`);
    }
  }
  if (redirect?.ok) sessionStorage.removeItem('nanal.silentTried');
  // 할 일 권한 동의 화면에서 취소한 경우: 캘린더 토큰은 그대로라 안내만 한다
  if (redirect?.error && getToken()) toast('할 일 권한을 허용하지 않았습니다. 캘린더는 그대로 쓸 수 있습니다');
  // 방금 동의 화면에서 할 일만 빼고 허용했으면 띠를 다시 띄우지 않는다(조용한 토큰 갱신은 해당 없음)
  if (redirect && sessionStorage.getItem('nanal.askedTasks')) {
    sessionStorage.removeItem('nanal.askedTasks');
    if (redirect.ok && useGoogle && !hasTasksScope()) localStorage.setItem(K_ASK, '1');
  }
  placeAccount();
  await render();
  loadWeather();
  // ?q=문장 : 빠른 입력창을 채운 상태로 연다(공유 링크·화면 확인용, 저장은 하지 않음)
  if (params.get('q')) openQuick(params.get('q'));
}
start();

if ('serviceWorker' in navigator && !params.has('nosw')) {
  // /jbcal/ 같은 하위 경로에서도 앱 루트 기준으로 등록한다(현재 주소의 슬래시 유무와 무관).
  const swUrl = new URL('../sw.js', import.meta.url);
  const swScope = new URL('../', import.meta.url).href;
  navigator.serviceWorker.register(swUrl, { scope: swScope }).catch(() => {});
}
