/**
 * lib/extract-opens-catchup-status.ts (#4740)
 *
 * Lógica PURA de extração do campo `opens_catchup` do JSON summary que
 * `clarice-sync-brevo.ts --incremental` imprime em stdout ao final da run
 * (ver docstring de `main()` nesse arquivo — `console.log(JSON.stringify({...,
 * opens_catchup}, null, 2))`).
 *
 * Por que ler o log em vez de estender `clarice-sync-brevo.ts` diretamente:
 * esse script é ativamente modificado (histórico recente denso, #4688/#4712/
 * #4717/#4721/#4722) — acoplar um novo alarme ao seu `main()` aumenta risco
 * de conflito com trabalho concorrente na mesma noite. Em vez disso,
 * `run-clarice-sync-daily.ps1` (baixo-tráfego de mudanças) já grava a saída
 * completa da run (stdout+stderr mesclados via `2>&1`) num arquivo temporário
 * ANTES de anexar ao log final — este módulo extrai o resumo dali logo após
 * o passo 1 (sync), no MESMO processo, sem parsear múltiplas runs históricas.
 *
 * Extração JSON-aware (não regex ingênuo): o texto do log mistura linhas de
 * progresso (`console.error`, uma por linha) com UM blob JSON multi-linha
 * (`console.log(JSON.stringify(..., null, 2))`). Um scanner com reconhecimento
 * de string evita contar `{`/`}` que apareçam DENTRO de valores string (ex:
 * mensagens de erro do catch-up que podem conter chaves literais).
 */

export type OpensCatchupStatus =
  | { status: "ok"; checked_at: string }
  | { status: "error"; error: string; checked_at: string }
  /** Catch-up não rodou neste ciclo (`--no-catch-opens`, modo full, ou
   * summary não encontrado/malformado no log) — NÃO é sinal de falha, nunca
   * deve mexer no streak de falhas consecutivas do alarme. */
  | { status: "not_run"; checked_at: string };

/**
 * Varre `text` char-a-char (string-aware) e retorna o ÚLTIMO objeto JSON
 * top-level balanceado que, uma vez parseado, contém a chave `key`. `null`
 * se nenhum for encontrado ou nenhum parsear como JSON válido.
 */
export function extractLastJsonObjectWithKey(text: string, key: string): Record<string, unknown> | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let last: Record<string, unknown> | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          const candidate = text.slice(start, i + 1);
          try {
            const parsed = JSON.parse(candidate) as unknown;
            if (parsed && typeof parsed === "object" && key in (parsed as Record<string, unknown>)) {
              last = parsed as Record<string, unknown>;
            }
          } catch {
            // Não é JSON válido (ex: `{` dentro de progresso não-JSON) — ignora.
          }
          start = -1;
        }
      }
    }
  }
  return last;
}

/**
 * Pure: extrai o status do catch-up de opens a partir do texto bruto do log
 * de uma run de `clarice-sync-brevo.ts --incremental`.
 *
 * #5401: `ok: true` sozinho não é sinal de COBERTURA — `runOpensCatchup` é
 * fail-soft POR CAMPANHA (uma campanha cujo export/poll/download falhar
 * incrementa `result.campaignsFailed` mas não faz a função lançar, então o
 * summary ainda reporta `ok: true`). Confirmado ao vivo em 260816: a mesma
 * run que reporta `{"status":"ok"}` em produção pode ter deixado campanha(s)
 * inteiras da janela sem re-exportar (timeout de download, entre outras
 * causas) — exatamente o gap que o item 4/5 da issue #5401 pede pra fechar.
 * `campaignsFailed > 0` agora reprova como `"error"` (reusa o streak/alarme/
 * issue já wired pro status de erro — sem introduzir um 3º branch de estado
 * espalhado por todo consumidor). `contactsFailed` (per-CONTATO) fica DE
 * FORA de propósito — um 404 isolado (contato removido entre export e
 * re-busca) é ruído esperado, não falha de cobertura da campanha.
 */
export function extractOpensCatchupStatus(logText: string, now: Date = new Date()): OpensCatchupStatus {
  const checked_at = now.toISOString();
  const summary = extractLastJsonObjectWithKey(logText, "opens_catchup");
  if (!summary) return { status: "not_run", checked_at };

  const catchup = summary.opens_catchup as
    | { ok?: boolean; error?: string; result?: { campaignsFailed?: number; campaignsInWindow?: number } }
    | null
    | undefined;
  if (catchup === null || catchup === undefined) return { status: "not_run", checked_at };
  if (catchup.ok === true) {
    const campaignsFailed = catchup.result?.campaignsFailed ?? 0;
    if (campaignsFailed > 0) {
      const campaignsInWindow = catchup.result?.campaignsInWindow ?? 0;
      return {
        status: "error",
        error: `cobertura parcial: ${campaignsFailed}/${campaignsInWindow} campanha(s) na janela falharam no export`,
        checked_at,
      };
    }
    return { status: "ok", checked_at };
  }
  if (catchup.ok === false) {
    return { status: "error", error: typeof catchup.error === "string" ? catchup.error : "erro desconhecido", checked_at };
  }
  return { status: "not_run", checked_at };
}
