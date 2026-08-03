/**
 * test/send-monthly-apoiadores.test.ts (#4521)
 *
 * `APOIADORES_TARGET_SEGMENT_NAMES` é derivado de `APOIO_SEGMENTS_CANONICAL`
 * (`scripts/lib/apoio-segments-canonical.ts`, #4436) em vez de strings
 * hardcoded de novo — este teste trava que o filtro continua pegando
 * EXATAMENTE os 2 segmentos-alvo (decisão 2 do #4482: só Mantenedor/Patrono,
 * nunca Amigo/Apoiador/Todos/Nenhum nem a base inteira) mesmo se a lista
 * canônica for reordenada ou ganhar segmentos novos no futuro.
 *
 * Não testamos `main()`/`renderMonthlyBeehiivEmail` fim-a-fim aqui: os dois
 * resolvem `monthlyDir(cycle)` contra o `data/monthly/` REAL (junction pro
 * OneDrive de produção neste worktree) — mesma limitação já aceita por
 * `test/render-monthly-beehiiv.test.ts`, que testa as peças puras
 * (`missingImageKeys`, `draftToEmailBeehiiv`, `buildRelink`) em vez do CLI
 * inteiro. A idempotência/dedup (a lógica nova desta issue) é 100% pura e
 * está coberta em `test/monthly-apoiadores-state.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { APOIADORES_TARGET_SEGMENT_NAMES } from "../scripts/send-monthly-apoiadores.ts";

test("APOIADORES_TARGET_SEGMENT_NAMES: exatamente Mantenedor + Patrono (decisão 2 do #4482)", () => {
  assert.deepEqual([...APOIADORES_TARGET_SEGMENT_NAMES].sort(), ["Apoio — Mantenedor", "Apoio — Patrono"]);
});

test("APOIADORES_TARGET_SEGMENT_NAMES: nunca inclui Amigo/Apoiador/Todos/Nenhum", () => {
  for (const forbidden of ["Apoio — Amigo", "Apoio — Apoiador", "Apoio — Todos", "Apoio — Nenhum"]) {
    assert.ok(!APOIADORES_TARGET_SEGMENT_NAMES.includes(forbidden), `${forbidden} não deveria estar no envio extra`);
  }
});
