/**
 * test/pre-dispatch-claim-release-13172.test.ts (#13172)
 *
 * Duas falhas do sinal de claim no GitHub (#13154):
 *
 * 1. `--announce` conferia e postava sem reler: duas sessões que conferem com
 *    1-2 s de diferença recebiam `livre`, postavam e despachavam as duas.
 * 2. Claim de sessão já encerrada (pulada, falha do implementador, fim de
 *    rodada sem `--release`) segurava a issue por 24h. Cenário da issue: o
 *    overnight reivindica às 02:00, a implementação falha, a rodada encerra; às
 *    10:00 o `/diaria-develop --issues N` recebia `github-claim`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessGithubClaims,
  endedSessionsFromLifecycle,
  formatClaimComment,
  parseReleaseMarkers,
} from "../scripts/lib/github-claim-marker.ts";
import { main, type Runner, type RunnerResult } from "../scripts/check-pre-dispatch-claim.ts";
import type { SessionLifecycleEvent } from "../scripts/lib/session-registry.ts";

const OVERNIGHT_AT = "2026-11-15T02:00:00.000Z";
const DEVELOP_NOW = Date.parse("2026-11-15T10:00:00Z");

function trusted(body: string) {
  return { body, authorAssociation: "OWNER" };
}

function claim(sessionId: string, at: string, kind = "overnight") {
  return trusted(formatClaimComment({ kind, sessionId, host: "300", at }));
}

function ev(sessionId: string, ts: string, event: SessionLifecycleEvent["event"] = "ended"): SessionLifecycleEvent {
  return { event, kind: "overnight", machineTag: "300", sessionId, ts };
}

function capture<T>(fn: () => T): { result: T; out: string; err: string } {
  const logs: string[] = [];
  const errs: string[] = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (m: string) => logs.push(m);
  console.error = (m: string) => errs.push(m);
  try {
    return { result: fn(), out: logs.join("\n"), err: errs.join("\n") };
  } finally {
    console.log = ol;
    console.error = oe;
  }
}

/** Runner cujos comentários mudam entre a 1ª e a 2ª leitura da issue: simula
 * a outra sessão postando entre a conferência e o post desta. */
function racingRunner(
  reads: unknown[][],
  posted: { args: string[]; input?: string }[],
  opts: { failSecondRead?: boolean } = {},
): Runner {
  let n = 0;
  return (_cmd, args, o): RunnerResult => {
    if (args[0] === "pr" && args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
    if (args[0] === "issue" && args[1] === "view") {
      const i = n++;
      if (i >= 1 && opts.failSecondRead) return { status: 1, stdout: "", stderr: "HTTP 502" };
      return { status: 0, stdout: JSON.stringify({ comments: reads[Math.min(i, reads.length - 1)] }), stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "comment") {
      posted.push({ args, input: o.input });
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`comando inesperado: ${args.join(" ")}`);
  };
}

const freeRegistry = () => null;
const noEnded = () => new Map<string, string>();

describe("--announce relê depois de postar (#13172 finding 4)", () => {
  const T0 = Date.parse("2026-11-15T18:47:01Z");

  it("outra sessão postou 1 s antes: esta cede, grava release, exit 1", () => {
    const posted: { args: string[]; input?: string }[] = [];
    const other = claim("neo-dev", "2026-11-15T18:47:00.000Z", "develop");
    const runner = racingRunner([[], [other]], posted);
    const { result, out } = capture(() =>
      main(["--issues", "13172", "--session-id", "o300", "--kind", "overnight", "--announce"], "/tmp", {
        runner,
        registryLookup: freeRegistry,
        endedSessions: noEnded,
        now: () => T0,
      }),
    );
    assert.equal(result, 1);
    const r = JSON.parse(out).issues[0];
    assert.equal(r.verdict, "ocupada");
    assert.deepEqual(r.reasons, ["github-claim-race"]);
    assert.equal(r.githubClaim.sessionId, "neo-dev");
    assert.equal(posted.length, 2, "claim + release");
    assert.equal(parseReleaseMarkers(posted[1].input ?? "")[0].sessionId, "o300");
  });

  it("a sessão de claim mais antiga segue livre na releitura (exit 0, sem release)", () => {
    const posted: { args: string[]; input?: string }[] = [];
    const newer = claim("neo-dev", "2026-11-15T18:47:05.000Z", "develop");
    const runner = racingRunner([[], [newer]], posted);
    const { result } = capture(() =>
      main(["--issues", "13172", "--session-id", "o300", "--kind", "overnight", "--announce"], "/tmp", {
        runner,
        registryLookup: freeRegistry,
        endedSessions: noEnded,
        now: () => T0,
      }),
    );
    assert.equal(result, 0);
    assert.equal(posted.length, 1);
  });

  it("releitura que falha: cannot-verify (exit 2) e release da claim recém-postada", () => {
    const posted: { args: string[]; input?: string }[] = [];
    const runner = racingRunner([[]], posted, { failSecondRead: true });
    const { result, out } = capture(() =>
      main(["--issues", "13172", "--session-id", "o300", "--kind", "overnight", "--announce"], "/tmp", {
        runner,
        registryLookup: freeRegistry,
        endedSessions: noEnded,
        now: () => T0,
      }),
    );
    assert.equal(result, 2);
    assert.equal(JSON.parse(out).issues[0].verdict, "cannot-verify");
    assert.equal(posted.length, 2);
    assert.match(posted[1].input ?? "", /diaria-claim-release/);
  });
});

describe("claim de sessão encerrada não segura a issue (#13172)", () => {
  it("cenário da issue: overnight encerrou às 03:00 sem release, develop às 10:00 vê livre", () => {
    const runner = racingRunner([[claim("ovn", OVERNIGHT_AT)]], []);
    const { result, out } = capture(() =>
      main(["--issues", "13172", "--session-id", "dev"], "/tmp", {
        runner,
        registryLookup: freeRegistry,
        endedSessions: () => endedSessionsFromLifecycle([ev("ovn", "2026-11-15T03:00:00.000Z")]),
        now: () => DEVELOP_NOW,
      }),
    );
    assert.equal(result, 0);
    assert.equal(JSON.parse(out).issues[0].verdict, "livre");
  });

  it("sem o fim no log (ainda não replicou) a claim segue valendo", () => {
    const runner = racingRunner([[claim("ovn", OVERNIGHT_AT)]], []);
    const { result } = capture(() =>
      main(["--issues", "13172", "--session-id", "dev"], "/tmp", {
        runner,
        registryLookup: freeRegistry,
        endedSessions: noEnded,
        now: () => DEVELOP_NOW,
      }),
    );
    assert.equal(result, 1);
  });

  it("fim ANTERIOR ao `at` da claim não a solta (sessão re-anunciou depois)", () => {
    const ended = endedSessionsFromLifecycle([ev("ovn", "2026-11-15T01:00:00.000Z")]);
    const a = assessGithubClaims([claim("ovn", OVERNIGHT_AT)], {
      excludeSessionId: "dev",
      now: DEVELOP_NOW,
      endedSessions: ended,
    });
    assert.equal(a?.claimedByOther?.sessionId, "ovn");
  });

  it("gc-removed-without-end e swept-without-end também contam como fim", () => {
    for (const kind of ["gc-removed-without-end", "swept-without-end"] as const) {
      const ended = endedSessionsFromLifecycle([ev("ovn", "2026-11-15T05:00:00.000Z", kind)]);
      const a = assessGithubClaims([claim("ovn", OVERNIGHT_AT)], {
        excludeSessionId: "dev",
        now: DEVELOP_NOW,
        endedSessions: ended,
      });
      assert.equal(a?.claimedByOther, null, kind);
    }
  });

  it("endedSessionsFromLifecycle guarda o fim mais recente e ignora ts ilegível", () => {
    const m = endedSessionsFromLifecycle([
      ev("a", "2026-11-15T03:00:00.000Z"),
      ev("a", "2026-11-15T09:00:00.000Z"),
      ev("a", "2026-11-15T04:00:00.000Z"),
      ev("b", "lixo"),
    ]);
    assert.equal(m.get("a"), "2026-11-15T09:00:00.000Z");
    assert.equal(m.has("b"), false);
  });
});
