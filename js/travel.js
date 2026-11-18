// 이동 시간: 키 없이 쓰는 공개 서비스(OpenStreetMap)
//  - 장소 → 좌표: Nominatim(OSM 공식 검색, 한국 안에서). 못 찾으면 Photon(komoot).
//  - 경로·시간: OSRM 공개 서버(자동차). 대중교통·실시간 교통은 없다(대략값).
// 같은 장소는 이 기기에 저장해 두고 다시 묻지 않는다(공개 서버 사용 규칙: 적게, 천천히).
import { haversineKm } from './extras.js';

const K_GEO = 'nanal.geoCache';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const PHOTON = 'https://photon.komoot.io/api/';
const OSRM = 'https://router.project-osrm.org/route/v1/driving';

const cache = () => { try { return JSON.parse(localStorage.getItem(K_GEO)) || {}; } catch { return {}; } };

/** 장소 이름·주소 → [{name, lat, lon}] (최대 5개) */
export async function geocode(q) {
  q = String(q || '').trim();
  if (!q) return [];
  const c = cache();
  if (c[q]) return c[q];
  let list = [];
  try {
    const r = await fetch(`${NOMINATIM}?${new URLSearchParams({ q, format: 'jsonv2', limit: 5, countrycodes: 'kr', 'accept-language': 'ko' })}`);
    if (r.ok) list = (await r.json()).map((x) => ({ name: x.display_name.split(',').slice(0, 3).join(',').trim(), lat: +x.lat, lon: +x.lon }));
  } catch { /* 다음 방법 */ }
  if (!list.length) {
    try {
      const r = await fetch(`${PHOTON}?${new URLSearchParams({ q, limit: 5, bbox: '124.5,33,131,38.7' })}`);
      if (r.ok) list = ((await r.json()).features || []).map((f) => ({
        name: [f.properties.name, f.properties.district || f.properties.city].filter(Boolean).join(', '),
        lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
      }));
    } catch { /* 못 찾음 */ }
  }
  if (list.length) {
    c[q] = list;
    const keys = Object.keys(c);
    if (keys.length > 200) delete c[keys[0]];
    localStorage.setItem(K_GEO, JSON.stringify(c));
  }
  return list;
}

/** 두 점 사이 자동차 경로 {min, km, approx}. 경로 서버가 안 되면 직선 거리로 대략(시속 30km) */
export async function route(from, to) {
  try {
    const r = await fetch(`${OSRM}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`);
    if (r.ok) {
      const j = await r.json();
      const rt = j.routes?.[0];
      if (j.code === 'Ok' && rt) return { min: Math.max(1, Math.round(rt.duration / 60)), km: rt.distance / 1000, approx: false };
    }
  } catch { /* 대략값으로 */ }
  const km = haversineKm(from, to) * 1.3;
  return { min: Math.max(1, Math.round((km / 30) * 60)), km, approx: true };
}

/** 지금 위치(브라우저가 허락을 묻는다) */
export function here() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('위치를 쓸 수 없는 브라우저입니다')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ name: '현재 위치', lat: p.coords.latitude, lon: p.coords.longitude }),
      () => reject(new Error('위치 권한을 허용하지 않았습니다')),
      { timeout: 10000, maximumAge: 5 * 60e3 },
    );
  });
}
