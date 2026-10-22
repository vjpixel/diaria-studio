/**
 * `IssueKey` — fonte única de "chave de issue" multi-repo (#10618, fatia 3).
 *
 * Decisão do editor registrada na #10618: a identidade de uma issue é
 * `owner/repo#N`; um número sozinho continua significando
 * `vjpixel/diaria-studio#N` (ver `issue-repos.ts`). As fatias 1 e 2 deram a
 * identidade (`IssueRef`, `parseIssueRef`, `formatIssueRef`) e a leitura de
 * entradas do `plan.json` (`plan-issue-ref.ts`), mas cada gate ainda montava
 * a própria string `owner/repo#N` (ou, pior, lia `number` cru). Este módulo
 * dá:
 *
 * - **`IssueKey`**: string `owner/repo#N` com marca de tipo. Só nasce por
 *   `toIssueKey`/`issueKeyOfPlanEntry`, então quem recebe um `IssueKey` sabe
 *   que ele já é canônico (minúsculas, qualificado) — comparar dois com `===`
 *   é comparar identidade, e o `21` do diaria-design nunca é igual ao `21` do
 *   diaria-studio.
 * - **`claimKeysOf(session)`**: as claims de uma sessão do `session-registry`
 *   como `IssueKey`, juntando `claimed_issues` (números = studio) e
 *   `claimed_foreign_issues` (`owner/repo#N`). Consumidores que só liam
 *   `claimed_issues` perdiam as claims do design em silêncio.
 * - **Guard contra número cru** (`requireStudioIssueNumber`): devolve o
 *   número do diaria-studio de uma entrada, e LANÇA `ForeignIssueNumberError`
 *   quando a entrada é de outro repo (ou de identidade desconhecida). É o que
 *   uma API que só entende número deve chamar em vez de ler `entry.number`:
 *   desde a fatia 2, `normalizeIssues` dá `number: 21` pra chave
 *   `"vjpixel/diaria-design#21"`, e ler esse campo direto consultaria a
 *   studio#21 sem erro nenhum (o defeito do #10778).
 *
 * Puro — nenhum I/O.
 */

import {
  DEFAULT_ISSUE_REPO,
  formatIssueRef,
  legacyIssueNumber,
  normalizeRepoSlug,
  parseIssueRef,
  type IssueRef,
} from "./issue-repos.ts";
import { planEntryRef } from "./plan-issue-ref.ts";

declare const ISSUE_KEY_BRAND: unique symbol;

/** `owner/repo#N` canônico (minúsculas, sempre qualificado). */
export type IssueKey = string & { readonly [ISSUE_KEY_BRAND]: true };

/**
 * Chave canônica de uma identidade. Aceita `IssueRef`, número (= repo
 * default), `"#N"`, `"N"`, `"owner/repo#N"` e URL de issue/PR. `null` quando
 * não é inequívoca — nunca chuta.
 */
export function toIssueKey(input: IssueRef | string | number | null | undefined): IssueKey | null {
  if (input && typeof input === "object") {
    const repo = normalizeRepoSlug(input.repo);
    if (!repo || !Number.isSafeInteger(input.number) || input.number <= 0) return null;
    return formatIssueRef({ repo, number: input.number }) as IssueKey;
  }
  const ref = parseIssueRef(input as string | number | null | undefined);
  return ref ? (formatIssueRef(ref) as IssueKey) : null;
}

/** Chave de uma entrada do `plan.json` (todas as formas de `planEntryRef`). */
export function issueKeyOfPlanEntry(entry: unknown): IssueKey | null {
  const ref = planEntryRef(entry);
  return ref ? toIssueKey(ref) : null;
}

/** `IssueRef` de uma chave. Total: toda `IssueKey` nasceu canônica. */
export function refOfIssueKey(key: IssueKey): IssueRef {
  const ref = parseIssueRef(key);
  if (!ref) throw new Error(`IssueKey corrompida: ${JSON.stringify(key)} (#10618)`);
  return ref;
}

/** `owner/repo` da chave. */
export function repoOfIssueKey(key: IssueKey): string {
  return refOfIssueKey(key).repo;
}

/** Número da issue dentro do repo DELA (não necessariamente o studio). */
export function issueNumberInRepo(key: IssueKey): number {
  return refOfIssueKey(key).number;
}

/** `true` quando a chave é do repo default (`vjpixel/diaria-studio`). */
export function isStudioIssueKey(key: IssueKey): boolean {
  return repoOfIssueKey(key) === DEFAULT_ISSUE_REPO;
}

/** Número legado (studio) da chave, ou `null` quando é de outro repo. */
export function studioNumberOfIssueKey(key: IssueKey): number | null {
  return legacyIssueNumber(refOfIssueKey(key));
}

/**
 * Rótulo pra mensagem de gate: `#N` pro diaria-studio (a saída de sempre,
 * que os SKILL.md e os testes de CLI leem) e `owner/repo#N` pros outros.
 */
export function issueKeyLabel(key: IssueKey): string {
  const n = studioNumberOfIssueKey(key);
  return n !== null ? `#${n}` : key;
}

/** Ordenação estável: repo default primeiro, depois repo e número. */
export function compareIssueKeys(a: IssueKey, b: IssueKey): number {
  const ra = refOfIssueKey(a);
  const rb = refOfIssueKey(b);
  const da = ra.repo === DEFAULT_ISSUE_REPO ? 0 : 1;
  const db = rb.repo === DEFAULT_ISSUE_REPO ? 0 : 1;
  if (da !== db) return da - db;
  if (ra.repo !== rb.repo) return ra.repo < rb.repo ? -1 : 1;
  return ra.number - rb.number;
}

/** Shape mínimo de sessão do `session-registry` lido por `claimKeysOf`. */
export interface ClaimKeyBearingSession {
  claimed_issues?: readonly number[];
  claimed_issues_effective?: readonly number[];
  claimed_foreign_issues?: readonly string[];
  claimed_foreign_issues_effective?: readonly string[];
}

/**
 * Claims de uma sessão como `IssueKey`, sem colisão entre repos.
 *
 * Prefere os campos `*_effective` (`listActiveSessions` já aplicou a janela
 * de retenção, #6623/#7227) e cai nos crus quando ausentes (fixture antiga,
 * registro lido direto do disco) — o MESMO critério nos dois espaços, pra
 * claim do design nunca valer por mais (ou menos) tempo que a do studio.
 * Entrada ilegível em `claimed_foreign_issues` é descartada (nunca vira
 * número do studio).
 */
export function claimKeysOf(session: ClaimKeyBearingSession): IssueKey[] {
  const out = new Set<IssueKey>();
  for (const n of session.claimed_issues_effective ?? session.claimed_issues ?? []) {
    const key = toIssueKey(n);
    if (key) out.add(key);
  }
  for (const raw of session.claimed_foreign_issues_effective ?? session.claimed_foreign_issues ?? []) {
    const key = typeof raw === "string" ? toIssueKey(raw) : null;
    // Ref do studio gravada (por engano) no campo de outro repo continua
    // sendo a mesma issue — `toIssueKey` já canoniza, então não duplica.
    if (key) out.add(key);
  }
  return [...out].sort(compareIssueKeys);
}

/**
 * Agrupa chaves por repo, separando o que está fora da allowlist
 * (`platform.config.json → issue_repos`, via `loadIssueRepos`). Gate que
 * consulta o GitHub só consulta repo da allowlist — repo estranho (typo,
 * fork) vira `outsideAllowlist` pro chamador avisar, nunca uma chamada `-R`
 * a um repo arbitrário.
 */
export function groupIssueKeysByRepo(
  keys: Iterable<IssueKey>,
  allowlist: readonly string[],
): { byRepo: Map<string, IssueKey[]>; outsideAllowlist: IssueKey[] } {
  const allowed = new Set(allowlist.map((r) => normalizeRepoSlug(r)).filter((r): r is string => !!r));
  allowed.add(DEFAULT_ISSUE_REPO);
  const byRepo = new Map<string, IssueKey[]>();
  const outsideAllowlist: IssueKey[] = [];
  for (const key of new Set(keys)) {
    const repo = repoOfIssueKey(key);
    if (!allowed.has(repo)) {
      outsideAllowlist.push(key);
      continue;
    }
    const list = byRepo.get(repo) ?? [];
    list.push(key);
    byRepo.set(repo, list);
  }
  for (const list of byRepo.values()) list.sort(compareIssueKeys);
  return { byRepo, outsideAllowlist: outsideAllowlist.sort(compareIssueKeys) };
}

/** Erro do guard: entrada de outro repo lida como número do diaria-studio. */
export class ForeignIssueNumberError extends Error {
  readonly key: IssueKey | null;
  constructor(where: string, key: IssueKey | null) {
    super(
      `[${where}] entrada ${key ?? "(identidade desconhecida)"} lida como número do diaria-studio — ` +
        `uma API que só entende número não pode receber issue de outro repo (#10618). ` +
        `Use a IssueKey (scripts/lib/issue-key.ts) ou filtre antes com partitionStudioPlanEntries.`,
    );
    this.name = "ForeignIssueNumberError";
    this.key = key;
  }
}

/**
 * Guard (#10618, fatia 3): número do diaria-studio de uma entrada, ou LANÇA.
 *
 * Para API que só entende número e NÃO pode descartar a entrada em silêncio
 * (devolve `number[]` a quem vai chamar `gh` sem `-R`): entrada de outro repo
 * — inclusive a que `normalizeIssues` já preencheu com `number` a partir da
 * chave `"owner/repo#N"` — e entrada de identidade desconhecida (`repo`
 * ilegível) lançam `ForeignIssueNumberError`: falhar alto é melhor que
 * devolver o número de OUTRA issue sem aviso.
 *
 * Estado real dos chamadores (não é a única defesa): hoje só
 * `planIssuesRequiringRouting` (`skipped-develop-track.ts`, API legada) lança
 * por aqui. Os gates de fim de rodada que só consultam o studio filtram ANTES
 * com os equivalentes que não lançam — `partitionStudioPlanEntries` (separa e
 * avisa: `check-overnight-comment-coverage`, `check-decision-label-drift-gate`,
 * `check-develop-label-cleared`) ou `studioNumberOfPlanEntry`
 * (`collectKnownIssueNumbers`, `findRetrackedUnworkedIssues`) — e os que
 * cobrem outros repos leem a `IssueKey` (`issueKeyOfPlanEntry`). Nenhum
 * desses lê `entry.number` cru.
 */
export function requireStudioIssueNumber(entry: unknown, where: string): number {
  const ref = planEntryRef(entry);
  const n = ref ? legacyIssueNumber(ref) : null;
  if (n === null) throw new ForeignIssueNumberError(where, ref ? (formatIssueRef(ref) as IssueKey) : null);
  return n;
}

/**
 * Descrição crua de uma entrada do plano de identidade desconhecida, pra
 * aviso de gate: índice + `ref`/`repo`/`number` como vieram (#10618, fatia 3)
 * — "(identidade desconhecida)" sozinho não diz ao coordenador QUAL entrada
 * corrigir.
 */
export function describeUnknownPlanEntry(entry: unknown, index: number): string {
  if (!entry || typeof entry !== "object") return `entrada [${index}] ${JSON.stringify(entry) ?? String(entry)}`;
  const e = entry as { ref?: unknown; repo?: unknown; number?: unknown };
  const parts: string[] = [];
  if (e.ref !== undefined) parts.push(`ref=${JSON.stringify(e.ref)}`);
  if (e.repo !== undefined) parts.push(`repo=${JSON.stringify(e.repo)}`);
  if (e.number !== undefined) parts.push(`number=${JSON.stringify(e.number)}`);
  return `entrada [${index}] (${parts.length > 0 ? parts.join(", ") : "sem ref/repo/number"})`;
}

/** `true` quando a entrada tenta declarar identidade (`ref` ou `repo`
 * presentes) — distingue "identidade ilegível" de "entrada sem número"
 * (esta última, os gates ignoram como sempre). */
export function planEntryDeclaresIdentity(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as { ref?: unknown; repo?: unknown };
  return (e.ref !== undefined && e.ref !== null) || (e.repo !== undefined && e.repo !== null);
}
