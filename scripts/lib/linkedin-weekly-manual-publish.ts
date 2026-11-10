/**
 * scripts/lib/linkedin-weekly-manual-publish.ts (#12745)
 *
 * Lógica PURA do registro de publicação MANUAL de um ciclo da newsletter
 * semanal do LinkedIn. O alarme `linkedin-weekly-staleness-alarm.ts` só
 * olha se `data/weekly/{cycle}/ln-{cycle}.json` existe; quando o editor
 * publica o ciclo à mão, fora do `/diaria-linkedin-semanal` (caso do 26w45,
 * #12493), o arquivo nunca é escrito e o alarme segue reproduzindo depois
 * da publicação (histórico: #8622, #10059, #11100).
 *
 * Não há como confirmar pela API: `/rest/posts?q=author` (versão 202610)
 * traz os carrosséis da retro semanal, mas não os artigos de newsletter, e
 * não há endpoint de listagem de artigos de newsletter. O registro é a
 * palavra do editor, com a URL do artigo como prova auditável.
 *
 * O I/O (ler/gravar o arquivo) fica em `scripts/mark-linkedin-weekly-published.ts`.
 */

/** Campos que o registro manual grava em `ln-{cycle}.json`. */
export interface ManualPublicationFields {
  published_manually: true;
  published_url: string;
  marked_published_at: string;
}

export type UrlValidation = { ok: true; url: string } | { ok: false; reason: string };

/** Hosts aceitos para a URL do artigo publicado. */
const LINKEDIN_HOSTS = new Set(["linkedin.com", "lnkd.in"]);

/**
 * Pure: aceita só `https://` em `linkedin.com` (ou subdomínio, ex.
 * `www.linkedin.com`) ou `lnkd.in`, com caminho além da raiz. A URL é a
 * prova de que o ciclo saiu; uma URL qualquer (ou a home do LinkedIn)
 * calaria o alarme sem provar nada.
 */
export function validateLinkedinPublishedUrl(raw: string | undefined | null): UrlValidation {
  const value = (raw ?? "").trim();
  if (!value) return { ok: false, reason: "URL vazia" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: `URL inválida: ${value}` };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: `URL precisa ser https: ${value}` };
  const host = parsed.hostname.toLowerCase();
  const hostOk = LINKEDIN_HOSTS.has(host) || host.endsWith(".linkedin.com");
  if (!hostOk) return { ok: false, reason: `host não é do LinkedIn (${host}): ${value}` };
  if (parsed.pathname === "/" || parsed.pathname === "") {
    return { ok: false, reason: `URL sem caminho do artigo: ${value}` };
  }
  return { ok: true, url: parsed.toString() };
}

export type ManualPublicationPlan =
  | { action: "create"; record: Record<string, unknown> }
  | { action: "merge"; record: Record<string, unknown> }
  | { action: "noop"; record: Record<string, unknown> }
  | { action: "conflict"; reason: string };

export interface PlanManualPublicationInput {
  cycle: string;
  url: string;
  now: Date;
  /** Sobrescreve URL diferente já registrada ou arquivo ilegível. */
  force?: boolean;
}

/**
 * Pure: decide o que gravar em `ln-{cycle}.json`.
 *
 * - `existingRaw === null` (arquivo ausente): cria o registro mínimo.
 * - arquivo do render (`render-linkedin-weekly.ts`): acrescenta os campos
 *   manuais e preserva o resto (`warnings`, `coverImagePath`, ...).
 * - mesma URL já registrada: `noop` (idempotente).
 * - URL diferente já registrada, `cycle` divergente ou arquivo ilegível:
 *   `conflict`, a menos que `force`.
 */
export function planManualPublicationRecord(
  existingRaw: string | null,
  input: PlanManualPublicationInput,
): ManualPublicationPlan {
  const fields: ManualPublicationFields = {
    published_manually: true,
    published_url: input.url,
    marked_published_at: input.now.toISOString(),
  };
  const fresh = { cycle: input.cycle, ...fields };

  if (existingRaw === null) return { action: "create", record: fresh };

  let existing: unknown;
  try {
    existing = JSON.parse(existingRaw);
  } catch (e) {
    if (input.force) return { action: "create", record: fresh };
    return { action: "conflict", reason: `ln-${input.cycle}.json existe e não é JSON válido (${(e as Error).message}); use --force para substituir` };
  }
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    if (input.force) return { action: "create", record: fresh };
    return { action: "conflict", reason: `ln-${input.cycle}.json existe e não é um objeto JSON; use --force para substituir` };
  }

  const obj = existing as Record<string, unknown>;
  if (typeof obj.cycle === "string" && obj.cycle !== input.cycle && !input.force) {
    return { action: "conflict", reason: `ln-${input.cycle}.json diz cycle=${obj.cycle}; use --force para sobrescrever` };
  }
  if (obj.published_manually === true && obj.published_url === input.url) {
    return { action: "noop", record: obj };
  }
  if (typeof obj.published_url === "string" && obj.published_url !== input.url && !input.force) {
    return {
      action: "conflict",
      reason: `ln-${input.cycle}.json já registra outra URL (${obj.published_url}); use --force para trocar`,
    };
  }
  return { action: "merge", record: { ...obj, cycle: input.cycle, ...fields } };
}

/** Pure: o `ln-{cycle}.json` lido é um registro de publicação manual? (só para log do alarme) */
export function isManualPublicationRecord(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return !!parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).published_manually === true;
  } catch {
    return false;
  }
}
