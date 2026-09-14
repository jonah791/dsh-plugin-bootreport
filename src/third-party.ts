/**
 * 第三方插件清单（§5.23 第三方插件管理模式 · 2026-09-14）。
 *
 * 背景：`ledger.ts` 只扫 `self-plugins/**`，于是 **bundle 形态的第三方**
 * （profile `dependencies` + `dsh.profile.bundles`，产物来自上游 tarball）在整个
 * 管理面上不可见——「已盘点全部插件」这句话在补上本模块之前是不成立的。
 *
 * 本模块补这一档：从各 profile 的 `package.json` 依赖里挑出非自研、非官方的那部分，
 * 记录 **pin（依赖声明）/ 来源档 / 安装时刻**，并给出「本次进程启动是否已组合它」的判据
 * （第三方没有「我构建的产物」，所以不能用 self-plugins 的 lib-mtime 判据；
 *  改用 **装得早于进程起点** ⇒ 本次启动的组合里包含它）。
 *
 * 纯逻辑（classify/redact/deriveActivated）+ 薄 IO（readProfileManifest/collectThirdParty），
 * 后者可喂临时目录离线单测，不拉依赖树。
 *
 * @module dsh-plugin-bootreport/third-party
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 依赖来源档位。第三方 = `third-party-*` 四档。 */
export type DepSource =
  | 'link-self'          // link: → 工作区 self-plugins/<name>（自研，另有 ledger 的 live/stale 判据）
  | 'link-other'         // link: → 其他本地路径（如 deepseek-harness 源码化安装）
  | 'official'           // @deepseek-ai/*（官方包）
  | 'third-party-git'    // github:owner/repo#ref / git+https / git@（pin 到 commit/tag）
  | 'third-party-tarball'// https://…/tar.gz#<sha>（pnpm 从 git 拉下的 tarball）
  | 'third-party-local'  // file:（本地目录）
  | 'third-party-registry' // 版本号（npm registry）

/** 一条第三方插件记录（落进启动账本，也用于工具面展示）。 */
export interface ThirdPartyEntry {
  name: string
  version: string
  /** 依赖声明（**已脱敏**：URL userinfo 与 token 类查询参数被擦除） */
  spec: string
  source: DepSource
  profile: string
  /** 是否列在该 profile 的 `dsh.profile.bundles`（bundle 形态 = 自述式挂载） */
  bundle: boolean
  /** `node_modules/<name>/package.json` 的 mtime（= 上游产物落地时刻）；未安装为 0 */
  installedMtimeMs: number
  /** 装得早于进程起点 ⇒ 本次启动的组合已包含它（第三方的「生效」判据） */
  activatedAtBoot: boolean
}

const OFFICIAL_SCOPE = '@deepseek-ai/'

/** 判定一个依赖属于哪一档（纯函数，`name` 参与判定是为了识别官方 scope）。 */
export function classifyDependency(name: string, spec: string): DepSource {
  const s = spec.trim()
  if (name.startsWith(OFFICIAL_SCOPE)) return 'official'
  if (s.startsWith('link:')) {
    return /(^|[\\/])self-plugins[\\/]/.test(s) ? 'link-self' : 'link-other'
  }
  if (s.startsWith('file:')) return 'third-party-local'
  if (s.startsWith('github:') || s.startsWith('git+') || s.startsWith('git:') || s.startsWith('git@')) {
    return 'third-party-git'
  }
  if (/^https?:\/\//i.test(s)) {
    // pnpm 把 github: 依赖解析成 codeload 的 tar.gz；两者都认（见 pnpm-lock 的 tarball 字段）
    return /\.git(#|$)/i.test(s) ? 'third-party-git' : 'third-party-tarball'
  }
  return 'third-party-registry'
}

/** 是否第三方档。 */
export function isThirdParty(source: DepSource): boolean {
  return source.startsWith('third-party-')
}

/**
 * 脱敏依赖声明：URL 里的 userinfo（`//user:pass@`）与 token 类查询参数不落盘。
 * 与 dsh-code-search 的 `redactQuery` 同思路：**宁可少记，不可把凭据写进账本**。
 */
export function redactSpec(spec: string): string {
  return spec
    .replace(/\/\/[^/@\s]+@/g, '//')
    .replace(/([?&](?:token|access_token|auth|api_?key|password|secret)=)[^&\s]+/gi, '$1[redacted]')
}

/** 从「安装时刻 / 进程起点」推导是否已随本次启动组合。 */
export function deriveActivated(installedMtimeMs: number, processStartMs: number, toleranceMs = 1000): boolean {
  if (installedMtimeMs <= 0) return false
  return installedMtimeMs <= processStartMs + toleranceMs
}

/** 一个 profile 的依赖与 bundles 名单（读不动返回 null）。 */
export function readProfileManifest(profileDir: string): { deps: { name: string; spec: string }[]; bundles: string[] } | null {
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    const deps = Object.entries(pkg.dependencies ?? {}).map(([name, spec]) => ({ name, spec: String(spec) }))
    const bundles = pkg.dsh?.profile?.bundles ?? []
    return { deps, bundles }
  } catch {
    return null
  }
}

/** `node_modules/<name>/package.json` 的版本与 mtime（未安装 → {'?', 0}）。 */
export function readInstalled(profileDir: string, name: string): { version: string; mtimeMs: number } {
  try {
    const p = join(profileDir, 'node_modules', name, 'package.json')
    const mtimeMs = Math.round(statSync(p).mtimeMs)
    const pkg = JSON.parse(readFileSync(p, 'utf8')) as { version?: string }
    return { version: String(pkg.version ?? '?'), mtimeMs }
  } catch {
    return { version: '未安装', mtimeMs: 0 }
  }
}

/**
 * 收集全部 profile 的第三方插件（按 name 去重，保留先遇到的 profile）。
 * 顺带统计各档位条数，便于工具面回一句话总数。
 */
export function collectThirdParty(
  home: string,
  processStartMs: number,
  profilesDirName = 'profiles',
): { entries: ThirdPartyEntry[]; counts: Record<string, number> } {
  const entries: ThirdPartyEntry[] = []
  const counts: Record<string, number> = {}
  const seen = new Set<string>()
  let profileNames: string[] = []
  try {
    profileNames = readdirSync(join(home, profilesDirName))
  } catch {
    return { entries, counts }
  }
  for (const profile of profileNames) {
    const dir = join(home, profilesDirName, profile)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const manifest = readProfileManifest(dir)
    if (manifest === null) continue
    for (const { name, spec } of manifest.deps) {
      const source = classifyDependency(name, spec)
      counts[source] = (counts[source] ?? 0) + 1
      if (!isThirdParty(source) || seen.has(name)) continue
      seen.add(name)
      const installed = readInstalled(dir, name)
      entries.push({
        name,
        version: installed.version,
        spec: redactSpec(spec),
        source,
        profile,
        bundle: manifest.bundles.includes(name),
        installedMtimeMs: installed.mtimeMs,
        activatedAtBoot: deriveActivated(installed.mtimeMs, processStartMs),
      })
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return { entries, counts }
}

/** 一行摘要（工具面/日志用）。 */
export function summarizeThirdParty(entry: ThirdPartyEntry): string {
  return entry.name + '@' + entry.version
    + ' [' + entry.source + ']'
    + ' profile=' + entry.profile
    + ' bundle=' + String(entry.bundle)
    + ' activatedAtBoot=' + String(entry.activatedAtBoot)
    + ' spec=' + entry.spec
}
