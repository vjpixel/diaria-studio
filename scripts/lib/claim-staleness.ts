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

import {
  claimKeysOf,
  compareIssueKeys,
  isStudioIssueKey,
  issueNumberInRepo,
  repoOfIssueKey,
  toIssueKey,
  type IssueKey,
} from "./issue-key.ts";

/** Uma entrada de claim, já achatada a partir de `listActiveSessions` — uma
 * linha por (sessão, issue reivindicada). */
export interface ClaimEntry {
  /** Número da issue no repo DELA (`issueKey` diz qual; ausente = studio). */
  issueNumber: number;
  /** #10618 (fatia 3): identidade `owner/repo#N` — presente nas claims de
   * outro repo de `flattenAllClaims`. Ausente = diaria-studio#`issueNumber`
   * (`flattenClaims` não preenche, pra não mudar o shape que o painel lê). */
  issueKey?: IssueKey;
  kind: string;
  machineTag: string;
  sessionId: string;
  /** ISO de `claimed_issues_at[String(issueNumber)]` — `null` quando a
   * sessão é anterior ao #6436 e nunca gravou o campo (idade desconhecida,
   * nunca tratada como "acabou de reivindicar"). */
  claimedAt: string | null;
  /** #7263 — repasse de `session.stale` (`SOFT_STALE_MS`, 90min). Permite ao
   * consumidor (`attachClaims`, `scripts/studio-ui/studio-issues.ts`)
   * distinguir "em andamento" (sessão fresca) de "reivindicada por sessão
   * provavelmente ociosa" (stale, mas ainda dentro da janela de retenção de
   * 24h — `claimed_issues_effective` não teria esvaziado). `false` quando a
   * sessão de origem não carrega o campo `stale` (fixture antiga). */
  stale: boolean;
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
  /** #7263 — computado por `listActiveSessions` (`SOFT_STALE_MS`, 90min).
   * Opcional só para não quebrar fixture antiga que não passa por
   * `listActiveSessions`; ausência é tratada como `false` (nunca-stale). */
  stale?: boolean;
  /** #6623: quando presente, é a fonte preferida — já resolve staleness.
   * **Semântica atualizada pelo #7227 (#7297 corrige esta docstring, que
   * ainda descrevia o comportamento pré-#7227):** vazio quando
   * `ageMs > claimReleaseMsForKind(kind)` (24h pros 3 kinds coordenadores),
   * NÃO mais quando a sessão fica `stale` (90min, `SOFT_STALE_MS`) — as duas
   * janelas coincidiam antes do #7227, mas não coincidem mais (ver a
   * docstring de `CLAIM_RELEASE_MS`/`isIssueClaimedByOther` em
   * `scripts/lib/session-registry.ts`). Ausente (fixture antiga, ou
   * chamador que não passou por `listActiveSessions`) cai no fallback
   * `claimed_issues` bruto, comportamento anterior preservado. */
  claimed_issues_effective?: number[];
  /** #10618 (fatia 3) — claims de OUTRO repo (`owner/repo#N`), lidas só por
   * `flattenAllClaims`. */
  claimed_foreign_issues?: string[];
  claimed_foreign_issues_at?: Record<string, string>;
  claimed_foreign_issues_effective?: string[];
}

/** Pure: achata as claims EFETIVAS de cada sessão numa lista de `ClaimEntry`.
 *
 * #6623: lê `claimed_issues_effective` quando presente (já resolve
 * staleness — ver a ressalva do #7227/#7297 na docstring do campo acima:
 * "resolve staleness" hoje significa a janela de 24h de retenção de claim,
 * não mais os 90min de `stale`) em vez de `claimed_issues` bruto. Antes
 * deste fix (#6623), uma sessão `continuo` que nunca fica `stale`
 * (heartbeat perpétuo, ver docstring do módulo) continuava correta — mas
 * qualquer OUTRA sessão cujo claim já não valia mais (`is-claimed` já o
 * tratava como livre) ainda entrava na lista de "claims envelhecidas" deste
 * módulo, reportando staleness sobre uma reivindicação que já não existia
 * de fato. Fallback pra `claimed_issues` bruto quando
 * `claimed_issues_effective` não foi passado (fixtures antigas / chamador
 * fora de `listActiveSessions`) — nunca uma mudança de comportamento pra
 * quem já não tinha o campo. */
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
        stale: session.stale ?? false,
      });
    }
  }
  return out;
}

/**
 * #10618 (fatia 3): como `flattenClaims`, mas inclui as claims de OUTRO repo
 * (`claimed_foreign_issues[_effective]`, `owner/repo#N`), cada uma com
 * `issueKey` e o número no repo dela. Fica separado de `flattenClaims` de
 * propósito: o painel `/triagem` (`attachClaims`, `studio-issues.ts`) indexa
 * as claims por número do diaria-studio e ainda não sabe de outro repo — se
 * `flattenClaims` passasse a devolver a design#21, o painel a mostraria na
 * studio#21. Mesmo critério de janela dos dois lados (`*_effective` quando
 * presente).
 */
export function flattenAllClaims(sessions: readonly ClaimBearingSession[]): ClaimEntry[] {
  const out = flattenClaims(sessions);
  for (const session of sessions) {
    // `claimKeysOf` é a fonte única de "claims de uma sessão como IssueKey"
    // (mesmo critério `*_effective ?? cru`, entrada ilegível descartada). Só
    // o lado estrangeiro é passado: o studio já veio de `flattenClaims`.
    const foreignKeys = claimKeysOf({
      claimed_foreign_issues: session.claimed_foreign_issues,
      claimed_foreign_issues_effective: session.claimed_foreign_issues_effective,
    });
    // `claimed_foreign_issues_at` é chaveado pela string gravada — canoniza
    // as chaves pra achar o timestamp de `Vjpixel/Diaria-Design#21` também.
    const atByKey = new Map<IssueKey, string>();
    for (const [raw, at] of Object.entries(session.claimed_foreign_issues_at ?? {})) {
      const k = toIssueKey(raw);
      if (k && typeof at === "string" && !atByKey.has(k)) atByKey.set(k, at);
    }
    for (const issueKey of foreignKeys) {
      if (isStudioIssueKey(issueKey)) continue; // studio já coberto acima
      out.push({
        issueNumber: issueNumberInRepo(issueKey),
        issueKey,
        kind: session.kind,
        machineTag: session.machineTag,
        sessionId: session.sessionId,
        claimedAt: atByKey.get(issueKey) ?? null,
        stale: session.stale ?? false,
      });
    }
  }
  return out;
}

export interface AgedClaimFinding {
  /** Número no repo da issue (`issueKey`). */
  issueNumber: number;
  /** #10618 (fatia 3): identidade `owner/repo#N`. */
  issueKey: IssueKey;
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
  hasOpenPr: (issueNumber: number, repo?: string) => boolean | null,
  isIssueClosed?: (issueNumber: number, repo?: string) => boolean | null,
  /** #10618 (fatia 3): chamado pra cada claim que NÃO pôde ser avaliada —
   * `sem-timestamp` (sem `claimedAt` legível: idade desconhecida) ou
   * `nao-verificavel` (passou do teto mas `hasOpenPr` devolveu `null`). O
   * veredito não muda (fail-soft de sempre); o CLI usa pra pôr a ressalva na
   * linha de ok em vez de deixar a claim sumir em silêncio. */
  onUnevaluated?: (issueKey: IssueKey, reason: "sem-timestamp" | "nao-verificavel") => void,
): AgedClaimFinding[] {
  const out: AgedClaimFinding[] = [];
  for (const entry of entries) {
    // #10618 (fatia 3): claim de outro repo chega com `issueKey`; os
    // consultores recebem o `repo` (só nesse caso — claim do studio segue
    // chamando com o número sozinho, como sempre). O número sai da chave
    // quando ela existe — `issueNumber` é só o fallback legado.
    const issueKey = entry.issueKey ?? toIssueKey(entry.issueNumber);
    if (!issueKey) continue;
    const issueNumber = issueNumberInRepo(issueKey);
    const repo = isStudioIssueKey(issueKey) ? undefined : repoOfIssueKey(issueKey);
    const claimedAtMs = entry.claimedAt ? Date.parse(entry.claimedAt) : Number.NaN;
    if (!entry.claimedAt || !Number.isFinite(claimedAtMs)) {
      onUnevaluated?.(issueKey, "sem-timestamp");
      continue;
    }
    const ageMs = now - claimedAtMs;
    if (ageMs < maxAgeMs) continue;
    if ((repo ? isIssueClosed?.(issueNumber, repo) : isIssueClosed?.(issueNumber)) === true) {
      continue; // issue fechada — nunca precisa de re-triagem
    }
    const openPr = repo ? hasOpenPr(issueNumber, repo) : hasOpenPr(issueNumber);
    if (openPr === null) onUnevaluated?.(issueKey, "nao-verificavel");
    if (openPr !== false) continue; // true ou null (não verificável) → nunca reporta
    out.push({
      issueNumber,
      issueKey,
      kind: entry.kind,
      machineTag: entry.machineTag,
      sessionId: entry.sessionId,
      claimedAt: entry.claimedAt,
      ageMs,
    });
  }
  return out.sort((a, b) => compareIssueKeys(a.issueKey, b.issueKey));
}
