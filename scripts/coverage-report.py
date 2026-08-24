#!/usr/bin/env python3
"""等价性语料的**执行覆盖**报告。

背景（aster-lang-test#97）：语料里「有 .aster 文件」「有 cases 文件」都不等于
「规则被执行过」。cases 文件的 schema 是**一文件一 entry**，而一个 policy 常常
定义十几条规则——只有从该 entry 可达的规则才会真正跑起来。

★这不是理论问题：`stdlib_decimal.aster` 定义了 12 条规则专门覆盖 Decimal 的
不同语义（精确加法、整数提升、标度增长……），而唯一的 entry `compute` 把算术
**内联**在自己体内、不调用任何其它规则——那 11 条从未在任一引擎上执行过。
等价性语料本该是发现双引擎分叉的第一道网，这些格子却是空的。

★2026-08-25 订正：本脚本最初把「不可达」当成单一数字上报，导致连续四个批次
汇报的基线虚高。不可达的规则实际有**三种性质完全不同**的成因，混在一起报
等于把「不该做的事」和「该做的事」加在同一个分子里：

  1. eval-exempt —— meta.json 标了 `evalExempt`（effects / interop / io / pii …）。
     这些样本的存在是为测**编译期**语义，本就不该求值。仓里 `tag-eval-exempt.mjs`
     一直在维护该标记（并会清除陈旧标记），`parity-tier1.mjs` 也读它；
     只有本脚本从不读，是本脚本的缺陷。
  2. stub —— 规则体**全部**是 `Return 0.` 的占位样本（如 test_life 的 36 条）。
     它们是**只测语法**的 fixture：规则签名覆盖 `given` / `produce` / `Define … has`
     的文法，body 从来不打算跑。给它们补 cases 会把 `0` 固化成 36 条规则的
     "正确答案"——那是在制造假基线，不是提升覆盖率。
     ★判据用「所有缩进行都是 `Return 0.`」而非「存在 `Return 0.`」，
     后者会把正常规则里合法的 `Return 0.` 分支误判成占位。
  3. real —— 有真实逻辑、却从 entry 不可达。**只有这一类是待补的缺口。**

用法：
    python3 scripts/coverage-report.py [--tier tier1-equivalence] [--json]

输出每个 policy 的「规则总数 / 可达数 / 不可达清单」，以及按上述三类拆分的统计。
"""
import argparse
import glob
import json
import os
import re
import sys


def rules_of(src: str) -> list[str]:
    return re.findall(r'^Rule\s+(\w+)', src, re.M)


def bodies_of(src: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in re.finditer(r'^Rule\s+(\w+)(.*?)(?=^Rule\s+|\Z)', src, re.M | re.S):
        out[m.group(1)] = m.group(2)
    return out


def exempt_reason_of(meta_path: str) -> str | None:
    """读 meta.json 的 evalExempt 标记。与 parity-tier1.mjs / tag-eval-exempt.mjs 同源。"""
    if not os.path.isfile(meta_path):
        return None
    try:
        with open(meta_path, encoding='utf-8') as fh:
            meta = json.load(fh)
    except Exception:
        return None
    return (meta.get('evalExemptReason') or 'exempt') if meta.get('evalExempt') is True else None


def is_stub(src: str) -> bool:
    """规则体是否**全部**为 `Return 0.`（占位 fixture）。

    ★必须是「全部」而非「存在」：正常规则里 `Return 0.` 是完全合法的分支
    （如 test_eligibility 的兜底），用「存在」判定会把真实样本误标成占位、
    从而把真缺口藏起来——那比虚报更糟。
    """
    bodies = [ln for ln in src.splitlines() if ln[:1] in (' ', '\t') and ln.strip()]
    return bool(bodies) and all(ln.strip() == 'Return 0.' for ln in bodies)


def reachable(entries: set[str], bodies: dict[str, str]) -> set[str]:
    """从 entry 出发的可达闭包：规则体里提到某规则名即视为调用。

    宁可**高估**可达性（把提及当调用），这样报出来的不可达是保守下界——
    报出来的一定真的没被执行，不会虚报。
    """
    seen: set[str] = set()
    stack = [e for e in entries if e in bodies]
    while stack:
        r = stack.pop()
        if r in seen:
            continue
        seen.add(r)
        for other in bodies:
            if other not in seen and re.search(r'\b' + re.escape(other) + r'\b', bodies.get(r, '')):
                stack.append(other)
    return seen


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--tier', default='tier1-equivalence')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    base = os.path.join('corpus', args.tier)
    if not os.path.isdir(base):
        print(f'找不到语料目录: {base}', file=sys.stderr)
        return 2

    report = []
    total_rules = total_dead = no_cases = 0
    # 三类分桶：只有 real 是待补缺口，另两类不该计入分子。
    buckets = {'exempt': 0, 'stub': 0, 'real': 0}
    exempt_by_reason: dict[str, int] = {}
    for path in sorted(glob.glob(f'{base}/policies/*.aster')):
        name = os.path.basename(path)[:-6]
        src = open(path, encoding='utf-8').read()
        rules = rules_of(src)
        total_rules += len(rules)

        entries: set[str] = set()
        for c in glob.glob(f'{base}/inputs/{name}*.cases.json'):
            try:
                with open(c, encoding='utf-8') as fh:
                    data = json.load(fh)
            except Exception:
                continue
            # ★`{name}*` 是**前缀**匹配：policy `loan` 会吞掉 `loan_fixed.cases.json`,
            #   `lambda_cnl` 会吞掉 7 个 `lambda_cnl_match_*`——把别人的 entry 当成自己的，
            #   于是本该不可达的规则被算成可达（实测 28 处跨 policy 污染，真缺口被低估 55 条）。
            #   不能改用严格文件名相等：`21-comparison-is-prefix_greater_check.cases.json`
            #   等 56 个文件是**同一 policy 的多 entry 拆分**，自称归属正是本 policy，必须保留。
            #   唯一可靠的判据是每个 cases 文件自带的 `policy` 字段（自证归属）。
            owner = os.path.basename(data.get('policy', '') or '')
            if owner and owner[:-6] != name:
                continue
            entries.update(
                c.get('entry') for c in data.get('cases', []) if isinstance(c, dict) and c.get('entry')
            )
            if data.get('entry'):
                entries.add(data['entry'])

        # 分类只取决于样本自身性质，与「有没有 cases」无关，故先判后分支。
        reason = exempt_reason_of(f'{base}/policies/{name}.meta.json')
        if reason:
            kind = 'exempt'
        elif is_stub(src):
            kind = 'stub'
        else:
            kind = 'real'

        if not entries:
            no_cases += 1
            dead = rules
            why = 'no-cases-file'
        else:
            seen = reachable(entries, bodies_of(src))
            dead = [r for r in rules if r not in seen]
            why = 'unreachable-from-entry'

        if not dead:
            continue
        total_dead += len(dead)
        buckets[kind] += len(dead)
        if kind == 'exempt':
            exempt_by_reason[reason] = exempt_by_reason.get(reason, 0) + len(dead)
        report.append({'policy': name, 'rules': len(rules),
                       'reachable': len(rules) - len(dead),
                       'unreachable': dead, 'reason': why, 'kind': kind})

    if args.json:
        json.dump({'total_rules': total_rules, 'unreachable': total_dead,
                   'gap': buckets['real'], 'buckets': buckets,
                   'exempt_by_reason': exempt_by_reason,
                   'policies_without_cases': no_cases, 'detail': report},
                  sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0

    gap = buckets['real']
    pct = gap * 100 // total_rules if total_rules else 0
    print(f'语料: {args.tier}')
    print(f'规则总数: {total_rules}')
    print(f'从 entry 不可达: {total_dead}，拆分如下——')
    reasons = ', '.join(f'{k} {v}' for k, v in sorted(exempt_by_reason.items(), key=lambda x: -x[1]))
    print(f'  · eval-exempt（设计上不求值）: {buckets["exempt"]}  [{reasons}]')
    print(f'  · stub（规则体全是 Return 0. 的语法 fixture）: {buckets["stub"]}')
    print(f'  ★ 真实缺口（有逻辑却没跑过）: {gap}  ({pct}% of 全部规则)')
    print(f'完全没有 cases 文件的 policy: {no_cases}')
    print()
    print('真实缺口明细：')
    real_rows = [r for r in report if r['kind'] == 'real']
    for row in sorted(real_rows, key=lambda r: -len(r['unreachable']))[:20]:
        head = ', '.join(row['unreachable'][:4])
        more = f' …共 {len(row["unreachable"])} 条' if len(row['unreachable']) > 4 else ''
        print(f'  {row["policy"]}: {row["reachable"]}/{row["rules"]} 可达 | 未执行: {head}{more}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
