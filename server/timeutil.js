'use strict';
// 事件/窗口时间文本的解析、日历合法性校验与“实际时刻”比较。
//
// 时间文本允许两种既有写法，均原样保留在 events.event_time 中（不做归一化改写）：
//   - 分钟精度：2026-10-01T09:00
//   - 带秒写法：2026-10-01T09:00:00
// 两种写法指同一实际时刻（分钟写法即该分钟的 00 秒）。所有冲突/先后判断都以
// 解析后的实际时刻为准，不能直接比较原始字符串——否则
// "2026-10-01T09:00" 与 "2026-10-01T09:00:00" 会被误判为不同时刻。
//
// 写入入口还须先过日历校验（calendarTimeError）：只接受真实存在的公历日期与
// 合法时分秒（闰年按公历判定），2026-02-30T09:00、2026-10-01T25:61 之类
// “不存在的时刻”在写入前拒绝，不得进入排序、窗口冲突与批次引用判断。

const EVENT_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// 日历时间解析（含字段捕获）：与 EVENT_TIME_RE 同形，另带出各字段。
const EVENT_TIME_PARTS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

// 公历闰年：能被 4 整除但不能被 100 整除，或能被 400 整除
// （2000 年是闰年；1900/2100 年不是；2024 是，2026 不是）。
function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// 校验时间文本是否对应真实存在的日历时刻（字符格式 + 公历日期 + 合法时分秒）。
// 合法返回 null；非法返回中文原因，供各写入入口拼接拒绝信息。
// 仅按字符格式校验会放过 2026-02-30T09:00（2 月没有 30 日）、2026-10-01T25:61
// （不存在 25 时 61 分）等“不存在的时刻”，使其参与排序、窗口冲突与批次引用判断。
function calendarTimeError(t) {
  const s = String(t);
  const m = EVENT_TIME_PARTS_RE.exec(s);
  if (!m) return '格式应为 YYYY-MM-DDTHH:MM 或 YYYY-MM-DDTHH:MM:SS';
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  const second = m[6] === undefined ? 0 : parseInt(m[6], 10);
  if (month < 1 || month > 12) {
    return `月份 ${m[2]} 不存在（月份须在 01–12 之间）`;
  }
  const dim = month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1];
  if (day < 1 || day > dim) {
    const leapNote = month === 2 ? (isLeapYear(year) ? '（闰年）' : '（平年）') : '';
    return `${year} 年 ${month} 月${leapNote}只有 ${dim} 天，日期 ${m[3]} 不存在`;
  }
  if (hour > 23) return `小时 ${m[4]} 不存在（小时须在 00–23 之间）`;
  if (minute > 59) return `分钟 ${m[5]} 不存在（分钟须在 00–59 之间）`;
  if (second > 59) return `秒 ${m[6]} 不存在（秒须在 00–59 之间）`;
  return null;
}

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
  isLeapYear,
  calendarTimeError,
  normTime,
  sameInstant,
  instantBefore,
  compareEvents,
  eventsByInstant
};
