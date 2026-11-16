import { CONFIG } from '../config.js';
import {
  P, T, DAY, WD, startOfDay, startOfWeek, startOfMonth, addMonths, dayKey, fromDayKey,
  fmtTime, fmtHourLabel, fmtDate, fmtDayHeading, hm, fromInputs, sameDay,
} from './time.js';
import { parseQuick } from './nlp.js';
import { demoStore, resetDemo } from './demo.js';
import {
  googleStore, getToken, wasLinked, beginLogin, consumeRedirect, logout, AuthError, EVENT_COLORS,
} from './gcal.js';

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
};
// 옛 「목록」 보기 값은 데스크톱에서 월 보기로(목록은 L 키로 계속 쓸 수 있다)

S.miniMonth = startOfMonth(S.cursor);

document.title = CONFIG.appName;
$('#appName').textContent = CONFIG.appName;

/* ---------- 데이터 ---------- */

const calById = (id) => S.cals.find((c) => c.id === id);
const colorOf = (e) => e.color || calById(e.calendarId)?.color || '#888';
const writableCals = () => S.cals.filter((c) => !c.readOnly);
const defaultCal = () => writableCals().find((c) => c.primary) || writableCals()[0];
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
    if (!S.cals.length) S.cals = await S.store.calendars();
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
  await ensureEvents(refetch);
  if (seq !== renderSeq) return;
  renderChrome();
  renderMini();
  renderTicker();
  renderUpcoming();
  renderCals();
  renderView();
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
      // 일정 하나에 점 하나(캘린더 색), 최대 넷
      const dots = evs.slice(0, 4).map((e) => `<i style="background:${colorOf(e)}"></i>`).join('');
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
    if (!evs.length && i) continue;
    const name = d === today ? '오늘' : d === today + DAY ? '내일' : `${WD[p.dow]}요일`;
    html += `<div class="ag-day sa-day${d === today ? ' today' : ''}" data-date="${dayKey(d)}">
      <h3 class="sa-h"><span><b>${name}</b> ${p.m + 1}/${p.d}</span>${wxHTML(d)}</h3>`;
    if (!evs.length) html += '<div class="ag-empty">일정 없음</div>';
    const ads = evs.filter((e) => e.allDay);
    if (ads.length) html += `<div class="sa-ads">${ads.map((e) => `<button class="ag-ev sa-ad" data-id="${esc(e.id)}" style="--c:${colorOf(e)}">${esc(e.title)}</button>`).join('')}</div>`;
    for (const e of evs) {
      if (e.allDay) continue;
      const cls = ['ag-ev', 'sa-ev', e.id === hl && 'hl', e.end < now && 'past'].filter(Boolean).join(' ');
      html += `<button class="${cls}" data-id="${esc(e.id)}" style="--c:${colorOf(e)}">
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
    if (!evs.length) html += '<div class="ag-empty">일정 없음</div>';
    let nowShown = d !== today;
    for (const e of evs) {
      if (!nowShown && !e.allDay && e.start > now) { html += nowLineHTML(now); nowShown = true; }
      const time = e.allDay
        ? '<span class="ag-t1">종일</span>'
        : `<span class="ag-t1">${e.start < d ? '…' : fmtTime(e.start)}</span><small>${e.end > d + DAY ? '…' : fmtTime(e.end)}</small>`;
      const past = !e.allDay && e.end < now ? ' past' : '';
      html += `<button class="ag-ev${past}${e.allDay ? ' allday' : ''}" data-id="${esc(e.id)}" style="--c:${colorOf(e)}">
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
function mEventsHTML(evs, d, now) {
  const ads = evs.filter((e) => e.allDay);
  let html = ads.length ? `<div class="m-ads">${ads.map((e) => `<button class="ag-ev m-allday" data-id="${esc(e.id)}" style="--c:${colorOf(e)}"><span class="ag-title">${esc(e.title)}</span></button>`).join('')}</div>` : '';
  for (const e of evs) {
    if (e.allDay) continue;
    const past = e.end < now ? ' past' : '';
    html += `<button class="ag-ev m-ev${past}" data-id="${esc(e.id)}" style="--c:${colorOf(e)}">
      <i class="m-dot"></i><span class="m-time">${mTimeRange(e, d)}</span>
      <span class="ag-title">${esc(e.title)}</span>${e.location ? `<span class="ag-loc">${esc(e.location)}</span>` : ''}
    </button>`;
  }
  return html;
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
    if (!evs.length && !keep.has(d)) continue;
    const cls = ['ag-day', 'm-day', d === today && 'today', d < today && 'before'].filter(Boolean).join(' ');
    html += `<section class="${cls}" data-date="${dayKey(d)}"><h3 class="ag-h">${mDayLabel(d, today)}${wxHTML(d)}</h3>`;
    html += evs.length ? mEventsHTML(evs, d, now) : '<div class="ag-empty">일정 없음</div>';
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
      <span class="cal-name">${esc(c.name)}</span>
      ${c.readOnly ? '<span class="cal-ro">읽기 전용</span>' : ''}
    </label>`).join('') + (useGoogle ? '' : '<button class="link-btn" data-act="reset-demo">예시 일정 초기화</button>');
  // 왼쪽 아래 「모든 캘린더 ⌄」: 켠 캘린더 수, 체크 상자는 전부 켜기/끄기
  const on = S.cals.filter((c) => !S.hidden.has(c.id)).length;
  $('#calSetLabel').textContent = on === S.cals.length ? '모든 캘린더' : on ? `캘린더 ${on}/${S.cals.length}개` : '캘린더 꺼짐';
  const all = $('#allCals');
  all.checked = on === S.cals.length;
  all.indeterminate = on > 0 && on < S.cals.length;
  $('#weekStartSel').value = String(S.weekStart);
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
      return `<button class="tg-ev${short ? ' short' : ''}${ev.end < now ? ' past' : ''}" data-id="${esc(ev.id)}"
        style="--c:${colorOf(ev)};top:${top}px;height:${h}px;left:calc(${col * w}% + 1px);width:calc(${w}% - 3px)">
        <span class="t">${esc(ev.title)}</span>
        ${short ? `<span class="tm">${fmtTime(ev.start)}</span>` : `<span class="tm">${fmtTime(ev.start)} – ${fmtTime(ev.end)}</span>`}
        ${!short && ev.location && h > 54 ? `<span class="loc">${esc(ev.location)}</span>` : ''}
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

function chipHTML(e, filled = false) {
  const c = colorOf(e);
  if (filled || e.allDay) {
    return `<button class="chip fill" data-id="${esc(e.id)}" style="--c:${c}">${esc(e.title)}</button>`;
  }
  // 월 보기: 한 줄 = 색 점 + 제목(넘치면 …) + 오른쪽 작은 회색 시각
  return `<button class="chip${isLive(e) ? ' live' : ''}" data-id="${esc(e.id)}" style="--c:${c}"><i></i><span class="tt">${esc(e.title)}</span><span class="ct">${fmtShort(e.start)}</span></button>`;
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
    const p = P(fromDayKey(cell.dataset.day));
    cell.insertAdjacentHTML('beforeend', `<button class="more" data-more="${cell.dataset.day}" aria-label="${p.m + 1}월 ${p.d}일 일정 모두 보기">+${hidden}개 더</button>`);
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
    bars.push(`<button class="${cls}" data-id="${esc(e.id)}" style="--c:${colorOf(e)};--l:${lane};left:calc(${sc} * 100% / 7 + 3px);width:calc(${ec - sc + 1} * 100% / 7 - 6px)" title="${esc(e.title)}">${esc(e.title)}</button>`);
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
    rows += `<div class="mv-week" data-date="${dayKey(w)}">${cells}${bars}</div>`;
  }
  return `<div class="mv" style="--wh:${rowH}px">
    <div class="mv-head">${wdOrder().map((i) => `<span class="${i === 0 || i === 6 ? 'wkend' : ''}">${WD[i]}</span>`).join('')}</div>
    <div class="mv-scroll">${rows}</div>
  </div>`;
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
      const items = evs.slice(0, 3).map((e) => `<button class="qv-ev${e.allDay ? ' ad' : ''}${isLive(e, now) ? ' live' : ''}" data-id="${esc(e.id)}" style="--c:${colorOf(e)}">${esc(e.title)}</button>`).join('');
      cells += `<div class="${cls}" data-day="${dayKey(d)}"><span class="qv-d">${inM ? p.d : ''}</span>${items}${evs.length > 3 ? `<button class="more" data-more="${dayKey(d)}">+${evs.length - 3}</button>` : ''}</div>`;
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
      cells += `<button class="${cls}" data-day="${dayKey(d)}" style="--c:${evs.length ? colorOf(evs[0]) : 'transparent'}" aria-label="${p.m + 1}월 ${p.d}일${evs.length ? `, 일정 ${evs.length}개` : ''}">${p.d}</button>`;
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
    return `<button class="ag-ev${!e.allDay && e.end < now ? ' past' : ''}" data-id="${esc(e.id)}" style="--c:${colorOf(e)}">
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
    <img src="icons/icon.svg" alt="" width="72" height="72">
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
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="btn small">${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
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
const parseQ = (v) => parseQuick(v, Date.now(), { baseDay: S.selDay });

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
  if (r.location) parts.push(row('pv-loc', '장소', `📍 ${esc(r.location)}`));
  const cal = matchCal(r.calendarHint);
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
function openQuick(text = '') {
  if (S.needsLogin) return;
  if (text) quick.value = text;
  closeCtx();
  document.body.classList.add('quick-open');
  if (mq.matches) fitSheetToKeyboard();
  quick.focus();
  quick.dispatchEvent(new Event('input'));
}
function closeQuick() {
  quick.value = '';
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

$('#quickForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const v = quick.value.trim();
  if (!v || S.needsLogin) return;
  const r = parseQ(v);
  const cal = matchCal(r.calendarHint);
  if (!cal) { toast('일정을 넣을 수 있는 캘린더가 없습니다'); return; }
  const saved = await guarded(() => createEvent({
    calendarId: cal.id, title: r.title || '새 일정', start: r.start, end: r.end,
    allDay: r.allDay, location: r.location, note: '',
  }));
  if (!saved) return;
  closeQuick();
  closeMenu();
  S.cursor = startOfDay(saved.start);
  S.miniMonth = startOfMonth(S.cursor);
  S.jump = true;
  await render();
  flash(saved.id);
  toast(`‘${saved.title}’ 추가 · ${fmtDate(saved.start)}${saved.allDay ? '' : ` ${fmtTime(saved.start)}`}`, {
    label: '실행 취소',
    run: async () => { await guarded(() => removeEvent(saved)); render(); },
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
  editing = { event: e, isNew, reminder: String(e.reminder ?? 'default') };
  const ro = !!e.readOnly;
  const cals = ro ? S.cals.filter((c) => c.id === e.calendarId) : writableCals();
  form.calendarId.innerHTML = cals.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  form.calendarId.value = e.calendarId;
  form.title.value = isNew ? '' : e.title;
  form.allDay.checked = e.allDay;
  form.sDate.value = dayKey(e.start);
  form.sTime.value = hm(e.start);
  form.eDate.value = dayKey(e.allDay ? e.end - DAY : e.end);
  form.eTime.value = hm(e.end);
  form.location.value = e.location || '';
  form.note.value = e.note || '';
  setReminderField(e.reminder);
  [...form.elements].forEach((el) => { if (el.name) el.disabled = ro; });
  $('#edSave').hidden = ro;
  $('#edDelete').hidden = isNew || ro;
  $('#edCancel').textContent = ro ? '닫기' : '취소';
  const note = $('#edNote');
  note.hidden = !(ro || e.recurring);
  note.textContent = ro ? '읽기 전용 캘린더의 일정입니다.' : '반복 일정입니다. 이 날짜의 일정만 바뀝니다.';
  const link = $('#edLink');
  link.hidden = !e.link;
  if (e.link) link.href = e.link;
  syncEditor();
  dlg.showModal();
  edOpenedAt = Date.now();
  if (isNew) form.title.focus();
}

/** 알림 고르기: 목록에 없는 값(20분 전·여러 알림)은 그 일정에만 보기 하나를 더 붙인다 */
function setReminderField(v = 'default') {
  const sel = form.reminder;
  sel.querySelectorAll('[data-extra]').forEach((o) => o.remove());
  const val = String(v);
  if (![...sel.options].some((o) => o.value === val)) {
    const label = v === 'custom' ? '구글에 설정된 알림 그대로'
      : v >= 1440 && v % 1440 === 0 ? `${v / 1440}일 전`
        : v >= 60 && v % 60 === 0 ? `${v / 60}시간 전` : `${v}분 전`;
    sel.insertAdjacentHTML('beforeend', `<option value="${esc(val)}" data-extra>${esc(label)}</option>`);
  }
  sel.value = val;
}
const reminderOf = (v) => (/^\d+$/.test(v) ? +v : v);

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
  const { event: orig, isNew } = editing;
  const allDay = form.allDay.checked;
  let start;
  let end;
  if (allDay) {
    start = fromDayKey(form.sDate.value);
    end = fromDayKey(form.eDate.value) + DAY;
  } else {
    start = fromInputs(form.sDate.value, form.sTime.value);
    end = fromInputs(form.eDate.value, form.eTime.value);
  }
  if (end <= start) { toast('종료가 시작보다 늦어야 합니다'); return; }
  const e = {
    ...orig,
    title: form.title.value.trim() || '새 일정',
    calendarId: form.calendarId.value,
    allDay, start, end,
    location: form.location.value.trim(),
    note: form.note.value,
    // 알림을 안 건드렸으면 원래 값(없으면 보내지 않아 구글 쪽 그대로)
    reminder: form.reminder.value === editing.reminder ? orig.reminder : reminderOf(form.reminder.value),
  };
  $('#edSave').disabled = true;
  const saved = await guarded(() => (isNew ? createEvent(e) : updateEvent(e, orig.calendarId)));
  $('#edSave').disabled = false;
  if (!saved) return;
  dlg.close();
  await render();
  flash(saved.id);
  toast(isNew ? '일정을 추가했습니다' : '일정을 수정했습니다');
});

/** 삭제(확인 후) + 되돌리기. 편집 창·오른쪽 클릭 메뉴가 같이 쓴다 */
async function deleteEvent(e) {
  if (!confirm(`‘${e.title}’ 일정을 삭제할까요?${e.recurring ? '\n(반복 일정 중 이 날짜만 삭제됩니다)' : ''}`)) return false;
  const ok = await guarded(async () => { await removeEvent(e); return true; });
  if (!ok) return false;
  render();
  toast('일정을 삭제했습니다', {
    label: '되돌리기',
    run: async () => { await guarded(() => createEvent(copyOf(e))); render(); },
  });
  return true;
}
/** 새로 만들 때 쓸 사본(구글 쪽 id·링크·반복 표시는 뺀다) */
function copyOf(e, patch = {}) {
  const { id, link, recurring, readOnly, ...rest } = e;
  void id; void link; void recurring; void readOnly;
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
        html += `<button class="ag-ev${!e.allDay && e.end < now ? ' past' : ''}" data-id="${esc(e.id)}" style="--c:${colorOf(e)}">
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
  S.hidden = new Set(showAll ? [] : S.cals.map((c) => c.id));
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
    { label: '삭제', disabled: ro, hint: roHint, act: () => deleteEvent(e) },
    { label: '숨기기', hint: '이 기기 화면에서만 감춥니다(구글에는 그대로)', act: () => hideEvent(e) },
    { sep: true },
    { label: '이메일로 보내기', act: () => { location.href = `mailto:?subject=${encodeURIComponent(e.title)}&body=${encodeURIComponent(eventText(e))}`; } },
  ];
}
function eventText(e) {
  const when = e.allDay
    ? `${fmtDate(e.start, true)}${e.end - e.start > DAY ? ` – ${fmtDate(e.end - DAY, true)}` : ''} (종일)`
    : `${fmtDate(e.start, true)} ${fmtTime(e.start)} – ${sameDay(e.start, e.end - 1) ? '' : `${fmtDate(e.end)} `}${fmtTime(e.end)}`;
  return [e.title, when, e.location && `장소: ${e.location}`, e.note].filter(Boolean).join('\n');
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
    if (document.body.classList.contains('quick-open') && !t.closest('#quickPop')) closeQuick();
    if (document.body.classList.contains('cals-open') && !t.closest('#calsPanel, .sb-foot')) toggleCalPanel(false);
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
  if (ev.metaKey || ev.ctrlKey || ev.altKey || dlg.open) return;
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
  if (!mq.matches) { closeQuick(); closeMenu(); closeSearch(); } else { closeCtx(); toggleCalPanel(false); }
  S.jump = true;
  render();
});

// 현재 시각 선 갱신 + 다른 기기에서 바뀐 일정 반영
setInterval(() => {
  if (S.needsLogin) return;
  const stale = useGoogle && S.loaded && Date.now() - S.loaded.at > 5 * 60e3;
  render({ refetch: stale });
}, 60e3);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && useGoogle && !S.needsLogin) { searchPool = null; render({ refetch: true }); }
  if (document.visibilityState === 'visible') loadWeather();
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
