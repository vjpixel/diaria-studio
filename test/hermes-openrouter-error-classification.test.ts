/**
 * test/hermes-openrouter-error-classification.test.ts (#6696)
 *
 * Guard de regressao contra 3 findings do review consolidado do range
 * `5bad85fc..3dd36e8d` sobre `hermes/scripts/claude-openrouter.sh`, onde o
 * commit do #6666 (budget/stdout-capture) reintroduziu um mascaramento que o
 * #6617 (config-inválida vs rate-limit) tinha acabado de remover:
 *
 * 1. "Exceeded USD budget" é DETERMINÍSTICO para um dado BUDGET — o mesmo
 *    prompt estoura em todo run até o valor mudar. Classificar isso como
 *    SAW_QUOTA_SIGNAL (transitório, "reset resolve sozinho") é a leitura
 *    errada que o exit 4 do #6617 existe pra evitar. Deve setar
 *    SAW_CONFIG_ERROR_SIGNAL.
 * 2. O grep de config-inválida/rate-limit rodava sobre o ATTEMPT_LOG DEPOIS
 *    de `$OUT` (texto gerado pelo MODELO) ter sido anexado — como este
 *    wrapper roda dentro deste checkout, onde as tarefas falam de "model not
 *    found"/"rate limit" (o próprio assunto das issues #6617/#6666), uma
 *    resposta parcial do modelo discutindo o bug podia disparar um exit 4
 *    espúrio. Os dois greps devem classificar contra um snapshot PURO de
 *    stderr, capturado ANTES do stdout ser anexado.
 * 3. O filtro de ruído (`grep -vE ... >&2`) rodava incondicionalmente ANTES
 *    do check de sucesso — mesmo um run bem-sucedido duplicava a resposta
 *    inteira do modelo em stderr (já que o ATTEMPT_LOG continha `$OUT`
 *    quando o filtro rodava). Deve rodar só no caminho de FALHA.
 *
 * Teste de parsing estático (não executa o CLI) — mesma técnica de
 * test/hermes-budget-guard.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER_PATH = join(ROOT, "hermes/scripts/claude-openrouter.sh");

describe("classificação de erro do wrapper OpenRouter (#6696)", () => {
  const source = readFileSync(WRAPPER_PATH, "utf8");

  it("finding 1: o elif de budget-exceeded seta SAW_CONFIG_ERROR_SIGNAL, não SAW_QUOTA_SIGNAL", () => {
    // #6796: o padrão migrou de prosa frouxa pra string literal do CLI.
    const budgetElifIdx = source.indexOf('elif command grep -qE "Exceeded USD budget"');
    assert.ok(budgetElifIdx > -1, "elif de budget-exceeded não encontrado");
    // A próxima ocorrência de SAW_*_SIGNAL= depois deste elif é a que ele seta.
    const nextConfigSignal = source.indexOf("SAW_CONFIG_ERROR_SIGNAL=1", budgetElifIdx);
    const nextQuotaSignal = source.indexOf("SAW_QUOTA_SIGNAL=1", budgetElifIdx);
    assert.ok(
      nextConfigSignal > budgetElifIdx &&
        (nextQuotaSignal === -1 || nextConfigSignal < nextQuotaSignal),
      "budget-exceeded deveria setar SAW_CONFIG_ERROR_SIGNAL=1 logo após o elif " +
        "(é determinístico pro mesmo BUDGET — classificar como quota faz o " +
        "watchdog/consumidor ler 'transitório, reset resolve' quando na real " +
        "precisa de correção manual do valor, #6696 finding 1).",
    );
  });

  it("finding 2: os greps de config-inválida e rate-limit classificam contra um snapshot puro de stderr, não o ATTEMPT_LOG combinado com stdout", () => {
    const modelNotFoundElif = /elif command grep -qiE "model not found[^"]*" "(\$\w+)"/.exec(source);
    assert.ok(modelNotFoundElif, "elif de config-inválida (model not found) não encontrado");
    assert.notEqual(
      modelNotFoundElif![1],
      "$ATTEMPT_LOG",
      "o grep de config-inválida não pode classificar contra $ATTEMPT_LOG depois do stdout do " +
        "modelo ser anexado — uma resposta do modelo discutindo 'model not found' " +
        "(assunto real deste checkout) dispararia exit 4 espúrio (#6696 finding 2).",
    );

    const rateLimitElif = /elif command grep -qiE "rate\.\?limit[^"]*" "(\$\w+)"/.exec(source);
    assert.ok(rateLimitElif, "elif de rate-limit não encontrado");
    assert.notEqual(
      rateLimitElif![1],
      "$ATTEMPT_LOG",
      "o grep de rate-limit não pode classificar contra $ATTEMPT_LOG combinado com stdout, " +
        "mesmo motivo do finding 2 acima.",
    );

    // O snapshot precisa ser tirado ANTES do stdout ser anexado ao ATTEMPT_LOG.
    const snapshotIdx = source.indexOf(`cp "$ATTEMPT_LOG" "${modelNotFoundElif![1]}"`);
    const appendIdx = source.indexOf('echo "$OUT" >> "$ATTEMPT_LOG"');
    assert.ok(
      snapshotIdx > -1 && appendIdx > -1,
      "não encontrei o snapshot do stderr puro nem o append do stdout no wrapper",
    );
    assert.ok(
      snapshotIdx < appendIdx,
      "o snapshot do stderr puro precisa ser tirado ANTES de `$OUT` ser anexado ao " +
        "ATTEMPT_LOG — senão o snapshot já contém o stdout do modelo, reintroduzindo o bug.",
    );
  });

  it("finding 2 (regressão inversa): o grep de budget-exceeded continua vendo o STDOUT (precisa, #6666)", () => {
    // O budget error do CLI vai pro stdout — não pode migrar pro snapshot
    // stderr-only, senão o #6666 volta a quebrar.
    const budgetElif = /elif command grep -qE "Exceeded USD budget" "(\$\w+)"/.exec(source);
    assert.ok(budgetElif, "elif de budget-exceeded não encontrado");
    assert.equal(
      budgetElif![1],
      "$ATTEMPT_LOG",
      "o grep de budget-exceeded precisa continuar vendo o ATTEMPT_LOG combinado " +
        "(stdout+stderr) — 'Exceeded USD budget' vai pro STDOUT (#6666); mover isso " +
        "pro snapshot stderr-only reintroduziria o bug original.",
    );
  });

  it("#6796: o padrão de budget-exceeded não casa prosa PT-BR do modelo discutindo orçamento", () => {
    // Extrai o padrão de grep -E literal usado pelo wrapper e confirma que
    // uma resposta gerada pelo modelo discutindo o próprio bug de budget
    // (assunto real deste checkout, #6712/#6716/#6791) não casa — só o
    // texto EXATO que o CLI emite deve casar.
    const budgetElif = /elif command grep -qE "([^"]+)" "\$ATTEMPT_LOG"/.exec(source);
    assert.ok(budgetElif, "elif de budget-exceeded não encontrado");
    const pattern = new RegExp(budgetElif![1]);
    assert.ok(
      pattern.test("Exceeded USD budget (0.31 spent)"),
      "o padrão precisa continuar casando o texto literal que o CLI emite",
    );
    assert.ok(
      !pattern.test("o job excedeu o budget de tokens configurado para esta rodada"),
      "o padrão não pode casar prosa PT-BR gerada pelo modelo mencionando budget — " +
        "esse é o cenário de falso-positivo do #6796 (exit 4 espúrio sobre modelos sãos)",
    );
    assert.ok(
      !pattern.test("this session exceeded its budget for the task and had to stop early"),
      "o padrão não pode casar prosa EM INGLÊS parafraseando o erro (não o texto literal do CLI)",
    );
  });

  it("finding 3: o filtro de ruído (grep -vE ... >&2) roda DEPOIS do check de sucesso, não antes", () => {
    const successCheckIdx = source.indexOf('if [ $RC -eq 0 ] && [ -n "$OUT" ]; then');
    const noiseFilterIdx = source.indexOf(
      'command grep -vE "not a model this version|unrecognized_model|connectors are disabled" "$ATTEMPT_LOG" >&2',
    );
    assert.ok(
      successCheckIdx > -1 && noiseFilterIdx > -1,
      "não encontrei o check de sucesso ou o filtro de ruído no wrapper",
    );
    assert.ok(
      noiseFilterIdx > successCheckIdx,
      "o filtro de ruído roda ANTES do check de sucesso — isso duplica a resposta " +
        "inteira do modelo em stderr mesmo num run bem-sucedido (o ATTEMPT_LOG já " +
        "contém $OUT quando o filtro roda incondicionalmente, #6696 finding 3).",
    );
  });
});
