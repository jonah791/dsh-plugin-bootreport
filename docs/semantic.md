# dsh-plugin-bootreport · 语义文档 v0.2

| 元信息 | 值 |
|---|---|
| 能力 | 启动自报账本（生态级构建生效判据）+ 第三方插件盘点（§5.23） |
| 主副本 | `self-plugins/dsh-plugin-bootreport/docs/semantic.md` |
| 实现落点 | `src/ledger.ts`（纯逻辑+薄 IO）· `src/third-party.ts`（第三方档：纯判定 + 薄 IO）· `src/index.ts`（cordis 胶水）· `tests/ledger.test.mjs` · `tests/third-party.test.mjs` |
| 版本 | 0.1.1（2026-09-14） |
| 状态 | implemented（测试 **19/19**；线上验收 A3/A4/A5 已证，A7/A8 见 §7） |

## 1 · 定位与反定位

- **定位**：把「这台进程到底加载了哪些插件构建」落成一行可查账——一条命令回答全生态的「线上跑的是哪个构建 / 谁需要重启」。
- **反定位**：
  - 不是插件管理器（不挂载/不启停/不改组合）——它只**观察并记账**。
  - 不是 loader 状态的复述——判据来自**文件系统 mtime + 进程起点**，不 inject `loader`（零耦合）。
  - 不是性能/健康监控——只回答构建生效这一个问题。

## 2 · 术语表

| 术语 | 含义 |
|---|---|
| 启动账（boot line） | 一次 web 启动写一行 JSONL：`{atMs, processStartMs, pid, live[], stale[], plugins[]}` |
| 进程起点 `processStartMs` | `Date.now() - process.uptime()*1000` 反推的真实进程启动时刻（不是 apply 时刻） |
| live | `lib 产物 mtime ≤ 进程起点 + 容差` ⇒ 该构建正被运行 |
| stale | `lib 产物 mtime > 进程起点 + 容差` ⇒ 构建晚于启动，进程跑的是旧码（重启才生效） |
| 容差 `toleranceMs` | 缺省 1000ms（文件系统 mtime 精度与启动抖动） |
| **第三方档（§5.23）** | self-plugins 之外的插件：来自各 profile `package.json` 的 dependencies，四形态 `third-party-git`（git pin）/`third-party-tarball`/`third-party-registry`/`third-party-local`；`self-link`/`official`/`local-link` 不算 |
| `bundle` | 该 profile 的 `dsh.profile.bundles` 是否含它 ⇒ **自述式挂载**（包自带 `dsh.bundle.patch`，不由我写 patch 行） |
| `activatedAtBoot` | 第三方**专用**的生效判据：`node_modules/<name>/package.json` 的 mtime ≤ 进程起点 + 容差 ⇒ 本次启动的组合已包含它（第三方没有「我构建的产物」，故不能用 lib-mtime 判据） |

## 3 · 概念模型 + 不变量

```
web 进程启动 ──┬─> 本插件 apply ─> scanBuilds(self-plugins/*/lib/*.js) ─> 取各插件最大 mtime
              │                                                    │
              └─> processStartMs（uptime 反推）─────────────> classify() ─> live / stale
                                                                    │
                                              appendBootLine(<DSH_HOME>/plugin-boot.jsonl)
```

不变量：
- **I1** 判据只用「构建时刻 vs 进程起点」，不依赖任何运行时注册表（可离线复算）。
- **I2** `live ∪ stale = plugins` 且互斥（无第三态）。
- **I3** 账本行**有界**：行数 ≤ `keepLines + 50`。
- **I4** 任何落盘失败都不得抛（观测绝不反噬主流程）。

## 4 · 契约

| 契约 | 值 |
|---|---|
| 文件 | `<DSH_HOME>/plugin-boot.jsonl`（append-only，尾行为最近一次启动） |
| 行结构 | `{"atMs":number,"processStartMs":number,"pid":number,"live":string[],"stale":string[],"plugins":[{"name":string,"version":string,"libMtimeMs":number}],"thirdParty":[{"name","version","spec","source","profile","bundle","installedMtimeMs","activatedAtBoot"}]}`（`thirdParty` 为 0.1.1 新增，老行缺该字段解析不报错） |
| 工具 | `plugin_boot_status` → `{ok,ledger,atMs,processStartMs,pid,total,live,stale,liveNow,staleNow,thirdPartyTotal,thirdParty[],thirdPartyPending[]}`（schema `additionalProperties:false`；第三方以「一行摘要字符串」暴露，结构化明细在账本行里） |
| 配置 | `enabled`（缺省 true）· `keepLines`（缺省 200） |
| 扫描根 | `buildRoots(home, cwd)` = `[DSH_HOME/../self-plugins, cwd/self-plugins, DSH_HOME/self-plugins]` |

**调用点清单**（契约的每个触点）：
- 写入：`apply()` → `currentBootLine()` → `appendBootLine()`（每次 web 启动一次）
- 读取：`plugin_boot_status` 工具 → `readLastBoot()`；外部 `scripts/plugin-maintainability-audit.py --live`
- 判据复算：`classify()`（离线可用，与写入同源）

## 5 · 边界与信任

- 边界：只读本地文件系统；不写任何插件目录；不联网；不持凭据。第三方档读的是 profile `package.json` 与 `node_modules` 元数据，**依赖声明落盘前经 `redactSpec` 脱敏**（URL userinfo / token 类参数擦除，`spec` 是升级回退的唯一指纹故保留 git pin）。
- 信任：账本是**观测证据**，不是控制面——坏账本不影响任何业务路径（I4）。
- 已知盲区：自研侧只统计**有 `lib/*.js` 的目录**（纯源码插件/官方 bundle 不算）；watch profile 需另行挂载才记账；**官方 bundle（`@deepseek-ai/*`）当前不进第三方清单**（它们有目录数据，见 plugin-manager 的官方档）。

## 6 · 与既有机制的关系

- `dsh-agent-plugin-manager`：它管组合与档案（挂载/启停/预检），本插件只管**生效判据**——「管理」与「自证」分离。
- §5.11 规则 6「重建 ≠ 生效」：本插件是该规则在**生态层**的常设仪器（此前只有 web 侧 `hasUnverifiedBuilds()` 兜底，watch 侧无机制）。
- 技能 `plugin-maintainability`：本插件是准则 **C1（机制必须自证）** 在生态平面的落地——**一个观察者统一落账**，而不是 49 份各自实现。

## 7 · 可证伪验收清单

| id | 断言 | 判据 | 状态 |
|---|---|---|---|
| A1 | 纯逻辑不变量 I1–I3 成立 | `node --test tests/ledger.test.mjs`（10 条） | 已证（10/10） |
| A2 | 落盘失败不抛（I4） | 测试「不可写路径返回 false 且不抛」 | 已证 |
| A3 | 每次 web 启动恰好多一行账 | 挂载重启后 `wc -l` 2 行 → 3 行；尾行 `pid=7080 / processStartMs=1789351547742`（= 10:05:47 那次启动） | 已证（2026-09-14 线上） |
| A4 | 判据能抓到「构建晚于启动」 | 证伪测试：`touch` 一个插件 lib → `--live` 报「需重启才生效：dsh-plugin-bootreport(1789351603272)」；复原 mtime → 报「全生态正跑最新构建」 | 已证（两态均实测） |
| A5 | 工具输出通过 schema | 线上调用 `plugin_boot_status` → `进程启动 1789351547742｜live 50｜stale 0`，无 schema 报错 | 已证 |
| A6 | 生态级效果 | 审计器 S5 缺口 **48 → 0**，全生态通过率 19% → 32%（代价 = 一个插件） | 已证（记分卡 + `--live`） |
| A7 | 第三方四形态全部可盘点（git pin / tarball / registry / file），自研与官方不混入 | `node --test tests/third-party.test.mjs`（8 条，含夹具：git-pin 带 bundle、registry 未安装） | 已证（单测；线上见 A8） |
| A8 | 线上工具面能答「装了哪些第三方、哪些没随本次启动组合」 | `plugin_boot_status` → `thirdPartyTotal≥1`、`thirdParty` 含 `dsh-x-opencode-session@0.1.0 [third-party-git] bundle=true activatedAtBoot=true`；`thirdPartyPending` 为空 | **待线上验收**（重启后实测；判据 = 该条目出现且 `activatedAtBoot=true`） |

## 8 · 与实现的关系

- `src/ledger.ts`：`resolveHome` / `bootLedgerPath` / `processStartMs` / `buildRoots` / `scanBuilds` / `classify` / `serializeBootLine` / `parseBootLines` / `appendBootLine` / `readLastBoot` / `currentBootLine`（纯函数 + 薄 IO，无 cordis 依赖）。
- `src/index.ts`：`Config` + `apply()`（写账 + stale 告警 + 注册工具）。工具 schema 严格 `additionalProperties:false`，返回字段与 schema 一一对应。

## 9 · 实践修订记录

- 2026-09-14 立项：审计 49 个自研插件，「不知线上跑哪个构建」命中 **48/49** ⇒ 判定为生态级共性缺陷，拒绝逐个手改，改为统一账本（主人指令「其他插件的可维护性提升」）。
- 2026-09-14 实现期修正：① 初版把纯逻辑写在 `index.ts` → 测试会拉 cordis 依赖树，拆出 `ledger.ts`（技能 C6）；② 初版在 ESM 里用 `require('node:fs')` → 改为顶层 import；③ 裁剪断言从「恰好 keepLines」改为**有界不变量** `≤ keepLines+50`（原断言写错了机制语义）。
- 2026-09-14 上线实测（A3–A6 全证）：挂载后守护 full 预检 PASS → 10:05:47 重启；账本 +1 行、工具可答、S5 缺口清零。**A4 用证伪测试验真**（touch 一个 lib → 报警响；复原 → 消失），符合「防线必须带尸体测试」。
- 2026-09-14 已知副作用（重要）：**预检 trialRun 也会落账**（试运行是真实组合）——账本 3 行中有 1 行来自试运行进程。当前实现按「尾行=最近启动」读，恰好正确（真启动晚于试运行）；但若试运行发生在启动**之后**（如一次失败的重启尝试），尾行会是短命进程 ⇒ 读取方应校验 `pid` 存活（见 §10）。
- 2026-09-14 §5.23 补档（0.1.1）：主人装了一个第三方插件（`dsh-x-opencode-session`，git pin + bundle 形态），实测**管理面完全看不见它**——本插件只扫 `self-plugins`。新增 `src/third-party.ts` + `tests/third-party.test.mjs`（8 条）：四形态判定、`redactSpec` 脱敏、`activatedAtBoot` 推导（装得早于进程起点）、缺目录/坏 manifest/未安装不抛。**本插件的 §10 早已把「第三方是否纳入统计」列为未决问题——这次是它被现实兑现**。修复方式为「新增一档而非改动 live/stale 判据」：第三方没有「我构建的产物」，硬套 lib-mtime 会得到假结论。

## 10 · 未决问题

- **读取方要过滤死 pid**：账本尾行可能来自 trialRun 短命进程；应加 `process.kill(pid,0)` 存活校验（跨平台可取）后再取该行。
- 是否把账本扩展到 watch/headless profile（各自挂载一份，或统一写到同一账本并按 profile 分行）？——rulebook 记录的「watch 侧无生效机制」缺口正指这里。
- ~~第三方/官方 bundle 是否纳入统计（当前只扫自研构建）？~~ → **2026-09-14 已答**：第三方纳入（`thirdParty` 档，四形态 + `activatedAtBoot`）；官方 bundle 仍不入（它有目录数据，归 plugin-manager 的官方档）。
- 是否在 stale / 第三方未组合时**主动**提示主人（telegram）——还是只留日志与工具查询？（泄漏风险：告警噪音）
- 第三方要不要记 **pnpm-lock 的 integrity/tarball**（比 mtime 更强的「装的是哪份产物」指纹）？——当前只记 `spec`（含 pin）+ 安装 mtime，够判「是否本次启动已组合」，不够判「字节是否被换过」。
