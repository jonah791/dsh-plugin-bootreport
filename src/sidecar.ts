/**
 * 侧车健康巡检 —— 把「机制在悄悄空转」变成可感知的信号。
 *
 * 为什么存在（2026-10-03 事故直接驱动）
 * ------------------------------------
 * `dsh-agent-toolface` 的补挂自激循环写了 **2,311,441 行 / 439 MB** 日志、烧掉
 * **34% 单核**（进程累计 39,027 CPU 秒 ≈ 10.8 小时），而**我从未感知**——没有任何告警，
 * 文件静静躺在 `.dsh/` 下。主人从会话轨迹上看到「命令 263 ms 完成，之后近 1 分钟没反应」，
 * 才把它揪出来。
 *
 * ⇒ 本模块负责回答一个问题：**「有没有哪个机制正在高频重复地写同一行？」**
 * 那正是自激/死循环最硬的指纹——审计记录的是**状态变迁**，不是心跳（同 toolface 的 I8 不变量）。
 *
 * 口径（必须与读数同读）
 * ----------------------
 * · 只读每个文件的**尾部窗口**（缺省 256 KB）——大文件全读不可行，且尾部最能反映**当前**状态；
 * · 「重复率」= 1 − (窗口内去重行数 / 窗口内非空行数)；心跳类日志应接近 1.0，**这本身不是错**，
 *   判据要**与体积和时间窗联看**：`repetitive && sizeBytes >= minBytes && recent` ⇒ 疑似自激；
 * · `recent` 用 mtime 距今 ≤ staleMinutes 判定（默认 30 分钟）——历史遗留的大日志不该再报。
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** 一个侧车文件的巡检读数。 */
export interface SidecarReading {
  name: string
  path: string
  sizeBytes: number
  ageMinutes: number
  /** 尾部窗口里抽样到的非空行数（0 = 空文件或全空行）。 */
  sampleLines: number
  /** 1 − 去重行数/样本行数；样本为 0 时报 0（**不报 1**，避免把空文件误判成自激）。 */
  dupRatio: number
  /** 疑似自激：重复率高 + 体积够大 + 最近仍在写。 */
  suspectSpin: boolean
}

export interface SidecarOptions {
  /** 只看这些后缀（缺省 jsonl / log）。 */
  suffixes?: readonly string[]
  /** 尾部窗口字节数（缺省 262144 = 256 KB）。 */
  tailBytes?: number
  /** 判定 suspectSpin 的最小体积（缺省 1 MiB）。 */
  minBytes?: number
  /** 判定 suspectSpin 的重复率阈值（缺省 0.9）。 */
  dupThreshold?: number
  /** 判定 suspectSpin 的「最近仍在写」窗口，分钟（缺省 30）。 */
  staleMinutes?: number
}

const DEFAULTS = {
  suffixes: ['.jsonl', '.log'] as readonly string[],
  tailBytes: 262_144,
  minBytes: 1_048_576,
  dupThreshold: 0.9,
  staleMinutes: 30,
}

/** 读文件尾部至多 n 字节（文件小于 n 时读全量）。 */
function readTail(path: string, n: number): string {
  const st = statSync(path)
  const start = st.size > n ? st.size - n : 0
  const len = st.size - start
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(len)
    // `readSync` **不保证一次读完**请求的字节数；不循环补齐的话，未读部分会留在
    // Buffer.alloc 的零填充里 ⇒ 尾部字符串带 `\0`。本循环是防御性正确（2026-10-03 加固；
    // 当时的假红真因是测试断言用了 `dupRatio === 1`，而 1 − uniq/n 数学上达不到 1，与此无关）。
    let off = 0
    while (off < len) {
      const got = readSync(fd, buf, off, len - off, start + off)
      if (got <= 0) break
      off += got
    }
    return buf.subarray(0, off).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** 巡检单个文件。读不到（权限/消失）⇒ 返回 null，由调用方跳过。 */
export function inspectSidecar(
  path: string,
  nowMs: number,
  options: SidecarOptions = {},
): SidecarReading | null {
  const o = { ...DEFAULTS, ...options }
  let st
  try {
    st = statSync(path)
  } catch {
    return null
  }
  if (!st.isFile()) return null

  let text = ''
  try {
    text = readTail(path, o.tailBytes)
  } catch {
    return null
  }
  // 尾部窗口**截断了文件**时，首行必是从行中间切开的碎片 ⇒ 丢掉它。
  // 反之（文件小于窗口 / 窗口正好落在行首）首行是**完整行**，丢掉会白损样本
  // （2026-10-03 由 tests/sidecar.test.mjs 的两条小样本用例抓出：丢一整行后
  //  2 行样本的重复率被算成 0.5）。
  const truncated = st.size > o.tailBytes
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  const sample = truncated && lines.length > 1 ? lines.slice(1) : lines
  const uniq = new Set(sample).size
  const sampleLines = sample.length
  // 样本 <5 行时重复率不可靠（1 行必得 0，2 行同内容得 0.5）⇒ 保守报 0，不据此指控。
  const dupRatio = sampleLines < 5 ? 0 : 1 - uniq / sampleLines
  const ageMinutes = Math.max(0, (nowMs - st.mtimeMs) / 60_000)
  const suspectSpin = dupRatio >= o.dupThreshold
    && st.size >= o.minBytes
    && ageMinutes <= o.staleMinutes

  return {
    name: basename(path),
    path,
    sizeBytes: st.size,
    ageMinutes: Math.round(ageMinutes * 10) / 10,
    sampleLines,
    dupRatio: Math.round(dupRatio * 1000) / 1000,
    suspectSpin,
  }
}

/** 扫一个目录下的侧车文件（不递归；缺目录 ⇒ 空数组，**不抛**）。 */
export function scanSidecarDir(
  dir: string,
  nowMs: number,
  options: SidecarOptions & { readdir?: (d: string) => string[] } = {},
): SidecarReading[] {
  const o = { ...DEFAULTS, ...options }
  const readdir = options.readdir
    ?? ((d: string): string[] => {
      try {
        return readdirSync(d)
      } catch {
        return []
      }
    })
  const out: SidecarReading[] = []
  for (const name of readdir(dir)) {
    if (!o.suffixes.some((s) => name.endsWith(s))) continue
    const r = inspectSidecar(join(dir, name), nowMs, o)
    if (r !== null) out.push(r)
  }
  return out
}

/**
 * 渲染巡检报告（工具 render 与测试共用同一份文案 —— 判据单一真源，§5.22）。
 * 排序：疑似自激优先，其次体积降序。
 */
export function sidecarReportLines(readings: readonly SidecarReading[]): string[] {
  if (readings.length === 0) return ['未发现侧车文件（.jsonl / .log）']
  const sorted = [...readings].sort((a, b) => {
    if (a.suspectSpin !== b.suspectSpin) return a.suspectSpin ? -1 : 1
    return b.sizeBytes - a.sizeBytes
  })
  const suspects = sorted.filter((r) => r.suspectSpin)
  const mb = (n: number): string => (n / 1_048_576).toFixed(1)
  const lines: string[] = []
  lines.push(suspects.length > 0
    ? `⚠ 疑似自激 ${suspects.length} 个（重复率高 + 体积大 + 最近仍在写）`
    : '✓ 无自激指纹（所有大文件的尾部重复率均低于阈值）')
  for (const r of sorted) {
    if (!r.suspectSpin && r.sizeBytes < 262_144) continue   // 小文件不刷屏
    const flag = r.suspectSpin ? '⚠' : '·'
    lines.push(`${flag} ${r.name}  ${mb(r.sizeBytes)} MB  重复率 ${(r.dupRatio * 100).toFixed(1)}%  `
      + `样本 ${r.sampleLines} 行  最后写 ${r.ageMinutes} 分钟前`)
  }
  if (suspects.length > 0) {
    lines.push('建议：`tail -n 5 <文件>` 看是否同一行反复刷；若是，找写它的机制（自激的判据是'
      + '「触发条件可满足且会收敛」，见 toolface 事故 I7/I8）')
  }
  return lines
}
