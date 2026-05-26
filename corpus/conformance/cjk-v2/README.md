# Conformance: CJK Punctuation + zh-CN v2 Keywords

Cross-implementation byte-equivalence harness for the Aster v2 Chinese support.

## Goal

For every `.aster` source file in this directory, the canonicalizer **must
produce byte-identical output** across:
- TypeScript: `aster-lang-ts/src/frontend/canonicalizer.ts`
- Java:       `aster-lang-core/src/main/java/aster/core/canonicalizer/Canonicalizer.java`

Any drift between the two implementations is a P0 release blocker.

## What's tested

Each `.aster` file pairs with a `.expected.txt` containing the canonical
form **both** implementations must produce.

Categories:
1. **Pure CJK punctuation** — verify 。 → . / ：→ : / ，→ , / ；→ ; / 、→ ,
2. **String literal preservation** — verify CJK punct inside 「」 is kept verbatim
3. **v2 keywords** — verify all 13 砍掉的 1-char keywords now resolve to multi-char forms
4. **Identifier collision** — verify 或然率 / 真客户 / 是否成年 etc. survive as identifiers
5. **Mixed real-world** — full module from the HIPAA / loan_decision fixtures

## How to run

```bash
# TypeScript side
cd aster-lang-ts && pnpm run test:conformance

# Java side
cd aster-lang-core && ./gradlew conformanceTest
```

## Adding new conformance cases

1. Drop `your-case.aster` here
2. Run one impl, capture output → `your-case.expected.txt`
3. Run the other impl, assert byte equality

If they diverge from day 0, you've found a bug in one implementation.
