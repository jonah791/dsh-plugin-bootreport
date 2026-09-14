/**
 * third-party.ts 单测（§5.23 第三方插件管理模式）。
 *
 * 现场动机（2026-09-14）：主人装了 bundle 形态的第三方插件（`dsh-x-opencode-session`），
 * 而 bootreport 只扫 `self-plugins` → 管理面上「看不见」。本模块把这一档补上，
 * 因此**判据与失败行为都必须被测试锁住**：
 *   ① 依赖档位判定（自研 link / 官方 / git pin / tarball / registry / file）
 *   ② 脱敏（URL userinfo 与 token 参数不得落盘）
 *   ③ 「本次启动是否已组合」的推导（装得早于进程起点）
 *   ④ 枚举 IO 的健壮性（profiles 目录缺失 / 坏 package.json / 未安装 → 不抛、如实标注）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyDependency,
  collectThirdParty,
  deriveActivated,
  isThirdParty,
  readInstalled,
  readProfileManifest,
  redactSpec,
  summarizeThirdParty,
} from '../lib/third-party.js';

// ── ① 档位判定 ────────────────────────────────────────────────────────────

test('classifyDependency: 自研 link / 官方 scope / git pin / tarball / registry / file 六档可分', () => {
  // 自研：link: 指向工作区 self-plugins
  assert.equal(classifyDependency('dsh-agent-browser', 'link:E:/alice/self-plugins/dsh-agent-browser'), 'link-self');
  assert.equal(classifyDependency('dsh-panel', 'link:E:\\alice\\self-plugins\\dsh-panel'), 'link-self');
  // 官方 scope 优先于 link 形态：@deepseek-ai/* 无论是 registry 还是源码 link，都算 official
  // （源码化安装 = spec 里能看到 link: 路径；第三方清单只看「是不是我的代码」）
  assert.equal(
    classifyDependency('@deepseek-ai/dsh-web-app', 'link:E:/alice/deepseek-harness/packages/web/app'),
    'official',
  );
  assert.equal(classifyDependency('@deepseek-ai/dsh-base', '^1.0.0'), 'official');
  // 本地 link 但既不是自研也不是官方 scope
  assert.equal(classifyDependency('my-local-tool', 'link:E:/alice/tools/my-local-tool'), 'link-other');
  // git pin（本次实例的真实形态）
  assert.equal(
    classifyDependency('dsh-x-opencode-session', 'github:Coco-king/dsh-x-opencode-session#2e7ce82c9fa821f63edb80f2ab641a87e1a7de3c'),
    'third-party-git',
  );
  assert.equal(classifyDependency('x', 'git+https://github.com/a/b.git#v1'), 'third-party-git');
  assert.equal(classifyDependency('x', 'git@github.com:a/b.git'), 'third-party-git');
  // pnpm 解析出的 codeload tarball
  assert.equal(
    classifyDependency('x', 'https://codeload.github.com/a/b/tar.gz/deadbeef'),
    'third-party-tarball',
  );
  assert.equal(classifyDependency('x', 'https://github.com/a/b.git#v1'), 'third-party-git');
  // 本地目录 / npm 版本号
  assert.equal(classifyDependency('x', 'file:../pkg'), 'third-party-local');
  assert.equal(classifyDependency('x', '^1.2.3'), 'third-party-registry');
  assert.equal(classifyDependency('x', 'latest'), 'third-party-registry');
});

test('isThirdParty: 只有 third-party-* 四档算第三方（自研/官方不算）', () => {
  assert.equal(isThirdParty('third-party-git'), true);
  assert.equal(isThirdParty('third-party-registry'), true);
  assert.equal(isThirdParty('link-self'), false);
  assert.equal(isThirdParty('official'), false);
  assert.equal(isThirdParty('link-other'), false);
});

// ── ② 脱敏（隐私红线） ────────────────────────────────────────────────────

test('redactSpec: URL userinfo 与 token 类参数不落盘，其余原样保留', () => {
  assert.equal(redactSpec('https://user:pass@example.com/pkg.tgz'), 'https://example.com/pkg.tgz');
  assert.equal(redactSpec('https://example.com/pkg.tgz?token=abc123'), 'https://example.com/pkg.tgz?token=[redacted]');
  assert.equal(redactSpec('https://x/y.git?api_key=SECRET&a=1'), 'https://x/y.git?api_key=[redacted]&a=1');
  // git pin 形态不含凭据 → 原样（pin 本身是必须留的指纹）
  const pinned = 'github:Coco-king/dsh-x-opencode-session#2e7ce82c9fa821f63edb80f2ab641a87e1a7de3c';
  assert.equal(redactSpec(pinned), pinned);
});

// ── ③ 生效推导 ────────────────────────────────────────────────────────────

test('deriveActivated: 装得早于进程起点（含 1s 容差）算已组合；未安装/装晚了不算', () => {
  assert.equal(deriveActivated(1000, 5000), true);
  assert.equal(deriveActivated(5000, 5000), true);
  assert.equal(deriveActivated(6000, 5000), true, '容差边界（起点+1000）恰好算已组合');
  assert.equal(deriveActivated(6001, 5000), false, '超过容差 1ms 就不算已组合');
  assert.equal(deriveActivated(9000, 5000), false, '装晚于进程起点 ⇒ 本次启动没组合它');
  assert.equal(deriveActivated(0, 5000), false, '未安装（mtime=0）不是「已组合」');
});

// ── ④ 枚举 IO：夹具 + 健壮性 ──────────────────────────────────────────────

/** 造一个最小 fake DSH_HOME：profiles/<name>/package.json (+ node_modules)。 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'bootreport-tp-'));
  const web = join(home, 'profiles', 'web');
  mkdirSync(web, { recursive: true });
  writeFileSync(
    join(web, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: {
        'dsh-agent-browser': 'link:E:/alice/self-plugins/dsh-agent-browser',
        '@deepseek-ai/dsh-base': '^1.0.0',
        'dsh-x-opencode-session': 'github:Coco-king/dsh-x-opencode-session#2e7ce82',
        'some-npm-plugin': '^0.3.1',
        'never-installed': '^9.9.9',
      },
      dsh: { profile: { bundles: ['dsh-x-opencode-session'] } },
    }),
  );
  const installed = join(web, 'node_modules', 'dsh-x-opencode-session');
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'dsh-x-opencode-session', version: '0.1.0' }));
  return home;
}

test('readProfileManifest: 读出 dependencies 与 dsh.profile.bundles（坏 JSON → null 不抛）', () => {
  const home = makeHome();
  try {
    const m = readProfileManifest(join(home, 'profiles', 'web'));
    assert.ok(m);
    assert.equal(m.deps.length, 5);
    assert.deepEqual(m.bundles, ['dsh-x-opencode-session']);
    // 尸体测试：坏 manifest 不抛
    const bad = join(home, 'profiles', 'broken');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'package.json'), '{not json');
    assert.equal(readProfileManifest(bad), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('collectThirdParty: 只收第三方档；带 bundle 与 pin；未安装如实标注', () => {
  const home = makeHome();
  try {
    const { entries, counts } = collectThirdParty(home, Date.now() + 60_000);
    const names = entries.map((e) => e.name);
    assert.deepEqual(names, ['dsh-x-opencode-session', 'never-installed', 'some-npm-plugin']);
    // 自研与官方都不进第三方清单（但进 counts，便于说明「扫了多少条」）
    assert.equal(names.includes('dsh-agent-browser'), false);
    assert.equal(names.includes('@deepseek-ai/dsh-base'), false);
    assert.equal(counts['link-self'], 1);
    assert.equal(counts['official'], 1);
    assert.equal(counts['third-party-git'], 1);
    assert.equal(counts['third-party-registry'], 2);

    const pin = entries.find((e) => e.name === 'dsh-x-opencode-session');
    assert.ok(pin);
    assert.equal(pin.version, '0.1.0');
    assert.equal(pin.source, 'third-party-git');
    assert.equal(pin.bundle, true, 'bundle 形态必须被标出（它决定了挂载方式）');
    assert.equal(pin.activatedAtBoot, true);
    assert.equal(pin.spec, 'github:Coco-king/dsh-x-opencode-session#2e7ce82', 'pin 必须留在记录里');

    const missing = entries.find((e) => e.name === 'never-installed');
    assert.ok(missing);
    assert.equal(missing.version, '未安装');
    assert.equal(missing.activatedAtBoot, false);
    assert.equal(missing.bundle, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('collectThirdParty: 「装得晚于进程起点」⇒ activatedAtBoot=false（本次启动没组合它）', () => {
  const home = makeHome();
  try {
    // 进程起点取一个远早于安装时刻的时间：等价于「插件是启动之后才装的」
    const { entries } = collectThirdParty(home, Date.parse('2020-01-01T00:00:00Z'));
    const pin = entries.find((e) => e.name === 'dsh-x-opencode-session');
    assert.ok(pin);
    assert.equal(pin.activatedAtBoot, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('readInstalled / collectThirdParty: 路径不存在不抛（观测绝不反噬主流程）', () => {
  assert.deepEqual(readInstalled('E:/definitely/not/here', 'x'), { version: '未安装', mtimeMs: 0 });
  const { entries, counts } = collectThirdParty('E:/definitely/not/here', Date.now());
  assert.deepEqual(entries, []);
  assert.deepEqual(counts, {});
});

test('summarizeThirdParty: 一行里带得出 pin / 来源 / bundle / 是否已组合（tail 可读）', () => {
  const line = summarizeThirdParty({
    name: 'dsh-x-opencode-session',
    version: '0.1.0',
    spec: 'github:Coco-king/dsh-x-opencode-session#2e7ce82',
    source: 'third-party-git',
    profile: 'web',
    bundle: true,
    installedMtimeMs: 1,
    activatedAtBoot: true,
  });
  assert.match(line, /dsh-x-opencode-session@0\.1\.0/);
  assert.match(line, /\[third-party-git\]/);
  assert.match(line, /bundle=true/);
  assert.match(line, /activatedAtBoot=true/);
  assert.match(line, /#2e7ce82/);
});
