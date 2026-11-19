/**
 * test/route-issue-solta-claim-13605.test.ts (#13605)
 *
 * O overnight roteava issues para develop e a claim dele no GitHub
 * (`diaria-claim`, 24h) continuava ativa: o `check-pre-dispatch-claim.ts
 * --announce` da sessão develop dava `ocupada` (`github-claim`) e a sessão
 * escolhia entre esperar sem motivo e ignorar a claim (develop 261118b,
 * #13563/#13571/#13508). Agora `routeIssue` solta, no GitHub e no registro
 * local, a claim de sessão cujo kind não pertence ao track de destino.
 *
 * Sempre com `GhRunFn` e registro em memória: nunca `gh` real, nunca issue
 * real, nunca `data/sessions/` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeIssue, type ClaimRegistryPort, type GhRunFn } from "../scripts/route-issue.ts";
import { assessGithubClaims, formatClaimComment } from "../scripts/lib/github-claim-marker.ts";
import { claimKindStaysOnTrack, claimsToReleaseOnRoute } from "../scripts/lib/route-claim-release.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

interface Comment {
  body: string;
  authorAssociation: string;
  createdAt: string;
}

const NOW = new Date("2026-11-18T17:45:00Z");
const OVERNIGHT = "e333a546-0000-0000-0000-000000000000";
const DEVELOP = "dddddddd-0000-0000-0000-000000000000";

function claim(kind: string, sessionId: string, at: string): Comment {
  return {
    body: formatClaimComment({ kind, sessionId, host: "300", at }),
    authorAssociation: "OWNER",
    createdAt: at,
  };
}

function fakeGh(comments: Comment[], labels: string[] = []): { run: GhRunFn; comments: Comment[]; failComment?: boolean } {
  const state = { labels: [...labels], body: "corpo", comments: [...comments] };
  const holder: { run: GhRunFn; comments: Comment[]; failComment?: boolean } = { run: null as unknown as GhRunFn, comments: state.comments };
  holder.run = (args): GhSpawnResult => {
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("-q") && args.includes(".body")) return { status: 0, stdout: `${state.body}\n`, stderr: "" };
      return {
        status: 0,
        stdout: JSON.stringify({ labels: state.labels.map((name) => ({ name })), body: state.body, state: "OPEN", comments: state.comments }),
        stderr: "",
      };
    }
    if (args[0] === "issue" && args[1] === "edit") {
      const addIdx = args.indexOf("--add-label");
      if (addIdx !== -1) for (const l of args[addIdx + 1].split(",")) if (!state.labels.includes(l)) state.labels.push(l);
      const removeIdx = args.indexOf("--remove-label");
      if (removeIdx !== -1) {
        const rm = new Set(args[removeIdx + 1].split(","));
        state.labels = state.labels.filter((l) => !rm.has(l));
      }
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx !== -1) state.body = args[bodyIdx + 1];
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "comment") {
      const body = args[args.indexOf("--body") + 1];
      if (holder.failComment && body.includes("diaria-claim-release")) return { status: 1, stdout: "", stderr: "HTTP 502" };
      state.comments.push({ body, authorAssociation: "OWNER", createdAt: NOW.toISOString() });
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  return holder;
}

function fakeRegistry(holders: Array<{ kind: string; sessionId: string; machineTag: string }>, localTag = "300") {
  const unclaimed: Array<{ kind: string; sessionId: string; target: unknown; tag: string }> = [];
  const live = [...holders];
  const port: ClaimRegistryPort = {
    localTag,
    holders: () => [...live],
    unclaim: (kind, sessionId, target, tag) => {
      unclaimed.push({ kind, sessionId, target, tag });
      const i = live.findIndex((h) => h.sessionId === sessionId);
      if (i !== -1) live.splice(i, 1);
      return { ok: true, reason: "unclaimed" };
    },
  };
  return { port, unclaimed, live };
}

function activeAfter(comments: Comment[]) {
  return assessGithubClaims(comments, { excludeSessionId: "", now: NOW.getTime() })!.activeClaims;
}

describe("#13605 — claimKindStaysOnTrack / claimsToReleaseOnRoute", () => {
  it("overnight mantém overnight e continuo; develop mantém develop e interactive", () => {
    assert.equal(claimKindStaysOnTrack("overnight", "overnight"), true);
    assert.equal(claimKindStaysOnTrack("continuo", "overnight"), true);
    assert.equal(claimKindStaysOnTrack("develop", "overnight"), false);
    assert.equal(claimKindStaysOnTrack("develop", "develop"), true);
    assert.equal(claimKindStaysOnTrack("interactive", "develop"), true);
    assert.equal(claimKindStaysOnTrack("overnight", "develop"), false);
  });

  it("bloqueada, agendada, fora-de-rodada e epica soltam todos os kinds", () => {
    for (const track of ["bloqueada", "agendada", "fora-de-rodada", "epica"]) {
      for (const kind of ["overnight", "continuo", "develop", "interactive"]) {
        assert.equal(claimKindStaysOnTrack(kind, track), false, `${kind} em ${track}`);
      }
    }
  });

  it("filtra só as claims de outro track", () => {
    const claims = [
      { kind: "overnight", sessionId: "a", host: "300", at: NOW.toISOString() },
      { kind: "develop", sessionId: "b", host: "neo", at: NOW.toISOString() },
    ];
    assert.deepEqual(claimsToReleaseOnRoute(claims, "develop").map((c) => c.sessionId), ["a"]);
    assert.deepEqual(claimsToReleaseOnRoute(claims, "overnight").map((c) => c.sessionId), ["b"]);
  });
});

describe("#13605 — routeIssue solta a claim de sessão de outro track", () => {
  it("cenário da issue: rotear para develop com claim overnight ativa solta a claim no GitHub e no registro", () => {
    const gh = fakeGh([claim("overnight", OVERNIGHT, "2026-11-18T17:10:40Z")]);
    const reg = fakeRegistry([{ kind: "overnight", sessionId: OVERNIGHT, machineTag: "300" }]);
    assert.equal(activeAfter(gh.comments).length, 1, "pré-condição: claim ativa");

    const r = routeIssue({
      issue: 13563, track: "develop", reason: "o editor confirma antes",
      cwd: "/tmp", ghRun: gh.run, now: NOW, claimRegistry: reg.port, endedSessions: () => new Map(),
    });

    assert.equal(r.ok, true, r.error);
    assert.equal(activeAfter(gh.comments).length, 0, "claim do GitHub solta");
    assert.deepEqual(reg.unclaimed, [{ kind: "overnight", sessionId: OVERNIGHT, target: 13563, tag: "300" }]);
    assert.deepEqual(
      r.claimRelease?.map((e) => [e.where, e.kind, e.ok]),
      [["github", "overnight", true], ["registry", "overnight", true]],
    );
  });

  it("claim develop sobrevive ao roteamento para develop", () => {
    const gh = fakeGh([claim("develop", DEVELOP, "2026-11-18T17:20:00Z")]);
    const reg = fakeRegistry([{ kind: "develop", sessionId: DEVELOP, machineTag: "neo" }]);
    const r = routeIssue({
      issue: 1, track: "develop", reason: "x", cwd: "/tmp", ghRun: gh.run, now: NOW,
      claimRegistry: reg.port, endedSessions: () => new Map(),
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(activeAfter(gh.comments).length, 1);
    assert.equal(reg.unclaimed.length, 0);
    assert.equal(r.claimRelease, undefined);
  });

  it("agendada solta até a claim da própria sessão develop", () => {
    const gh = fakeGh([claim("develop", DEVELOP, "2026-11-18T17:20:00Z")]);
    const reg = fakeRegistry([]);
    const r = routeIssue({
      issue: 2, track: "agendada", until: "2026-11-25", reason: "aguardando resposta da Beehiiv",
      cwd: "/tmp", ghRun: gh.run, now: NOW, claimRegistry: reg.port, endedSessions: () => new Map(),
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(activeAfter(gh.comments).length, 0);
  });

  it("registro de outra máquina não é reescrito daqui; sai como aviso", () => {
    const gh = fakeGh([]);
    const reg = fakeRegistry([{ kind: "overnight", sessionId: OVERNIGHT, machineTag: "300" }], "neo");
    const r = routeIssue({
      issue: 3, track: "develop", reason: "x", cwd: "/tmp", ghRun: gh.run, now: NOW,
      claimRegistry: reg.port, endedSessions: () => new Map(),
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(reg.unclaimed.length, 0);
    assert.equal(r.claimRelease?.[0].ok, false);
    assert.match(r.claimRelease?.[0].detail ?? "", /outra máquina/);
  });

  it("--keep-claim desliga o passo", () => {
    const gh = fakeGh([claim("overnight", OVERNIGHT, "2026-11-18T17:10:40Z")]);
    const reg = fakeRegistry([{ kind: "overnight", sessionId: OVERNIGHT, machineTag: "300" }]);
    const r = routeIssue({
      issue: 4, track: "develop", reason: "x", cwd: "/tmp", ghRun: gh.run, now: NOW,
      claimRegistry: reg.port, endedSessions: () => new Map(), keepClaim: true,
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(activeAfter(gh.comments).length, 1);
    assert.equal(reg.unclaimed.length, 0);
  });

  it("falha ao postar o release não derruba o roteamento, mas sai em claimRelease", () => {
    const gh = fakeGh([claim("overnight", OVERNIGHT, "2026-11-18T17:10:40Z")]);
    gh.failComment = true;
    const reg = fakeRegistry([]);
    const r = routeIssue({
      issue: 5, track: "develop", reason: "x", cwd: "/tmp", ghRun: gh.run, now: NOW,
      claimRegistry: reg.port, endedSessions: () => new Map(),
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.claimRelease?.[0].ok, false);
    assert.match(r.claimRelease?.[0].detail ?? "", /502/);
  });

  it("roteamento recusado não mexe em claim nenhuma", () => {
    // `--until` com data já passada: recusado antes de qualquer escrita.
    const gh = fakeGh([claim("overnight", OVERNIGHT, "2026-11-18T17:10:40Z")]);
    const reg = fakeRegistry([{ kind: "overnight", sessionId: OVERNIGHT, machineTag: "300" }]);
    const r = routeIssue({
      issue: 6, track: "agendada", until: "2026-11-01", reason: "data",
      cwd: "/tmp", ghRun: gh.run, now: NOW, claimRegistry: reg.port, endedSessions: () => new Map(),
    });
    assert.equal(r.ok, false);
    assert.equal(activeAfter(gh.comments).length, 1);
    assert.equal(reg.unclaimed.length, 0);
  });

  it("marcador de claim postado por conta externa é ignorado", () => {
    const external = { ...claim("overnight", OVERNIGHT, "2026-11-18T17:10:40Z"), authorAssociation: "NONE" };
    const gh = fakeGh([external]);
    const reg = fakeRegistry([]);
    const r = routeIssue({
      issue: 7, track: "develop", reason: "x", cwd: "/tmp", ghRun: gh.run, now: NOW,
      claimRegistry: reg.port, endedSessions: () => new Map(),
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.claimRelease, undefined);
  });
});
