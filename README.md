<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 启动自报账本——web 启动时把「本进程加载了哪些插件构建」落一行到 <DSH_HOME>/plugin-boot.jsonl，一条命令判全生态「构建是否生效」（rulebook §5.11 规则 6 的生态级仪器）；含第三方插件档（profile 依赖四形态 + dsh.profile.bundles，§5.23）
  inject: 'tools'
  tools: plugin_boot_status
  runtime: host-only（零 loader 耦合：判据来自文件系统 mtime + 进程起点，不 inject loader）
  envDeps: 无（只读本地文件系统；不联网、不持凭据）
  boundary: 只观察并记账，不是插件管理器；不含控制面（不挂载/不启停/不改组合）
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-plugin-bootreport

<p align="center">
  <a href="https://github.com/jonah791/dsh-plugin-bootreport"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-19%20passed-brightgreen" alt="tests">
</p>

**一句话**：每次 web 启动写一行「本进程加载了哪些插件构建」的账，配一个 `plugin_boot_status` 工具现算「磁盘上的构建 vs 进程起点」——把「构建是否真的生效」从逐个插件的猜测变成一个可查的账本。

**为什么值得用**：「重新构建 ≠ 生效」是 DSH 生态里最难自查的一类故障——产物 mtime 新只证明构建过，不证明进程在跑它；web 侧只有 `hasUnverifiedBuilds()` 兜底，watch/headless 侧完全没有机制（实测：某次修复因进程启动早于产物而静默躺着不生效）。本插件把判据**统一**成一行账：一个观察者记账，而不是 N 个插件各自实现；一次 `tail` 就能回答「线上跑的是哪个构建、谁需要重启」。

## 能力

| 工具 | 用途 |
|------|------|
| `plugin_boot_status` | 读启动自报账本 + **现场复算**：最近一次 web 启动时间（`atMs`/`processStartMs`/`pid`）、启动时快照、以及「现在磁盘上的构建 vs 进程起点」的实时 `live`/`stale` 清单（快照盖不住启动之后的重建）；另答**第三方档**——`thirdPartyTotal` / `thirdParty[]`（一行一条：`name@version [来源档] profile= bundle= activatedAtBoot= spec=<pin>`）/ `thirdPartyPending[]`（装了但没随本次启动组合的） |

装载时（`apply`）本插件自行写一行账，并在 `stale` 非空时打 `logger.warn`（进程在跑旧码，重启才生效）；**第三方未随本次启动组合**时同样告警（第三方没有构建门控，这是它唯一的生效提示，§5.23）。

账本一行 = 一次启动，`plugins[]` 是**自研**构建（走 `lib-mtime vs 进程起点` 判据），`thirdParty[]` 是**第三方**（走「装得早于进程起点」判据 + `bundle` 标记）——两档判据不同，因为第三方的产物不是我在本机构建的。

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-plugin-bootreport": "link:<工作区>/self-plugins/dsh-plugin-bootreport"
```

**2) 挂组合**（agent 预设行）：

```yaml
- insert:
    - id: agent-plugin-bootreport
      name: dsh-plugin-bootreport
      config:
        enabled: true
        keepLines: 200
```

**3) 30 秒验证**：重启（或挂载触发的哨兵重启）后执行

```bash
tail -1 "$DSH_HOME/plugin-boot.jsonl"
```

期望：一行 JSON，`pid` 为当前 web 进程，`live` + `stale` 覆盖全部有 `lib/*.js` 的自研插件；再调 `plugin_boot_status`，其 `stale` 应为空数组（否则就是「有构建没生效」的清单）。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `enabled` | `true` | 关掉后不写账（工具仍可读历史账） |
| `keepLines` | `200` | 账本保留行数（裁到有界，见不变量 I3） |

扫描根 `buildRoots(home, cwd)` = `[<DSH_HOME>/../self-plugins, <cwd>/self-plugins, <DSH_HOME>/self-plugins]`——与 `dsh-agent-plugin-manager` 同源约定（`DSH_HOME` 的上一级即工作区）。

## 落盘与自证（出问题时先看这里）

**唯一持久产物**：`<DSH_HOME>/plugin-boot.jsonl`（append-only，`DSH_HOME` 缺省 `~/.dsh`）。**一行 = 一次 web 启动**，无 `phase` 字段——写入点只有一处（`apply()` → `currentBootLine()` → `appendBootLine()`），读取点有两处（`plugin_boot_status` 工具、外部审计脚本 `--live`）。

| 字段 | 含义 |
|------|------|
| `atMs` | 写账时刻（apply 时刻） |
| `processStartMs` | **进程起点**：`Date.now() - process.uptime()*1000` 反推的真实启动时刻（不是 apply 时刻——用「现在」会误判） |
| `pid` | 写账进程 pid |
| `plugins[]` | `{name, version, libMtimeMs}`：各插件 `lib/*.js` 的最大 mtime |
| `live[]` | `libMtimeMs ≤ processStartMs + 容差`（容差 1000ms）⇒ 该构建正被运行 |
| `stale[]` | `libMtimeMs > processStartMs + 容差` ⇒ 构建晚于启动，进程跑的是旧码（**重启才生效**） |

**一条命令答五问**：

```bash
tail -3 "$DSH_HOME/plugin-boot.jsonl"
# ① 线上跑的是哪个构建 → plugins[].libMtimeMs + version（各插件产物 mtime 即它的构建指纹）
# ② 谁发起 / 记了什么   → pid + processStartMs（哪一次 web 启动写的账）
# ③ 断在哪一段         → 无阶段枚举：账本有新行 ⇒ apply 跑到了；无新行 ⇒ 插件未挂载或未重启
# ④ 结果质量           → live[] / stale[] 的划分（stale 非空即「重启才生效」清单）
# ⑤ 耗时与预算         → atMs - processStartMs = 启动到 apply 的间隔（读账只读尾行，O(1)）
```

不变量（改动时不得破坏）：**I1** 判据只用「构建时刻 vs 进程起点」，可离线复算；**I2** `live ∪ stale = plugins` 且互斥；**I3** 行数有界（`≤ keepLines + 50`）；**I4** 任何落盘失败都不得抛（观测绝不反噬主流程）。

> 已知副作用：**预检 trialRun 也会落账**（试运行是真实组合）。当前读取方按「尾行 = 最近启动」取，恰好正确；若一次**失败**的重启尝试排在真启动之后，尾行会是短命进程——读取方应先校验 `pid` 存活（见 `docs/semantic.md` §10）。

## 生效判据与回退

**生效判据**（三选一）：
1. `tail -1 "$DSH_HOME/plugin-boot.jsonl"` 的 `atMs` 晚于本次重启时刻、且 `pid` 与当前 web 进程一致 ⇒ 本插件已装载并写了账；
2. 行为级：`plugin_boot_status` 可调用且返回 `ok: true`、`total` 非零 ⇒ 工具面已注册；
3. 判据级：`plugin_boot_status` 的实时 `stale` 为空 ⇒ 全生态正跑最新构建（这才是本插件存在的意义）。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。本插件正是这条判据的仪器，所以**它自己**也必须按判据验收：**进程起来了 ≠ 账写对了**，挂载/重启后账本必须 +1 行。

**回退**：
- 源码级：`git -C self-plugins/dsh-plugin-bootreport revert <commit>` → 重新构建 → 预检 → 重启；
- 组合级：预设里给 `agent-plugin-bootreport` 行加 `disabled: true`（或移除该行）→ 哨兵重启；
- 运行期：无需回退（无业务状态；`<DSH_HOME>/plugin-boot.jsonl` 可随时删除，下次启动重新建账）。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"
```

**19 例离线测试**（19/19 通过），跑 `lib/` 产物（与运行时同源）：

- **`tests/ledger.test.mjs`（10 例）**——账本本体：
  - 路径与身份：`resolveHome` 环境变量优先/缺省回落、`bootLedgerPath`；
  - 判据自洽：`currentBootLine` 真跑一次本机扫描，断言 `live + stale = 总数`、`pid` 为本进程；
  - 分类边界：`classify` 的 live/stale 划分与容差；
  - 序列化：`serializeBootLine` / `parseBootLines` 往返稳定（坏行跳过）；
  - **尸体测试**：不可写路径 → `appendBootLine` 返回 `false` 且**不抛**（不变量 I4）。
- **`tests/third-party.test.mjs`（9 例）**——第三方档（§5.23）：
  - 档位判定：自研 `link:` / 本地 `link:` / 官方 scope / git pin / codeload tarball / `file:` / registry 七档；
  - **隐私红线**：`redactSpec` 擦掉 URL userinfo 与 token 类参数，但**保留 git pin**（升级回退的唯一指纹）；
  - 生效推导：`deriveActivated` 容差边界（起点 +1000ms 算已组合、+1001ms 不算、未安装不算）；
  - 夹具盘点：`scanThirdParty` 在假 profile 上只收第三方档、标出 `bundle`、未安装如实写「未安装」；
  - **尸体测试**：profiles 目录不存在 / `package.json` 坏 JSON → 返回空、**不抛**。

**无需网络、无需外部依赖、无需 WSL**——纯本地文件系统 + 纯函数，任意环境可直接跑。

## 设计要点

- **不用「现在」当终点**：进程起点由 `Date.now() - process.uptime()*1000` 反推。`apply` 时刻可能比进程起点晚数秒到数十秒，用「现在」判 live/stale 会把刚构建完的产物误判为已生效——这是本插件最容易写错的一行。
- **零 loader 耦合**：判据不读运行时注册表，只读文件系统 mtime + 进程起点。好处是**可离线复算**（`classify()` 与写入同源），代价是只统计**有 `lib/*.js` 的目录**（纯源码插件与官方 bundle 不在账内）。
- **观测绝不反噬**：落盘失败一律吞错返回 `bool`，配尸体测试——账本坏了不影响任何业务路径。
- **一行一次启动，不做增量状态**：账本是 append-only 事件流而非「当前状态文件」，所以能事后回答「那次重启后是 live 还是 stale」，而不是只知道此刻。
- **一个观察者而不是 N 份实现**：技能 `plugin-maintainability` 准则 C1（机制必须自证）在生态平面的落地——把判据收敛到一处，避免 49 个插件各自维护「什么算生效」而互相漂移。
- **第三方不能用自研的判据**（2026-09-14 补，§5.23）：第三方插件的产物来自上游 tarball，**没有「我构建的 lib」**——硬套 `lib-mtime vs 进程起点` 会得到假结论。故第三方走独立档：记 `spec`（pin）+ 安装 mtime，判据是「**装得早于进程起点** ⇒ 本次启动的组合已包含它」（`activatedAtBoot`），并按 `bundle` 标出它是自述式挂载。补这一档的原因很直白：**只扫 `self-plugins` 的仪器看不见主人新装的第三方插件**，而「已盘点全部插件」这句话当时并不成立。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、概念模型与不变量（I1–I4）、契约（含调用点清单）、边界与信任、可证伪验收清单（A1–A8）、实践修订记录、未决问题（U1–U3） |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `plugin-maintainability` / `dsh-plugin-ecosystem-audit` / `plugin-workflow` | 可维护性工程（五问判据）、生态对齐审计、插件生命周期 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**49 个自研插件**按生命/认知/感知/行动/通信/治理/呈现/安全八层组织（另有第三方插件，管理模式见 AGENTS.md §5.23）。
