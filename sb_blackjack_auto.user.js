// ==UserScript==
// @name         sb.sb Blackjack Auto Pro
// @namespace    https://sb.sb/
// @version      2.0.0
// @description  自动下注 + 基本策略自动操作；使用页面原生按钮，所以发牌、等待 drand、动画、结算都会正常显示。带局数控制、会话统计和本地历史记录。
// @match        https://sb.sb/games/blackjack/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const root = document.querySelector('[data-bj]');
  const configEl = document.getElementById('blackjack-config');
  if (!root || !configEl) {
    console.warn('[BJ AUTO PRO] 找不到游戏区域或配置。');
    return;
  }

  const CFG = JSON.parse(configEl.textContent || '{}');
  const CHIPS = Array.isArray(CFG.chips) ? CFG.chips : [10, 50, 100, 500, 1000];
  const SETTINGS_KEY = 'sb-bj-auto-pro-settings-v2';
  const HISTORY_KEY = 'sb-bj-auto-pro-history-v2';
  const MAX_HISTORY = 100;
  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  const $ = (sel, base = document) => base.querySelector(sel);
  const $$ = (sel, base = document) => [...base.querySelectorAll(sel)];

  function loadJSON(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      return v ?? fallback;
    } catch {
      return fallback;
    }
  }

  const settings = Object.assign({
    bet: 10,
    targetGames: 3,
    actionDelay: 350,
    keepHistory: true,
    collapsed: false,
  }, loadJSON(SETTINGS_KEY, {}));

  if (!CHIPS.includes(Number(settings.bet))) settings.bet = CHIPS[0];

  let history = loadJSON(HISTORY_KEY, []);
  if (!Array.isArray(history)) history = [];

  const session = {
    running: false,
    started: 0,
    settled: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    wagered: 0,
    returned: 0,
    net: 0,
    initialCoins: null,
    currentCoins: null,
    gameIds: new Set(),
    settledIds: new Set(),
    actionsByGame: new Map(),
  };

  let lastState = null;
  let lastStateError = '';
  let awaitingStart = null;
  let lastActionFingerprint = '';
  let lastActionAt = 0;
  let nextActionAt = 0;
  let loopTimer = null;
  let syncTimer = null;
  let statusText = '准备就绪';
  let recommendationText = '—';

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function saveHistory() {
    if (!settings.keepHistory) return;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
  }

  function sleepLoop(ms = 150) {
    clearTimeout(loopTimer);
    loopTimer = setTimeout(mainLoop, ms);
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.hidden || el.closest('[hidden]')) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function actionButton(action) {
    return root.querySelector(`[data-bj-act="${action}"]`);
  }

  function actionAvailable(action) {
    const b = actionButton(action);
    return !!b && isVisible(b) && !b.disabled;
  }

  function clickNative(el, why = '') {
    if (!el || el.disabled || !isVisible(el)) return false;
    const now = Date.now();
    if (now < nextActionAt) return false;
    nextActionAt = now + Math.max(120, Number(settings.actionDelay) || 350);
    if (why) statusText = why;
    el.click();
    render();
    return true;
  }

  function parseCardLabel(label) {
    const m = String(label || '').trim().match(/^([♠♥♦♣])(A|10|[2-9]|J|Q|K)$/);
    if (!m) return null;
    return { suit: m[1], rank: m[2], label: m[0] };
  }

  function valueFromRank(rank) {
    if (rank === 'A') return 11;
    if (['10', 'J', 'Q', 'K'].includes(rank)) return 10;
    return Number(rank);
  }

  function cardLabelFromId(id) {
    const n = Number(id);
    if (!Number.isFinite(n) || n < 0 || n > 51) return '?';
    return SUITS[Math.floor(n / 13)] + RANKS[n % 13];
  }

  function handInfo(cards) {
    let total = 0;
    let softAces = 0;
    for (const c of cards) {
      const v = valueFromRank(c.rank);
      total += v;
      if (v === 11) softAces++;
    }
    while (total > 21 && softAces > 0) {
      total -= 10;
      softAces--;
    }
    return { total, soft: softAces > 0 };
  }

  function dealerUpCard() {
    const labels = $$('[data-bj-dealer] .bj-card[aria-label]', root)
      .map(el => parseCardLabel(el.getAttribute('aria-label')))
      .filter(Boolean);
    return labels[0] || null;
  }

  function activeHandElement() {
    const hands = $$('.bj-hand', root);
    if (!hands.length) return null;
    return hands.find(h => h.classList.contains('is-active')) || hands[0];
  }

  function activeHandCards() {
    const hand = activeHandElement();
    if (!hand) return [];
    return $$('.bj-card[aria-label]', hand)
      .map(el => parseCardLabel(el.getAttribute('aria-label')))
      .filter(Boolean);
  }

  function dealerText(v) {
    return v === 11 ? 'A' : String(v);
  }

  // 6D / S17 / DAS / no surrender / no insurance
  function decide(cards, dealerCard) {
    const dealer = valueFromRank(dealerCard.rank);
    const can = {
      hit: actionAvailable('hit'),
      stand: actionAvailable('stand'),
      double: actionAvailable('double'),
      split: actionAvailable('split'),
    };

    // 对子：这里按“点数相同”处理，所以 10/J/Q/K 视为同类 10 点牌。
    if (cards.length === 2 && can.split) {
      const a = valueFromRank(cards[0].rank);
      const b = valueFromRank(cards[1].rank);
      if (a === b) {
        let split = false;
        if (a === 11 || a === 8) split = true;                         // AA / 88
        else if (a === 9) split = [2,3,4,5,6,8,9].includes(dealer);    // 99
        else if (a === 7) split = dealer >= 2 && dealer <= 7;          // 77
        else if (a === 6) split = dealer >= 2 && dealer <= 6;          // 66 DAS
        else if (a === 4) split = dealer === 5 || dealer === 6;        // 44 DAS
        else if (a === 2 || a === 3) split = dealer >= 2 && dealer <= 7;
        // 55 当硬 10；TT 永不分。
        if (split) {
          return { action: 'split', reason: `${cards[0].rank}${cards[1].rank} vs ${dealerText(dealer)} → 分牌` };
        }
      }
    }

    const h = handInfo(cards);
    const total = h.total;

    if (h.soft) {
      if (total <= 12) return { action: 'hit', reason: `软 ${total} vs ${dealerText(dealer)} → 要牌` };
      if (total === 13 || total === 14) {
        if (dealer >= 5 && dealer <= 6 && can.double) return { action: 'double', reason: `软 ${total} vs ${dealerText(dealer)} → 加倍` };
        return { action: 'hit', reason: `软 ${total} vs ${dealerText(dealer)} → 要牌` };
      }
      if (total === 15 || total === 16) {
        if (dealer >= 4 && dealer <= 6 && can.double) return { action: 'double', reason: `软 ${total} vs ${dealerText(dealer)} → 加倍` };
        return { action: 'hit', reason: `软 ${total} vs ${dealerText(dealer)} → 要牌` };
      }
      if (total === 17) {
        if (dealer >= 3 && dealer <= 6 && can.double) return { action: 'double', reason: `软 17 vs ${dealerText(dealer)} → 加倍` };
        return { action: 'hit', reason: `软 17 vs ${dealerText(dealer)} → 要牌` };
      }
      if (total === 18) {
        if (dealer >= 3 && dealer <= 6 && can.double) return { action: 'double', reason: `软 18 vs ${dealerText(dealer)} → 加倍` };
        if ([2,7,8].includes(dealer) || (dealer >= 3 && dealer <= 6)) return { action: 'stand', reason: `软 18 vs ${dealerText(dealer)} → 停牌` };
        return { action: 'hit', reason: `软 18 vs ${dealerText(dealer)} → 要牌` };
      }
      return { action: 'stand', reason: `软 ${total} vs ${dealerText(dealer)} → 停牌` };
    }

    if (total <= 8) return { action: 'hit', reason: `硬 ${total} vs ${dealerText(dealer)} → 要牌` };
    if (total === 9) {
      if (dealer >= 3 && dealer <= 6 && can.double) return { action: 'double', reason: `硬 9 vs ${dealerText(dealer)} → 加倍` };
      return { action: 'hit', reason: `硬 9 vs ${dealerText(dealer)} → 要牌` };
    }
    if (total === 10) {
      if (dealer >= 2 && dealer <= 9 && can.double) return { action: 'double', reason: `硬 10 vs ${dealerText(dealer)} → 加倍` };
      return { action: 'hit', reason: `硬 10 vs ${dealerText(dealer)} → 要牌` };
    }
    if (total === 11) {
      if (dealer >= 2 && dealer <= 10 && can.double) return { action: 'double', reason: `硬 11 vs ${dealerText(dealer)} → 加倍` };
      return { action: 'hit', reason: `硬 11 vs ${dealerText(dealer)} → 要牌` };
    }
    if (total === 12) {
      const stand = dealer >= 4 && dealer <= 6;
      return { action: stand ? 'stand' : 'hit', reason: `硬 12 vs ${dealerText(dealer)} → ${stand ? '停牌' : '要牌'}` };
    }
    if (total >= 13 && total <= 16) {
      const stand = dealer >= 2 && dealer <= 6;
      return { action: stand ? 'stand' : 'hit', reason: `硬 ${total} vs ${dealerText(dealer)} → ${stand ? '停牌' : '要牌'}` };
    }
    return { action: 'stand', reason: `硬 ${total} vs ${dealerText(dealer)} → 停牌` };
  }

  function phaseFromDOM() {
    if (isVisible($('[data-bj-wait]', root))) return 'wait';
    if (isVisible($('[data-bj-ins-row]', root))) return 'insurance';
    if (isVisible($('[data-bj-play-row]', root))) return 'play';
    if (isVisible($('[data-bj-again-row]', root))) return 'settled';
    if (isVisible($('[data-bj-bet-row]', root))) return 'bet';
    return 'transition';
  }

  function fingerprint(action, cards, dealer) {
    const active = $$('.bj-hand', root).indexOf(activeHandElement());
    return [
      phaseFromDOM(),
      active,
      dealer?.label || '?',
      cards.map(c => c.label).join(','),
      action,
    ].join('|');
  }

  function logAction(action, reason) {
    const id = lastState?.id;
    if (!id) return;
    if (!session.actionsByGame.has(id)) session.actionsByGame.set(id, []);
    session.actionsByGame.get(id).push({
      at: Date.now(),
      action,
      reason,
    });
  }

  function clickAction(action, reason, cards = [], dealer = null) {
    const b = actionButton(action);
    if (!b || b.disabled || !isVisible(b)) return false;

    const fp = fingerprint(action, cards, dealer);
    const now = Date.now();
    if (fp === lastActionFingerprint && now - lastActionAt < 1800) return false;

    if (now < nextActionAt) return false;
    lastActionFingerprint = fp;
    lastActionAt = now;
    recommendationText = reason;
    logAction(action, reason);
    return clickNative(b, `执行：${reason}`);
  }

  async function getState() {
    if (!CFG.State) return null;
    const r = await fetch(CFG.State, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`state HTTP ${r.status}`);
    return r.json();
  }

  function paidFromState(s) {
    if (Number.isFinite(Number(s.paid))) return Number(s.paid);
    let paid = 0;
    for (const h of s.hands || []) paid += Number(h.paid || 0);
    return paid;
  }

  function recordSettlement(s) {
    if (!s?.id || session.settledIds.has(s.id)) return;
    if (!session.gameIds.has(s.id)) return;

    session.settledIds.add(s.id);
    session.settled++;

    const staked = Number(s.staked || 0);
    const paid = paidFromState(s);
    const net = paid - staked;

    session.wagered += staked;
    session.returned += paid;
    session.net += net;
    if (net > 0) session.wins++;
    else if (net < 0) session.losses++;
    else session.pushes++;

    const rec = {
      ts: Date.now(),
      id: s.id,
      base: Number(s.base || settings.bet || 0),
      staked,
      paid,
      net,
      coins: Number(s.coins || 0),
      dealer: (s.dealer || []).map(cardLabelFromId),
      dealerTotal: s.dealer_total,
      hands: (s.hands || []).map(h => ({
        cards: (h.cards || []).map(cardLabelFromId),
        total: h.total,
        bet: h.bet,
        result: h.result || '',
        paid: Number(h.paid || 0),
      })),
      actions: session.actionsByGame.get(s.id) || [],
      recordUrl: s.record_url || `/games/blackjack/records/${s.id}/`,
    };

    history.unshift(rec);
    history = history.slice(0, MAX_HISTORY);
    saveHistory();
    render();

    if (Number(settings.targetGames) > 0 && session.settled >= Number(settings.targetGames)) {
      stopAuto(`已完成 ${session.settled}/${settings.targetGames} 局`);
    }
  }

  function registerStartedGame(s) {
    if (!s?.id || session.gameIds.has(s.id)) return;
    session.gameIds.add(s.id);
    session.started++;
    session.actionsByGame.set(s.id, []);
    awaitingStart = null;
    statusText = `第 ${session.started} 局已开始（#${s.id}）`;
    render();
  }

  async function syncState() {
    try {
      const s = await getState();
      lastState = s;
      lastStateError = '';
      if (s?.coins != null) {
        session.currentCoins = Number(s.coins);
        if (session.initialCoins == null) session.initialCoins = Number(s.coins);
      }

      // 启动后如果本来已有未结束牌局，接管为本次第 1 局。
      if (session.running && s?.id && s.status !== 'settled' && session.started === 0 && !awaitingStart) {
        registerStartedGame(s);
      }

      // 由脚本点击“下注”后，只在看到新 game id 时才计数，避免“输入 3 只打 2”的错位。
      if (session.running && awaitingStart && s?.id && s.id !== awaitingStart.beforeId) {
        registerStartedGame(s);
      }

      if (s?.status === 'settled') recordSettlement(s);
      render();
    } catch (e) {
      lastStateError = String(e?.message || e);
      render();
    }
  }

  function selectBetAndDeal() {
    if (awaitingStart) {
      if (Date.now() - awaitingStart.clickedAt > 9000) {
        awaitingStart = null;
        statusText = '开局确认超时，准备重试';
      } else {
        return;
      }
    }

    const target = Number(settings.targetGames) || 0;
    if (target > 0 && session.started >= target) {
      statusText = `已发起 ${session.started}/${target} 局，等待最后一局结算`;
      return;
    }

    const bet = Number(settings.bet);
    const chip = root.querySelector(`[data-bj-chip="${bet}"]`);
    const deal = actionButton('deal');
    if (!chip || !deal) return;

    const pressed = chip.getAttribute('aria-pressed') === 'true';
    if (!pressed) {
      clickNative(chip, `选择筹码 ${bet}`);
      return;
    }

    if (!deal.disabled && isVisible(deal)) {
      awaitingStart = {
        beforeId: lastState?.id ?? null,
        clickedAt: Date.now(),
      };
      lastActionFingerprint = '';
      clickNative(deal, `下注 ${bet}，开始第 ${session.started + 1} 局`);
    }
  }

  function startNextFromSettled() {
    const target = Number(settings.targetGames) || 0;
    if (target > 0 && session.started >= target) {
      statusText = `目标 ${target} 局已全部发起，等待结算记录`;
      return;
    }
    const rebet = actionButton('rebet');
    if (rebet && !rebet.disabled && isVisible(rebet)) {
      clickNative(rebet, '重新押注');
    }
  }

  function mainLoop() {
    if (!session.running) return;

    const phase = phaseFromDOM();

    if (phase === 'bet') {
      selectBetAndDeal();
      return sleepLoop(140);
    }

    if (phase === 'insurance') {
      recommendationText = '庄家 A → 不买保险';
      clickAction('noinsure', '庄家 A → 不买保险');
      return sleepLoop(140);
    }

    if (phase === 'play') {
      const cards = activeHandCards();
      const dealer = dealerUpCard();
      if (cards.length && dealer) {
        const d = decide(cards, dealer);
        recommendationText = d.reason;
        clickAction(d.action, d.reason, cards, dealer);
      } else {
        statusText = '等待牌面渲染';
      }
      return sleepLoop(120);
    }

    if (phase === 'settled') {
      startNextFromSettled();
      return sleepLoop(180);
    }

    if (phase === 'wait') {
      const waitText = $('[data-bj-wait-text]', root)?.textContent?.trim();
      statusText = waitText || '等待 drand 随机数';
      return sleepLoop(300);
    }

    statusText = '等待页面状态切换';
    sleepLoop(180);
  }

  async function startAuto() {
    settings.bet = Number(ui.bet.value);
    settings.targetGames = Math.max(0, parseInt(ui.target.value || '0', 10) || 0);
    settings.actionDelay = Math.max(120, Math.min(1500, parseInt(ui.delay.value || '350', 10) || 350));
    saveSettings();

    session.running = true;
    session.started = 0;
    session.settled = 0;
    session.wins = 0;
    session.losses = 0;
    session.pushes = 0;
    session.wagered = 0;
    session.returned = 0;
    session.net = 0;
    session.initialCoins = null;
    session.currentCoins = null;
    session.gameIds.clear();
    session.settledIds.clear();
    session.actionsByGame.clear();
    awaitingStart = null;
    lastActionFingerprint = '';
    lastActionAt = 0;
    nextActionAt = 0;
    statusText = '启动中，读取当前牌局…';
    recommendationText = '—';
    render();

    await syncState();

    // 若当前已经是已结算局，不把旧局计入本次；回到下注页后开始新的目标局数。
    if (lastState?.status === 'settled') {
      const rebet = actionButton('rebet');
      if (rebet && isVisible(rebet) && !rebet.disabled) clickNative(rebet, '准备新一轮自动局');
    }

    mainLoop();
  }

  function stopAuto(reason = '手动停止') {
    session.running = false;
    awaitingStart = null;
    clearTimeout(loopTimer);
    statusText = reason;
    recommendationText = '—';
    render();
  }

  function resultLabel(net) {
    if (net > 0) return '赢';
    if (net < 0) return '输';
    return '平';
  }

  function fmtSigned(n) {
    n = Number(n) || 0;
    return `${n > 0 ? '+' : ''}${n}`;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function renderHistory() {
    const rows = history.slice(0, 20).map(r => {
      const player = (r.hands || []).map((h, i) => `${r.hands.length > 1 ? `H${i+1}:` : ''}${(h.cards || []).join(' ')}(${h.total ?? '?'})`).join(' / ');
      const dealer = `${(r.dealer || []).join(' ')}${r.dealerTotal != null ? `(${r.dealerTotal})` : ''}`;
      const actionTip = (r.actions || []).map(a => a.reason).join('；') || '无玩家操作（可能天然黑杰克）';
      return `
        <tr title="${esc(actionTip)}">
          <td><a href="${esc(r.recordUrl)}" target="_blank" rel="noopener">#${esc(r.id)}</a></td>
          <td>${esc(player)}</td>
          <td>${esc(dealer)}</td>
          <td>${esc(r.staked)}</td>
          <td class="${r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}">${esc(fmtSigned(r.net))}</td>
          <td>${esc(resultLabel(r.net))}</td>
        </tr>`;
    }).join('');
    ui.historyBody.innerHTML = rows || '<tr><td colspan="6" class="empty">暂无本地记录</td></tr>';
  }

  function render() {
    if (!ui?.panel) return;
    ui.dot.classList.toggle('on', session.running);
    ui.toggle.textContent = session.running ? '停止自动' : '启动自动';
    ui.progress.textContent = `${session.settled}/${settings.targetGames || '∞'} 已结算 · ${session.started}/${settings.targetGames || '∞'} 已发起`;
    ui.status.textContent = statusText;
    ui.recommend.textContent = recommendationText;
    ui.balance.textContent = session.currentCoins == null ? '—' : session.currentCoins;
    ui.wlp.textContent = `${session.wins} / ${session.losses} / ${session.pushes}`;
    ui.net.textContent = fmtSigned(session.net);
    ui.net.className = `v ${session.net > 0 ? 'pos' : session.net < 0 ? 'neg' : ''}`;
    ui.wagered.textContent = String(session.wagered);
    ui.rtp.textContent = session.wagered > 0 ? `${(session.returned / session.wagered * 100).toFixed(2)}%` : '—';
    ui.error.textContent = lastStateError ? `状态接口：${lastStateError}` : '';
    ui.body.hidden = !!settings.collapsed;
    ui.collapse.textContent = settings.collapsed ? '展开' : '收起';
    renderHistory();
  }

  function exportCSV() {
    const lines = [['time','game','bet','staked','paid','net','player','dealer','actions','record']];
    for (const r of history) {
      const player = (r.hands || []).map(h => `${(h.cards || []).join(' ')}=${h.total}:${h.result}`).join(' / ');
      const dealer = `${(r.dealer || []).join(' ')}=${r.dealerTotal ?? ''}`;
      const actions = (r.actions || []).map(a => a.reason).join(' | ');
      lines.push([
        new Date(r.ts).toISOString(), r.id, r.base, r.staked, r.paid, r.net,
        player, dealer, actions, location.origin + r.recordUrl
      ]);
    }
    const csv = '\uFEFF' + lines.map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sb-blackjack-history-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const panel = document.createElement('section');
  panel.id = 'bj-auto-pro';
  panel.innerHTML = `
    <div class="head">
      <div class="title"><span id="bja-dot"></span><b>Blackjack Auto Pro</b><small>v2</small></div>
      <button id="bja-collapse" type="button">收起</button>
    </div>
    <div id="bja-body">
      <div class="controls">
        <label>固定下注<select id="bja-bet"></select></label>
        <label>自动局数<input id="bja-target" type="number" min="0" step="1" title="0 = 无限"></label>
        <label>操作延迟<input id="bja-delay" type="number" min="120" max="1500" step="10"><span>ms</span></label>
      </div>
      <div class="buttons">
        <button id="bja-toggle" class="primary" type="button">启动自动</button>
        <button id="bja-sync" type="button">刷新状态</button>
      </div>
      <div class="progress" id="bja-progress">0/0</div>
      <div class="now">
        <div><span>当前状态</span><b id="bja-status">准备就绪</b></div>
        <div><span>策略判断</span><b id="bja-rec">—</b></div>
      </div>
      <div class="stats">
        <div><span>余额</span><b id="bja-balance">—</b></div>
        <div><span>胜 / 负 / 平</span><b id="bja-wlp">0 / 0 / 0</b></div>
        <div><span>本轮净收益</span><b id="bja-net" class="v">0</b></div>
        <div><span>总押注</span><b id="bja-wagered">0</b></div>
        <div><span>本轮 RTP</span><b id="bja-rtp">—</b></div>
      </div>
      <div class="history-head">
        <b>历史记录</b>
        <div><button id="bja-export" type="button">导出 CSV</button><button id="bja-clear" type="button">清空</button></div>
      </div>
      <div class="history-wrap">
        <table>
          <thead><tr><th>局</th><th>你的牌</th><th>庄家</th><th>押</th><th>净</th><th>结果</th></tr></thead>
          <tbody id="bja-history"></tbody>
        </table>
      </div>
      <div id="bja-error" class="error"></div>
      <div class="foot">6 副牌 · S17 · DAS · 不买保险 · 使用网页原生按钮执行</div>
    </div>`;
  document.body.appendChild(panel);

  const style = document.createElement('style');
  style.textContent = `
    #bj-auto-pro{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:min(430px,calc(100vw - 24px));font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;color:#f4f6f8;background:rgba(18,21,27,.97);border:1px solid rgba(255,255,255,.14);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.38);overflow:hidden;backdrop-filter:blur(10px)}
    #bj-auto-pro *{box-sizing:border-box} #bj-auto-pro button,#bj-auto-pro input,#bj-auto-pro select{font:inherit}
    #bj-auto-pro .head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.1)}
    #bj-auto-pro .title{display:flex;align-items:center;gap:7px} #bj-auto-pro .title small{color:#8d98a8}
    #bj-auto-pro #bja-dot{width:9px;height:9px;border-radius:50%;background:#6d7480} #bj-auto-pro #bja-dot.on{background:#4ade80;box-shadow:0 0 0 3px rgba(74,222,128,.12)}
    #bj-auto-pro .head button,#bj-auto-pro .history-head button{border:1px solid rgba(255,255,255,.15);background:#2a303b;color:#e8edf3;border-radius:7px;padding:4px 8px;cursor:pointer}
    #bj-auto-pro #bja-body{padding:11px} #bj-auto-pro .controls{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
    #bj-auto-pro label{display:flex;flex-direction:column;gap:5px;color:#aeb7c4;font-size:12px;position:relative}
    #bj-auto-pro input,#bj-auto-pro select{width:100%;height:32px;border-radius:8px;border:1px solid #404957;background:#11151b;color:#fff;padding:0 8px;outline:none}
    #bj-auto-pro label>span{position:absolute;right:8px;bottom:8px;color:#758092;font-size:10px}
    #bj-auto-pro .buttons{display:grid;grid-template-columns:2fr 1fr;gap:8px;margin-top:9px}
    #bj-auto-pro .buttons button{height:35px;border:0;border-radius:8px;background:#333a46;color:#fff;font-weight:700;cursor:pointer}
    #bj-auto-pro .buttons .primary{background:#e7bd47;color:#171717}
    #bj-auto-pro .progress{margin:9px 0 7px;color:#9da8b6;font-size:12px;text-align:right}
    #bj-auto-pro .now{display:grid;gap:6px;padding:9px;border-radius:9px;background:#10141a;border:1px solid rgba(255,255,255,.07)}
    #bj-auto-pro .now>div{display:grid;grid-template-columns:72px 1fr;gap:8px;align-items:start} #bj-auto-pro .now span{color:#8994a4} #bj-auto-pro .now b{font-weight:600;word-break:break-word}
    #bj-auto-pro .stats{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:8px} #bj-auto-pro .stats>div{background:#252b35;border-radius:8px;padding:7px;min-width:0}
    #bj-auto-pro .stats span{display:block;color:#8f9aaa;font-size:10px;white-space:nowrap} #bj-auto-pro .stats b{display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #bj-auto-pro .pos{color:#63dc8a!important} #bj-auto-pro .neg{color:#ff7b82!important}
    #bj-auto-pro .history-head{display:flex;align-items:center;justify-content:space-between;margin:11px 0 6px} #bj-auto-pro .history-head>div{display:flex;gap:5px}
    #bj-auto-pro .history-wrap{max-height:235px;overflow:auto;border:1px solid rgba(255,255,255,.08);border-radius:9px;background:#11151a}
    #bj-auto-pro table{width:100%;border-collapse:collapse;font-size:11px} #bj-auto-pro th{position:sticky;top:0;background:#202630;color:#aeb7c4;text-align:left;padding:6px;z-index:1}
    #bj-auto-pro td{padding:6px;border-top:1px solid rgba(255,255,255,.06);vertical-align:top;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #bj-auto-pro td a{color:#8ecbff;text-decoration:none} #bj-auto-pro .empty{text-align:center;color:#798494;padding:15px}
    #bj-auto-pro .error{min-height:0;color:#ff9499;margin-top:6px;font-size:11px} #bj-auto-pro .foot{margin-top:7px;color:#727d8d;font-size:10px;text-align:center}
    @media(max-width:560px){#bj-auto-pro{right:8px;bottom:8px;width:calc(100vw - 16px)}#bj-auto-pro .controls{grid-template-columns:1fr 1fr}#bj-auto-pro .stats{grid-template-columns:repeat(3,1fr)}}
  `;
  document.head.appendChild(style);

  const ui = {
    panel,
    body: $('#bja-body', panel),
    dot: $('#bja-dot', panel),
    collapse: $('#bja-collapse', panel),
    bet: $('#bja-bet', panel),
    target: $('#bja-target', panel),
    delay: $('#bja-delay', panel),
    toggle: $('#bja-toggle', panel),
    sync: $('#bja-sync', panel),
    progress: $('#bja-progress', panel),
    status: $('#bja-status', panel),
    recommend: $('#bja-rec', panel),
    balance: $('#bja-balance', panel),
    wlp: $('#bja-wlp', panel),
    net: $('#bja-net', panel),
    wagered: $('#bja-wagered', panel),
    rtp: $('#bja-rtp', panel),
    historyBody: $('#bja-history', panel),
    export: $('#bja-export', panel),
    clear: $('#bja-clear', panel),
    error: $('#bja-error', panel),
  };

  for (const c of CHIPS) {
    const o = document.createElement('option');
    o.value = String(c); o.textContent = String(c); ui.bet.appendChild(o);
  }
  ui.bet.value = String(settings.bet);
  ui.target.value = String(settings.targetGames);
  ui.delay.value = String(settings.actionDelay);

  ui.bet.addEventListener('change', () => { settings.bet = Number(ui.bet.value); saveSettings(); });
  ui.target.addEventListener('change', () => { settings.targetGames = Math.max(0, parseInt(ui.target.value || '0', 10) || 0); ui.target.value = String(settings.targetGames); saveSettings(); render(); });
  ui.delay.addEventListener('change', () => { settings.actionDelay = Math.max(120, Math.min(1500, parseInt(ui.delay.value || '350', 10) || 350)); ui.delay.value = String(settings.actionDelay); saveSettings(); });
  ui.toggle.addEventListener('click', () => session.running ? stopAuto('手动停止') : startAuto());
  ui.sync.addEventListener('click', syncState);
  ui.collapse.addEventListener('click', () => { settings.collapsed = !settings.collapsed; saveSettings(); render(); });
  ui.export.addEventListener('click', exportCSV);
  ui.clear.addEventListener('click', () => {
    if (!confirm('确定清空脚本保存的本地 Blackjack 历史记录？')) return;
    history = []; localStorage.removeItem(HISTORY_KEY); render();
  });

  // 状态同步一直运行：即使刚好停止在最后一局结算画面，也能把最后一局写进历史。
  syncState();
  syncTimer = setInterval(syncState, 650);
  render();

  console.log('[BJ AUTO PRO] v2 已加载：所有下注/要牌/停牌/加倍/分牌均通过网页原生按钮执行。');
})();
