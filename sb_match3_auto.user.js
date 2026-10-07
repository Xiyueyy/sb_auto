// ==UserScript==
// @name         sb.sb 消消乐 Auto
// @namespace    https://sb.sb/
// @version      2.1.0
// @description  练习/正式计奖双模式；支持前台可视原生操作与后台稳定 API 模式，自动选步并记录成绩与收益。
// @match        https://sb.sb/games/match-3/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const GRID = 8;
  const CONFIG_EL = document.getElementById('match3-config');
  const BOARD_EL = document.querySelector('[data-m3-board]');
  const PRACTICE_BTN = document.querySelector('[data-m3-practice]');
  const FORMAL_BTN = document.querySelector('[data-m3-start]');
  const CSRF_EL = document.querySelector('input[name="_csrf"]');

  if (!CONFIG_EL || !BOARD_EL) {
    console.warn('[M3 AUTO] 找不到消消乐配置或棋盘。');
    return;
  }

  const CFG = JSON.parse(CONFIG_EL.textContent || '{}');
  const SETTINGS_KEY = 'sb-m3-auto-settings-v1';
  const HISTORY_KEY = 'sb-m3-auto-history-v1';
  const MAX_HISTORY = 100;

  const $ = (sel, base = document) => base.querySelector(sel);

  function loadJSON(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch {
      return fallback;
    }
  }

  const settings = Object.assign({
    mode: 'practice',
    runMode: 'visible',
    targetGames: 1,
    targetScore: 0,
    moveDelay: 480,
    autoRestart: true,
    collapsed: false,
  }, loadJSON(SETTINGS_KEY, {}));

  let history = loadJSON(HISTORY_KEY, []);
  if (!Array.isArray(history)) history = [];

  const session = {
    running: false,
    started: 0,
    settled: 0,
    best: 0,
    totalScore: 0,
    totalMoves: 0,
    validMoves: 0,
    invalidMoves: 0,
    totalEntry: 0,
    totalReward: 0,
    totalNet: 0,
    gameIds: new Set(),
    settledIds: new Set(),
    movesByGame: new Map(),
  };

  let state = null;
  let stateError = '';
  let statusText = '准备就绪';
  let suggestionText = '—';
  let pendingMove = null;
  let targetHoldGameId = null;
  let nextMoveAt = 0;
  let startClickAt = 0;
  let pollTimer = null;
  let tickTimer = null;
  let patchedCapture = false;
  let apiBusy = false;
  let lastApiRefreshAt = 0;
  let heartbeatWorker = null;
  let heartbeatUrl = null;

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function saveHistory() {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function newRequestID() {
    return window.bbsGame?.newRequestID?.() ||
      (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  }

  function csrfToken() {
    return document.querySelector('input[name="_csrf"]')?.value || CSRF_EL?.value || '';
  }

  async function postAPI(url, data) {
    const form = new FormData();
    form.set('_csrf', csrfToken());
    for (const [key, value] of Object.entries(data)) form.set(key, String(value));

    const r = await fetch(url, {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });

    const body = await r.json();
    if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
    return body;
  }

  function startBackgroundHeartbeat() {
    stopBackgroundHeartbeat();

    const code = `
      let timer = null;
      onmessage = (event) => {
        const data = event.data || {};
        if (data.cmd === 'start') {
          clearInterval(timer);
          timer = setInterval(() => postMessage('tick'), Math.max(70, Number(data.ms) || 100));
        } else if (data.cmd === 'stop') {
          clearInterval(timer);
          timer = null;
        }
      };
    `;

    try {
      heartbeatUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      heartbeatWorker = new Worker(heartbeatUrl);
    } catch (e) {
      if (heartbeatUrl) URL.revokeObjectURL(heartbeatUrl);
      heartbeatUrl = null;
      heartbeatWorker = null;
      console.warn('[M3 AUTO] Worker 心跳不可用，回退到页面定时器。', e);
      return;
    }
    heartbeatWorker.onmessage = () => {
      if (session.running && settings.runMode === 'background') tick();
    };
    heartbeatWorker.postMessage({ cmd: 'start', ms: 100 });
  }

  function stopBackgroundHeartbeat() {
    if (heartbeatWorker) {
      try { heartbeatWorker.postMessage({ cmd: 'stop' }); } catch {}
      heartbeatWorker.terminate();
      heartbeatWorker = null;
    }
    if (heartbeatUrl) {
      URL.revokeObjectURL(heartbeatUrl);
      heartbeatUrl = null;
    }
  }

  function nowServer(s = state) {
    if (!s || typeof s.server_now !== 'number') return Date.now();
    return Date.now() + (s.server_now - Date.now());
  }

  function boardFromString(value) {
    const s = String(value || '');
    if (s.length !== GRID * GRID || !/^[0-6]+$/.test(s)) return null;
    const out = [];
    for (let r = 0; r < GRID; r++) {
      out.push(
        s.slice(r * GRID, (r + 1) * GRID)
          .split('')
          .map(Number)
      );
    }
    return out;
  }

  function cloneBoard(board) {
    return board.map(row => row.slice());
  }

  function cellKey(r, c) {
    return r * GRID + c;
  }

  function findMatches(board) {
    const cells = new Set();
    const horizontal = new Set();
    const vertical = new Set();
    const runs = [];

    for (let r = 0; r < GRID; r++) {
      let c = 0;
      while (c < GRID) {
        let end = c + 1;
        while (end < GRID && board[r][end] === board[r][c]) end++;
        const len = end - c;
        if (len >= 3) {
          runs.push({ dir: 'h', len, r, c });
          for (let x = c; x < end; x++) {
            const k = cellKey(r, x);
            cells.add(k);
            horizontal.add(k);
          }
        }
        c = end;
      }
    }

    for (let c = 0; c < GRID; c++) {
      let r = 0;
      while (r < GRID) {
        let end = r + 1;
        while (end < GRID && board[end][c] === board[r][c]) end++;
        const len = end - r;
        if (len >= 3) {
          runs.push({ dir: 'v', len, r, c });
          for (let y = r; y < end; y++) {
            const k = cellKey(y, c);
            cells.add(k);
            vertical.add(k);
          }
        }
        r = end;
      }
    }

    let intersections = 0;
    for (const k of horizontal) {
      if (vertical.has(k)) intersections++;
    }

    let maxRun = 0;
    for (const run of runs) maxRun = Math.max(maxRun, run.len);

    return {
      cells,
      count: cells.size,
      runs,
      intersections,
      maxRun,
    };
  }

  function evaluateSwap(board, a, b) {
    if (board[a.r][a.c] === board[b.r][b.c]) return null;

    const copy = cloneBoard(board);
    [copy[a.r][a.c], copy[b.r][b.c]] = [copy[b.r][b.c], copy[a.r][a.c]];

    const match = findMatches(copy);
    if (!match.count) return null;

    const ak = cellKey(a.r, a.c);
    const bk = cellKey(b.r, b.c);
    if (!match.cells.has(ak) && !match.cells.has(bk)) return null;

    let rowSum = 0;
    for (const k of match.cells) rowSum += Math.floor(k / GRID);
    const averageRow = rowSum / Math.max(1, match.count);

    // 主要追求一次清得多；交叉消除、4/5 连和偏下方的消除作为次级偏好。
    const heuristic =
      match.count * 1000 +
      match.intersections * 180 +
      Math.max(0, match.maxRun - 3) * 90 +
      match.runs.length * 35 +
      averageRow * 5;

    return {
      from: a,
      to: b,
      clear: match.count,
      intersections: match.intersections,
      maxRun: match.maxRun,
      heuristic,
    };
  }

  function findAllMoves(board) {
    const moves = [];

    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        if (c + 1 < GRID) {
          const m = evaluateSwap(board, { r, c }, { r, c: c + 1 });
          if (m) moves.push(m);
        }
        if (r + 1 < GRID) {
          const m = evaluateSwap(board, { r, c }, { r: r + 1, c });
          if (m) moves.push(m);
        }
      }
    }

    moves.sort((a, b) => b.heuristic - a.heuristic);
    return moves;
  }

  function pickMove(board) {
    const moves = findAllMoves(board);
    if (!moves.length) return { moves, best: null };

    // 完全同分时随机一个，避免每局在同类局面总走固定方向。
    const top = moves[0].heuristic;
    const tied = moves.filter(m => Math.abs(m.heuristic - top) < 0.001);
    const best = tied[Math.floor(Math.random() * tied.length)];

    return { moves, best };
  }

  function patchPointerCapture() {
    if (patchedCapture) return;
    patchedCapture = true;

    try {
      const native = BOARD_EL.setPointerCapture?.bind(BOARD_EL);
      BOARD_EL.setPointerCapture = pointerId => {
        try {
          return native?.(pointerId);
        } catch {
          return undefined;
        }
      };
    } catch {
      // 某些浏览器不允许覆盖；后续仍会尝试原生事件。
    }
  }

  function cellCenter(r, c) {
    const rect = BOARD_EL.getBoundingClientRect();
    return {
      x: rect.left + ((c + 0.5) / GRID) * rect.width,
      y: rect.top + ((r + 0.5) / GRID) * rect.height,
    };
  }

  function fireTap(r, c, pointerId) {
    const p = cellCenter(r, c);
    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: p.x,
      clientY: p.y,
    };

    const down = new PointerEvent('pointerdown', {
      ...common,
      buttons: 1,
      pressure: 0.5,
    });
    const up = new PointerEvent('pointerup', {
      ...common,
      buttons: 0,
      pressure: 0,
    });

    BOARD_EL.dispatchEvent(down);
    BOARD_EL.dispatchEvent(up);
  }

  async function nativeSwap(move) {
    patchPointerCapture();

    const pointerId = 7000 + Math.floor(Math.random() * 1000);
    fireTap(move.from.r, move.from.c, pointerId);
    await sleep(45);
    fireTap(move.to.r, move.to.c, pointerId + 1);
  }

  async function getState() {
    const r = await fetch(CFG.state, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });

    if (!r.ok) throw new Error(`state HTTP ${r.status}`);
    return r.json();
  }

  function currentResultPracticeButton() {
    return document.querySelector('[data-m3-again-practice]');
  }

  function canClick(el) {
    if (!el || el.disabled || el.hidden || el.closest('[hidden]')) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  const FORMAL_ENTRY =
    Number((FORMAL_BTN?.textContent?.match(/\d+/) || ['100'])[0]) || 100;

  function stateMode(s) {
    if (!s) return null;
    if (s.practice === true) return 'practice';
    if (s.practice === false) return 'formal';
    if (Number(s.entry || 0) > 0) return 'formal';
    return null;
  }

  function modeLabel(mode) {
    return mode === 'formal' ? '正式计奖' : '练习';
  }

  function modeMatchesState(s) {
    const m = stateMode(s);
    return !m || m === settings.mode;
  }

  function formalPrecheck(s = state) {
    const entry = Number(s?.entry || FORMAL_ENTRY || 100);
    if (Number.isFinite(Number(s?.coins)) && Number(s.coins) < entry) {
      return { ok: false, reason: `游戏币不足：余额 ${s.coins}，正式局需要 ${entry}` };
    }
    if (
      Number.isFinite(Number(s?.daily_max)) &&
      Number.isFinite(Number(s?.played_today)) &&
      Number(s.played_today) >= Number(s.daily_max)
    ) {
      return { ok: false, reason: `今天正式计奖局已达到上限 ${s.daily_max} 局` };
    }
    return { ok: true, entry };
  }

  function targetReached() {
    const target = Math.max(0, Number(settings.targetGames) || 0);
    return target > 0 && session.settled >= target;
  }

  function registerActiveGame(s) {
    if (!s?.id || session.gameIds.has(s.id)) return;

    // 新一局开始后解除上一局因达到目标分数而进入的停手状态。
    if (targetHoldGameId !== s.id) targetHoldGameId = null;

    session.gameIds.add(s.id);
    session.movesByGame.set(s.id, []);
    session.started++;
    statusText = `${modeLabel(stateMode(s) || settings.mode)}局 #${s.id} 已开始（第 ${session.started} 局）`;
    render();
  }

  function recordMoveResult(s) {
    if (!pendingMove) return;
    if (!s || s.id !== pendingMove.gameId) return;
    if (Number(s.version) <= pendingMove.version) return;

    const scoreDelta = Number(s.score || 0) - pendingMove.scoreBefore;
    const boardChanged = String(s.board || '') !== pendingMove.boardBefore;
    const valid = scoreDelta > 0 || boardChanged;

    session.totalMoves++;

    if (valid) {
      session.validMoves++;
      statusText =
        `成功：+${Math.max(0, scoreDelta)} 分，` +
        `交换 (${pendingMove.move.from.r + 1},${pendingMove.move.from.c + 1}) ↔ ` +
        `(${pendingMove.move.to.r + 1},${pendingMove.move.to.c + 1})`;
    } else {
      session.invalidMoves++;
      statusText = '这一步未形成消除，重新计算。';
    }

    const list = session.movesByGame.get(s.id) || [];
    list.push({
      at: Date.now(),
      from: pendingMove.move.from,
      to: pendingMove.move.to,
      predictedClear: pendingMove.move.clear,
      scoreBefore: pendingMove.scoreBefore,
      scoreAfter: Number(s.score || 0),
      scoreDelta,
      valid,
    });
    session.movesByGame.set(s.id, list);

    pendingMove = null;
    nextMoveAt = Date.now() + Math.max(100, Number(settings.moveDelay) || 480);
  }

  function recordSettlement(s) {
    if (!s?.id) return;
    if (!session.gameIds.has(s.id) || session.settledIds.has(s.id)) return;

    const gameMode = stateMode(s) || settings.mode;
    session.settledIds.add(s.id);
    session.settled++;

    const score = Number(s.score || 0);
    const moves = session.movesByGame.get(s.id) || [];
    const entry = gameMode === 'formal' ? Number(s.entry || FORMAL_ENTRY || 100) : 0;
    const reward = gameMode === 'formal' ? Number(s.reward || 0) : 0;
    const net = reward - entry;

    session.best = Math.max(session.best, score);
    session.totalScore += score;
    session.totalEntry += entry;
    session.totalReward += reward;
    session.totalNet += net;

    history.unshift({
      ts: Date.now(),
      id: s.id,
      mode: gameMode,
      score,
      entry,
      reward,
      net,
      moves: moves.length,
      validMoves: moves.filter(m => m.valid).length,
      invalidMoves: moves.filter(m => !m.valid).length,
    });
    history = history.slice(0, MAX_HISTORY);
    saveHistory();

    statusText =
      gameMode === 'formal'
        ? `正式局 #${s.id} 结束：${score} 分，净收益 ${net >= 0 ? '+' : ''}${net}`
        : `练习局 #${s.id} 结束：${score} 分`;

    suggestionText = '—';

    if (targetReached()) {
      stopAuto(`已完成 ${session.settled} 局${modeLabel(settings.mode)}`);
    }

    render();
  }

  async function syncState(force = false) {
    if (!force && session.running && settings.runMode === 'background') return;

    try {
      const s = await getState();
      stateError = '';

      // 先用新状态确认上一手结果，再替换全局状态。
      recordMoveResult(s);
      state = s;

      // 已经由本次自动流程开始过的牌局，即使因为“目标分数”暂停了自动，
      // 最终结算后仍记入历史和正式局收益。
      if (s.status === 'settled') {
        recordSettlement(s);
      }

      if (session.running && s.status === 'active') {
        if (!modeMatchesState(s)) {
          stopAuto(`当前是${modeLabel(stateMode(s))}局，但脚本选择的是${modeLabel(settings.mode)}模式`);
          return;
        }
        registerActiveGame(s);
      }

      render();
    } catch (e) {
      stateError = String(e?.message || e);
      render();
    }
  }

  function currentResultFormalButton() {
    return document.querySelector('[data-m3-again]');
  }

  function startButtonForCurrentScreen() {
    if (settings.mode === 'formal') {
      const again = currentResultFormalButton();
      if (canClick(again)) return again;
      if (canClick(FORMAL_BTN)) return FORMAL_BTN;
      return null;
    }

    const again = currentResultPracticeButton();
    if (canClick(again)) return again;
    if (canClick(PRACTICE_BTN)) return PRACTICE_BTN;
    return null;
  }

  function startGameIfNeeded() {
    if (!session.running || targetReached()) return false;
    if (state?.status === 'active') return false;

    if (settings.mode === 'formal') {
      const check = formalPrecheck(state);
      if (!check.ok) {
        stopAuto(check.reason);
        return false;
      }
    }

    const btn = startButtonForCurrentScreen();
    if (!btn) return false;

    const now = Date.now();
    if (now - startClickAt < 1200) return false;

    startClickAt = now;
    statusText = `启动第 ${session.started + 1} 局${modeLabel(settings.mode)}…`;
    btn.click();
    render();
    return true;
  }

  async function apiStartGame() {
    if (!session.running || targetReached()) return false;
    if (state?.status === 'active') return false;

    if (settings.mode === 'formal') {
      const check = formalPrecheck(state);
      if (!check.ok) {
        stopAuto(check.reason);
        return false;
      }
    }

    statusText = `后台接口启动第 ${session.started + 1} 局${modeLabel(settings.mode)}…`;
    const res = await postAPI(CFG.start, {
      request: newRequestID(),
      practice: settings.mode === 'practice' ? 1 : 0,
    });

    if (res?.error) throw new Error(res.error);

    state = res;
    lastApiRefreshAt = Date.now();
    if (res?.status === 'active') registerActiveGame(res);
    if (res?.status === 'settled') recordSettlement(res);
    render();
    return true;
  }

  async function apiPlayMove() {
    if (!session.running || !state || state.status !== 'active') return;

    if (!modeMatchesState(state)) {
      stopAuto(`牌局模式与脚本选择不一致：当前${modeLabel(stateMode(state))}，脚本${modeLabel(settings.mode)}`);
      return;
    }

    if (targetHoldGameId === state.id) {
      statusText =
        `本局已达到目标分数 ${settings.targetScore}，已停止继续消除，等待本局结算后自动进入下一局`;
      return;
    }

    if (
      settings.mode === 'formal' &&
      Number(settings.targetScore) > 0 &&
      Number(state.score || 0) >= Number(settings.targetScore)
    ) {
      targetHoldGameId = state.id;
      pendingMove = null;
      statusText =
        `本局已达到目标分数 ${settings.targetScore}（当前 ${state.score}），停止继续消除；等待结算后继续下一局`;
      suggestionText = '本局达标，等待结算';
      render();
      return;
    }

    const nowS = Number(state.server_now || Date.now()) + Math.max(0, Date.now() - lastApiRefreshAt);

    if (Number.isFinite(Number(state.start_at)) && nowS < Number(state.start_at)) {
      statusText = `后台准备中：${Math.max(0, Math.ceil((Number(state.start_at) - nowS) / 1000))}s`;
      return;
    }

    if (Number.isFinite(Number(state.deadline_at)) && nowS >= Number(state.deadline_at)) {
      statusText = '后台等待本局结算…';
      return;
    }

    if (Number.isFinite(Number(state.busy_until)) && nowS < Number(state.busy_until) + 25) {
      statusText = '后台等待服务器消除结算…';
      return;
    }

    if (Date.now() < nextMoveAt) return;

    const board = boardFromString(state.board);
    if (!board) {
      statusText = '后台棋盘数据格式不正确，等待刷新…';
      return;
    }

    const pick = pickMove(board);
    if (!pick.best) {
      suggestionText = '当前没有可消除交换，等待服务器重排';
      statusText = '后台没有可用步，等待棋盘变化…';
      return;
    }

    const m = pick.best;
    suggestionText =
      `共 ${pick.moves.length} 个可用步；选 (${m.from.r + 1},${m.from.c + 1}) ↔ ` +
      `(${m.to.r + 1},${m.to.c + 1})，预计先消 ${m.clear} 个`;

    pendingMove = {
      gameId: state.id,
      version: Number(state.version || 0),
      boardBefore: String(state.board || ''),
      scoreBefore: Number(state.score || 0),
      move: m,
      sentAt: Date.now(),
      retries: 0,
    };

    const res = await postAPI(CFG.move, {
      game: state.id,
      move: newRequestID(),
      expected: state.version,
      fr: m.from.r,
      fc: m.from.c,
      tr: m.to.r,
      tc: m.to.c,
    });

    if (res?.code === 'fast') {
      state = res;
      lastApiRefreshAt = Date.now();
      pendingMove = null;
      nextMoveAt = Date.now() + Math.max(80, Number(settings.moveDelay) || 250);
      statusText = '后台发送过快，等待服务器允许下一步…';
      return;
    }

    if (res?.error) {
      if (res.board) state = res;
      pendingMove = null;
      if (res.code === 'over') {
        statusText = '本局已结束，等待结算…';
        return;
      }
      throw new Error(res.error);
    }

    recordMoveResult(res);
    state = res;
    lastApiRefreshAt = Date.now();

    if (res?.status === 'settled') recordSettlement(res);
    else registerActiveGame(res);
  }

  async function backgroundTick() {
    if (!session.running || settings.runMode !== 'background' || apiBusy) return;

    apiBusy = true;
    try {
      const now = Date.now();

      // 后台定期同步一次服务器状态；每次 move/start 的响应也会直接更新 state。
      if (!state || now - lastApiRefreshAt >= 450) {
        const fresh = await getState();
        recordMoveResult(fresh);
        state = fresh;
        lastApiRefreshAt = Date.now();

        if (fresh?.status === 'settled') recordSettlement(fresh);
        if (session.running && fresh?.status === 'active') {
          if (!modeMatchesState(fresh)) {
            stopAuto(`当前是${modeLabel(stateMode(fresh))}局，但脚本选择的是${modeLabel(settings.mode)}模式`);
            return;
          }
          registerActiveGame(fresh);
        }
      }

      if (!session.running) return;

      if (state?.status === 'active') {
        await apiPlayMove();
        return;
      }

      if (state?.status === 'settled') {
        if (targetReached()) return;
        if (settings.autoRestart) await apiStartGame();
        else statusText = '本局结束；自动续局已关闭';
        return;
      }

      await apiStartGame();
    } catch (e) {
      stateError = String(e?.message || e);
      statusText = `后台接口错误：${stateError}`;
    } finally {
      apiBusy = false;
      render();
    }
  }

  async function maybePlayMove() {
    if (!session.running || !state) return;
    if (state.status !== 'active') return;

    if (!modeMatchesState(state)) {
      stopAuto(`牌局模式与脚本选择不一致：当前${modeLabel(stateMode(state))}，脚本${modeLabel(settings.mode)}`);
      return;
    }

    if (targetHoldGameId === state.id) {
      statusText =
        `本局已达到目标分数 ${settings.targetScore}，已停止继续消除，等待本局结算后自动进入下一局`;
      return;
    }

    if (
      settings.mode === 'formal' &&
      Number(settings.targetScore) > 0 &&
      Number(state.score || 0) >= Number(settings.targetScore)
    ) {
      targetHoldGameId = state.id;
      pendingMove = null;
      statusText =
        `本局已达到目标分数 ${settings.targetScore}（当前 ${state.score}），停止继续消除；等待结算后继续下一局`;
      suggestionText = '本局达标，等待结算';
      render();
      return;
    }

    const nowS = Number(state.server_now || Date.now());

    if (Number.isFinite(Number(state.start_at)) && nowS < Number(state.start_at)) {
      const left = Math.max(0, Math.ceil((Number(state.start_at) - nowS) / 1000));
      statusText = `准备中：${left}s`;
      return;
    }

    if (Number.isFinite(Number(state.deadline_at)) && nowS >= Number(state.deadline_at)) {
      statusText = '时间到，等待结算…';
      return;
    }

    if (
      Number.isFinite(Number(state.busy_until)) &&
      nowS < Number(state.busy_until) + 40
    ) {
      statusText = '等待上一手动画 / 服务器结算…';
      return;
    }

    if (pendingMove) {
      if (Date.now() - pendingMove.sentAt > 1700) {
        pendingMove.retries = (pendingMove.retries || 0) + 1;

        if (pendingMove.retries >= 3) {
          stopAuto('原生棋盘事件连续 3 次未触发，请刷新页面后重试');
          return;
        }

        pendingMove.sentAt = Date.now();
        statusText = `第 ${pendingMove.retries + 1} 次重试当前交换…`;
        await nativeSwap(pendingMove.move);
      }
      return;
    }

    if (Date.now() < nextMoveAt) return;

    const board = boardFromString(state.board);
    if (!board) {
      statusText = '棋盘数据格式不正确，等待刷新…';
      return;
    }

    const pick = pickMove(board);
    if (!pick.best) {
      suggestionText = '当前没有可消除交换，等待服务器重排';
      statusText = '没有可用步，等待棋盘变化…';
      return;
    }

    const m = pick.best;

    suggestionText =
      `共 ${pick.moves.length} 个可用步；` +
      `选 (${m.from.r + 1},${m.from.c + 1}) ↔ (${m.to.r + 1},${m.to.c + 1})，` +
      `预计先消 ${m.clear} 个`;

    pendingMove = {
      gameId: state.id,
      version: Number(state.version || 0),
      boardBefore: String(state.board || ''),
      scoreBefore: Number(state.score || 0),
      move: m,
      sentAt: Date.now(),
      retries: 0,
    };

    statusText = '正在通过网页原生棋盘执行交换…';
    render();

    await nativeSwap(m);
  }

  function avgScore() {
    return session.settled ? session.totalScore / session.settled : 0;
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return '';
    }
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[ch]);
  }

  function renderHistory() {
    if (!ui?.history) return;

    const rows = history.slice(0, 20).map(item => `
      <tr>
        <td><a href="/games/match-3/records/${esc(item.id)}/" target="_blank" rel="noopener">#${esc(item.id)}</a></td>
        <td>${esc(modeLabel(item.mode))}</td>
        <td>${esc(item.score)}</td>
        <td>${item.mode === 'formal' ? esc((item.net >= 0 ? '+' : '') + item.net) : '—'}</td>
        <td>${esc(item.validMoves)}</td>
        <td>${esc(formatTime(item.ts))}</td>
      </tr>
    `).join('');

    ui.history.innerHTML =
      rows ||
      '<tr><td colspan="6" class="empty">暂无自动记录</td></tr>';
  }

  function render() {
    if (!ui?.panel) return;

    ui.dot.classList.toggle('on', session.running);
    ui.mode.disabled = session.running;
    ui.runMode.disabled = session.running;
    ui.toggle.textContent = session.running
      ? `停止${modeLabel(settings.mode)}自动`
      : `开始${modeLabel(settings.mode)}自动`;
    ui.status.textContent = statusText;
    ui.suggestion.textContent = suggestionText;

    const target = Math.max(0, Number(settings.targetGames) || 0);
    ui.progress.textContent =
      `${session.settled}/${target || '∞'} 已完成 · ${session.started}/${target || '∞'} 已开始`;

    ui.modeNote.className = 'm3a-lock ' + (settings.mode === 'formal' ? 'formal' : 'practice');
    ui.modeTitle.textContent = settings.mode === 'formal' ? '正式计奖模式' : '练习模式';
    ui.targetScore.disabled = settings.mode !== 'formal' || session.running;
    ui.targetScore.title =
      settings.mode === 'formal'
        ? '达到该分数后暂停自动操作；0 = 不按分数暂停'
        : '目标分数仅用于正式计奖模式';
    ui.modeDesc.textContent =
      settings.mode === 'formal'
        ? `每局扣 ${FORMAL_ENTRY} 游戏币，按分数返币；目标分数：${settings.targetScore > 0 ? settings.targetScore : '关闭'}。`
        : '不扣游戏币，也不返币。';

    ui.score.textContent =
      state?.status === 'active' && modeMatchesState(state)
        ? String(state.score ?? 0)
        : '—';
    ui.best.textContent = String(session.best || 0);
    ui.avg.textContent = session.settled ? avgScore().toFixed(0) : '—';
    ui.moves.textContent = String(session.validMoves);
    ui.invalid.textContent = String(session.invalidMoves);
    ui.coins.textContent = state?.coins != null ? String(state.coins) : '—';
    ui.net.textContent = settings.mode === 'formal' ? `${session.totalNet >= 0 ? '+' : ''}${session.totalNet}` : '—';
    ui.net.className = session.totalNet > 0 ? 'pos' : session.totalNet < 0 ? 'neg' : '';

    if (state?.status === 'active' && modeMatchesState(state) && state.deadline_at && state.server_now) {
      const left = Math.max(0, Math.ceil((Number(state.deadline_at) - Number(state.server_now)) / 1000));
      ui.time.textContent = `${left}s`;
    } else {
      ui.time.textContent = '—';
    }

    ui.error.textContent = stateError ? `状态接口：${stateError}` : '';
    ui.foot.textContent =
      settings.runMode === 'background'
        ? '后台稳定：直接使用站点正常 start/move/state API；棋盘动画可能不实时刷新'
        : '前台可视：使用网页原生 Pointer 事件，保留交换/消除动画';
    ui.body.hidden = !!settings.collapsed;
    ui.collapse.textContent = settings.collapsed ? '展开' : '收起';

    renderHistory();
  }

  function resetSessionStats() {
    session.started = 0;
    session.settled = 0;
    session.best = 0;
    session.totalScore = 0;
    session.totalMoves = 0;
    session.validMoves = 0;
    session.invalidMoves = 0;
    session.totalEntry = 0;
    session.totalReward = 0;
    session.totalNet = 0;
    session.gameIds.clear();
    session.settledIds.clear();
    session.movesByGame.clear();

    pendingMove = null;
    targetHoldGameId = null;
    nextMoveAt = 0;
    startClickAt = 0;
    suggestionText = '—';
  }

  async function startAuto() {
    settings.mode = ui.mode.value === 'formal' ? 'formal' : 'practice';
    settings.runMode = ui.runMode.value === 'background' ? 'background' : 'visible';
    settings.targetGames = Math.max(0, parseInt(ui.target.value || '0', 10) || 0);
    settings.targetScore = Math.max(0, parseInt(ui.targetScore.value || '0', 10) || 0);
    settings.moveDelay = Math.max(120, Math.min(1200, parseInt(ui.delay.value || '480', 10) || 480));
    settings.autoRestart = ui.restart.checked;
    saveSettings();

    await syncState(true);

    if (settings.mode === 'formal') {
      const check = formalPrecheck(state);
      if (!check.ok) {
        statusText = check.reason;
        render();
        return;
      }

      const target = settings.targetGames || '无限';
      const scoreTarget = settings.targetScore > 0 ? settings.targetScore : '不限制';
      const ok = confirm(
        `将启动正式计奖自动模式。

` +
        `每局扣 ${check.entry} 游戏币，目标局数：${target}。
` +
        `目标分数：${scoreTarget}（每局达到后停止继续消除，结算后自动进入下一局）。
` +
        `当前余额：${state?.coins ?? '未知'} 游戏币。

` +
        '确定继续吗？'
      );
      if (!ok) {
        statusText = '已取消正式计奖模式';
        render();
        return;
      }
    }

    resetSessionStats();
    session.running = true;
    apiBusy = false;
    statusText = '正在检查当前牌局…';
    render();

    await syncState(true);

    if (settings.runMode === 'background') {
      lastApiRefreshAt = Date.now();
      startBackgroundHeartbeat();
    } else {
      stopBackgroundHeartbeat();
    }

    if (state?.status === 'active') {
      if (!modeMatchesState(state)) {
        stopAuto(`当前是${modeLabel(stateMode(state))}局；请先打完或切换到对应模式`);
        return;
      }

      registerActiveGame(state);
      statusText = `接管当前${modeLabel(settings.mode)}局`;
    } else {
      if (settings.runMode === 'background') await apiStartGame();
      else startGameIfNeeded();
    }

    render();
  }

  function stopAuto(reason = '手动停止') {
    session.running = false;
    pendingMove = null;
    targetHoldGameId = null;
    apiBusy = false;
    stopBackgroundHeartbeat();
    statusText = reason;
    suggestionText = '—';
    render();
  }

  async function tick() {
    try {
      if (!session.running) return;

      if (settings.runMode === 'background') {
        await backgroundTick();
        return;
      }

      if (!state) {
        statusText = '等待状态数据…';
        return;
      }

      if (state.status === 'active') {
        await maybePlayMove();
        return;
      }

      if (state.status === 'settled') {
        if (targetReached()) return;

        if (settings.autoRestart) {
          startGameIfNeeded();
        } else {
          statusText = '本局结束；自动续局已关闭';
        }
        return;
      }

      startGameIfNeeded();
    } catch (e) {
      stateError = String(e?.message || e);
    } finally {
      render();
    }
  }

  const panel = document.createElement('section');
  panel.id = 'm3-auto-panel';
  panel.innerHTML = `
    <div class="m3a-head">
      <div class="m3a-title">
        <span id="m3a-dot"></span>
        <b>消消乐 Auto</b>
        <small>v2.1</small>
      </div>
      <button id="m3a-collapse" type="button">收起</button>
    </div>

    <div id="m3a-body">
      <div class="m3a-lock practice" id="m3a-mode-note">
        <b id="m3a-mode-title">练习模式</b>
        <span id="m3a-mode-desc">不扣游戏币，也不返币。</span>
      </div>

      <div class="m3a-controls">
        <label>
          游戏模式
          <select id="m3a-mode">
            <option value="practice">练习</option>
            <option value="formal">正式计奖</option>
          </select>
        </label>

        <label>
          运行方式
          <select id="m3a-run-mode">
            <option value="visible">前台可视</option>
            <option value="background">后台稳定</option>
          </select>
        </label>

        <label>
          局数
          <input id="m3a-target" type="number" min="0" step="1" title="0 = 无限">
        </label>

        <label>
          正式目标分数
          <input id="m3a-target-score" type="number" min="0" step="100" title="0 = 不按分数暂停">
        </label>

        <label>
          每步缓冲
          <div class="m3a-input-unit">
            <input id="m3a-delay" type="number" min="120" max="1200" step="20">
            <span>ms</span>
          </div>
        </label>

        <label class="m3a-check">
          <input id="m3a-restart" type="checkbox">
          <span>自动续下一局</span>
        </label>
      </div>

      <div class="m3a-buttons">
        <button id="m3a-toggle" class="primary" type="button">开始练习自动</button>
        <button id="m3a-sync" type="button">刷新状态</button>
      </div>

      <div id="m3a-progress" class="m3a-progress">0/1 已完成 · 0/1 已开始</div>

      <div class="m3a-now">
        <div><span>当前状态</span><b id="m3a-status">准备就绪</b></div>
        <div><span>选步判断</span><b id="m3a-suggestion">—</b></div>
      </div>

      <div class="m3a-stats">
        <div><span>当前分</span><b id="m3a-score">—</b></div>
        <div><span>剩余</span><b id="m3a-time">—</b></div>
        <div><span>游戏币</span><b id="m3a-coins">—</b></div>
        <div><span>本轮净收益</span><b id="m3a-net">—</b></div>
        <div><span>本轮最高</span><b id="m3a-best">0</b></div>
        <div><span>平均分</span><b id="m3a-avg">—</b></div>
        <div><span>有效步</span><b id="m3a-moves">0</b></div>
        <div><span>无效步</span><b id="m3a-invalid">0</b></div>
      </div>

      <div class="m3a-history-head">
        <b>历史记录</b>
        <button id="m3a-clear" type="button">清空</button>
      </div>

      <div class="m3a-history-wrap">
        <table>
          <thead>
            <tr><th>局</th><th>模式</th><th>分数</th><th>净</th><th>有效</th><th>时间</th></tr>
          </thead>
          <tbody id="m3a-history"></tbody>
        </table>
      </div>

      <div id="m3a-error" class="m3a-error"></div>
      <div class="m3a-foot" id="m3a-foot">8×8 · 练习/正式计奖双模式</div>
    </div>
  `;

  document.body.appendChild(panel);

  const style = document.createElement('style');
  style.textContent = `
    #m3-auto-panel{
      position:fixed;right:16px;bottom:16px;z-index:2147483646;
      width:min(440px,calc(100vw - 24px));
      color:#f4f6f8;background:rgba(18,21,27,.97);
      border:1px solid rgba(255,255,255,.14);border-radius:14px;
      box-shadow:0 16px 48px rgba(0,0,0,.38);overflow:hidden;
      backdrop-filter:blur(10px);
      font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif
    }
    #m3-auto-panel *{box-sizing:border-box}
    #m3-auto-panel button,#m3-auto-panel input,#m3-auto-panel select{font:inherit}
    #m3-auto-panel .m3a-head{
      display:flex;align-items:center;justify-content:space-between;
      padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.1)
    }
    #m3-auto-panel .m3a-title{display:flex;align-items:center;gap:7px}
    #m3-auto-panel .m3a-title small{color:#8d98a8}
    #m3-auto-panel #m3a-dot{width:9px;height:9px;border-radius:50%;background:#6d7480}
    #m3-auto-panel #m3a-dot.on{background:#4ade80;box-shadow:0 0 0 3px rgba(74,222,128,.12)}
    #m3-auto-panel .m3a-head button,
    #m3-auto-panel .m3a-history-head button{
      border:1px solid rgba(255,255,255,.15);background:#2a303b;color:#e8edf3;
      border-radius:7px;padding:4px 8px;cursor:pointer
    }
    #m3-auto-panel #m3a-body{padding:11px}
    #m3-auto-panel .m3a-lock{
      display:grid;gap:2px;padding:9px 10px;border-radius:9px;
      background:#12251a;border:1px solid rgba(74,222,128,.22);margin-bottom:9px
    }
    #m3-auto-panel .m3a-lock b{color:#7ee7a0}
    #m3-auto-panel .m3a-lock span{color:#a9b8ae;font-size:11px}
    #m3-auto-panel .m3a-lock.formal{background:#2a2111;border-color:rgba(231,189,71,.32)}
    #m3-auto-panel .m3a-lock.formal b{color:#f0c85b}
    #m3-auto-panel .m3a-controls{
      display:grid;grid-template-columns:1fr 1fr;gap:8px
    }
    #m3-auto-panel label{display:flex;flex-direction:column;gap:5px;color:#aeb7c4;font-size:12px}
    #m3-auto-panel input[type="number"],#m3-auto-panel select{
      width:100%;height:32px;border-radius:8px;border:1px solid #404957;
      background:#11151b;color:#fff;padding:0 8px;outline:none
    }
    #m3-auto-panel .m3a-input-unit{position:relative}
    #m3-auto-panel .m3a-input-unit span{
      position:absolute;right:8px;top:8px;color:#758092;font-size:10px
    }
    #m3-auto-panel .m3a-check{
      grid-column:1/-1;display:flex;flex-direction:row;align-items:center;gap:7px;
      min-height:28px
    }
    #m3-auto-panel .m3a-check input{width:16px;height:16px;margin:0}
    #m3-auto-panel .m3a-buttons{
      display:grid;grid-template-columns:2fr 1fr;gap:8px;margin-top:8px
    }
    #m3-auto-panel .m3a-buttons button{
      height:35px;border:0;border-radius:8px;background:#333a46;color:#fff;
      font-weight:700;cursor:pointer
    }
    #m3-auto-panel .m3a-buttons .primary{background:#e7bd47;color:#171717}
    #m3-auto-panel .m3a-progress{
      margin:8px 0 7px;color:#9da8b6;font-size:12px;text-align:right
    }
    #m3-auto-panel .m3a-now{
      display:grid;gap:6px;padding:9px;border-radius:9px;background:#10141a;
      border:1px solid rgba(255,255,255,.07)
    }
    #m3-auto-panel .m3a-now>div{
      display:grid;grid-template-columns:72px 1fr;gap:8px;align-items:start
    }
    #m3-auto-panel .m3a-now span{color:#8994a4}
    #m3-auto-panel .m3a-now b{font-weight:600;word-break:break-word}
    #m3-auto-panel .m3a-stats{
      display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px
    }
    #m3-auto-panel .m3a-stats>div{
      min-width:0;background:#252b35;border-radius:8px;padding:7px
    }
    #m3-auto-panel .m3a-stats span{
      display:block;color:#8f9aaa;font-size:10px;white-space:nowrap
    }
    #m3-auto-panel .m3a-stats b{
      display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap
    }
    #m3-auto-panel .m3a-history-head{
      display:flex;align-items:center;justify-content:space-between;margin:11px 0 6px
    }
    #m3-auto-panel .m3a-history-wrap{
      max-height:210px;overflow:auto;border:1px solid rgba(255,255,255,.08);
      border-radius:9px;background:#11151a
    }
    #m3-auto-panel table{width:100%;border-collapse:collapse;font-size:11px}
    #m3-auto-panel th{
      position:sticky;top:0;z-index:1;background:#202630;color:#aeb7c4;
      text-align:left;padding:6px
    }
    #m3-auto-panel td{
      padding:6px;border-top:1px solid rgba(255,255,255,.06);
      max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap
    }
    #m3-auto-panel td a{color:#8ecbff;text-decoration:none}
    #m3-auto-panel .pos{color:#63dc8a!important} #m3-auto-panel .neg{color:#ff7b82!important}
    #m3-auto-panel .empty{text-align:center;color:#798494;padding:15px}
    #m3-auto-panel .m3a-error{color:#ff9499;margin-top:6px;font-size:11px}
    #m3-auto-panel .m3a-foot{margin-top:7px;color:#727d8d;font-size:10px;text-align:center}
    @media(max-width:560px){
      #m3-auto-panel{right:8px;bottom:8px;width:calc(100vw - 16px)}
      #m3-auto-panel .m3a-stats{grid-template-columns:repeat(3,1fr)}
    }
  `;
  document.head.appendChild(style);

  const ui = {
    panel,
    body: $('#m3a-body', panel),
    dot: $('#m3a-dot', panel),
    collapse: $('#m3a-collapse', panel),
    mode: $('#m3a-mode', panel),
    runMode: $('#m3a-run-mode', panel),
    modeNote: $('#m3a-mode-note', panel),
    modeTitle: $('#m3a-mode-title', panel),
    modeDesc: $('#m3a-mode-desc', panel),
    target: $('#m3a-target', panel),
    targetScore: $('#m3a-target-score', panel),
    delay: $('#m3a-delay', panel),
    restart: $('#m3a-restart', panel),
    toggle: $('#m3a-toggle', panel),
    sync: $('#m3a-sync', panel),
    progress: $('#m3a-progress', panel),
    status: $('#m3a-status', panel),
    suggestion: $('#m3a-suggestion', panel),
    score: $('#m3a-score', panel),
    time: $('#m3a-time', panel),
    coins: $('#m3a-coins', panel),
    net: $('#m3a-net', panel),
    best: $('#m3a-best', panel),
    avg: $('#m3a-avg', panel),
    moves: $('#m3a-moves', panel),
    invalid: $('#m3a-invalid', panel),
    history: $('#m3a-history', panel),
    clear: $('#m3a-clear', panel),
    error: $('#m3a-error', panel),
    foot: $('#m3a-foot', panel),
  };

  ui.mode.value = settings.mode === 'formal' ? 'formal' : 'practice';
  ui.runMode.value = settings.runMode === 'background' ? 'background' : 'visible';
  ui.target.value = String(settings.targetGames);
  ui.targetScore.value = String(settings.targetScore || 0);
  ui.delay.value = String(settings.moveDelay);
  ui.restart.checked = !!settings.autoRestart;

  ui.mode.addEventListener('change', () => {
    if (session.running) {
      ui.mode.value = settings.mode;
      return;
    }
    settings.mode = ui.mode.value === 'formal' ? 'formal' : 'practice';
    saveSettings();
    statusText = `已切换到${modeLabel(settings.mode)}模式`;
    render();
  });

  ui.runMode.addEventListener('change', () => {
    if (session.running) {
      ui.runMode.value = settings.runMode;
      return;
    }
    settings.runMode = ui.runMode.value === 'background' ? 'background' : 'visible';
    saveSettings();
    statusText = settings.runMode === 'background' ? '已切换到后台稳定模式' : '已切换到前台可视模式';
    render();
  });

  ui.target.addEventListener('change', () => {
    settings.targetGames = Math.max(0, parseInt(ui.target.value || '0', 10) || 0);
    ui.target.value = String(settings.targetGames);
    saveSettings();
    render();
  });

  ui.targetScore.addEventListener('change', () => {
    settings.targetScore = Math.max(0, parseInt(ui.targetScore.value || '0', 10) || 0);
    ui.targetScore.value = String(settings.targetScore);
    saveSettings();
    render();
  });

  ui.delay.addEventListener('change', () => {
    settings.moveDelay = Math.max(120, Math.min(1200, parseInt(ui.delay.value || '480', 10) || 480));
    ui.delay.value = String(settings.moveDelay);
    saveSettings();
  });

  ui.restart.addEventListener('change', () => {
    settings.autoRestart = ui.restart.checked;
    saveSettings();
  });

  ui.toggle.addEventListener('click', () => {
    if (session.running) stopAuto('手动停止');
    else startAuto();
  });

  ui.sync.addEventListener('click', () => syncState(true));

  ui.collapse.addEventListener('click', () => {
    settings.collapsed = !settings.collapsed;
    saveSettings();
    render();
  });

  ui.clear.addEventListener('click', () => {
    if (!confirm('确定清空脚本保存的消消乐历史记录？')) return;
    history = [];
    localStorage.removeItem(HISTORY_KEY);
    render();
  });

  // 便于在控制台验证选步，不参与正式运行逻辑。
  window.__SB_M3_AUTO_TEST = {
    boardFromString,
    findMatches,
    findAllMoves,
    pickMove,
  };

  syncState();
  pollTimer = setInterval(syncState, 220);
  tickTimer = setInterval(tick, 90);
  render();

  console.log('[M3 AUTO] v2.1 已加载：练习/正式计奖 + 前台可视/后台稳定双运行方式。');
})();
