/**
 * scripts/lib/claim-staleness.ts (#6436)
 *
 * A sessão `continuo` (`hermes-cron-{id}`, cron do Hermes que roda a cada
 * 60min — ver CLAUDE.md "A infra do kind `continuo` tem um consumidor
 * EXTERNO") re-reivindica (`claim-issue`) as mesmas issues bloqueadas a
 * cada ciclo. Como `claimIssueCheckAndSet` só faz `heartbeat` refrescar
 * (`lastHeartbeat`), o claim NUNCA caduca por staleness de sessão — a
 * sessão está sempre "viva" aos olhos de `listActiveSessions`. Achado ao
 * vivo (#6436, rodada 260827b): #6051/#6185/#6186/#6431 ficaram
 * `claimed-por-outra-sessao` indefinidamente, invisíveis tanto pro painel
 * de Triagem do Studio (que não consulta `data/sessions/` — só GitHub)
 * quanto pro `check-block-staleness.ts` (#6259, que só libera claim quando
 * NENHUMA sessão ativa segura mais a issue — nunca quando a MESMA sessão
 * segura por tempo demais sem produzir PR).
 *
 * Este módulo fecha a 2ª metade do #6436 (a 1ª é visibilidade no painel,
 * ver `scripts/studio-ui/studio-issues.ts`): um teto de IDADE de claim SEM
 * PR aberto correspondente. Usa `claimed_issues_at` (#6436,
 * `scripts/lib/session-registry.ts`) — o timestamp da PRIMEIRA
 * reivindicação, nunca refrescado por re-claim — como a fonte de "idade
 * real", que é exatamente o dado que a idade da SESSÃO (heartbeat) não
 * consegue fornecer pra uma sessão perpétua como `continuo`.
 *
 * ## Por que "sem PR aberto" é a segunda metade da condição
 *
 * Claim antigo COM PR aberto é trabalho real em andamento — não é staleness,
 * é só uma unidade grande/lenta. Só claim antigo SEM nenhum PR referenciando
 * a issue é sinal de "esta sessão reivindicou e nunca começou" (ou começou e
 * abandonou sem soltar) — candidato a pendência de re-triagem, não uma
 * proibição de trabalhar (outra sessão, ou a própria dona depois de destravar,
 * ainda pode pegar).
 *
 * Puro (`findAgedClaims`) — o CLI (`scripts/check-block-staleness.ts`, #6259,
 * reusa o mesmo entrypoint pra não duplicar mais um script de gate) monta o
 * consultor real via `gh pr list --search`.
 *
 * @see scripts/lib/session-registry.ts (`claimed_issues_at`, `listActiveSessions`)
 * @see scripts/lib/block-staleness.ts (irmão — libera claim quando NINGUÉM
 *      mais segura; este módulo cobre o caso oposto: a MESMA sessão segura
 *      por tempo demais sem produzir trabalho visível)
 * @see scripts/studio-ui/studio-issues.ts (1ª metade do #6436 — visibilidade
 *      no painel de Triagem via `listActiveSessions`)
 */

/** Teto de idade de claim sem PR aberto correspondente — "2 rodadas" citado
 * na issue, aproximado como 6h (2× o ciclo de 60min da `continuo` já daria
 * margem de sobra; 6h cobre também rodadas overnight/develop mais longas
 * sem gerar falso positivo numa unidade só um pouco lenta). */
export const CLAIM_STALE_AGE_MS = 6 * 60 * 60 * 1000;

/** Uma entrada de claim, já achatada a partir de `listActiveSessions` — uma
 * linha por (sessão, issue reivindicada). */
export interface ClaimEntry {
  issueNumber: number;
  kind: string;
  machineTag: string;
  sessionId: string;
  /** ISO de `claimed_issues_at[String(issueNumber)]` — `null` quando a
   * sessão é anterior ao #6436 e nunca gravou o campo (idade desconhecida,
   * nunca tratada como "acabou de reivindicar"). */
  claimedAt: string | null;
}

/** Subconjunto mínimo de `ActiveSessionRecord` que este módulo consome —
 * evita import cruzado de `session-registry.ts` só pelo tipo (mantém o
 * módulo testável com fixtures simples, mesmo padrão de `block-staleness.ts`). */
export interface ClaimBearingSession {
  kind: string;
  machineTag: string;
  sessionId: string;
  claimed_issues?: number[];
  claimed_issues_at?: Record<string, string>;
  /** #6623: quando presente, é a fonte preferida — já resolve staleness
   * (vazio quando a sessão está `stale`). Ausente (fixture antiga, ou
   * chamador que não passou por `listActiveSessions`) cai no fallback
   * `claimed_issues` bruto, comportamento anterior preservado. */
  claimed_issues_effective?: number[];
}

/** Pure: achata as claims EFETIVAS de cada sessão numa lista de `ClaimEntry`.
 *
 * #6623: lê `claimed_issues_effective` quando presente (já resolve
 * staleness — vazio pra sessão `stale`) em vez de `claimed_issues` bruto.
 * Antes deste fix, uma sessão `continuo` que nunca fica `stale` (heartbeat
 * perpétuo, ver docstring do módulo) continuava correta — mas qualquer
 * OUTRA sessão `stale` cujo claim já não vale mais (`is-claimed` já o trata
 * como livre) ainda entrava na lista de "claims envelhecidas" deste módulo,
 * reportando staleness sobre uma reivindicação que já não existe de fato.
 * Fallback pra `claimed_issues` bruto quando `claimed_issues_effective` não
 * foi passado (fixtures antigas / chamador fora de `listActiveSessions`) —
 * nunca uma mudança de comportamento pra quem já não tinha o campo. */
export function flattenClaims(sessions: readonly ClaimBearingSession[]): ClaimEntry[] {
  const out: ClaimEntry[] = [];
  for (const session of sessions) {
    const issues = session.claimed_issues_effective ?? session.claimed_issues ?? [];
    for (const issueNumber of issues) {
      const claimedAt = session.claimed_issues_at?.[String(issueNumber)] ?? null;
      out.push({
        issueNumber,
        kind: session.kind,
        machineTag: session.machineTag,
        sessionId: session.sessionId,
        claimedAt,
      });
    }
  }
  return out;
}

export interface AgedClaimFinding {
  issueNumber: number;
  kind: string;
  machineTag: string;
  sessionId: string;
  claimedAt: string;
  ageMs: number;
}

/**
 * Pure: entre as claims achatadas, devolve as que passam do teto de idade
 * (`maxAgeMs`) E cuja issue não tem PR aberto — `hasOpenPr` é injetável
 * (CLI monta via `gh pr list --search`, testes injetam fixture). Claim sem
 * `claimedAt` conhecido (sessão pré-#6436) nunca é reportado — idade
 * desconhecida não é idade excedida, mesmo fail-soft de `block-staleness.ts`
 * (preferir falso negativo a reabrir/marcar staleness por engano de dado
 * ausente).
 *
 * `isIssueClosed` (opcional, #6754): issue já `CLOSED` nunca precisa de
 * re-triagem — reportá-la como "claim envelhecida" é sempre falso positivo
 * (achado ao vivo #6754/#6677: a issue tinha sido fechada, mas o checker
 * nunca consultava o estado dela antes de sinalizar). `true` pula o
 * finding; `false`/`null`/omitido segue a avaliação normal (idade +
 * `hasOpenPr`) — mesmo fail-soft do resto do módulo, "não sei" nunca vira
 * "está fechada".
 */
export function findAgedClaims(
  entries: readonly ClaimEntry[],
  now: number,
  maxAgeMs: number,
  hasOpenPr: (issueNumber: number) => boolean | null,
  isIssueClosed?: (issueNumber: number) => boolean | null,
): AgedClaimFinding[] {
  const out: AgedClaimFinding[] = [];
  for (const entry of entries) {
    if (!entry.claimedAt) continue;
    const claimedAtMs = Date.parse(entry.claimedAt);
    if (!Number.isFinite(claimedAtMs)) continue;
    const ageMs = now - claimedAtMs;
    if (ageMs < maxAgeMs) continue;
    if (isIssueClosed?.(entry.issueNumber) === true) continue; // issue fechada — nunca precisa de re-triagem
    const openPr = hasOpenPr(entry.issueNumber);
    if (openPr !== false) continue; // true ou null (não verificável) → nunca reporta
    out.push({
      issueNumber: entry.issueNumber,
      kind: entry.kind,
      machineTag: entry.machineTag,
      sessionId: entry.sessionId,
      claimedAt: entry.claimedAt,
      ageMs,
    });
  }
  return out.sort((a, b) => a.issueNumber - b.issueNumber);
}
