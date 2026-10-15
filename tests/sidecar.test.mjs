/**
 * tests/sidecar.test.mjs —— 侧车健康巡检的判据回归。
 *
 * **尸体样本直接取自 2026-10-03 toolface 事故的形态**：
 * 「同一行反复刷 + 体积大 + 此刻仍在写」——判据必须对它亮，
 * 而对「全不同的行 / 空文件 / 很久没写的大文件」必须不亮（否则是到处报警）。
 *
 * 跑法：node --test tests/sidecar.test.mjs（先 tsc -p tsconfig.json 构建）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectSidecar, scanSidecarDir, sidecarReportLines } from '../lib/sidecar.js'

const NOW = Date.now()
const MB = 1_048_576

async function tmpFile(name, content, ageMinutes = 0) {
  const dir = await mkdtemp(join(tmpdir(), 'sidecar-'))
  const p = join(dir, name)
  await writeFile(p, content, 'utf8')
  if (ageMinutes > 0) {
    const t = (NOW - ageMinutes * 60_000) / 1000
    await utimes(p, t, t)
  }
  return p
}

/** 造 toolface 形态：同一行重复 n 次（体积靠行长 × 行数堆出来）。 */
function spinContent(lines, pad = 200) {
  const line = JSON.stringify({ at: '2026-10-03T14:00:00.000Z', action: 'reapply', mode: 'lean', pad: 'x'.repeat(pad) })
  return Array(lines).fill(line).join('\n') + '\n'
}

// ── inspectSidecar：判据 ────────────────────────────────────────────────
test('inspectSidecar：**尸体样本**（重复行 + 体积大 + 刚写过）⇒ suspectSpin=true', async () => {
  const p = await tmpFile('toolface-events.log', spinContent(6000), 0)
  const r = inspectSidecar(p, NOW, { minBytes: MB })
  assert.ok(r !== null)
  assert.ok(r.sizeBytes >= MB, `样本体积应 ≥1MB，实际 ${r.sizeBytes}`)
  // ⚠ 重复率的定义是 1 − uniq/n，**数学上达不到 1**（除非样本为空）。
  // 首次写这条断言时用了 `=== 1` ⇒ 假红三次；正解是留余量。
  assert.ok(r.dupRatio > 0.99, `同一行重复 6000 次 ⇒ 重复率应 >0.99，实际 ${r.dupRatio}`)
  assert.equal(r.suspectSpin, true, '这就是 toolface 的形态，判据必须亮')
})

test('inspectSidecar：**对照**——同为重复行但很久没写 ⇒ 不判自激（历史日志不该反复报警）', async () => {
  const p = await tmpFile('old.log', spinContent(6000), 120)
  const r = inspectSidecar(p, NOW, { minBytes: MB, staleMinutes: 30 })
  assert.equal(r.suspectSpin, false, '120 分钟没写 > 30 分钟窗口 ⇒ 不报')
})

test('inspectSidecar：**对照**——体积大但行全不同 ⇒ 不判自激（正常审计日志）', async () => {
  const lines = []
  for (let i = 0; i < 8000; i += 1) lines.push(JSON.stringify({ i, at: `2026-10-03T14:00:${i % 60}.000Z`, v: 'y'.repeat(150) }))
  const p = await tmpFile('audit.jsonl', lines.join('\n') + '\n', 0)
  const r = inspectSidecar(p, NOW, { minBytes: MB })
  assert.ok(r.sizeBytes >= MB)
  assert.ok(r.dupRatio < 0.05, `行全不同 ⇒ 重复率应接近 0，实际 ${r.dupRatio}`)
  assert.equal(r.suspectSpin, false)
})

test('inspectSidecar：空文件 ⇒ dupRatio=0（**不报 1**，避免把空文件误判成自激）', async () => {
  const p = await tmpFile('empty.jsonl', '', 0)
  const r = inspectSidecar(p, NOW)
  assert.equal(r.sampleLines, 0)
  assert.equal(r.dupRatio, 0)
  assert.equal(r.suspectSpin, false)
})

test('inspectSidecar：小体积的高重复文件 ⇒ 不判自激（低于 minBytes 不当嫌疑）', async () => {
  const p = await tmpFile('small.log', spinContent(3), 0)
  const r = inspectSidecar(p, NOW, { minBytes: MB })
  // 样本 <5 行时重复率保守报 0（不可靠），本用例只断言「不指控」
  assert.equal(r.suspectSpin, false, '小文件重复率高是常态，不该当自激')
})

test('inspectSidecar：目录 / 不存在的路径 ⇒ 返回 null（不抛）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sidecar-null-'))
  assert.equal(inspectSidecar(dir, NOW), null)
  assert.equal(inspectSidecar(join(dir, 'nope.jsonl'), NOW), null)
})

test('inspectSidecar：窗口截断时丢掉首行碎片、保留完整行', async () => {
  // 每行 100 字节 × 20 行 = 2000 字节；窗口 250 字节 ⇒ 必然从行中间开始（截断）
  const line = 'z'.repeat(99)
  const p = await tmpFile('mid.log', (line + '\n').repeat(20), 0)
  const r = inspectSidecar(p, NOW, { tailBytes: 250 })
  assert.ok(r.sampleLines >= 1, '应仍取到样本（首行碎片被丢，其余保留）')
  assert.ok(r.sampleLines <= 3, `250 字节窗口至多容纳约 2 行，实际 ${r.sampleLines}`)
})

// ── scanSidecarDir：目录扫描 ────────────────────────────────────────────
test('scanSidecarDir：只挑后缀匹配的文件，跳过子目录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sidecar-scan-'))
  await writeFile(join(dir, 'a.jsonl'), 'x\n', 'utf8')
  await writeFile(join(dir, 'b.log'), 'y\n', 'utf8')
  await writeFile(join(dir, 'c.txt'), 'z\n', 'utf8')
  const rows = scanSidecarDir(dir, NOW)
  assert.deepEqual(rows.map(r => r.name).sort(), ['a.jsonl', 'b.log'])
})

test('scanSidecarDir：目录不存在 ⇒ 空数组（不抛）', () => {
  assert.deepEqual(scanSidecarDir(join(tmpdir(), 'definitely-not-here-xyz'), NOW), [])
})

// ── sidecarReportLines：渲染与判据同源 ──────────────────────────────────
test('sidecarReportLines：有嫌疑时置顶告警，并给下一步线索', () => {
  const lines = sidecarReportLines([
    { name: 'spin.log', path: 'p', sizeBytes: 2 * MB, ageMinutes: 1, sampleLines: 100, dupRatio: 1, suspectSpin: true },
    { name: 'ok.jsonl', path: 'q', sizeBytes: 3 * MB, ageMinutes: 5, sampleLines: 100, dupRatio: 0.1, suspectSpin: false },
  ])
  const s = lines.join('\n')
  assert.match(s, /⚠ 疑似自激 1 个/)
  assert.match(s, /spin\.log/)
  assert.match(s, /tail -n 5/)
})

test('sidecarReportLines：无嫌疑时报健康（且不把空清单渲染成告警）', () => {
  const s = sidecarReportLines([
    { name: 'a.jsonl', path: 'p', sizeBytes: 2 * MB, ageMinutes: 5, sampleLines: 50, dupRatio: 0.2, suspectSpin: false },
  ]).join('\n')
  assert.match(s, /✓ 无自激指纹/)
})

test('sidecarReportLines：空清单 ⇒ 明确说「未发现侧车文件」', () => {
  assert.match(sidecarReportLines([]).join('\n'), /未发现侧车文件/)
})
