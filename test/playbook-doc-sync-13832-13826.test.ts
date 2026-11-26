/**
 * #13832 / #13826 — prosa de playbook que ficou atrás do código.
 *
 * #13832: desde o #13828 o `check-disk-space-guard.ts` descarta com resgate os
 * preservados `descartavel` quando o disco segue baixo depois do cleanup; o
 * passo 2 do `/diaria-overnight` ainda dizia que sujo "nunca sai".
 * #13826: os re-dispatches do `writer-destaque` no Stage 2 citavam "tende a"/
 * "à medida que" sem o limite de 1 marca por destaque (#13766).
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const overnight = readFileSync(new URL('../.claude/skills/diaria-overnight/SKILL.md', import.meta.url), 'utf8');
const stage2 = readFileSync(new URL('../.claude/agents/orchestrator-stage-2.md', import.meta.url), 'utf8');
const guardScript = readFileSync(new URL('../scripts/check-disk-space-guard.ts', import.meta.url), 'utf8');

test('passo 2 do overnight cita o descarte com resgate do disk-guard (#13832)', () => {
  const guardLine = overnight.split('\n').find((l) => l.includes('Guard de espaço livre antes de abrir cada ONDA')) ?? '';
  assert.ok(guardLine, 'linha do guard de espaço livre não encontrada');
  assert.match(guardLine, /triage-preserved-worktrees\.ts --discard/);
  assert.match(guardLine, /data\/worktree-rescue\/\{AAAA-MM-DD\}\/\{nome\}\//);
  assert.match(guardLine, /`descartavel`/);
  for (const fora of [/PR aberta/, /sessão viva/, /lock ativo/, /branch sem PR/, /parado há menos que o mínimo/]) {
    assert.match(guardLine, fora);
  }
  // O código que a prosa descreve continua lá (se sair, a prosa fica errada de novo).
  assert.match(guardScript, /discardPreserved/);
});

test('re-dispatches do Stage 2 levam o limite de 1 marca de previsão (#13766, #13826)', () => {
  const sites = stage2.split('previsão só com "tende a"/"à medida que"').slice(1);
  assert.equal(sites.length, 2, 'esperados os 2 re-dispatches (min-chars e why-matters-length)');
  for (const after of sites) {
    assert.match(after.slice(0, 120), /^, no máximo 1 marca por destaque, só no "Por que isso importa" \(#13766\)/);
  }
});
