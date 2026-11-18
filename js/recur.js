// 반복 일정 규칙(RRULE) 도우미: 만들기·읽기·한국어 설명·펼치기·「이후 모두」 자르기.
// 구글 캘린더는 반복을 RFC 5545 RRULE 문자열로 주고받는다. 날짜 계산은 늘 서울 시각(time.js) 기준.
import { P, T, DAY, WD, startOfDay } from './time.js';

const CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const ORD = { 1: '첫째', 2: '둘째', 3: '셋째', 4: '넷째', 5: '다섯째', '-1': '마지막' };
const pad = (n) => String(n).padStart(2, '0');

/** 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE' → {freq, interval, byDay:[{dow, n}], byMonthDay, until, count, raw} (모르는 규칙은 null) */
export function parseRRule(line) {
  if (!line) return null;
  const s = String(line).replace(/^RRULE:/i, '').trim();
  const kv = Object.fromEntries(s.split(';').filter(Boolean).map((p) => { const [k, v] = p.split('='); return [k.toUpperCase(), v]; }));
  const freq = kv.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  const rule = { freq, interval: Math.max(1, +(kv.INTERVAL || 1)), byDay: [], byMonthDay: null, until: null, count: null, raw: `RRULE:${s}` };
  if (kv.BYDAY) {
    for (const d of kv.BYDAY.split(',')) {
      const m = d.match(/^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/);
      if (!m) return { ...rule, unknown: true };
      rule.byDay.push({ dow: CODES.indexOf(m[2]), n: m[1] ? +m[1] : 0 });
    }
  }
  if (kv.BYMONTHDAY) rule.byMonthDay = +kv.BYMONTHDAY;
  if (kv.COUNT) rule.count = +kv.COUNT;
  if (kv.UNTIL) {
    const m = kv.UNTIL.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
    if (m) rule.until = m[4] ? (m[7] ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : T(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) + (+m[6]) * 1e3)
      : T(+m[1], m[2] - 1, +m[3]) + DAY - 1; // 날짜만: 그날 끝까지
  }
  // 앱이 다루지 않는 항목(BYSETPOS·BYMONTH 등)이 있으면 「구글 설정 그대로」로 둔다
  if (Object.keys(kv).some((k) => !['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL', 'WKST'].includes(k))) rule.unknown = true;
  return rule;
}

/** UNTIL 표기: 시간 일정은 UTC(…Z), 종일 일정은 날짜(서울) */
export function untilStr(ts, allDay) {
  if (allDay) { const p = P(ts); return `${p.y}${pad(p.m + 1)}${pad(p.d)}`; }
  const d = new Date(ts);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** {freq, interval, byDay, byMonthDay, until, count} → 'RRULE:…' */
export function buildRRule(r, allDay = false) {
  const parts = [`FREQ=${r.freq}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.byDay?.length) parts.push(`BYDAY=${r.byDay.map((d) => `${d.n || ''}${CODES[d.dow]}`).join(',')}`);
  if (r.byMonthDay) parts.push(`BYMONTHDAY=${r.byMonthDay}`);
  if (r.count) parts.push(`COUNT=${r.count}`);
  else if (r.until != null) parts.push(`UNTIL=${untilStr(r.until, allDay)}`);
  return `RRULE:${parts.join(';')}`;
}

/** 편집 창 「반복」 고르기 값 ↔ 규칙 */
export const REPEAT_OPTIONS = [
  ['none', '안 함'], ['daily', '매일'], ['weekdays', '평일(월–금)'], ['weekly', '매주'],
  ['biweekly', '격주'], ['monthly', '매월'], ['yearly', '매년'],
];
const WEEKDAYS = [1, 2, 3, 4, 5].map((dow) => ({ dow, n: 0 }));
export function presetRule(kind, start) {
  const dow = P(start).dow;
  switch (kind) {
    case 'daily': return { freq: 'DAILY', interval: 1, byDay: [] };
    case 'weekdays': return { freq: 'WEEKLY', interval: 1, byDay: WEEKDAYS };
    case 'weekly': return { freq: 'WEEKLY', interval: 1, byDay: [{ dow, n: 0 }] };
    case 'biweekly': return { freq: 'WEEKLY', interval: 2, byDay: [{ dow, n: 0 }] };
    case 'monthly': return { freq: 'MONTHLY', interval: 1, byDay: [] };
    case 'yearly': return { freq: 'YEARLY', interval: 1, byDay: [] };
    default: return null;
  }
}
/** 규칙이 고르기 값 중 하나와 같으면 그 값, 아니면 'custom' */
export function presetOf(rule, start) {
  if (!rule) return 'none';
  if (rule.unknown || rule.byMonthDay) return 'custom';
  const dow = P(start).dow;
  const days = rule.byDay.map((d) => (d.n ? `${d.n}${d.dow}` : String(d.dow))).sort().join(',');
  if (rule.freq === 'DAILY' && rule.interval === 1 && !days) return 'daily';
  if (rule.freq === 'WEEKLY' && rule.interval === 1 && days === '1,2,3,4,5') return 'weekdays';
  if (rule.freq === 'WEEKLY' && rule.interval === 1 && (!days || days === String(dow))) return 'weekly';
  if (rule.freq === 'WEEKLY' && rule.interval === 2 && (!days || days === String(dow))) return 'biweekly';
  if (rule.freq === 'MONTHLY' && rule.interval === 1 && !days) return 'monthly';
  if (rule.freq === 'YEARLY' && rule.interval === 1 && !days) return 'yearly';
  return 'custom';
}

/** 한국어 설명: 매주 월·수·금 / 격주 금요일 / 매월 셋째 화요일 / 매월 18일 / 3일마다 · 12월 31일까지 */
export function describeRule(rule, start) {
  if (!rule) return '반복 안 함';
  const p = P(start);
  const days = rule.byDay.filter((d) => !d.n).map((d) => d.dow);
  const sorted = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const dayText = (list) => (list.join(',') === '1,2,3,4,5' ? '평일' : list.join(',') === '6,0' ? '주말' : list.length === 1 ? `${WD[list[0]]}요일` : list.map((d) => WD[d]).join('·'));
  let s;
  const every = (unit, word) => (rule.interval === 1 ? word : rule.interval === 2 && unit === '주' ? '격주' : `${rule.interval}${unit}마다`);
  if (rule.freq === 'DAILY') s = rule.interval === 1 ? '매일' : `${rule.interval}일마다`;
  else if (rule.freq === 'WEEKLY') {
    const list = sorted.length ? sorted : [p.dow];
    if (rule.interval === 1 && list.join(',') === '1,2,3,4,5') s = '평일마다';
    else s = `${every('주', '매주')} ${dayText(list)}`;
  } else if (rule.freq === 'MONTHLY') {
    const nth = rule.byDay.find((d) => d.n);
    s = `${every('개월', '매월')} ${nth ? `${ORD[nth.n] || `${nth.n}번째`} ${WD[nth.dow]}요일` : `${rule.byMonthDay || p.d}일`}`;
  } else s = `${every('년', '매년')} ${p.m + 1}월 ${p.d}일`;
  if (rule.count) s += ` · ${rule.count}회`;
  else if (rule.until != null) { const u = P(rule.until); s += ` · ${u.y !== p.y ? `${u.y}년 ` : ''}${u.m + 1}월 ${u.d}일까지`; }
  if (rule.unknown) s += ' (구글 설정)';
  return s;
}

/** n번째(음수는 끝에서) 요일 날짜. 그런 날이 없으면 null */
export function nthWeekday(y, m, dow, n) {
  if (n > 0) {
    const first = T(y, m, 1);
    const d = first + (((dow - P(first).dow + 7) % 7) + (n - 1) * 7) * DAY;
    return P(d).m === ((m % 12) + 12) % 12 ? d : null;
  }
  const last = T(y, m + 1, 0);
  const d = last - (((P(last).dow - dow + 7) % 7) + (-n - 1) * 7) * DAY;
  return P(d).m === ((m % 12) + 12) % 12 ? d : null;
}

/**
 * 규칙을 펼쳐 [from, to) 안의 시작 시각들을 돌려준다(첫 회 = start 포함). 개수(COUNT)는 처음부터 센다.
 * 날짜 단위로 계산하고 그날의 시각(start 의 시·분)을 붙인다. exdates: 빼는 시작 시각 목록.
 */
export function expand(rule, start, from, to, { exdates = [], max = 1000 } = {}) {
  if (!rule) return start >= from && start < to ? [start] : [];
  const day0 = startOfDay(start);
  const tod = start - day0;
  const sp = P(day0);
  const out = [];
  const ex = new Set(exdates);
  let n = 0;
  const push = (d) => {
    const ts = d + tod;
    if (ts < start) return true;
    if (rule.until != null && ts > rule.until) return false;
    if (rule.count && n >= rule.count) return false;
    n++;
    if (ts >= to) return false;
    if (ts >= from && !ex.has(ts)) out.push(ts);
    return out.length < max;
  };
  const iv = rule.interval || 1;
  const limit = 3000;
  if (rule.freq === 'DAILY') {
    for (let i = 0; i < limit * 10; i += iv) if (!push(day0 + i * DAY)) break;
  } else if (rule.freq === 'WEEKLY') {
    const days = (rule.byDay.length ? rule.byDay.map((d) => d.dow) : [sp.dow]).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    const wk0 = day0 - ((sp.dow + 6) % 7) * DAY; // 월요일 시작 주(WKST=MO)
    outer: for (let w = 0; w < limit; w += iv) {
      for (const dow of days) if (!push(wk0 + (w * 7 + (dow + 6) % 7) * DAY)) break outer;
    }
  } else if (rule.freq === 'MONTHLY') {
    const nth = rule.byDay.find((d) => d.n);
    const md = rule.byMonthDay || sp.d;
    for (let k = 0; k < limit; k += iv) {
      const d = nth ? nthWeekday(sp.y, sp.m + k, nth.dow, nth.n) : T(sp.y, sp.m + k, md);
      if (d == null || (!nth && P(d).d !== md)) continue; // 31일이 없는 달은 건너뛴다
      if (!push(d)) break;
    }
  } else if (rule.freq === 'YEARLY') {
    for (let k = 0; k < limit; k += iv) {
      const d = T(sp.y + k, sp.m, sp.d);
      if (P(d).d !== sp.d) continue; // 2월 29일
      if (!push(d)) break;
    }
  }
  return out;
}

/** 「이후 모든 일정」 삭제: instanceStart 바로 앞에서 끝나도록 RRULE 줄을 고친다(COUNT 는 UNTIL 로 바꿈) */
export function truncateBefore(recurrence, instanceStart, allDay) {
  const until = allDay ? startOfDay(instanceStart) - DAY : instanceStart - 1000;
  return (recurrence || []).map((line) => {
    if (!/^RRULE:/i.test(line)) return line;
    const parts = line.replace(/^RRULE:/i, '').split(';').filter((p) => !/^(UNTIL|COUNT)=/i.test(p));
    parts.push(`UNTIL=${untilStr(until, allDay)}`);
    return `RRULE:${parts.join(';')}`;
  });
}

/** recurrence 배열에서 RRULE 한 줄을 읽는다 */
export const ruleOf = (recurrence) => parseRRule((recurrence || []).find((l) => /^RRULE:/i.test(l)));
