// ==UserScript==
// @name         sb.sb 雷霆战机 Auto
// @namespace    https://sb.sb/
// @version      1.0.0
// @description  雷霆战机自动驾驶：练习/正式计奖、前台可视/后台稳定、局数控制、智能躲弹与历史统计。
// @match        https://sb.sb/games/thunder-fighter/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const CFG_EL = document.getElementById('thunder-config');
  const CANVAS = document.querySelector('[data-tf-canvas]');
  const START_BTN = document.querySelector('[data-tf-start]');
  const PRACTICE_BTN = document.querySelector('[data-tf-practice]');
  const CSRF_EL = document.querySelector('input[name="_csrf"]');

  if (!CFG_EL || !CANVAS) {
    console.warn('[TF AUTO] 找不到雷霆战机配置或画布。');
    return;
  }

  const CFG = JSON.parse(CFG_EL.textContent || '{}');
  const SETTINGS_KEY = 'sb-tf-auto-settings-v1';
  const HISTORY_KEY = 'sb-tf-auto-history-v1';
  const MAX_HISTORY = 100;

  const WIDTH = 480;
  const HEIGHT = 800;
  const FPS = 60;
  const MAX_FRAMES = 7200;
  const FIX = 16;
  const ENTRY = Number(START_BTN?.dataset?.entry || 100) || 100;

  const $ = (sel, base = document) => base.querySelector(sel);

  function loadJSON(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      return v ?? fallback;
    } catch {
      return fallback;
    }
  }

  const settings = Object.assign({
    mode: 'practice',
    runMode: 'visible',
    strategy: 'balanced',
    targetGames: 1,
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
    totalEntry: 0,
    totalReward: 0,
    totalNet: 0,
    gameIds: new Set(),
    settledIds: new Set(),
  };

  let state = null;
  let stateError = '';
  let statusText = '准备就绪';
  let aiText = '—';

  let engineBuffer = new Uint8Array(4 * (24 + 5 * 2048));
  let engineInts = new Int32Array(engineBuffer.buffer);

  let heldKeys = new Set();
  let lastStartClick = 0;
  let syncTimer = null;
  let controlTimer = null;

  let heartbeatWorker = null;
  let heartbeatUrl = null;
  let apiBusy = false;

  let bgGame = null;
  let bgFrame = 0;
  let bgSeq = 0;
  let bgServerOffset = 0;
  let bgEnding = false;
  let bgPending = null;
  let bgNextStartAt = 0;

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function saveHistory() {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
  }

  function csrfToken() {
    return document.querySelector('input[name="_csrf"]')?.value || CSRF_EL?.value || '';
  }

  function newRequestID() {
    return window.bbsGame?.newRequestID?.() ||
      (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  }

  async function postAPI(url, data) {
    const fd = new FormData();
    fd.set('_csrf', csrfToken());
    for (const [k, v] of Object.entries(data)) fd.set(k, String(v));

    const r = await fetch(url, {
      method: 'POST',
      body: fd,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });

    const body = await r.json();
    if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
    return body;
  }

  async function getState() {
    const r = await fetch(CFG.State, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });

    if (!r.ok) throw new Error(`state HTTP ${r.status}`);
    return r.json();
  }

  async function waitForEngine(timeoutMs = 15000) {
    const start = Date.now();
    while (!window.bbsThunder) {
      if (Date.now() - start > timeoutMs) throw new Error('WASM 引擎加载超时');
      await new Promise(r => setTimeout(r, 100));
    }
    return window.bbsThunder;
  }

  function modeLabel(mode = settings.mode) {
    return mode === 'formal' ? '正式计奖' : '练习';
  }

  function runModeLabel(mode = settings.runMode) {
    return mode === 'background' ? '后台稳定' : '前台可视';
  }

  function stateMode(s) {
    if (!s) return null;
    if (s.practice === true) return 'practice';
    if (s.practice === false) return 'formal';
    if (Number(s.entry || 0) > 0) return 'formal';
    return null;
  }

  function targetReached() {
    const target = Math.max(0, Number(settings.targetGames) || 0);
    return target > 0 && session.settled >= target;
  }

  function canStartMore() {
    const target = Math.max(0, Number(settings.targetGames) || 0);
    return target === 0 || session.started < target;
  }

  function formalPrecheck(s = state) {
    const coins = Number(s?.coins);
    const played = Number(s?.played_today);
    const max = Number(s?.daily_max);

    if (Number.isFinite(coins) && coins < ENTRY) {
      return { ok: false, reason: `游戏币不足：余额 ${coins}，正式局需要 ${ENTRY}` };
    }

    if (Number.isFinite(played) && Number.isFinite(max) && max > 0 && played >= max) {
      return { ok: false, reason: `今天正式计奖局已达到上限 ${max} 局` };
    }

    return { ok: true };
  }

  function registerStarted(s) {
    if (!s?.id || session.gameIds.has(s.id)) return;

    session.gameIds.add(s.id);
    session.started++;
    statusText = `${modeLabel(stateMode(s) || settings.mode)}局 #${s.id} 已开始（第 ${session.started} 局）`;
  }

  function recordSettlement(s) {
    if (!s?.id || !session.gameIds.has(s.id) || session.settledIds.has(s.id)) return;

    session.settledIds.add(s.id);
    session.settled++;

    const gameMode = stateMode(s) || settings.mode;
    const score = Number(s.score || 0);
    const entry = gameMode === 'formal' ? Number(s.entry || ENTRY) : 0;
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
      kills: Number(s.kills || 0),
      maxStreak: Number(s.max_streak || 0),
      endReason: Number(s.end_reason || 0),
      entry,
      reward,
      net,
    });
    history = history.slice(0, MAX_HISTORY);
    saveHistory();

    statusText =
      gameMode === 'formal'
        ? `#${s.id} 结束：${score} 分，净收益 ${net >= 0 ? '+' : ''}${net}`
        : `#${s.id} 练习结束：${score} 分`;

    if (targetReached()) stopAuto(`已完成 ${session.settled} 局`);
  }

  function resetSession() {
    session.started = 0;
    session.settled = 0;
    session.best = 0;
    session.totalScore = 0;
    session.totalEntry = 0;
    session.totalReward = 0;
    session.totalNet = 0;
    session.gameIds.clear();
    session.settledIds.clear();

    bgGame = null;
    bgFrame = 0;
    bgSeq = 0;
    bgEnding = false;
    bgPending = null;
    bgNextStartAt = 0;
    releaseKeys();
  }
  function readEngineSnapshot() {
    const engine = window.bbsThunder;
    if (!engine) return null;

    let count = 0;
    try {
      count = engine.fill(engineBuffer) || 0;
    } catch {
      return null;
    }

    if (!count || count < 24) return null;

    const n = engineInts;
    const entities = [];

    for (let i = 24; i + 4 < count; i += 5) {
      entities.push({
        type: n[i],
        x: n[i + 1] / FIX,
        y: n[i + 2] / FIX,
        a: n[i + 3],
        b: n[i + 4],
      });
    }

    return {
      frame: n[0],
      score: n[1],
      lives: n[2],
      power: n[3],
      shield: n[4],
      invuln: n[5],
      combo: n[6],
      endReason: n[8],
      bossHp: n[9],
      bossMax: n[10],
      laserX: n[11] / FIX,
      laserPhase: n[12],
      x: n[16] / FIX,
      y: n[17] / FIX,
      bossX: n[18] / FIX,
      bossY: n[19] / FIX,
      entities,
    };
  }

  function encodeInput(direction, speed = 8, fire = true) {
    const d = ((direction % 32) + 32) % 32;
    return (speed & 15) | ((d & 31) << 4) | (fire ? 512 : 0);
  }

  function inputVector(value) {
    const speed = value & 15;
    if (!speed) return { dx: 0, dy: 0 };

    const d = (value >> 4) & 31;
    const angle = d / 32 * Math.PI * 2;

    return {
      dx: Math.sin(angle),
      dy: -Math.cos(angle),
    };
  }

  function chooseAutoInput(snap) {
    if (!snap) return 512;

    const strategy = settings.strategy;
    const bullets = snap.entities.filter(e => e.type === 6);
    const enemies = snap.entities.filter(e => [2, 3, 4].includes(e.type));
    const items = snap.entities.filter(e => [7, 8, 9].includes(e.type));

    const candidateDirs = [-1];
    for (let d = 0; d < 32; d += 2) candidateDirs.push(d);

    let bestValue = 512;
    let bestCost = Infinity;
    let bestMeta = null;

    const look = strategy === 'survival' ? 16 : strategy === 'aggressive' ? 11 : 14;
    const bulletWeight = strategy === 'survival' ? 1450 : strategy === 'aggressive' ? 850 : 1150;
    const enemyWeight = strategy === 'survival' ? 520 : 390;
    const preferredY = strategy === 'aggressive' ? 590 : strategy === 'survival' ? 690 : 650;

    for (const dir of candidateDirs) {
      let dx = 0;
      let dy = 0;
      let input = 512;

      if (dir >= 0) {
        const angle = dir / 32 * Math.PI * 2;
        dx = Math.sin(angle);
        dy = -Math.cos(angle);
        input = encodeInput(dir, 8, true);
      }

      const px = snap.x + dx * look;
      const py = snap.y + dy * look;

      let cost = 0;

      if (px < 26) cost += (26 - px) * 150;
      if (px > WIDTH - 26) cost += (px - (WIDTH - 26)) * 150;
      if (py < 70) cost += (70 - py) * 120;
      if (py > HEIGHT - 28) cost += (py - (HEIGHT - 28)) * 160;

      cost += Math.abs(py - preferredY) * 0.42;
      cost += Math.abs(px - WIDTH / 2) * 0.025;

      let nearestBullet = 999;

      for (const b of bullets) {
        const ddx = px - b.x;
        const ddy = py - b.y;
        const dist2 = ddx * ddx + ddy * ddy;
        const dist = Math.sqrt(dist2);
        nearestBullet = Math.min(nearestBullet, dist);

        const ahead = b.y < py ? 1.25 : 0.8;
        cost += bulletWeight * ahead * Math.exp(-dist2 / (2 * 58 * 58));
        if (dist < 24) cost += 25000;
        else if (dist < 38) cost += 6000;
      }

      for (const en of enemies) {
        const radius = en.type === 3 ? 70 : 44;
        const ddx = px - en.x;
        const ddy = py - en.y;
        const dist2 = ddx * ddx + ddy * ddy;
        const dist = Math.sqrt(dist2);
        cost += enemyWeight * Math.exp(-dist2 / (2 * (radius + 28) * (radius + 28)));
        if (dist < radius * 0.7) cost += 12000;
      }

      if (snap.bossMax > 0 && snap.laserPhase > 0) {
        const lane = Math.abs(px - snap.laserX);
        if (snap.laserPhase === 2 && py > snap.bossY + 40) {
          if (lane < 42) cost += 30000;
          else cost += 1100 * Math.exp(-(lane * lane) / (2 * 68 * 68));
        } else if (snap.laserPhase === 1) {
          cost += 700 * Math.exp(-(lane * lane) / (2 * 55 * 55));
        }
      }

      if (nearestBullet > 72) {
        let bestItem = null;

        for (const item of items) {
          const iy = item.y - py;
          const ix = item.x - px;
          const d2 = ix * ix + iy * iy;

          let importance = 0;
          if (item.type === 8 && !snap.shield) importance = 1.35;
          else if (item.type === 9 && snap.lives < 3) importance = 1.5;
          else if (item.type === 7) importance = strategy === 'survival' ? 0.35 : 0.8;

          if (importance > 0 && d2 < 210 * 210) {
            const value = importance * (1 - Math.sqrt(d2) / 210);
            if (!bestItem || value > bestItem.value) bestItem = { value, d2 };
          }
        }

        if (bestItem) cost -= bestItem.value * 420;

        if (strategy !== 'survival' && enemies.length) {
          let target = null;

          for (const en of enemies) {
            if (en.y >= py - 40) continue;
            const vertical = py - en.y;
            if (!target || vertical < target.vertical) target = { x: en.x, vertical };
          }

          if (target) cost += Math.abs(px - target.x) * (strategy === 'aggressive' ? 0.20 : 0.08);
        }
      }

      cost += Math.sin(snap.frame / 90 + dir * 0.11) * 1.5;

      if (cost < bestCost) {
        bestCost = cost;
        bestValue = input;
        bestMeta = { nearestBullet, hazards: bullets.length, dir };
      }
    }

    const vec = inputVector(bestValue);
    const arrows =
      (vec.dx < -0.3 ? '←' : vec.dx > 0.3 ? '→' : '') +
      (vec.dy < -0.3 ? '↑' : vec.dy > 0.3 ? '↓' : '');

    aiText =
      (strategy === 'survival' ? '保命' : strategy === 'aggressive' ? '激进' : '均衡') +
      ' · 弹幕 ' + (bestMeta?.hazards || 0) +
      ' · 最近 ' + Math.round(bestMeta?.nearestBullet || 0) + 'px · ' +
      (arrows || '停');

    return bestValue;
  }

  function keyEvent(type, code) {
    window.dispatchEvent(new KeyboardEvent(type, {
      code,
      key: code,
      bubbles: true,
      cancelable: true,
    }));
  }

  function setHeldKeys(next) {
    const wanted = new Set(next);

    for (const code of heldKeys) {
      if (!wanted.has(code)) keyEvent('keyup', code);
    }

    for (const code of wanted) {
      if (!heldKeys.has(code)) keyEvent('keydown', code);
    }

    heldKeys = wanted;
  }

  function releaseKeys() {
    for (const code of heldKeys) keyEvent('keyup', code);
    heldKeys.clear();
  }

  function applyVisibleInput(input) {
    const { dx, dy } = inputVector(input);
    const keys = [];

    if (dx < -0.28) keys.push('ArrowLeft');
    if (dx > 0.28) keys.push('ArrowRight');
    if (dy < -0.28) keys.push('ArrowUp');
    if (dy > 0.28) keys.push('ArrowDown');

    setHeldKeys(keys);
  }

  function encodeChunk(inputs) {
    const bytes = [];

    for (let i = 0; i < inputs.length;) {
      let j = i + 1;
      while (j < inputs.length && inputs[j] === inputs[i]) j++;

      let run = j - i;
      while (run >= 128) {
        bytes.push((run & 127) | 128);
        run = Math.floor(run / 128);
      }

      bytes.push(run, inputs[i] & 255, (inputs[i] >> 8) & 255);
      i = j;
    }

    let raw = '';
    for (const b of bytes) raw += String.fromCharCode(b);
    return btoa(raw);
  }

  function decodeInputs(data) {
    const raw = atob(data || '');
    const out = [];

    for (let i = 0; i < raw.length;) {
      let count = 0;
      let shift = 0;
      let byte;

      do {
        byte = raw.charCodeAt(i++);
        count += (byte & 127) * 2 ** shift;
        shift += 7;
      } while (byte >= 128 && i < raw.length);

      if (i + 1 >= raw.length) break;

      const value = raw.charCodeAt(i) | (raw.charCodeAt(i + 1) << 8);
      i += 2;

      for (let j = 0; j < count; j++) out.push(value);
    }

    return out;
  }
  function startBackgroundHeartbeat() {
    stopBackgroundHeartbeat();

    const code =
      "let timer=null;" +
      "onmessage=(e)=>{" +
      "const d=e.data||{};" +
      "if(d.cmd==='start'){clearInterval(timer);timer=setInterval(()=>postMessage('tick'),Math.max(80,Number(d.ms)||1000));}" +
      "else if(d.cmd==='stop'){clearInterval(timer);timer=null;}" +
      "};";

    try {
      heartbeatUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      heartbeatWorker = new Worker(heartbeatUrl);
      heartbeatWorker.onmessage = () => {
        if (session.running && settings.runMode === 'background') backgroundTick();
      };
      heartbeatWorker.postMessage({ cmd: 'start', ms: 120 });
    } catch (e) {
      if (heartbeatUrl) URL.revokeObjectURL(heartbeatUrl);
      heartbeatUrl = null;
      heartbeatWorker = null;
      console.warn('[TF AUTO] Worker 不可用，回退到普通定时器。', e);
    }
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

  function currentNativeStartButton() {
    const againFormal = document.querySelector('[data-tf-again]');
    const againPractice = document.querySelector('[data-tf-again-practice]');

    if (settings.mode === 'formal') {
      if (againFormal && !againFormal.disabled) return againFormal;
      if (START_BTN && !START_BTN.disabled && !START_BTN.hidden) return START_BTN;
    } else {
      if (againPractice && !againPractice.disabled) return againPractice;
      if (PRACTICE_BTN && !PRACTICE_BTN.disabled && !PRACTICE_BTN.hidden) return PRACTICE_BTN;
    }

    return null;
  }

  function startNativeGame() {
    if (!session.running || !canStartMore() || targetReached()) return false;

    if (settings.mode === 'formal') {
      const check = formalPrecheck(state);
      if (!check.ok) {
        stopAuto(check.reason);
        return false;
      }
    }

    const btn = currentNativeStartButton();
    if (!btn) {
      statusText = '等待游戏按钮可用…';
      return false;
    }

    const now = Date.now();
    if (now - lastStartClick < 1200) return false;

    lastStartClick = now;
    statusText = '启动第 ' + (session.started + 1) + ' 局' + modeLabel() + '…';
    btn.click();
    return true;
  }

  async function syncVisibleState(force = false) {
    if (!force && (!session.running || settings.runMode !== 'visible')) return;

    try {
      const s = await getState();
      state = s;
      stateError = '';

      if (s?.status === 'active') {
        const sm = stateMode(s);
        if (sm && sm !== settings.mode) {
          stopAuto('当前牌局模式与脚本选择不一致');
          return;
        }

        registerStarted(s);
      } else if (s?.status === 'settled') {
        recordSettlement(s);

        if (
          session.running &&
          settings.autoRestart &&
          !targetReached() &&
          canStartMore()
        ) {
          startNativeGame();
        }
      } else if (
        session.running &&
        settings.autoRestart &&
        canStartMore()
      ) {
        startNativeGame();
      }

      render();
    } catch (e) {
      stateError = String(e?.message || e);
      render();
    }
  }

  function visibleControlTick() {
    if (!session.running || settings.runMode !== 'visible') return;
    if (state?.status !== 'active') {
      releaseKeys();
      return;
    }

    const snap = readEngineSnapshot();
    if (!snap) return;

    if (snap.endReason) {
      releaseKeys();
      statusText = '本局结束，等待服务器结算…';
      return;
    }

    const input = chooseAutoInput(snap);
    applyVisibleInput(input);

    statusText =
      '自动驾驶 · ' + snap.score + ' 分 · ' +
      snap.lives + ' 命 · 火力 ' + snap.power +
      ' · ' + Math.floor(snap.frame / FPS) + 's';

    render();
  }

  async function prepareBackgroundGame(s) {
    const engine = await waitForEngine();

    bgGame = s;
    state = s;
    bgServerOffset = Number(s.server_now || Date.now()) - Date.now();
    bgSeq = Number(s.chunks || 0);
    bgFrame = 0;
    bgEnding = false;
    bgPending = null;

    engine.start(String(s.seed));

    const prior = decodeInputs(s.inputs || '');
    for (const input of prior) {
      engine.step(input);
      bgFrame++;
    }

    if (prior.length && bgFrame < bgSeq * FPS) {
      bgFrame = bgSeq * FPS;
    }

    registerStarted(s);
    statusText = '后台引擎已就绪，等待开局时间…';
    render();
  }

  async function apiStartBackgroundGame() {
    if (!session.running || !canStartMore() || targetReached()) return;

    if (settings.mode === 'formal') {
      const check = formalPrecheck(state);
      if (!check.ok) {
        stopAuto(check.reason);
        return;
      }
    }

    statusText = '后台启动第 ' + (session.started + 1) + ' 局' + modeLabel() + '…';

    const s = await postAPI(CFG.Start, {
      request: newRequestID(),
      practice: settings.mode === 'practice' ? 1 : 0,
    });

    if (s?.error) throw new Error(s.error);

    if (s?.code === 'active') {
      const fresh = await getState();
      await prepareBackgroundGame(fresh);
      return;
    }

    await prepareBackgroundGame(s);
  }

  async function sendPendingChunk() {
    if (!bgPending || !bgGame) return false;

    const seqAtSend = bgSeq;
    const res = await postAPI(CFG.Input, {
      game: bgGame.id,
      seq: seqAtSend,
      data: bgPending.data,
    });

    const serverChunks = Number(res?.chunks || 0);
    const accepted = !res?.error || serverChunks > seqAtSend;

    if (accepted) {
      bgSeq = Math.max(seqAtSend + 1, serverChunks);
      bgPending = null;
    }

    if (res?.code === 'over') {
      bgEnding = true;
      bgPending = null;
    }

    if (res?.error && !accepted && res?.code !== 'over') {
      throw new Error(res.error);
    }

    return accepted;
  }

  async function generateOneChunk() {
    if (!bgGame || bgPending || bgEnding) return;

    const engine = await waitForEngine();
    const inputs = [];

    for (let i = 0; i < FPS && bgFrame < MAX_FRAMES; i++) {
      const before = readEngineSnapshot();
      if (before?.endReason) {
        bgEnding = true;
        break;
      }

      const input = chooseAutoInput(before);
      inputs.push(input);
      engine.step(input);
      bgFrame++;

      const after = readEngineSnapshot();
      if (after?.endReason) {
        bgEnding = true;
        break;
      }
    }

    if (inputs.length) {
      bgPending = {
        data: encodeChunk(inputs),
        frames: inputs.length,
      };
    }

    if (bgFrame >= MAX_FRAMES) bgEnding = true;
  }

  async function finishBackgroundGame() {
    if (!bgGame) return;

    statusText = '后台结算中……';

    const result = await postAPI(CFG.Finish, {
      game: bgGame.id,
    });

    state = result;
    recordSettlement(result);

    bgGame = null;
    bgPending = null;
    bgEnding = false;
    bgNextStartAt = Date.now() + 700;

    render();
  }

  async function backgroundTick() {
    if (!session.running || settings.runMode !== 'background' || apiBusy) return;

    apiBusy = true;

    try {
      if (targetReached()) return;

      if (!bgGame) {
        if (Date.now() < bgNextStartAt) return;
        if (!canStartMore()) return;

        await apiStartBackgroundGame();
        return;
      }

      const nowServer = Date.now() + bgServerOffset;

      if (nowServer < Number(bgGame.start_at || 0)) {
        const left = Math.max(0, Math.ceil((Number(bgGame.start_at) - nowServer) / 1000));
        statusText = '后台倒计时：' + left + 's';
        return;
      }

      if (bgPending) {
        const dueChunks = Math.max(
          0,
          Math.floor((nowServer - Number(bgGame.start_at || 0)) / 1000)
        );

        if (bgSeq < dueChunks || bgEnding) {
          await sendPendingChunk();
        }

        return;
      }

      if (bgEnding) {
        await finishBackgroundGame();
        return;
      }

      const dueChunks = Math.min(
        120,
        Math.max(0, Math.floor((nowServer - Number(bgGame.start_at || 0)) / 1000))
      );

      if (bgSeq >= dueChunks) {
        const snap = readEngineSnapshot();

        if (snap) {
          statusText =
            '后台自动 · ' + snap.score + ' 分 · ' +
            snap.lives + ' 命 · 火力 ' + snap.power +
            ' · ' + Math.floor(snap.frame / FPS) + 's';
        }

        return;
      }

      await generateOneChunk();

      if (bgPending) {
        await sendPendingChunk();
      }

      const snap = readEngineSnapshot();
      if (snap?.endReason) bgEnding = true;

      if (bgEnding && !bgPending) {
        await finishBackgroundGame();
      }
    } catch (e) {
      stateError = String(e?.message || e);
      statusText = '后台错误：' + stateError;
    } finally {
      apiBusy = false;
      render();
    }
  }
  function avgScore() {
    return session.settled ? session.totalScore / session.settled : 0;
  }

  function fmtSigned(n) {
    n = Number(n) || 0;
    return (n > 0 ? '+' : '') + n;
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

  function endReasonLabel(v) {
    return ({
      1: '被击落',
      2: '坚持到底',
      3: '击败 Boss',
    })[Number(v)] || '结束';
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

    const rows = history.slice(0, 20).map(item => {
      return '<tr>' +
        '<td><a href="/games/thunder-fighter/records/' + esc(item.id) + '/" target="_blank" rel="noopener">#' + esc(item.id) + '</a></td>' +
        '<td>' + esc(modeLabel(item.mode)) + '</td>' +
        '<td>' + esc(item.score) + '</td>' +
        '<td>' + esc(item.kills) + '</td>' +
        '<td>' + esc(endReasonLabel(item.endReason)) + '</td>' +
        '<td class="' + (item.net > 0 ? 'pos' : item.net < 0 ? 'neg' : '') + '">' +
          (item.mode === 'formal' ? esc(fmtSigned(item.net)) : '—') +
        '</td>' +
        '<td>' + esc(formatTime(item.ts)) + '</td>' +
      '</tr>';
    }).join('');

    ui.history.innerHTML =
      rows ||
      '<tr><td colspan="7" class="empty">暂无自动记录</td></tr>';
  }

  function render() {
    if (!ui?.panel) return;

    ui.dot.classList.toggle('on', session.running);
    ui.mode.disabled = session.running;
    ui.runMode.disabled = session.running;
    ui.strategy.disabled = session.running;

    ui.toggle.textContent =
      session.running
        ? '停止自动'
        : '开始自动';

    const target = Math.max(0, Number(settings.targetGames) || 0);

    ui.progress.textContent =
      session.settled + '/' + (target || '∞') + ' 已完成 · ' +
      session.started + '/' + (target || '∞') + ' 已开始';

    ui.status.textContent = statusText;
    ui.ai.textContent = aiText;

    ui.score.textContent =
      state?.status === 'active'
        ? String(state.score ?? readEngineSnapshot()?.score ?? '—')
        : String(readEngineSnapshot()?.score ?? '—');

    ui.coins.textContent =
      state?.coins != null
        ? String(state.coins)
        : '—';

    ui.best.textContent = String(session.best || 0);
    ui.avg.textContent = session.settled ? avgScore().toFixed(0) : '—';
    ui.net.textContent = settings.mode === 'formal' ? fmtSigned(session.totalNet) : '—';
    ui.net.className = session.totalNet > 0 ? 'pos' : session.totalNet < 0 ? 'neg' : '';

    const snap = readEngineSnapshot();
    if (session.running && snap) {
      ui.life.textContent = String(snap.lives);
      ui.power.textContent = String(snap.power);
      ui.time.textContent = Math.max(0, 120 - Math.floor(snap.frame / FPS)) + 's';
    } else {
      ui.life.textContent = '—';
      ui.power.textContent = '—';
      ui.time.textContent = '—';
    }

    ui.modeNote.className = 'tfa-mode-note ' + (settings.mode === 'formal' ? 'formal' : 'practice');
    ui.modeTitle.textContent =
      modeLabel() + ' · ' + runModeLabel();

    ui.modeDesc.textContent =
      settings.mode === 'formal'
        ? '每局 ' + ENTRY + ' 游戏币；每天前 ' + (state?.daily_max || 10) + ' 局计奖。'
        : '练习局不扣币，也不返币。';

    ui.foot.textContent =
      settings.runMode === 'background'
        ? '后台稳定：WASM 本地模拟 + 正常 Input/Finish 接口，每 60 帧提交一次'
        : '前台可视：原页面负责渲染和提交，脚本只自动控制方向';

    ui.error.textContent = stateError ? '错误：' + stateError : '';
    ui.body.hidden = !!settings.collapsed;
    ui.collapse.textContent = settings.collapsed ? '展开' : '收起';

    renderHistory();
  }

  async function startAuto() {
    settings.mode = ui.mode.value === 'formal' ? 'formal' : 'practice';
    settings.runMode = ui.runMode.value === 'background' ? 'background' : 'visible';
    settings.strategy =
      ['survival', 'balanced', 'aggressive'].includes(ui.strategy.value)
        ? ui.strategy.value
        : 'balanced';
    settings.targetGames = Math.max(0, parseInt(ui.target.value || '0', 10) || 0);
    settings.autoRestart = ui.restart.checked;
    saveSettings();

    stateError = '';
    statusText = '读取当前状态…';
    aiText = '—';
    render();

    try {
      await waitForEngine();

      const current = await getState();
      state = current;

      if (settings.mode === 'formal') {
        const check = formalPrecheck(current);

        if (!check.ok) {
          statusText = check.reason;
          render();
          return;
        }

        const target = settings.targetGames || '直到手动停止 / 每日上限';
        const remaining =
          Number.isFinite(Number(current.daily_max)) && Number.isFinite(Number(current.played_today))
            ? Math.max(0, Number(current.daily_max) - Number(current.played_today))
            : '未知';

        const ok = confirm(
          '将启动雷霆战机正式计奖自动模式。\n\n' +
          '每局：' + ENTRY + ' 游戏币\n' +
          '目标局数：' + target + '\n' +
          '今日剩余计奖局：' + remaining + '\n' +
          '当前余额：' + (current.coins ?? '未知') + ' 游戏币\n' +
          '运行方式：' + runModeLabel() + '\n\n' +
          '确定继续吗？'
        );

        if (!ok) {
          statusText = '已取消';
          render();
          return;
        }
      }

      if (
        settings.runMode === 'background' &&
        current?.status === 'active'
      ) {
        statusText = '后台稳定模式请在没有进行中牌局时启动；先完成当前局或刷新后再开。';
        render();
        return;
      }

      resetSession();
      session.running = true;
      apiBusy = false;
      render();

      if (settings.runMode === 'background') {
        startBackgroundHeartbeat();
        bgNextStartAt = Date.now();
        await backgroundTick();
      } else {
        stopBackgroundHeartbeat();

        if (current?.status === 'active') {
          const sm = stateMode(current);
          if (sm && sm !== settings.mode) {
            stopAuto('当前牌局模式与脚本选择不一致');
            return;
          }

          registerStarted(current);
          statusText = '接管当前' + modeLabel() + '局';
        } else {
          startNativeGame();
        }
      }

      render();
    } catch (e) {
      stateError = String(e?.message || e);
      stopAuto('启动失败：' + stateError);
    }
  }

  function stopAuto(reason = '手动停止') {
    session.running = false;
    apiBusy = false;
    releaseKeys();
    stopBackgroundHeartbeat();

    bgPending = null;
    statusText = reason;
    aiText = '—';

    render();
  }

  const panel = document.createElement('section');
  panel.id = 'tf-auto-panel';
  panel.innerHTML =
    '<div class="tfa-head">' +
      '<div class="tfa-title"><span id="tfa-dot"></span><b>雷霆战机 Auto</b><small>v1</small></div>' +
      '<button id="tfa-collapse" type="button">收起</button>' +
    '</div>' +

    '<div id="tfa-body">' +
      '<div class="tfa-mode-note practice" id="tfa-mode-note">' +
        '<b id="tfa-mode-title">练习 · 前台可视</b>' +
        '<span id="tfa-mode-desc">练习局不扣币，也不返币。</span>' +
      '</div>' +

      '<div class="tfa-controls">' +
        '<label>游戏模式' +
          '<select id="tfa-mode">' +
            '<option value="practice">练习</option>' +
            '<option value="formal">正式计奖</option>' +
          '</select>' +
        '</label>' +

        '<label>运行方式' +
          '<select id="tfa-run-mode">' +
            '<option value="visible">前台可视</option>' +
            '<option value="background">后台稳定</option>' +
          '</select>' +
        '</label>' +

        '<label>AI 策略' +
          '<select id="tfa-strategy">' +
            '<option value="survival">保命优先</option>' +
            '<option value="balanced">均衡</option>' +
            '<option value="aggressive">激进追分</option>' +
          '</select>' +
        '</label>' +

        '<label>自动局数' +
          '<input id="tfa-target" type="number" min="0" step="1" title="0 = 无限">' +
        '</label>' +

        '<label class="tfa-check">' +
          '<input id="tfa-restart" type="checkbox">' +
          '<span>自动续下一局</span>' +
        '</label>' +
      '</div>' +

      '<div class="tfa-buttons">' +
        '<button id="tfa-toggle" class="primary" type="button">开始自动</button>' +
        '<button id="tfa-sync" type="button">刷新状态</button>' +
      '</div>' +

      '<div class="tfa-progress" id="tfa-progress">0/1 已完成 · 0/1 已开始</div>' +

      '<div class="tfa-now">' +
        '<div><span>当前状态</span><b id="tfa-status">准备就绪</b></div>' +
        '<div><span>AI 判断</span><b id="tfa-ai">—</b></div>' +
      '</div>' +

      '<div class="tfa-stats">' +
        '<div><span>当前分</span><b id="tfa-score">—</b></div>' +
        '<div><span>剩余</span><b id="tfa-time">—</b></div>' +
        '<div><span>生命</span><b id="tfa-life">—</b></div>' +
        '<div><span>火力</span><b id="tfa-power">—</b></div>' +
        '<div><span>游戏币</span><b id="tfa-coins">—</b></div>' +
        '<div><span>本轮净收益</span><b id="tfa-net">—</b></div>' +
        '<div><span>最高分</span><b id="tfa-best">0</b></div>' +
        '<div><span>平均分</span><b id="tfa-avg">—</b></div>' +
      '</div>' +

      '<div class="tfa-history-head">' +
        '<b>历史记录</b>' +
        '<button id="tfa-clear" type="button">清空</button>' +
      '</div>' +

      '<div class="tfa-history-wrap">' +
        '<table>' +
          '<thead><tr><th>局</th><th>模式</th><th>分</th><th>击毁</th><th>结束</th><th>净</th><th>时间</th></tr></thead>' +
          '<tbody id="tfa-history"></tbody>' +
        '</table>' +
      '</div>' +

      '<div id="tfa-error" class="tfa-error"></div>' +
      '<div class="tfa-foot" id="tfa-foot">自动躲弹 · 自动开火</div>' +
    '</div>';

  document.body.appendChild(panel);

  const style = document.createElement('style');
  style.textContent = [
    '#tf-auto-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:min(470px,calc(100vw - 24px));font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#f4f6f8;background:rgba(18,21,27,.97);border:1px solid rgba(255,255,255,.14);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.38);overflow:hidden;backdrop-filter:blur(10px)}',
    '#tf-auto-panel *{box-sizing:border-box}#tf-auto-panel button,#tf-auto-panel input,#tf-auto-panel select{font:inherit}',
    '#tf-auto-panel .tfa-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.1)}',
    '#tf-auto-panel .tfa-title{display:flex;align-items:center;gap:7px}#tf-auto-panel .tfa-title small{color:#8d98a8}',
    '#tf-auto-panel #tfa-dot{width:9px;height:9px;border-radius:50%;background:#6d7480}#tf-auto-panel #tfa-dot.on{background:#4ade80;box-shadow:0 0 0 3px rgba(74,222,128,.12)}',
    '#tf-auto-panel .tfa-head button,#tf-auto-panel .tfa-history-head button{border:1px solid rgba(255,255,255,.15);background:#2a303b;color:#e8edf3;border-radius:7px;padding:4px 8px;cursor:pointer}',
    '#tf-auto-panel #tfa-body{padding:11px}',
    '#tf-auto-panel .tfa-mode-note{display:grid;gap:2px;padding:9px 10px;border-radius:9px;background:#12251a;border:1px solid rgba(74,222,128,.22);margin-bottom:9px}',
    '#tf-auto-panel .tfa-mode-note b{color:#7ee7a0}#tf-auto-panel .tfa-mode-note span{color:#a9b8ae;font-size:11px}',
    '#tf-auto-panel .tfa-mode-note.formal{background:#2a2111;border-color:rgba(231,189,71,.32)}#tf-auto-panel .tfa-mode-note.formal b{color:#f0c85b}',
    '#tf-auto-panel .tfa-controls{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}',
    '#tf-auto-panel label{display:flex;flex-direction:column;gap:5px;color:#aeb7c4;font-size:12px}',
    '#tf-auto-panel input[type="number"],#tf-auto-panel select{width:100%;height:32px;border-radius:8px;border:1px solid #404957;background:#11151b;color:#fff;padding:0 8px;outline:none}',
    '#tf-auto-panel .tfa-check{grid-column:1/-1;display:flex;flex-direction:row;align-items:center;gap:7px;min-height:28px}',
    '#tf-auto-panel .tfa-check input{width:16px;height:16px;margin:0}',
    '#tf-auto-panel .tfa-buttons{display:grid;grid-template-columns:2fr 1fr;gap:8px;margin-top:8px}',
    '#tf-auto-panel .tfa-buttons button{height:35px;border:0;border-radius:8px;background:#333a46;color:#fff;font-weight:700;cursor:pointer}',
    '#tf-auto-panel .tfa-buttons .primary{background:#e7bd47;color:#171717}',
    '#tf-auto-panel .tfa-progress{margin:8px 0 7px;color:#9da8b6;font-size:12px;text-align:right}',
    '#tf-auto-panel .tfa-now{display:grid;gap:6px;padding:9px;border-radius:9px;background:#10141a;border:1px solid rgba(255,255,255,.07)}',
    '#tf-auto-panel .tfa-now>div{display:grid;grid-template-columns:72px 1fr;gap:8px;align-items:start}#tf-auto-panel .tfa-now span{color:#8994a4}#tf-auto-panel .tfa-now b{font-weight:600;word-break:break-word}',
    '#tf-auto-panel .tfa-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px}',
    '#tf-auto-panel .tfa-stats>div{min-width:0;background:#252b35;border-radius:8px;padding:7px}',
    '#tf-auto-panel .tfa-stats span{display:block;color:#8f9aaa;font-size:10px;white-space:nowrap}#tf-auto-panel .tfa-stats b{display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#tf-auto-panel .pos{color:#63dc8a!important}#tf-auto-panel .neg{color:#ff7b82!important}',
    '#tf-auto-panel .tfa-history-head{display:flex;align-items:center;justify-content:space-between;margin:11px 0 6px}',
    '#tf-auto-panel .tfa-history-wrap{max-height:210px;overflow:auto;border:1px solid rgba(255,255,255,.08);border-radius:9px;background:#11151a}',
    '#tf-auto-panel table{width:100%;border-collapse:collapse;font-size:11px}#tf-auto-panel th{position:sticky;top:0;z-index:1;background:#202630;color:#aeb7c4;text-align:left;padding:6px}',
    '#tf-auto-panel td{padding:6px;border-top:1px solid rgba(255,255,255,.06);max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#tf-auto-panel td a{color:#8ecbff;text-decoration:none}#tf-auto-panel .empty{text-align:center;color:#798494;padding:15px}',
    '#tf-auto-panel .tfa-error{color:#ff9499;margin-top:6px;font-size:11px}#tf-auto-panel .tfa-foot{margin-top:7px;color:#727d8d;font-size:10px;text-align:center}',
    '@media(max-width:560px){#tf-auto-panel{right:8px;bottom:8px;width:calc(100vw - 16px)}#tf-auto-panel .tfa-stats{grid-template-columns:repeat(2,1fr)}}'
  ].join('');
  document.head.appendChild(style);

  const ui = {
    panel,
    body: $('#tfa-body', panel),
    dot: $('#tfa-dot', panel),
    collapse: $('#tfa-collapse', panel),
    mode: $('#tfa-mode', panel),
    runMode: $('#tfa-run-mode', panel),
    strategy: $('#tfa-strategy', panel),
    target: $('#tfa-target', panel),
    restart: $('#tfa-restart', panel),
    toggle: $('#tfa-toggle', panel),
    sync: $('#tfa-sync', panel),
    progress: $('#tfa-progress', panel),
    status: $('#tfa-status', panel),
    ai: $('#tfa-ai', panel),
    score: $('#tfa-score', panel),
    time: $('#tfa-time', panel),
    life: $('#tfa-life', panel),
    power: $('#tfa-power', panel),
    coins: $('#tfa-coins', panel),
    net: $('#tfa-net', panel),
    best: $('#tfa-best', panel),
    avg: $('#tfa-avg', panel),
    history: $('#tfa-history', panel),
    clear: $('#tfa-clear', panel),
    error: $('#tfa-error', panel),
    foot: $('#tfa-foot', panel),
    modeNote: $('#tfa-mode-note', panel),
    modeTitle: $('#tfa-mode-title', panel),
    modeDesc: $('#tfa-mode-desc', panel),
  };

  ui.mode.value = settings.mode === 'formal' ? 'formal' : 'practice';
  ui.runMode.value = settings.runMode === 'background' ? 'background' : 'visible';
  ui.strategy.value = ['survival', 'balanced', 'aggressive'].includes(settings.strategy)
    ? settings.strategy
    : 'balanced';
  ui.target.value = String(settings.targetGames || 0);
  ui.restart.checked = !!settings.autoRestart;

  ui.mode.addEventListener('change', () => {
    if (session.running) {
      ui.mode.value = settings.mode;
      return;
    }

    settings.mode = ui.mode.value === 'formal' ? 'formal' : 'practice';
    saveSettings();
    statusText = '已切换到' + modeLabel();
    render();
  });

  ui.runMode.addEventListener('change', () => {
    if (session.running) {
      ui.runMode.value = settings.runMode;
      return;
    }

    settings.runMode = ui.runMode.value === 'background' ? 'background' : 'visible';
    saveSettings();
    statusText = '已切换到' + runModeLabel();
    render();
  });

  ui.strategy.addEventListener('change', () => {
    if (session.running) {
      ui.strategy.value = settings.strategy;
      return;
    }

    settings.strategy = ui.strategy.value;
    saveSettings();
    render();
  });

  ui.target.addEventListener('change', () => {
    settings.targetGames = Math.max(0, parseInt(ui.target.value || '0', 10) || 0);
    ui.target.value = String(settings.targetGames);
    saveSettings();
    render();
  });

  ui.restart.addEventListener('change', () => {
    settings.autoRestart = ui.restart.checked;
    saveSettings();
  });

  ui.toggle.addEventListener('click', () => {
    if (session.running) stopAuto('手动停止');
    else startAuto();
  });

  ui.sync.addEventListener('click', async () => {
    try {
      state = await getState();
      stateError = '';
      statusText = '状态已刷新';
    } catch (e) {
      stateError = String(e?.message || e);
    }
    render();
  });

  ui.collapse.addEventListener('click', () => {
    settings.collapsed = !settings.collapsed;
    saveSettings();
    render();
  });

  ui.clear.addEventListener('click', () => {
    if (!confirm('确定清空脚本保存的雷霆战机历史记录？')) return;
    history = [];
    localStorage.removeItem(HISTORY_KEY);
    render();
  });

  syncTimer = setInterval(() => {
    if (session.running && settings.runMode === 'visible') syncVisibleState();
  }, 650);

  controlTimer = setInterval(() => {
    if (session.running && settings.runMode === 'visible') visibleControlTick();

    if (
      session.running &&
      settings.runMode === 'background' &&
      !heartbeatWorker
    ) {
      backgroundTick();
    }
  }, 80);

  // 初始只读取页面状态，不自动开始。
  getState()
    .then(s => {
      state = s;
      stateError = '';
      render();
    })
    .catch(e => {
      stateError = String(e?.message || e);
      render();
    });

  render();

  // 便于控制台自检。
  window.__SB_TF_AUTO_TEST = {
    encodeInput,
    inputVector,
    encodeChunk,
    decodeInputs,
    readEngineSnapshot,
    chooseAutoInput,
  };

  console.log('[TF AUTO] v1 已加载：练习/正式计奖 + 前台可视/后台稳定 + 自动躲弹。');
})();
