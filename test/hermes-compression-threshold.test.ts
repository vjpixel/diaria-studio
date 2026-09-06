/**
 * test/hermes-compression-threshold.test.ts (#7527)
 *
 * Teste de regressão pedido explicitamente pela issue ("Verificação
 * sugerida"): dado um nome de modelo e uma janela real conhecida, o
 * threshold efetivo tem que ficar abaixo dela — nunca reproduzir o estado
 * em que a compressão nunca dispara e o Ollama trunca em silêncio.
 *
 * Não depende de GPU, Ollama ou do Hermes core (Python, fora deste repo) —
 * exercita só a reimplementação pura da fórmula de derivação
 * (`scripts/lib/hermes-compression-threshold.ts`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_THRESHOLD_FRACTION,
  deriveCompressionThreshold,
  isThresholdSafeAgainstRealWindow,
} from "../scripts/lib/hermes-compression-threshold.ts";

describe("deriveCompressionThreshold", () => {
  it("sem threshold_tokens explícito, deriva 80% do context_length (mesma fórmula de acp_adapter/server.py:2413-2414)", () => {
    const threshold = deriveCompressionThreshold({ contextLength: 65536 });
    assert.equal(threshold, Math.trunc(65536 * DEFAULT_THRESHOLD_FRACTION));
    assert.equal(threshold, 52428);
  });

  it("threshold_tokens explícito e positivo sempre vence, mesmo maior que o context_length — é exatamente a causa raiz do bug (#7527)", () => {
    // Estado da issue ANTES do conserto: threshold_tokens: 150000 fixo,
    // acima até da janela ERRADA que o Hermes resolvia (131072) — a
    // derivação por 80% nunca chega a rodar.
    const threshold = deriveCompressionThreshold({ contextLength: 131072, explicitThresholdTokens: 150000 });
    assert.equal(threshold, 150000);
  });

  it("threshold_tokens <= 0 é tratado como 'não setado' (mesma checagem do core Python) — cai pra derivação por 80%", () => {
    assert.equal(deriveCompressionThreshold({ contextLength: 65536, explicitThresholdTokens: 0 }), 52428);
    assert.equal(deriveCompressionThreshold({ contextLength: 65536, explicitThresholdTokens: -1 }), 52428);
  });

  it("sem threshold_tokens e sem context_length positivo -> lança (nenhum sinal pra derivar)", () => {
    assert.throws(() => deriveCompressionThreshold({ contextLength: 0 }), /não há como derivar um threshold/);
    assert.throws(() => deriveCompressionThreshold({ contextLength: -1 }), /não há como derivar um threshold/);
  });
});

describe("isThresholdSafeAgainstRealWindow — regressão do #7527", () => {
  it("REGRESSÃO: config CORRIGIDO (context_length = janela real, sem threshold_tokens fixo) — threshold sempre abaixo da janela real", () => {
    // Espelha o conserto da issue: model.context_length setado com a
    // janela REAL do modelo (65536 pro qwen-64k medido em 06/09/2026),
    // compression.threshold_tokens ausente do bloco de compressão.
    const realWindow = 65536;
    assert.ok(
      isThresholdSafeAgainstRealWindow({ contextLength: realWindow }, realWindow),
      "threshold derivado deveria ficar estritamente abaixo da janela real",
    );
  });

  it("REGRESSÃO: threshold derivado fica abaixo até do consumo medido por chamada do tick (56-61k), nunca só abaixo da janela nominal", () => {
    // Não basta "abaixo de 65536" — o objetivo real é comprimir ANTES do
    // tick truncar. As 4 sessões de 1 chamada medidas ao vivo em
    // 06/09/2026 (docs/goal-modelo-local-continuo.md) consumiram
    // 56348-60792 tokens por chamada.
    const realWindow = 65536;
    const threshold = deriveCompressionThreshold({ contextLength: realWindow });
    const measuredPerCallUsage = [56348, 56361, 56362, 56527, 57142, 58215, 60460, 60792];
    for (const usage of measuredPerCallUsage) {
      assert.ok(
        threshold < usage,
        `threshold ${threshold} deveria ficar abaixo do consumo medido ${usage} — senão a compressão dispara TARDE demais`,
      );
    }
  });

  it("REGRESSÃO NEGATIVA: reproduz o bug original — janela resolvida ERRADA (match de substring 'qwen' -> 131072) mais threshold_tokens global (150000) NÃO fica abaixo da janela real (65536)", () => {
    // Isto é o estado ANTES do conserto, preservado como caso de controle:
    // se este teste um dia passar a assert.ok (em vez de !ok), é sinal de
    // que a fórmula mudou de um jeito que esconderia a regressão original.
    const realWindow = 65536;
    const wrongResolvedWindow = 131072; // valor que a issue mediu via match de substring "qwen"
    const buggyParams = { contextLength: wrongResolvedWindow, explicitThresholdTokens: 150000 };
    assert.equal(
      isThresholdSafeAgainstRealWindow(buggyParams, realWindow),
      false,
      "estado pré-conserto: threshold 150000 fica ACIMA da janela real 65536 — compressão nunca dispara antes da truncagem, é a causa raiz do #7527",
    );
  });

  it("caso do modelo INVENTADO da issue (custom/qwen-INVENTADO-999:latest -> 131072 pelo mesmo match de substring): mesma reprovação, provando que o valor não vinha de sondagem real", () => {
    const realWindow = 65536;
    // A issue mede que um modelo que NÃO EXISTE resolve pra 131072 (mesmo
    // valor do modelo real) — prova de que o número vem da tabela estática
    // por substring, não de sondagem. O predicado de segurança precisa
    // reprovar esse cenário igualmente, já que ele carrega a mesma janela
    // errada que o modelo real tinha antes do conserto.
    assert.equal(
      isThresholdSafeAgainstRealWindow({ contextLength: 131072, explicitThresholdTokens: 150000 }, realWindow),
      false,
    );
  });

  it("qualquer janela real positiva razoável — a derivação por 80% sempre produz um threshold estritamente menor (propriedade geral, não amarrada a 65536)", () => {
    for (const realWindow of [4096, 8192, 32768, 65536, 92700, 131072, 256000]) {
      assert.ok(isThresholdSafeAgainstRealWindow({ contextLength: realWindow }, realWindow));
    }
  });
});
