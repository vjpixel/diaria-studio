/**
 * scripts/lib/hermes-compression-threshold.ts (#7527)
 *
 * Reimplementação PURA, do lado do `diaria-studio`, da fórmula que o Hermes
 * core (`acp_adapter/server.py:2413-2414`, fora deste repo) usa pra derivar
 * o threshold de compressão quando `compression.threshold_tokens` não está
 * setado explicitamente no `~/.hermes/config.yaml`:
 *
 * ```python
 * if threshold_tokens <= 0 and context_length > 0:
 *     threshold_tokens = int(context_length * 0.80)
 * ```
 *
 * ## Por que isto existe (causa raiz da #7527)
 *
 * O Hermes resolvia a janela de `custom/qwen-64k:latest` como 131.072 por
 * MATCH DE SUBSTRING `"qwen"` numa tabela estática do core
 * (`agent/model_metadata.py`) — a janela real servida (`num_ctx` do
 * Modelfile) é bem menor. `compression.threshold_tokens: 150000` (global,
 * sem variante por modelo) ficava acima até do valor ERRADO, então a
 * compressão nunca disparava por threshold — o Ollama truncava o prompt
 * DO COMEÇO, devolvendo HTTP 200 sem erro nenhum, e o tick perdia as regras
 * do procedimento que vivem no início do prompt.
 *
 * O conserto documentado na issue (e sugerido pelo próprio Hermes na
 * mensagem de erro do fallback cego) é setar `model.context_length` com a
 * janela REAL no config — sem `threshold_tokens` setado, o Hermes deriva o
 * threshold como 80% dessa janela, comprimindo ANTES de truncar.
 *
 * `scripts/write-hermes-config.ts` (#6817 item 3) já é o verbo genérico que
 * escreve qualquer conteúdo YAML validado em `~/.hermes/config.yaml` — não
 * precisa de suporte específico pro campo `model.context_length` (é só mais
 * uma chave escalar no mesmo arquivo). O que faltava, e que esta issue pede
 * explicitamente na seção "Verificação sugerida", é uma forma de TESTAR a
 * fórmula de derivação em si — sem GPU, sem depender do Hermes core (Python,
 * fora deste repo) — pra provar que, com `context_length` setado, o
 * threshold efetivo sempre fica abaixo da janela real. É isso que este
 * módulo e seu teste (`test/hermes-compression-threshold.test.ts`)
 * verificam.
 *
 * Este módulo NÃO chama o Hermes, NÃO lê `~/.hermes/config.yaml` — é
 * miolo puro, mesmo padrão de `scripts/lib/hermes-config-writer.ts`.
 */

/** Fração do `contextLength` usada como threshold quando
 * `compression.threshold_tokens` não está setado — espelha o literal
 * `0.80` de `acp_adapter/server.py:2413-2414`. */
export const DEFAULT_THRESHOLD_FRACTION = 0.8;

export interface DeriveCompressionThresholdParams {
  /** `model.context_length` do config, ou a janela resolvida pelo Hermes
   * quando o campo não está setado (pode ser o valor ERRADO por match de
   * substring — ver docstring do módulo). Precisa ser > 0 pra a fórmula de
   * 80% se aplicar; ausência/≤0 é o estado "nunca setado" do Hermes. */
  readonly contextLength: number;
  /** `compression.threshold_tokens` do config. `undefined` ou ≤0 é o
   * estado "não setado" — mesma checagem `threshold_tokens <= 0` do core
   * Python (que trata 0/negativo como "sem override", nunca como
   * "comprimir imediatamente"). */
  readonly explicitThresholdTokens?: number;
}

/**
 * Deriva o threshold de compressão EFETIVO com a mesma regra do Hermes core:
 * um `explicitThresholdTokens` positivo sempre vence (é o que a issue
 * descreve como a causa do bug — `150000` fixo, acima até da janela errada
 * de 131.072); só na ausência dele o threshold vira 80% de `contextLength`
 * (truncado — `Math.trunc`, mesmo comportamento de `int()` em Python pra
 * valores positivos).
 *
 * Lança se nem `explicitThresholdTokens` nem `contextLength` positivo
 * estiverem disponíveis — esse é o estado "sem sinal nenhum pra derivar
 * threshold", que o Hermes real trataria como compressão nunca disparando
 * (o próprio bug desta issue); melhor um erro alto aqui do que devolver um
 * número que finge ser um threshold válido.
 */
export function deriveCompressionThreshold(params: DeriveCompressionThresholdParams): number {
  const { contextLength, explicitThresholdTokens } = params;
  if (explicitThresholdTokens !== undefined && explicitThresholdTokens > 0) {
    return explicitThresholdTokens;
  }
  if (!(contextLength > 0)) {
    throw new Error(
      "deriveCompressionThreshold: nem explicitThresholdTokens nem contextLength positivo foram fornecidos — " +
        "não há como derivar um threshold (mesmo estado que faz a compressão nunca disparar no Hermes real, #7527)",
    );
  }
  return Math.trunc(contextLength * DEFAULT_THRESHOLD_FRACTION);
}

/**
 * `true` sse o threshold derivado por `deriveCompressionThreshold` fica
 * ESTRITAMENTE abaixo da janela real servida (`realContextLength`) — a
 * propriedade que a issue pede pra verificar ("dado um nome de modelo e uma
 * janela real conhecida, o threshold efetivo tem que ficar abaixo dela").
 * `realContextLength` pode divergir de `params.contextLength` — é
 * justamente esse desalinhamento (Hermes resolvendo a janela errada) que
 * causa o bug: um config correto usa o MESMO valor nos dois; um config
 * ainda quebrado (ex: threshold_tokens fixo acima da janela real) reprova
 * este predicado.
 */
export function isThresholdSafeAgainstRealWindow(
  params: DeriveCompressionThresholdParams,
  realContextLength: number,
): boolean {
  const threshold = deriveCompressionThreshold(params);
  return threshold < realContextLength;
}
