/**
 * test/evaluate-brevo-diaria-exit-code-8686.test.ts (#8686)
 *
 * Regressão do achado ao vivo na edição 260922: `evaluate-brevo-diaria.ts
 * --push` promoveu 4 contatos por taxa de abertura mas a verificação
 * pós-escrita não confirmou nenhum dos 4 (`verifyPromotedToBeehiiv`/
 * `verifyPromotedToKit` retornando `false`) — o script escreveu o store
 * normalmente (69 mantidos processados com sucesso) e terminou o run
 * inteiro, mas saía com `exit(1)`, o MESMO código de um erro FATAL
 * (`main().catch()`, nunca chegou a `writeStore()`). `brevo-diaria-run.ts`
 * (Passo 1 de `--apply`) tratava qualquer exit não-zero como "aborta a
 * sequência inteira" — Passos 2-4 nunca rodavam, e a cadeia de
 * `brevo-diaria-stage5-dispatch.ts` nunca chegava a criar o rascunho
 * Brevo da edição, mesmo com o store já refletindo o progresso real da
 * rodada. Sucesso parcial tratado como falha total.
 *
 * Este arquivo cobre a peça pura (`resolveEvaluateExitCode`) que decide o
 * exit code em `evaluate-brevo-diaria.ts::main()` — o comportamento do
 * lado `brevo-diaria-run.ts` (que consome `PARTIAL_FAILURE_EXIT_CODE`)
 * está coberto em `test/brevo-diaria-run.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PARTIAL_FAILURE_EXIT_CODE, resolveEvaluateExitCode } from "../scripts/evaluate-brevo-diaria.ts";

describe("resolveEvaluateExitCode (#8686)", () => {
  it("nenhum contato com falha/skip → exit 0", () => {
    assert.equal(resolveEvaluateExitCode({ failed: 0, kitAutoConfirmSkipped: 0 }), 0);
  });

  it("failed > 0 → PARTIAL_FAILURE_EXIT_CODE, NUNCA 1 (o código de erro fatal)", () => {
    assert.equal(resolveEvaluateExitCode({ failed: 4, kitAutoConfirmSkipped: 0 }), PARTIAL_FAILURE_EXIT_CODE);
    assert.notEqual(PARTIAL_FAILURE_EXIT_CODE, 1);
  });

  it("kitAutoConfirmSkipped > 0 (mesmo com failed=0) → PARTIAL_FAILURE_EXIT_CODE", () => {
    assert.equal(resolveEvaluateExitCode({ failed: 0, kitAutoConfirmSkipped: 2 }), PARTIAL_FAILURE_EXIT_CODE);
  });

  it("os dois > 0 → ainda PARTIAL_FAILURE_EXIT_CODE (não soma nem escala)", () => {
    assert.equal(resolveEvaluateExitCode({ failed: 4, kitAutoConfirmSkipped: 3 }), PARTIAL_FAILURE_EXIT_CODE);
  });

  it("PARTIAL_FAILURE_EXIT_CODE é distinto de 0, 1 e 2 (semântica própria)", () => {
    assert.notEqual(PARTIAL_FAILURE_EXIT_CODE, 0);
    assert.notEqual(PARTIAL_FAILURE_EXIT_CODE, 1);
    assert.notEqual(PARTIAL_FAILURE_EXIT_CODE, 2);
  });
});
