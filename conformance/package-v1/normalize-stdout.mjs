/**
 * 跨 CLI stdout 归一（ADR 0059 修订 1 A0）：比较两个 CLI 的 `run` / `verify` / `inspect` stdout 之前，
 * 把**顶层成员 `meta`** 的直接成员 `engine`、`cliVersion` 的字符串值分别替换为字面量 `"<ENGINE>"`、`"<CLI_VERSION>"`，
 * 其余字节一律不动。
 *
 * 规则（JVM 侧 `StdoutNormalizer.java` 按同一规则另实现，跑同一组 vectors/stdout-normalize.json）：
 *   1. 去掉末尾至多一个 `\n` 后，若文本不是一个合法 JSON 对象，原样返回；
 *   2. 只看顶层对象的成员 `meta`；它不是对象则原样返回；
 *   3. 在 `meta` 的直接成员里，键为 `engine` / `cliVersion` 且值为 JSON 字符串的，把该字符串字面量（含引号、
 *      含其中的转义序列）整体替换为占位符；值不是字符串的不动；嵌套更深处（如 `value` 里的 `meta`）不动；
 *   4. 不重新序列化：替换只改动这两个值的字节区间，空白、键序、转义写法都保持原样。
 *
 * T4（ts CLI 测试）与 T11（跨 CLI 一致性门）直接 import 本文件。
 */

export const ENGINE_PLACEHOLDER = '"<ENGINE>"';
export const CLI_VERSION_PLACEHOLDER = '"<CLI_VERSION>"';
const PLACEHOLDERS = { engine: ENGINE_PLACEHOLDER, cliVersion: CLI_VERSION_PLACEHOLDER };

/** 最小 JSON 扫描器：只需记录顶层 `meta` 对象直接成员的值区间；任何语法错误抛出。 */
class Scanner {
  constructor(text) {
    this.s = text;
    this.i = 0;
  }

  ws() {
    while (this.i < this.s.length && ' \t\n\r'.includes(this.s[this.i])) this.i++;
  }

  fail() {
    throw new SyntaxError(`非法 JSON（位置 ${this.i}）`);
  }

  /** 解析一个值，返回 { start, end, type, members? }；members 只在 wantMembers 时收集（键 → 值区间列表）。 */
  value(wantMembers = false) {
    this.ws();
    const start = this.i;
    const c = this.s[this.i];
    if (c === '{') return this.object(start, wantMembers);
    if (c === '[') {
      this.i++;
      this.ws();
      if (this.s[this.i] === ']') {
        this.i++;
        return { start, end: this.i, type: 'array' };
      }
      for (;;) {
        this.value();
        this.ws();
        if (this.s[this.i] === ',') { this.i++; continue; }
        if (this.s[this.i] === ']') { this.i++; return { start, end: this.i, type: 'array' }; }
        this.fail();
      }
    }
    if (c === '"') {
      const key = this.string();
      return { start, end: this.i, type: 'string', text: key };
    }
    const m = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(this.s.slice(this.i));
    if (!m) this.fail();
    this.i += m[0].length;
    return { start, end: this.i, type: 'scalar' };
  }

  object(start, wantMembers) {
    this.i++;
    const members = wantMembers ? [] : null;
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return { start, end: this.i, type: 'object', members };
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') this.fail();
      const key = this.string();
      this.ws();
      if (this.s[this.i] !== ':') this.fail();
      this.i++;
      const v = this.value(wantMembers === 'top' && key === 'meta');
      if (members) members.push({ key, value: v });
      this.ws();
      if (this.s[this.i] === ',') { this.i++; continue; }
      if (this.s[this.i] === '}') { this.i++; return { start, end: this.i, type: 'object', members }; }
      this.fail();
    }
  }

  string() {
    const m = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(this.s.slice(this.i));
    if (!m) this.fail();
    this.i += m[0].length;
    return JSON.parse(m[0]);
  }
}

/** 归一一段 CLI stdout（见文件头规则）。 */
export function normalizeStdout(stdout) {
  const body = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  let top;
  try {
    const sc = new Scanner(body);
    top = sc.value('top');
    sc.ws();
    if (sc.i !== body.length) return stdout;
  } catch {
    return stdout;
  }
  if (top.type !== 'object') return stdout;
  const spans = [];
  for (const { key, value } of top.members) {
    if (key !== 'meta' || value.type !== 'object') continue;
    for (const m of value.members) {
      if (Object.hasOwn(PLACEHOLDERS, m.key) && m.value.type === 'string') spans.push([m.value.start, m.value.end, PLACEHOLDERS[m.key]]);
    }
  }
  if (spans.length === 0) return stdout;
  let out = '';
  let at = 0;
  for (const [s, e, rep] of spans.sort((a, b) => a[0] - b[0])) {
    out += body.slice(at, s) + rep;
    at = e;
  }
  return out + body.slice(at) + stdout.slice(body.length);
}
