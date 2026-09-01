/**
 * test/hermes-openrouter-evidence-capture.test.ts (#6666)
 *
 * Guard de regressão para 2 dos itens de "O que investigar" da #6666:
 *
 * 1. "Capturar o erro real": os 3 stderr logs inspecionados na issue só
 *    tinham ruído (avisos de conector + `unrecognized_model`), sem exit
 *    code nem tempo de vida do processo — nada que permitisse diagnosticar
 *    a próxima ocorrência. O wrapper precisa registrar rc + duração em
 *    caso de falha, e manter uma cópia num path ESTÁVEL (não $$-escopado,
 *    que some assim que o PID é reciclado).
 * 2. "Revisar a classificação do exit code 4": confirma que
 *    `unrecognized_model` sozinho — que o próprio wrapper documenta como
 *    "ruído esperado de QUALQUER modelo de terceiro" — nunca alimenta
 *    SAW_CONFIG_ERROR_SIGNAL/SAW_QUOTA_SIGNAL. Já era verdade antes desta
 *    unidade (resolvido junto com #6617), mas não havia teste travando
 *    isso — sem o teste, uma edição futura pode reintroduzir o padrão sem
 *    ninguém perceber (mesma classe de regressão do #6796).
 *
 * Item 2 (reproduzir o incidente ao vivo contra a API OpenRouter) e item 3
 * (testar a hipótese de quota) do corpo da #6666 são EXPLICITAMENTE fora do
 * escopo desta unidade — exigem gasto real e execução ao vivo contra o
 * OpenRouter, proibidos no guard de publicação do dispatch overnight.
 *
 * Teste de parsing estático — não executa o CLI nem faz request de rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER_PATH = join(ROOT, "hermes/scripts/claude-openrouter.sh");

describe("captura de evidência real de falha (#6666 item 1)", () => {
  const source = readFileSync(WRAPPER_PATH, "utf8");

  it("registra o timestamp de início ANTES de invocar o CLI e computa a duração após o rc", () => {
    const startIdx = source.indexOf("ATTEMPT_START_TS=$(date +%s)");
    const outIdx = source.indexOf("OUT=$(printf");
    const rcIdx = source.indexOf("RC=$?");
    const durationIdx = source.indexOf("ATTEMPT_DURATION_S=");
    assert.ok(
      startIdx > -1 && outIdx > -1 && rcIdx > -1 && durationIdx > -1,
      "captura de início/duração não encontrada no wrapper",
    );
    assert.ok(
      startIdx < outIdx,
      "o timestamp de início precisa ser capturado ANTES de invocar o CLI, não depois",
    );
    assert.ok(
      durationIdx > rcIdx,
      "a duração precisa ser calculada DEPOIS de capturar RC (senão mede o tempo errado)",
    );
  });

  it("no caminho de falha, imprime rc + duração num log recuperável (stderr + STDERR_LOG)", () => {
    assert.ok(
      /duracao_s=\$ATTEMPT_DURATION_S/.test(source),
      "o wrapper não imprime a duração da tentativa em nenhuma mensagem de diagnóstico",
    );
    const diagIdx = source.indexOf("diagnóstico model=$MODEL rc=$RC duracao_s=$ATTEMPT_DURATION_S");
    assert.ok(diagIdx > -1, "linha de diagnóstico rc+duração não encontrada");
  });

  it("mantém uma cópia do log de falha num path ESTÁVEL (não $$-escopado)", () => {
    assert.ok(
      /claude-openrouter-last-failure\.log/.test(source),
      "não há cópia do log de falha num path fixo — o path $$-escopado " +
        "(claude-openrouter-attempt.$$.log) some assim que o PID é reciclado " +
        "ou /tmp é limpo, tornando a evidência irrecuperável na prática (#6666 item 1).",
    );
  });

  it("o path ESTÁVEL contém a própria linha de diagnóstico (rc+duração), não só o attempt log de antes dela (review #6808)", () => {
    // Achado do review da PR #6808 (P2, confiança alta): a linha de
    // diagnóstico só era apendada ao STDERR_LOG ($$-escopado, some com o
    // processo) — o cp para o path estável rodava sobre o ATTEMPT_LOG de
    // ANTES da linha de diagnóstico ser escrita nele, então o único arquivo
    // que sobrevive ao PID não continha o dado que o #6666 item 1 existe
    // pra preservar. A linha de diagnóstico precisa ser apendada ao
    // ATTEMPT_LOG ANTES do `cp` pro path estável.
    const diagAppendToAttemptIdx = source.indexOf(
      'echo "[claude-openrouter] diagnóstico model=$MODEL rc=$RC duracao_s=$ATTEMPT_DURATION_S timeout_s=$TIMEOUT bytes_stdout=$BYTES_STDOUT bytes_stderr=$BYTES_STDERR" >> "$ATTEMPT_LOG"',
    );
    const cpIdx = source.indexOf('cp -f "$ATTEMPT_LOG" "${TMPDIR:-/tmp}/claude-openrouter-last-failure.log"');
    assert.ok(
      diagAppendToAttemptIdx > -1,
      "a linha de diagnóstico não é apendada ao ATTEMPT_LOG — o path estável " +
        "vai continuar sem rc+duração mesmo com o resto do fix presente",
    );
    assert.ok(cpIdx > -1, "cópia pro path estável não encontrada");
    assert.ok(
      diagAppendToAttemptIdx < cpIdx,
      "a linha de diagnóstico precisa ser apendada ao ATTEMPT_LOG ANTES do cp " +
        "pro path estável — na ordem inversa, o cp continua capturando o " +
        "estado de ANTES do diagnóstico existir",
    );
  });
});

describe("unrecognized_model nunca alimenta a classificação de exit code (#6666 item 2, já resolvido junto com #6617)", () => {
  const source = readFileSync(WRAPPER_PATH, "utf8");

  it("'unrecognized_model' só aparece em comentários e no filtro de ruído do terminal, nunca num grep -q classificador", () => {
    // Todo grep -q{i,}E de classificação (os que setam SAW_*_SIGNAL) fica
    // dentro do bloco entre "Classificar o motivo desta tentativa" e o
    // fechamento do loop (`rm -f "$ATTEMPT_LOG"`). Nenhum desses padrões
    // pode conter "unrecognized_model" — o próprio wrapper documenta esse
    // sinal como ruído esperado de QUALQUER modelo de terceiro, incapaz de
    // distinguir válido de inválido (linhas 165-170 do wrapper, achado
    // original da #6666: até o modelo PAGO válido `glm-5.3-flash` recebeu
    // esse sinal).
    const classifyStart = source.indexOf("Classificar o motivo desta tentativa");
    const loopEnd = source.indexOf('rm -f "$ATTEMPT_LOG" "$STDERR_ONLY_LOG"');
    assert.ok(classifyStart > -1 && loopEnd > classifyStart, "bloco de classificação não encontrado");
    const classifyBlock = source.slice(classifyStart, loopEnd);

    const classifyGreps = [...classifyBlock.matchAll(/grep -q[iE]*\s+"[^"]*"/g)].map((m) => m[0]);
    assert.ok(classifyGreps.length > 0, "nenhum grep -q classificador encontrado no bloco — regex de extração desatualizada?");
    for (const grep of classifyGreps) {
      assert.ok(
        !grep.includes("unrecognized_model"),
        `um dos greps de classificação usa 'unrecognized_model' como sinal (${grep}) — isso é ` +
          "ruído esperado de QUALQUER modelo de terceiro (não distingue válido de inválido), " +
          "reabriria o bug diagnosticado na #6666.",
      );
    }
  });
});
