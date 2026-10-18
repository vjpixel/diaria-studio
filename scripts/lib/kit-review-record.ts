/**
 * kit-review-record.ts (#9594)
 *
 * Registro por edição do resultado do loop `review-test-email` (§5f do Stage 5)
 * quando `publishing.newsletter.backend === "kit"`. O backend Beehiiv grava
 * `review_*` dentro de `_internal/05-published.json`; o Kit não tem esse
 * arquivo (schema `KitNewsletterPublished` não carrega `review_*`), e até o
 * #9594 o resultado só ia pro `data/run-log.jsonl` — sem nada por edição que
 * o invariante `stage-5-review-completed` ou o gate do Stage 6 pudessem ler.
 * Edição 261005: o §5f não rodou, nada acusou, e o gate mostrou "review
 * automático" sem dado.
 *
 * Fonte única do nome do arquivo, do vocabulário de status e do shape —
 * consumida por `scripts/record-kit-review.ts` (escrita) e por
 * `scripts/lib/invariant-checks/stage-5.ts` (leitura).
 */

import { isIntentionalErrorPlaceholder } from "./intentional-errors.ts";

export const KIT_REVIEW_FILENAME = "05-review-kit.json";

export const KIT_REVIEW_STATUSES = ["ok", "inconclusive", "issues_unfixable"] as const;
export type KitReviewStatus = (typeof KIT_REVIEW_STATUSES)[number];

/**
 * Mesmo vocabulário de `review_reason` do caminho Beehiiv (#8902), mais
 * `ui_test_not_marked` (#10395, só Kit): o estado diz `test_mode: "ui"` sem
 * `test_sent_at` — o Send test da UI pode nunca ter saído
 * (`fetch-test-email.ts` exit 5).
 */
export const KIT_REVIEW_REASONS = ["mcp_unavailable", "not_found_timeout", "truncated_fetch", "ui_test_not_marked"] as const;
export type KitReviewReason = (typeof KIT_REVIEW_REASONS)[number];

export interface KitReviewRecord {
  review_status: KitReviewStatus;
  /** 1 ou 2; 0 só com `inconclusive` sem despachar o agente (#9885). */
  review_attempts: number;
  /** Só com `review_status === "inconclusive"`. */
  review_reason?: KitReviewReason;
  /** Issues que sobraram após o filtro de falso-positivo (§5f passo 4.5). */
  review_final_issues: string[];
  /**
   * #10243: checagem determinística (TS, não LLM) do erro intencional no e-mail
   * ENTREGUE. `present` = `wrong_value` achado; `missing` = ausente (o agente
   * pode ter alucinado o texto correto — falso negativo de 261015);
   * `no_wrong_value` = sem `wrong_value` declarado; `no_email` = sem corpo.
   */
  intentional_error_check?: IntentionalErrorCheck;
  recorded_at: string;
}

export type IntentionalErrorCheck = "present" | "missing" | "no_wrong_value" | "no_email";

/** Entidades nomeadas sem forma "letra + diacrítico" (case-insensitive nas 6 básicas). */
const ENT: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ordm: "º", ordf: "ª", deg: "°", ndash: "–", mdash: "—", hellip: "…",
  laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  middot: "·", copy: "©", reg: "®", trade: "™", euro: "€", szlig: "ß",
};

/** Sufixo de entidade HTML → diacrítico combinante (`&ccedil;`, `&atilde;`, `&Eacute;`…). */
const DIACRITIC: Record<string, string> = {
  acute: "́", grave: "̀", circ: "̂", tilde: "̃", uml: "̈", cedil: "̧",
};

function decodeNamedEntity(original: string, name: string): string {
  const basic = ENT[name] ?? ENT[name.toLowerCase()];
  if (basic !== undefined) return basic;
  // #10267: `&ccedil;`/`&atilde;` no HTML do Kit contra um wrong_value acentuado
  // davam `missing` falso. Case-sensitive (`&Aacute;` = "Á").
  const m = /^([a-zA-Z])(acute|grave|circ|tilde|uml|cedil)$/.exec(name);
  if (m) {
    const composed = (m[1] + DIACRITIC[m[2]]).normalize("NFC");
    if (composed.length === 1) return composed;
  }
  return original;
}

/** #10267: entidade numérica fora do intervalo Unicode não aborta o record. */
function decodeCodePoint(cp: number, original: string): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return original;
  }
}

/** @pure Tira tags, decodifica entidades e colapsa espaços (HTML cru do Kit). */
export function normalizeEmailText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (e, n) => decodeCodePoint(Number(n), e))
    .replace(/&#x([0-9a-f]+);/gi, (e, n) => decodeCodePoint(parseInt(n, 16), e))
    .replace(/&([a-z]+);/gi, (m, n) => decodeNamedEntity(m, n))
    .replace(/\s+/g, " ");
}

/**
 * @pure Case-sensitive: "Unibanko" ≠ "Unibanco". HTML normalizado (#10243 review).
 * Placeholder `{PREENCHER...}` = sem gabarito declarado (`no_wrong_value`), nunca
 * um valor a procurar no e-mail (#10267).
 */
export function checkIntentionalErrorInEmail(
  emailBody: string | undefined,
  wrongValue: string | undefined,
): IntentionalErrorCheck {
  const w = (wrongValue ?? "").trim();
  if (!w || isIntentionalErrorPlaceholder(w)) return "no_wrong_value";
  if (!emailBody) return "no_email";
  return normalizeEmailText(emailBody).includes(normalizeEmailText(w)) ? "present" : "missing";
}

export function isKitReviewStatus(v: unknown): v is KitReviewStatus {
  return typeof v === "string" && (KIT_REVIEW_STATUSES as readonly string[]).includes(v);
}

export function isKitReviewReason(v: unknown): v is KitReviewReason {
  return typeof v === "string" && (KIT_REVIEW_REASONS as readonly string[]).includes(v);
}

/**
 * Valida a entrada e monta o registro. Lança com mensagem clara em vez de
 * gravar um arquivo que o invariante depois trataria como inválido.
 *
 * @pure (exceto `now`, injetável)
 */
export function buildKitReviewRecord(input: {
  status: unknown;
  attempts?: number;
  reason?: unknown;
  issues?: unknown;
  intentionalErrorCheck?: IntentionalErrorCheck;
  now?: Date;
}): KitReviewRecord {
  if (!isKitReviewStatus(input.status)) {
    throw new Error(
      `review_status inválido: ${JSON.stringify(input.status)} (válidos: ${KIT_REVIEW_STATUSES.join(", ")})`,
    );
  }
  const attempts = input.attempts ?? 1;
  // #9885: 0 = o agente nem foi despachado (§5f passo 0 — e-mail não achado
  // ou conector Gmail indisponível). Só faz sentido com `inconclusive`: `ok`
  // e `issues_unfixable` só existem depois de o review ter rodado ao menos 1x.
  const minAttempts = input.status === "inconclusive" ? 0 : 1;
  if (!Number.isInteger(attempts) || attempts < minAttempts || attempts > 2) {
    throw new Error(
      `review_attempts inválido: ${attempts} (o loop do §5f tem 1 ou 2 tentativas; ` +
        `0 só com review_status=inconclusive, quando o agente não foi despachado)`,
    );
  }
  if (input.reason !== undefined && !isKitReviewReason(input.reason)) {
    throw new Error(
      `review_reason inválido: ${JSON.stringify(input.reason)} (válidos: ${KIT_REVIEW_REASONS.join(", ")})`,
    );
  }
  if (input.reason !== undefined && input.status !== "inconclusive") {
    throw new Error("review_reason só se aplica a review_status=inconclusive");
  }
  const issues = input.issues ?? [];
  if (!Array.isArray(issues) || issues.some((i) => typeof i !== "string")) {
    throw new Error("review_final_issues precisa ser um array de strings");
  }
  const finalIssues = issues as string[];
  // #10243: `ok` do agente não vale se o erro intencional declarado não está
  // no e-mail entregue — o agente descreveu texto que não existia.
  if (input.intentionalErrorCheck === "missing" && input.status === "ok") {
    throw new Error(
      "review_status=ok contradiz a checagem determinística: wrong_value do erro intencional " +
        "NÃO aparece no e-mail entregue (#10243). Reavalie o e-mail ou grave issues_unfixable.",
    );
  }
  return {
    review_status: input.status,
    review_attempts: attempts,
    ...(input.reason !== undefined ? { review_reason: input.reason as KitReviewReason } : {}),
    review_final_issues: finalIssues,
    ...(input.intentionalErrorCheck ? { intentional_error_check: input.intentionalErrorCheck } : {}),
    recorded_at: (input.now ?? new Date()).toISOString(),
  };
}
