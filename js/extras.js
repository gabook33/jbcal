// 2026-11-19 보강 기능의 순수 함수(화면·네트워크 없음, 단위 시험 대상)
// 화상회의 링크 찾기, 가용 시간(빈 시간) 계산, 이 기기 알림 예약, 지도·길찾기 링크, 이동 시간 표시.
import { DAY } from './time.js';

/* ---------- 화상회의: 구글 Meet 외에 Zoom·Teams·Webex 링크를 URL·장소·메모에서 찾는다 ---------- */
const CONF = [
  ['Zoom', /https?:\/\/(?:[\w-]+\.)?zoom\.(?:us|com)\/(?:j|my|w|s|wc\/join)\/[^\s<>"'）)]+/i],
  ['Teams', /https?:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s<>"'）)]+/i],
  ['Meet', /https?:\/\/meet\.google\.com\/[a-z]{3,}-[a-z]{3,}-[a-z]{3,}[^\s<>"'）)]*/i],
  ['Webex', /https?:\/\/(?:[\w-]+\.)?webex\.com\/(?:meet|join|[\w-]+\/j\.php)[^\s<>"'）)]*/i],
];
/** 일정의 화상회의 {kind, url} (없으면 null). 구글 Meet(회의 정보)이 먼저 */
export function confOf(e) {
  if (e.meet) return { kind: /meet\.google/.test(e.meet) ? 'Meet' : '화상회의', url: e.meet };
  for (const text of [e.url, e.location, e.note]) {
    if (!text) continue;
    for (const [kind, re] of CONF) {
      const m = String(text).match(re);
      if (m) return { kind, url: m[0].replace(/[.,]+$/, '') };
    }
  }
  return null;
}
/** 새 회의를 만드는 각 서비스 웹 주소(로그인은 그 서비스에서) */
export const CONF_NEW = {
  Zoom: 'https://zoom.us/meeting/schedule',
  Teams: 'https://teams.microsoft.com/l/meeting/new',
};

/* ---------- 가용 시간 ---------- */

/** 겹치는 바쁜 구간을 합친다 [{start,end}] */
export function mergeBusy(list) {
  const s = list.filter((b) => b.end > b.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const b of s) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else out.push({ start: b.start, end: b.end });
  }
  return out;
}
/**
 * 모두 비어 있는 시간 찾기: from~to 안에서 길이 dur 이상, step(기본 15분) 눈금에 맞춘 시작 시각.
 * busy: 모든 사람의 바쁜 구간을 한데 모은 것. 하루 근무 시간(workFrom~workTo 시, 서울 기준 dayStart 의 시각) 밖은 건너뛴다.
 * 돌려주는 값: [{start, end}] (최대 limit 개)
 */
export function freeSlots(busy, from, to, dur, { step = 15 * 60e3, dayStart = null, workFrom = 9, workTo = 18, limit = 3 } = {}) {
  const m = mergeBusy(busy);
  const out = [];
  let t = Math.ceil(from / step) * step;
  while (t + dur <= to && out.length < limit) {
    // 근무 시간(dayStart 가 주어지면 그날 기준) 밖이면 건너뛴다
    if (dayStart != null) {
      const day = dayStart + Math.floor((t - dayStart) / DAY) * DAY;
      const ws = day + workFrom * 3600e3;
      const we = day + workTo * 3600e3;
      if (t < ws) { t = ws; continue; }
      if (t + dur > we) { t = day + DAY + workFrom * 3600e3; continue; }
    }
    const hit = m.find((b) => b.start < t + dur && b.end > t);
    if (!hit) { out.push({ start: t, end: t + dur }); t += dur; continue; }
    t = Math.ceil(hit.end / step) * step;
  }
  return out;
}

/* ---------- 이 기기 알림(앱이 열려 있는 동안 브라우저 알림으로) ---------- */

/** 일정 알림 분 목록. 'default' 는 캘린더 기본 알림(없으면 dflt), 'none'·'custom'(이메일 등)은 없음 */
export function alertMinutes(e, calDefaults = null, dflt = [10]) {
  const r = e.reminder ?? 'default';
  if (r === 'none' || r === 'custom') return [];
  if (r === 'default') return Array.isArray(calDefaults) ? calDefaults : dflt; // 캘린더 기본 알림이 없으면 알림 없음
  if (Array.isArray(r)) return r;
  return Number.isFinite(+r) ? [+r] : [];
}
/** 같은 알림을 두 번 보내지 않게 쓰는 열쇠 */
export const alertKey = (e, kind, min) => `${e.id}|${e.start}|${kind}${min}`;
/**
 * 지금 보낼 알림 목록. 알림 시각이 (now - catchUp, now] 안이고 아직 안 보낸 것.
 * opts: calDefaults(id→분 목록), muted(캘린더 id Set), fired(열쇠 Set), travel(일정 id→{min}), lead(출발 알림 여유 분), selfDeclined 무시
 * 결과: [{key, e, kind:'alert'|'leave', min, at}]
 */
export function dueAlerts(events, now, { calDefaults = {}, muted = new Set(), fired = new Set(), travel = {}, lead = 5, catchUp = 10 * 60e3, dflt = [10] } = {}) {
  const out = [];
  for (const e of events) {
    if (muted.has(e.calendarId) || e.end <= now - catchUp) continue;
    if (e.attendees?.some((a) => a.self && a.status === 'declined')) continue;
    const mins = e.allDay ? [] : alertMinutes(e, calDefaults[e.calendarId], dflt);
    for (const min of mins) {
      const at = e.start - min * 60e3;
      const key = alertKey(e, 'a', min);
      if (at <= now && at > now - catchUp && !fired.has(key)) out.push({ key, e, kind: 'alert', min, at });
    }
    const tv = travel[e.id];
    if (tv?.min && !e.allDay) {
      const at = e.start - (tv.min + lead) * 60e3;
      const key = alertKey(e, 't', tv.min);
      if (at <= now && at > now - catchUp && !fired.has(key)) out.push({ key, e, kind: 'leave', min: tv.min, at });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
/** 다음 알림 시각(없으면 null): 타이머를 그때 맞춘다 */
export function nextAlertAt(events, now, opts = {}) {
  let best = null;
  const { calDefaults = {}, muted = new Set(), travel = {}, lead = 5, dflt = [10] } = opts;
  for (const e of events) {
    if (muted.has(e.calendarId) || e.allDay) continue;
    const ats = alertMinutes(e, calDefaults[e.calendarId], dflt).map((m) => e.start - m * 60e3);
    if (travel[e.id]?.min) ats.push(e.start - (travel[e.id].min + lead) * 60e3);
    for (const at of ats) if (at > now && (best == null || at < best)) best = at;
  }
  return best;
}
/** 알림 본문: 「10분 뒤 시작 · 14:00–15:00 · 본관」 */
export function alertBody(e, kind, min, fmt) {
  const when = min === 0 ? '지금 시작' : min < 60 ? `${min}분 뒤 시작` : min % 1440 === 0 ? `${min / 1440}일 뒤` : min % 60 === 0 ? `${min / 60}시간 뒤 시작` : `${min}분 뒤 시작`;
  const head = kind === 'leave' ? `지금 출발하세요(이동 약 ${min}분)` : when;
  return [head, fmt(e), e.location].filter(Boolean).join(' · ');
}

/* ---------- 지도·길찾기 링크(키 없이 여는 앱·웹 주소) ---------- */

export function mapLinks(place, geo = null) {
  const q = encodeURIComponent(place);
  const links = [
    ['카카오맵', geo ? `https://map.kakao.com/link/to/${encodeURIComponent(geo.name || place)},${geo.lat},${geo.lon}` : `https://map.kakao.com/link/search/${q}`],
    ['네이버 지도', `https://map.naver.com/p/search/${q}`],
    ['구글 지도', `https://www.google.com/maps/dir/?api=1&destination=${geo ? `${geo.lat},${geo.lon}` : q}&travelmode=driving`],
  ];
  return links.map(([name, href]) => ({ name, href }));
}
/** 「차로 약 25분 · 12.3km」 */
export function travelText(t) {
  if (!t) return '';
  const h = Math.floor(t.min / 60);
  const m = t.min % 60;
  const dur = h ? `${h}시간${m ? ` ${m}분` : ''}` : `${m}분`;
  return `차로 약 ${dur} · ${t.km < 10 ? t.km.toFixed(1) : Math.round(t.km)}km`;
}
/** 두 점 사이 직선 거리(km). 경로를 못 받을 때 대략값 */
export function haversineKm(a, b) {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
