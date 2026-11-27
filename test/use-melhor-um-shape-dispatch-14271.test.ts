/**
 * test/use-melhor-um-shape-dispatch-14271.test.ts (#14271)
 *
 * Na 261127 o dispatch do `## um` mandou usar o `## um` anterior (uma lista)
 * como referência de formato, e o `social-writer` devolveu lista numerada para
 * um item SEM `steps`. O plano de `refresh-use-melhor-post.ts` agora manda o
 * formato derivado do item: sem `steps` → 3 parágrafos + chamada datada, sem
 * nenhuma instrução de lista nem `1)`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildUseMelhorRefreshPlan } from "../scripts/lib/use-melhor-refresh-plan.ts";
import { useMelhorUmShapeInstruction } from "../scripts/lib/use-melhor-isca.ts";
import type { UseMelhorPostStatusInput } from "../scripts/lib/use-melhor-post.ts";

const DIR = "data/editions/261127/";

function status(steps?: string[]): UseMelhorPostStatusInput {
  const item: Record<string, unknown> = { url: "https://prepara.com.br/curriculo", title: "Currículo", source_text_path: "_internal/src.txt" };
  if (steps) item.steps = steps;
  return {
    config: { enabled: true, time: "09:00" } as UseMelhorPostStatusInput["config"],
    state: { enabled: true, item } as unknown as UseMelhorPostStatusInput["state"],
    reviewedMd: "",
    approved: null,
    hasSocialSection: true,
    hasCurtoSection: true,
    socialUmMentionsBrand: false,
    carouselSlots: ["capa", "p1", "p2", "p3", "cta"],
    carouselStale: false,
    coverTitleDrift: null,
  };
}

function dispatchStep(steps?: string[]): string {
  const p = buildUseMelhorRefreshPlan({ previousUrl: "https://old.example/lista", status: status(steps) }, DIR);
  assert.equal(p.rewrite_text, true);
  const step = p.steps.find((s) => s.includes("social-writer"));
  assert.ok(step, "plano sem o passo de dispatch do social-writer");
  return step;
}

describe("dispatch do '## um' manda o formato pelo item (#14271)", () => {
  it("item SEM steps: texto corrido de 3 parágrafos + chamada datada, sem instrução de lista", () => {
    const step = dispatchStep();
    assert.match(step, /SEM steps/);
    assert.match(step, /exatamente 3 parágrafos/);
    assert.match(step, /O guia completo está na edição de 27\/11\./);
    assert.doesNotMatch(step, /lista numerada no formato/);
    assert.doesNotMatch(step, /^\s*\d+\)/m);
    assert.doesNotMatch(step, /um item por passo/);
  });

  it("item SEM steps: nunca aponta o '## um' anterior como referência de formato", () => {
    const step = dispatchStep();
    assert.doesNotMatch(step, /como referência/i);
    assert.match(step, /Não copiar o formato do '## um' que já está em 03-social\.md/);
  });

  it("steps vazio conta como sem steps", () => {
    assert.match(dispatchStep([]), /SEM steps/);
  });

  it("item COM steps: lista numerada com todos os passos", () => {
    const step = dispatchStep(["Abra o app", "Clique em X", "Salve"]);
    assert.match(step, /COM steps \(3\)/);
    assert.match(step, /lista numerada/);
    assert.doesNotMatch(step, /exatamente 3 parágrafos/);
  });

  it("formato escopado ao # Social; o # Curto mantém o próprio e fecha com 'Mais em {edition_url}'", () => {
    for (const steps of [undefined, ["Abra o app", "Salve"]]) {
      const step = dispatchStep(steps);
      assert.match(step, /Formato do '## um' no # Social \(social-writer\)/);
      assert.match(step, /# Curto \(social-curto\) mantém o formato próprio/);
      assert.match(step, /Mais em \{edition_url\}/);
      // A chamada datada não é atribuída ao # Curto.
      assert.doesNotMatch(step, /# Curto[^.]*O guia completo/);
    }
    const swap = useMelhorUmShapeInstruction({}, "261127");
    assert.match(swap, /no # Social \(social-writer\)/);
    assert.match(swap, /# Curto \(social-curto\) mantém o formato próprio/);
  });

  it("edição fora de AAMMDD: chamada genérica com DD/MM, sem inventar data", () => {
    const s = useMelhorUmShapeInstruction({}, "rascunho");
    assert.match(s, /O guia completo está na edição de DD\/MM\./);
  });
});
