const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

class Element {
  constructor() {
    this.listeners = {};
    this.value = '';
    this.classList = { toggle() {} };
    this.dataset = {};
    this.nodes = new Map();
  }
  set innerHTML(html) {
    this.html = html;
    for (const [, id] of html.matchAll(/id="([^"]+)"/g)) this.nodes.set(id, new Element());
  }
  get innerHTML() { return this.html || ''; }
  querySelector(selector) { return this.nodes.get(selector.slice(1)) || null; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  appendChild() {}
}

const config = { State: '/state', Input: '/input', Finish: '/finish' };
const storage = new Map();
let fetchBehavior = async () => ({ ok: true, json: async () => ({ status: 'idle' }) });
const context = vm.createContext({
  console, Uint8Array, Int32Array, DataView, Map, Set, Math, Date, Promise, FormData,
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  document: {
    getElementById: id => id === 'thunder-config' ? { textContent: JSON.stringify(config) } : null,
    querySelector: selector => selector === '[data-tf-canvas]' ? new Element() : null,
    createElement: () => new Element(),
    body: new Element(), head: new Element(),
  },
  localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
  fetch: (...args) => fetchBehavior(...args),
  setInterval: () => 0, clearInterval() {}, requestAnimationFrame() {},
  setTimeout, clearTimeout,
});
context.window = context;
let source = fs.readFileSync(path.join(__dirname, '..', 'sb_thunder_auto.user.js'), 'utf8');
source = source.replace('  // 便于控制台自检。', `
  window.integrationAPI = {
    settings, ui, session, humanControl, naturalInput, resetHumanControl, naturalPlanLength,
    resetInputStats, inputStats, sendPendingChunk, encodeChunk, decodeInputs,
    repairLost, packStreamChunk, generateOneChunk, finishBackgroundGame, resetSession, backgroundTick,
    setupStream: (gen, expected = null) => {
      bgGame = { id: 99, seed: '1', practice: true }; bgFrame = 0; bgSeq = 0;
      bgPending = null; bgEnding = false; bgGen = gen; bgExpectedScore = expected;
    },
    streamState: () => ({ bgFrame, bgEnding, bgExpectedScore, bgGen }),
    setPending: (id, inputs, seq = 0) => {
      bgGame = { id }; bgSeq = seq;
      const data = encodeChunk(inputs);
      bgPending = { inputs, data, bytes: atob(data).length, frames: inputs.length };
    },
    pending: () => bgPending,
    seq: () => bgSeq,
  };
  // 便于控制台自检。`);
vm.runInContext(source, context);
const api = context.integrationAPI;

async function main() {
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.ui.controlStyle.value, 'natural');
  assert.equal(api.ui.inputBytes.textContent, '—');
  api.ui.controlStyle.value = 'classic';
  api.ui.controlStyle.listeners.change();
  assert.equal(api.settings.controlStyle, 'classic');
  assert.equal(JSON.parse(storage.get('sb-tf-auto-settings-v1')).controlStyle, 'classic');
  api.session.running = true;
  api.ui.controlStyle.value = 'natural';
  api.ui.controlStyle.listeners.change();
  assert.equal(api.ui.controlStyle.value, 'classic');
  api.session.running = false;
  api.ui.controlStyle.value = 'natural';
  api.ui.controlStyle.listeners.change();

  for (const seq of [[], [512], Array(7200).fill(512), Array.from({ length: 7200 }, (_, i) => i % 1024)]) {
    assert.deepEqual(Array.from(api.decodeInputs(api.encodeChunk(seq))), seq);
  }
  const sample = [520, 520, 520, 648, 648, 512];
  api.resetInputStats(17);
  api.setPending(17, sample);
  fetchBehavior = async () => ({ ok: true, json: async () => ({ error: 'retry', chunks: 0 }) });
  await assert.rejects(api.sendPendingChunk(), /retry/);
  assert.equal(api.inputStats.bytes, 0);
  assert(api.pending());
  fetchBehavior = async (_url, options) => {
    assert.equal(options.body.get('seq'), '0');
    assert.deepEqual(Array.from(api.decodeInputs(options.body.get('data'))), sample);
    return { ok: true, json: async () => ({ chunks: 1 }) };
  };
  await api.sendPendingChunk();
  assert.equal(api.inputStats.bytes, 9);
  assert.equal(api.inputStats.frames, 6);
  assert.equal(api.inputStats.changes, 3);
  assert.equal(api.seq(), 1);
  await api.sendPendingChunk();
  assert.equal(api.inputStats.bytes, 9);

  // 已入库但回复丢失时，重发同一 seq 的确认只累计一次。
  api.setPending(17, [512, 512], 1);
  fetchBehavior = async () => ({ ok: true, json: async () => ({ error: 'duplicate', chunks: 2 }) });
  await api.sendPendingChunk();
  assert.equal(api.inputStats.bytes, 12);
  assert.equal(api.inputStats.changes, 3);

  // 旧局请求晚到，不能污染新局统计。
  api.setPending(17, sample, 2);
  let resolveResponse;
  fetchBehavior = () => new Promise(resolve => { resolveResponse = resolve; });
  const lateRequest = api.sendPendingChunk();
  api.resetInputStats(18);
  api.setPending(18, [512]);
  resolveResponse({ ok: true, json: async () => ({ chunks: 3 }) });
  assert.equal(await lateRequest, false);
  assert.equal(api.inputStats.gameId, 18);
  assert.equal(api.inputStats.bytes, 0);
  assert.equal(api.seq(), 0);

  // 开火/停火、紧急避险和原版开关必须保留其语义。
  api.resetHumanControl('14990132883620190655');
  for (let frame = 0; frame < 1000; frame++) {
    const input = frame % 3 === 0 ? 0 : frame % 3 === 1 ? 520 : 8;
    const output = api.naturalInput(input, frame, 240, 660, api.humanControl);
    assert.equal(output & 512, input & 512);
    assert((output & 15) <= 8);
    assert(output >= 0 && output <= 1023);
    assert.equal(api.naturalInput(input, frame, 240, 660, api.humanControl, true), input);
  }
  api.resetHumanControl('14990132883620190655');
  const firstSeed = api.humanControl.seed;
  api.resetHumanControl('14990132883620190656');
  assert.notEqual(api.humanControl.seed, firstSeed);
  api.resetHumanControl('14990132883620190655');
  let x = 240, y = 660, maxOffset = 0;
  for (let frame = 0; frame < 3000; frame++) {
    const output = api.naturalInput(512, frame, x, y, api.humanControl);
    const speed = output & 15;
    const angle = ((output >> 4) & 31) / 32 * Math.PI * 2;
    x += Math.sin(angle) * speed / 8 * 6;
    y -= Math.cos(angle) * speed / 8 * 6;
    maxOffset = Math.max(maxOffset, Math.hypot(x - 240, y - 660));
  }
  assert(maxOffset < 8, `Idle drift exceeded anchor bounds: ${maxOffset}`);

  // 起步必须先响应意图，再加速；频繁覆盖待响应意图不能推迟期限。
  api.resetHumanControl('14990132883620190655');
  api.naturalInput(648, 0, 240, 660, api.humanControl);
  const respondAt = api.humanControl.reactAt;
  assert(respondAt >= 4 && respondAt <= 9);
  assert.equal(api.humanControl.demand, 0);
  for (let frame = 1; frame < respondAt; frame++) {
    api.naturalInput(frame % 2 ? 776 : 648, frame, 240, 660, api.humanControl);
    assert.equal(api.humanControl.reactAt, respondAt);
    assert.equal(api.humanControl.demand, 0);
  }
  api.naturalInput(648, respondAt, 240, 660, api.humanControl);
  assert.equal(api.humanControl.demand, 136);

  // 推演副本拥有独立随机状态；同一个状态得到相同的输出。
  api.resetHumanControl('4544080754576429201');
  const saved = { ...api.humanControl };
  const trialA = { ...saved }, trialB = { ...saved };
  const sampleIntervals = new Set();
  const planIntervals = new Set();
  let zeroMovingFrames = 0;
  for (let frame = 0; frame < 5000; frame++) {
    const a = api.naturalInput(648, frame, 240, 660, trialA);
    const b = api.naturalInput(648, frame, 240, 660, trialB);
    assert.equal(a, b);
    if (frame > 30 && !(a & 15)) zeroMovingFrames++;
    if (trialA.nextFrame > frame) sampleIntervals.add(trialA.nextFrame - frame);
    const rngBefore = trialA.rng;
    const k = api.naturalPlanLength(trialA, frame);
    assert(k >= 9 && k <= 16);
    assert.equal(trialA.rng, rngBefore);
    planIntervals.add(k);
  }
  assert.deepEqual({ ...api.humanControl }, saved);
  assert(trialA.pauseCount > 0);
  assert(zeroMovingFrames > 0);
  assert.equal(sampleIntervals.size, 3);
  assert(planIntervals.size >= 6);
  api.settings.controlStyle = 'classic';
  for (const input of [0, 512, 520, 1016]) assert.equal(api.naturalInput(input, 123, 240, 660, api.humanControl), input);

  // 回溯修补只把"活着离开屏幕"的目标算作失误：原地消失（击毁/拾取）和够不着的道具不算。
  const lostPrev = [{ t: 2, x: 100, y: 775 }, { t: 2, x: 300, y: 400 }, { t: 4, x: 495, y: 200 }, { t: 7, x: 2, y: 790 }, { t: 8, x: 200, y: 790 }];
  const lostCur = [{ t: 4, x: 497, y: 200 }];
  assert.equal(api.repairLost(lostPrev, lostCur).map(e => e.t + '@' + e.x).join(), '2@100,8@200');
  assert.equal(api.repairLost(lostPrev, lostPrev).length, 0);

  // 实时仿真：只在到期时打包下一秒，打包即锁定（修补不再回溯到已提交的帧）。
  let locked = 0, ended = false;
  const route = Array.from({ length: 130 }, (_, i) => 512 + (i % 9));
  const gen = { inputs: route, final: null, lock: f => { locked = f; }, ended: () => ended };
  api.setupStream(gen);
  api.packStreamChunk(0);
  assert.equal(api.pending(), null);
  api.packStreamChunk(1);
  assert.deepEqual(Array.from(api.pending().inputs), route.slice(0, 60));
  assert.equal(locked, 60);
  api.packStreamChunk(5);
  assert.equal(api.streamState().bgFrame, 60);
  api.setPending(99, [], 0);
  api.setupStream(gen);
  api.streamState().bgGen.inputs = route.slice(0, 40);
  api.packStreamChunk(3);
  assert.equal(api.pending(), null);
  ended = true; gen.final = { score: 1234 };
  api.packStreamChunk(3);
  assert.equal(api.pending().inputs.length, 40);
  assert.equal(api.streamState().bgEnding, true);
  assert.equal(api.streamState().bgExpectedScore, 1234);

  // 服务器按同一引擎重放；结算分数与本地引擎不一致时停止，不再自动开下一局。
  api.session.running = true;
  api.settings.targetGames = 0;
  api.setupStream(gen, 100);
  fetchBehavior = async () => ({ ok: true, json: async () => ({ id: 99, score: 100, kills: 0, end_reason: 3, practice: true }) });
  await api.finishBackgroundGame();
  assert.equal(api.session.running, true);
  api.setupStream(gen, 100);
  fetchBehavior = async () => ({ ok: true, json: async () => ({ id: 99, score: 99, kills: 0, end_reason: 3, practice: true }) });
  await api.finishBackgroundGame();
  assert.equal(api.session.running, false);
  assert.match(api.ui.error.textContent, /不一致/);
  api.resetSession();
  assert.equal(api.streamState().bgGen, null);
  console.log('PASS: UI/settings, codec/acknowledgement/retry, random controls, repair escape detection, stream chunk packing/locking, settlement mismatch stop and reset');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
