/**
 * scripts/lib/route-claim-release.ts (#13605)
 *
 * Quando `route-issue.ts` tira uma issue do track da sessão que a reivindicou
 * (overnight → develop, bloqueada, agendada, fora-de-rodada, épica), a claim
 * dessa sessão deixa de proteger trabalho em curso e passa a travar quem vai
 * fazer o resto. Caso de origem (develop 261118b): a rodada overnight
 * `e333a546` roteou #13563, #13571 e #13508 para develop e manteve a claim no
 * GitHub (`diaria-claim`, 24h); o `check-pre-dispatch-claim.ts --announce` da
 * sessão develop deu `ocupada` (`github-claim`) nas três.
 *
 * Regra: depois de um roteamento validado, solta (no GitHub e no registro
 * local) toda claim ativa cujo `kind` não pertence ao track de destino:
 *
 * - `overnight` mantém `overnight` e `continuo` (as duas drenam a mesma fila
 *   desbloqueada; o continuo usa o mesmo track).
 * - `develop` mantém `develop` e `interactive` (sessão com o editor presente).
 * - qualquer outro track (`bloqueada`, `agendada`, `fora-de-rodada`, `epica`)
 *   não é trabalhado por sessão nenhuma enquanto durar: solta todas.
 *
 * O módulo é puro (decide QUAIS claims soltar); a escrita mora em
 * `scripts/route-issue.ts`.
 */

import type { GithubClaimMarker } from "./github-claim-marker.ts";
import type { RouteTrack } from "./issue-route.ts";

/** Kinds de sessão cuja claim segue válida depois de rotear para o track. */
export const CLAIM_KINDS_KEPT_BY_TRACK: Readonly<Record<string, readonly string[]>> = {
  overnight: ["overnight", "continuo"],
  develop: ["develop", "interactive"],
};

/** `true` quando uma claim de sessão `kind` continua coerente com o track. */
export function claimKindStaysOnTrack(kind: string, track: RouteTrack | string): boolean {
  return (CLAIM_KINDS_KEPT_BY_TRACK[track] ?? []).includes(kind);
}

/** Claims ativas (de `assessGithubClaims`) que o roteamento para `track` solta. */
export function claimsToReleaseOnRoute(
  activeClaims: readonly GithubClaimMarker[],
  track: RouteTrack | string,
): GithubClaimMarker[] {
  return activeClaims.filter((c) => !claimKindStaysOnTrack(c.kind, track));
}

/** Desfecho por sessão, gravado no resultado de `routeIssue`. */
export interface RouteClaimReleaseEntry {
  sessionId: string;
  kind: string;
  /** `github` = marcador de release postado; `registry` = `unclaim` local. */
  where: "github" | "registry";
  ok: boolean;
  /** Motivo do não-ok, ou do pulo (`registro de outra máquina`). */
  detail?: string;
}
