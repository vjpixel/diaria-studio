/**
 * test/poll-shared-mirror-4054.test.ts (#4054, regressão #633)
 *
 * Até o #14053 este arquivo também travava as cópias locais de
 * `session-cookie.ts`, `subscriber-verify.ts` e `rate-limit.ts` em
 * `workers/poll/src/`. O Worker passou a importar direto de
 * `scripts/lib/shared/` e as cópias foram apagadas; o comportamento desses
 * módulos segue coberto por `test/lib-shared-session-cookie.test.ts` e
 * `test/lib-shared-subscriber-verify.test.ts`. Fica só o espelho de
 * `isOwnWorkOnlyCredit`, cuja origem é `scripts/eia-compose.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isOwnWorkOnlyCredit as originIsOwnWorkOnlyCredit } from "../scripts/eia-compose.ts";
import { isOwnWorkOnlyCredit as mirrorIsOwnWorkOnlyCredit } from "../workers/poll/src/lib.ts";

// #4258 item 2: `isOwnWorkOnlyCredit` — mesmo mecanismo de espelhamento
// acima, mas a origem é `scripts/eia-compose.ts` (não `scripts/lib/shared/`,
// já que este predicado é específico do domínio "É IA?", não genérico o
// bastante pra viver em shared/) — mesmo motivo de fundo (bundle do Worker
// não alcança scripts/**). Achado do review consolidado (3 agentes
// convergentes): sem este teste, um synonym adicionado só de um lado (ex:
// 4ª variante localizada de "Own work") driftaria em silêncio — a origem
// suprimiria o synonym novo em composições futuras, mas o Worker continuaria
// exibindo-o pra qualquer edição já gravada no KV, sem nenhum sinal de CI.
describe("#4258 item 2 — espelho de isOwnWorkOnlyCredit não pode driftar", () => {
  const cases = [
    "Own work",
    "own work",
    "OWN WORK",
    "  Own work  ",
    "Trabalho próprio",
    "Self-photographed",
    "Tisha Mukherjee",
    "Own work by Jane Doe",
    "",
    "Unknown",
  ];

  it("mesma saída pros dois lados, pra cada caso", () => {
    for (const input of cases) {
      assert.equal(
        mirrorIsOwnWorkOnlyCredit(input),
        originIsOwnWorkOnlyCredit(input),
        `input=${JSON.stringify(input)}`,
      );
    }
  });
});
