// 한국어 자연어 빠른 입력 해석기.
// 예) "내일 오후 3시 팀 회의 @본관 /업무", "다음주 금요일 7시~9시 저녁 약속", "11월 20일 종일 연차"
import { P, T, DAY, startOfDay, startOfWeekMon } from './time.js';

const WDMAP = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const REL_DAY = { 오늘: 0, 금일: 0, 내일: 1, 모레: 2, 내일모레: 2, 글피: 3, 어제: -1 };
const WEEK_OFF = { 이번: 0, 다음: 1, 담: 1, 다다음: 2 };
const MER = '(오전|오후|아침|낮|저녁|밤|새벽)';
// 시간 하나: "오후 3시 30분", "3시 반", "15:30"
const TIME = `(?:${MER}\\s*)?(?:(\\d{1,2})\\s*:\\s*(\\d{2})|(\\d{1,2})\\s*시(?!간)(?:\\s*(\\d{1,2})\\s*분|\\s*(반))?)`;
// 범위의 시작은 "시"를 생략할 수 있다: "2~4시"
const TIME_LOOSE = `(?:${MER}\\s*)?(\\d{1,2})(?:\\s*:\\s*(\\d{2})|\\s*시(?!간)(?:\\s*(\\d{1,2})\\s*분|\\s*(반))?)?`;
const PARTICLES = new Set(['은', '는', '에', '에는', '에도', '부터', '까지', '에서', '의', '으로', '로', '이', '가', '을', '를', '에서는', '쯤', '경', '~', '-', ',']);

/** 오전/오후 표현과 시(hour)를 24시간제로. 오전/오후가 없으면 1~6시는 오후로 본다. */
function to24(mer, h) {
  if (mer) {
    if (/오전|아침|새벽/.test(mer)) return h === 12 ? 0 : h;
    if (mer === '낮') return h <= 6 ? h + 12 : h;
    if (mer === '밤' && h === 12) return 24;
    return h < 12 ? h + 12 : h;
  }
  return h >= 1 && h <= 6 ? h + 12 : h;
}

/**
 * 휴대폰 키보드가 넣는 전각 글자(１４：００, ～)와 물결표 변형(〜 ∼)을 보통 글자로,
 * 영어 am/pm(2pm, 2:30 PM, 10am-12pm)을 「오전/오후 h:mm」으로 바꾼다.
 */
function normalize(input) {
  return String(input || '').normalize('NFKC')
    .replace(/[〜∼]/g, '~').replace(/[—―]/g, '-')
    .replace(/(\d{1,2})(?:\s*:\s*(\d{2}))?\s*([ap])\.?\s?m\.?(?![a-z])/gi,
      (_, h, mi, ap) => ` ${/a/i.test(ap) ? '오전' : '오후'} ${h}:${mi || '00'} `)
    .trim().replace(/\s+/g, ' ');
}

/** baseDay: 날짜 말이 없을 때 쓸 날(달력에서 고른 날). 없으면 오늘. 「내일」 같은 말은 늘 실제 오늘 기준. */
export function parseQuick(input, now = Date.now(), { baseDay = null } = {}) {
  let s = ` ${normalize(input)} `;
  const out = {
    title: '', start: null, end: null, allDay: false,
    location: '', calendarHint: '', hasDate: false, hasTime: false, timeGuessed: false,
  };
  // 정규식에 맞는 부분을 문장에서 떼어내고 콜백에 넘긴다.
  const take = (re, fn) => {
    const m = s.match(re);
    if (!m) return false;
    s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
    fn(m);
    return true;
  };

  const today = startOfDay(now);
  const tp = P(now);

  // 1) 캘린더 지정: /업무 또는 #업무
  take(/\s[/#](\S+)/, (m) => { out.calendarHint = m[1]; });
  // 2) 장소: @강남역
  take(/\s@(\S+)/, (m) => { out.location = m[1]; });
  // 3) 종일
  take(/(하루\s?종일|종일)/, () => { out.allDay = true; });

  // 4) 날짜
  let day = null;
  const ymd = (y, mo, d, explicitYear) => {
    let ts = T(y, mo - 1, d);
    if (!explicitYear && ts < today) ts = T(y + 1, mo - 1, d);
    return ts;
  };
  const dateRules = [
    [/(\d{4})-(\d{1,2})-(\d{1,2})/, (m) => ymd(+m[1], +m[2], +m[3], true)],
    [/(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/, (m) => ymd(m[1] ? +m[1] : tp.y, +m[2], +m[3], !!m[1])],
    [/(\d{1,2})\/(\d{1,2})(?!\d)/, (m) => ymd(tp.y, +m[1], +m[2], false)],
    [/(이번|이|다음|담)\s*달\s*(\d{1,2})\s*일/, (m) => T(tp.y, tp.m + (m[1].startsWith('이') ? 0 : 1), +m[2])],
    [/(\d+)\s*(일|주)\s*(후|뒤)/, (m) => today + (+m[1]) * (m[2] === '주' ? 7 : 1) * DAY],
    [/(내일모레|오늘|금일|내일|모레|글피|어제)/, (m) => today + REL_DAY[m[1]] * DAY],
    [/(?:(이번|다다음|다음|담)\s*(?:주\s*)?)?([일월화수목금토])(?:요일|욜)/, (m) => {
      const wd = WDMAP[m[2]];
      if (m[1]) return startOfWeekMon(now) + (WEEK_OFF[m[1]] * 7 + (wd + 6) % 7) * DAY;
      return today + ((wd - tp.dow + 7) % 7) * DAY;
    }],
    [/(?:이번\s*주|금주)/, () => today],
    [/(?:다음\s*주|담주)/, () => startOfWeekMon(now) + 7 * DAY],
    [/(?<!\d)(\d{1,2})\s*일(?!\s*(?:후|뒤|동안|간))/, (m) => {
      const ts = T(tp.y, tp.m, +m[1]);
      return ts < today ? T(tp.y, tp.m + 1, +m[1]) : ts;
    }],
  ];
  for (const [re, fn] of dateRules) {
    if (take(re, (m) => { day = fn(m); })) { out.hasDate = true; break; }
  }

  // 5) 시간 (범위 → 단일 → 정오/자정)
  let startMin = null; // 자정부터 몇 분
  let endMin = null;
  let merGiven = false;
  const minutesOf = (mer, hh, mm, hh2, mm2, half) => {
    const h = hh != null ? +hh : +hh2;
    const mi = hh != null ? +mm : (half ? 30 : +(mm2 || 0));
    return to24(mer, h) * 60 + mi;
  };
  const rangeRe = new RegExp(`${TIME_LOOSE}\\s*(?:~|-|–|부터|에서)\\s*${TIME}(?:\\s*까지)?`);
  const rangeHit = take(rangeRe, (m) => {
    // 시작: m[1..5], 끝: m[6..11]
    const sMer = m[1], sH = +m[2], sMi = m[3] ? +m[3] : m[5] ? 30 : +(m[4] || 0);
    const [eMer, eH1, eM1, eH2, eM2, eHalf] = m.slice(6, 12);
    merGiven = !!(sMer || m[6]);
    startMin = to24(sMer, sH) * 60 + sMi;
    if (eMer) {
      endMin = minutesOf(eMer, eH1, eM1, eH2, eM2, eHalf);
    } else {
      let h = eH1 != null ? +eH1 : +eH2;
      const mi = eH1 != null ? +eM1 : eHalf ? 30 : +(eM2 || 0);
      while (h * 60 + mi <= startMin && h < 12) h += 12;
      endMin = h * 60 + mi;
    }
    if (endMin <= startMin) endMin += 24 * 60;
  });
  if (!rangeHit) {
    take(new RegExp(TIME), (m) => {
      merGiven = !!m[1];
      startMin = minutesOf(m[1], m[2], m[3], m[4], m[5], m[6]);
    }) ||
      take(/정오/, () => { startMin = 12 * 60; merGiven = true; }) ||
      take(/자정/, () => { startMin = 24 * 60; merGiven = true; });
  }
  // "7시 저녁 약속"처럼 오전/오후 없이 저녁·밤이 문장에 있으면 오후로
  if (startMin != null && !merGiven && startMin < 12 * 60 && /저녁|밤/.test(s)) {
    startMin += 12 * 60;
    if (endMin != null && endMin < 24 * 60) endMin += 12 * 60;
    if (endMin != null && endMin <= startMin) endMin += 12 * 60;
  }
  // 시간 표현이 없을 때 끼니 단어로 시간 추정 (제목에는 남긴다)
  if (startMin == null && !out.allDay) {
    if (/점심/.test(s)) startMin = 12 * 60;
    else if (/저녁/.test(s)) startMin = 19 * 60;
    out.timeGuessed = startMin != null;
  }

  // 6) 길이: "1시간 30분", "2시간 반", "45분 동안"
  let durMin = null;
  take(/(\d+)\s*시간(?:\s*(반)|\s*(\d{1,2})\s*분)?(?:\s*동안)?/, (m) => {
    durMin = +m[1] * 60 + (m[2] ? 30 : +(m[3] || 0));
  }) || take(/(\d+)\s*분(?:\s*동안)?/, (m) => { durMin = +m[1]; });

  // 7) "~에서" 장소 (시간 범위 해석 뒤에 해야 "3시에서 5시"와 헷갈리지 않는다)
  if (!out.location) take(/\s(\S+?)에서(?=\s)/, (m) => { out.location = m[1]; });

  // 8) 조립
  if (startMin != null && !out.allDay) {
    out.hasTime = true;
    if (day == null && baseDay != null) day = startOfDay(baseDay);
    if (day == null) {
      day = today;
      if (today + startMin * 60e3 < now) day += DAY; // 이미 지난 시각이면 내일로
    }
    out.start = day + startMin * 60e3;
    out.end = endMin != null ? day + endMin * 60e3 : out.start + (durMin ?? 60) * 60e3;
  } else {
    out.allDay = true;
    if (day == null) day = baseDay != null ? startOfDay(baseDay) : today;
    out.start = day;
    out.end = day + DAY;
  }

  out.title = s.split(' ')
    .filter((w) => w && !PARTICLES.has(w))
    .join(' ')
    .replace(/^[,·\s]+|[,·\s]+$/g, '')
    .trim();
  return out;
}

