/**
 * test/stage6-sem-linkedin-pessoal-11398.test.ts
 *
 * #11398 (pedido do editor, 27/10/2026): o 4º post (USE MELHOR, `## um`) não
 * sai mais no LinkedIn PESSOAL (vjpixel). Trava os três pontos que faziam ele
 * sair, para o post não voltar por uma edição de playbook ou do registro:
 *   1. o Stage 6 não roda o pré-gate (`resolve-post-pixel.ts`,
 *      `publish-linkedin-personal.ts --check`) nem arma (`--arm`);
 *   2. o gate de §6c não tem o bloco de lembrete do post pessoal;
 *   3. nenhuma task habilitada do registro dispara `publish-linkedin-personal.ts`
 *      (sem isso, uma intenção armada antes da mudança ainda sairia).
 * E o alarme do token deixou de avaliar intenções (sobra armada viraria P1 falso).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("Stage 6 sem o post pessoal do LinkedIn (#11398)", () => {
  const stage6 = read(".claude/agents/orchestrator-stage-6.md");

  it("não roda resolve-post-pixel nem publish-linkedin-personal (--check/--arm)", () => {
    assert.doesNotMatch(stage6, /npx tsx scripts\/resolve-post-pixel\.ts/);
    assert.doesNotMatch(stage6, /npx tsx scripts\/publish-linkedin-personal\.ts/);
    assert.doesNotMatch(stage6, /PERSONAL_AUTO/);
  });

  it("o gate não tem o lembrete do post pessoal", () => {
    assert.doesNotMatch(stage6, /LEMBRETE \(nao bloqueia\) — post pessoal/);
    assert.doesNotMatch(stage6, /POST_PIXEL_(TEXT|IMAGE|AT)/);
    assert.doesNotMatch(stage6, /Agende manualmente no LinkedIn PESSOAL/);
  });

  it("nenhuma task habilitada dispara publish-linkedin-personal.ts", () => {
    const firing = SCHEDULED_TASKS.filter(
      (t) => t.enabled !== false && t.steps.some((s) => s.script === "scripts/publish-linkedin-personal.ts"),
    ).map((t) => t.name);
    assert.deepEqual(firing, []);
  });

  it("o alarme do token não avalia mais intenções armadas", () => {
    const alarm = read("scripts/linkedin-personal-token-alarm.ts");
    assert.doesNotMatch(alarm, /evaluatePersonalIntents\(/);
  });
});
