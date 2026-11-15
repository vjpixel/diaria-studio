/**
 * test/pre-dispatch-claim-13154.test.ts (#13154)
 *
 * Regressão do incidente da rodada 261115c: o overnight do 300 despachou
 * #13120/#13128-#13132 depois de a sessão develop do Neo reivindicá-las,
 * porque o `session-registry` do Neo ainda não tinha replicado. O registro
 * local volta "livre" (como voltou ao vivo); o marcador de claim no GitHub é
 * o sinal que precisa segurar o dispatch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessGithubClaims,
  formatClaimComment,
  formatReleaseComment,
  parseClaimMarkers,
} from "../scripts/lib/github-claim-marker.ts";
import { main, combineVerdict, type Runner, type RunnerResult } from "../scripts/check-pre-dispatch-claim.ts";

const NOW = Date.parse("2026-11-15T18:47:00Z");
const DEVELOP_AT = "2026-11-15T18:30:13.000Z";

function trusted(body: string) {
  return { body, authorAssociation: "OWNER" };
}

function developClaim(at = DEVELOP_AT) {
  return trusted(formatClaimComment({ kind: "develop", sessionId: "8596e5c0", host: "neo", at }));
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

interface FakeOpts {
  comments?: Record<number, unknown[]>;
  prs?: unknown[];
  failComments?: boolean;
  failPrs?: boolean;
}

function fakeRunner(opts: FakeOpts, posted: { args: string[]; input?: string }[] = []): Runner {
  return (_cmd, args, o): RunnerResult => {
    if (args[0] === "pr" && args[1] === "list") {
      if (opts.failPrs) return { status: 1, stdout: "", stderr: "rate limit" };
      return { status: 0, stdout: JSON.stringify(opts.prs ?? []), stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "view") {
      if (opts.failComments) return { status: 1, stdout: "", stderr: "HTTP 502" };
      const n = Number(args[2]);
      return { status: 0, stdout: JSON.stringify({ comments: opts.comments?.[n] ?? [] }), stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "comment") {
      posted.push({ args, input: o.input });
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`comando inesperado: ${args.join(" ")}`);
  };
}

const freeRegistry = () => null;

describe("github-claim-marker (#13154)", () => {
  it("formata e lê de volta o marcador de claim", () => {
    const body = formatClaimComment({ kind: "develop", sessionId: "s1", host: "neo", at: DEVELOP_AT });
    assert.deepEqual(parseClaimMarkers(body), [{ kind: "develop", sessionId: "s1", host: "neo", at: DEVELOP_AT }]);
  });

  it("comentário não cita nenhuma issue (#N criaria backlink a cada claim)", () => {
    const body = formatClaimComment({ kind: "develop", sessionId: "s1", host: "neo", at: DEVELOP_AT });
    assert.doesNotMatch(body + formatReleaseComment({ sessionId: "s1", at: DEVELOP_AT }), /#\d/);
  });

  it("recusa token com espaço ou `--` (não deixa fechar o comentário HTML)", () => {
    assert.throws(() => formatClaimComment({ kind: "develop", sessionId: "a -->x", host: "neo", at: DEVELOP_AT }));
  });

  it("claim de outra sessão dentro da janela segura a issue", () => {
    const a = assessGithubClaims([developClaim()], { excludeSessionId: "overnight-1", now: NOW });
    assert.equal(a?.claimedByOther?.sessionId, "8596e5c0");
  });

  it("autor sem vínculo com o repo é ignorado (item 30)", () => {
    const body = formatClaimComment({ kind: "develop", sessionId: "x", host: "h", at: DEVELOP_AT });
    const a = assessGithubClaims([{ body, authorAssociation: "NONE" }, { body }], { excludeSessionId: "o", now: NOW });
    assert.equal(a?.claimedByOther, null);
  });

  it("release da mesma sessão solta a claim", () => {
    const rel = trusted(formatReleaseComment({ sessionId: "8596e5c0", at: "2026-11-15T18:40:00.000Z" }));
    const a = assessGithubClaims([developClaim(), rel], { excludeSessionId: "o", now: NOW });
    assert.equal(a?.claimedByOther, null);
  });

  it("release de OUTRA sessão não solta a claim", () => {
    const rel = trusted(formatReleaseComment({ sessionId: "outra", at: "2026-11-15T18:40:00.000Z" }));
    const a = assessGithubClaims([developClaim(), rel], { excludeSessionId: "o", now: NOW });
    assert.equal(a?.claimedByOther?.sessionId, "8596e5c0");
  });

  it("claim expira pela janela do kind (24h para coordenador)", () => {
    const a = assessGithubClaims([developClaim("2026-11-14T18:00:00.000Z")], { excludeSessionId: "o", now: NOW });
    assert.equal(a?.claimedByOther, null);
  });

  it("desempate: a claim mais antiga vence, a mais nova cede", () => {
    const mine = trusted(formatClaimComment({ kind: "overnight", sessionId: "o", host: "300", at: "2026-11-15T18:31:00.000Z" }));
    const older = assessGithubClaims([developClaim(), mine], { excludeSessionId: "o", now: NOW });
    assert.equal(older?.claimedByOther?.sessionId, "8596e5c0");
    const fromDevelop = assessGithubClaims([developClaim(), mine], { excludeSessionId: "8596e5c0", now: NOW });
    assert.equal(fromDevelop?.claimedByOther, null);
  });

  it("empate exato de `at` decide pelo sessionId, as duas sessões concordam", () => {
    const a = trusted(formatClaimComment({ kind: "overnight", sessionId: "aaa", host: "300", at: DEVELOP_AT }));
    const b = trusted(formatClaimComment({ kind: "develop", sessionId: "bbb", host: "neo", at: DEVELOP_AT }));
    assert.equal(assessGithubClaims([a, b], { excludeSessionId: "aaa", now: NOW })?.claimedByOther, null);
    assert.equal(assessGithubClaims([a, b], { excludeSessionId: "bbb", now: NOW })?.claimedByOther?.sessionId, "aaa");
  });

  it("payload sem array devolve null (nunca livre)", () => {
    assert.equal(assessGithubClaims(undefined, { excludeSessionId: "o", now: NOW }), null);
  });
});

describe("combineVerdict (#13154)", () => {
  it("falha de qualquer sinal vira cannot-verify", () => {
    assert.equal(combineVerdict({ registry: undefined, github: null, openPr: { verdict: "no-open-pr", issueNumber: 1, matches: [], recommendation: "" } }).verdict, "cannot-verify");
    assert.equal(combineVerdict({ registry: null, github: undefined, openPr: { verdict: "no-open-pr", issueNumber: 1, matches: [], recommendation: "" } }).verdict, "cannot-verify");
    assert.equal(combineVerdict({ registry: null, github: null, openPr: undefined }).verdict, "cannot-verify");
  });
});

describe("check-pre-dispatch-claim main() (#13154)", () => {
  it("cenário 261115c: registro local livre, claim do Neo no GitHub → ocupada, exit 1", () => {
    const runner = fakeRunner({ comments: { 13120: [developClaim()] } });
    const { result, out } = capture(() =>
      main(["--issues", "13120", "--session-id", "overnight-1"], "/tmp", { runner, registryLookup: freeRegistry, now: () => NOW }),
    );
    assert.equal(result, 1);
    const parsed = JSON.parse(out);
    assert.equal(parsed.issues[0].verdict, "ocupada");
    assert.deepEqual(parsed.issues[0].reasons, ["github-claim"]);
    assert.equal(parsed.issues[0].githubClaim.host, "neo");
  });

  it("--announce não grava claim em issue ocupada", () => {
    const posted: { args: string[]; input?: string }[] = [];
    const runner = fakeRunner({ comments: { 13120: [developClaim()] } }, posted);
    capture(() =>
      main(["--issues", "13120", "--session-id", "o", "--kind", "overnight", "--announce"], "/tmp", {
        runner,
        registryLookup: freeRegistry,
        now: () => NOW,
      }),
    );
    assert.equal(posted.length, 0);
  });

  it("--announce grava o marcador nas livres, pelo stdin", () => {
    const posted: { args: string[]; input?: string }[] = [];
    const runner = fakeRunner({}, posted);
    const { result } = capture(() =>
      main(["--issues", "13128,13129", "--session-id", "o", "--kind", "develop", "--announce"], "/tmp", {
        runner,
        registryLookup: freeRegistry,
        now: () => NOW,
        host: "neo",
      }),
    );
    assert.equal(result, 0);
    assert.equal(posted.length, 2);
    assert.deepEqual(posted[0].args.slice(-2), ["--body-file", "-"]);
    assert.equal(parseClaimMarkers(posted[0].input ?? "")[0].sessionId, "o");
  });

  it("--announce não duplica claim desta sessão já gravada", () => {
    const posted: { args: string[]; input?: string }[] = [];
    const mine = trusted(formatClaimComment({ kind: "develop", sessionId: "o", host: "neo", at: DEVELOP_AT }));
    const runner = fakeRunner({ comments: { 13128: [mine] } }, posted);
    capture(() =>
      main(["--issues", "13128", "--session-id", "o", "--kind", "develop", "--announce"], "/tmp", {
        runner,
        registryLookup: freeRegistry,
        now: () => NOW,
      }),
    );
    assert.equal(posted.length, 0);
  });

  it("claim no registro de outra sessão → ocupada", () => {
    const runner = fakeRunner({});
    const { result, out } = capture(() =>
      main(["--issues", "13120", "--session-id", "o"], "/tmp", {
        runner,
        registryLookup: () => ({ kind: "develop", sessionId: "8596e5c0" }),
        now: () => NOW,
      }),
    );
    assert.equal(result, 1);
    assert.deepEqual(JSON.parse(out).issues[0].reasons, ["registry"]);
  });

  it("PR aberta develop/fix-13120-13132 cobre 13120 → ocupada com pr-aberta", () => {
    const pr = {
      number: 13141,
      title: "feat(video-roteiro)",
      body: "Closes #13128",
      headRefName: "develop/fix-13120-13132",
      author: { login: "vjpixel" },
      updatedAt: "2026-11-15T18:52:37Z",
      statusCheckRollup: [],
    };
    const runner = fakeRunner({ prs: [pr] });
    const { result, out } = capture(() =>
      main(["--issues", "13120,13128", "--session-id", "o"], "/tmp", { runner, registryLookup: freeRegistry, now: () => NOW }),
    );
    assert.equal(result, 1);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.issues.map((i: { reasons: string[] }) => i.reasons), [["pr-aberta"], ["pr-aberta"]]);
    assert.equal(parsed.issues[0].openPr.number, 13141);
  });

  it("falha ao ler comentários → cannot-verify, exit 2, sem anunciar", () => {
    const posted: { args: string[]; input?: string }[] = [];
    const runner = fakeRunner({ failComments: true }, posted);
    const { result, out } = capture(() =>
      main(["--issues", "13120", "--session-id", "o", "--kind", "overnight", "--announce"], "/tmp", {
        runner,
        registryLookup: freeRegistry,
        now: () => NOW,
      }),
    );
    assert.equal(result, 2);
    assert.equal(JSON.parse(out).issues[0].verdict, "cannot-verify");
    assert.equal(posted.length, 0);
  });

  it("falha ao listar PRs → cannot-verify (nunca livre)", () => {
    const runner = fakeRunner({ failPrs: true });
    const { result } = capture(() =>
      main(["--issues", "13120", "--session-id", "o"], "/tmp", { runner, registryLookup: freeRegistry, now: () => NOW }),
    );
    assert.equal(result, 2);
  });

  it("sem --session-id → exit 2", () => {
    const { result } = capture(() => main(["--issues", "1"], "/tmp", { runner: fakeRunner({}) }));
    assert.equal(result, 2);
  });

  it("--release só grava onde esta sessão tem claim ativa", () => {
    const posted: { args: string[]; input?: string }[] = [];
    const mine = trusted(formatClaimComment({ kind: "overnight", sessionId: "o", host: "300", at: DEVELOP_AT }));
    const runner = fakeRunner({ comments: { 13120: [mine], 13128: [] } }, posted);
    const { result } = capture(() =>
      main(["--issues", "13120,13128", "--session-id", "o", "--release"], "/tmp", { runner, now: () => NOW }),
    );
    assert.equal(result, 0);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].args[2], "13120");
    assert.match(posted[0].input ?? "", /diaria-claim-release: v=1 session=o /);
  });
});
