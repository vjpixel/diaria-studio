/**
 * scripts/lib/github-claim-marker.ts (#13154)
 *
 * Sinal de claim de issue que ATRAVESSA máquina, gravado como comentário na
 * própria issue do GitHub. Complementa o `session-registry` (`claim-issue`/
 * `is-claimed`), que vive em `data/sessions/` e só chega às outras máquinas
 * quando o sync do Drive/OneDrive replica: o lock é advisory entre máquinas
 * (#6182).
 *
 * Incidente que motivou (rodada overnight 261115c): a sessão `/diaria-develop`
 * do Neo reivindicou #13120 e #13128-#13132 às 18:30Z; às 18:47Z o overnight
 * do 300 rodou `is-claimed` (`claimed: false`) e `claim-issue` (`ok`) sem ver
 * a claim do Neo, porque o registro ainda não tinha replicado, e despachou um
 * lote inteiro (PR #13139) que duplicava a PR #13141. A colisão só apareceu
 * no merge. O comentário no GitHub é visível na hora em qualquer máquina.
 *
 * Este módulo é PURO: formata e lê os marcadores e decide, dada a lista de
 * comentários já buscada, se OUTRA sessão segura a issue. O fetch e a escrita
 * moram em `scripts/check-pre-dispatch-claim.ts`.
 *
 * ## Formato
 *
 * Claim:   `<!-- diaria-claim: v=1 kind=develop session=ID host=neo at=ISO -->`
 * Release: `<!-- diaria-claim-release: v=1 session=ID at=ISO -->`
 *
 * ## Regras de leitura
 *
 * - Só comentário de autor confiável (`OWNER`/`MEMBER`/`COLLABORATOR`, item 30
 *   de `context/overnight-dispatch-rules.md`): o repo é público, e um
 *   marcador colado por conta externa não pode travar nem liberar issue.
 * - A claim vale pela mesma janela de retenção do registro
 *   (`claimReleaseMsForKind`: 24h para os kinds coordenadores), contada do
 *   `at` do marcador. Sessão que caiu sem soltar segura a issue até lá, igual
 *   ao registro.
 * - Um release da MESMA sessão com `at` igual ou posterior ao da claim a
 *   cancela.
 * - Desempate entre duas sessões com claim ativa: vence a de `at` mais antigo
 *   (a outra cede). Assim, duas rodadas que anunciam quase ao mesmo tempo
 *   chegam à mesma resposta lendo o mesmo par de comentários.
 * - Claim de sessão que o log de lifecycle do registro
 *   (`data/session-lifecycle.jsonl`) mostra como encerrada DEPOIS do `at` da
 *   claim não conta (#13172): a sessão dona acabou sem soltar (pulada, falha
 *   do implementador, encerramento sem `--release`) e a issue não pode ficar
 *   presa pelo resto das 24h. O log só chega à outra máquina quando o sync
 *   replica; até lá a claim segue valendo (erra para o lado de segurar).
 */

import { isTrustedCommentAuthor } from "./trusted-comment-author.ts";
import { claimReleaseMsForKind, type SessionLifecycleEvent } from "./session-registry.ts";

export interface GithubClaimMarker {
  kind: string;
  sessionId: string;
  host: string;
  /** ISO 8601. */
  at: string;
}

export interface GithubReleaseMarker {
  sessionId: string;
  /** ISO 8601. */
  at: string;
}

/** Comentário de issue no shape de `gh issue view N --json comments`. */
export interface IssueCommentLike {
  body?: unknown;
  authorAssociation?: unknown;
  author_association?: unknown;
}

const TOKEN_RE = /^[A-Za-z0-9._:-]+$/;

function sanitizeToken(value: string, field: string): string {
  const v = value.trim();
  if (!v || !TOKEN_RE.test(v)) {
    throw new Error(`github-claim-marker: ${field} inválido para o marcador: ${JSON.stringify(value)}`);
  }
  return v;
}

/** Corpo completo do comentário de claim (marcador + uma linha legível). */
export function formatClaimComment(marker: GithubClaimMarker): string {
  const kind = sanitizeToken(marker.kind, "kind");
  const session = sanitizeToken(marker.sessionId, "sessionId");
  const host = sanitizeToken(marker.host, "host");
  const at = sanitizeToken(marker.at, "at");
  return (
    `<!-- diaria-claim: v=1 kind=${kind} session=${session} host=${host} at=${at} -->\n` +
    `Issue reivindicada pela sessão \`${kind}\` na máquina \`${host}\` (${at}). ` +
    // Sem `#N` no texto: citar uma issue aqui criaria um backlink na timeline
    // dela a cada claim gravada em qualquer outra issue.
    `Sinal de claim entre máquinas: outra rodada não despacha esta issue enquanto a claim valer ` +
    `(até ser solta ou por ${Math.round(claimReleaseMsForKind(kind) / 3_600_000)}h).`
  );
}

/** Corpo completo do comentário de release. */
export function formatReleaseComment(marker: GithubReleaseMarker): string {
  const session = sanitizeToken(marker.sessionId, "sessionId");
  const at = sanitizeToken(marker.at, "at");
  return (
    `<!-- diaria-claim-release: v=1 session=${session} at=${at} -->\n` +
    `Claim da sessão solta (${at}).`
  );
}

function parseFields(inner: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of inner.trim().split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/** Marcadores de claim num texto. Marcador malformado (campo ausente, `at`
 * ilegível) é ignorado. */
export function parseClaimMarkers(text: string): GithubClaimMarker[] {
  const out: GithubClaimMarker[] = [];
  const re = /<!--\s*diaria-claim:([^>]*?)-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const f = parseFields(m[1]);
    if (!f.kind || !f.session || !f.at || Number.isNaN(Date.parse(f.at))) continue;
    out.push({ kind: f.kind, sessionId: f.session, host: f.host ?? "", at: f.at });
  }
  return out;
}

export function parseReleaseMarkers(text: string): GithubReleaseMarker[] {
  const out: GithubReleaseMarker[] = [];
  const re = /<!--\s*diaria-claim-release:([^>]*?)-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const f = parseFields(m[1]);
    if (!f.session || !f.at || Number.isNaN(Date.parse(f.at))) continue;
    out.push({ sessionId: f.session, at: f.at });
  }
  return out;
}

/** Ordem de precedência: `at` mais antigo primeiro; empate exato decidido pelo
 * `sessionId` (ordem lexicográfica), para as duas sessões chegarem à mesma
 * resposta. */
export function compareClaims(a: GithubClaimMarker, b: GithubClaimMarker): number {
  const d = Date.parse(a.at) - Date.parse(b.at);
  if (d !== 0) return d;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

export interface GithubClaimAssessment {
  /** Claim ativa mais antiga de OUTRA sessão que vence a desta, ou `null`. */
  claimedByOther: GithubClaimMarker | null;
  /** Claim ativa desta sessão (`excludeSessionId`), ou `null`. */
  ownClaim: GithubClaimMarker | null;
  /** Todas as claims ativas, mais antiga primeiro. */
  activeClaims: GithubClaimMarker[];
}

/**
 * Lê os comentários da issue e decide se OUTRA sessão segura a claim. Nunca
 * lança. `comments` que não é array devolve `null` (payload desconhecido: o
 * chamador trata como não verificável, nunca como livre).
 */
export function assessGithubClaims(
  comments: unknown,
  opts: {
    excludeSessionId: string;
    now?: number;
    /** `sessionId` → `ts` ISO do fim mais recente da sessão no log de
     * lifecycle (`endedSessionsFromLifecycle`). Claim com `at` até esse
     * instante é ignorada (#13172). */
    endedSessions?: ReadonlyMap<string, string>;
  },
): GithubClaimAssessment | null {
  if (!Array.isArray(comments)) return null;
  const now = opts.now ?? Date.now();
  const claims: GithubClaimMarker[] = [];
  const releases: GithubReleaseMarker[] = [];
  for (const c of comments as IssueCommentLike[]) {
    if (!isTrustedCommentAuthor(c)) continue;
    const body = typeof c?.body === "string" ? c.body : "";
    if (!body.includes("diaria-claim")) continue;
    claims.push(...parseClaimMarkers(body));
    releases.push(...parseReleaseMarkers(body));
  }

  // Por sessão, só a claim mais recente conta (re-anúncio não estende a de antes
  // nem cria duplicata).
  const latestBySession = new Map<string, GithubClaimMarker>();
  for (const c of claims) {
    const prev = latestBySession.get(c.sessionId);
    if (!prev || Date.parse(c.at) > Date.parse(prev.at)) latestBySession.set(c.sessionId, c);
  }

  const active: GithubClaimMarker[] = [];
  for (const c of latestBySession.values()) {
    const atMs = Date.parse(c.at);
    if (now - atMs > claimReleaseMsForKind(c.kind)) continue;
    const released = releases.some((r) => r.sessionId === c.sessionId && Date.parse(r.at) >= atMs);
    if (released) continue;
    const endedAt = opts.endedSessions?.get(c.sessionId);
    if (endedAt !== undefined && Date.parse(endedAt) >= atMs) continue;
    active.push(c);
  }
  active.sort(compareClaims);

  const ownClaim = active.find((c) => c.sessionId === opts.excludeSessionId) ?? null;
  const claimedByOther =
    active.find(
      (c) => c.sessionId !== opts.excludeSessionId && (ownClaim === null || compareClaims(c, ownClaim) < 0),
    ) ?? null;

  return { claimedByOther, ownClaim, activeClaims: active };
}

/**
 * Mapa `sessionId` → `ts` do fim mais recente, a partir dos eventos de
 * `data/session-lifecycle.jsonl` (`readSessionLifecycleEvents`). Os três
 * eventos contam como fim: `ended` (fim limpo), `gc-removed-without-end` e
 * `swept-without-end` (sessão morta recolhida). Pura; evento com `ts`
 * ilegível é ignorado (#13172).
 */
export function endedSessionsFromLifecycle(events: readonly SessionLifecycleEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const ev of events) {
    if (!ev || typeof ev.sessionId !== "string" || typeof ev.ts !== "string") continue;
    const ms = Date.parse(ev.ts);
    if (Number.isNaN(ms)) continue;
    const prev = out.get(ev.sessionId);
    if (prev === undefined || ms > Date.parse(prev)) out.set(ev.sessionId, ev.ts);
  }
  return out;
}
