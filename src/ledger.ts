/**
 * 启动自报账本的纯逻辑 + 薄 IO（与 cordis 胶水分离：测试只跑这一层，不拉依赖树）。
 *
 * 判据（§5.11 规则 6「重建 ≠ 生效」的生态版）：
 *   lib 产物 mtime ≤ **进程启动时间** ⇒ 该构建在被跑（live）；> 进程启动 ⇒ 构建晚于启动，
 *   进程跑的是旧码（stale，需重启）。进程起点用 `Date.now() - process.uptime()*1000` 反推
 *   （apply 可能晚于进程起点，用「现在」会误判）。
 *
 * @module dsh-plugin-bootreport/ledger
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 单个插件的构建标识。 */
export interface PluginBuild {
  name: string
  version: string
  libMtimeMs: number
}

/** 一行启动账（一次 web 启动 = 一行）。 */
export interface BootLine {
  atMs: number
  processStartMs: number
  pid: number
  plugins: PluginBuild[]
  live: string[]
  stale: string[]
}

/** 解析 DSH_HOME：环境变量优先，缺省 `<homedir>/.dsh`（与既有插件同约定）。 */
export function resolveHome(
  env: Record<string, string | undefined> = process.env,
  fallback = homedir(),
): string {
  const raw = env['DSH_HOME']
  return raw !== undefined && raw.trim() !== '' ? raw : join(fallback, '.dsh')
}

/** 账本路径。 */
export function bootLedgerPath(home: string): string {
  return join(home, 'plugin-boot.jsonl')
}

/** 进程启动时刻（ms epoch）。 */
export function processStartMs(nowMs = Date.now(), uptimeSec = process.uptime()): number {
  return Math.round(nowMs - uptimeSec * 1000)
}

/** 插件根候选（与 dsh-agent-plugin-manager 同源：DSH_HOME 的上一级即工作区）。 */
export function buildRoots(home: string, cwd = process.cwd()): string[] {
  return [join(home, '..', 'self-plugins'), join(cwd, 'self-plugins'), join(home, 'self-plugins')]
}

/** 扫一个插件根下的构建：`<root>/<dir>/lib/*.js` 的 mtime 最大值 = 该插件构建时刻。 */
export function scanBuilds(root: string): PluginBuild[] {
  const out: PluginBuild[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  for (const entry of entries) {
    const dir = join(root, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string
        version?: string
      }
      let newest = 0
      for (const file of readdirSync(join(dir, 'lib'))) {
        if (!file.endsWith('.js')) continue
        newest = Math.max(newest, statSync(join(dir, 'lib', file)).mtimeMs)
      }
      if (newest === 0) continue
      out.push({ name: pkg.name ?? entry, version: pkg.version ?? '?', libMtimeMs: Math.round(newest) })
    } catch {
      continue // 无 package.json / 无 lib / 读不动 → 非可判定构建
    }
  }
  return out
}

/** 分类：构建时刻 ≤ 进程起点（+容差）= 在被跑；晚于 = 需重启。 */
export function classify(
  builds: PluginBuild[],
  startMs: number,
  toleranceMs = 1000,
): { live: string[]; stale: string[] } {
  const live: string[] = []
  const stale: string[] = []
  for (const b of builds) {
    if (b.libMtimeMs <= startMs + toleranceMs) live.push(b.name)
    else stale.push(b.name)
  }
  return { live: live.sort(), stale: stale.sort() }
}

/** 稳定序列化（单行 JSON，键序固定便于 tail/grep）。 */
export function serializeBootLine(line: BootLine): string {
  return JSON.stringify({
    atMs: line.atMs,
    processStartMs: line.processStartMs,
    pid: line.pid,
    live: line.live,
    stale: line.stale,
    plugins: line.plugins,
  })
}

/** 容错解析（坏行/空行跳过，不抛）。 */
export function parseBootLines(text: string): BootLine[] {
  const out: BootLine[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    try {
      const parsed = JSON.parse(line) as BootLine
      if (typeof parsed.atMs === 'number' && Array.isArray(parsed.plugins)) out.push(parsed)
    } catch {
      continue
    }
  }
  return out
}

/**
 * 追加一行并（超限时）裁剪保留最近 keepLines 行。
 * 失败一律吞掉并返回 false——**观测绝不反噬主流程**（技能 C4）。
 */
export function appendBootLine(path: string, line: BootLine, keepLines = 200): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, serializeBootLine(line) + '\n', 'utf8')
  } catch {
    return false
  }
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '')
    if (lines.length > keepLines + 50) {
      const kept = lines.slice(-keepLines).join('\n') + '\n'
      // 旁车 + rename = 原子替换；坏路径吞掉（账本丢了不影响业务）
      writeFileSync(path + '.trim', kept, 'utf8')
      renameSync(path + '.trim', path)
    }
  } catch {
    // 裁剪失败不影响账本本身
  }
  return true
}

/** 读最近一行（无账本/坏文件返回 null）。 */
export function readLastBoot(path: string): BootLine | null {
  try {
    const all = parseBootLines(readFileSync(path, 'utf8'))
    return all.length > 0 ? all[all.length - 1]! : null
  } catch {
    return null
  }
}

/** 当前进程视角的账本行（apply 时调用）。同名单取最新 lib mtime（多根去重）。 */
export function currentBootLine(home: string, roots?: string[]): BootLine {
  const startMs = processStartMs()
  const seen = new Map<string, PluginBuild>()
  for (const root of roots ?? buildRoots(home)) {
    for (const b of scanBuilds(root)) {
      const prev = seen.get(b.name)
      if (prev === undefined || b.libMtimeMs > prev.libMtimeMs) seen.set(b.name, b)
    }
  }
  const builds = [...seen.values()]
  const { live, stale } = classify(builds, startMs)
  return { atMs: Date.now(), processStartMs: startMs, pid: process.pid, plugins: builds, live, stale }
}
