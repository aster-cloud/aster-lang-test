#!/usr/bin/env python3
"""等价性语料的**执行覆盖**报告。

背景（aster-lang-test#97）：语料里「有 .aster 文件」「有 cases 文件」都不等于
「规则被执行过」。cases 文件的 schema 是**一文件一 entry**，而一个 policy 常常
定义十几条规则——只有从该 entry 可达的规则才会真正跑起来。

★这不是理论问题：`stdlib_decimal.aster` 定义了 12 条规则专门覆盖 Decimal 的
不同语义（精确加法、整数提升、标度增长……），而唯一的 entry `compute` 把算术
**内联**在自己体内、不调用任何其它规则——那 11 条从未在任一引擎上执行过。
等价性语料本该是发现双引擎分叉的第一道网，这些格子却是空的。

用法：
    python3 scripts/coverage-report.py [--tier tier1-equivalence] [--json]

输出每个 policy 的「规则总数 / 可达数 / 不可达清单」，以及总体统计。
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
    for path in sorted(glob.glob(f'{base}/policies/*.aster')):
        name = os.path.basename(path)[:-6]
        src = open(path, encoding='utf-8').read()
        rules = rules_of(src)
        total_rules += len(rules)

        entries: set[str] = set()
        for c in glob.glob(f'{base}/inputs/{name}*.cases.json'):
            try:
                entries.add(json.load(open(c, encoding='utf-8')).get('entry'))
            except Exception:
                pass

        if not entries:
            no_cases += 1
            total_dead += len(rules)
            report.append({'policy': name, 'rules': len(rules), 'reachable': 0,
                           'unreachable': rules, 'reason': 'no-cases-file'})
            continue

        seen = reachable(entries, bodies_of(src))
        dead = [r for r in rules if r not in seen]
        total_dead += len(dead)
        if dead:
            report.append({'policy': name, 'rules': len(rules),
                           'reachable': len(rules) - len(dead),
                           'unreachable': dead, 'reason': 'unreachable-from-entry'})

    if args.json:
        json.dump({'total_rules': total_rules, 'unreachable': total_dead,
                   'policies_without_cases': no_cases, 'detail': report},
                  sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0

    pct = total_dead * 100 // total_rules if total_rules else 0
    print(f'语料: {args.tier}')
    print(f'规则总数: {total_rules}')
    print(f'从 entry 不可达（从未执行）: {total_dead}  ({pct}%)')
    print(f'完全没有 cases 文件的 policy: {no_cases}')
    print()
    for row in sorted(report, key=lambda r: -len(r['unreachable']))[:20]:
        head = ', '.join(row['unreachable'][:4])
        more = f' …共 {len(row["unreachable"])} 条' if len(row['unreachable']) > 4 else ''
        print(f'  {row["policy"]}: {row["reachable"]}/{row["rules"]} 可达 | 未执行: {head}{more}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
