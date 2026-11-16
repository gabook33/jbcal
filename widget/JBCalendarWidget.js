// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: red; icon-glyph: calendar-alt;

// ───────────────────────────────────────────────────────────
//  JB's 캘린더 위젯 (Scriptable 무료 앱용, 한 파일)
//  - 아이폰 「캘린더」 앱에 연결된 일정(구글 계정 포함)을 그대로 읽는다.
//  - 계정·비밀번호·키를 넣지 않는다. 누구 아이폰이든 그 폰의 캘린더를 보여 준다.
//  - 작은 위젯: 오늘 날짜 + 다음 일정 / 중간: 며칠치 일정 / 큰: 월 달력 + 일정
//  - 위젯을 누르면 https://gabook33.github.io/jbcal/ 이 열린다.
// ───────────────────────────────────────────────────────────

// ===== 설정 (필요할 때만 고치세요) =====
const CONFIG = {
  // 보여 줄 캘린더 이름. 비워 두면 전부 보여 준다.
  // 예) ["gabook33@gmail.com", "가족"]   (아이폰 캘린더 앱에 보이는 이름 그대로)
  // 위젯 편집의 「Parameter」 칸에 「gabook33@gmail.com, 가족」처럼 쉼표로 적어도 된다(그쪽이 우선).
  calendars: [],
  // 빼고 싶은 캘린더 이름 (예: ["대한민국의 휴일"])
  excludeCalendars: [],
  // 일정 목록을 며칠 앞까지 볼지
  daysAhead: 14,
  // 오늘 이미 끝난 일정도 흐리게 보여 줄지 (false면 숨김)
  showEndedToday: false,
  // 24시간 표기 (false면 「오후 3:30」)
  use24h: false,
  // 날짜 밑 점 최대 개수
  maxDots: 4,
  // 위젯을 눌렀을 때 열 주소
  url: "https://gabook33.github.io/jbcal/",
  // 새로 고침 간격(분). 아이폰이 정확히 지키지는 않는다(대략 15분~).
  refreshMinutes: 15,
};

// ===== 색 (JB's 캘린더 모바일 화면과 같은 값) =====
const C = {
  red: Color.dynamic(new Color("#e8372c"), new Color("#ff5146")),
  blue: new Color("#3a87f2"),
  ink: Color.dynamic(new Color("#1c1c1e"), new Color("#f2f2f7")),
  other: Color.dynamic(new Color("#a5a5aa"), new Color("#5a5a5f")),
  topBg: Color.dynamic(new Color("#ffffff"), new Color("#1c1c1e")),
  wkend: Color.dynamic(new Color("#f3f3f5"), new Color("#232326")),
  band: Color.dynamic(new Color("#e9e9eb"), new Color("#2e2e31")),
  wkLabel: Color.dynamic(new Color("#6e6e73"), new Color("#98989d")),
  agBg: new Color("#111111"),
  agText: new Color("#f5f5f7"),
  agGray: new Color("#a1a1a6"),
  agTime: new Color("#a9b0bb"),
  agDim: new Color("#5c5c61"),
  white: new Color("#ffffff"),
  fallback: new Color("#5aa0e0"),
};

const WD = ["일", "월", "화", "수", "목", "금", "토"];
const DAY = 86400000;

// ===== 날짜 도우미 =====
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function dotDate(d) { return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`; }
function fmtTime(d, use24h) {
  const h = d.getHours(), m = String(d.getMinutes()).padStart(2, "0");
  if (use24h) return `${String(h).padStart(2, "0")}:${m}`;
  return `${h < 12 ? "오전" : "오후"} ${h % 12 === 0 ? 12 : h % 12}:${m}`;
}
// 오늘/내일/요일 이름
function dayLabel(d, today) {
  if (sameDay(d, today)) return "오늘";
  return `${WD[d.getDay()]}요일`;
}
function shortDayLabel(d, today) {
  if (sameDay(d, today)) return "오늘";
  if (sameDay(d, addDays(today, 1))) return "내일";
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
}

// ===== 캘린더 고르기 =====
function parseParam(p) {
  if (!p || typeof p !== "string") return [];
  return p.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}
function pickCalendars(all, include, exclude) {
  const norm = (s) => String(s || "").trim().toLowerCase();
  const inc = include.map(norm), exc = exclude.map(norm);
  let list = all;
  if (inc.length) list = list.filter((c) => inc.includes(norm(c.title)));
  if (exc.length) list = list.filter((c) => !exc.includes(norm(c.title)));
  return list;
}

// ===== 일정 읽기 =====
async function loadEvents(from, to, cals) {
  const evs = await CalendarEvent.between(from, to, cals);
  return evs
    .filter((e) => e && e.startDate && e.endDate)
    .map((e) => ({
      title: (e.title || "(제목 없음)").trim(),
      start: new Date(e.startDate),
      end: new Date(e.endDate),
      allDay: !!e.isAllDay,
      location: e.location || "",
      color: (e.calendar && e.calendar.color) || C.fallback,
    }))
    .sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start) || a.title.localeCompare(b.title));
}
// 그 날에 걸치는 일정 (종일 먼저, 그다음 시작 시각 순)
function eventsOn(events, day) {
  const s = startOfDay(day), e = addDays(s, 1);
  return events.filter((ev) => ev.start < e && (ev.end > s || (+ev.end === +ev.start && ev.start >= s)));
}
// 오늘부터 며칠치 목록: [{ day, items:[ev...] }] (일정 없는 날은 뺌, 오늘은 늘 넣음)
function buildAgenda(events, now, days, showEnded) {
  const today = startOfDay(now);
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(today, i);
    let items = eventsOn(events, d);
    if (i === 0 && !showEnded) items = items.filter((ev) => ev.allDay || ev.end > now);
    if (items.length || i === 0) out.push({ day: d, items });
  }
  return out;
}

// ===== 그리기 도우미 =====
function txt(stack, s, size, color, weight, lines) {
  const t = stack.addText(String(s));
  t.font = weight === "heavy" ? Font.heavySystemFont(size)
    : weight === "bold" ? Font.boldSystemFont(size)
    : weight === "semibold" ? Font.semiboldSystemFont(size)
    : weight === "medium" ? Font.mediumSystemFont(size)
    : Font.systemFont(size);
  t.textColor = color;
  t.lineLimit = lines || 1;
  return t;
}
function dot(stack, color, size) {
  const d = stack.addStack();
  d.size = new Size(size, size);
  d.cornerRadius = size / 2;
  d.backgroundColor = color;
  return d;
}
// 세로 칸을 가로로 꽉 채우기 (빈 가로줄 + 유연 여백)
function fullWidth(v) { const r = v.addStack(); r.size = new Size(0, 0.5); r.addSpacer(); }
function hstack(parent) { const s = parent.addStack(); s.layoutHorizontally(); return s; }
function vstack(parent) { const s = parent.addStack(); s.layoutVertically(); return s; }

// 종일 일정 이름표 (캘린더 색 둥근 칸 + 흰 글자)
function allDayLabel(parent, ev, size) {
  const row = hstack(parent);
  const lab = hstack(row);
  lab.backgroundColor = ev.color;
  lab.cornerRadius = 4;
  lab.setPadding(1, 6, 1, 6);
  txt(lab, ev.title, size, C.white, "semibold");
  row.addSpacer();
  return row;
}
// 시간 일정 한 줄: ● 시간 제목
function timedLine(parent, ev, size, opts) {
  const row = hstack(parent);
  row.centerAlignContent();
  const ended = ev.end <= opts.now;
  dot(row, ended ? C.agDim : ev.color, Math.round(size * 0.55));
  row.addSpacer(6);
  if (opts.prefix) { txt(row, opts.prefix, size - 1, C.agGray, "semibold"); row.addSpacer(4); }
  const timeStr = ev.start < startOfDay(opts.day) ? "계속" : fmtTime(ev.start, opts.use24h);
  txt(row, timeStr, size - 1, ended ? C.agDim : C.agTime, "semibold");
  row.addSpacer(5);
  txt(row, ev.title, size, ended ? C.agDim : C.agText, "regular");
  row.addSpacer();
  return row;
}
// 요일 머리: 「오늘 2026. 11. 16.」(파랑) / 「화요일 2026. 11. 17.」
function dayHeader(parent, d, today, size) {
  const row = hstack(parent);
  if (sameDay(d, today)) {
    txt(row, `오늘 ${dotDate(d)}`, size, C.blue, "bold");
  } else {
    txt(row, dayLabel(d, today), size, C.agText, "heavy");
    row.addSpacer(4);
    txt(row, dotDate(d), size, C.agGray, "regular");
  }
  row.addSpacer();
  return row;
}

// 목록을 줄 수(budget)에 맞춰 그린다. 못 그린 일정 수를 돌려준다(「외 N개」용).
function drawAgenda(parent, agenda, opts) {
  const { budget, size, now } = opts;
  const today = startOfDay(now);
  const lines = [];
  for (const g of agenda) {
    lines.push({ head: g.day });
    if (!g.items.length) lines.push({ empty: true });
    for (const ev of g.items) lines.push({ ev, day: g.day });
  }
  const total = lines.filter((l) => l.ev).length;
  let take = lines;
  if (lines.length > budget) {
    take = lines.slice(0, budget - 1); // 마지막 한 줄은 「외 N개」 자리
    while (take.length && take[take.length - 1].head) take.pop(); // 머리만 남지 않게
  }
  take.forEach((l, i) => {
    if (l.head) {
      if (i) parent.addSpacer(opts.gap);
      dayHeader(parent, l.head, today, size);
      parent.addSpacer(2);
    } else if (l.empty) {
      txt(parent, "일정 없음", size - 1, C.agDim, "regular");
    } else {
      if (l.ev.allDay) allDayLabel(parent, l.ev, size - 1);
      else timedLine(parent, l.ev, size, { now, day: l.day, use24h: opts.use24h });
      parent.addSpacer(2);
    }
  });
  return total - take.filter((l) => l.ev).length;
}

// ===== 위젯 크기 (아이폰 화면 폭으로 짐작) =====
function widgetSize(family) {
  let w = 390;
  try { w = Device.screenSize().width; } catch (e) { /* 미리보기 */ }
  const small = w >= 428 ? 170 : w >= 414 ? 169 : w >= 390 ? 158 : w >= 375 ? 155 : 141;
  const wide = w >= 428 ? 364 : w >= 414 ? 360 : w >= 390 ? 338 : w >= 375 ? 329 : 292;
  const tall = w >= 428 ? 382 : w >= 414 ? 379 : w >= 390 ? 354 : w >= 375 ? 345 : 311;
  if (family === "small") return { w: small, h: small };
  if (family === "medium") return { w: wide, h: small };
  return { w: wide, h: tall };
}

// ===== 작은 위젯: 오늘 날짜 + 다음 일정 =====
function buildSmall(w, data) {
  const { now, agenda } = data;
  const today = startOfDay(now);
  const sz = widgetSize("small");
  w.setPadding(0, 0, 0, 0);
  w.backgroundColor = C.agBg;

  const top = hstack(w);
  top.backgroundColor = C.topBg;
  top.setPadding(9, 12, 7, 12);
  top.bottomAlignContent();
  txt(top, String(now.getDate()), 30, C.ink, "heavy");
  top.addSpacer(6);
  const tcol = vstack(top);
  txt(tcol, `${now.getFullYear()}년`, 11, C.red, "semibold");
  txt(tcol, `${now.getMonth() + 1}월 ${WD[now.getDay()]}요일`, 12, C.ink, "bold");
  top.addSpacer();

  const body = vstack(w);
  body.setPadding(7, 11, 6, 11);
  fullWidth(body);
  // 다음 일정 최대 3개 (오늘 남은 것 → 다음 날들)
  const list = [];
  for (const g of agenda) for (const ev of g.items) list.push({ ev, day: g.day });
  if (!list.length) {
    txt(body, "다가오는 일정 없음", 12, C.agDim, "regular");
  }
  const todayLeft = agenda.length && sameDay(agenda[0].day, today) ? agenda[0].items.length : 0;
  if (list.length && !todayLeft) { txt(body, "오늘 남은 일정 없음", 10, C.agDim, "regular"); body.addSpacer(3); }
  const max = todayLeft ? 3 : 2;
  list.slice(0, max).forEach((it, i) => {
    if (i) body.addSpacer(4);
    const head = hstack(body);
    head.centerAlignContent();
    dot(head, it.ev.allDay ? it.ev.color : it.ev.end <= now ? C.agDim : it.ev.color, 6);
    head.addSpacer(5);
    const when = it.ev.allDay ? "종일" : it.ev.start < it.day ? "계속" : fmtTime(it.ev.start, CONFIG.use24h);
    const pre = sameDay(it.day, today) ? "" : `${shortDayLabel(it.day, today)} `;
    txt(head, pre + when, 10, C.agTime, "semibold");
    head.addSpacer();
    const t = hstack(body);
    t.addSpacer(11);
    txt(t, it.ev.title, 12, C.agText, "regular");
    t.addSpacer();
  });
  body.addSpacer();
}

// ===== 중간 위젯: 왼쪽 날짜, 오른쪽 며칠치 일정 =====
function buildMedium(w, data) {
  const { now, agenda } = data;
  const sz = widgetSize("medium");
  w.setPadding(0, 0, 0, 0);
  w.backgroundColor = C.agBg;
  const row = hstack(w);
  row.size = new Size(sz.w, sz.h);

  // 크기를 정한 바깥 칸 안에 여백을 준 안쪽 칸 (크기와 여백을 한 칸에 같이 주지 않는다)
  const leftBox = hstack(row);
  leftBox.size = new Size(104, sz.h);
  leftBox.backgroundColor = C.topBg;
  const left = vstack(leftBox);
  leftBox.addSpacer();
  left.setPadding(12, 12, 12, 8);
  txt(left, `${now.getFullYear()}년`, 13, C.red, "semibold");
  txt(left, `${now.getMonth() + 1}월`, 24, C.ink, "heavy");
  left.addSpacer();
  txt(left, `${WD[now.getDay()]}요일`, 13, C.blue, "semibold");
  const big = txt(left, String(now.getDate()), 44, C.ink, "bold");
  big.minimumScaleFactor = 0.7;
  left.addSpacer(2);
  const cnt = agenda.length && sameDay(agenda[0].day, now) ? agenda[0].items.length : 0;
  txt(left, cnt ? `남은 일정 ${cnt}개` : "남은 일정 없음", 10, C.wkLabel, "medium");

  const rightBox = hstack(row);
  rightBox.size = new Size(sz.w - 104, sz.h);
  const right = vstack(rightBox);
  right.setPadding(11, 12, 8, 10);
  fullWidth(right);
  const hidden = drawAgenda(right, agenda, { budget: 8, size: 13, now, gap: 4, use24h: CONFIG.use24h });
  right.addSpacer();
  if (hidden) txt(right, `외 ${hidden}개 일정`, 10, C.agDim, "regular");
}

// ===== 큰 위젯: 월 달력(점) + 일정 =====
function buildLarge(w, data) {
  const { now, monthEvents, agenda } = data;
  const today = startOfDay(now);
  const sz = widgetSize("large");
  w.setPadding(0, 0, 0, 0);
  w.backgroundColor = C.agBg;

  const padX = 10;
  const cellW = Math.floor((sz.w - padX * 2) / 7);
  const gridW = cellW * 7;
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const gridStart = addDays(first, -first.getDay());
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((first.getDay() + daysInMonth) / 7);
  const rowH = weeks > 5 ? 22 : 24;

  const top = vstack(w);
  top.backgroundColor = C.topBg;
  top.setPadding(10, padX, 6, padX);

  // 제목: 빨간 「2026년」 + 굵은 「11월」
  const title = hstack(top);
  title.bottomAlignContent();
  title.addSpacer(4);
  txt(title, `${now.getFullYear()}년`, 20, C.red, "medium");
  title.addSpacer(5);
  txt(title, `${now.getMonth() + 1}월`, 20, C.ink, "heavy");
  title.addSpacer();
  top.addSpacer(4);

  // 요일 줄 (일·토 옅은 회색 칸, 오늘 요일 파랑)
  const wk = hstack(top);
  for (let i = 0; i < 7; i++) {
    const c = hstack(wk);
    c.size = new Size(cellW, 15);
    c.centerAlignContent();
    if (i === 0 || i === 6) c.backgroundColor = C.wkend;
    c.addSpacer();
    txt(c, WD[i], 10, i === now.getDay() ? C.blue : C.wkLabel, "medium");
    c.addSpacer();
  }

  for (let r = 0; r < weeks; r++) {
    const weekStart = addDays(gridStart, r * 7);
    const isThisWeek = today >= weekStart && today < addDays(weekStart, 7);
    const line = hstack(top);
    line.size = new Size(gridW, rowH);
    if (isThisWeek) { line.backgroundColor = C.band; line.cornerRadius = 7; }
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      const inMonth = d.getMonth() === now.getMonth();
      const isToday = sameDay(d, today);
      const cell = vstack(line);
      cell.size = new Size(cellW, rowH);
      if ((i === 0 || i === 6) && !isThisWeek) cell.backgroundColor = C.wkend;
      cell.centerAlignContent();
      cell.addSpacer(1);
      const num = hstack(cell);
      num.size = new Size(17, 17);
      num.cornerRadius = 8.5;
      num.centerAlignContent();
      if (isToday) num.backgroundColor = C.blue;
      num.addSpacer();
      txt(num, String(d.getDate()), 12, isToday ? C.white : inMonth ? C.ink : C.other, isToday ? "bold" : "regular");
      num.addSpacer();
      cell.addSpacer(1);
      const dots = hstack(cell);
      dots.size = new Size(cellW, 4);
      dots.spacing = 1.5;
      dots.addSpacer();
      eventsOn(monthEvents, d).slice(0, CONFIG.maxDots).forEach((ev) => dot(dots, ev.color, 4));
      dots.addSpacer();
      cell.addSpacer();
    }
  }

  const ag = vstack(w);
  ag.setPadding(8, 14, 6, 14);
  fullWidth(ag);
  const topH = 10 + 24 + 4 + 15 + weeks * rowH + 6;
  const budget = Math.max(3, Math.floor((sz.h - topH - 14) / 17.5));
  const hidden = drawAgenda(ag, agenda, { budget, size: 13, now, gap: 6, use24h: CONFIG.use24h });
  ag.addSpacer();
  if (hidden) txt(ag, `외 ${hidden}개 일정`, 10, C.agDim, "regular");
}

// ===== 잠금 화면 위젯: 다음 일정 한두 줄 =====
function buildAccessory(w, data) {
  const { now, agenda } = data;
  const today = startOfDay(now);
  const list = [];
  for (const g of agenda) for (const ev of g.items) list.push({ ev, day: g.day });
  if (!list.length) { txt(w, "다가오는 일정 없음", 12, C.white, "medium"); return; }
  list.slice(0, 2).forEach(({ ev, day }) => {
    const when = ev.allDay ? "종일" : ev.start < day ? "계속" : fmtTime(ev.start, CONFIG.use24h);
    const pre = sameDay(day, today) ? "" : `${shortDayLabel(day, today)} `;
    txt(w, `${pre}${when} ${ev.title}`, 12, C.white, "medium");
  });
}

// ===== 안내 위젯 (권한 없음 등) =====
function buildMessage(w, title, msg) {
  w.backgroundColor = C.agBg;
  w.setPadding(14, 14, 14, 14);
  txt(w, "JB's 캘린더", 14, C.red, "heavy");
  w.addSpacer(6);
  txt(w, title, 13, C.agText, "semibold", 2);
  w.addSpacer(4);
  txt(w, msg, 11, C.agGray, "regular", 5);
}

// ===== 본체 =====
async function createWidget(family, now) {
  now = now || new Date();
  const w = new ListWidget();
  w.url = CONFIG.url;
  w.refreshAfterDate = new Date(Date.now() + CONFIG.refreshMinutes * 60000);
  let cals;
  try {
    const all = await Calendar.forEvents();
    const param = typeof args !== "undefined" ? parseParam(args.widgetParameter) : [];
    cals = pickCalendars(all, param.length ? param : CONFIG.calendars, CONFIG.excludeCalendars);
    if (!cals.length) {
      buildMessage(w, "보여 줄 캘린더가 없습니다", all.length
        ? "설정한 캘린더 이름이 아이폰 캘린더 앱의 이름과 같은지 확인하세요."
        : "아이폰 설정 → 캘린더 → 계정에서 구글 계정을 추가하고 캘린더를 켜 주세요.");
      return w;
    }
  } catch (e) {
    buildMessage(w, "캘린더 권한이 필요합니다", "Scriptable 앱에서 이 스크립트를 한 번 실행하고 캘린더 접근을 허용하세요.");
    return w;
  }
  const today = startOfDay(now);
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const gridStart = addDays(first, -first.getDay());
  const from = family === "large" ? (gridStart < today ? gridStart : today) : today;
  const to = addDays(today, Math.max(CONFIG.daysAhead, family === "large" ? 43 : 0));
  const events = await loadEvents(from, family === "large" ? (addDays(gridStart, 42) > to ? addDays(gridStart, 42) : to) : to, cals);
  const agenda = buildAgenda(events, now, family === "small" ? Math.max(CONFIG.daysAhead, 30) : CONFIG.daysAhead, CONFIG.showEndedToday);
  const data = { now, agenda, monthEvents: events };
  if (family === "accessory") buildAccessory(w, data);
  else if (family === "small") buildSmall(w, data);
  else if (family === "medium") buildMedium(w, data);
  else buildLarge(w, data);
  return w;
}

async function main() {
  if (config.runsInWidget) {
    const fam = config.widgetFamily;
    const family = fam === "small" || fam === "medium" ? fam
      : String(fam || "").startsWith("accessory") ? "accessory" : "large";
    Script.setWidget(await createWidget(family));
  } else {
    // 앱에서 실행: 미리보기 크기 고르기 (처음 실행 때 캘린더 권한을 묻는다)
    const a = new Alert();
    a.title = "JB's 캘린더 위젯";
    a.message = "미리볼 크기를 고르세요";
    a.addAction("작은 위젯");
    a.addAction("중간 위젯");
    a.addAction("큰 위젯");
    a.addCancelAction("닫기");
    const i = await a.presentSheet();
    if (i === 0) await (await createWidget("small")).presentSmall();
    else if (i === 1) await (await createWidget("medium")).presentMedium();
    else if (i === 2) await (await createWidget("large")).presentLarge();
  }
  Script.complete();
}

if (typeof module !== "undefined" && module.exports && typeof __JB_TEST__ !== "undefined") {
  module.exports = { createWidget, buildAgenda, eventsOn, pickCalendars, parseParam, fmtTime, CONFIG };
} else {
  await main();
}
