// 逐节点比较 ts / Java IR 的 origin，归类 col 差异（节点 kind × start/end）
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [,, tsRoot, cpFile, harness, ...files] = process.argv;
const { compile } = await import(tsRoot + '/dist/src/browser.js');
const reqs = files.map((f, i) => ({ id: String(i), source: readFileSync(f, 'utf8'), locale: 'en-US', aliasSet: null, vocabulary: null }));
const j = spawnSync('java', ['-cp', readFileSync(cpFile, 'utf8').trim(), harness], { input: reqs.map((r) => JSON.stringify(r)).join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 30 });
const jo = j.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
const tally = {};
function walk(a, b, kind) {
  if (a && typeof a === 'object' && b && typeof b === 'object') {
    if (a.origin && b.origin && a.origin.start) {
      for (const se of ['start', 'end']) {
        if (a.origin[se].col !== b.origin[se].col) {
          const k = `${a.kind ?? kind}.${se} ${a.origin[se].line === b.origin[se].line ? 'sameLine' : 'lineDiff'} delta=${Math.sign(b.origin[se].col - a.origin[se].col)}`;
          tally[k] = (tally[k] ?? 0) + 1;
        }
      }
    }
    for (const k of Object.keys(a)) if (k !== 'origin') walk(a[k], b[k], a.kind ?? kind);
  }
}
let nodes = 0;
files.forEach((f, i) => {
  const t = compile(readFileSync(f, 'utf8'));
  if (!t.success || !jo[i]?.ok) return;
  walk(JSON.parse(t.coreJson), JSON.parse(jo[i].coreJson), 'Module');
  nodes += (t.coreJson.match(/"origin":\{"end"/g) ?? []).length;
});
console.log('origin nodes', nodes);
console.log(Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${v}\t${k}`).join('\n'));
