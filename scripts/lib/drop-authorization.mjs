/**
 * `--allow-drop` / `--drop-reason` 的参数解析与最终退出码合并。
 *
 * ★抽成纯函数**是为了可测**：这两段逻辑原本内联在 gen-cases.mjs 里，
 * 而 gen-cases 要真跑两个引擎（分钟级），没法为它写快测。
 * 后果是真实发生过的回归抓不到——上一轮就出过「护栏正确打印拒绝、
 * 进程却 exit 0」（末行 `process.exit(problems>0?1:0)` 覆盖了 `exitCode=1`），
 * CI 因此把「拒绝写入」读成成功。
 */

/** 解析失败时的结构化结果（调用方据此打印并 exit 2）。 */
export const DROP_ARG_ERRORS = {
  MISSING_SAMPLES:
    '错误：--allow-drop 必须指定样本名，如 --allow-drop=test_eligibility。\n' +
    '  不接受无参形式——全局放行会让本该被拦下的误覆盖一并通过。\n' +
    '  注意必须用等号：空格分隔（--allow-drop test_eligibility）不被识别，\n' +
    '  会按「未指定样本」拒绝，而不会静默放行。',
  MISSING_REASON:
    '错误：--allow-drop 必须同时给出 --drop-reason="为何这些 golden 该弃"。\n' +
    '  理由会打进日志，供日后审计。',
};

/**
 * 解析 drop 授权参数。
 *
 * @returns `{ok:true, samples:Set<string>, reason:string}`
 *        | `{ok:false, error:keyof DROP_ARG_ERRORS}`
 *
 * ★`--allow-drop` 必须**精确匹配**：用 `startsWith('--allow-drop')` 会把
 * `--allow-dropfoo=alpha` 当成合法授权（Codex 复审抓出）。
 */
export function parseDropArgs(args) {
  const dropArg = args.find(
    (a) => a === '--allow-drop' || a.startsWith('--allow-drop='),
  );
  if (!dropArg) return { ok: true, samples: new Set(), reason: '' };

  const samples = new Set(
    (dropArg.includes('=') ? dropArg.slice(dropArg.indexOf('=') + 1) : '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );
  if (samples.size === 0) return { ok: false, error: 'MISSING_SAMPLES' };

  const reasonArg = args.find((a) => a.startsWith('--drop-reason='));
  const reason = reasonArg ? reasonArg.slice('--drop-reason='.length).trim() : '';
  if (!reason) return { ok: false, error: 'MISSING_REASON' };

  return { ok: true, samples, reason };
}

/**
 * 合并最终退出码。
 *
 * ★不能写成 `process.exit(problems > 0 ? 1 : 0)`：那会**覆盖**护栏中途设的
 * `exitCode = 1`，让「拒绝写入」在 CI 里被读成成功。已设的失败码优先。
 *
 * @param currentExitCode `process.exitCode`（可能是 undefined / 0 / 非 0）
 * @param problemCount    双引擎不一致的 case 数
 */
export function finalExitCode(currentExitCode, problemCount) {
  if (currentExitCode !== undefined && currentExitCode !== 0) return currentExitCode;
  return problemCount > 0 ? 1 : 0;
}
