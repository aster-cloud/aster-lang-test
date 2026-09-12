/**
 * 跨引擎 Core IR 归一化 —— **两引擎 IR 可比性的单一真相源**。
 *
 * <h2>为什么必须共享</h2>
 *
 * TS 与 Java 的原始 Core IR 字段**本就不同**，且这是 ADR 0016 §B/§C 认定的
 * **合法分岔**（推导分析层）：
 *
 * ```
 *   Java 独有   annotations / retAnnotations / piiLevel / piiCategories
 *   TS   独有   retTypeInferred / constraints / typeInferred
 * ```
 *
 * 所以任何「跨引擎比较 IR」的动作——parity 门禁、ADR 0037 的 contentHash、
 * 未来的 MappingIR verifier——都必须先过同一套归一化。
 *
 * ★本模块从 `scripts/parity-tier1.mjs` **原样抽出**（行为不变），目的是避免
 * 出现第二套归一化规则。本仓反复记录过单源漂移事故：两处规则各自演进后，
 * 门禁说「一致」而 contentHash 说「不一致」，且**两边都不报错**。
 *
 * 规则的每一条豁免都是一次**可审计的「此分岔可接受」决定**，不是随手加的。
 */

const IR_IGNORE_FIELDS = new Set<string>([]);

// ─────────────────────────────────────────────────────────────────────────────
// `origin` (source spans) — staged tightening. ADR 0037 §2.2.1.
//
// ★History: `origin` used to be stripped wholesale (`IR_IGNORE_FIELDS =
//   {'origin'}`) with the stated reason "line/col numbering conventions
//   legitimately differ between engines". That reason is FALSE — both engines
//   are 1-based (Java Lexer.java:69-70, TS frontend/lexer.ts:203-204). The
//   exemption dated back to the very first field-level parity commit and was
//   never a considered decision.
//
// ★What it was hiding (measured 2026-09-12 by emptying the set and re-running):
//   150/223 samples diverge, 1325 field diffs, broken down as:
//     origin.file        736  pure representation: ts=undefined vs java="null"
//     origin.end.col     450  REAL divergence
//     origin.start.col   115  REAL divergence
//     origin.*.line       24  REAL but small
//
// ★Root cause of the col gap (two prior hypotheses were disproven):
//   NOT a fixed offset — deltas are scattered (-8, +3, +4, +8, +11 …).
//   NOT the Canonicalizer — greet.aster canonicalizes byte-identically.
//   It is that TS emits PLACEHOLDER end positions: `end.col` is frequently 1
//   (e.g. Module and Rule nodes in greet.aster) where Java reports the real
//   end column (6 and 9). TS is not using a different convention — it is not
//   computing the end position at all.
//
// ★Why stage it instead of keeping the blanket strip: "wait until everything
//   aligns, then enable" leaves the field unguarded indefinitely — the failure
//   mode this repo keeps hitting (a gate that cannot go red). Each stage we
//   tighten is one more thing the gate actually holds.
//
//   stage 'file+line' (current): normalize file (undefined == "null"), COMPARE
//                                line, still tolerate col.
//   stage 'strict'   (target):   compare everything, once TS computes real end
//                                positions (ADR 0037 step 3).
//
// Override for experiments: ASTER_originMode=strict|file+line|off
// ★原先在 parity 脚本里直接读 process.env。抽成共享库后改为**参数注入**：
//   库代码不该依赖调用方的进程环境，否则同一份输入在不同进程下产出不同结果，
//   而 contentHash 正是建立在「同输入同输出」之上的。
//   parity 脚本仍从 env 读，然后作为参数传进来——行为不变，来源变显式。
const DEFAULT_ORIGIN_MODE = 'file+line';

/**
 * Normalize one `origin` object according to originMode.
 * Returns undefined when origin should be dropped entirely.
 */
function normalizeOrigin(origin: any, originMode: string = DEFAULT_ORIGIN_MODE): any {
  if (originMode === 'off') return undefined;
  if (origin === null || typeof origin !== 'object') return origin;
  const out: Record<string, any> = {};
  // file: TS omits it, Java emits the string "null". Same information ("no file
  // attached") in two representations — fold to a single canonical absence.
  const file = origin.file;
  out.file = file === undefined || file === null || file === 'null' ? null : file;
  for (const endpoint of ['start', 'end']) {
    const p = origin[endpoint];
    if (p === null || typeof p !== 'object') continue;
    const norm: Record<string, any> = { line: p.line };
    // col is compared only in strict mode — TS placeholder end positions make it
    // noisy today. Dropping it here keeps `line` genuinely guarded meanwhile.
    if (originMode === 'strict') norm.col = p.col;
    out[endpoint] = norm;
  }
  return out;
}

// Type-inference + per-engine metadata layer. The two engines run DIFFERENT type
// inference (TS leaves unannotated params/returns as TypeVar 'Unknown'/omitted;
// Java eagerly infers a concrete TypeName), and each emits its own metadata
// (piiCategories/piiLevel, typeParams seeding, retTypeInferred). None of this is
// source-level structure — it's derived analysis state that legitimately differs
// — so it is out of scope for STRUCTURAL IR parity (ADR 0016 §B/§C). Stripped on
// both sides so the comparison focuses on the executable tree (decls, params by
// name, statements, expressions). Declared (non-inferred) types survive because
// they live on nodes the parser emits directly, not via these inference fields.
const IR_INFERENCE_FIELDS = new Set<string>([
  'type', 'ret', 'retType', 'typeParams', 'typeInferred', 'retTypeInferred',
  'constraints', 'piiCategories', 'piiLevel',
  // Effect capabilities: the two engines run different capability *inference*
  // (TS seeds effectCaps from the stdlib namespace of each call; Java derives
  // them later/elsewhere), so effectCaps is derived analysis state like the
  // type layer — out of scope for structural IR parity. The DECLARED effects
  // (`It performs …`) are compared separately (see effects normalization).
  'effectCaps', 'effectCapsExplicit',
  // Lambda closure captures: derived analysis (TS captures the whole enclosing
  // env, Java only the referenced subset) — a closure-implementation detail, not
  // source structure. Both engines execute closures identically (eval-parity);
  // the capture LIST is not a source-level artifact, so it's out of scope.
  'captures',
]);

// Known, accepted leaf-field renamings: same `kind`, semantically identical
// payload, different field name on each side. Normalize the TS name → Java name.
// Every entry here is an auditable "this divergence is acceptable" decision.
// key: `<kind>.<tsField>`  value: `<javaField>`
const IR_FIELD_ALIASES: Record<string, string> = {
  'Import.name': 'path',
  'Import.asName': 'alias',
};

/**
 * Recursively normalize a Core IR node so the two engines' trees become
 * field-comparable: drop ignored fields, apply the alias table, treat a missing
 * field as an empty array/false default, and sort order-insensitive collections.
 */
function normalizeIr(node: any, kind?: string, originMode: string = DEFAULT_ORIGIN_MODE): any {
  if (Array.isArray(node)) return node.map((n) => normalizeIr(n, kind, originMode));
  if (node === null || typeof node !== 'object') return node;

  const k = typeof node.kind === 'string' ? node.kind : kind;
  const out: Record<string, any> = {};
  for (const [key, val] of Object.entries(node)) {
    if (IR_IGNORE_FIELDS.has(key)) continue;
    if (IR_INFERENCE_FIELDS.has(key)) continue; // derived analysis state — out of scope
    if (key === 'origin') {
      const norm = normalizeOrigin(val, originMode);
      if (norm !== undefined) out.origin = norm;
      continue;
    }
    const aliased = IR_FIELD_ALIASES[`${k}.${key}`] || key;
    out[aliased] = normalizeIr(val, k, originMode);
  }
  // Declared effects: TS calls the field `declaredEffects` and preserves the
  // source casing (`IO`); Java calls it `effects` and lowercases (`io`). Same
  // source-level data (`It performs …`) — fold both to a sorted lowercase set
  // under `effects` so the declared-effect surface IS compared (unlike the
  // inferred effectCaps, which are dropped above).
  if (out.declaredEffects !== undefined) { out.effects = out.declaredEffects; delete out.declaredEffects; }
  if (Array.isArray(out.effects)) {
    out.effects = [...out.effects].map((e) => String(e).toLowerCase()).sort();
  }
  // "missing == empty" for optional annotation arrays the two engines disagree
  // on emitting (TS omits empty arrays to preserve golden baselines; Java emits
  // []). Only injected on node kinds known to carry the field.
  for (const f of ['annotations', 'retAnnotations', 'effects']) {
    if (out[f] === undefined && nodeMayHave(k, out, f)) out[f] = [];
  }
  // Import version: TS omits an unset version; Java emits `null`. Same "no
  // version pin" meaning — fold both to null.
  if (k === 'Import' && out.version === undefined) out.version = null;
  // Annotation params: an argument-less annotation (`@entry`) carries no params
  // in TS; Java attaches an all-empty params container
  // `{annotations:[],retAnnotations:[],effects:[]}`. Treat such an empty
  // container as "no params" so both sides match.
  if (out.params && typeof out.params === 'object' && !Array.isArray(out.params)
      && Object.values(out.params).every((v) => Array.isArray(v) && v.length === 0)) {
    delete out.params;
  }
  // Ok/Err/Some/None constructor call-form: TS lowers `Ok(x)` to
  // `Call{target:Name "Ok", args:[x]}` (the call form is not given a dedicated
  // node by the TS front-end — only the `ok of x` keyword form is); Java lowers
  // both forms to a dedicated `{kind:"Ok", expr:x}`. Canonicalize the TS Call
  // shape to the dedicated-node shape so they compare equal.
  if (k === 'Call' && out.target && out.target.kind === 'Name'
      && ['Ok', 'Err', 'Some', 'None'].includes(out.target.name)) {
    const ctor = out.target.name;
    if (ctor === 'None') return { kind: 'None' };
    if (Array.isArray(out.args) && out.args.length === 1) {
      return { kind: ctor, expr: out.args[0] };
    }
  }
  // Ctor-pattern bind names: TS `PatCtor` lists them as `names: ["id","name"]`;
  // Java lists them as `args: [{kind:PatName, name:"id"}, …]`. Same ordered bind
  // names, different shape — canonicalize both to `binds: ["id","name"]`.
  if (k === 'PatCtor') {
    const binds = out.names
      ? out.names
      : Array.isArray(out.args)
        ? out.args.map((a) => (a && a.name !== undefined ? a.name : a))
        : [];
    delete out.names;
    delete out.args;
    out.binds = binds;
  }
  // 0-arg enum-variant pattern: `When InvalidCreds` → TS lowers to
  // `PatName{name:"InvalidCreds"}` (a Capitalized name-pattern = variant match),
  // Java to `PatCtor{typeName:"InvalidCreds", binds:[]}`. Same "match this enum
  // variant by name, bind nothing" meaning — canonicalize a Capitalized PatName
  // and a no-bind PatCtor to a single `PatVariant{variant}` form.
  if (k === 'PatName' && typeof out.name === 'string' && /^[A-Z]/.test(out.name)) {
    return { kind: 'PatVariant', variant: out.name };
  }
  if (k === 'PatCtor' && Array.isArray(out.binds) && out.binds.length === 0 && out.typeName) {
    return { kind: 'PatVariant', variant: out.typeName };
  }
  return out;
}

// Conservative: only inject an empty default for a list field on nodes known to
// carry it, so we don't invent fields on unrelated nodes. Field/param nodes have
// no `kind` discriminator (they're `{name, type}` records), so detect them by
// shape: a named record that isn't a top-level decl can carry `annotations`.
function nodeMayHave(kind: string | undefined, out: any, field: string): boolean {
  if (kind === 'Func') return ['annotations', 'retAnnotations', 'effects'].includes(field);
  if (field === 'annotations' && out.name !== undefined && out.kind === undefined) return true;
  return false;
}

export { normalizeIr, normalizeOrigin, nodeMayHave, DEFAULT_ORIGIN_MODE,
         IR_IGNORE_FIELDS, IR_INFERENCE_FIELDS, IR_FIELD_ALIASES };
