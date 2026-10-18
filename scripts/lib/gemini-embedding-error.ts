/**
 * gemini-embedding-error.ts (#10448)
 *
 * Classifica a falha REAL de uma chamada `embedContent` do Gemini, pra que o
 * aviso do topic-cluster diga a causa em vez de "drift de catálogo, quota ou
 * rede indistinguíveis aqui".
 *
 * Motivação: de 260930 a 261019 (14 edições seguidas) 100% dos embeddings
 * `gemini-embedding-001` falharam e o topic-cluster caiu inteiro no fallback
 * Jaccard. `embedText` engolia a resposta (`catch { return null }` e
 * `data.embedding?.values ?? null`), então nem o sidecar nem o run-log tinham
 * o status HTTP. Medido ao vivo em 18/10/2026: a API devolve
 * `402 RESOURCE_EXHAUSTED — "Your prepayment credits are depleted"`. É billing
 * da conta, não código: `validate-gemini-config.ts` dizia `ok` porque listar
 * o catálogo (`GET /v1beta/models`) continua funcionando sem crédito — a
 * recomendação "rode validate-gemini-config" do aviso antigo levava a um beco.
 *
 * Puro: nenhuma I/O. Consumido por `scripts/topic-cluster.ts` (captura) e
 * `scripts/lib/stage-1-validator.ts` (mensagem do gate).
 */

/** Falha de uma chamada de embedding. `status=null` = sem resposta HTTP (rede/timeout/JSON inválido). */
export interface EmbeddingError {
  status: number | null;
  /** Mensagem da API (`error.message`) ou da exceção, já sem a chave e truncada. */
  message: string;
}

export type EmbeddingErrorKind =
  | "billing"
  | "quota"
  | "model_not_found"
  | "auth"
  | "bad_request"
  | "server"
  | "network"
  | "unknown";

const MAX_MESSAGE_CHARS = 300;

/** Remove a chave (aparece na URL `?key=`) de qualquer texto de erro antes de persistir. */
export function redactGeminiKey(text: string, apiKey: string | undefined): string {
  let out = text;
  if (apiKey) out = out.split(apiKey).join("[REDACTED]");
  return out.replace(/([?&]key=)[^&\s"']+/g, "$1[REDACTED]");
}

export function normalizeEmbeddingErrorMessage(text: string, apiKey: string | undefined): string {
  const flat = redactGeminiKey(text, apiKey).replace(/\s+/g, " ").trim();
  return flat.length > MAX_MESSAGE_CHARS ? `${flat.slice(0, MAX_MESSAGE_CHARS)}…` : flat;
}

export function classifyEmbeddingError(err: EmbeddingError): EmbeddingErrorKind {
  const msg = err.message.toLowerCase();
  if (err.status === null) return "network";
  if (err.status === 402 || /prepayment|credits are depleted|billing/.test(msg)) return "billing";
  if (err.status === 429) return "quota";
  if (err.status === 404) return "model_not_found";
  if (err.status === 401 || err.status === 403) return "auth";
  if (err.status === 400 && /api key|api_key/.test(msg)) return "auth";
  if (err.status === 400) return "bad_request";
  if (err.status >= 500) return "server";
  return "unknown";
}

/** Ação concreta por classe de falha — o que o editor faz pra destravar. */
export function embeddingErrorHint(kind: EmbeddingErrorKind): string {
  switch (kind) {
    case "billing":
      return "créditos pré-pagos da conta Gemini esgotados — recarregar o billing do projeto em https://ai.studio/projects (externo ao código; validate-gemini-config.ts não detecta, listar o catálogo funciona sem crédito)";
    case "quota":
      return "quota/rate limit do Gemini estourada (429) — conferir limites do projeto no AI Studio";
    case "model_not_found":
      return "modelo fora do catálogo Gemini (404, drift #4654) — trocar platform.config.json > gemini.embedding_model por um modelo listado em /v1beta/models";
    case "auth":
      return "GEMINI_API_KEY inválida ou sem permissão — conferir a chave no Doppler/.env";
    case "bad_request":
      return "requisição rejeitada (400) — conferir o payload de embedContent em scripts/topic-cluster.ts";
    case "server":
      return "erro do servidor Gemini (5xx) — transitório, repetir na próxima edição";
    case "network":
      return "sem resposta HTTP (rede, DNS, timeout ou JSON inválido)";
    default:
      return "causa não classificada — ver status/mensagem";
  }
}

/** Uma linha legível: `HTTP 402 (billing): <mensagem> — <ação>`. */
export function describeEmbeddingError(err: EmbeddingError): string {
  const kind = classifyEmbeddingError(err);
  const status = err.status === null ? "sem HTTP" : `HTTP ${err.status}`;
  return `${status} (${kind}): ${err.message} — ${embeddingErrorHint(kind)}`;
}

/** Campos do sidecar `topic-cluster-stats.json` que carregam a causa (#10448). */
export interface EmbeddingErrorFields {
  errors_by_status?: Record<string, number>;
  first_error?: EmbeddingError | null;
}

/**
 * Frase de causa pro aviso do gate/run-log. Sem `first_error` (sidecar de
 * antes do #10448) mantém o texto antigo de "causa não confirmada".
 */
export function embeddingCauseSentence(stats: EmbeddingErrorFields): string {
  if (!stats.first_error) {
    return "Causa não registrada neste sidecar (anterior ao #10448: drift de catálogo #4654, billing/quota ou rede indistinguíveis) — rode o topic-cluster de novo pra capturar o status HTTP.";
  }
  const counts = Object.entries(stats.errors_by_status ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}×${n}`)
    .join(", ");
  return `Causa: ${describeEmbeddingError(stats.first_error)}.${counts ? ` Falhas por status: ${counts}.` : ""}`;
}
