/**
 * 参照复算用的 ts 求值（aster-lang-test#254）：与 Node CLI 相同的条件——在 `resourceLimits.stackSizeMb = 32` 的 Worker 里、
 * 以 `maxCallDepth = CLI_MAX_CALL_DEPTH`（10 000）求值（ADR 0059 修订 1 A4、ADR 0063）。此前生成器在主线程以解释器缺省
 * 深度（50）求值，复算不了深递归的成功用例。
 *
 * 生成器的调用方都是同步的，所以这里用一个常驻 Worker 做同步往返：主线程 postMessage 后在共享标志上 Atomics.wait，
 * Worker 求值完把结果发到专用 MessagePort 并置位、notify，主线程再用 receiveMessageOnPort 取回。Worker 只加载一次 ts。
 */
import { MessageChannel, Worker, isMainThread, parentPort, receiveMessageOnPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseValueTree, valueJson } from './value-json.mjs';

/** 与 aster-lang-ts policy-package/cli.ts 的 WORKER_STACK_SIZE_MB 相同。 */
const WORKER_STACK_SIZE_MB = 32;
/** 单次求值的等待上限：Worker 卡死或崩溃时报错，而不是让生成器永远挂起。 */
const WAIT_MS = 120_000;

/**
 * 启动常驻求值 Worker，返回同步求值函数 `(coreJson, entry, input, maxSteps) → {ok:true,value}|{ok:false,error}`。
 * input 为 validateInput 的结果（结构化克隆传给 Worker）；value 为值规范 JSON 文本。
 */
export function createTsEvaluator(tsDir) {
  const { port1, port2 } = new MessageChannel();
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { tsEvalWorker: true, tsDir, port: port2, flag },
    transferList: [port2],
    resourceLimits: { stackSizeMb: WORKER_STACK_SIZE_MB },
  });
  worker.unref();
  return (coreJson, entry, input, maxSteps) => {
    Atomics.store(flag, 0, 0);
    worker.postMessage({ coreJson, entry, input, maxSteps });
    if (Atomics.wait(flag, 0, 0, WAIT_MS) === 'timed-out') throw new Error(`ts 求值 Worker ${WAIT_MS} ms 内无响应（${entry}）`);
    const reply = receiveMessageOnPort(port1)?.message;
    if (!reply) throw new Error(`ts 求值 Worker 未返回结果（${entry}）`);
    if (reply.crash) throw new Error(`ts 求值 Worker 出错：${reply.crash}`);
    return reply.result;
  };
}

/**
 * 包格式输入 → ts 解释器的上下文（T3 parseInput 的职责，这里只为复算期望值）：Decimal 字符串 → decimal.js 实例；
 * Long → BigInt；Int / Double → number；List / Map / Data 递归；Maybe：null → None，否则内层值（解释器接受这两种宿主形态）；
 * Enum：变体名字符串。输入可以来自 JSON.parse（number）或 parseValueTree（BigInt）。
 */
function tsContext(ts, input, func, ir) {
  const datas = new Map(ir.decls.filter((d) => d.kind === 'Data').map((d) => [d.name, d]));
  const conv = (v, type) => {
    switch (type.kind) {
      case 'List': return v.map((x) => conv(x, type.type));
      case 'Map': return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x, type.val)]));
      case 'Maybe':
      case 'Option': return v === null ? null : conv(v, type.type);
      default: break;
    }
    if (type.name === 'Decimal') return new ts.Decimal(String(v));
    if (type.name === 'Long') return BigInt(v);
    if (type.name === 'Int' || type.name === 'Double') return Number(v);
    const data = datas.get(type.name);
    if (data) return Object.fromEntries(data.fields.map((f) => [f.name, conv(v[f.name], f.type)]));
    return v;
  };
  return Object.fromEntries(func.params.map((p) => [p.name, conv(input[p.name], p.type)]));
}

/** ts 求值结果 → 值规范 JSON（Enum 删去 ts 多出的 "__type":"?"，VALUE-FORMS.md）。 */
function tsValueJson(ts, value) {
  const drop = (v) => {
    if (Array.isArray(v)) return v.map(drop);
    if (v !== null && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) if (!(k === '__type' && x === '?')) o[k] = drop(x);
      return o;
    }
    return v;
  };
  return valueJson(drop(parseValueTree(ts.serializeGuestValue(value))));
}

async function loadInterpreter(tsDir) {
  const at = (p) => import(pathToFileURL(join(tsDir, p)).href);
  const [interp, readIr, limits] = await Promise.all([
    at('dist/src/core/interpreter.js'), at('dist/src/core/read-core-ir.js'), at('dist/src/policy-package/evaluate-package.js'),
  ]);
  const req = createRequire(join(tsDir, 'package.json'));
  // 必须与解释器 import 的是同一个 ESM 模块实例（解释器用 instanceof 判 Decimal）
  const Decimal = await import(pathToFileURL(join(dirname(req.resolve('decimal.js/package.json')), 'decimal.mjs')).href);
  return {
    evaluate: interp.evaluate,
    serializeGuestValue: interp.serializeGuestValue,
    readCoreIr: readIr.readCoreIr,
    maxCallDepth: limits.CLI_MAX_CALL_DEPTH,
    Decimal: Decimal.default ?? Decimal,
  };
}

function evaluateOnce(ts, { coreJson, entry, input, maxSteps }) {
  const ir = JSON.parse(coreJson);
  const func = ir.decls.find((d) => d.kind === 'Func' && d.name === entry);
  try {
    const r = ts.evaluate(ts.readCoreIr(coreJson), entry, tsContext(ts, input, func, ir), { maxSteps, maxCallDepth: ts.maxCallDepth });
    return r.success ? { ok: true, value: tsValueJson(ts, r.value) } : { ok: false, error: r.error };
  } catch (e) {
    // 解释器以异常报告的资源耗尽（含真实栈溢出 RangeError）同样是求值失败
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

if (!isMainThread && workerData?.tsEvalWorker) {
  const { port, flag } = workerData;
  const ts = await loadInterpreter(workerData.tsDir);
  parentPort.on('message', (job) => {
    let reply;
    try {
      reply = { result: evaluateOnce(ts, job) };
    } catch (e) {
      reply = { crash: e instanceof Error ? e.stack ?? e.message : String(e) };
    }
    port.postMessage(reply);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  });
}
