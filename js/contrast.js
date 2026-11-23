// 색 바탕 위 글자색 자동 결정(WCAG 2 대비). 일정·캘린더 색은 사용자가 아무 색이나 고를 수 있어서
// (연한 색으로 바꾸면 흰 글자가 안 보인다) 실제로 그려지는 바탕색의 휘도로 흰/진회색 중 대비가 큰 쪽을 쓴다.
export const INK_LIGHT = '#ffffff';
export const INK_DARK = '#1c1c1e';
export const MIN_RATIO = 4.5;

/** '#rgb' '#rrggbb' 'rgb(r g b)' 'rgb(r, g, b)' → [r, g, b] (모르는 값이면 null) */
export function parseColor(s) {
  s = String(s || '').trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16));
  m = s.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) return [m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(255, Math.round(+v))));
  return null;
}
const hex2 = (v) => Math.round(v).toString(16).padStart(2, '0');
export const toHex = (rgb) => `#${rgb.map(hex2).join('')}`;
/** 상대 휘도(WCAG 2) */
export function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** CSS color-mix(in srgb, a p%, b) 와 같은 섞기 */
export const mix = (a, b, p) => a.map((v, i) => v * p + b[i] * (1 - p));
const round = (rgb) => rgb.map((v) => Math.round(v));

const LIGHT = parseColor(INK_LIGHT);
const DARK = parseColor(INK_DARK);
/** 바탕색 위에 쓸 글자색: 흰/진회색 중 대비가 큰 쪽 */
export function inkOn(bg) {
  const rgb = Array.isArray(bg) ? bg : parseColor(bg);
  if (!rgb) return INK_LIGHT;
  return ratio(rgb, LIGHT) >= ratio(rgb, DARK) ? INK_LIGHT : INK_DARK;
}

/**
 * 색을 바탕으로 칠하는 이름표(종일 일정·지금 일정 등)용 바탕·글자색.
 * 흰/진회색 중 큰 쪽도 4.5:1이 안 되는 중간 밝기 색(주황·초록 일부)만 바탕을 아주 조금 옮겨 4.5:1을 맞춘다.
 */
export function solidPair(c) {
  const rgb = parseColor(c);
  if (!rgb) return { bg: c, ink: INK_LIGHT };
  const ink = inkOn(rgb);
  if (ratio(rgb, parseColor(ink)) >= MIN_RATIO) return { bg: toHex(rgb), ink };
  // 흰 글자 → 바탕을 조금 어둡게, 진회색 글자 → 조금 밝게. 덜 옮겨도 되는 쪽을 고른다
  const nudge = (toward, inkRgb) => {
    for (let k = 1; k <= 60; k++) {
      const bg = round(mix(toward, rgb, k / 100));
      if (ratio(bg, inkRgb) >= MIN_RATIO) return { k, bg };
    }
    return { k: 99, bg: toward };
  };
  const d = nudge([0, 0, 0], LIGHT);
  const l = nudge([255, 255, 255], DARK);
  return d.k <= l.k ? { bg: toHex(d.bg), ink: INK_LIGHT } : { bg: toHex(l.bg), ink: INK_DARK };
}

/** 옅게 깐 바탕(color-mix(c t%, panel)) 위 글자: 색 기운은 남기고 4.5:1이 될 때까지 글자 쪽(text)으로 섞는다 */
export const TINTS = [0.12, 0.16, 0.2, 0.22, 0.26, 0.27];
export function tintInk(c, panel, text, start = 0.72, tints = TINTS) {
  const [rgb, p, t] = [parseColor(c), parseColor(panel), parseColor(text)];
  if (!rgb || !p || !t) return null;
  const bgs = tints.map((k) => mix(rgb, p, k));
  for (let s = start; s > 0.001; s -= 0.04) {
    const fg = round(mix(rgb, t, s));
    if (bgs.every((bg) => ratio(fg, bg) >= MIN_RATIO)) return toHex(fg);
  }
  // 글자색 그대로도 모자라면(중간 밝기 바탕) 흰/검정/진회색/글자색 중 가장 대비가 큰 것
  const worst = (fg) => Math.min(...bgs.map((bg) => ratio(fg, bg)));
  return toHex([t, LIGHT, [0, 0, 0], DARK].sort((x, y) => worst(y) - worst(x))[0]);
}

/**
 * style 속성용 CSS 변수: --c(원래 색) --cb(칠할 바탕) --ci(그 위 글자)
 * --ct / --cts(옅은 바탕 위 글자: 색 기운 72%·50%에서 시작 — 막대·이름표 / 주 보기·칩), --ctp(고른 일정 45% 바탕 위)
 */
export function colorVars(c, theme) {
  if (!parseColor(c)) return `--c:${c}`;
  const { bg, ink } = solidPair(c);
  let out = `--c:${c};--cb:${bg};--ci:${ink}`;
  if (theme) out += `;--ct:${tintInk(c, theme.panel, theme.text, 0.72)};--cts:${tintInk(c, theme.panel, theme.text, 0.5)};--ctp:${tintInk(c, theme.panel, theme.text, 0.5, [0.45])}`;
  return out;
}
