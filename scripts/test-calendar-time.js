'use strict';
// 日历时间校验的端到端 HTTP 测试：不存在的时刻（2026-02-30T09:00、2026-10-01T25:61 等）
// 在写入前拒绝，不得进入排序、窗口冲突与批次引用判断。
// 启动使用临时 SQLite 文件的真实服务（空白库，自建数据），验证四条写入入口：
//   1. 加工/清洗事件（POST/PUT /api/events）：非法日历时间 400 整次拒绝、原事件不变；
//      合法边界时间（闰日 2024-02-29、月末、23:59:59）仍按现有规则接受且原文保留；
//      同刻异写冲突等既有判定规则不变。
//   2. 检修停机窗口（POST/PUT /api/downtime-windows）：非法起止 400，窗口清单不变；
//      合法边界窗口（跨闰日整天）可登记，原文保留。
//   3. 断网整包补录（POST /api/backfills）：包内非法时间整包回滚（不写事件、不写台账）；
//      合法闰日补录成功。
//   4. 换线预演/确认（POST /api/replan/preview|apply）：非法时间预演即 400、不改正式数据；
//      合法预演可确认应用。
// 闰年按公历判定：2024/2000 是闰年（2 月 29 日合法），2026/1900/2100 不是。
//   node scripts/test-calendar-time.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39168';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-time-test-'));
const dbPath = path.join(tmpDir, 'test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error('  ✗ ' + name, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

async function api(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(proc) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/api/state');
      if (res.ok) return;
    } catch (_) { /* 未就绪 */ }
    if (proc.exitCode !== null) throw new Error('服务提前退出');
    await sleep(250);
  }
  throw new Error('服务启动超时');
}

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', DB_PATH: dbPath, SEED_DEMO: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    const newId = async (url, body) => (await api('POST', url, body)).json.id;
    const MILK = await newId('/api/materials', { code: 'MILK', name: '全脂奶粉', allergens: ['乳'] });
    const LINE = await newId('/api/equipment', { code: 'LINE-A', name: '烘焙A线' });
    const LINE2 = await newId('/api/equipment', { code: 'LINE-B', name: '烘焙B线' });
    const state = async () => (await api('GET', '/api/state')).json;
    const eventCount = async () => (await state()).events.length;
    const windowCount = async () => (await api('GET', '/api/downtime-windows')).json.windows.length;
    let r;

    // ---------- 1. 单条事件：非法日历时间写入前拒绝 ----------
    console.log('1) 加工/清洗事件：不存在的时刻 400 拒绝，不产生事件');
    const badTimes = [
      ['2026-02-30T09:00', '2 月 30 日不存在'],
      ['2026-02-29T09:00', '2026 为平年，2 月 29 日不存在'],
      ['1900-02-29T09:00', '1900 整百年非闰'],
      ['2100-02-29T09:00', '2100 整百年非闰'],
      ['2026-10-01T25:61', '25 时 61 分不存在'],
      ['2026-10-01T23:60', '60 分不存在'],
      ['2026-10-01T23:59:60', '60 秒不存在'],
      ['2026-13-01T09:00', '13 月不存在'],
      ['2026-04-31T09:00', '4 月 31 日不存在'],
      ['2026-01-00T09:00', '0 日不存在']
    ];
    for (const [t, label] of badTimes) {
      const before = await eventCount();
      r = await api('POST', '/api/events', {
        type: 'PROCESS', event_time: t, equipment_id: LINE,
        batch_code: `B-BAD-${t}`, material_ids: [MILK]
      });
      check(`非法时间拒绝（${label}：${t}）`, r.status === 400, r.json);
      check(`拒绝原因点明日历非法（${t}）`,
        r.json && typeof r.json.error === 'string' && r.json.error.includes('日历时间'),
        r.json);
      check(`整次拒绝：事件数不变（${t}）`, (await eventCount()) === before);
    }
    // 清洗事件同样校验
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-02-30T09:00:00', equipment_id: LINE, note: 'x'
    });
    check('清洗事件带秒写法的非法日期同样拒绝', r.status === 400, r.json);

    // 合法边界时间仍按现有规则接受，原文保留
    console.log('2) 合法边界时间（闰日/月末/23:59:59）接受且原文保留');
    const goodTimes = [
      '2024-02-29T09:00',      // 闰日（分钟写法）
      '2024-02-29T09:30:00',   // 闰日（带秒写法）
      '2000-02-29T10:00',      // 整 400 年闰日
      '2026-02-28T23:59:59',   // 平年 2 月最后合法时刻
      '2026-04-30T23:59',      // 小月末
      '2026-12-31T23:59'       // 年末
    ];
    let firstGoodId = null;
    for (const t of goodTimes) {
      r = await api('POST', '/api/events', {
        type: 'PROCESS', event_time: t, equipment_id: LINE,
        batch_code: `B-OK-${t}`, material_ids: [MILK]
      });
      check(`合法边界时间接受（${t}）`, r.status === 200, r.json);
      if (firstGoodId === null) firstGoodId = r.json && r.json.id;
      check(`原文保留（${t}）`,
        (await state()).events.some((e) => e.event_time === t));
    }

    // 既有规则不变：闰日同刻异写仍判同设备冲突
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2024-02-29T09:00:00', equipment_id: LINE, note: '同刻清洗'
    });
    check('同刻异写冲突规则不变（2024-02-29T09:00:00 同设备拒绝）',
      r.status === 400 && r.json.details && r.json.details.some((d) => d.includes('时间冲突')),
      r.json);

    // 更正为非法时间：拒绝且原事件不变
    console.log('3) 单条更正：非法时间拒绝，原事件与推导结论不变');
    const beforeCorr = await state();
    r = await api('PUT', `/api/events/${firstGoodId}`, {
      type: 'PROCESS', event_time: '2026-02-30T09:00', equipment_id: LINE,
      batch_code: 'B-OK-2024-02-29T09:00', material_ids: [MILK]
    });
    check('更正为 2026-02-30T09:00 拒绝', r.status === 400, r.json);
    const afterCorr = await state();
    check('被拒更正不改变事件时间原文',
      afterCorr.events.some((e) => e.id === firstGoodId && e.event_time === '2024-02-29T09:00'));
    check('被拒更正不改变推导结论',
      JSON.stringify(beforeCorr.batches.map((b) => [b.code, b.allergens])) ===
      JSON.stringify(afterCorr.batches.map((b) => [b.code, b.allergens])));
    // 合法更正（另一真实时刻）仍接受
    r = await api('PUT', `/api/events/${firstGoodId}`, {
      type: 'PROCESS', event_time: '2024-02-29T09:15', equipment_id: LINE,
      batch_code: 'B-OK-2024-02-29T09:00', material_ids: [MILK]
    });
    check('合法更正接受（2024-02-29T09:15）', r.status === 200, r.json);

    // ---------- 4. 停机窗口：非法起止拒绝，合法边界可登记 ----------
    console.log('4) 检修停机窗口：非法起止 400，合法边界窗口登记成功');
    const beforeWin = await windowCount();
    r = await api('POST', '/api/downtime-windows', {
      equipment_id: LINE, start_time: '2026-02-30T08:00', end_time: '2026-03-01T08:00',
      reason: '非法起点', operator: '张工'
    });
    check('窗口起点 2026-02-30 拒绝', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    check('窗口拒绝原因点明日历非法',
      r.json && typeof r.json.error === 'string' && r.json.error.includes('日历时间'), r.json);
    r = await api('POST', '/api/downtime-windows', {
      equipment_id: LINE, start_time: '2026-10-01T08:00', end_time: '2026-10-01T25:00',
      reason: '非法终点', operator: '张工'
    });
    check('窗口终点 25:00 拒绝', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    check('非法窗口不落地：窗口数不变', (await windowCount()) === beforeWin);

    // 合法边界：跨闰日整天（带秒终点），起点=终点仍按既有规则拒绝
    r = await api('POST', '/api/downtime-windows', {
      equipment_id: LINE2, start_time: '2024-02-29T00:00', end_time: '2024-02-29T23:59:59',
      reason: '闰日检修', operator: '张工'
    });
    check('闰日整天窗口登记成功', r.status === 200, r.json);
    const winId = r.json && r.json.id;
    check('窗口时间原文保留',
      r.json && r.json.start_time === '2024-02-29T00:00' && r.json.end_time === '2024-02-29T23:59:59',
      r.json);
    r = await api('POST', '/api/downtime-windows', {
      equipment_id: LINE2, start_time: '2026-03-01T08:00', end_time: '2026-03-01T08:00',
      reason: '起止相同', operator: '张工'
    });
    check('起点不早于终点仍按既有规则拒绝', r.status === 400, r.json);

    // 调整为非法时间：拒绝且原窗口不变
    r = await api('PUT', `/api/downtime-windows/${winId}`, {
      equipment_id: LINE2, start_time: '2024-02-29T00:00', end_time: '2026-02-30T08:00',
      reason: '非法调整', operator: '张工'
    });
    check('窗口调整为非法终点拒绝', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('GET', `/api/downtime-windows/${winId}`);
    check('被拒调整不改变原窗口',
      r.json && r.json.end_time === '2024-02-29T23:59:59' && r.json.reason === '闰日检修', r.json);

    // ---------- 5. 断网整包补录：包内非法时间整包回滚 ----------
    console.log('5) 断网补录：包内非法时间整包回滚（不写事件、不写台账）');
    const beforeBf = await eventCount();
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-CAL-1',
      records: [
        { external_ref: 'R1', type: 'PROCESS', event_time: '2026-10-02T08:00',
          equipment_id: LINE, batch_code: 'BF-CAL-B1', material_ids: [MILK] },
        { external_ref: 'R2', type: 'PROCESS', event_time: '2026-02-30T09:00',
          equipment_id: LINE, batch_code: 'BF-CAL-B2', material_ids: [MILK] }
      ]
    });
    check('包内含 2026-02-30 整包拒绝', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    check('拒绝明细点明日历非法',
      r.json && Array.isArray(r.json.details) &&
        r.json.details.some((d) => d.includes('records[1]') && d.includes('日历时间')),
      r.json);
    check('整包回滚：事件数不变', (await eventCount()) === beforeBf);
    r = await api('GET', '/api/backfills/BF-CAL-1');
    check('整包回滚：补录台账不存在（404）', r.status === 404);

    // 合法闰日补录成功（含带秒写法）
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-CAL-2',
      records: [
        { external_ref: 'S1', type: 'PROCESS', event_time: '2024-02-29T08:00',
          equipment_id: LINE, batch_code: 'BF-CAL-OK1', material_ids: [MILK] },
        { external_ref: 'S2', type: 'CLEAN', event_time: '2024-02-29T08:30:00',
          equipment_id: LINE, note: '闰日带秒清洗' }
      ]
    });
    check('合法闰日补录包成功', r.status === 200, r.json);
    check('补录写入 2 条事件',
      r.json && r.json.impact_summary && r.json.impact_summary.inserted_events === 2, r.json);

    // ---------- 6. 换线预演/确认：非法时间预演即拒绝 ----------
    console.log('6) 换线预演：非法时间 400，不改正式数据；合法预演可确认');
    const st6 = await state();
    const target = st6.events.find((e) => e.event_time === '2024-02-29T09:15');
    check('找到待更正事件', !!target);
    const beforePrev = await eventCount();
    r = await api('POST', '/api/replan/preview', {
      changes: [
        { op: 'update', event_id: target.id, type: 'PROCESS',
          event_time: '2026-10-01T25:61', equipment_id: LINE,
          batch_code: 'B-OK-2024-02-29T09:00', material_ids: [MILK] }
      ]
    });
    check('预演更正为 25:61 拒绝', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    check('预演拒绝明细点明日历非法',
      r.json && Array.isArray(r.json.details) &&
        r.json.details.some((d) => d.includes('日历时间')),
      r.json);
    r = await api('POST', '/api/replan/preview', {
      changes: [
        { op: 'insert_clean', event_time: '2026-02-29T09:00',
          equipment_id: LINE, note: '平年闰日清洗' }
      ]
    });
    check('预演插入平年 2 月 29 日清洗拒绝', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    check('预演拒绝不写正式数据（事件数不变）', (await eventCount()) === beforePrev);
    check('预演拒绝不改变原事件时间',
      (await state()).events.some((e) => e.id === target.id && e.event_time === '2024-02-29T09:15'));

    // 合法预演（闰日另一时刻）成功并可确认应用
    const okChanges = [
      { op: 'update', event_id: target.id, type: 'PROCESS',
        event_time: '2024-02-29T09:20', equipment_id: LINE,
        batch_code: 'B-OK-2024-02-29T09:00', material_ids: [MILK] }
    ];
    r = await api('POST', '/api/replan/preview', { changes: okChanges });
    check('合法预演成功', r.status === 200 && r.json.version, r.json);
    const version = r.json.version;
    r = await api('POST', '/api/replan/apply', { version, changes: okChanges });
    check('合法确认应用成功', r.status === 200, r.json);
    check('应用后事件时间更新',
      (await state()).events.some((e) => e.id === target.id && e.event_time === '2024-02-29T09:20'));

  } finally {
    proc.kill();
  }

  if (failures) {
    console.error(`\n${failures} 项检查失败`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch((err) => {
  console.error('测试执行异常：', err);
  process.exit(1);
});
