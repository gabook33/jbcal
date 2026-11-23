// 이 앱 판 번호. 바꿀 때는 version.json 의 version·sw, sw.js 의 VERSION 을 같이 바꾼다(tests/version.test.mjs 가 확인).
// 앱은 열 때·다시 볼 때 서버의 version.json 과 이 값을 비교해, 다르면 「새 버전 적용」 띠를 띄운다.
export const APP_VERSION = 'v17';
