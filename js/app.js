import { CONFIG } from '../config.js';
import {
  P, T, DAY, WD, startOfDay, startOfWeek, startOfMonth, addMonths, dayKey, fromDayKey,
  fmtTime, fmtHourLabel, fmtDate, fmtDayHeading, hm, fromInputs, sameDay,
} from './time.js';
import { parseQuick } from './nlp.js';
import { demoStore, resetDemo } from './demo.js';
import {
  googleStore, getToken, wasLinked, beginLogin, consumeRedirect, logout, AuthError,
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
  tab: 'events', // 휴대폰 아래 탭: events | calendars | todos
  tickerOpen: false, // 휴대폰 위 날짜 줄이 월 달력으로 펼쳐졌는지
  listFrom: null, // 연속 목록이 시작하는 날
  listDays: 0,
  jump: true, // 다음 렌더링 때 목록·월 보기를 S.cursor 날짜로 스크롤
  mvFrom: null, // 월 보기 연속 스크롤이 시작하는 주(일요일)
  mvWeeks: 0,
  mcFrom: null, // 미니 달력 연속 스크롤이 시작하는 주
  mcWeeks: 0,
};
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
const effView = () => (mq.matches && S.view === 'month' ? 'list' : S.view);

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
// 미니 달력이 지금 스크롤로 보여 주는 달. S.miniMonth 와 같으면 다시 그려도 스크롤 위치를 지킨다.
let miniShown = null;
const weeksTo = (from, to) => Math.round((startOfWeek(to) - from) / WEEK) + 1;

/** 월 보기 연속 스크롤 범위. 스크롤 중에는 onMonthScroll 이 늘리고,
 *  날짜로 바로 갈 때(S.jump)만 그 달 앞뒤로 여유가 없으면 다시 잡는다 */
function anchorMonthView() {
  const m = startOfMonth(S.cursor);
  const first = startOfWeek(m);
  const end = S.mvFrom + S.mvWeeks * WEEK;
  if (S.mvFrom == null || (S.jump && (first < S.mvFrom + 4 * WEEK || first + 10 * WEEK > end))) {
    S.mvFrom = startOfWeek(addMonths(m, -3));
    S.mvWeeks = weeksTo(S.mvFrom, addMonths(m, 5));
  }
}

/** 미니 달력 연속 스크롤 범위. 사용자가 미니 달력을 스크롤하는 중(miniShown === S.miniMonth)에는 그대로 둔다 */
function anchorMini() {
  const first = startOfWeek(S.miniMonth);
  const end = S.mcFrom + S.mcWeeks * WEEK;
  if (S.mcFrom == null
    || (miniShown !== S.miniMonth && (first < S.mcFrom + 2 * WEEK || first + 8 * WEEK > end))) {
    S.mcFrom = startOfWeek(addMonths(S.miniMonth, -3));
    S.mcWeeks = weeksTo(S.mcFrom, addMonths(S.miniMonth, 4));
  }
}

function viewRange(view = effView(), cursor = S.cursor) {
  if (view === 'day') return [startOfDay(cursor), startOfDay(cursor) + DAY];
  if (view === 'week') {
    const start = mq.matches ? startOfDay(cursor) : startOfWeek(cursor);
    return [start, start + (mq.matches ? 3 : 7) * DAY];
  }
  if (view === 'month') {
    anchorMonthView();
    return [S.mvFrom, S.mvFrom + S.mvWeeks * WEEK];
  }
  anchorList();
  return [S.listFrom, S.listFrom + S.listDays * DAY]; // list
}

async function ensureEvents(force = false) {
  const today = startOfDay(Date.now());
  const [vs, ve] = viewRange();
  anchorMini();
  const cm = startOfWeek(startOfMonth(S.cursor));
  const ms = Math.min(S.mcFrom, cm);
  const me = Math.max(S.mcFrom + S.mcWeeks * WEEK, cm + 42 * DAY);
  const from = Math.min(vs, ms, today);
  const to = Math.max(ve, me, today + 15 * DAY);
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
    .filter((e) => !S.hidden.has(e.calendarId) && e.end > from && e.start < to)
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

function miniHTML() {
  anchorMini();
  const mp = P(S.miniMonth);
  const today = startOfDay(Date.now());
  const sel = startOfDay(S.cursor);
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
      const dots = [...new Set(evs.map(colorOf))].slice(0, 3)
        .map((c) => `<i style="background:${c}"></i>`).join('');
      const holiday = evs.some(isHoliday);
      const cls = [
        'mc-day',
        (p.m !== mp.m || p.y !== mp.y) && 'other',
        d === today && 'today',
        d === sel && 'sel',
        d >= vs && d < ve && view !== 'month' && view !== 'list' && 'inrange',
        (p.dow === 0 || holiday) && 'sun',
        p.dow === 6 && 'sat',
      ].filter(Boolean).join(' ');
      cells += `<button class="${cls}" data-day="${dayKey(d)}"><span>${p.d}</span><b>${dots}</b></button>`;
    }
    rows += `<div class="mc-week" data-date="${dayKey(ws)}">${cells}</div>`;
  }
  return `
    <div class="mc-head">
      <strong id="mcTitle">${mp.y}년 ${mp.m + 1}월</strong>
      <span>
        <button class="icon-btn sm" data-mini="-1" aria-label="이전 달">‹</button>
        <button class="icon-btn sm" data-mini="1" aria-label="다음 달">›</button>
      </span>
    </div>
    <div class="mc-grid">${WD.map((w, i) => `<span class="mc-wd ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}</div>
    <div class="mc-scroll">${rows}</div>`;
}

function renderMini() {
  const box = $('#mini');
  const prev = box.querySelector('.mc-scroll');
  const keep = prev && miniShown === S.miniMonth && prev.getClientRects().length
    ? topDay(prev, '.mc-week') : null;
  box.innerHTML = miniHTML();
  const c = box.querySelector('.mc-scroll');
  if (!keep || !scrollToDay(c, keep.key, keep.off, '.mc-week')) scrollToDay(c, dayKey(startOfWeek(S.miniMonth)), 0, '.mc-week');
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
      const mp = P(m);
      $('#mcTitle').textContent = `${mp.y}년 ${mp.m + 1}월`;
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
  const row = c?.querySelector(`.mc-week[data-date="${dayKey(startOfWeek(target))}"]`);
  if (!row || !c.getClientRects().length) { S.miniMonth = target; render(); return; }
  c.scrollTo({ top: row.offsetTop, behavior: 'smooth' });
}

/* ---------- 휴대폰 위 날짜 줄 (접으면 한 주, 펼치면 한 달) ---------- */

const tickerMonth = () => (S.tickerOpen ? S.miniMonth : startOfMonth(S.cursor));

function renderTicker() {
  const el = $('#ticker');
  const m = tickerMonth();
  const mp = P(m);
  const gs = startOfWeek(m);
  const weeks = Math.ceil((mp.dow + Math.round((addMonths(m, 1) - m) / DAY)) / 7);
  const today = startOfDay(Date.now());
  const sel = startOfDay(S.cursor);
  let rows = '';
  for (let w = 0; w < weeks; w++) {
    let cells = '';
    for (let i = 0; i < 7; i++) {
      const d = gs + (w * 7 + i) * DAY;
      const p = P(d);
      const evs = visibleEvents(d, d + DAY);
      const dots = [...new Set(evs.filter((e) => !isHoliday(e)).map(colorOf))].slice(0, 3)
        .map((c) => `<i style="background:${c}"></i>`).join('');
      const cls = [
        'tk-day',
        p.m !== mp.m && 'other',
        d === today && 'today',
        d === sel && 'sel',
        (p.dow === 0 || evs.some(isHoliday)) && 'sun',
        p.dow === 6 && 'sat',
      ].filter(Boolean).join(' ');
      cells += `<button class="${cls}" data-day="${dayKey(d)}" aria-label="${p.m + 1}월 ${p.d}일"><span class="n">${p.d}</span><b>${dots}</b></button>`;
    }
    rows += `<div class="tk-row${d0InWeek(sel, gs + w * 7 * DAY) ? ' cur' : ''}">${cells}</div>`;
  }
  const selRow = Math.min(Math.max(Math.floor((startOfWeek(sel) - gs) / (7 * DAY)), 0), weeks - 1);
  el.innerHTML = `
    <div class="tk-wd">${WD.map((w, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}</div>
    <div class="tk-clip"><div class="tk-grid">${rows}</div></div>
    <button class="tk-grab" id="tkGrab" aria-label="${S.tickerOpen ? '달력 접기' : '달력 펼치기'}"><i></i></button>`;
  el.style.setProperty('--weeks', weeks);
  el.style.setProperty('--row', selRow);
  el.classList.toggle('expanded', S.tickerOpen);
  syncTickerHead();
}
function d0InWeek(day, weekStart) { return day >= weekStart && day < weekStart + 7 * DAY; }

function syncTickerHead() {
  const mp = P(tickerMonth());
  $('#mTitle').innerHTML = `<small>${mp.y}년</small> ${mp.m + 1}월`;
  const t = $('#monthToggle');
  t.setAttribute('aria-expanded', String(S.tickerOpen));
  t.setAttribute('aria-label', `${mp.y}년 ${mp.m + 1}월, ${S.tickerOpen ? '달력 접기' : '달력 펼치기'}`);
  $('#tkPrev').setAttribute('aria-label', S.tickerOpen ? '이전 달' : '이전 주');
  $('#tkNext').setAttribute('aria-label', S.tickerOpen ? '다음 달' : '다음 주');
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
  el.classList.toggle('expanded', S.tickerOpen);
  el.querySelector('#tkGrab')?.setAttribute('aria-label', S.tickerOpen ? '달력 접기' : '달력 펼치기');
  syncTickerHead();
}

/** 날짜 줄 좌우 이동: 접힌 상태는 한 주, 펼친 상태는 한 달 */
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

function agendaHTML(from, days, { compact = false, showEmptyToday = true } = {}) {
  const now = Date.now();
  const today = startOfDay(now);
  let html = '';
  for (let i = 0; i < days; i++) {
    const d = from + i * DAY;
    const evs = visibleEvents(d, d + DAY).filter((e) => !(compact && !e.allDay && e.end < now));
    if (!evs.length && !(showEmptyToday && d === today)) continue;
    html += `<div class="ag-day${d === today ? ' today' : ''}">
      <div class="ag-h">${esc(fmtDayHeading(d, now))}</div>`;
    if (!evs.length) html += '<div class="ag-empty">일정 없음</div>';
    for (const e of evs) {
      const time = e.allDay
        ? '종일'
        : `${e.start < d ? '…' : fmtTime(e.start)}${compact ? '' : `<small>${e.end > d + DAY ? '…' : fmtTime(e.end)}</small>`}`;
      const past = !e.allDay && e.end < now ? ' past' : '';
      html += `<button class="ag-ev${past}" data-id="${esc(e.id)}" style="--c:${colorOf(e)}">
        <span class="ag-time">${time}</span>
        <span class="ag-bar"></span>
        <span class="ag-body"><span class="ag-title">${esc(e.title)}</span>${e.location ? `<span class="ag-loc">${esc(e.location)}</span>` : ''}</span>
      </button>`;
    }
    html += '</div>';
  }
  return html || '<div class="ag-empty">다가오는 일정이 없습니다</div>';
}

function renderUpcoming() {
  $('#upcoming').innerHTML = agendaHTML(startOfDay(Date.now()), 14, { compact: true });
}

/* ---------- 날짜별 연속 목록 (휴대폰 기본 화면 · 데스크톱 목록 보기) ---------- */

function listHTML(from, days) {
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
    el.innerHTML = `<div class="ag-main" id="list">${listHTML(S.listFrom, S.listDays)}<div class="ag-tail"></div></div>`;
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
      const row = c.querySelector(`.mv-week[data-date="${dayKey(startOfWeek(startOfMonth(S.cursor)))}"]`);
      // 가까운 달로 옮길 때(‹ › · 방향키)는 부드럽게, 멀리 가면 바로
      if (row && kept && Math.abs(row.offsetTop - c.scrollTop) < 12 * row.offsetHeight) {
        c.scrollTo({ top: row.offsetTop, behavior: 'smooth' });
      } else if (row) c.scrollTop = row.offsetTop;
    }
    c.addEventListener('scroll', onMonthScroll, { passive: true });
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
    const cls = ['tg-dh', d === today && 'today', p.dow === 0 && 'sun', p.dow === 6 && 'sat'].filter(Boolean).join(' ');
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
    return `<div class="tg-col${d === today ? ' today' : ''}" data-day="${dayKey(d)}">${blocks}${nowLine}</div>`;
  }).join('');
  return `<div class="tg" style="--n:${n};--hh:${HH}px">
    <div class="tg-row tg-head"><div class="tg-gutter"></div>${head}</div>
    <div class="tg-row tg-allday"><div class="tg-gutter">종일</div>${allday}</div>
    <div class="tg-scroll"><div class="tg-row tg-body"><div class="tg-hours">${hours}</div>${cols}</div></div>
  </div>`;
}

function chipHTML(e, filled = false) {
  const c = colorOf(e);
  if (filled || e.allDay) {
    return `<button class="chip fill" data-id="${esc(e.id)}" style="--c:${c}">${esc(e.title)}</button>`;
  }
  return `<button class="chip" data-id="${esc(e.id)}" style="--c:${c}"><span class="ct"><i></i>&#8288;${fmtTime(e.start).replace(':00', '')}</span><span class="tt">${esc(e.title)}</span></button>`;
}

/** 월 보기 한 주 줄 높이: 화면에 다섯 주가 보이게 */
function monthRowH() {
  const h = $('#view').clientHeight - 33;
  return Math.max(92, Math.floor(h / 5));
}

/** 월 보기 칸마다 칩 높이를 재서 줄 높이(--wh) 안에 들어가는 만큼만 남기고 나머지는 「+N개 더」로.
 *  첫 일정 하나는 늘 다 보이게: 그것조차 안 들어가면 그 주 줄을 늘린다. 읽기를 먼저 다 하고 고친다. */
function fitMonth(root, rowH) {
  const MORE = 17; // 「+N개 더」 16px + 사이 1px
  const plan = [];
  for (const cell of root.querySelectorAll('.mv-cell')) {
    const chips = cell.querySelectorAll('.chip');
    if (!chips.length) continue;
    const top = cell.offsetTop;
    const limit = rowH - 3; // 아래 여백 2px + 테두리 1px
    const bottoms = [...chips].map((x) => x.offsetTop + x.offsetHeight - top);
    if (bottoms[bottoms.length - 1] <= limit) continue;
    const n = Math.max(1, bottoms.findIndex((b) => b + MORE > limit));
    const more = n < chips.length;
    plan.push({ cell, chips, n, more, need: bottoms[n - 1] + (more ? MORE : 0) + 3 });
  }
  const grow = new Map();
  for (const { cell, chips, n, more, need } of plan) {
    for (let i = n; i < chips.length; i++) chips[i].remove();
    const p = P(fromDayKey(cell.dataset.day));
    const total = chips.length;
    if (more) cell.insertAdjacentHTML('beforeend', `<button class="more" data-more="${cell.dataset.day}" aria-label="${p.m + 1}월 ${p.d}일 일정 ${total}개 모두 보기">+${total - n}개 더</button>`);
    if (need > rowH) grow.set(cell.parentElement, Math.max(grow.get(cell.parentElement) || 0, need));
  }
  grow.forEach((h, week) => { week.style.height = `${Math.ceil(h)}px`; });
}

function monthHTML() {
  const [gs, ge] = viewRange('month');
  const cur = startOfMonth(S.cursor);
  const today = startOfDay(Date.now());
  const rowH = monthRowH();
  // 제목이 여러 줄로 감기므로 몇 개가 들어갈지는 그린 뒤 fitMonth 가 재서 정한다
  const fit = mq.matches ? 0 : Infinity;
  let rows = '';
  for (let w = gs; w < ge; w += WEEK) {
    let cells = '';
    for (let d = w; d < w + WEEK; d += DAY) {
      const p = P(d);
      const evs = visibleEvents(d, d + DAY);
      const holiday = evs.some(isHoliday);
      const cls = ['mv-cell', startOfMonth(d) !== cur && 'other', d === today && 'today', (p.dow === 0 || holiday) && 'is-sun', p.dow === 6 && 'is-sat'].filter(Boolean).join(' ');
      const maxChips = evs.length > fit ? Math.max(fit - 1, 0) : fit;
      const shown = evs.slice(0, maxChips).map((e) => chipHTML(e)).join('');
      const more = evs.length > maxChips
        ? (maxChips || !mq.matches
          ? `<button class="more" data-more="${dayKey(d)}" aria-label="${p.m + 1}월 ${p.d}일 일정 ${evs.length}개 모두 보기">+${evs.length - maxChips}개 더</button>`
          : `<span class="dots">${evs.slice(0, 4).map((e) => `<i style="background:${colorOf(e)}"></i>`).join('')}</span>`)
        : '';
      const label = p.d === 1 ? `<span class="mv-mon">${p.m + 1}월</span>` : '';
      cells += `<div class="${cls}" data-day="${dayKey(d)}"><span class="mv-dl">${label}<span class="mv-date">${p.d}</span></span>${shown}${more}</div>`;
    }
    rows += `<div class="mv-week" data-date="${dayKey(w)}">${cells}</div>`;
  }
  return `<div class="mv" style="--wh:${rowH}px">
    <div class="mv-head">${WD.map((w, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}</div>
    <div class="mv-scroll">${rows}</div>
  </div>`;
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
  return saved;
}
async function updateEvent(e, prevCalendarId) {
  const saved = await S.store.update(e, calById(e.calendarId), prevCalendarId);
  S.events = S.events.map((x) => (x.id === e.id ? saved : x));
  return saved;
}
async function removeEvent(e) {
  await S.store.remove(e);
  S.events = S.events.filter((x) => x.id !== e.id);
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

function describe(r) {
  const row = (cls, label, html) => `<span class="pv-row ${cls}"><em>${label}</em>${html}</span>`;
  const parts = [row('pv-date', '날짜', esc(fmtDate(r.start)))];
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
const sheetMode = () => mq.matches && document.body.classList.contains('quick-open');
quick.addEventListener('input', () => {
  const v = quick.value.trim();
  if (!v || S.needsLogin) { pvEl.hidden = true; return; }
  pvEl.innerHTML = describe(parseQuick(v));
  pvEl.hidden = false;
});
quick.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { closeQuick(); }
});
// 데스크톱 드롭다운 미리보기는 입력창을 벗어나면 닫는다(휴대폰 시트에서는 계속 보임)
quick.addEventListener('blur', () => setTimeout(() => { if (!sheetMode()) pvEl.hidden = true; }, 150));
quick.addEventListener('focus', () => quick.dispatchEvent(new Event('input')));

/** 휴대폰: + 버튼 → 아래에서 올라오는 빠른 입력 시트 */
function openQuick(text = '') {
  if (S.needsLogin) return;
  if (text) quick.value = text;
  if (mq.matches) {
    document.body.classList.add('quick-open');
    fitSheetToKeyboard();
  }
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
$('#qsScrim').onclick = closeQuick;

$('#quickForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const v = quick.value.trim();
  if (!v || S.needsLogin) return;
  const r = parseQuick(v);
  const cal = matchCal(r.calendarHint);
  if (!cal) { toast('일정을 넣을 수 있는 캘린더가 없습니다'); return; }
  const saved = await guarded(() => createEvent({
    calendarId: cal.id, title: r.title || '새 일정', start: r.start, end: r.end,
    allDay: r.allDay, location: r.location, note: '',
  }));
  if (!saved) return;
  closeQuick();
  S.cursor = startOfDay(saved.start);
  S.miniMonth = startOfMonth(S.cursor);
  S.jump = true;
  if (S.tab !== 'events') setTab('events');
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
  editing = { event: e, isNew };
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
  if (isNew) form.title.focus();
}

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
dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });

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

$('#edDelete').addEventListener('click', async () => {
  const e = editing.event;
  if (!confirm(`‘${e.title}’ 일정을 삭제할까요?${e.recurring ? '\n(반복 일정 중 이 날짜만 삭제됩니다)' : ''}`)) return;
  const ok = await guarded(async () => { await removeEvent(e); return true; });
  if (!ok) return;
  dlg.close();
  render();
  toast('일정을 삭제했습니다', {
    label: '되돌리기',
    run: async () => { const { id, ...rest } = e; void id; await guarded(() => createEvent(rest)); render(); },
  });
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
  else if (view === 'week') S.cursor = c + dir * (mq.matches ? 3 : 7) * DAY;
  else if (view === 'list') S.cursor = startOfDay(c) + dir * 7 * DAY;
  else S.cursor = c + dir * DAY;
  S.miniMonth = startOfMonth(S.cursor);
  S.jump = true;
  render();
}
function goToday() {
  S.cursor = startOfDay(Date.now());
  S.miniMonth = startOfMonth(S.cursor);
  S.jump = true;
  render();
}
function selectDay(d) {
  S.cursor = d;
  if (P(d).m !== P(S.miniMonth).m) S.miniMonth = startOfMonth(d);
  S.jump = true;
  render();
}

/** 휴대폰 아래 탭 */
function setTab(tab) {
  S.tab = tab;
  document.body.dataset.tab = tab;
  document.querySelectorAll('#tabbar [data-tab]').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === tab);
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  });
  if (tab === 'events') { S.jump = false; render(); }
}

/** 계정 표시(데모 배지·구글 연결 버튼): 데스크톱은 위쪽 막대, 휴대폰은 「캘린더」 탭 */
function placeAccount() {
  const slot = mq.matches ? $('#acctSlot') : $('.topbar');
  const a = $('#account');
  if (a.parentElement !== slot) slot.append(a);
}

$('#prevBtn').onclick = () => go(-1);
$('#nextBtn').onclick = () => go(1);
$('#todayBtn').onclick = goToday;
$('#mTodayBtn').onclick = () => { if (S.tickerOpen) S.miniMonth = startOfMonth(Date.now()); goToday(); };
$('#viewSeg').onclick = (ev) => { const b = ev.target.closest('button'); if (b) setView(b.dataset.view); };
$('#mViewBtn').onclick = () => setView(effView() === 'list' ? 'week' : 'list');
$('#fab').onclick = () => (mq.matches ? openQuick() : quick.focus());
$('#monthToggle').onclick = () => toggleTicker();
$('#tkPrev').onclick = () => tickerStep(-1);
$('#tkNext').onclick = () => tickerStep(1);
$('#tabbar').onclick = (ev) => { const b = ev.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); };

// 날짜 줄: 좌우로 밀면 주(펼친 상태는 달) 이동, 아래로 당기면 펼침, 위로 밀면 접힘
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
  if (act === 'day-view') { const k = t.closest('[data-goto]').dataset.goto; closeDayPop(); S.cursor = fromDayKey(k); S.miniMonth = startOfMonth(S.cursor); setView('day'); return; }
  const pop = $('#dayPop');
  if (pop && !t.closest('#dayPop')) closeDayPop();
  const moreBtn = t.closest('[data-more]');
  if (moreBtn) { openDayPop(fromDayKey(moreBtn.dataset.more), moreBtn); return; }
  if (act === 'reset-demo') { resetDemo(); S.loaded = null; render(); toast('예시 일정을 처음 상태로 되돌렸습니다'); return; }

  if (t.closest('#ticker')) {
    if (Date.now() < swallowClickUntil) return;
    if (t.closest('#tkGrab')) { toggleTicker(); return; }
  }

  const evBtn = t.closest('[data-id]');
  if (evBtn && !t.closest('dialog')) {
    const e = S.events.find((x) => x.id === evBtn.dataset.id);
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
    S.cursor = d; setView('day');
  } else if (dayEl.classList.contains('mv-cell')) {
    if (mq.matches) { S.cursor = d; setView('day'); return; }
    S.cursor = d;
    render();
  } else if (dayEl.classList.contains('tg-col')) {
    // 빈 시간 칸 클릭 → 30분 단위로 새 일정
    const y = ev.clientY - dayEl.getBoundingClientRect().top;
    const min = Math.floor((y / HH) * 2) * 30;
    newEventAt(d + min * 60e3);
  } else if (dayEl.classList.contains('tg-ad')) {
    newEventAt(d, true);
  }
});

document.addEventListener('dblclick', (ev) => {
  const cell = ev.target.closest('.mv-cell');
  if (cell && !ev.target.closest('[data-id], [data-more]')) newEventAt(fromDayKey(cell.dataset.day) + 9 * 3600e3);
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
  if (ev.key === 'Escape' && $('#dayPop')) { closeDayPop(); return; }
  if (ev.metaKey || ev.ctrlKey || ev.altKey || dlg.open) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  const k = ev.key;
  if (k === 't') goToday();
  else if (k === 'd') setView('day');
  else if (k === 'w') setView('week');
  else if (k === 'm') setView('month');
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

mq.addEventListener('change', () => { placeAccount(); if (!mq.matches) closeQuick(); S.jump = true; render(); });

// 현재 시각 선 갱신 + 다른 기기에서 바뀐 일정 반영
setInterval(() => {
  if (S.needsLogin) return;
  const stale = useGoogle && S.loaded && Date.now() - S.loaded.at > 5 * 60e3;
  render({ refetch: stale });
}, 60e3);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && useGoogle && !S.needsLogin) render({ refetch: true });
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
  document.body.dataset.tab = S.tab;
  await render();
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
