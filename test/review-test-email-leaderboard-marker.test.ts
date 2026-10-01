/**
 * test/review-test-email-leaderboard-marker.test.ts (#9247)
 *
 * O check 19 do `review-test-email` procurava "Liderança", texto que o
 * renderer nunca emitiu — falso `email:leaderboard_missing` em toda edição
 * com pódio. Este teste amarra os marcadores citados no prompt ao HTML real
 * de `renderLeaderboardTop1Row`: se o renderer mudar o texto do bloco, ou o
 * prompt voltar a citar uma string que não sai no e-mail, o teste quebra.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderLeaderboardTop1Row } from "../scripts/lib/newsletter-render-html.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prompt = readFileSync(resolve(ROOT, ".claude/agents/review-test-email.md"), "utf8");

function check19Markers(): string[] {
  const line = prompt.split("\n").find((l) => l.startsWith("**19."));
  assert.ok(line, "check 19 não encontrado no prompt");
  const m = line.match(/marcadores (.+?) aparece no body/);
  assert.ok(m, "check 19 deve listar os marcadores entre 'marcadores' e 'aparece no body'");
  const markers = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.ok(markers.length > 0, "check 19 sem marcador entre aspas");
  return markers;
}

describe("review-test-email check 19 — marcador do leaderboard (#9247)", () => {
  it("não cita mais 'Liderança' (string que o renderer nunca emitiu)", () => {
    assert.ok(!check19Markers().includes("Liderança"));
  });

  for (const [label, eia] of [
    ["podium", { leaderboardPodium: [{ nickname: "Ana", rank: 1 }, { nickname: "Bia", rank: 2 }], leaderboardPeriod: "Setembro", leaderboardPeriodSlug: "2026-09" }],
    ["top1 legado", { leaderboardTop1: [{ nickname: "Ana" }], leaderboardPeriod: "Setembro" }],
  ] as const) {
    it(`algum marcador do prompt aparece no HTML renderizado (${label})`, () => {
      const html = renderLeaderboardTop1Row(eia as never, "");
      const markers = check19Markers();
      assert.ok(
        markers.some((mk) => html.includes(mk)),
        `nenhum de ${JSON.stringify(markers)} aparece no HTML do renderer: ${html}`,
      );
    });
  }
});
