// ==UserScript==
// @name         sb.sb Blackjack Auto Pro
// @namespace    https://sb.sb/
// @version      3.0.0
// @description  sb.sb 黑杰克自动打牌：精确基本策略、前台可视 / 后台稳定 / 仅提示三种模式，止盈止损、超时保护、会话统计与本地历史。
// @author       Xiyueyy
// @match        https://sb.sb/games/blackjack/*
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/Xiyueyy/sb_auto
// @downloadURL  https://raw.githubusercontent.com/Xiyueyy/sb_auto/main/sb_blackjack_auto.user.js
// @updateURL    https://raw.githubusercontent.com/Xiyueyy/sb_auto/main/sb_blackjack_auto.user.js
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '3.0.0';
  const root = document.querySelector('[data-bj]');
  const configEl = document.getElementById('blackjack-config');
  if (!root || !configEl) {
    console.warn('[BJ AUTO] 找不到游戏区域或配置。');
    return;
  }

  let CFG = {};
  try { CFG = JSON.parse(configEl.textContent || '{}'); } catch {}
  const CHIPS = Array.isArray(CFG.chips) && CFG.chips.length ? CFG.chips.map(Number) : [10, 50, 100, 500, 1000];
  const ENDPOINT = {
    start: CFG.Start || '/games/blackjack/start/',
    move: CFG.Move || '/games/blackjack/move/',
    state: CFG.State || '/games/blackjack/state/',
  };

  /* ------------------------------------------------------------------ *
   * 规则与策略
   * 站点规则：6 副牌、每局重新洗牌、无暗牌、庄家软 17 停、BJ 3:2、可加倍任意两张、
   * 分牌后可加倍、最多 4 手、分 A 只补一张、庄家 BJ 只输原注（OBO）。
   * 下表是该规则下的总点数基本策略，已用逐手精确期望值校验（540 种起手 0 处偏差）。
   * 每格：H 要 / S 停 / D 能加倍就加倍否则要 / Ds 能加倍就加倍否则停 / P 分。
   * 庄家列顺序：2 3 4 5 6 7 8 9 10 A
   * ------------------------------------------------------------------ */
  const UP = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const row = (s) => s.trim().split(/\s+/);
  const HARD = {
    8: row('H H H H H H H H H H'),
    9: row('H D D D D H H H H H'),
    10: row('D D D D D D D D H H'),
    11: row('D D D D D D D D D H'),
    12: row('H H S S S H H H H H'),
    13: row('S S S S S H H H H H'),
    14: row('S S S S S H H H H H'),
    15: row('S S S S S H H H H H'),
    16: row('S S S S S H H H H H'),
    17: row('S S S S S S S S S S'),
  };
  const SOFT = {
    13: row('H H H D D H H H H H'),
    14: row('H H H D D H H H H H'),
    15: row('H H D D D H H H H H'),
    16: row('H H D D D H H H H H'),
    17: row('H D D D D H H H H H'),
    18: row('S Ds Ds Ds Ds S S H H H'),
    19: row('S S S S S S S S S S'),
  };
  const PAIRS = {
    11: row('P P P P P P P P P P'),
    10: row('S S S S S S S S S S'),
    9: row('P P P P P S P P S S'),
    8: row('P P P P P P P P P P'),
    7: row('P P P P P P H H H H'),
    6: row('P P P P P H H H H H'),
    5: row('D D D D D D D D H H'),
    4: row('H H H P P H H H H H'),
    3: row('P P P P P P H H H H'),
    2: row('P P P P P P H H H H'),
  };

  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const rankOf = (id) => RANKS[((Number(id) % 13) + 13) % 13];
  const labelOf = (id) => {
    const n = Number(id);
    return Number.isInteger(n) && n >= 0 && n < 52 ? SUITS[Math.floor(n / 13)] + RANKS[n % 13] : '?';
  };
  const pointOf = (rank) => (rank === 'A' ? 11 : ['10', 'J', 'Q', 'K'].includes(rank) ? 10 : Number(rank));
  const upText = (v) => (v === 11 ? 'A' : String(v));

  function handInfo(ranks) {
    let total = 0;
    let aces = 0;
    for (const r of ranks) {
      const v = pointOf(r);
      total += v;
      if (v === 11) aces++;
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return { total, soft: aces > 0 };
  }

  const ACTION_TEXT = { hit: '要牌', stand: '停牌', double: '加倍', split: '分牌', noinsure: '不保险' };

  /** ranks: 玩家手牌点名数组；up: 庄家明牌点名；can: {hit,stand,double,split} */
  function decide(ranks, up, can) {
    const u = pointOf(up);
    const col = UP.indexOf(u);
    const info = handInfo(ranks);
    const vs = ` 对 ${upText(u)}`;

    const pick = (action, why) => {
      // 站点此刻不允许的动作退化为最接近的合法动作。
      if (!can[action]) action = action === 'stand' || !can.hit ? 'stand' : 'hit';
      return { action, reason: `${why} → ${ACTION_TEXT[action]}` };
    };

    if (ranks.length === 2 && can.split && pointOf(ranks[0]) === pointOf(ranks[1])) {
      if (PAIRS[pointOf(ranks[0])][col] === 'P') return pick('split', `${ranks[0]}${ranks[1]}${vs}`);
    }

    let code;
    let label;
    if (info.soft && info.total >= 13) {
      code = SOFT[Math.min(info.total, 19)][col];
      label = `软 ${info.total}`;
    } else if (info.soft) {
      code = 'H';
      label = `软 ${info.total}`;
    } else {
      code = HARD[Math.max(8, Math.min(info.total, 17))][col];
      label = `硬 ${info.total}`;
    }

    if (code === 'D') return pick(can.double ? 'double' : 'hit', label + vs);
    if (code === 'Ds') return pick(can.double ? 'double' : 'stand', label + vs);
    return pick(code === 'S' ? 'stand' : 'hit', label + vs);
  }

  function decideFromState(s) {
    const hand = s?.hands?.[s.active];
    const upId = s?.dealer?.[0];
    if (!hand || !hand.cards?.length || upId == null) return null;
    const can = {
      hit: !!s.can?.Hit,
      stand: !!s.can?.Stand,
      double: !!s.can?.Double,
      split: !!s.can?.Split,
    };
    if (!can.hit && !can.stand) return null;
    return decide(hand.cards.map(rankOf), rankOf(upId), can);
  }

  /* ------------------------------------------------------------------ *
   * 设置 / 历史
   * ------------------------------------------------------------------ */
  const SETTINGS_KEY = 'sb-bj-auto-pro-settings-v3';
  const HISTORY_KEY = 'sb-bj-auto-pro-history-v3';
  const LEGACY_HISTORY_KEY = 'sb-bj-auto-pro-history-v2';
  const MAX_HISTORY = 300;

  function loadJSON(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      return v ?? fallback;
    } catch {
      return fallback;
    }
  }

  const legacy = loadJSON('sb-bj-auto-pro-settings-v2', {});
  const settings = Object.assign({
    mode: legacy.runMode === 'background' ? 'background' : 'visible', // visible | background | hint
    bet: Number(legacy.bet) || CHIPS[0],
    targetGames: Number.isFinite(Number(legacy.targetGames)) ? Number(legacy.targetGames) : 20,
    takeProfit: 0,
    stopLoss: 0,
    minBalance: 0,
    actionDelay: Number(legacy.actionDelay) || 350,
    keepHistory: true,
    collapsed: false,
    tab: 'run',
    x: null,
    y: null,
  }, loadJSON(SETTINGS_KEY, null) ?? { collapsed: window.innerWidth < 520 });
  if (!CHIPS.includes(Number(settings.bet))) settings.bet = CHIPS[0];
  if (!['visible', 'background', 'hint'].includes(settings.mode)) settings.mode = 'visible';

  let history = loadJSON(HISTORY_KEY, null);
  if (!Array.isArray(history)) {
    history = loadJSON(LEGACY_HISTORY_KEY, []);
    if (!Array.isArray(history)) history = [];
  }

  const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  const saveHistory = () => {
    if (settings.keepHistory) localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
  };

  /* ------------------------------------------------------------------ *
   * 会话状态
   * ------------------------------------------------------------------ */
  const session = {
    running: false,
    stopAfterCurrent: false,
    started: 0,
    settled: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    blackjacks: 0,
    doubles: 0,
    splits: 0,
    busts: 0,
    wagered: 0,
    returned: 0,
    net: 0,
    peak: 0,
    trough: 0,
    curve: [0],
    gameIds: new Set(),
    settledIds: new Set(),
    actions: new Map(),
  };

  let lastState = null;
  let coins = null;
  let clockSkew = 0; // server_now - Date.now()
  let statusText = '准备就绪';
  let adviceText = '—';
  let errorText = '';
  let busy = false;
  let lastKey = '';
  let lastKeyAt = 0;
  let failStreak = 0;
  let awaitingStart = null;
  let nextVisibleAt = 0;
  let loopTimer = null;
  let worker = null;
  let workerUrl = null;

  const serverNow = () => Date.now() + clockSkew;
  const csrf = () => document.querySelector('input[name="_csrf"]')?.value || '';
  const requestId = () =>
    window.bbsGame?.newRequestID?.() ||
    (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  function absorb(s) {
    if (!s || typeof s !== 'object') return s;
    if (Number.isFinite(Number(s.server_now))) clockSkew = Number(s.server_now) - Date.now();
    if (s.coins != null && Number.isFinite(Number(s.coins))) coins = Number(s.coins);
    if (s.id) lastState = s;
    return s;
  }

  /* ------------------------------------------------------------------ *
   * 网络
   * ------------------------------------------------------------------ */
  async function getState() {
    const r = await fetch(ENDPOINT.state, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`state HTTP ${r.status}`);
    return absorb(await r.json());
  }

  async function post(url, data) {
    const form = new FormData();
    form.set('_csrf', csrf());
    for (const [k, v] of Object.entries(data)) form.set(k, String(v));
    const r = await fetch(url, {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    let body = null;
    try { body = await r.json(); } catch {}
    if (body) absorb(body);
    if ((!r.ok || body?.error) && !body?.id) {
      const err = new Error(body?.error || `HTTP ${r.status}`);
      err.code = body?.code;
      throw err;
    }
    return body;
  }

  /* ------------------------------------------------------------------ *
   * 结算与统计
   * ------------------------------------------------------------------ */
  function paidOf(s) {
    if (Number.isFinite(Number(s.paid))) return Number(s.paid);
    return (s.hands || []).reduce((sum, h) => sum + Number(h.paid || 0), 0);
  }

  function logAction(id, action, reason) {
    if (!id) return;
    if (!session.actions.has(id)) session.actions.set(id, []);
    session.actions.get(id).push({ at: Date.now(), action, reason });
    if (action === 'double') session.doubles++;
    if (action === 'split') session.splits++;
  }

  function registerStarted(s) {
    if (!s?.id || session.gameIds.has(s.id)) return;
    session.gameIds.add(s.id);
    session.started++;
    if (!session.actions.has(s.id)) session.actions.set(s.id, []);
    awaitingStart = null;
  }

  function recordSettlement(s) {
    if (!s?.id || s.status !== 'settled') return;
    if (session.settledIds.has(s.id) || !session.gameIds.has(s.id)) return;
    session.settledIds.add(s.id);
    session.settled++;

    const staked = Number(s.staked || 0);
    const paid = paidOf(s);
    const net = paid - staked;
    session.wagered += staked;
    session.returned += paid;
    session.net += net;
    session.peak = Math.max(session.peak, session.net);
    session.trough = Math.min(session.trough, session.net);
    session.curve.push(session.net);
    if (session.curve.length > 400) session.curve.splice(1, session.curve.length - 400);
    if (net > 0) session.wins++;
    else if (net < 0) session.losses++;
    else session.pushes++;

    const hands = s.hands || [];
    if (hands.length === 1 && hands[0].cards?.length === 2 && handInfo(hands[0].cards.map(rankOf)).total === 21) session.blackjacks++;
    session.busts += hands.filter((h) => Number(h.total) > 21).length;

    history.unshift({
      ts: Date.now(),
      id: s.id,
      base: Number(s.base || settings.bet || 0),
      staked,
      paid,
      net,
      coins: Number(s.coins || 0),
      dealer: (s.dealer || []).map(labelOf),
      dealerTotal: s.dealer_total,
      hands: hands.map((h) => ({
        cards: (h.cards || []).map(labelOf),
        total: h.total,
        bet: h.bet,
        result: h.result || '',
        paid: Number(h.paid || 0),
      })),
      actions: session.actions.get(s.id) || [],
      recordUrl: s.record_url || `/games/blackjack/records/${s.id}/`,
    });
    history = history.slice(0, MAX_HISTORY);
    saveHistory();
    checkStopRules();
  }

  function checkStopRules() {
    if (!session.running) return;
    const target = Number(settings.targetGames) || 0;
    if (session.stopAfterCurrent) return stop('已按要求在本局结束后停止');
    if (target > 0 && session.settled >= target) return stop(`已完成 ${session.settled}/${target} 局`);
    if (settings.takeProfit > 0 && session.net >= settings.takeProfit) return stop(`止盈：本轮净收益 +${session.net}`);
    if (settings.stopLoss > 0 && session.net <= -settings.stopLoss) return stop(`止损：本轮净收益 ${session.net}`);
  }

  function canStartAnother() {
    const target = Number(settings.targetGames) || 0;
    if (session.stopAfterCurrent) return false;
    if (target > 0 && session.started >= target) return false;
    const bet = Number(settings.bet);
    if (coins != null && coins < bet) {
      stop(`余额 ${coins}，不够再押 ${bet}`);
      return false;
    }
    if (settings.minBalance > 0 && coins != null && coins - bet < settings.minBalance) {
      stop(`余额保护：下注后会低于 ${settings.minBalance}`);
      return false;
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 后台稳定 / 仅提示模式：读 state，按 reveal_at 精确调度；后台模式直接调接口
   * ------------------------------------------------------------------ */
  function schedule(ms) {
    clearTimeout(loopTimer);
    if (session.running) loopTimer = setTimeout(tick, Math.max(60, ms));
  }

  async function act(s, move, reason) {
    const key = `${s.id}:${s.seq}:${s.active}:${move}`;
    if (key === lastKey && Date.now() - lastKeyAt < 1500) return null;
    lastKey = key;
    lastKeyAt = Date.now();
    adviceText = reason;
    statusText = `执行：${reason}`;
    render();
    try {
      const res = await post(ENDPOINT.move, { game: s.id, seq: s.seq, move });
      logAction(s.id, move, reason);
      failStreak = 0;
      if (res?.status === 'settled') recordSettlement(res);
      return res;
    } catch (e) {
      // 允许同一步立刻重试（stale 表示别处已推进，重新读状态即可）。
      lastKey = '';
      throw e;
    }
  }

  async function tick() {
    if (!session.running || busy) return;
    if (settings.mode === 'visible') return visibleTick();
    busy = true;
    let wait = 400;
    try {
      const s = await getState();
      errorText = '';
      failStreak = 0;

      if (s?.id && s.status !== 'settled') registerStarted(s);
      if (s?.status === 'settled') recordSettlement(s);
      if (!session.running) return;

      if (!s?.id || s.status === 'settled') {
        if (settings.mode === 'hint') { statusText = '仅提示：请手动下注开局'; adviceText = '—'; wait = 700; return; }
        if (!canStartAnother()) {
          if (session.running) { statusText = '等待最后一局结算'; wait = 500; }
          return;
        }
        statusText = `下注 ${settings.bet}，开始第 ${session.started + 1} 局`;
        render();
        const res = await post(ENDPOINT.start, { request: requestId(), bet: settings.bet });
        registerStarted(res);
        wait = res?.reveal_at ? Number(res.reveal_at) - serverNow() + 250 : 300;
        return;
      }

      if (s.pending_round || s.phase === 'wait') {
        const left = s.reveal_at ? Number(s.reveal_at) - serverNow() : 800;
        statusText = s.pending_round
          ? `等 drand 第 ${s.pending_round} 轮${left > 0 ? `（约 ${Math.ceil(left / 1000)} 秒）` : ''}`
          : '等待发牌 / 庄家补牌';
        wait = Math.min(1200, Math.max(150, left + 250));
        return;
      }

      if (s.phase === 'insurance') {
        const why = '庄家 A → 不买保险';
        if (settings.mode === 'hint') { adviceText = why; statusText = deadlineText(s) || '请手动操作'; wait = 400; return; }
        await act(s, 'noinsure', why);
        wait = 200;
        return;
      }

      if (s.phase === 'play') {
        const d = decideFromState(s);
        if (!d) { statusText = '等待牌局状态完整'; wait = 250; return; }
        if (settings.mode === 'hint') {
          adviceText = d.reason;
          statusText = deadlineText(s) || '轮到你了';
          wait = 400;
          return;
        }
        await act(s, d.action, d.reason);
        wait = 150;
        return;
      }

      statusText = `等待：${s.status || ''}/${s.phase || ''}`;
    } catch (e) {
      failStreak++;
      errorText = String(e?.message || e);
      statusText = failStreak > 1 ? `接口出错，第 ${failStreak} 次重试` : '接口出错，马上重试';
      // 出错先快速重试，避免拖过 10 秒决策时间被判停牌；连续失败再逐步退避。
      wait = failStreak <= 3 ? 250 : Math.min(4000, 500 * failStreak);
      if (failStreak >= 12) stop(`接口连续失败 ${failStreak} 次，已停止`);
    } finally {
      busy = false;
      render();
      schedule(wait);
    }
  }

  function deadlineText(s) {
    if (!s?.decide_by) return '';
    const left = Math.ceil((Number(s.decide_by) - serverNow()) / 1000);
    return left > 0 ? `还剩 ${left} 秒，超时按${s.phase === 'insurance' ? '不买' : '停牌'}处理` : '时间到';
  }

  // 后台标签页的 setTimeout 会被节流，用 Worker 心跳把循环叫醒。
  function startWorker() {
    stopWorker();
    try {
      workerUrl = URL.createObjectURL(new Blob([
        'let t=null;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(1),e.data)}',
      ], { type: 'text/javascript' }));
      worker = new Worker(workerUrl);
      worker.onmessage = () => { if (session.running && !busy && settings.mode !== 'visible') tick(); };
      worker.postMessage(500);
    } catch {
      stopWorker();
    }
  }
  function stopWorker() {
    if (worker) { try { worker.postMessage(0); } catch {} worker.terminate(); worker = null; }
    if (workerUrl) { URL.revokeObjectURL(workerUrl); workerUrl = null; }
  }

  /* ------------------------------------------------------------------ *
   * 前台可视模式：读站点 state 决策，点网页原生按钮（保留动画）
   * ------------------------------------------------------------------ */
  const isShown = (node) => !!node && !node.hidden && !node.closest('[hidden]') && getComputedStyle(node).display !== 'none';
  const btn = (name) => root.querySelector(`[data-bj-act="${name}"]`);
  const usable = (node) => isShown(node) && !node.disabled;

  function domPhase() {
    if (isShown(root.querySelector('[data-bj-wait]'))) return 'wait';
    if (isShown(root.querySelector('[data-bj-ins-row]'))) return 'insurance';
    if (isShown(root.querySelector('[data-bj-play-row]'))) return 'play';
    if (isShown(root.querySelector('[data-bj-again-row]'))) return 'settled';
    if (isShown(root.querySelector('[data-bj-bet-row]'))) return 'bet';
    return 'transition';
  }

  function press(node, why) {
    if (!usable(node)) return false;
    const now = Date.now();
    if (now < nextVisibleAt) return false;
    nextVisibleAt = now + Math.max(120, Number(settings.actionDelay) || 350);
    statusText = why;
    node.click();
    return true;
  }

  async function visibleTick() {
    if (!session.running || busy) return;
    busy = true;
    let wait = 160;
    try {
      const phase = domPhase();
      let s = lastState;
      // 决策只认站点 state，不解析牌面 DOM。
      if (phase === 'play' || phase === 'insurance' || phase === 'settled' || awaitingStart) s = await getState();
      errorText = '';
      failStreak = 0;
      if (s?.id && s.status !== 'settled') {
        if (awaitingStart ? s.id !== awaitingStart.before : session.started === 0) registerStarted(s);
      }
      if (s?.status === 'settled') recordSettlement(s);
      if (!session.running) return;

      if (phase === 'bet') {
        if (awaitingStart && Date.now() - awaitingStart.at < 8000) { statusText = '等待开局'; return; }
        awaitingStart = null;
        if (!canStartAnother()) { if (session.running) statusText = '等待最后一局结算'; return; }
        const chip = root.querySelector(`[data-bj-chip="${settings.bet}"]`);
        if (!chip) { statusText = `页面没有 ${settings.bet} 筹码`; return; }
        if (chip.getAttribute('aria-pressed') !== 'true') { press(chip, `选择筹码 ${settings.bet}`); return; }
        if (usable(btn('deal'))) {
          const before = lastState?.id ?? null;
          if (press(btn('deal'), `下注 ${settings.bet}，开始第 ${session.started + 1} 局`)) awaitingStart = { before, at: Date.now() };
        }
        return;
      }

      if (phase === 'insurance') {
        adviceText = '庄家 A → 不买保险';
        if (s?.phase === 'insurance' && press(btn('noinsure'), '不买保险')) logAction(s.id, 'noinsure', adviceText);
        return;
      }

      if (phase === 'play') {
        if (s?.phase !== 'play') { statusText = '等待牌局状态'; return; }
        // 以页面上真正能点的按钮为准：站点会按本地余额禁用加倍/分牌，和 state.can 不一定一致。
        const live = {
          ...s,
          can: {
            Hit: !!s.can?.Hit && usable(btn('hit')),
            Stand: !!s.can?.Stand && usable(btn('stand')),
            Double: !!s.can?.Double && usable(btn('double')),
            Split: !!s.can?.Split && usable(btn('split')),
          },
        };
        const d = decideFromState(live);
        if (!d) { statusText = '等待按钮可用'; return; }
        adviceText = d.reason;
        const key = `${s.id}:${s.seq}:${s.active}:${d.action}`;
        if (key === lastKey && Date.now() - lastKeyAt < 1800) return;
        if (press(btn(d.action), `执行：${d.reason}`)) {
          lastKey = key;
          lastKeyAt = Date.now();
          logAction(s.id, d.action, d.reason);
        }
        return;
      }

      if (phase === 'settled') {
        if (!canStartAnother()) { if (session.running) statusText = '目标局数已全部发起'; return; }
        press(btn('rebet'), '重新押注');
        wait = 220;
        return;
      }

      if (phase === 'wait') {
        statusText = root.querySelector('[data-bj-wait-text]')?.textContent?.trim() || '等待 drand 随机数';
        wait = 300;
        return;
      }
      statusText = '等待页面切换';
    } catch (e) {
      failStreak++;
      errorText = String(e?.message || e);
      wait = failStreak <= 3 ? 250 : Math.min(3000, 400 * failStreak);
    } finally {
      busy = false;
      render();
      clearTimeout(loopTimer);
      if (session.running) loopTimer = setTimeout(tick, wait);
    }
  }

  /* ------------------------------------------------------------------ *
   * 启停
   * ------------------------------------------------------------------ */
  function resetSession() {
    Object.assign(session, {
      stopAfterCurrent: false, started: 0, settled: 0, wins: 0, losses: 0, pushes: 0,
      blackjacks: 0, doubles: 0, splits: 0, busts: 0,
      wagered: 0, returned: 0, net: 0, peak: 0, trough: 0, curve: [0],
    });
    session.gameIds.clear();
    session.settledIds.clear();
    session.actions.clear();
  }

  async function start() {
    readForm();
    resetSession();
    session.running = true;
    awaitingStart = null;
    lastKey = '';
    failStreak = 0;
    errorText = '';
    adviceText = '—';
    statusText = '启动中…';
    render();
    try {
      const s = await getState();
      // 已有进行中的局：接管为本轮第 1 局。
      if (s?.id && s.status !== 'settled') registerStarted(s);
    } catch (e) {
      errorText = String(e?.message || e);
    }
    if (!session.running) return;
    if (settings.mode !== 'visible') startWorker();
    else {
      stopWorker();
      if (lastState?.status === 'settled' && canStartAnother()) press(btn('rebet'), '准备新一轮');
    }
    tick();
  }

  function stop(reason = '已停止') {
    session.running = false;
    session.stopAfterCurrent = false;
    awaitingStart = null;
    stopWorker();
    clearTimeout(loopTimer);
    statusText = reason;
    if (settings.mode !== 'hint') adviceText = '—';
    render();
  }

  function stopAfterCurrent() {
    if (!session.running) return;
    const s = lastState;
    if (!s?.id || s.status === 'settled' || !session.gameIds.has(s.id)) return stop('已停止');
    session.stopAfterCurrent = true;
    statusText = '本局结束后停止';
    render();
  }

  /* ------------------------------------------------------------------ *
   * UI（Shadow DOM，样式与站点完全隔离）
   * ------------------------------------------------------------------ */
  const host = document.createElement('div');
  host.id = 'bj-auto-pro-host';
  const edge = window.innerWidth < 520 ? 8 : 16;
  host.style.cssText = `position:fixed;z-index:2147483646;right:${edge}px;bottom:${edge}px;`;
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
  <style>
    :host{all:initial}
    *{box-sizing:border-box;margin:0}
    button{font:inherit}
    .panel{width:360px;max-width:calc(100vw - 24px);font:12.5px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#e8ecf2;
      background:linear-gradient(180deg,rgba(24,30,38,.96),rgba(14,18,24,.97));border:1px solid rgba(255,255,255,.09);border-radius:16px;
      box-shadow:0 24px 60px -12px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.05);backdrop-filter:blur(14px);overflow:hidden}
    .head{display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:grab;user-select:none;touch-action:none}
    .head:active{cursor:grabbing}
    .panel:not(.collapsed) .head{border-bottom:1px solid rgba(255,255,255,.06)}
    .logo{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;background:linear-gradient(135deg,#f3cd66,#c7922b);color:#1b1406;font:800 13px ui-monospace,monospace;box-shadow:0 6px 14px -6px rgba(241,199,91,.7)}
    .title{flex:1;min-width:0}
    .title b{display:block;font-size:13px;letter-spacing:.2px}
    .title small{display:flex;align-items:center;gap:6px;color:#8b96a7;font-size:11px}
    .mini{font:700 12px ui-monospace,monospace}
    .dot{width:7px;height:7px;border-radius:50%;background:#5b6472;flex:none}
    .dot.on{background:#4ade80;animation:pulse 1.6s infinite}
    @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(74,222,128,.45)}70%{box-shadow:0 0 0 6px rgba(74,222,128,0)}100%{box-shadow:0 0 0 0 rgba(74,222,128,0)}}
    .icon{width:28px;height:28px;border:0;border-radius:8px;background:rgba(255,255,255,.06);color:#c8d0dc;cursor:pointer;display:grid;place-items:center;font-size:13px}
    .icon:hover{background:rgba(255,255,255,.12)}
    .body{padding:12px 14px 14px}
    .hidden{display:none!important}
    .hero{display:grid;grid-template-columns:1fr auto;align-items:end;gap:2px 8px;padding:12px 12px 8px;border-radius:12px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.06)}
    .lbl{color:#8b96a7;font-size:11px}
    .net{font:700 26px/1.15 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.5px}
    .meta{color:#9aa5b5;font-size:11px}
    .bal{text-align:right}
    .bal b{font:600 15px ui-monospace,SFMono-Regular,Menlo,monospace}
    svg.spark{grid-column:1/-1;width:100%;height:38px;margin-top:6px;display:block}
    .pos{color:#5fe08f}.neg{color:#ff7b84}
    .now{margin-top:10px;display:grid;gap:6px}
    .line{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:10px;background:rgba(0,0,0,.22)}
    .line span{flex:none;width:30px;color:#7f8a9b;font-size:11px;padding-top:1px}
    .line b{font-weight:600;word-break:break-word;min-height:18px}
    .advice b{color:#f3cd66}
    .tabs{display:flex;gap:4px;margin:12px 0 10px;padding:3px;border-radius:10px;background:rgba(0,0,0,.25)}
    .tabs button{flex:1;height:28px;border:0;border-radius:8px;background:transparent;color:#9aa5b5;font-weight:600;cursor:pointer}
    .tabs button.on{background:rgba(255,255,255,.09);color:#fff}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .full{grid-column:1/-1}
    label{display:flex;flex-direction:column;gap:4px;color:#8b96a7;font-size:11px}
    input{height:32px;width:100%;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.3);color:#fff;padding:0 9px;font:13px ui-monospace,monospace;outline:none}
    input:focus{border-color:#f3cd66;box-shadow:0 0 0 3px rgba(241,199,91,.15)}
    input:disabled{opacity:.5}
    .sec{grid-column:1/-1;color:#6f7a8b;font-size:10.5px;letter-spacing:.5px;margin-top:2px}
    .chips{grid-column:1/-1;display:flex;gap:6px}
    .chip{flex:1;height:34px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#dfe5ee;font:600 12px ui-monospace,monospace;cursor:pointer;transition:transform .1s}
    .chip:hover:not(:disabled){transform:translateY(-1px)}
    .chip.on{background:linear-gradient(135deg,#f3cd66,#c7922b);color:#1b1406;border-color:transparent}
    .chip:disabled{opacity:.45;cursor:not-allowed}
    .modes{grid-column:1/-1;display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
    .mode{padding:8px;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);color:#cfd6e0;text-align:left;cursor:pointer}
    .mode b{display:block;font-size:12px}
    .mode small{color:#7f8a9b;font-size:10.5px}
    .mode.on{border-color:#f3cd66;background:rgba(241,199,91,.08)}
    .mode:disabled:not(.on){opacity:.45;cursor:not-allowed}
    .actions{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:12px}
    .primary{height:38px;border:0;border-radius:10px;background:linear-gradient(135deg,#f3cd66,#d49d32);color:#1b1406;font-weight:700;font-size:13px;cursor:pointer;box-shadow:0 8px 20px -10px rgba(241,199,91,.8)}
    .primary.stop{background:linear-gradient(135deg,#ff7b84,#e0525c);color:#fff;box-shadow:0 8px 20px -10px rgba(255,123,132,.8)}
    .ghost{height:38px;padding:0 12px;border:1px solid rgba(255,255,255,.12);border-radius:10px;background:transparent;color:#dfe5ee;font-weight:600;cursor:pointer}
    .ghost:disabled{opacity:.4;cursor:not-allowed}
    .progress{margin-top:10px;height:4px;border-radius:99px;background:rgba(255,255,255,.07);overflow:hidden}
    .progress i{display:block;height:100%;width:0;background:linear-gradient(90deg,#f3cd66,#5fe08f);transition:width .3s}
    .progress.inf i{width:35%!important;animation:slide 1.4s ease-in-out infinite}
    @keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(290%)}}
    .ptext{margin-top:5px;color:#7f8a9b;font-size:11px;text-align:right}
    .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
    .stat{padding:8px;border-radius:10px;background:rgba(255,255,255,.035)}
    .stat span{display:block;color:#7f8a9b;font-size:10.5px}
    .stat b{display:block;margin-top:2px;font:600 13px ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .note{margin-top:10px;padding:9px 10px;border-radius:10px;background:rgba(241,199,91,.07);color:#cdb67a;font-size:11px}
    .hist-tools{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;color:#8b96a7;font-size:11px}
    .hist-tools div{display:flex;gap:6px}
    .small{height:26px;padding:0 9px;border:1px solid rgba(255,255,255,.12);border-radius:7px;background:transparent;color:#dfe5ee;font-size:11px;cursor:pointer}
    .list{max-height:260px;overflow:auto;display:grid;gap:6px;padding-right:2px}
    .list::-webkit-scrollbar{width:6px}.list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:9px}
    .item{display:grid;grid-template-columns:1fr auto;gap:2px 8px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.035);text-decoration:none;color:inherit}
    .item:hover{background:rgba(255,255,255,.07)}
    .cards{font:12px ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cards em{font-style:normal;color:#7f8a9b}
    .red{color:#ff8f96}
    .amt{font:700 12.5px ui-monospace,monospace;text-align:right}
    .sub{grid-column:1/-1;color:#7f8a9b;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .empty{padding:18px;text-align:center;color:#6f7a8b}
    .err{margin-top:8px;color:#ff9aa1;font-size:11px;word-break:break-word}
    .err:empty{display:none}
    .foot{margin-top:10px;color:#5f6a7a;font-size:10.5px;text-align:center}
    .body{max-height:calc(100vh - 96px);overflow:auto;overscroll-behavior:contain}
    .body::-webkit-scrollbar{width:6px}.body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:9px}
    @media (max-width:520px){.panel{width:calc(100vw - 16px)}.list{max-height:200px}}
  </style>
  <div class="panel">
    <div class="head" data-drag>
      <div class="logo">21</div>
      <div class="title"><b>Blackjack Auto Pro</b><small><i class="dot" data-dot></i><span data-mode-label></span></small></div>
      <span class="mini hidden" data-mini></span>
      <button class="icon" data-collapse title="收起 / 展开">▾</button>
    </div>
    <div class="body" data-body>
      <div class="hero">
        <div>
          <div class="lbl">本轮净收益</div>
          <div class="net" data-net>0</div>
          <div class="meta" data-meta></div>
        </div>
        <div class="bal"><div class="lbl">余额</div><b data-coins>—</b></div>
        <svg class="spark" data-spark viewBox="0 0 300 38" preserveAspectRatio="none"></svg>
      </div>
      <div class="now">
        <div class="line"><span>状态</span><b data-status></b></div>
        <div class="line advice"><span>策略</span><b data-advice></b></div>
      </div>
      <div class="tabs">
        <button data-tab="run">运行</button>
        <button data-tab="stats">统计</button>
        <button data-tab="history">历史</button>
      </div>

      <section data-pane="run">
        <div class="grid">
          <div class="modes">
            <button class="mode" data-mode="visible"><b>前台可视</b><small>点网页按钮</small></button>
            <button class="mode" data-mode="background"><b>后台稳定</b><small>切走也能跑</small></button>
            <button class="mode" data-mode="hint"><b>仅提示</b><small>你点我算</small></button>
          </div>
          <div class="sec">每手下注</div>
          <div class="chips" data-chips></div>
          <div class="sec">停止条件（0 = 关闭）</div>
          <label>局数<input data-f="targetGames" type="number" min="0" step="1"></label>
          <label>余额保护<input data-f="minBalance" type="number" min="0" step="10" title="下注后余额会低于这个数就停"></label>
          <label>止盈 +<input data-f="takeProfit" type="number" min="0" step="10" title="本轮净赚到这个数就停"></label>
          <label>止损 −<input data-f="stopLoss" type="number" min="0" step="10" title="本轮净亏到这个数就停"></label>
          <label class="full" data-delay-row>前台操作间隔（毫秒）<input data-f="actionDelay" type="number" min="120" max="2000" step="10"></label>
        </div>
        <div class="actions">
          <button class="primary" data-toggle>开始</button>
          <button class="ghost" data-soft-stop title="当前这局打完再停">打完本局停</button>
        </div>
        <div class="progress" data-progress-bar><i data-bar></i></div>
        <div class="ptext" data-progress></div>
      </section>

      <section data-pane="stats" class="hidden">
        <div class="stats">
          <div class="stat"><span>胜 / 负 / 平</span><b data-s="wlp"></b></div>
          <div class="stat"><span>胜率（不含平）</span><b data-s="winrate"></b></div>
          <div class="stat"><span>RTP</span><b data-s="rtp"></b></div>
          <div class="stat"><span>总押注</span><b data-s="wagered"></b></div>
          <div class="stat"><span>最高 / 最低</span><b data-s="range"></b></div>
          <div class="stat"><span>黑杰克</span><b data-s="bj"></b></div>
          <div class="stat"><span>加倍 / 分牌</span><b data-s="ds"></b></div>
          <div class="stat"><span>爆牌手数</span><b data-s="busts"></b></div>
          <div class="stat"><span>理论期望</span><b data-s="ev"></b></div>
        </div>
        <div class="note">按最优基本策略，这张桌子长期回报率约 99.5%（平均每局亏底注的 0.5% 左右）。每局重新洗牌、牌在你决定之后才由 drand 生成，算牌和倍投都改变不了期望；止盈止损只是帮你在运气好时收手。</div>
      </section>

      <section data-pane="history" class="hidden">
        <div class="hist-tools"><span data-hist-count></span><div><button class="small" data-export>导出 CSV</button><button class="small" data-clear>清空</button></div></div>
        <div class="list" data-list></div>
      </section>

      <div class="err" data-err></div>
      <div class="foot">v${VERSION} · 6 副牌 · 软 17 停 · 分牌后可加倍 · 不买保险</div>
    </div>
  </div>`;

  const q = (sel) => shadow.querySelector(sel);
  const qa = (sel) => [...shadow.querySelectorAll(sel)];
  const ui = {
    panel: q('.panel'), body: q('[data-body]'), drag: q('[data-drag]'), collapse: q('[data-collapse]'), mini: q('[data-mini]'),
    dot: q('[data-dot]'), modeLabel: q('[data-mode-label]'), net: q('[data-net]'), meta: q('[data-meta]'),
    coins: q('[data-coins]'), spark: q('[data-spark]'), status: q('[data-status]'), advice: q('[data-advice]'),
    chips: q('[data-chips]'), toggle: q('[data-toggle]'), softStop: q('[data-soft-stop]'), bar: q('[data-bar]'),
    progressBar: q('[data-progress-bar]'), progress: q('[data-progress]'), list: q('[data-list]'),
    histCount: q('[data-hist-count]'), err: q('[data-err]'), delayRow: q('[data-delay-row]'),
  };
  const fields = Object.fromEntries(qa('[data-f]').map((i) => [i.dataset.f, i]));
  const MODE_TEXT = { visible: '前台可视', background: '后台稳定', hint: '仅提示' };

  for (const c of CHIPS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.chip = String(c);
    b.textContent = c >= 1000 && c % 1000 === 0 ? `${c / 1000}k` : String(c);
    ui.chips.appendChild(b);
  }
  for (const [k, input] of Object.entries(fields)) input.value = String(settings[k] ?? 0);

  const clampInt = (v, min, max, dflt) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  };
  function readForm() {
    settings.targetGames = clampInt(fields.targetGames.value, 0, 100000, 0);
    settings.actionDelay = clampInt(fields.actionDelay.value, 120, 2000, 350);
    settings.takeProfit = clampInt(fields.takeProfit.value, 0, 1e9, 0);
    settings.stopLoss = clampInt(fields.stopLoss.value, 0, 1e9, 0);
    settings.minBalance = clampInt(fields.minBalance.value, 0, 1e9, 0);
    for (const [k, input] of Object.entries(fields)) input.value = String(settings[k]);
    saveSettings();
  }

  for (const input of Object.values(fields)) {
    input.addEventListener('change', () => {
      readForm();
      // 运行中调高/调低局数、止盈止损立即生效。
      if (session.running) checkStopRules();
      render();
    });
  }
  ui.chips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-chip]');
    if (!b || b.disabled) return;
    settings.bet = Number(b.dataset.chip);
    saveSettings();
    render();
  });
  qa('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    if (session.running) return;
    settings.mode = b.dataset.mode;
    saveSettings();
    render();
  }));
  qa('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    settings.tab = b.dataset.tab;
    saveSettings();
    render();
  }));
  ui.toggle.addEventListener('click', () => (session.running ? stop('手动停止') : start()));
  ui.softStop.addEventListener('click', stopAfterCurrent);
  ui.collapse.addEventListener('click', () => { settings.collapsed = !settings.collapsed; saveSettings(); render(); });
  q('[data-export]').addEventListener('click', exportCSV);
  q('[data-clear]').addEventListener('click', () => {
    if (!confirm('清空脚本保存的本地历史记录？')) return;
    history = [];
    localStorage.removeItem(HISTORY_KEY);
    render();
  });

  // 拖动面板，位置会记住；窗口缩放时保持在可视范围内。
  const placePanel = () => {
    if (settings.x == null || settings.y == null) return;
    const r = host.getBoundingClientRect();
    const x = Math.min(Math.max(0, settings.x), Math.max(0, window.innerWidth - r.width));
    const y = Math.min(Math.max(0, settings.y), Math.max(0, window.innerHeight - 48));
    Object.assign(host.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
  };
  (() => {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    ui.drag.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      dragging = true;
      const r = host.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      ui.drag.setPointerCapture(e.pointerId);
    });
    ui.drag.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      settings.x = ox + e.clientX - sx;
      settings.y = oy + e.clientY - sy;
      placePanel();
    });
    const end = () => { if (dragging) { dragging = false; saveSettings(); } };
    ui.drag.addEventListener('pointerup', end);
    ui.drag.addEventListener('pointercancel', end);
    ui.drag.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      settings.x = settings.y = null;
      Object.assign(host.style, { left: 'auto', top: 'auto', right: `${edge}px`, bottom: `${edge}px` });
      saveSettings();
    });
    window.addEventListener('resize', placePanel);
  })();

  const signed = (n) => `${n > 0 ? '+' : ''}${Number(n) || 0}`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const cardHTML = (label) => esc(label).replace(/^([♥♦])/, '<span class="red">$1</span>');

  function sparkline() {
    const pts = session.curve;
    if (pts.length < 2) return '<line x1="0" y1="19" x2="300" y2="19" stroke="rgba(255,255,255,.14)" stroke-dasharray="3 4"/>';
    const min = Math.min(0, ...pts);
    const max = Math.max(0, ...pts);
    const span = max - min || 1;
    const xy = pts.map((v, i) => [(i / (pts.length - 1)) * 300, 35 - ((v - min) / span) * 32]);
    const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
    const zero = (35 - ((0 - min) / span) * 32).toFixed(1);
    const color = session.net >= 0 ? '#5fe08f' : '#ff7b84';
    return `<defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".32"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
      <line x1="0" y1="${zero}" x2="300" y2="${zero}" stroke="rgba(255,255,255,.14)" stroke-dasharray="3 4"/>
      <path d="${d}L300 ${zero}L0 ${zero}Z" fill="url(#g)"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  }

  function renderHistory() {
    ui.histCount.textContent = `共 ${history.length} 局 · 本地最多保存 ${MAX_HISTORY} 局`;
    if (!history.length) { ui.list.innerHTML = '<div class="empty">还没有记录</div>'; return; }
    ui.list.innerHTML = history.slice(0, 80).map((r) => {
      const player = (r.hands || []).map((h) => `${(h.cards || []).map(cardHTML).join(' ')} <em>${esc(h.total ?? '')}</em>`).join(' ｜ ');
      const dealer = `${(r.dealer || []).map(cardHTML).join(' ')} <em>${esc(r.dealerTotal ?? '')}</em>`;
      const acts = (r.actions || []).map((a) => ACTION_TEXT[a.action] || a.action).join(' → ') || '无操作';
      const t = new Date(r.ts);
      const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      return `<a class="item" href="${esc(r.recordUrl)}" target="_blank" rel="noopener" title="${esc((r.actions || []).map((a) => a.reason).join('；'))}">
        <div class="cards">${player}</div><div class="amt ${r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}">${signed(r.net)}</div>
        <div class="sub">庄 ${dealer} · ${esc(acts)} · 押 ${esc(r.staked)} · ${time} · #${esc(r.id)}</div></a>`;
    }).join('');
  }

  let lastHistoryLen = -1;
  function render() {
    const running = session.running;
    ui.panel.classList.toggle('collapsed', !!settings.collapsed);
    ui.dot.classList.toggle('on', running);
    ui.modeLabel.textContent = `${MODE_TEXT[settings.mode]}${running ? ' · 运行中' : ''}`;
    ui.body.classList.toggle('hidden', !!settings.collapsed);
    ui.collapse.textContent = settings.collapsed ? '▴' : '▾';
    ui.mini.classList.toggle('hidden', !settings.collapsed);
    ui.mini.textContent = signed(session.net);
    ui.mini.className = `mini ${settings.collapsed ? '' : 'hidden'} ${session.net > 0 ? 'pos' : session.net < 0 ? 'neg' : ''}`;

    ui.net.textContent = signed(session.net);
    ui.net.className = `net ${session.net > 0 ? 'pos' : session.net < 0 ? 'neg' : ''}`;
    const rtp = session.wagered > 0 ? `${((session.returned / session.wagered) * 100).toFixed(1)}%` : '—';
    ui.meta.textContent = `${session.settled} 局 · RTP ${rtp}`;
    ui.coins.textContent = coins == null ? '—' : String(coins);
    ui.spark.innerHTML = sparkline();
    ui.status.textContent = statusText;
    ui.advice.textContent = adviceText;
    ui.err.textContent = errorText ? `接口：${errorText}` : '';

    qa('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === settings.tab));
    qa('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== settings.tab));
    qa('[data-mode]').forEach((b) => { b.classList.toggle('on', b.dataset.mode === settings.mode); b.disabled = running; });
    qa('[data-chip]').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.chip) === Number(settings.bet));
      b.disabled = running || settings.mode === 'hint';
    });
    fields.actionDelay.disabled = running;
    ui.delayRow.classList.toggle('hidden', settings.mode !== 'visible');

    ui.toggle.textContent = running ? '停止' : settings.mode === 'hint' ? '开始提示' : '开始自动';
    ui.toggle.classList.toggle('stop', running);
    ui.softStop.disabled = !running || settings.mode === 'hint' || session.stopAfterCurrent;

    const target = Number(settings.targetGames) || 0;
    ui.progressBar.classList.toggle('inf', running && target === 0);
    ui.bar.style.width = target > 0 ? `${Math.min(100, (session.settled / target) * 100)}%` : '0%';
    ui.progress.textContent = target > 0
      ? `已结算 ${session.settled}/${target} · 已发起 ${session.started}`
      : `已结算 ${session.settled} · 不限局数`;

    const decided = session.wins + session.losses;
    const set = (k, v) => { q(`[data-s="${k}"]`).textContent = v; };
    set('wlp', `${session.wins} / ${session.losses} / ${session.pushes}`);
    set('winrate', decided ? `${((session.wins / decided) * 100).toFixed(1)}%` : '—');
    set('rtp', rtp);
    set('wagered', String(session.wagered));
    set('range', `${signed(session.peak)} / ${signed(session.trough)}`);
    set('bj', String(session.blackjacks));
    set('ds', `${session.doubles} / ${session.splits}`);
    set('busts', String(session.busts));
    // 期望亏损约为总押注的 0.46%（加倍/分牌会抬高总押注，按押注额计）。
    set('ev', session.wagered ? signed(Math.round(-session.wagered * 0.0046)) : '—');

    if (settings.tab === 'history' && history.length !== lastHistoryLen) {
      lastHistoryLen = history.length;
      renderHistory();
    } else if (settings.tab !== 'history') {
      lastHistoryLen = -1;
    }
  }

  function exportCSV() {
    const rows = [['time', 'game', 'base', 'staked', 'paid', 'net', 'player', 'dealer', 'actions', 'record']];
    for (const r of history) {
      rows.push([
        new Date(r.ts).toISOString(), r.id, r.base, r.staked, r.paid, r.net,
        (r.hands || []).map((h) => `${(h.cards || []).join(' ')}=${h.total}:${h.result}`).join(' / '),
        `${(r.dealer || []).join(' ')}=${r.dealerTotal ?? ''}`,
        (r.actions || []).map((a) => a.reason).join(' | '),
        location.origin + r.recordUrl,
      ]);
    }
    const csv = '﻿' + rows.map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `sb-blackjack-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // 空闲时轻量同步余额；运行时由主循环负责。
  setInterval(() => {
    if (session.running || document.hidden) return;
    getState().then(render).catch(() => {});
  }, 4000);
  getState().then(render).catch(() => render());
  render();
  requestAnimationFrame(placePanel);

  // 控制台自测：__bjAuto.decide(['A','7'], '9', {hit:true,stand:true,double:true,split:false})
  window.__bjAuto = { version: VERSION, decide, decideFromState };
  console.log(`[BJ AUTO] v${VERSION} 已加载`);
})();
