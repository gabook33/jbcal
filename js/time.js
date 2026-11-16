// 한국 표준시(KST, UTC+9) 기준 날짜 계산.
// 기기 시간대와 상관없이 항상 서울 시각으로 계산한다. KST는 서머타임이 없어서 고정 오프셋으로 충분하다.
export const TZ = 'Asia/Seoul';
const OFF = 9 * 3600e3;
export const HOUR = 3600e3;
export const DAY = 24 * HOUR;
export const WD = ['일', '월', '화', '수', '목', '금', '토'];

const pad = (n) => String(n).padStart(2, '0');

/** 타임스탬프(ms) → 서울 시각 구성요소 (m은 0부터) */
export function P(ts) {
  const d = new Date(ts + OFF);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay(),
  };
}

/** 서울 시각 구성요소 → 타임스탬프(ms). 범위를 넘는 값은 자동으로 넘어간다(32일 → 다음 달 1일). */
export function T(y, m, d, h = 0, mi = 0) {
  return Date.UTC(y, m, d, h, mi) - OFF;
}

export const startOfDay = (ts) => { const p = P(ts); return T(p.y, p.m, p.d); };
export const addDays = (ts, n) => ts + n * DAY;
/** 일요일 시작 주 (달력 표시용) */
export const startOfWeek = (ts) => { const s = startOfDay(ts); return s - P(s).dow * DAY; };
/** 월요일 시작 주 ("이번 주 금요일" 같은 말 해석용) */
export const startOfWeekMon = (ts) => { const s = startOfDay(ts); return s - ((P(s).dow + 6) % 7) * DAY; };
export const startOfMonth = (ts) => { const p = P(ts); return T(p.y, p.m, 1); };
export const addMonths = (ts, n) => { const p = P(ts); return T(p.y, p.m + n, 1); };
export const sameDay = (a, b) => startOfDay(a) === startOfDay(b);

export function dayKey(ts) {
  const p = P(ts);
  return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}`;
}
export function fromDayKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return T(y, m - 1, d);
}
/** 구글 API용 RFC3339 (+09:00) */
export function rfc3339(ts) {
  const p = P(ts);
  return `${dayKey(ts)}T${pad(p.h)}:${pad(p.mi)}:00+09:00`;
}
/** <input type="time"> 값 */
export const hm = (ts) => { const p = P(ts); return `${pad(p.h)}:${pad(p.mi)}`; };
export function fromInputs(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = (timeStr || '00:00').split(':').map(Number);
  return T(y, m - 1, d, h, mi);
}

/** 오후 3:30 / 오전 9:00 */
export function fmtTime(ts) {
  const { h, mi } = P(ts);
  return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${pad(mi)}`;
}
/** 시간축 라벨: 오전 9시 / 오후 3시 / 정오 */
export function fmtHourLabel(h) {
  if (h === 12) return '정오';
  return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}시`;
}
/** 11월 17일 (화) */
export function fmtDate(ts, withYear = false) {
  const p = P(ts);
  return `${withYear ? p.y + '년 ' : ''}${p.m + 1}월 ${p.d}일 (${WD[p.dow]})`;
}
/** 오늘 / 내일 / 어제 / 11월 18일 수요일 */
export function fmtDayHeading(ts, now) {
  const diff = Math.round((startOfDay(ts) - startOfDay(now)) / DAY);
  const p = P(ts);
  const base = `${p.m + 1}월 ${p.d}일 ${WD[p.dow]}요일`;
  if (diff === 0) return `오늘 · ${base}`;
  if (diff === 1) return `내일 · ${base}`;
  if (diff === -1) return `어제 · ${base}`;
  return base;
}
