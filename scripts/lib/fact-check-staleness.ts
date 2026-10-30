/**
 * fact-check-staleness.ts (#11671)
 *
 * Carimbo de conteúdo do `_internal/fact-check.json`: o hash de
 * `02-reviewed.md` e `03-social.md` no momento em que o resultado do
 * fact-checker foi gravado. Sem ele, o `--check-blocking` de uma rodada
 * posterior (depois de o editor reescrever/remover o trecho no gate) seguia
 * acusando como bloqueante uma frase que já não existia mais (edição 261030).
 *
 * Política: carimbo divergente = fact-check DEFASADO. Isso é aviso, nunca
 * bloqueio por si só. O bloqueio passa a valer só para os claims cujo texto
 * ainda aparece no conteúdo atual; claim cujo trecho sumiu sai do bloqueio e
 * (`text` e `context` ausentes) vira aviso ("re-rodar o fact-checker"). Claim ainda presente continua
 * bloqueando: o texto não mudou, então o veredito segue valendo.
 *
 * Carimbo ausente (fact-check.json anterior ao #11671) = não dá pra saber;
 * comportamento idêntico ao de antes (nunca defasado).
 */
import { createHash } from "node:crypto";

export interface FactCheckContentHash {
  /** sha256 (16 hex) de `02-reviewed.md`; null se o arquivo não existia. */
  newsletter: string | null;
  /** sha256 (16 hex) de `03-social.md`; null se o arquivo não existia. */
  social: string | null;
}

export function hashContent(text: string): string {
  // CRLF/LF não muda o conteúdo editorial — OneDrive/Windows alternam os dois.
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex").slice(0, 16);
}

export function computeContentHash(
  newsletterMd: string | null | undefined,
  socialMd: string | null | undefined,
): FactCheckContentHash {
  return {
    newsletter: typeof newsletterMd === "string" ? hashContent(newsletterMd) : null,
    social: typeof socialMd === "string" ? hashContent(socialMd) : null,
  };
}

/** Valida o shape vindo do JSON (unknown → carimbo ou undefined). */
export function parseContentHash(raw: unknown): FactCheckContentHash | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const ok = (v: unknown) => v === null || typeof v === "string";
  if (!ok(o.newsletter) || !ok(o.social)) return undefined;
  return { newsletter: o.newsletter as string | null, social: o.social as string | null };
}

export interface StalenessReport {
  stale: boolean;
  /** Quais arquivos mudaram desde o carimbo. */
  changed: Array<"02-reviewed.md" | "03-social.md">;
}

export function factCheckStaleness(
  stamp: FactCheckContentHash | undefined,
  current: FactCheckContentHash,
): StalenessReport {
  if (!stamp) return { stale: false, changed: [] };
  const changed: StalenessReport["changed"] = [];
  if (stamp.newsletter !== current.newsletter) changed.push("02-reviewed.md");
  if (stamp.social !== current.social) changed.push("03-social.md");
  return { stale: changed.length > 0, changed };
}

/**
 * Normaliza markdown pra comparar o trecho do claim com o texto atual:
 * link `[t](url)` → `t`, sem ênfase/código, aspas tipográficas → retas,
 * espaços (inclusive NBSP) colapsados, minúsculas.
 */
export function normalizeForClaimMatch(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[\s ]+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * true se o trecho do claim (`text`) ainda aparece em algum dos textos
 * atuais. Trecho vazio conta como presente (conservador: na dúvida, o
 * bloqueio fica).
 */
export function claimStillPresent(claimText: string, contents: Array<string | null | undefined>): boolean {
  const needle = normalizeForClaimMatch(claimText ?? "");
  if (!needle) return true;
  return contents.some((c) => typeof c === "string" && normalizeForClaimMatch(c).includes(needle));
}

/**
 * Separa os claims bloqueantes em `blocking` (seguem bloqueando) e
 * `vanished` (fact-check defasado E claim sumido do texto atual — só aviso).
 * Sem defasagem, tudo continua em `blocking`.
 *
 * "Sumido" exige que `text` E `context` tenham saído do texto atual (PR
 * #11683, self-review P2): o agente às vezes grava em `text` uma paráfrase
 * ("500 milhões de reais" contra "R$ 500 milhões" no MD), e só o `text`
 * deixaria um claim que continua no texto sair do bloqueio. `context`
 * ausente/vazio conta como presente (conservador: o bloqueio fica).
 */
export function partitionBlockingByContent<T extends { text: string; context?: string }>(
  blocking: T[],
  staleness: StalenessReport,
  contents: Array<string | null | undefined>,
): { blocking: T[]; vanished: T[] } {
  if (!staleness.stale) return { blocking, vanished: [] };
  const still: T[] = [];
  const vanished: T[] = [];
  for (const c of blocking) {
    const present = claimStillPresent(c.text, contents) || claimStillPresent(c.context ?? "", contents);
    (present ? still : vanished).push(c);
  }
  return { blocking: still, vanished };
}

export function formatStaleWarning(staleness: StalenessReport, vanishedCount = 0): string {
  const files = staleness.changed.join(" e ");
  const tail =
    vanishedCount > 0
      ? ` ${vanishedCount} claim(s) bloqueante(s) não aparece(m) mais no texto atual e saíram do bloqueio.`
      : "";
  return (
    `  ⚠️  Fact-check DEFASADO (#11671): ${files} mudou(aram) depois da checagem.${tail} ` +
    "Re-rodar o fact-checker (§4c.6) antes de aprovar o gate."
  );
}
