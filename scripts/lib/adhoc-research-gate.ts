/**
 * adhoc-research-gate.ts (#11797)
 *
 * Gate determinístico para a saída de uma pesquisa AD-HOC de candidatos
 * (ex.: "pesquisa profunda das newsletters recebidas desde DD/MM", pedida
 * pelo editor fora do Stage 1). Caso que motivou (edição 261103): o subagente
 * afirmou que o Gemini 4 Carbon era de 30/10 (era de 28/10) e trouxe
 * comparações com Opus/GPT que a página do Google não sustentava; o item
 * Cathedral x Anthropic também era de 26-28/10, fora da janela que começava
 * em 30/10. Só a releitura manual das fontes primárias pegou.
 *
 * O subagente declara, por candidato, de ONDE leu a data e cada claim
 * (`primary` = página da fonte primária; `newsletter` = resumo da newsletter
 * que trouxe o link; `unknown` = não sabe). Este módulo NÃO acredita no
 * gloss do subagente: aplica as regras e devolve um veredito por candidato:
 *
 *   - `fora_da_janela`  — data (primária) anterior ao início da janela;
 *   - `nao_verificado`  — data ausente, data ou algum claim não lido da fonte
 *                         primária, ou data em formato ilegível;
 *   - `ok`              — data primária dentro da janela e todos os claims
 *                         com fonte primária.
 *
 * `fora_da_janela` vence `nao_verificado`: um item comprovadamente fora da
 * janela sai da sugestão independente do resto.
 *
 * Puro (sem I/O); a CLI fica em `scripts/check-adhoc-research-candidates.ts`.
 */

export type EvidenceSource = "primary" | "newsletter" | "unknown";

export interface AdhocClaim {
  text: string;
  source?: EvidenceSource | string | null;
  /** URL de onde o claim foi lido (opcional, só informativo). */
  source_url?: string | null;
}

export interface AdhocCandidate {
  url: string;
  title?: string;
  /** Data de publicação, YYYY-MM-DD (ISO com hora também é aceito). */
  date?: string | null;
  date_source?: EvidenceSource | string | null;
  claims?: AdhocClaim[];
}

export type AdhocVerdict = "ok" | "nao_verificado" | "fora_da_janela";

export interface AdhocCandidateResult {
  url: string;
  title?: string;
  date: string | null;
  verdict: AdhocVerdict;
  reasons: string[];
  /** Claims que não foram lidos da fonte primária (texto como veio). */
  unverified_claims: string[];
}

export interface AdhocGateReport {
  window_start: string;
  total: number;
  ok: number;
  nao_verificado: number;
  fora_da_janela: number;
  results: AdhocCandidateResult[];
}

const ISO_DAY = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/;

/** Normaliza para YYYY-MM-DD; devolve null se ilegível. */
export function normalizeDay(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(ISO_DAY);
  if (!m) return null;
  const d = new Date(`${m[1]}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Rejeita datas que o Date "corrige" (2026-02-31 → 03-03).
  if (d.toISOString().slice(0, 10) !== m[1]) return null;
  return m[1];
}

function isPrimary(source: unknown): boolean {
  return typeof source === "string" && source.trim().toLowerCase() === "primary";
}

export function classifyAdhocCandidate(
  candidate: AdhocCandidate,
  windowStart: string,
): AdhocCandidateResult {
  const reasons: string[] = [];
  const rawDate = candidate.date ?? null;
  const day = normalizeDay(rawDate);
  const datePrimary = isPrimary(candidate.date_source);

  let outOfWindow = false;
  if (rawDate == null || String(rawDate).trim() === "") {
    reasons.push("data ausente: ler a data na página da fonte primária");
  } else if (day == null) {
    reasons.push(`data ilegível (${String(rawDate)}): usar YYYY-MM-DD lido da fonte primária`);
  } else {
    if (!datePrimary) {
      reasons.push(
        `data ${day} não lida da fonte primária (date_source=${String(candidate.date_source ?? "ausente")})`,
      );
    }
    if (day < windowStart) {
      // Data de newsletter também conta: se até ela diz que é anterior,
      // a primária (que só pode ser igual ou mais antiga que o resumo) não
      // salva o item. Data posterior ao resumo é impossível na prática.
      outOfWindow = true;
      reasons.push(`fora da janela: ${day} é anterior ao início ${windowStart}`);
    }
  }

  const unverifiedClaims: string[] = [];
  for (const claim of candidate.claims ?? []) {
    if (!claim || typeof claim.text !== "string" || claim.text.trim() === "") continue;
    if (!isPrimary(claim.source)) unverifiedClaims.push(claim.text.trim());
  }
  if (unverifiedClaims.length > 0) {
    reasons.push(
      `${unverifiedClaims.length} claim(s) sem fonte primária: marcar "não verificado" ou remover`,
    );
  }

  let verdict: AdhocVerdict;
  if (outOfWindow) verdict = "fora_da_janela";
  else if (reasons.length > 0) verdict = "nao_verificado";
  else verdict = "ok";

  return {
    url: candidate.url,
    ...(candidate.title !== undefined ? { title: candidate.title } : {}),
    date: day,
    verdict,
    reasons,
    unverified_claims: unverifiedClaims,
  };
}

export function classifyAdhocCandidates(
  candidates: AdhocCandidate[],
  windowStart: string,
): AdhocGateReport {
  const start = normalizeDay(windowStart);
  if (!start) throw new Error(`window_start inválido: ${windowStart} (esperado YYYY-MM-DD)`);
  const results = candidates.map((c) => classifyAdhocCandidate(c, start));
  return {
    window_start: start,
    total: results.length,
    ok: results.filter((r) => r.verdict === "ok").length,
    nao_verificado: results.filter((r) => r.verdict === "nao_verificado").length,
    fora_da_janela: results.filter((r) => r.verdict === "fora_da_janela").length,
    results,
  };
}
