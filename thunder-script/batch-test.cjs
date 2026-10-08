const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const dir = __dirname;
const freshBaselines = process.argv.includes('--fresh-baselines');
const seeds = [
  '14990132883620190655', '4544080754576429201', '1', '42',
  '20261008', '9223372036854775808', '18446744073709551615', '9876543210123456789',
];
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, file === 'sb_thunder_auto.user.js' ? '..' : '.', file))).digest('hex');
const sourceHash = sha('sb_thunder_auto.user.js');
const baselineHash = sha('sb_thunder_auto.original.user.js');
const engineHash = sha('thunder.01a6b402a0.wasm');
let next = 0;
const rows = [];
function run(args, label) {
  return new Promise((resolve,reject) => {
    const child = spawn(process.execPath, [path.join(dir,'verify.cjs'), ...args], { cwd: path.dirname(dir), windowsHide: true });
    const chunks = [];
    child.stdout.on('data', data => {
      chunks.push(data);
      for (const line of data.toString().trim().split('\n')) {
        try { const p = JSON.parse(line);
          if (p.progress || p.stage === 'certificate') console.log(JSON.stringify({ label, ...p }));
        } catch {}
      }
    });
    child.stderr.on('data', data => chunks.push(data));
    child.on('error', reject);
    child.on('close', code => {
      fs.writeFileSync(path.join(dir,`batch-${label.replace(/[^a-z0-9_-]/g,'_')}.log`), Buffer.concat(chunks));
      code === 0 ? resolve() : reject(new Error(label+' failed with code '+code));
    });
  });
}
async function worker() {
  for (;;) {
    const index = next++;
    if (index >= seeds.length) return;
    const seed = seeds[index], tag = 'seed'+String(index+1).padStart(2,'0');
    const stem = 'sb_thunder_auto.original.user.js.'+tag;
    try {
      if (!freshBaselines && index === 0 && !fs.existsSync(path.join(dir,stem+'.result.json'))) {
        for (const suffix of ['result.json','inputs.json']) fs.copyFileSync(path.join(dir,'sb_thunder_auto.original.user.js.'+suffix),path.join(dir,stem+'.'+suffix));
      }
      if (freshBaselines || !fs.existsSync(path.join(dir,stem+'.result.json'))) {
        console.log(JSON.stringify({ stage:'start-baseline',seed,tag }));
        await run(['sb_thunder_auto.original.user.js','ai',seed,'7200',tag],tag+'-baseline');
      }
      await run(['sb_thunder_auto.user.js','certified-baseline',seed,'7200',tag],tag+'-protected');
      const baseline = JSON.parse(fs.readFileSync(path.join(dir,stem+'.result.json')));
      const protectedResult = JSON.parse(fs.readFileSync(path.join(dir,'sb_thunder_auto.user.js.'+tag+'.result.json')));
      if (protectedResult.score < baseline.score || !protectedResult.freshReplayPassed || protectedResult.positionChanges < 32) throw new Error('Score/simulation/replay assertion failed');
      if (protectedResult.bytes < 7000 || protectedResult.bytes > 10000) throw new Error('Byte-range assertion failed');
      const row = { tag,seed, baselineScore:baseline.score, protectedScore:protectedResult.score,
        delta:protectedResult.score-baseline.score,bytes:protectedResult.bytes,
        kills:protectedResult.kills,lives:protectedResult.lives,endReason:protectedResult.endReason,
        positionChanges:protectedResult.positionChanges,replayPassed:true,scoreFloorPassed:true,byteRangePassed:true,
        attempts:protectedResult.attempts.length };
      rows.push(row);
      console.log(JSON.stringify({ stage:'seed-passed',...row }));
    } catch (error) {
      rows.push({ tag,seed,error:String(error),scoreFloorPassed:false });
      console.log(JSON.stringify({ stage:'seed-failed',tag,seed,error:String(error) }));
    }
    saveReport();
  }
}
function saveReport() {
  const sorted = [...rows].sort((a,b)=>a.tag.localeCompare(b.tag));
  const report = { version:'2.4.0',date:'2026-10-08',engineVersion:1,
    sourceHash,baselineHash,engineHash,seeds,results:sorted,
    passed:sorted.filter(r=>r.scoreFloorPassed && r.byteRangePassed).length,total:seeds.length };
  fs.writeFileSync(path.join(dir,'batch-results.json'),JSON.stringify(report,null,2));
}
Promise.all([worker(),worker()]).then(()=>{
  saveReport();
  console.log(JSON.stringify({ stage:'complete',passed:rows.filter(r=>r.scoreFloorPassed).length,total:seeds.length }));
  if (rows.some(r=>!r.scoreFloorPassed)) process.exitCode=1;
}).catch(error=>{console.error(error);process.exitCode=1;});
