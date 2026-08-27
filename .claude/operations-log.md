
## 2026-08-27 第四轮交叉审查：Codex 用量耗尽 → 降级为注册审查 agent

**降级原因（非自愿）**：`mcp__codex__codex` 首次调用后台运行 120s+，返回的只是工作计划、
未产出评分也未写报告；SESSION_ID 续跑时明确报错 `You've hit your usage limit ... try again at 3:42 PM`。
即第一次的截断是**用量耗尽导致的中途死亡**，不是设计如此。

**降级动作**：依 CLAUDE.md「Codex MCP 不可用 → Claude 自审（记录降级原因）」，
但为避免违反「禁止自审」铁律，改为派发两个**独立注册 agent** 承担审查，我只做裁决：
- `false-green-hunter` —— 对 drop-authorization / golden-overwrite 两个 helper 做变异审计，
  并逐条核对 20 条测试有无「名字承诺 > 断言体」。
- `claim-verifier` —— 核验 3cbacf5 / 899c875 两个提交自述的事实性断言，
  重点查 gen-cases.mjs 是否残留内联死副本。

**补偿计划**：Codex 额度恢复后（约 15:42）补跑第四轮，与 agent 结论比对；
若出现分歧，以能给出可复现证据的一方为准。

**降级期间我自己已完成的客观验证**（供审查者复核，不作为审查结论）：
- 七种重复/乱序 flag 写法实测，全部「收窄或拒绝」，无放宽路径；已固化为 7 条测试。
- 两个放宽方向的变异被抓住：取并集 20→18/2 red；空格分隔也认 20→19/1 red。
- CI 实跑日志确认两个 guard 步骤真实执行（run 33028041008），非 skipped。
- CI 路径过滤经 fnmatch 逐一比对，四个相关文件全部命中。
