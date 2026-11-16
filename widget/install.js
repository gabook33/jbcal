// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: red; icon-glyph: download;

// JB's 캘린더 위젯 설치·업데이트 도우미
// 이 스크립트를 실행하면 최신 위젯 스크립트를 받아 「JB 캘린더」라는 이름으로 저장한다.
// (계정·비밀번호를 쓰지 않는다. 다시 실행하면 최신판으로 덮어쓴다.)
const SRC = "https://gabook33.github.io/jbcal/widget/JBCalendarWidget.js";
const NAME = "JB 캘린더";
const fm = module.filename.includes("iCloud~") ? FileManager.iCloud() : FileManager.local();
const req = new Request(SRC + "?t=" + Date.now());
const code = await req.loadString();
const a = new Alert();
if (req.response.statusCode !== 200 || !code.includes("JB's 캘린더 위젯")) {
  a.title = "받기 실패";
  a.message = "인터넷 연결을 확인하고 다시 실행하세요.";
} else {
  fm.writeString(fm.joinPath(fm.documentsDirectory(), NAME + ".js"), code);
  a.title = "설치 완료";
  a.message = `「${NAME}」 스크립트가 저장되었습니다.\n스크립트 목록에서 「${NAME}」을 한 번 실행해 캘린더 접근을 허용하세요.`;
}
a.addAction("확인");
await a.present();
Script.complete();
