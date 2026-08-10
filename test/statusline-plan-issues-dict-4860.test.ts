/**
 * test/statusline-plan-issues-dict-4860.test.ts (#4860)
 *
 * O #4817 corrigiu `render-overnight-timeline.ts` pro shape DICT de
 * `plan.issues` (real em `data/develop/{AAMMDD}/plan.json`, apesar do
 * SKILL.md do develop dizer "reusa o schema do overnight" array). O
 * self-review do #4817/#4859 achou o MESMO mismatch, sem tratamento, em
 * `scripts/overnight-statusline.ts`: diferente do #4817 (que CRASHAVA), aqui
 * o dict shape era tratado como se fosse vazio SILENCIOSAMENTE — a barra de
 * develop desaparecia sem erro pra qualquer sessão real (que grava dict).
 *
 * Este arquivo cobre os 4 pontos do módulo que liam `plan.issues`
 * diretamente antes do #4860: `isPlanConcluded`, `cycleLabel`,
 * `renderOvernightBar`, `readTodayDevelopPlan` (via disco).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  isPlanConcluded,
  cycleLabel,
  renderOvernightBar,
  readTodayDevelopPlan,
  type Plan,
} from "../scripts/overnight-statusline.ts";

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Plan de develop real (shape observado ao vivo, #4817): dict chaveado pelo
// número da issue como string, sem campo `number` explícito.
const dictPlan = {
  started_at: "2026-08-08T13:40:00.000Z",
  issues: {
    "4800": { priority: "P2", status: "mergeada" },
    "4783": { priority: "P1", status: "pulada" },
  },
} as unknown as Plan;

describe("overnight-statusline.ts — plan.issues shape DICT (#4860)", () => {
  it("isPlanConcluded: dict com todas as issues terminais → true", () => {
    assert.equal(isPlanConcluded(dictPlan), true);
  });

  it("isPlanConcluded: dict com issue não-terminal → false", () => {
    const plan = {
      started_at: "2026-08-08T13:40:00.000Z",
      issues: { "4800": { status: "elegivel" } },
    } as unknown as Plan;
    assert.equal(isPlanConcluded(plan), false);
  });

  it("cycleLabel: dict não trata a fila como vazia (não retorna 'fila principal' por engano de shape)", () => {
    // Com 1 issue ainda não-terminal e sem `source` (depth 0), a fila segue
    // ativa — "fila principal" é a resposta CORRETA aqui, mas antes do fix
    // o resultado era o mesmo por um motivo ERRADO (issues sempre lidas como
    // []). O teste de renderOvernightBar abaixo é o que de fato expõe a
    // diferença observável.
    const plan = {
      started_at: "2026-08-08T13:40:00.000Z",
      issues: { "4800": { status: "elegivel" } },
    } as unknown as Plan;
    assert.equal(cycleLabel(plan), "fila principal");
  });

  it("renderOvernightBar: dict é lido de verdade — barra reflete progresso real, não ''", () => {
    // Antes do #4860: `!Array.isArray(plan.issues)` era true pro dict → "".
    const bar = renderOvernightBar(dictPlan);
    assert.notEqual(bar, "", "dict shape não deveria mais esconder a barra");
    assert.match(bar, /2\/2/);
    assert.match(bar, /100%/);
  });

  it("renderOvernightBar: dict com progresso parcial mostra fração correta (1/2)", () => {
    const plan = {
      started_at: "2026-08-08T13:40:00.000Z",
      issues: {
        "4800": { status: "mergeada" },
        "4783": { status: "elegivel" },
      },
    } as unknown as Plan;
    const bar = renderOvernightBar(plan);
    assert.match(bar, /1\/2/);
  });

  it("readTodayDevelopPlan: sessão com plan.json em shape dict é encontrada (não mais tratada como 'sem sessão ativa')", () => {
    const root = makeTmpDir("develop-dict-issues-4860-");
    const dir = join(root, "data", "develop", "260810");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan.json"), JSON.stringify(dictPlan), "utf8");

    const now = new Date("2026-08-10T14:00:00.000Z");
    const entry = readTodayDevelopPlan(root, now, "" /* machine_id ausente no plan — fail-open */);

    assert.notEqual(entry, null, "sessão develop com plan.json em dict não deveria mais ser invisível");
    assert.equal(entry!.id, "260810");
    assert.deepEqual(entry!.plan.issues, dictPlan.issues);
  });
});
