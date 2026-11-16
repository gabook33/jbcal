// 할 일 묶기·정렬 (순수 함수, 테스트 대상). 날짜는 time.js 와 같이 서울 0시 타임스탬프.
import { DAY } from './time.js';

/** 같은 마감일 안에서는 구글 순서(position), 없으면 제목 순 */
export const byOrder = (a, b) => (a.due ?? Infinity) - (b.due ?? Infinity)
  || String(a.position).localeCompare(String(b.position)) || a.title.localeCompare(b.title, 'ko');

/** 날짜별 목록에 넣을 할 일: 그날 마감인 것(완료 포함). 오늘 칸에는 마감이 지났는데 안 끝낸 것도 함께 */
export function tasksForDay(tasks, d, today) {
  return tasks
    .filter((t) => t.due === d || (d === today && !t.done && t.due != null && t.due < today))
    .sort((a, b) => (a.done - b.done) || byOrder(a, b));
}

/** 할 일 화면 묶음: 지난 마감 / 오늘 / 내일 / 이후 / 마감일 없음 / 완료(최근 것부터, 최대 limit 개) */
export function groupTasks(tasks, today, { doneLimit = 30 } = {}) {
  const open = tasks.filter((t) => !t.done).sort(byOrder);
  const g = {
    overdue: open.filter((t) => t.due != null && t.due < today),
    today: open.filter((t) => t.due === today),
    tomorrow: open.filter((t) => t.due === today + DAY),
    later: open.filter((t) => t.due != null && t.due > today + DAY),
    none: open.filter((t) => t.due == null),
    done: tasks.filter((t) => t.done).sort((a, b) => (b.completed || 0) - (a.completed || 0)).slice(0, doneLimit),
  };
  g.doneTotal = tasks.length - open.length;
  return g;
}
