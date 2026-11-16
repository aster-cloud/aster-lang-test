// 额外值类别探针：Map、Long、Map 入参、Decimal 入参、Result、嵌套 List<Data>
import { readFileSync } from 'node:fs';
const ts = '/Users/rpang/IdeaProjects/wt-adr0059-p0/aster-lang-ts';
const { compile } = await import(ts + '/dist/src/browser.js');
const { readCoreIr } = await import(ts + '/dist/src/core/read-core-ir.js');
const { evaluate, serializeGuestValue } = await import(ts + '/dist/src/core/interpreter.js');
const probes = [
  ['map-out', 'Module p.m.\n\nRule f given k, produce:\n  Return Map.put(Map.put(Map.empty(), k, 1), "b", 2).\n', { k: 'z' }],
  ['long-out', 'Module p.l.\n\nRule f given x, produce:\n  Return x times 3000000000000000L.\n', { x: 4 }],
  ['long-small', 'Module p.ls.\n\nRule f given x, produce:\n  Return x times 3L.\n', { x: 4 }],
  ['long-in', 'Module p.l2.\n\nRule f given x, produce:\n  Return x plus 1.\n', { x: 9007199254740993 }],
  ['map-in', 'Module p.mi.\n\nRule f given m, produce:\n  Return Map.get(m, "a").\n', { m: { a: 7 } }],
  ['list-in-out', 'Module p.li.\n\nRule f given xs, produce:\n  Return List.map(xs, (x) => x times 2).\n', { xs: [1, 2, 3] }],
  ['double-in', 'Module p.d.\n\nRule f given x, produce:\n  Return x times 2.\n', { x: 1.25 }],
  ['decimal-lit', 'Module p.dl.\n\nRule f given x, produce:\n  Return 1.10m plus 2.205m.\n', { x: 1 }],
  ['ok-out', 'Module p.r.\n\nRule f given x, produce:\n  Return Ok(x).\n', { x: 1 }],
  ['null-out', 'Module p.n.\n\nRule f given x, produce:\n  Return None.\n', { x: 1 }],
];
for (const [name, src, ctx] of probes) {
  const c = compile(src);
  if (!c.success) { console.log(name, 'ts-compile-failed', JSON.stringify(c.parseErrors ?? c.resolutionDiagnostics ?? c.loweringErrors).slice(0, 160)); continue; }
  const tree = JSON.parse(c.coreJson);
  tree.decls.find((d) => d.kind === 'Func').annotations.push({ name: 'entry', args: [] });
  const t = evaluate(readCoreIr(c.coreJson), 'f', structuredClone(ctx), { maxSteps: Number.MAX_SAFE_INTEGER });
  const body = JSON.stringify({ policy: JSON.stringify(tree), context: ctx }).replace('9007199254740992', '9007199254740993');
  const res = await fetch('http://localhost:18959/api/v1/policies/evaluate-json', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 'p0', 'X-User-Role': 'ADMIN', 'X-User-Id': 'p0' }, body });
  const text = await res.text();
  console.log(name, '| ts:', t.success ? serializeGuestValue(t.value) : 'ERR ' + t.error, '| api:', res.status, text.replace(/"evidence":\{[^}]*\},/, '').slice(0, 220));
}
