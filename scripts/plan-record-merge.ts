#!/usr/bin/env npx tsx
/** Develop lifecycle checkpoints (#14196). Run from the coordinator, never merges a PR. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { isMainModule, parseArgs } from './lib/cli-args.ts';
import { normalizeIssues } from './lib/plan-issues-normalize.ts';
import { planEntryKey, planEntryRef } from './lib/plan-issue-ref.ts';
import { PR_ACCOUNTED_STATUSES } from './lib/pr-terminal-state.ts';

type Entry = { number?: number; ref?: string; repo?: string; status?: string; pr?: number; branch?: string; wave?: string; timeline?: { started?: string; merged?: string }; fleet_review?: string; [key: string]: unknown };
type Plan = { issues: Entry[] | Record<string, Entry>; [key: string]: unknown };
export type Pull = { number: number; headRefName: string; mergedAt: string | null };

// Dict normalization returns copies: map them back to the original writable entries.
export function entries(plan: Plan): Entry[] {
  if (!plan?.issues || typeof plan.issues !== 'object') throw new Error('plan.issues ausente ou inválido');
  const normalized = normalizeIssues<Entry>(plan);
  return Array.isArray(plan.issues) ? normalized : Object.values(plan.issues).map((entry, i) => {
    const identity = normalized[i];
    return Object.assign(entry, { number: identity.number }, identity.ref ? { ref: identity.ref } : {});
  });
}
export function recordDispatch(plan: Plan, refs: string[], branch: string, wave: string, at: string): void {
  const rows = entries(plan);
  const selected = refs.map(ref => {
    const key = planEntryKey(ref);
    const row = rows.find(e => planEntryKey(e) === key);
    if (!key || !row) throw new Error(`Issue fora do plano: ${ref}`);
    return row;
  });
  if (!branch || !wave || !selected.length) throw new Error('Dispatch exige --issues, --branch e --wave');
  if (new Set(selected.map(e => planEntryRef(e)?.repo)).size !== 1) throw new Error('Unidade mistura repos');
  for (const row of selected) {
    if (row.status === 'mergeada') throw new Error('Issue já mergeada');
  }
  for (const row of selected) {
    row.branch = branch;
    row.wave = wave;
    row.timeline = { ...row.timeline, started: row.timeline?.started ?? at };
  }
}
/** Terminal unit statuses: the shared PR set (#10430) plus the two that close a unit without a PR. */
export const TERMINAL_UNIT_STATUSES: ReadonlySet<string> = new Set([...PR_ACCOUNTED_STATUSES, 'pulada', 'entregue-fora-de-codigo']);
export function isTerminalUnit(e: Entry): boolean {
  return TERMINAL_UNIT_STATUSES.has(e.status ?? '');
}
export function mergeFindings(rows: Entry[], pull: Pull): string[] {
  if (!pull.mergedAt) return [];
  // Develop branch names are fixed (`develop/fix-N`): a PR merged on the same
  // branch before this unit's dispatch belongs to an earlier session, unless
  // the plan explicitly recorded it (PR #14205 review, P1).
  const starts = rows.map(e => Date.parse(e.timeline?.started ?? '')).filter(Number.isFinite);
  const recorded = rows.some(e => e.pr === pull.number);
  if (!recorded && starts.length === rows.length && Date.parse(pull.mergedAt) < Math.min(...starts)) return [];
  return rows.filter(e => e.status !== 'mergeada' || e.pr !== pull.number ||
    e.timeline?.merged !== pull.mergedAt || !e.timeline?.started || !e.fleet_review?.trim())
    .map(e => `${planEntryKey(e)}: PR #${pull.number} mergeada sem registro completo`);
}
export function recordMerge(rows: Entry[], pull: Pull, review: string): void {
  if (!pull.mergedAt || !rows.length) throw new Error('PR não mergeada ou unidade não registrada no dispatch');
  if (review !== 'done' && !/^skipped: \S.*$/.test(review)) throw new Error('Passe --fleet-review done ou skipped: motivo');
  if (rows.some(e => !e.timeline?.started)) throw new Error('timeline.started ausente; recuperar horário real do dispatch');
  for (const row of rows) {
    row.status = 'mergeada'; row.pr = pull.number; row.fleet_review = review;
    row.timeline = { ...row.timeline, merged: pull.mergedAt };
  }
}
function gh(args: string[]): unknown {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', timeout: 30000 }));
}
function savePlan(path: string, plan: Plan): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(plan, null, 2) + '\n');
  renameSync(tmp, path);
}
function main(): void {
  const { values, positional } = parseArgs(process.argv.slice(2));
  if (!values.plan) throw new Error('Passe --plan caminho');
  const path = resolve(values.plan);
  const plan = JSON.parse(readFileSync(path, 'utf8')) as Plan;
  const action = positional[0] ?? 'merge';
  if (action === 'dispatch') {
    recordDispatch(plan, (values.issues ?? '').split(',').filter(Boolean), values.branch, values.wave, new Date().toISOString());
  } else {
    const rows = entries(plan);
    const groups = new Map<string, Entry[]>();
    for (const row of rows) {
      const repo = planEntryRef(row)?.repo;
      if (!row.branch || !repo) continue;
      const key = `${repo}|${row.branch}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    if (action === 'check' || action === 'wave-end') {
      const findings: string[] = [];
      for (const [key, unit] of groups) {
        const [repo, branch] = key.split('|');
        const pulls = gh(['pr', 'list', '-R', repo, '--head', branch, '--state', 'merged', '--json', 'number,headRefName,mergedAt', '--limit', '100']) as Pull[];
        // Merge trains close original PRs without merging their branches. Verify
        // the explicitly recorded train PR too, scoped to this repo.
        for (const pr of new Set(unit.map(e => e.pr).filter((n): n is number => typeof n === 'number'))) {
          if (!pulls.some(p => p.number === pr)) {
            const pull = gh(['pr', 'view', String(pr), '-R', repo, '--json', 'number,headRefName,mergedAt']) as Pull;
            if (!pull.mergedAt) throw new Error(`PR #${pr} registrada como mergeada, mas não mergeou`);
            pulls.push(pull);
          }
        }
        for (const pull of pulls) findings.push(...mergeFindings(unit, pull));
      }
      if (findings.length) throw new Error(findings.join('\n'));
      if (action === 'check') {
        const checkpoints = (plan.wave_checkpoints ?? {}) as Record<string, string>;
        for (const wave of new Set(rows.map(e => e.wave).filter((w): w is string => !!w))) {
          const unit = rows.filter(e => e.wave === wave);
          if (unit.every(isTerminalUnit) && !checkpoints[wave]) {
            throw new Error(`Onda ${wave} concluída sem estimativa: execute wave-end --wave ${wave}`);
          }
        }
      }
      if (action === 'wave-end') {
        if (!values.wave) throw new Error('Passe --wave id');
        const unit = rows.filter(e => e.wave === values.wave);
        if (!unit.length || !unit.every(isTerminalUnit)) {
          throw new Error('Onda ainda tem unidade em voo ou não existe');
        }
        execFileSync(process.execPath, ['--import', 'tsx', resolve(import.meta.dirname, 'coordinator-usage-estimate.ts'),
          '--plan', path, '--agent', 'develop', '--phase', `onda ${values.wave}`], { stdio: 'inherit' });
        plan.wave_checkpoints = { ...(plan.wave_checkpoints as Record<string, string> ?? {}), [values.wave]: new Date().toISOString() };
        savePlan(path, plan);
      }
      console.log('plan-record-merge: registros de merge completos');
      return;
    }
    if (action !== 'merge' || !/^\d+$/.test(values.pr ?? '')) throw new Error('Use dispatch, check ou merge --pr N');
    const repo = values.repo ?? 'vjpixel/diaria-studio';
    const pull = gh(['pr', 'view', values.pr, '-R', repo, '--json', 'number,headRefName,mergedAt']) as Pull;
    recordMerge(groups.get(`${repo}|${values.branch ?? pull.headRefName}`) ?? [], pull, values['fleet-review'] ?? '');
  }
  savePlan(path, plan);
}
if (isMainModule(import.meta.url)) {
  try { main(); } catch (error) { console.error(`plan-record-merge: ${(error as Error).message}`); process.exitCode = 1; }
}
