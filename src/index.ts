/**
 * dsh-plugin-bootreport：启动自报账本（cordis 胶水层）。
 *
 * 生态级洞察（2026-09-14 审计）：49 个自研插件里 **48 个**「不知线上跑的是哪个构建」
 * （技能 `plugin-maintainability` Q1/C1）——逐个手写自报既慢又会漂移，正确解是
 * **一个观察者插件统一落账**：web 启动时把「这台进程加载了哪些插件构建」写成一行
 * `<DSH_HOME>/plugin-boot.jsonl`，并给「构建晚于进程起点」的插件打 stale 告警
 * （治 §5.11 规则 6 的生态级盲区，含 rulebook 记为缺口的 watch 侧同类问题）。
 *
 * 纯逻辑在 `./ledger.ts`（可离线单测，不拉依赖树）。
 * @module dsh-plugin-bootreport
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  appendBootLine,
  bootLedgerPath,
  currentBootLine,
  readLastBoot,
  resolveHome,
} from './ledger.ts'
import { collectThirdParty, summarizeThirdParty } from './third-party.ts'

export const name = 'agent-plugin-bootreport'
export const inject = ['tools'] as const

export interface Config {
  enabled: boolean
  keepLines: number
}
export const Config = z.object({
  enabled: z.boolean().default(true),
  keepLines: z.number().default(200),
})

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('agent-plugin-bootreport')
  const home = resolveHome()
  const ledger = bootLedgerPath(home)

  if (config.enabled) {
    const line = currentBootLine(home)
    const written = appendBootLine(ledger, line, config.keepLines)
    logger.info(
      'boot ledger: plugins=' + String(line.plugins.length)
      + ' live=' + String(line.live.length) + ' stale=' + String(line.stale.length)
      + ' thirdParty=' + String(line.thirdParty?.length ?? 0)
      + ' written=' + String(written),
    )
    if (line.stale.length > 0) {
      // 预防信号（§5.11 规则 6）：构建晚于进程起点 ⇒ 进程在跑旧码，重启才生效
      logger.warn('stale builds（重启才生效）: ' + line.stale.join(', '))
    }
    for (const entry of line.thirdParty ?? []) {
      if (!entry.activatedAtBoot) {
        // 第三方没有构建门控（§5.23）：只能靠「装得晚于进程起点」提醒它尚未组合
        logger.warn('third-party 未随本次启动组合（需重启或未安装）: ' + summarizeThirdParty(entry))
      }
    }
  }

  ctx.tools.register(defineTool({
    name: 'plugin_boot_status',
    description: '读启动自报账本 + **现场复算**：最近一次 web 启动时间、启动时快照、以及「现在磁盘上的构建 vs 进程起点」的实时 live/stale 清单（快照盖不住启动之后的重建）。含**第三方插件**一档（§5.23：来自各 profile 依赖 + `dsh.profile.bundles`，自研/第三方两条管理路见 AGENTS.md §5.23）',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          ledger: { type: 'string', required: true },
          atMs: { type: 'number', required: true },
          processStartMs: { type: 'number', required: true },
          pid: { type: 'number', required: true },
          total: { type: 'number', required: true },
          live: { type: 'array', required: true, items: { type: 'string' } },
          stale: { type: 'array', required: true, items: { type: 'string' } },
          liveNow: { type: 'number', required: true },
          staleNow: { type: 'array', required: true, items: { type: 'string' } },
          thirdPartyTotal: { type: 'number', required: true },
          thirdParty: { type: 'array', required: true, items: { type: 'string' } },
          thirdPartyPending: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: { staleNow: string[]; liveNow: number; processStartMs: number; thirdPartyTotal: number; thirdPartyPending: string[] }) => [
        {
          type: 'text',
          text: '进程启动 ' + String(value.processStartMs)
            + '｜**现场**：live ' + String(value.liveNow) + '｜需重启 ' + String(value.staleNow.length)
            + (value.staleNow.length > 0 ? '（' + value.staleNow.join(', ') + '）' : '')
            + '｜第三方 ' + String(value.thirdPartyTotal) + ' 个'
            + (value.thirdPartyPending.length > 0 ? '（未组合：' + value.thirdPartyPending.join(', ') + '）' : ''),
        },
      ],
    },
    async execute() {
      const last = readLastBoot(ledger)
      // 2026-09-14 补（分身指出的缺口）：账本行是**启动时快照**，盖不住启动之后的重建——
      // 实测当天有 9 个插件在启动后被重新构建，快照仍显示「50 live / 0 stale」。
      // 故这里现算一次：扫磁盘上的 lib mtime 与本进程起点比较，给出「现在谁需要重启」。
      const now = currentBootLine(home)
      // 第三方（§5.23）现算：不依赖账本行是否已含该字段（老账本也能答）
      const { entries } = collectThirdParty(home, now.processStartMs)
      const thirdParty = entries.map(summarizeThirdParty)
      const pending = entries.filter((e) => !e.activatedAtBoot).map((e) => e.name)
      return {
        ok: last !== null,
        ledger,
        atMs: last?.atMs ?? 0,
        processStartMs: last?.processStartMs ?? now.processStartMs,
        pid: last?.pid ?? 0,
        total: last?.plugins.length ?? 0,
        live: last?.live ?? [],
        stale: last?.stale ?? [],
        liveNow: now.live.length,
        staleNow: now.stale,
        thirdPartyTotal: entries.length,
        thirdParty,
        thirdPartyPending: pending,
      }
    },
  }))
}
