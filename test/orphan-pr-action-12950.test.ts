/**
 * test/orphan-pr-action-12950.test.ts (#12950 item 3)
 *
 * `pr-em-voo` não pode deixar PR órfã. Na rodada 261112b o overnight pulou
 * #12892/#12894 como `pr-em-voo` (PRs #12896/#12897, aprovadas e verdes) e
 * #12873/#12874 (PR #12880, CI vermelho), e ninguém assumiu as PRs. O
 * preflight de PR aberta agora devolve `orphanAction` e as skills mandam
 * executá-la.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assessOpenPrCoverage, orphanPrAction, type OpenPrInfo } from "../scripts/lib/issue-open-pr-check.ts";
import { fetchOpenPrs, type CommandRunner } from "../scripts/lib/gh-open-pr-fetch.ts";
import { main } from "../scripts/check-issue-open-pr.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function pr(overrides: Partial<OpenPrInfo>): OpenPrInfo {
  return {
    number: 12897,
    title: "fix(guard): aspas duplas",
    body: "Closes #12894",
    headRefName: "overnight/fix-12894-guard",
    author: { login: "vjpixel" },
    updatedAt: "2026-11-12T08:04:00Z",
    statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
    isDraft: false,
    labels: [],
    ...overrides,
  };
}

describe("orphanAction no preflight de PR aberta (#12950 item 3)", () => {
  it("caso real #12897: PR de lane, verde, sem draft -> merge-via-gate2", () => {
    const result = assessOpenPrCoverage(12894, [pr({})]);
    assert.equal(result.verdict, "open-pr-covers-scope");
    assert.equal(result.orphanAction, "merge-via-gate2");
    assert.match(result.recommendation, /merge-via-gate2/);
  });

  it("caso real #12880: CI vermelho -> despachar-fixer", () => {
    const result = assessOpenPrCoverage(12873, [
      pr({
        number: 12880,
        body: "Closes #12873",
        headRefName: "overnight/batch-12873-12874",
        statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
      }),
    ]);
    assert.equal(result.orphanAction, "despachar-fixer");
  });

  const NOW = new Date("2026-11-12T10:00:00Z");
  const base = {
    ciState: "green" as const,
    isDraft: false,
    labels: [] as string[],
    headRefName: "continuo/fix-1-x",
    retido: false as boolean | null,
    updatedAt: "2026-11-12T08:00:00Z",
  };

  it("CI pendente, atualizada há até 6h -> aguardar-ci", () => {
    assert.equal(orphanPrAction({ ...base, ciState: "pending" }, { now: NOW }), "aguardar-ci");
  });

  it("CI pendente/ilegível parada há mais de 6h (updatedAt) -> editor (#12950 review)", () => {
    const old = { ...base, ciState: "pending" as const, updatedAt: "2026-11-12T03:00:00Z" };
    assert.equal(orphanPrAction(old, { now: NOW }), "editor");
    assert.equal(orphanPrAction({ ...old, ciState: "unknown" }, { now: NOW }), "editor");
    assert.equal(orphanPrAction({ ...base, ciState: "pending", updatedAt: "" }, { now: NOW }), "editor");
  });

  it("draft, bloqueio-execucao, retido-para-editor ou branch manual -> editor", () => {
    assert.equal(orphanPrAction({ ...base, isDraft: true }), "editor");
    assert.equal(orphanPrAction({ ...base, labels: ["bloqueio-execucao"] }), "editor");
    assert.equal(orphanPrAction({ ...base, labels: ["retido-para-editor"] }), "editor");
    assert.equal(orphanPrAction({ ...base, headRefName: "pixel/wip-ideia" }), "editor");
  });

  it("retenção por marcador no corpo (sem label) -> editor (#12950 review)", () => {
    const result = assessOpenPrCoverage(12894, [pr({ body: "Closes #12894\n\n<!-- retido-para-editor -->" })]);
    assert.equal(result.matches[0].retido, true);
    assert.equal(result.orphanAction, "editor");
  });

  it("issue reivindicada por sessão ativa (dono vivo) -> editor, também CI vermelho; consulta falha -> editor", () => {
    assert.equal(orphanPrAction(base, { claimedByActiveSession: true }), "editor");
    assert.equal(orphanPrAction({ ...base, ciState: "failing" }, { claimedByActiveSession: true }), "editor");
    assert.equal(orphanPrAction(base, { claimedByActiveSession: null }), "editor");
    assert.equal(orphanPrAction(base, { claimedByActiveSession: false }), "merge-via-gate2");
    const viaAssess = assessOpenPrCoverage(12894, [pr({})], undefined, { claimedByActiveSession: true });
    assert.equal(viaAssess.orphanAction, "editor");
  });

  it("payload sem isDraft/labels: labels ilegíveis, retenção fail-closed -> editor", () => {
    const { isDraft: _d, labels: _l, ...legacy } = pr({});
    const result = assessOpenPrCoverage(12894, [legacy as OpenPrInfo]);
    assert.equal(result.matches[0].isDraft, false);
    assert.deepEqual(result.matches[0].labels, []);
    assert.equal(result.matches[0].retido, null);
    assert.equal(result.orphanAction, "editor");
  });

  it("recomendação diz que, em lane autônoma, o orphanAction vale antes das perguntas 2 e 3", () => {
    assert.match(assessOpenPrCoverage(12894, [pr({})]).recommendation, /ANTES das perguntas 2 e 3/);
  });

  it("sem PR cobrindo -> sem orphanAction", () => {
    assert.equal(assessOpenPrCoverage(1, [pr({})]).orphanAction, undefined);
  });
});

describe("as skills mandam executar o orphanAction (#12950 item 3)", () => {
  for (const skill of ["diaria-overnight", "diaria-develop"]) {
    it(`${skill}/SKILL.md cita orphanAction e #12950 no preflight de PR aberta`, () => {
      const text = readFileSync(resolve(ROOT, ".claude/skills", skill, "SKILL.md"), "utf8");
      assert.match(text, /`orphanAction`[^\n]*#12950|#12950[^\n]*`orphanAction`/);
    });
  }
});

describe("fetch e CLI ponta a ponta (#12950 review)", () => {
  function runnerCapturing(stdout: string): { runner: CommandRunner; calls: string[][] } {
    const calls: string[][] = [];
    return { calls, runner: (_cmd, args) => (calls.push(args), { status: 0, stdout, stderr: "" }) };
  }

  it("fetchOpenPrs pede isDraft, labels e body no --json (sem eles o orphanAction cegaria)", () => {
    const { runner, calls } = runnerCapturing("[]");
    fetchOpenPrs("/tmp", runner);
    const fields = calls[0][calls[0].indexOf("--json") + 1].split(",");
    for (const f of ["isDraft", "labels", "body", "headRefName", "updatedAt", "statusCheckRollup"]) {
      assert.ok(fields.includes(f), `campo ${f} ausente do --json`);
    }
  });

  function runCli(prs: unknown[], claimed: boolean | null): { code: number; out: { orphanAction?: string } } {
    const { runner } = runnerCapturing(JSON.stringify(prs));
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m: string) => logs.push(m);
    try {
      const code = main(["--issue", "12894"], "/tmp", runner, () => claimed);
      return { code, out: JSON.parse(logs.join("\n")) };
    } finally {
      console.log = orig;
    }
  }

  it("draft vindo do gh -> exit 1, orphanAction editor", () => {
    const { code, out } = runCli([pr({ isDraft: true, labels: [] })], false);
    assert.equal(code, 1);
    assert.equal(out.orphanAction, "editor");
  });

  it("PR verde de lane, sem claim -> merge-via-gate2; com claim de sessão ativa -> editor", () => {
    assert.equal(runCli([pr({})], false).out.orphanAction, "merge-via-gate2");
    assert.equal(runCli([pr({})], true).out.orphanAction, "editor");
    assert.equal(runCli([pr({})], null).out.orphanAction, "editor");
  });
});
