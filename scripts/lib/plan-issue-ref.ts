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
import { describeUnknownPlanEntry } from "./issue-key.ts";

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

/**
 * Marca de "visão local" (#10618, fatia 4, review H) que
 * `groupPlanEntriesByRepo` põe na cópia de uma entrada de OUTRO repo. A cópia
 * mantém `ref` canônico — qualquer resolvedor de identidade
 * (`planEntryRef`, `studioNumberOfPlanEntry`, `requireStudioIssueNumber`)
 * continua vendo `owner/repo#N`, nunca a studio#N — e a marca só autoriza
 * `localNumberOfPlanEntry` a devolver o número local DENTRO do grupo.
 * `Symbol.for` (e não um campo string) pra não sair num `JSON.stringify`.
 */
const LOCAL_VIEW = Symbol.for("diaria.plan-entry.local-view");

/** `true` quando a entrada é uma cópia em visão local de `groupPlanEntriesByRepo`. */
export function isLocalViewPlanEntry(entry: unknown): boolean {
  return !!entry && typeof entry === "object" && (entry as Record<symbol, unknown>)[LOCAL_VIEW] === true;
}

/**
 * Número da entrada DENTRO do grupo de `groupPlanEntriesByRepo`: o número
 * local de uma cópia em visão local, ou o número do studio de uma entrada do
 * default. Entrada de outro repo FORA de um grupo (sem a marca) devolve
 * `null` — mesma recusa de `studioNumberOfPlanEntry`. Só pra libs que casam
 * por número contra dados já buscados no repo do grupo (`gh -R`).
 */
export function localNumberOfPlanEntry(entry: unknown): number | null {
  if (isLocalViewPlanEntry(entry)) {
    const n = (entry as { number?: unknown }).number;
    return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return studioNumberOfPlanEntry(entry);
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

/** Um repo e as entradas do plano que são dele, numeradas localmente. */
export interface PlanEntriesOfRepo<T> {
  /** `owner/repo` (o default incluso). */
  repo: string;
  /** `true` quando é o repo default (`vjpixel/diaria-studio`). */
  isDefault: boolean;
  /**
   * Entradas do repo em "visão local": a do default sai como veio; a de
   * outro repo sai como cópia com `number` = o número NAQUELE repo, `ref`
   * canônico (`owner/repo#N`) e a marca de visão local, de modo que uma lib
   * que casa por número (sem saber de repo) a trate como "o #N deste repo"
   * — só é seguro porque cada grupo é avaliado sozinho, com dados buscados
   * no repo dele (`gh -R`). A cópia NÃO perde a identidade (review H): se
   * vazar pra um resolvedor (`studioNumberOfPlanEntry`,
   * `requireStudioIssueNumber`), ele continua vendo o repo de verdade, nunca
   * a studio#N. Guard que precise do número local usa
   * `localNumberOfPlanEntry`.
   */
  entries: T[];
}

/**
 * Agrupa as entradas do `plan.json` por repo (#10618, fatia 4) — o caminho
 * para um gate que só sabe casar por número avaliar também o diaria-design:
 * roda a mesma lógica uma vez por grupo, buscando os dados no repo do grupo.
 * O grupo do default vem primeiro, os demais em ordem alfabética. `unknown`
 * traz uma marca por entrada sem identidade legível, pro chamador avisar.
 *
 * Pura — nenhum I/O.
 */
export function groupPlanEntriesByRepo<T>(entries: readonly T[]): {
  groups: PlanEntriesOfRepo<T>[];
  unknown: string[];
} {
  const byRepo = new Map<string, T[]>();
  const unknown: string[] = [];
  entries.forEach((entry, index) => {
    const ref = planEntryRef(entry);
    if (!ref) {
      unknown.push(`${describeUnknownPlanEntry(entry, index)} (identidade desconhecida)`);
      return;
    }
    const list = byRepo.get(ref.repo) ?? [];
    if (ref.repo === DEFAULT_ISSUE_REPO || !entry || typeof entry !== "object") {
      list.push(entry);
    } else {
      list.push({
        ...(entry as Record<string, unknown>),
        number: ref.number,
        ref: formatIssueRef(ref),
        [LOCAL_VIEW]: true,
      } as T);
    }
    byRepo.set(ref.repo, list);
  });
  const repos = [...byRepo.keys()].sort((a, b) =>
    a === DEFAULT_ISSUE_REPO ? -1 : b === DEFAULT_ISSUE_REPO ? 1 : a.localeCompare(b),
  );
  return {
    groups: repos.map((repo) => ({ repo, isDefault: repo === DEFAULT_ISSUE_REPO, entries: byRepo.get(repo)! })),
    unknown,
  };
}

/** Rótulo da issue `n` do repo de um grupo: `#N` no default, `owner/repo#N` nos outros. */
export function labelInRepo(repo: string, n: number): string {
  return repo === DEFAULT_ISSUE_REPO ? `#${n}` : `${repo}#${n}`;
}
