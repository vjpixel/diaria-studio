/**
 * continuo-claim-leak.ts (#13418)
 *
 * Decide quais claims de um tick do contínuo estão VAZANDO. O alarme 3 do
 * `watch-continuo-health.sh` olhava só "claims + heartbeat parado > 45min" e
 * abria issue mesmo quando as claims eram legítimas (issue com PR aberto —
 * trabalho em curso, SKILL.md "Fim de tick") ou já estavam fechadas/mergeadas
 * (nada a segurar). Só vaza a claim de issue ABERTA sem PR aberto. Lookup
 * indeterminado (`null`) nunca conta como vazamento: na dúvida, não alarma.
 */
export interface ClaimLookup {
  state: "open" | "closed" | null;
  /** PR aberto referenciando a issue? `null` = indeterminado. */
  hasOpenPr: boolean | null;
}

export interface LeakSession {
  sessionId: string;
  claims: string[];
  heartbeatAgeMin: number;
}

export function leakedClaims(
  claims: readonly string[],
  lookup: (claim: string) => ClaimLookup,
): string[] {
  return claims.filter((c) => {
    const l = lookup(c);
    return l.state === "open" && l.hasOpenPr === false;
  });
}

export function planClaimLeaks(
  sessions: readonly LeakSession[],
  lookup: (claim: string) => ClaimLookup,
  maxAgeMin = 45,
): Array<{ sessionId: string; leaked: string[]; heartbeatAgeMin: number }> {
  const out: Array<{ sessionId: string; leaked: string[]; heartbeatAgeMin: number }> = [];
  for (const s of sessions) {
    if (s.heartbeatAgeMin <= maxAgeMin) continue;
    const leaked = leakedClaims(s.claims, lookup);
    if (leaked.length > 0) out.push({ sessionId: s.sessionId, leaked, heartbeatAgeMin: s.heartbeatAgeMin });
  }
  return out;
}
