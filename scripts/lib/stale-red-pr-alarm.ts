/**
 * scripts/lib/stale-red-pr-alarm.ts (#8530)
 *
 * Lógica PURA (sem I/O) do alarme "PR aberta com CI vermelho há mais de N
 * horas sem commit novo". Achado da #8530: na varredura de 20/09/2026 as
 * 3 de 3 PRs abertas estavam paradas, e o docstring de
 * `test/test-runner-import-guard.test.ts` já registrava o mesmo padrão
 * (8 de 8 PRs vermelhas na origem do #7807) — uma PR entra em vermelho, o
 * autor (sessão overnight/develop/continuo) já encerrou o tick, e nada
 * volta nela. Fica indistinguível de uma PR recém-aberta cujo CI ainda vai
 * ficar verde.
 *
 * Reusa `evaluatePrChecksGate` (`scripts/lib/pr-checks-gate.ts`) — mesma
 * fonte de verdade do gate de merge autônomo — em vez de reimplementar a
 * leitura de `statusCheckRollup`: um check `CANCELLED` supersedido por
 * force-push, ou um PR `CONFLICTING` sem check nenhum registrado, já tem
 * tratamento correto ali (ver docstrings de `pr-checks-gate.ts`); duplicar
 * essa lógica aqui reintroduziria os mesmos bugs que aquele módulo já
 * corrigiu.
 *
 * `scripts/stale-red-pr-alarm.ts` faz o I/O (`gh pr list`) e chama este
 * módulo pra decidir o que alarmar — mesmo molde de
 * `scripts/lib/on-hold-vencimento-alarm.ts`/`scripts/lib/npm-version-drift-alarm.ts`.
 */
import { evaluatePrChecksGate, type PrChecksGateResult } from "./pr-checks-gate.ts";

const MS_PER_HOUR = 60 * 60 * 1000;

/** Um item de `commits` no payload de `gh pr view {N} --json commits`. Só o
 * campo usado aqui — o payload real tem mais (authors, messageBody, etc),
 * ignorados de propósito. */
export interface PrCommitEntry {
  committedDate?: string | null;
  authoredDate?: string | null;
}

/** Uma entrada "básica" — o que `gh pr list --state open --json
 * number,title,isDraft,mergeable,statusCheckRollup` devolve, SEM `commits`.
 * Separado de `StaleRedPrListEntry` de propósito (#8530 achado ao vivo):
 * pedir `commits` no MESMO `gh pr list` que lista até 100 PRs multiplica o
 * custo de nó do GraphQL (commits × authors × N PRs) e estoura o limite de
 * 500k nós do GitHub mesmo com poucas PRs abertas — `gh pr view {N} --json
 * commits`, um PR por vez, não tem esse problema. `selectStaleRedPrCandidates`
 * decide, só com estes campos (baratos em lote), quais PRs justificam o
 * round-trip individual de `commits`. */
export interface StaleRedPrBasicEntry {
  number: number;
  title: string;
  isDraft: boolean;
  mergeable?: string | null;
  statusCheckRollup: unknown;
}

/** `StaleRedPrBasicEntry` + `commits` — só populado pros candidatos que
 * `selectStaleRedPrCandidates` apontou (nunca pro lote inteiro, ver acima). */
export interface StaleRedPrListEntry extends StaleRedPrBasicEntry {
  commits: readonly PrCommitEntry[];
}

export interface StaleRedPrFinding {
  number: number;
  title: string;
  /** Nomes dos checks reprovados (de `PrChecksGateResult.failingChecks`). */
  failingChecks: string[];
  /** ISO 8601 — `committedDate` do commit mais recente da PR. */
  lastCommitAt: string;
  hoursSinceLastCommit: number;
}

/**
 * Data do commit mais recente entre `commits` — `committedDate` (data em
 * que o commit foi de fato integrado à branch, que é o que importa pra
 * "sem trabalho novo", não `authoredDate`, que pode ser bem anterior num
 * rebase/cherry-pick). `null` quando a lista está vazia ou nenhuma entrada
 * tem `committedDate` válido — caller trata como "não dá pra avaliar",
 * NUNCA como "0 horas atrás" (que produziria falso-negativo silencioso, o
 * oposto do que este alarme existe pra evitar).
 */
export function latestCommitDate(commits: readonly PrCommitEntry[]): string | null {
  let latest: string | null = null;
  let latestMs = -Infinity;
  for (const c of commits) {
    if (typeof c.committedDate !== "string" || c.committedDate === "") continue;
    const ms = Date.parse(c.committedDate);
    if (Number.isNaN(ms)) continue;
    if (ms > latestMs) {
      latestMs = ms;
      latest = c.committedDate;
    }
  }
  return latest;
}

/**
 * Filtra, a partir do payload BARATO (`gh pr list` sem `commits`), quais
 * PRs justificam o round-trip individual de `gh pr view {N} --json commits`
 * — CI vermelho (verdict `"fail"`, nunca `"pending"`/`"error"`/
 * `"blocked_by_conflict"`) e não-draft. Pura — nenhuma chamada de rede
 * aqui, só decide QUAIS números pedir depois.
 */
export function selectStaleRedPrCandidates(prs: readonly StaleRedPrBasicEntry[]): StaleRedPrBasicEntry[] {
  return prs.filter((pr) => {
    if (pr.isDraft) return false;
    const gate = evaluatePrChecksGate(pr.statusCheckRollup, { mergeable: pr.mergeable ?? undefined });
    return gate.verdict === "fail";
  });
}

/**
 * Avalia todas as PRs abertas e devolve os achados: CI vermelho (verdict
 * `"fail"` do gate — nunca `"pending"`/`"error"`/`"blocked_by_conflict"`,
 * que não são "vermelho confirmado") + sem commit novo há >= `thresholdHours`
 * + não-draft (drafts como o #8519 são por construção — aguardam triagem
 * manual, não parada esquecida).
 *
 * Recebe tipicamente só o subconjunto já filtrado por
 * `selectStaleRedPrCandidates` (com `commits` anexado pelo caller após o
 * round-trip individual) — mas revalida draft/gate por conta própria
 * (defesa em profundidade, aceita qualquer `StaleRedPrListEntry[]`).
 *
 * Pura, determinística — `now` é sempre passado explicitamente pelo caller
 * (nunca `new Date()` interno), mesmo padrão de `evaluateNpmVersionDrift`.
 */
export function evaluateStaleRedPrs(
  prs: readonly StaleRedPrListEntry[],
  now: Date,
  thresholdHours: number,
): StaleRedPrFinding[] {
  const findings: StaleRedPrFinding[] = [];
  for (const pr of prs) {
    if (pr.isDraft) continue;

    const gate: PrChecksGateResult = evaluatePrChecksGate(pr.statusCheckRollup, {
      mergeable: pr.mergeable ?? undefined,
    });
    if (gate.verdict !== "fail") continue;

    const lastCommitAt = latestCommitDate(pr.commits);
    if (lastCommitAt === null) continue; // não dá pra avaliar "há quanto tempo" — nunca inventa 0h

    const hoursSinceLastCommit = (now.getTime() - Date.parse(lastCommitAt)) / MS_PER_HOUR;
    if (hoursSinceLastCommit < thresholdHours) continue;

    findings.push({
      number: pr.number,
      title: pr.title,
      failingChecks: gate.failingChecks,
      lastCommitAt,
      hoursSinceLastCommit,
    });
  }
  return findings.sort((a, b) => b.hoursSinceLastCommit - a.hoursSinceLastCommit);
}

/** `true` quando há ao menos 1 achado — caller usa isto pra decidir se vale
 * a pena montar o e-mail/issue. */
export function shouldAlarmStaleRedPrs(findings: readonly StaleRedPrFinding[]): boolean {
  return findings.length > 0;
}

/**
 * Fingerprint DERIVADO do conjunto de achados (mesmo padrão de
 * `on-hold-vencimento-alarm.ts`) — não uma string fixa. Uma issue de alarme
 * único e estático reusaria a MESMA issue pra sempre, mesmo quando o
 * conjunto de PRs paradas mudar (uma resolvida, outra nova entrando em
 * vermelho) — o `ensureAlarmIssue` fecharia a issue velha só quando o
 * conjunto ficar vazio, nunca atualizando o corpo no meio do caminho.
 * Arredonda as horas pro bucket de `thresholdHours` mais próximo pra não
 * gerar um fingerprint novo a cada execução só porque o relógio andou —
 * o que importa pro fingerprint é QUAL PR está parada, não há quantas
 * horas exatas.
 */
export function staleRedPrFindingSetKey(findings: readonly StaleRedPrFinding[]): string {
  return findings
    .map((f) => `${f.number}:${f.failingChecks.slice().sort().join("|")}`)
    .sort()
    .join(",");
}

export function buildStaleRedPrAlarmEmail(
  findings: readonly StaleRedPrFinding[],
  thresholdHours: number,
  now: Date,
): { subject: string; body: string } {
  const subject = `${findings.length} PR(s) parada(s): CI vermelho há mais de ${thresholdHours}h sem commit novo`;
  const lines = findings.map((f) => {
    const hours = f.hoursSinceLastCommit.toFixed(1);
    const checks = f.failingChecks.length > 0 ? f.failingChecks.join(", ") : "(nomes não reportados)";
    return `- PR #${f.number} "${f.title}" — parada há ${hours}h (último commit ${f.lastCommitAt}). Checks reprovados: ${checks}.`;
  });
  const body = [
    `Varredura de ${now.toISOString()} — limiar ${thresholdHours}h.`,
    "",
    ...lines,
    "",
    "Nenhuma destas PRs teve commit novo desde que o CI ficou vermelho. PRs draft (aguardando triagem por construção) não entram nesta lista.",
    "Ação: retomar a implementação (fix + push) ou fechar a PR se o escopo mudou.",
  ].join("\n");
  return { subject, body };
}
