import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recordDispatch, recordMerge, mergeFindings, entries } from '../scripts/plan-record-merge.ts';

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
it('CLI detects an unrecorded merged PR, persists the cluster and fails closed on gh errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-14196-'));
  try {
    const path = join(dir, 'plan.json');
    writeFileSync(path, JSON.stringify({ issues: { '1': { status: 'pendente', branch: pull.headRefName, timeline: { started } }, '2': { status: 'pendente', branch: pull.headRefName, timeline: { started } } }, untouched: 'keep' }));
    writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node\nif (process.env.TEST_GH_FAIL) process.exit(1);\nconst p = ${JSON.stringify(pull)};\nconsole.log(JSON.stringify(process.argv.includes('list') ? [p] : p));\n`, { mode: 0o755 });
    const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/plan-record-merge.ts'), ...args, '--plan', path], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
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
    writeFileSync(join(dir, 'gh'), '#!/usr/bin/env node\nprocess.exit(1);\n', { mode: 0o755 });
    assert.equal(run('check').status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('develop calls lifecycle checkpoints at dispatch, merge, Gate 2 and wave end', () => {
  const skill = readFileSync('.claude/skills/diaria-develop/SKILL.md', 'utf8');
  for (const command of ['plan-record-merge.ts dispatch', 'plan-record-merge.ts --plan', 'plan-record-merge.ts check', 'plan-record-merge.ts wave-end']) {
    assert.ok(skill.includes(command), command);
  }
});
