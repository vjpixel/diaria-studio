/**
 * Identidade de uma entrada de issue do `plan.json` (#10618, fatia 2).
 *
 * Decisão do editor registrada na #10618: a identidade de uma issue é
 * `owner/repo#N` — inclusive em `plan.json`. Uma rodada que pega issue do
 * `vjpixel/diaria-design` grava a entrada qualificada; os gates de fim de
 * rodada, que só conhecem número, NÃO podem ler o `21` dessa entrada como o
 * `vjpixel/diaria-studio#21` (o número colide: o #21 existe nos dois repos).
 *
 * Formas aceitas para uma entrada (em `goal.target_set`, `goal.tiers[*]`,
 * `issues[]`, `state_changed_issues`):
 *   - `123` (number) — legado, sempre `vjpixel/diaria-studio#123`;
 *   - `"owner/repo#N"`, `"#N"`, `"N"`, URL de issue (string);
 *   - `{ ref: "owner/repo#N", ... }` — `ref` vence qualquer outro campo;
 *   - `{ number: N, repo: "owner/repo", ... }` — `repo` ausente = default;
 *     `repo` presente mas ilegível → identidade desconhecida (`null`), nunca
 *     o default por omissão (seria exatamente a colisão que isto evita).
 *
 * `issues` como DICT (`/diaria-develop`, `{ "4800": {...} }`) passa por
 * `normalizeIssues`, que agora preserva a chave qualificada como `ref` quando
 * a chave não é numérica (`{ "vjpixel/diaria-design#21": {...} }`).
 *
 * Pura — nenhum I/O.
 */

import { DEFAULT_ISSUE_REPO, formatIssueRef, legacyIssueNumber, normalizeRepoSlug, parseIssueRef, type IssueRef } from "./issue-repos.ts";

/** Identidade da entrada, ou `null` quando não é inequívoca. */
export function planEntryRef(entry: unknown): IssueRef | null {
  if (typeof entry === "number") return parseIssueRef(entry);
  if (typeof entry === "string") return parseIssueRef(entry);
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as { ref?: unknown; number?: unknown; repo?: unknown };
  if (typeof obj.ref === "string") return parseIssueRef(obj.ref);
  if (typeof obj.number !== "number" || !Number.isFinite(obj.number)) return null;
  if (obj.repo === undefined || obj.repo === null) return parseIssueRef(obj.number);
  if (typeof obj.repo !== "string") return null;
  const repo = normalizeRepoSlug(obj.repo);
  return repo ? parseIssueRef(obj.number, repo) : null;
}

/** `owner/repo#N` da entrada, ou `null`. */
export function planEntryKey(entry: unknown): string | null {
  const ref = planEntryRef(entry);
  return ref ? formatIssueRef(ref) : null;
}

/** Número legado da entrada — só quando ela é do repo default. Entrada de
 * outro repo (ou de identidade desconhecida) devolve `null`. */
export function studioNumberOfPlanEntry(entry: unknown): number | null {
  const ref = planEntryRef(entry);
  return ref ? legacyIssueNumber(ref) : null;
}

/** `true` quando a entrada é inequivocamente de um repo que NÃO é o default. */
export function isForeignPlanEntry(entry: unknown): boolean {
  const ref = planEntryRef(entry);
  return ref !== null && ref.repo !== DEFAULT_ISSUE_REPO;
}

/**
 * Separa as entradas do `plan.json` que são inequivocamente do repo default
 * (`vjpixel/diaria-studio`) das demais (#10778). Gates que só sabem consultar
 * o diaria-studio por número (`gh issue view N` sem `-R`, claims por número)
 * passam por aqui ANTES de consultar: desde a fatia 2 do #10618 uma entrada
 * `"vjpixel/diaria-design#21"` normaliza pra `number: 21`, e consultar esse
 * número no cwd devolveria o estado da studio#21 — veredito errado em
 * silêncio. `skipped` traz a identidade de cada entrada descartada
 * (`owner/repo#N`, ou `"(identidade desconhecida)"`) pro chamador avisar em
 * stderr; descartar sem avisar trocaria um veredito errado por um veredito
 * incompleto igualmente silencioso.
 *
 * Pura — nenhum I/O.
 */
export function partitionStudioPlanEntries<T>(entries: readonly T[]): { studio: T[]; skipped: string[] } {
  const studio: T[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    if (studioNumberOfPlanEntry(entry) !== null) studio.push(entry);
    else skipped.push(planEntryKey(entry) ?? "(identidade desconhecida)");
  }
  return { studio, skipped };
}
