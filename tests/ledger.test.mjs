/**
 * ledger.ts 单测：启动账本必须「可写、可读、容错、判据正确、绝不反噬主流程」。
 *
 * 现场动机（2026-09-14）：生态里 48/49 插件答不出「线上跑的是哪个构建」——本模块是
 * 那个统一答案，所以判据（mtime vs 进程起点）与失败行为都必须被测试锁住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendBootLine,
  bootLedgerPath,
  buildRoots,
  classify,
  currentBootLine,
  parseBootLines,
  processStartMs,
  readLastBoot,
  resolveHome,
  scanBuilds,
  serializeBootLine,
} from '../lib/ledger.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'bootreport-'));
}

function makePlugin(root, dir, { name, version }) {
  const base = join(root, dir);
  mkdirSync(join(base, 'lib'), { recursive: true });
  writeFileSync(join(base, 'package.json'), JSON.stringify({ name, version }));
  writeFileSync(join(base, 'lib', 'index.js'), '// built\n');
  return base;
}

test('resolveHome：DSH_HOME 优先，空串回退 homedir/.dsh', () => {
  assert.equal(resolveHome({ DSH_HOME: 'E:/alice/.dsh' }, '/home/x'), 'E:/alice/.dsh');
  assert.equal(resolveHome({ DSH_HOME: '  ' }, '/home/x'), join('/home/x', '.dsh'));
  assert.equal(resolveHome({}, '/home/x'), join('/home/x', '.dsh'));
});

test('bootLedgerPath / buildRoots：路径约定稳定', () => {
  assert.equal(bootLedgerPath('E:/alice/.dsh'), join('E:/alice/.dsh', 'plugin-boot.jsonl'));
  const roots = buildRoots('E:/alice/.dsh', 'E:/alice');
  assert.equal(roots[0], join('E:/alice/.dsh', '..', 'self-plugins'));
  assert.ok(roots.includes(join('E:/alice', 'self-plugins')));
});

test('processStartMs：用 uptime 反推进程起点（不是 apply 时刻）', () => {
  assert.equal(processStartMs(1_000_000, 10), 990_000);
  assert.ok(processStartMs() <= Date.now());
});

test('scanBuilds：只认有 lib 的目录，跳过非目录与缺 lib 的包', () => {
  const root = tempDir();
  try {
    makePlugin(root, 'pkg-a', { name: '@scope/pkg-a', version: '1.2.3' });
    makePlugin(root, 'pkg-b', { name: 'pkg-b', version: '0.0.1' });
    rmSync(join(root, 'pkg-b', 'lib'), { recursive: true, force: true }); // 无 lib → 非可判定
    writeFileSync(join(root, 'loose.txt'), 'x');
    const builds = scanBuilds(root).sort((a, b) => a.name.localeCompare(b.name));
    assert.equal(builds.length, 1);
    assert.deepEqual(
      { name: builds[0].name, version: builds[0].version },
      { name: '@scope/pkg-a', version: '1.2.3' },
    );
    assert.ok(builds[0].libMtimeMs > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('classify：构件早于进程起点 = live；晚于 = stale（含容差边界）', () => {
  const builds = [
    { name: 'old', version: '1', libMtimeMs: 1_000 },
    { name: 'fresh', version: '1', libMtimeMs: 2_000 },
    { name: 'edge', version: '1', libMtimeMs: 1_500 },
  ];
  const r = classify(builds, 1_400, 200); // 容差 200 → edge(1500) 算 live，fresh(2000) 算 stale
  assert.deepEqual(r.live, ['edge', 'old']);
  assert.deepEqual(r.stale, ['fresh']);
  // 边界：容差内必须判 live（否则每次启动都假告警）
  assert.deepEqual(classify([{ name: 'x', version: '1', libMtimeMs: 1_500 }], 1_400, 200).stale, []);
});

test('serializeBootLine / parseBootLines：稳定键序 + 坏行跳过', () => {
  const line = {
    atMs: 1789351052242,
    processStartMs: 1789351000000,
    pid: 25260,
    live: ['a'],
    stale: ['b'],
    plugins: [{ name: 'a', version: '1.0.0', libMtimeMs: 1 }],
  };
  const text = serializeBootLine(line);
  assert.equal(text.split('\n').length, 1);
  assert.equal(
    text,
    '{"atMs":1789351052242,"processStartMs":1789351000000,"pid":25260,"live":["a"],"stale":["b"],'
    + '"plugins":[{"name":"a","version":"1.0.0","libMtimeMs":1}]}',
  );
  assert.deepEqual(parseBootLines(['', 'not json', text, '{"atMs":"nope"}'].join('\n')), [line]);
});

test('appendBootLine / readLastBoot：自动建目录、追加不覆盖、超限裁剪', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'nested', 'plugin-boot.jsonl');
    const line = (n) => ({
      atMs: n, processStartMs: n - 10, pid: 1, live: [], stale: [], plugins: [],
    });
    assert.equal(appendBootLine(path, line(1), 5), true);
    assert.equal(appendBootLine(path, line(2), 5), true);
    assert.equal(readLastBoot(path).atMs, 2);
    assert.equal(parseBootLines(readFileSync(path, 'utf8')).length, 2);
    // 超限裁剪是**有界**的：行数始终 ≤ keepLines + 50（不是恰好等于 keepLines——
    // 裁剪只在该阈值处发生，之后继续追加直到再次越界）
    for (let i = 3; i <= 60; i += 1) appendBootLine(path, line(i), 5);
    appendBootLine(path, line(99), 5);
    const count = parseBootLines(readFileSync(path, 'utf8')).length;
    assert.ok(count <= 5 + 50, `账本行数必须被裁剪到有界，实际 ${count}`);
    assert.ok(count < 61, '裁剪必须真的发生（否则文件无界增长）');
    assert.equal(readLastBoot(path).atMs, 99);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendBootLine：不可写路径返回 false 且不抛（观测不得反噬主流程）', () => {
  const dir = tempDir();
  try {
    const blocker = join(dir, 'file-not-dir');
    writeFileSync(blocker, 'x');
    assert.equal(
      appendBootLine(join(blocker, 'plugin-boot.jsonl'), {
        atMs: 1, processStartMs: 0, pid: 1, live: [], stale: [], plugins: [],
      }),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLastBoot：缺失/坏文件返回 null（不抛）', () => {
  const dir = tempDir();
  try {
    assert.equal(readLastBoot(join(dir, 'absent.jsonl')), null);
    const broken = join(dir, 'broken.jsonl');
    writeFileSync(broken, 'garbage\n');
    assert.equal(readLastBoot(broken), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('currentBootLine：真跑一次本机扫描，判据自洽（live+stale=总数，pid 为我）', () => {
  const dir = tempDir();
  try {
    makePlugin(dir, 'pkg-now', { name: 'pkg-now', version: '9.9.9' });
    const line = currentBootLine(dir, [dir]);
    assert.equal(line.pid, process.pid);
    assert.equal(line.live.length + line.stale.length, line.plugins.length);
    assert.ok(line.plugins.length >= 1);
    assert.ok(line.processStartMs <= line.atMs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
