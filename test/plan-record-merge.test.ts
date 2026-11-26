import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFakeGh, fakeGhEnv, FAKE_GH_SKIP_WIN32 } from './_helpers/fake-gh.ts';
import { recordDispatch, recordMerge, mergeFindings, entries, isTerminalUnit } from '../scripts/plan-record-merge.ts';

const started = '2026-11-26T09:00:00Z';
const pull = { number: 90, headRefName: 'develop/fix-1-2', mergedAt: '2026-11-26T10:00:00Z' };
describe('develop wave lifecycle #14196', () => {
  for (const dict of [false, true]) it(`records every issue in a fused unit (dict=${dict}) without losing metadata`, () => {
    const a = { number: 1, status: 'pendente', note: 'editor' };
    const b = { number: 2, status: 'pendente' };
    const plan = { issues: dict ? { '1': a, '2': b, 'other/repo#1': { status: 'pendente' } } : [a, b] };
    recordDispatch(plan, ['1', '2'], pull.headRefName, '2', started);
    recordDispatch(plan, ['1', '2'], pull.headRefName, '2', '2026-11-26T09:30:00Z');
    const unit = entries(plan).filter(e => e.branch === pull.headRefName);
    assert.equal(unit.length, 2);
    assert.equal(unit[0].timeline?.started, started);
    assert.equal(mergeFindings(unit, pull).length, 2); // previous merged PR must block next Gate 2
    recordMerge(unit, pull, 'done');
    assert.deepEqual(mergeFindings(unit, pull), []);
    assert.equal(a.note, 'editor');
    assert.equal(a.status, 'mergeada');
    if (dict) assert.equal(entries(plan).find(e => e.ref === 'other/repo#1')?.status, 'pendente');
    recordMerge(unit, pull, 'done'); // replay preserves started
    assert.equal(unit[1].timeline?.started, started);
  });
  it('refuses unconfirmed merges, missing dispatch and invalid review', () => {
    assert.throws(() => recordMerge([], pull, 'done'));
    assert.throws(() => recordMerge([{ timeline: {} }], pull, 'done'));
    assert.throws(() => recordMerge([{ timeline: { started } }], { ...pull, mergedAt: null }, 'done'));
    assert.throws(() => recordMerge([{ timeline: { started } }], pull, ''));
  });
  it('detects incomplete terminal records and validates all refs before dispatch', () => {
    const row = { number: 1, status: 'mergeada', pr: 90, timeline: { started, merged: pull.mergedAt }, fleet_review: 'done' };
    assert.deepEqual(mergeFindings([row], pull), []);
    assert.equal(mergeFindings([{ ...row, timeline: { merged: pull.mergedAt } }], pull).length, 1);
    const plan = { issues: [{ number: 1, status: 'pendente' }] };
    assert.throws(() => recordDispatch(plan, ['1', '99'], 'branch', '1', started));
    assert.equal(entries(plan)[0].branch, undefined);
  });
});

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
it('CLI detects an unrecorded merged PR, persists the cluster and fails closed on gh errors', { skip: FAKE_GH_SKIP_WIN32 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-14196-'));
  try {
    const path = join(dir, 'plan.json');
    writeFileSync(path, JSON.stringify({ issues: { '1': { status: 'pendente', branch: pull.headRefName, timeline: { started } }, '2': { status: 'pendente', branch: pull.headRefName, timeline: { started } } }, untouched: 'keep' }));
    writeFakeGh(dir, `#!/usr/bin/env node\nif (process.env.TEST_GH_FAIL) process.exit(1);\nconst p = ${JSON.stringify(pull)};\nconsole.log(JSON.stringify(process.argv.includes('list') ? [p] : p));\n`);
    const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/plan-record-merge.ts'), ...args, '--plan', path], {
      encoding: 'utf8', env: fakeGhEnv(dir),
    });
    assert.equal(run('check').status, 1);
    assert.equal(run('--pr', '90', '--fleet-review', 'done').status, 0);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(saved.issues['2'].pr, 90);
    assert.equal(saved.untouched, 'keep');
    assert.equal(run('check').status, 0);
    saved.issues['1'].wave = saved.issues['2'].wave = '2';
    writeFileSync(path, JSON.stringify(saved));
    assert.equal(run('check').status, 1); // closed wave without coordinator estimate
    saved.wave_checkpoints = { '2': '2026-11-26T10:01:00Z' };
    writeFileSync(path, JSON.stringify(saved));
    assert.equal(run('check').status, 0);
    writeFakeGh(dir, '#!/usr/bin/env node\nprocess.exit(1);\n');
    assert.equal(run('check').status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('develop calls lifecycle checkpoints at dispatch, merge, Gate 2 and wave end', () => {
  const skill = readFileSync('.claude/skills/diaria-develop/SKILL.md', 'utf8');
  for (const command of ['plan-record-merge.ts dispatch', 'plan-record-merge.ts --plan', 'plan-record-merge.ts check', 'plan-record-merge.ts wave-end']) {
    assert.ok(skill.includes(command), command);
  }
});
describe('PR #14205 review regressions', () => {
  it('ignores a PR merged on the same fixed branch before this unit was dispatched (P1)', () => {
    const old = { number: 40, headRefName: pull.headRefName, mergedAt: '2026-11-20T10:00:00Z' };
    const unit = [{ number: 1, status: 'pendente', branch: pull.headRefName, timeline: { started } }];
    assert.deepEqual(mergeFindings(unit, old), []);
    assert.equal(mergeFindings(unit, pull).length, 1);
    recordMerge(unit, pull, 'done');
    assert.deepEqual([old, pull].flatMap(p => mergeFindings(unit, p)), []);
    // An explicitly recorded PR is still checked even if older than the dispatch.
    assert.equal(mergeFindings([{ ...unit[0], pr: 40 }], old).length, 1);
    // Without timeline.started there is no cutoff: stay fail-closed.
    assert.equal(mergeFindings([{ number: 1, status: 'pendente' }], old).length, 1);
  });
  it('treats retida-para-editor and fechada-sem-merge as terminal (P2)', () => {
    for (const status of ['retida-para-editor', 'fechada-sem-merge', 'mergeada', 'pulada', 'draft-ci-vermelho', 'entregue-fora-de-codigo']) {
      assert.ok(isTerminalUnit({ status }), status);
    }
    assert.equal(isTerminalUnit({ status: 'em-voo' }), false);
    assert.equal(isTerminalUnit({}), false);
  });
  it('CLI: old merged PR on the branch does not block check; retida wave asks for wave-end', { skip: FAKE_GH_SKIP_WIN32 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-14205-'));
    try {
      const path = join(dir, 'plan.json');
      const old = { number: 40, headRefName: pull.headRefName, mergedAt: '2026-11-20T10:00:00Z' };
      writeFakeGh(dir, `#!/usr/bin/env node\nconst a = ${JSON.stringify([old, pull])};\nconst n = Number(process.argv[process.argv.indexOf('view') + 1]);\nconsole.log(JSON.stringify(process.argv.includes('list') ? a : a.find(p => p.number === n)));\n`);
      const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/plan-record-merge.ts'), ...args, '--plan', path], {
        encoding: 'utf8', env: fakeGhEnv(dir),
      });
      writeFileSync(path, JSON.stringify({ issues: { '1': { status: 'mergeada', pr: 90, branch: pull.headRefName, timeline: { started, merged: pull.mergedAt }, fleet_review: 'done' } } }));
      const ok = run('check');
      assert.equal(ok.status, 0, ok.stderr);
      writeFileSync(path, JSON.stringify({ issues: { '3': { status: 'retida-para-editor', wave: '2' } } }));
      const retained = run('check');
      assert.equal(retained.status, 1);
      assert.match(retained.stderr, /Onda 2 concluída sem estimativa/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
