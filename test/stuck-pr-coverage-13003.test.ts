/**
 * test/stuck-pr-coverage-13003.test.ts (#13003)
 *
 * Dois buracos de cobertura achados no self-review da PR #12986 (#12950):
 *
 * 1. `stuck-approved-pr-alarm.ts` só listava PRs do diaria-studio. PR
 *    aprovada e verde parada no diaria-design (`issue_repos`) não alarmava.
 *    Agora o achado carrega o repo, a chave do conjunto e o e-mail o
 *    qualificam (o `#21` do design não é o `#21` do studio), e o CLI itera
 *    `issue_repos` com `-R`.
 * 2. `check-block-staleness.ts` só reabria `pr-em-voo` quando a PR era
 *    mergeada/fechada. Com `orphan_action: "aguardar-ci"`, a espera é pelo
 *    CI: CI terminado (verde ou vermelho) com a PR ainda aberta também caduca
 *    o bloqueio.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStuckApprovedPrAlarmEmail,
  evaluateStuckApprovedPrs,
  stuckApprovedPrRef,
  stuckApprovedPrSetKey,
  type StuckApprovedPrEntry,
  type StuckApprovedPrFinding,
} from "../scripts/lib/stuck-approved-pr-alarm.ts";
import { ghRepoArgs } from "../scripts/stuck-approved-pr-alarm.ts";
import {
  findStaleBlocks,
  type BlockStalenessConsultor,
  type BlockStalenessPlanIssue,
} from "../scripts/lib/block-staleness.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-11-13T12:00:00Z");
const GREEN = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];

function pr(overrides: Partial<StuckApprovedPrEntry>): StuckApprovedPrEntry {
  return {
    number: 21,
    title: "fix",
    body: "",
    isDraft: false,
    labels: [],
    createdAt: "2026-11-13T00:00:00Z",
    mergeable: "MERGEABLE",
    statusCheckRollup: GREEN,
    reviewDecision: "APPROVED",
    headRefOid: "abc",
    comments: [],
    ...overrides,
  };
}

describe("#13003 item 1: alarme de PR aprovada parada cobre issue_repos", () => {
  it("PR do diaria-design aprovada e verde vira achado com o repo", () => {
    const findings = evaluateStuckApprovedPrs([pr({ repo: "vjpixel/diaria-design" })], NOW, 4);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].repo, "vjpixel/diaria-design");
  });

  it("a referência qualifica só fora do repo default", () => {
    assert.equal(stuckApprovedPrRef({ number: 21 }), "#21");
    assert.equal(stuckApprovedPrRef({ number: 21, repo: "vjpixel/diaria-studio" }), "#21");
    assert.equal(stuckApprovedPrRef({ number: 21, repo: "vjpixel/diaria-design" }), "vjpixel/diaria-design#21");
  });

  it("o #21 do design e o #21 do studio são PRs diferentes na chave do conjunto", () => {
    const base: Omit<StuckApprovedPrFinding, "number"> = {
      title: "x",
      isDraft: false,
      hoursOpen: 5,
      approvedBy: "github-review",
      mergeable: "MERGEABLE",
    };
    const studioOnly = stuckApprovedPrSetKey([{ ...base, number: 21 }]);
    const both = stuckApprovedPrSetKey([
      { ...base, number: 21, repo: "vjpixel/diaria-design" },
      { ...base, number: 30 },
      { ...base, number: 21 },
    ]);
    assert.equal(studioOnly, "21", "chave só-studio não muda (issues já abertas continuam casando)");
    assert.equal(both, "21,30,vjpixel/diaria-design#21");
  });

  it("o e-mail cita a PR do design com o repo", () => {
    const findings = evaluateStuckApprovedPrs([pr({ repo: "vjpixel/diaria-design" }), pr({ number: 30 })], NOW, 4);
    const { body } = buildStuckApprovedPrAlarmEmail(findings, 4, NOW);
    assert.match(body, /PR vjpixel\/diaria-design#21 "fix"/);
    assert.match(body, /PR #30 "fix"/);
  });

  it("-R só fora do repo default", () => {
    assert.deepEqual(ghRepoArgs(undefined), []);
    assert.deepEqual(ghRepoArgs("vjpixel/diaria-studio"), []);
    assert.deepEqual(ghRepoArgs("vjpixel/diaria-design"), ["-R", "vjpixel/diaria-design"]);
  });

  it("o CLI itera loadIssueRepos e passa o repo da candidata ao gh pr view", () => {
    const src = readFileSync(resolve(ROOT, "scripts/stuck-approved-pr-alarm.ts"), "utf8");
    assert.match(src, /const repos = loadIssueRepos\(ROOT\)/);
    assert.match(src, /listOpenPrsBasic\(ROOT, repo\)/);
    assert.match(src, /fetchPrComments\(candidate\.number, ROOT, candidate\.repo\)/);
  });
});

function consultor(overrides: Partial<BlockStalenessConsultor>): BlockStalenessConsultor {
  return {
    getPrState: () => "OPEN",
    isIssueClaimedActive: () => true,
    hasLabel: () => null,
    getIssueState: () => "OPEN",
    ...overrides,
  };
}

describe("#13003 item 2: pr-em-voo com orphan_action aguardar-ci reabre quando o CI termina", () => {
  const entry: BlockStalenessPlanIssue = {
    number: 12892,
    status: "pulada",
    motivo: "pr-em-voo",
    pr: 12896,
    orphan_action: "aguardar-ci",
  };

  it("CI verde com a PR aberta → caducou (merge-via-gate2)", () => {
    const findings = findStaleBlocks([entry], consultor({ getPrCiState: () => "green" }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].category, "pr-em-voo");
    assert.match(findings[0].reason, /CI do PR #12896 terminou \(verde → merge-via-gate2\)/);
  });

  it("CI vermelho com a PR aberta → caducou (despachar-fixer)", () => {
    const findings = findStaleBlocks([entry], consultor({ getPrCiState: () => "failing" }));
    assert.equal(findings.length, 1);
    assert.match(findings[0].reason, /vermelho → despachar-fixer/);
  });

  it("CI ainda pendente → segue bloqueada", () => {
    assert.deepEqual(findStaleBlocks([entry], consultor({ getPrCiState: () => "pending" })), []);
  });

  it("CI ilegível → não vira achado, mas entra na ressalva", () => {
    const unverifiable: string[] = [];
    const findings = findStaleBlocks([entry], consultor({ getPrCiState: () => "unknown" }), (k, what) =>
      unverifiable.push(`${k}: ${what}`),
    );
    assert.deepEqual(findings, []);
    assert.deepEqual(unverifiable, ["vjpixel/diaria-studio#12892: CI do PR #12896"]);
  });

  it("sem orphan_action aguardar-ci, CI verde não reabre (PR em voo de outra sessão segue em voo)", () => {
    const { orphan_action: _omit, ...plain } = entry;
    let consulted = false;
    const findings = findStaleBlocks(
      [plain, { ...entry, orphan_action: "editor" }],
      consultor({
        getPrCiState: () => {
          consulted = true;
          return "green";
        },
      }),
    );
    assert.deepEqual(findings, []);
    assert.equal(consulted, false);
  });

  it("consultor sem getPrCiState mantém o comportamento antigo", () => {
    assert.deepEqual(findStaleBlocks([entry], consultor({})), []);
  });

  it("PR do design citada: a consulta de CI vai com o repo", () => {
    const seen: Array<string | undefined> = [];
    const findings = findStaleBlocks(
      [{ ...entry, pr: "vjpixel/diaria-design#21" }],
      consultor({
        multiRepo: true,
        issueRepos: ["vjpixel/diaria-studio", "vjpixel/diaria-design"],
        getPrCiState: (_n, repo) => {
          seen.push(repo);
          return "green";
        },
      }),
    );
    assert.deepEqual(seen, ["vjpixel/diaria-design"]);
    assert.match(findings[0].reason, /CI do vjpixel\/diaria-design PR #21 terminou/);
  });

  it("o consultor real implementa getPrCiState via deriveOpenPrCiState", () => {
    const src = readFileSync(resolve(ROOT, "scripts/check-block-staleness.ts"), "utf8");
    assert.match(src, /getPrCiState\(prNumber: number, repo\?: string\): OpenPrCiState/);
    assert.match(src, /deriveOpenPrCiState\(parsed\.statusCheckRollup\)/);
  });
});
