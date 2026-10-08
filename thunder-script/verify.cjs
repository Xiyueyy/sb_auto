const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');

const dir = __dirname;
const filename = process.argv[2] || 'sb_thunder_auto.original.user.js';
const mode = process.argv[3] || 'replay';
const seed = process.argv[4] || '14990132883620190655';
const limit = Number(process.argv[5] || 7200);
const outputTag = process.argv[6] || '';
assert(!outputTag || /^[a-z0-9_-]+$/.test(outputTag));
assert(['replay', 'replay-output', 'ai', 'ai-classic', 'certified', 'certified-baseline', 'certified-prefix', 'trace-info'].includes(mode), 'Unknown verification mode');
const outputStem = filename + (outputTag ? `.${outputTag}` : '');
globalThis.window = globalThis;
globalThis.dispatchEvent = () => true;
globalThis.document = {
  getElementById: id => id === 'thunder-config' ? { textContent: JSON.stringify({ Wasm: 'offline.wasm' }) } : null,
  querySelector: selector => selector === '[data-tf-canvas]' ? {} : null,
};
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.fetch = async () => ({ arrayBuffer: async () => {
  const b = fs.readFileSync(path.join(dir, 'thunder.01a6b402a0.wasm'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
} });
vm.runInThisContext(fs.readFileSync(path.join(dir, 'wasm_exec.fb31a62437.js'), 'utf8'));
const sourcePath = filename === 'sb_thunder_auto.user.js' ? path.join(dir, '..', filename) : path.join(dir, filename);
const source = fs.readFileSync(sourcePath, 'utf8');
const cutoff = source.indexOf("  const panel = document.createElement('section');");
assert(cutoff > 0);
vm.runInThisContext(source.slice(0, cutoff) + `
  globalThis.testAPI = { encodeChunk, decodeInputs, plannerChoose, loadPlannerEngine,
    readPlannerSnapshot, plannerReset, planner, settings,
    ...(typeof resetHumanControl === 'function' ? { resetHumanControl } : {}),
    ...(typeof humanControl === 'object' ? { humanControl } : {}),
    ...(typeof planSave === 'function' ? { planSave, planLoad, planFill } : {}),
    ...(typeof certifySimulationTrace === 'function' ? { certifySimulationTrace, buildCertifiedGame } : {}) };
})();`, { filename });

async function main() {
  const api = globalThis.testAPI;
  if (mode === 'ai' && api.buildCertifiedGame) throw new Error('Use certified for the v2.4 runtime; ai is the unmodified baseline planner');
  const chunks = JSON.parse(fs.readFileSync(path.join(dir, 'har-inputs.sanitized.json'), 'utf8'));
  let bytes = 0;
  for (const chunk of chunks) {
    const encoded = api.encodeChunk(chunk);
    assert.deepEqual(api.decodeInputs(encoded), chunk);
    bytes += Buffer.from(encoded, 'base64').length;
  }
  console.log(JSON.stringify({ check: 'HAR codec roundtrip', chunks: chunks.length, frames: chunks.flat().length, bytes }));
  await api.loadPlannerEngine(true);
  if (['certified-baseline', 'certified', 'certified-prefix'].includes(mode)) {
    let certificate;
    const progress = p => {
      if (p.stage !== 'baseline' || p.frame % 600 === 0) console.log(JSON.stringify(p));
    };
    if (mode !== 'certified') {
      const baseStem = 'sb_thunder_auto.original.user.js' + (outputTag ? '.' + outputTag : '');
      const baseline = JSON.parse(fs.readFileSync(path.join(dir, `${baseStem}.inputs.json`), 'utf8'));
      const original = JSON.parse(fs.readFileSync(path.join(dir, `${baseStem}.result.json`), 'utf8'));
      assert.equal(original.seed, seed);
      const prefixFrames = mode === 'certified-prefix' ? Number(process.argv[7] || 240) : 0;
      certificate = await api.certifySimulationTrace(seed, baseline, prefixFrames, progress);
      assert.equal(certificate.floor.score, original.score);
      assert.deepEqual(certificate.inputs.slice(0, prefixFrames), baseline.slice(0, prefixFrames));
      certificate.baselineInputs = baseline;
    } else {
      certificate = await api.buildCertifiedGame(seed, [], progress);
      if (seed === '14990132883620190655') {
        const original = JSON.parse(fs.readFileSync(path.join(dir, 'sb_thunder_auto.original.user.js.inputs.json'), 'utf8'));
        assert.deepEqual(certificate.baselineInputs, original);
      }
    }
    await api.loadPlannerEngine(true);
    api.planner.engine.start(seed);
    for (const input of certificate.inputs) api.planner.engine.step(input);
    const replayed = api.readPlannerSnapshot();
    for (const key of ['frame','score','kills','lives','power','shield','endReason','x','y']) {
      assert.equal(replayed[key], certificate.result[key], `Fresh replay mismatch: ${key}`);
    }
    assert(replayed.score >= certificate.floor.score);
    assert(certificate.positionChanges >= 32);
    assert(certificate.inputs.every(input => input >= 0 && input <= 1023 && (input & 15) <= 8));
    for (let i = 0; i < certificate.inputs.length; i += 60) {
      const chunk = certificate.inputs.slice(i, i + 60);
      assert.deepEqual(api.decodeInputs(api.encodeChunk(chunk)), chunk);
    }
    const result = { filename, version: '2.4.0', seed, ...replayed, entities: undefined,
      bytes: certificate.bytes, baselineScore: certificate.floor.score,
      baselineKills: certificate.floor.kills, baselineLives: certificate.floor.lives,
      baselineFrames: certificate.floor.frame, baselineEndReason: certificate.floor.endReason,
      positionChanges: certificate.positionChanges,
      changedInputs: certificate.inputs.reduce((n,v,i)=>n+(v!==certificate.baselineInputs[i]?1:0),0),
      profile: certificate.profile, attempts: certificate.attempts,
      freshReplayPassed: true, scoreFloorPassed: true,
    };
    if (mode !== 'certified-prefix') {
      fs.writeFileSync(path.join(dir, `${outputStem}.result.json`), JSON.stringify(result, null, 2));
      fs.writeFileSync(path.join(dir, `${outputStem}.inputs.json`), JSON.stringify(certificate.inputs));
    }
    console.log(JSON.stringify(result));
    return;
  }
  if (mode === 'trace-info') {
    const result = JSON.parse(fs.readFileSync(path.join(dir, `${outputStem}.result.json`), 'utf8'));
    const inputs = JSON.parse(fs.readFileSync(path.join(dir, `${outputStem}.inputs.json`), 'utf8'));
    api.planner.engine.start(result.seed);
    let idle = 0, slow = 0, clamped = 0, unchanged = 0;
    const dirs = {};
    for (const input of inputs) {
      const before = api.readPlannerSnapshot();
      api.planner.engine.step(input);
      const after = api.readPlannerSnapshot();
      if (!(input & 15)) idle++;
      else if ((input & 15) < 8) slow++;
      if ((input & 15) && before.x === after.x && before.y === after.y) {
        unchanged++; const d = (input >> 4) & 31; dirs[d] = (dirs[d] || 0) + 1;
      }
      if ((input & 15) && ((before.x === after.x && [20,460].includes(after.x)) || (before.y === after.y && [20,780].includes(after.y)))) clamped++;
    }
    console.log(JSON.stringify({ seed: result.seed, frames: inputs.length, idle, slow, clamped, unchanged, dirs }));
    return;
  }
  if (mode === 'replay' || mode === 'replay-output') {
    if (mode === 'replay-output') {
      const result = JSON.parse(fs.readFileSync(path.join(dir, `${outputStem}.result.json`), 'utf8'));
      const inputs = JSON.parse(fs.readFileSync(path.join(dir, `${outputStem}.inputs.json`), 'utf8'));
      api.planner.engine.start(result.seed);
      for (const input of inputs) api.planner.engine.step(input);
      const replayed = api.readPlannerSnapshot();
      for (const key of ['frame', 'score', 'kills', 'lives', 'power', 'shield', 'endReason', 'x', 'y']) {
        assert.equal(replayed[key], result[key], `Replay mismatch: ${key}`);
      }
      console.log(JSON.stringify({ check: 'fresh engine replay of generated inputs', frame: replayed.frame, score: replayed.score, kills: replayed.kills, endReason: replayed.endReason }));
      return;
    }
    const session = JSON.parse(fs.readFileSync(path.join(dir, 'har-session.sanitized.json'), 'utf8'));
    api.planner.engine.start(session.seed);
    for (const v of chunks.flat()) api.planner.engine.step(v);
    const result = api.readPlannerSnapshot();
    assert.equal(result.frame, 7200);
    assert.equal(result.score, 13140);
    assert.equal(result.kills, 138);
    console.log(JSON.stringify({ check: 'HAR engine replay', ...result, entities: undefined }));
    return;
  }
  api.plannerReset();
  if (mode === 'ai-classic') api.settings.controlStyle = 'classic';
  api.resetHumanControl?.(seed);
  api.planner.engine.start(seed);
  const inputs = [];
  const planIntervals = [];
  let start = performance.now();
  for (let frame = 0; frame < limit; frame++) {
    const deciding = api.planner.plan.length === 0;
    const input = api.plannerChoose(false, false);
    if (deciding) planIntervals.push(api.planner.plan.length + 1);
    api.planner.engine.step(input);
    inputs.push(input);
    const snap = api.readPlannerSnapshot();
    if (snap.endReason) break;
    if ((frame + 1) % 600 === 0) {
      console.log(JSON.stringify({ progress: frame + 1, score: snap.score, lives: snap.lives, seconds: +(performance.now() - start).toFixed(1) / 1000 }));
    }
  }
  let totalBytes = 0;
  for (let i = 0; i < inputs.length; i += 60) {
    const chunk = inputs.slice(i, i + 60);
    const encoded = api.encodeChunk(chunk);
    assert.deepEqual(api.decodeInputs(encoded), chunk);
    totalBytes += Buffer.from(encoded, 'base64').length;
  }
  const result = { filename, seed, ...api.readPlannerSnapshot(), entities: undefined,
    bytes: totalBytes, inputChanges: inputs.reduce((n, v, i) => n + (i === 0 || v !== inputs[i - 1]), 0),
    seconds: +(performance.now() - start).toFixed(1) / 1000,
    simulation: api.humanControl ? {
      responses: api.humanControl.responseCount || 0,
      pauses: api.humanControl.pauseCount || 0,
      samples: api.humanControl.sampleCount || 0,
      planIntervals: Object.fromEntries([...new Set(planIntervals)].sort((a, b) => a - b).map(k => [k, planIntervals.filter(v => v === k).length])),
    } : undefined };
  if (mode === 'ai-classic') {
    const original = JSON.parse(fs.readFileSync(path.join(dir, 'sb_thunder_auto.original.user.js.inputs.json'), 'utf8'));
    assert.deepEqual(inputs, original.slice(0, inputs.length));
    console.log('PASS: classic control matches every original input frame');
  } else {
    fs.writeFileSync(path.join(dir, `${outputStem}.result.json`), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(dir, `${outputStem}.inputs.json`), JSON.stringify(inputs));
  }
  console.log(JSON.stringify(result));
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
