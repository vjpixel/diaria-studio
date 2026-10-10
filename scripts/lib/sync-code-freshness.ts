/**
 * sync-code-freshness.ts (#9925)
 *
 * Veredito ÚNICO sobre "esta edição vai rodar com o código atual?" a partir
 * do resultado de `syncCode()` (`scripts/lib/git-sync.ts`), e o banner que o
 * `sync-code.ts` imprime quando a resposta não é "sim".
 *
 * Por que existe: o banner de código defasado do #6090 só disparava com
 * `commits_behind > 0`. Quando o sync falhava ANTES de conseguir medir
 * (fetch offline/timeout, lock de outro sync, `commits_behind: -1`), ou com o
 * ref `origin/master` velho (fetch falhou, então `commits_behind` 0 é medido
 * contra um ref que não é o do GitHub), nenhum banner saía — a edição rodava
 * com código possivelmente defasado com só uma linha de warn no JSON
 * (incidente 261009, #9925: o editor precisou pedir o sync à mão).
 *
 * Fail-soft continua invariável (CLAUDE.md, #2686): o veredito NÃO bloqueia a
 * edição. Ele só garante que o "não sincronizou" vire um banner explícito e um
 * campo estruturado (`code_freshness`) que o Passo 0 de `/diaria-edicao`
 * repassa ao editor.
 */

import type { GitSyncOutcome, GitSyncResult } from "./git-sync.ts";

/**
 * - `fresh`: fetch rodou e HEAD == origin/master (medido).
 * - `stale`: medido atrás de origin/master (`commits_behind > 0`).
 * - `unknown`: não deu pra confirmar — fetch falhou/expirou (o ref local de
 *   origin/master pode estar velho), sync pulado por lock/worktree, ou a
 *   medição em si falhou (`commits_behind: -1`).
 */
export type CodeFreshnessStatus = "fresh" | "stale" | "unknown";

export interface CodeFreshness {
  status: CodeFreshnessStatus;
  /** Uma linha, pro log/JSON. */
  summary: string;
}

/**
 * Outcomes em que o `git fetch origin` desta chamada NÃO completou ou nem
 * rodou — `commits_behind` (se medido) compara contra um `origin/master`
 * local que pode não ser o do GitHub.
 */
const UNVERIFIED_OUTCOMES: ReadonlySet<GitSyncOutcome> = new Set<GitSyncOutcome>([
  "fetch_failed",
  "fetch_timeout",
  "sync_in_progress",
  "worktree_refused",
  "checkout_failed",
  // #9988: com branch != master este outcome volta ANTES do fetch (e do
  // checkout) — `measureSyncState` mede o HEAD de OUTRA branch contra um
  // `origin/master` local velho, e uma branch à frente desse ref saía
  // `commits_behind: 0` → `fresh`. Em master o fetch já rodou, mas o checkout
  // está preso em estado absorvente: "não verificado" é o veredito honesto.
  "preexisting_unmerged_state",
]);

type FreshnessInput = Pick<GitSyncResult, "outcome" | "commits_behind" | "up_to_date">;

/** Puro. */
export function assessCodeFreshness(r: FreshnessInput): CodeFreshness {
  if (r.commits_behind > 0) {
    return {
      status: "stale",
      summary: `código ${r.commits_behind} commit(s) atrás de origin/master (outcome '${r.outcome}')`,
    };
  }
  if (UNVERIFIED_OUTCOMES.has(r.outcome)) {
    return {
      status: "unknown",
      summary: `sync não confirmou o código atual (outcome '${r.outcome}') — origin/master local pode estar velho`,
    };
  }
  if (r.commits_behind < 0 || !r.up_to_date) {
    return {
      status: "unknown",
      summary: `não foi possível medir a defasagem contra origin/master (outcome '${r.outcome}')`,
    };
  }
  return { status: "fresh", summary: "código em dia com origin/master" };
}

/**
 * Banner multi-linha pro stderr, ou `null` quando `fresh`. O texto diz que a
 * edição CONTINUA (fail-soft) e o que fazer — nunca "parou".
 */
export function formatCodeFreshnessBanner(f: CodeFreshness, r: Pick<GitSyncResult, "outcome">): string | null {
  if (f.status === "fresh") return null;
  const head =
    f.status === "stale"
      ? `⚠  CÓDIGO DEFASADO — ${f.summary}.`
      : `⚠  CÓDIGO NÃO VERIFICADO — ${f.summary}.`;
  return (
    `\n${"=".repeat(72)}\n` +
    `${head}\n` +
    `   A edição vai continuar (fail-soft, #2686), mas scripts podem rodar com\n` +
    `   comportamento antigo — incluindo os guards que deveriam detectar isso.\n` +
    `   Repasse este aviso ao editor ANTES de seguir pro Stage 0 (#9925).\n` +
    `   Para sincronizar: git fetch origin && git merge --ff-only origin/master\n` +
    `   (ou rode de novo: npx tsx scripts/sync-code.ts — veja o banner do\n` +
    `   outcome '${r.outcome}' acima/abaixo pro motivo e a ação específica).\n` +
    `${"=".repeat(72)}\n\n`
  );
}
