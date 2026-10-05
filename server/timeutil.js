'use strict';
// 事件/窗口时间文本的解析与“实际时刻”比较。
//
// 时间文本允许两种既有写法，均原样保留在 events.event_time 中（不做归一化改写）：
//   - 分钟精度：2026-10-01T09:00
//   - 带秒写法：2026-10-01T09:00:00
// 两种写法指同一实际时刻（分钟写法即该分钟的 00 秒）。所有冲突/先后判断都以
// 解析后的实际时刻为准，不能直接比较原始字符串——否则
// "2026-10-01T09:00" 与 "2026-10-01T09:00:00" 会被误判为不同时刻。

const EVENT_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// 统一补成定长 19 位含秒形式（分钟写法补 ":00"）。
// 定长后各位置含义相同，字典序与实际时刻先后一致，可直接用 < / > 比较。
function normTime(t) {
  const s = String(t);
  return s.length === 16 ? `${s}:00` : s;
}

// 实际时刻是否为同一刻（分钟写法与带秒写法按同一刻处理）。
function sameInstant(a, b) {
  return normTime(a) === normTime(b);
}

// 实际时刻比较：a 早于 b（严格）。
function instantBefore(a, b) {
  return normTime(a) < normTime(b);
}

// 事件比较器：先按实际时刻，再按事件 id（同刻同设备本就非法；
// 同刻跨设备与同刻但文本写法不同的记录需要确定的回放/展示次序，以 id 兜底）。
function compareEvents(a, b) {
  const ta = normTime(a.event_time);
  const tb = normTime(b.event_time);
  if (ta < tb) return -1;
  if (ta > tb) return 1;
  return a.id - b.id;
}

// 排序事件集合（不修改入参），供“SQL ORDER BY event_time,id”之后纠正
// 分钟/带秒混排造成的次序偏差。
function eventsByInstant(events) {
  return events.slice().sort(compareEvents);
}

module.exports = {
  EVENT_TIME_RE,
  normTime,
  sameInstant,
  instantBefore,
  compareEvents,
  eventsByInstant
};
