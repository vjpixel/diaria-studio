#!/usr/bin/env npx tsx
/**
 * check-continuo-claim-leaks.ts (#13418)
 *
 * Lê o JSON de `active-of-kind --kind continuo` (session-registry) no stdin e
 * imprime 1 linha por sessão com claim VAZANDO (issue aberta sem PR aberto,
 * heartbeat parado > 45min) — ver `lib/continuo-claim-leak.ts`. Sem saída = ok;
 * entrada ilegível imprime `__ERR__` (o watch trata como indeterminado).
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isMainModule } from "./lib/cli-args.ts";
import { planClaimLeaks, type ClaimLookup, type LeakSession } from "./lib/continuo-claim-leak.ts";

function gh(args: string[]): string | null {
  const r = spawnSync("gh", args, { encoding: "utf8", timeout: 30_000 });
  return !r.error && r.status === 0 ? r.stdout.trim() : null;
}

function lookupClaim(claim: string): ClaimLookup {
  const m = /^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/.exec(claim);
  if (!m) return { state: null, hasOpenPr: null };
  const repo = m[1] ? ["--repo", m[1]] : [];
  const n = m[2];
  const st = gh(["issue", "view", n, ...repo, "--json", "state", "--jq", ".state"]);
  const state = st === "CLOSED" ? "closed" : st === "OPEN" ? "open" : null;
  const prs = gh(["pr", "list", ...repo, "--state", "open", "--search", `${n} in:body`, "--json", "number", "--jq", "length"]);
  const hasOpenPr = prs === null || prs === "" ? null : Number(prs) > 0;
  return { state, hasOpenPr };
}

export function sessionsFromRegistry(json: string, now = Date.now()): LeakSession[] {
  const d = JSON.parse(json) as { sessions?: Array<Record<string, unknown>> };
  const out: LeakSession[] = [];
  for (const s of d.sessions ?? []) {
    const claims = [
      ...((s.claimed_issues as number[] | undefined) ?? []).map((n) => `#${n}`),
      ...((s.claimed_foreign_issues as string[] | undefined) ?? []),
    ];
    const hb = Date.parse(String(s.lastHeartbeat ?? ""));
    if (claims.length === 0 || !Number.isFinite(hb)) continue;
    out.push({ sessionId: String(s.sessionId), claims, heartbeatAgeMin: (now - hb) / 60_000 });
  }
  return out;
}

if (isMainModule(import.meta.url)) {
  try {
    const sessions = sessionsFromRegistry(readFileSync(0, "utf8"));
    let indeterminate = false;
    const tracked = (c: string): ClaimLookup => {
      const l = lookupClaim(c);
      if (l.state === null || l.hasOpenPr === null) indeterminate = true;
      return l;
    };
    const leaks = planClaimLeaks(sessions, tracked);
    // gh fora do ar não pode virar "ok" em silêncio (review #13421): sem vazamento
    // confirmado e com lookup indeterminado, o watch conta INDETERMINADO.
    if (leaks.length === 0 && indeterminate) {
      console.log("__ERR__");
      process.exit(0);
    }
    for (const l of leaks) {
      console.log(`${l.sessionId}: claims=${JSON.stringify(l.leaked)} heartbeat parado há ${Math.round(l.heartbeatAgeMin)}min`);
    }
  } catch {
    console.log("__ERR__");
  }
}
