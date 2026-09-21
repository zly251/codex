// 巡航调度器（autopilot）：把已有的「同步反馈 → 回消息 → 发打招呼 → 写摘要」这些动作
// 串成一个一直跑下去的循环，让宿主可以「一键启动，自己跑到任务完成」。
//
// 为什么这里不 import 任何业务模块：这些动作在宿主里已经有现成实现（routes.mjs /
// applyScheduler.js / chatApply.js …），调度器只该负责「什么时候跑、什么顺序跑、某步挂了怎么办」。
// 依赖全部走 deps 注入，好处有三：避开循环依赖、宿主替换实现不用改调度器、
// 自检脚本能塞假动作从而完全不碰浏览器和网络（这台机器内存紧张，跑不起真浏览器）。

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 正常巡航间隔 10 分钟
const DEFAULT_IDLE_INTERVAL_MS = 30 * 60 * 1000; // 空闲巡检间隔 30 分钟
const MAX_LOGS = 50; // 日志环形缓冲上限，长跑不能无限长

export function createAutopilot(deps = {}) {
  const d = deps || {};
  // 三个可选项缺省实现：log 走控制台，now 走 Date.now，sleep 走真实 setTimeout。
  // sleep 之所以要能注入：测试必须用假 sleep，否则一轮测试要真等 10 分钟。
  const logFn = typeof d.log === "function" ? d.log : (msg) => console.log(msg);
  const nowFn = typeof d.now === "function" ? d.now : () => Date.now();
  const sleepFn = typeof d.sleep === "function" ? d.sleep : (ms) => new Promise((r) => setTimeout(r, ms));

  // 内部状态。status() 只返回它的副本，宿主改返回值不能污染调度器。
  const state = {
    running: false,
    phase: "idle", // 还没跑过任何一轮时就是空闲态
    round: 0, // 已执行轮数（含 need_login / browser_error 这些空转轮）
    startedAt: 0,
    lastRoundAt: 0,
    stoppedAt: 0,
    lastError: null,
    needLogin: false,
    intervalMs: DEFAULT_INTERVAL_MS,
    idleIntervalMs: DEFAULT_IDLE_INTERVAL_MS,
    // replenished/autoApproved 只在注入对应 dep 时才会增长；默认（未注入）恒为 0，保持原行为。
    stats: { rounds: 0, replied: 0, sent: 0, summaries: 0, errors: 0, replenished: 0, autoApproved: 0 },
    logs: [],
  };
  let maxRounds = Infinity; // 只在 start(opts) 里赋值，连跑多少轮后自动收工
  let ticking = false; // 单轮重入锁：外部在循环跑到一半时又调 tick()，直接跳过 —— 打招呼最怕同一批岗位被并发发两次
  let runGen = 0; // 运行代数：stop() 后自增，正在 await 的循环醒来发现代数变了就立刻退出，保证 stop() 之后不再有任何一轮
  let queueRemaining = 1; // 初值 1 只是「首次运行必须跑一次 applyQueue」的开关，不代表真实队列长度
  let stoppedForMaxRounds = false;

  // 计数归一化：宿主动作可能少返回某字段，统一按 0 处理，避免 undefined 污染 stats 累加
  const n0 = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const posOr = (v, dflt) => (typeof v === "number" && v > 0 ? v : dflt);

  function note(msg) {
    const entry = { t: nowFn(), msg: String(msg) };
    state.logs.push(entry);
    if (state.logs.length > MAX_LOGS) state.logs.shift(); // 先进先出：只留最近 50 条
    try {
      logFn(entry.msg);
    } catch {
      // 宿主日志写挂了也不能影响巡航，吞掉
    }
  }

  // 统一的失败记录：一处失败同时体现在 lastError、stats.errors 和日志里
  function fail(err, where) {
    const msg = `${where} 失败：${err && err.message ? err.message : String(err)}`;
    state.lastError = msg;
    state.stats.errors += 1;
    note(msg);
    return msg;
  }

  // 一轮的真正执行体。所有返回值都是结果对象，不抛异常。
  async function runRound(t0, round) {
    const errs = []; // 本轮各步骤的失败信息，逐步累积，不中断后续步骤
    let replied = 0;
    let sendFailed = 0; // 尝试回复但未送达的条数：不能不算数地归入"没事了"，否则又会假装排空
    let sent = 0;
    let summaries = 0;
    let remaining = 0;
    let pending = 0;
    let replenished = 0; // 本轮补库存新增的岗位数（搜索+增补），仅在注入 replenish 时增长
    let autoApproved = 0; // 本轮自动放行的待确认岗位数，仅在注入 autoApprove 时增长
    let queueOk = true; // 只有「队列和待回消息都成功跑过且都排空」才算空闲，某步失败时宁可继续按正常节奏跑
    let chatOk = true;
    let applyBlocked = false; // 投递命中 BOSS 账号访问受限/连续打不开熔断 → 本轮结束即整体停机（见 loop）
    let loginJustConfirmed = false; // 本轮步骤 1 已确认登录恢复时为 true，步骤 3 不再重复检查

    // —— 1. 已经判定需要登录：只探测登录态，别的动作一律不碰 ——
    // 为什么：未登录时每个动作都会撞上登录墙，反复去撞最容易触发 BOSS 风控，宁可空转一轮。
    // 这里也不重置 needLogin —— 探测失败说明还没登，保持原状。
    if (state.needLogin) {
      let ok = false;
      try {
        ok = !!d.checkLogin && !!(await d.checkLogin());
      } catch (e) {
        fail(e, "needLogin 期间 checkLogin");
      }
      if (!ok) {
        state.phase = "need_login";
        return { phase: "need_login", skipped: true, round, needLogin: true, ms: nowFn() - t0 };
      }
      state.needLogin = false;
      loginJustConfirmed = true; // 本轮已确认登录，跳过步骤 3 的重复检查（见下）
      note("检测到登录已恢复，继续自动巡航");
    }

    // —— 2. 浏览器没连就补连 ——
    let connected = true;
    try {
      connected = !d.isBrowserConnected || !!d.isBrowserConnected();
    } catch (e) {
      connected = false;
      errs.push(fail(e, "isBrowserConnected"));
    }
    if (!connected) {
      try {
        await d.connectBrowser();
        note("浏览器已连接");
      } catch (e) {
        state.phase = "browser_error";
        const msg = fail(e, "connectBrowser");
        return { phase: "browser_error", round, error: msg, ms: nowFn() - t0 };
      }
    }

    // —— 3. 登录检查：没登录就停下来等扫码，不做任何其他动作 ——
    // 例外：本轮步骤 1 刚刚确认过登录已恢复（loginJustConfirmed），不再重复检查。
    // 为什么：checkLoggedIn 会读页面 innerText 找"登录/注册"，BOSS 页面渲染/跳转有瞬时抖动，
    // 同一轮里连查两次很容易一次 true 一次 false，导致"检测到登录已恢复"后立刻又"未登录"，
    // 循环被永久卡在 need_login（2026-09-21 真机复现）。步骤 1 的探测本身就是权威判据，
    // 刚确认过就没必要在毫秒级内再问一次；下一轮若真掉登录，步骤 3 仍会拦住。
    let logged = false;
    try {
      logged = loginJustConfirmed || !!(await d.checkLogin());
    } catch (e) {
      errs.push(fail(e, "checkLogin"));
    }
    if (!logged) {
      state.needLogin = true;
      state.phase = "need_login";
      note("未登录：请扫码登录 BOSS 直聘，登录成功前自动巡航不会做任何投递动作");
      return { phase: "need_login", round, needLogin: true, ms: nowFn() - t0 };
    }

    // —— 4. 正常巡航：动作按固定顺序跑，每步单独 try/catch ——
    // 为什么每步都要单独兜：某一处失败（比如某页选择器变了）不该让整轮白跑，
    // 后面几步往往是独立的、还能正常出成果。
    //
    // replenish / autoApprove 两步是"无人值守补库存 + 自动放行"（2026-09-21 新增）：
    // 缺省（未注入对应 dep）时完全不跑，管线与新增前逐字节一致；只有宿主注入这两个 dep
    // 且 .env 开关打开时，巡航才自己搜新岗、增补、并把达标的待确认岗位放行进投递集合。

    // 4.0 补库存（可选）：搜索新岗 + 详情增补，让巡航自己找活、不必人工先搜。
    try {
      if (typeof d.replenish === "function") {
        const r = await d.replenish();
        replenished = n0(r && r.searched) + n0(r && r.enriched);
      }
    } catch (e) {
      errs.push(fail(e, "replenish"));
    }

    // 4.1 同步聊天反馈（把页面上的新回复、状态变化抓回来）
    try {
      await d.syncFeedback();
    } catch (e) {
      errs.push(fail(e, "syncFeedback"));
    }

    // 4.2 把待回复的 HR 消息回掉
    try {
      const r = await d.replyDueChats();
      replied = n0(r && r.replied);
      sendFailed = n0(r && r.failed);
      pending = n0(r && r.pending);
    } catch (e) {
      chatOk = false;
      pending = 0; // 拿不到真实余量，按 0 展示，但下面的空闲判定会因 chatOk=false 拦住
      errs.push(fail(e, "replyDueChats"));
    }

    // 4.25 自动放行（可选）：无人值守时把达标的待确认岗位放进投递集合。
    // 放在 applyQueue 之前 ⇒ 本轮放行的岗位本轮就能按节奏发出，不必等下一轮。
    try {
      if (typeof d.autoApprove === "function") {
        const r = await d.autoApprove();
        autoApproved = n0(r && r.approved);
      }
    } catch (e) {
      errs.push(fail(e, "autoApprove"));
    }

    // 4.3 按节奏发打招呼。每轮都探一次队列：宿主适配器在"无可发"时是廉价空操作，
    // 而用户要的是"一键启动后一直跑到完成"——中途新搜到的岗位也必须能发出去，
    // 不能因为上一轮排空就永久不再调用（2026-09-19 修正原先"排空后不再调用"的设计）。
    try {
      const r = await d.applyQueue();
      sent = n0(r && r.sent);
      remaining = n0(r && r.remaining);
      queueRemaining = remaining;
      applyBlocked = !!(r && r.blocked); // 命中访问受限熔断：本轮结束即停机，不再巡检
    } catch (e) {
      queueOk = false;
      queueRemaining = 1; // 出错了就下一轮重试，别因为一次异常把发送永久停掉
      errs.push(fail(e, "applyQueue"));
    }

    // 4.4 生成本轮会话要点摘要
    try {
      const r = await d.writeSummaries();
      summaries = n0(r && r.written);
    } catch (e) {
      errs.push(fail(e, "writeSummaries"));
    }

    // —— 5. 汇总本轮并累加到 stats ——
    state.stats.rounds += 1;
    state.stats.replied += replied;
    state.stats.sent += sent;
    state.stats.summaries += summaries;
    state.stats.replenished += replenished;
    state.stats.autoApproved += autoApproved;

    // —— 6. 空闲判定：待发 0、待回 0，且本轮没有"尝试过但没送达"的回复 ——
    // 空闲不是退出，只是把节奏降到 idleIntervalMs 继续低频巡检（用户要的是「一直跑」）。
    // sendFailed>0 时必须保持 working 节奏尽快重试：未送达的会话不会被标已回复，
    // 下一轮会重新扫到，若此时转入 30 分钟低频巡检，送达延迟会被无谓拉长。
    const idle = queueOk && chatOk && remaining === 0 && pending === 0 && sendFailed === 0;
    let phase = idle ? "idle" : "working";
    if (applyBlocked) phase = "blocked"; // 账号被限流/封禁：单独一档，供 loop 识别后整体停机
    state.phase = phase;
    if (applyBlocked) {
      note(`第 ${round} 轮：检测到 BOSS 账号访问受限，已停止投递。为避免延长封禁，自动巡航整体停机，请等待解封（通常 24h）后手动重启。`);
    } else {
      note(
        idle
          ? `第 ${round} 轮结束：队列与待回消息都已排空，转入低频巡检`
          : `第 ${round} 轮结束：回复 ${replied} 条、未送达 ${sendFailed} 条、打招呼 ${sent} 个、待回 ${pending}、待发 ${remaining}`
      );
    }
    // 补库存/自动放行有动作时单列一行，避免动到上面这条既有日志（存量断言只增不减）。
    if (replenished > 0 || autoApproved > 0) {
      note(`第 ${round} 轮：补库存 ${replenished}（搜索+增补）、自动放行 ${autoApproved}`);
    }
    return { phase, round, replied, failed: sendFailed, sent, remaining, pending, summaries, replenished, autoApproved, blocked: applyBlocked, ms: nowFn() - t0, errors: errs };
  }

  // 对外承诺：任何情况下都不抛异常 —— 兜底 catch 把 runRound 里漏网的意外（含 deps 里的同步 throw）收干净
  async function tick() {
    if (ticking) {
      return { phase: state.phase, skipped: true, reason: "round_in_progress", round: state.round };
    }
    ticking = true;
    const t0 = nowFn();
    const round = state.round + 1;
    state.round = round;
    state.lastRoundAt = t0;
    try {
      return await runRound(t0, round);
    } catch (e) {
      const msg = fail(e, "tick");
      state.phase = "error";
      return { phase: "error", round, error: msg, ms: nowFn() - t0 };
    } finally {
      ticking = false;
    }
  }

  // 循环体：跑一轮 → 按当前 phase 选间隔 → 等一下 → 再跑一轮。
  // 用递归式 while + await sleep 而不是 setInterval：天然串行，上一轮没跑完不会重入。
  async function loop(gen) {
    while (state.running && gen === runGen) {
      let roundResult;
      try {
        roundResult = await tick(); // tick 自身已全 catch，这里再兜一层防止将来改坏
      } catch (e) {
        fail(e, "loop.tick");
      }
      if (!state.running || gen !== runGen) return;
      // 命中 BOSS 访问受限熔断：整体停机，不转空闲巡检。否则下一轮又会搜索+增补，
      // 正是 BOSS 明令禁止、会延长封禁的行为（2026-09-21 真机教训）。
      if (roundResult && roundResult.blocked) {
        note("因 BOSS 账号访问受限，自动巡航已停机，等待解封后手动重启。");
        stop();
        return;
      }
      if (state.round >= maxRounds) {
        stoppedForMaxRounds = true;
        note(`已达到 maxRounds=${maxRounds}，自动停止巡航`);
        stop();
        return;
      }
      const wait = state.phase === "idle" ? state.idleIntervalMs : state.intervalMs;
      try {
        await sleepFn(wait);
      } catch (e) {
        // sleep 坏掉时如果直接 continue 就变成空转热循环，所以退回 1 秒真实定时器降速
        fail(e, "sleep");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  function start(opts = {}) {
    if (state.running) return { started: false, reason: "already_running" };
    const o = opts || {};
    state.intervalMs = posOr(o.intervalMs, DEFAULT_INTERVAL_MS);
    state.idleIntervalMs = posOr(o.idleIntervalMs, DEFAULT_IDLE_INTERVAL_MS);
    maxRounds = posOr(o.maxRounds, Infinity);

    state.running = true;
    state.startedAt = nowFn();
    state.stoppedAt = 0;
    stoppedForMaxRounds = false;
    runGen += 1;
    const gen = runGen;
    note(
      `自动巡航已启动（正常间隔 ${Math.round(state.intervalMs / 1000)}s，空闲间隔 ` +
        `${Math.round(state.idleIntervalMs / 1000)}s，maxRounds=${maxRounds}）`
    );
    // 不 await：start() 立刻返回，循环在后台跑。首轮立即执行（不留空窗），之后才按间隔等。
    loop(gen).catch((e) => fail(e, "loop"));
    return { started: true };
  }

  function stop() {
    if (!state.running) return { stopped: false };
    state.running = false;
    runGen += 1; // 让正在 await 的循环醒来后立刻退出
    state.stoppedAt = nowFn();
    note(stoppedForMaxRounds ? "自动巡航已停止（达到轮数上限）" : "自动巡航已停止");
    return { stopped: true };
  }

  function status() {
    return {
      running: state.running,
      phase: state.phase,
      round: state.round,
      startedAt: state.startedAt,
      lastRoundAt: state.lastRoundAt,
      stoppedAt: state.stoppedAt,
      lastError: state.lastError,
      needLogin: state.needLogin,
      intervalMs: state.intervalMs,
      idleIntervalMs: state.idleIntervalMs,
      stats: { ...state.stats },
      logs: state.logs.map((l) => ({ t: l.t, msg: l.msg })),
    };
  }

  return { start, stop, status, tick };
}
