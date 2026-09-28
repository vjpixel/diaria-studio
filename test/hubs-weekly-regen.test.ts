/**
 * test/hubs-weekly-regen.test.ts (#8906)
 *
 * Regressão pura pra `scripts/lib/hubs-weekly-regen.ts` — decisão de regen
 * por hub, bump de `UPDATED_DATE`, heurística de alarme de revisão de
 * prosa, e (#8923) a sequência de merge síncrono `mergeHubsRegenPr`. Nenhum
 * teste toca disco/rede — o orquestrador de I/O (`scripts/hubs-weekly-regen.ts`)
 * não é exercitado aqui (mesmo padrão de
 * `test/hub-drift-check.test.ts`/`test/hub-staleness-check.test.ts`); a
 * suíte de `mergeHubsRegenPr` usa um `TrainRunner` FAKE, mesmo padrão de
 * `test/merge-train-live.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  hasHubDataChange,
  planHubRegen,
  bumpUpdatedDateLine,
  HUB_PROSE_REVIEW_THRESHOLD_EDITIONS,
  emptyProseReviewState,
  countEditionsSince,
  decideProseAlarm,
  ensureProseReviewBaseline,
  mergeHubsRegenPr,
  type HubSourcesDiff,
} from "../scripts/lib/hubs-weekly-regen.ts";
import type { TrainRunner, ExecResult } from "../scripts/lib/merge-train-live.ts";

const EMPTY_DIFF: HubSourcesDiff = { added: [], removed: [], changed: [], unchanged: 3 };

// ─── Fake runner pra mergeHubsRegenPr (mesmo padrão de test/merge-train-live.test.ts) ───

type Handler = (args: string[], cwd?: string) => ExecResult;

function ok(stdout = ""): ExecResult {
  return { ok: true, stdout, stderr: "" };
}
function fail(stderr = "erro simulado"): ExecResult {
  return { ok: false, stdout: "", stderr };
}
function ciJson(conclusion: "SUCCESS" | "FAILURE"): string {
  return JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion, status: "COMPLETED" }] });
}

class FakeHubsRunner implements TrainRunner {
  readonly calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  private clock = 0;
  private handlers: { cmd: string; match: (args: string[], cwd?: string) => boolean; handler: Handler }[] = [];

  on(cmd: string, match: (args: string[], cwd?: string) => boolean, handler: Handler): this {
    this.handlers.push({ cmd, match, handler });
    return this;
  }

  exec(cmd: string, args: string[], cwd?: string): ExecResult {
    this.calls.push({ cmd, args, cwd });
    const found = [...this.handlers].reverse().find((h) => h.cmd === cmd && h.match(args, cwd));
    if (!found) throw new Error(`FakeHubsRunner: chamada não roteirizada: ${cmd} ${args.join(" ")} (cwd=${cwd ?? "default"})`);
    return found.handler(args, cwd);
  }

  async sleep(_ms: number): Promise<void> {
    this.clock += 30_000;
  }

  now(): number {
    return this.clock;
  }

  mkTempDir(prefix: string): string {
    return `/tmp/${prefix}1`;
  }

  warn(_message: string): void {
    // no-op — mergeHubsRegenPr nunca chama warn(), mas TrainRunner exige o método.
  }
}

function lockOkRunner(): FakeHubsRunner {
  return new FakeHubsRunner()
    .on("npx", (a) => a.includes("merge-lock-acquire"), () => ok())
    .on("npx", (a) => a.includes("merge-lock-release"), () => ok());
}

describe("hasHubDataChange", () => {
  it("false quando o diff não tem added/removed/changed", () => {
    assert.equal(hasHubDataChange(EMPTY_DIFF), false);
  });

  it("true com added", () => {
    assert.equal(hasHubDataChange({ ...EMPTY_DIFF, added: ["edicao-nova"] }), true);
  });

  it("true com removed", () => {
    assert.equal(hasHubDataChange({ ...EMPTY_DIFF, removed: ["edicao-velha"] }), true);
  });

  it("true com changed", () => {
    assert.equal(hasHubDataChange({ ...EMPTY_DIFF, changed: ["edicao-x"] }), true);
  });
});

describe("planHubRegen", () => {
  it("sem mudança de dados -> hasDataChange false, newUpdatedDate null", () => {
    const plan = planHubRegen("anthropic-claude", EMPTY_DIFF, "2026-09-28");
    assert.deepEqual(plan, { slug: "anthropic-claude", hasDataChange: false, newUpdatedDate: null });
  });

  it("com mudança de dados -> hasDataChange true, newUpdatedDate = todayISO (nunca derivado da edição)", () => {
    const diff: HubSourcesDiff = { ...EMPTY_DIFF, added: ["2026-09-25-edicao-nova"] };
    const plan = planHubRegen("openai-chatgpt", diff, "2026-09-28");
    assert.deepEqual(plan, { slug: "openai-chatgpt", hasDataChange: true, newUpdatedDate: "2026-09-28" });
  });
});

describe("bumpUpdatedDateLine", () => {
  it("substitui a linha const UPDATED_DATE pela nova data", () => {
    const before = [
      "// comentário",
      'const UPDATED_DATE = "2026-08-27";',
      "export const x = 1;",
    ].join("\n");
    const after = bumpUpdatedDateLine(before, "2026-09-28");
    assert.match(after, /const UPDATED_DATE = "2026-09-28";/);
    assert.doesNotMatch(after, /2026-08-27/);
  });

  it("preserva o resto do arquivo intocado", () => {
    const before = 'const A = 1;\nconst UPDATED_DATE = "2026-01-01";\nconst B = 2;\n';
    const after = bumpUpdatedDateLine(before, "2026-01-02");
    assert.equal(after, 'const A = 1;\nconst UPDATED_DATE = "2026-01-02";\nconst B = 2;\n');
  });

  it("lança quando o padrão não é encontrado (fail loud, #8906)", () => {
    assert.throws(() => bumpUpdatedDateLine("sem UPDATED_DATE aqui", "2026-09-28"), /não encontrado/);
  });
});

describe("countEditionsSince", () => {
  it("conta só datas estritamente posteriores", () => {
    const dates = ["2026-08-01", "2026-08-15", "2026-09-01", "2026-09-20"];
    assert.equal(countEditionsSince(dates, "2026-08-15"), 2);
  });

  it("zero quando nenhuma data é posterior", () => {
    assert.equal(countEditionsSince(["2026-01-01"], "2026-06-01"), 0);
  });
});

describe("decideProseAlarm", () => {
  it("não alarma abaixo do limiar", () => {
    const dates = Array.from({ length: HUB_PROSE_REVIEW_THRESHOLD_EDITIONS - 1 }, (_, i) => `2026-09-${10 + i}`);
    const decision = decideProseAlarm(emptyProseReviewState(), "anthropic-claude", dates, "2026-09-01");
    assert.equal(decision.alarm, false);
    assert.equal(decision.newEditionsCount, HUB_PROSE_REVIEW_THRESHOLD_EDITIONS - 1);
  });

  it("alarma no limiar exato", () => {
    const dates = Array.from({ length: HUB_PROSE_REVIEW_THRESHOLD_EDITIONS }, (_, i) => `2026-09-${10 + i}`);
    const decision = decideProseAlarm(emptyProseReviewState(), "anthropic-claude", dates, "2026-09-01");
    assert.equal(decision.alarm, true);
    assert.equal(decision.newEditionsCount, HUB_PROSE_REVIEW_THRESHOLD_EDITIONS);
  });

  it("usa a baseline persistida em `state` quando existe, não o fallback", () => {
    const state = { "anthropic-claude": { proseReviewedDate: "2026-09-20" } };
    const dates = ["2026-09-05", "2026-09-10", "2026-09-25"]; // só 1 depois de 2026-09-20
    const decision = decideProseAlarm(state, "anthropic-claude", dates, "2026-01-01");
    assert.equal(decision.baselineDate, "2026-09-20");
    assert.equal(decision.newEditionsCount, 1);
    assert.equal(decision.alarm, false);
  });
});

describe("ensureProseReviewBaseline", () => {
  it("semeia baseline quando o hub não tem entrada ainda (dia-0)", () => {
    const next = ensureProseReviewBaseline(emptyProseReviewState(), "google-gemini", "2026-09-17");
    assert.deepEqual(next, { "google-gemini": { proseReviewedDate: "2026-09-17" } });
  });

  it("não sobrescreve entrada já existente", () => {
    const state = { "google-gemini": { proseReviewedDate: "2026-08-01" } };
    const next = ensureProseReviewBaseline(state, "google-gemini", "2026-09-17");
    assert.deepEqual(next, state);
  });

  it("não afeta outros hubs", () => {
    const state = { "anthropic-claude": { proseReviewedDate: "2026-08-01" } };
    const next = ensureProseReviewBaseline(state, "google-gemini", "2026-09-17");
    assert.deepEqual(next, {
      "anthropic-claude": { proseReviewedDate: "2026-08-01" },
      "google-gemini": { proseReviewedDate: "2026-09-17" },
    });
  });
});

describe("mergeHubsRegenPr (#8923 — merge síncrono, nunca --auto)", () => {
  it("caminho feliz: acquire -> espera CI pass -> gh pr merge --squash SÍNCRONO (sem --auto) -> confirma -> release", async () => {
    const runner = lockOkRunner().on(
      "gh",
      (a) => a[0] === "pr" && a[1] === "view" && a.includes("statusCheckRollup"),
      () => ok(ciJson("SUCCESS")),
    );
    // `gh pr merge` só é chamado depois do CI ter respondido "pass" — sem
    // handler dedicado pra ele aqui, o teste falharia com "chamada não
    // roteirizada" se o código tentasse mergear ANTES da espera. Registrado
    // explicitamente, checado abaixo que veio com os args certos.
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok());

    const result = await mergeHubsRegenPr(runner, "123", { sessionId: "s1" });

    assert.equal(result.ok, true);
    assert.equal(result.merged, true);
    assert.equal(result.ciVerdict, "pass");

    const mergeCall = runner.calls.find((c) => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "merge");
    assert.ok(mergeCall, "gh pr merge deveria ter sido chamado");
    assert.deepEqual(mergeCall!.args, ["pr", "merge", "123", "--squash"]);
    assert.ok(!mergeCall!.args.includes("--auto"), "--auto nunca pode aparecer nos args do merge (#8923)");

    // Ordem: acquire vem ANTES do gate/merge, release vem DEPOIS — e release
    // sempre acontece (é o achado original: o lock não cobria a espera).
    const cmdOrder = runner.calls.map((c) => (c.args.includes("merge-lock-acquire") ? "acquire" : c.args.includes("merge-lock-release") ? "release" : c.args[1] === "merge" ? "merge" : c.args[1] === "view" ? "view" : "other"));
    assert.equal(cmdOrder[0], "acquire");
    assert.equal(cmdOrder[cmdOrder.length - 1], "release");
    assert.ok(cmdOrder.indexOf("merge") < cmdOrder.lastIndexOf("release"), "release precisa vir depois do merge, não antes");
  });

  it("gate vermelho (CI fail): nunca chama gh pr merge, PR fica aberto, lock é liberado mesmo assim", async () => {
    const runner = lockOkRunner().on(
      "gh",
      (a) => a[0] === "pr" && a[1] === "view" && a.includes("statusCheckRollup"),
      () => ok(ciJson("FAILURE")),
    );
    // Sem handler pra "gh pr merge" — se o código chamar mesmo assim, o
    // fake lança "chamada não roteirizada" e o teste falha (é a asserção).

    const result = await mergeHubsRegenPr(runner, "123", { sessionId: "s1" });

    assert.equal(result.ok, false);
    assert.equal(result.merged, false);
    assert.equal(result.ciVerdict, "fail");
    assert.match(result.error!, /CI não passou/);

    const releaseCall = runner.calls.find((c) => c.args.includes("merge-lock-release"));
    assert.ok(releaseCall, "lock precisa ser liberado mesmo com CI vermelho — nunca preso");
  });

  it("timeout de CI: trata como não-pass, não mergeia, libera o lock", async () => {
    const runner = lockOkRunner().on(
      "gh",
      (a) => a[0] === "pr" && a[1] === "view" && a.includes("statusCheckRollup"),
      () => ok(JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion: null, status: "IN_PROGRESS" }] })),
    );

    const result = await mergeHubsRegenPr(runner, "123", { sessionId: "s1", ciTimeoutMs: 100, ciPollIntervalMs: 30_000 });

    assert.equal(result.ok, false);
    assert.equal(result.ciVerdict, "timeout");
    const releaseCall = runner.calls.find((c) => c.args.includes("merge-lock-release"));
    assert.ok(releaseCall, "lock precisa ser liberado mesmo em timeout de CI");
  });

  it("merge-lock-acquire negado: nem espera CI nem tenta mergear", async () => {
    const runner = new FakeHubsRunner().on("npx", (a) => a.includes("merge-lock-acquire"), () => fail("denied (held by another session)"));

    const result = await mergeHubsRegenPr(runner, "123", { sessionId: "s1" });

    assert.equal(result.ok, false);
    assert.equal(result.merged, false);
    assert.match(result.error!, /merge-lock-acquire falhou/);
    assert.equal(
      runner.calls.some((c) => c.args[0] === "pr" && c.args[1] === "view"),
      false,
      "não deveria checar CI se o lock nem foi adquirido",
    );
  });

  it("gh pr merge reporta falha local mas o PR já mergeou no remoto (#573): confirma via gh pr view e retorna sucesso", async () => {
    const runner = lockOkRunner()
      .on("gh", (a) => a[0] === "pr" && a[1] === "view" && a.includes("statusCheckRollup"), () => ok(ciJson("SUCCESS")))
      .on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => fail("network blip local"))
      .on("gh", (a) => a[0] === "pr" && a[1] === "view" && a.includes("state,mergedAt"), () => ok(JSON.stringify({ state: "MERGED", mergedAt: "2026-09-28T12:00:00Z" })));

    const result = await mergeHubsRegenPr(runner, "123", { sessionId: "s1" });

    assert.equal(result.ok, true);
    assert.equal(result.merged, true);
  });
});
