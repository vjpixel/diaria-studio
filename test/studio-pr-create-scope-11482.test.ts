import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { studioPrCreateCwd } from '../.claude/hooks/lib/studio-pr-create-scope.mjs';
// @ts-expect-error -- hook .mjs sem .d.mts, como nos testes pr-create-review-hook-budget.
import { isForeignRepoPrUrl } from '../.claude/hooks/pr-create-review.mjs';

const root = resolve('.');
const hooks = join(root, '.claude/hooks');

it('#11482: Studio scope accepts local PRs and all canonical foreign flags without an allowlist', () => {
  assert.equal(studioPrCreateCwd('gh pr create --title x', root, hooks), root);
  assert.equal(studioPrCreateCwd('gh pr create -R vjpixel/diaria-studio', root, hooks), root);
  for (const flag of ['-R vjpixel/fluxo-criativo', '--repo vjpixel/fluxo-criativo', '--repo=vjpixel/fluxo-criativo', '-Rvjpixel/fluxo-criativo']) {
    assert.equal(studioPrCreateCwd(`gh pr create ${flag}`, root, hooks), null);
  }
  assert.equal(studioPrCreateCwd('gh pr create --body "-R vjpixel/fluxo-criativo"', root, hooks), root);
  assert.equal(studioPrCreateCwd('gh pr create -R "$REPO"', root, hooks), root);
  assert.equal(studioPrCreateCwd('gh pr create -R vjpixel/fluxo-criativo && gh pr create', root, hooks), root);
  assert.equal(isForeignRepoPrUrl('https://github.com/vjpixel/fluxo-criativo/pull/1'), true);
  assert.equal(isForeignRepoPrUrl('https://github.com/vjpixel/diaria-studio/pull/1'), false);
});

it('#11482: CLI hooks skip foreign PRs/cwds before running checks; local stale snapshot still denies', () => {
  const temp = mkdtempSync(join(tmpdir(), 'studio-pr-scope-'));
  try {
    execFileSync('git', ['init', '--quiet', temp]);
    assert.equal(studioPrCreateCwd('gh pr create', temp, hooks), null);
    const bin = join(temp, 'bin');
    mkdirSync(bin);
    const marker = join(temp, 'called');
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\nprintf called > "$SCOPE_MARKER"\nexit 1\n');
    chmodSync(join(bin, 'npx'), 0o755);
    const run = (hook: string, command: string, cwd: string) => spawnSync(process.execPath, [join(hooks, hook)], {
      input: JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }),
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SCOPE_MARKER: marker },
    });
    for (const hook of ['block-pr-create-orchestrator-snapshot-stale.mjs', 'block-pr-create-tsc-failure.mjs', 'block-pr-create-test-runner-import.mjs']) {
      for (const [command, cwd] of [
        ['gh pr create -R vjpixel/fluxo-criativo --title x', root],
        ['gh pr create --repo=vjpixel/fluxo-criativo', root],
        ['gh pr create', temp],
        [`cd '${temp}' && gh pr create`, root],
      ]) {
        const result = run(hook, command, cwd);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, '', `${hook}: ${command}`);
      }
    }
    assert.equal(existsSync(marker), false, 'foreign PRs must not execute npx');
    const local = run('block-pr-create-orchestrator-snapshot-stale.mjs', 'gh pr create -R vjpixel/diaria-studio', root);
    assert.equal(JSON.parse(local.stdout).hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
