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
      + ' written=' + String(written),
    )
    if (line.stale.length > 0) {
      // 预防信号（§5.11 规则 6）：构建晚于进程起点 ⇒ 进程在跑旧码，重启才生效
      logger.warn('stale builds（重启才生效）: ' + line.stale.join(', '))
    }
  }

  ctx.tools.register(defineTool({
    name: 'plugin_boot_status',
    description: '读启动自报账本：最近一次 web 启动时间 + 全生态构建「已生效 live / 需重启 stale」清单',
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
        },
      },
      render: (_args: unknown, value: { live: string[]; stale: string[]; processStartMs: number }) => [
        {
          type: 'text',
          text: '进程启动 ' + String(value.processStartMs)
            + '｜live ' + String(value.live.length) + '｜stale ' + String(value.stale.length)
            + (value.stale.length > 0 ? '（需重启：' + value.stale.join(', ') + '）' : ''),
        },
      ],
    },
    async execute() {
      const last = readLastBoot(ledger)
      return {
        ok: last !== null,
        ledger,
        atMs: last?.atMs ?? 0,
        processStartMs: last?.processStartMs ?? 0,
        pid: last?.pid ?? 0,
        total: last?.plugins.length ?? 0,
        live: last?.live ?? [],
        stale: last?.stale ?? [],
      }
    },
  }))
}
