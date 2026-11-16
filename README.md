# JB's 캘린더

정적 PWA입니다. 공개 주소: https://gabook33.github.io/jbcal/

구글 클라이언트 ID를 넣기 전에는 **데모 모드**로 열립니다.

## 클라이언트 ID 넣는 위치

`config.js` **7행** `clientId: ''` 의 따옴표 안에 웹 클라이언트 ID를 넣습니다.

```js
clientId: '1234567890-abcdefg.apps.googleusercontent.com',
```

구글 클라우드에 등록할 값:

- 승인된 자바스크립트 원본: `https://gabook33.github.io` (끝 슬래시 없이)
- 승인된 리디렉션 URI: `https://gabook33.github.io/jbcal/` (끝 슬래시 포함)
- 로컬 테스트용 원본: `http://localhost:8080` / 리디렉션: `http://localhost:8080/`

클라이언트 보안 비밀번호(client secret)는 쓰지 않습니다.
