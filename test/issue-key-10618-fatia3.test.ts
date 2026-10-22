/**
 * #10618 (fatia 3) — `IssueKey` como fonte única de chave de issue, e os
 * gates de fim de rodada lendo entrada de outro repo no repo DELA.
 *
 * Regra de todos os testes: a entrada `vjpixel/diaria-design#21` nunca é
 * confundida com a `vjpixel/diaria-studio#21` (o número colide), e a entrada
 * do studio segue com o comportamento de sempre.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  claimKeysOf,
  compareIssueKeys,
  ForeignIssueNumberError,
  groupIssueKeysByRepo,
  issueKeyLabel,
  issueKeyOfPlanEntry,
  requireStudioIssueNumber,
  studioNumberOfIssueKey,
  toIssueKey,
  type IssueKey,
} from "../scripts/lib/issue-key.ts";
import { normalizeIssues, type IssuesBearing } from "../scripts/lib/plan-issues-normalize.ts";
import {
  findStaleBlocks,
  suppressAgedClaimOverlap,
  type BlockStalenessConsultor,
  type BlockStalenessPlanIssue,
} from "../scripts/lib/block-staleness.ts";
import { CLAIM_STALE_AGE_MS, findAgedClaims, flattenAllClaims, flattenClaims } from "../scripts/lib/claim-staleness.ts";
import {
  checkPrTerminalState,
  findRegisteredNotTerminal,
  foreignClaimedIssueKeys,
  readAlienPrKeysConfirmed,
  type OpenPrLike,
  type PlanIssueWithPrLike,
} from "../scripts/lib/pr-terminal-state.ts";
import {
  findUnroutedSkipKeys,
  findUnroutedSkips,
  planIssueKeysRequiringRouting,
  planIssuesRequiringRouting,
  type IssueSnapshot,
  type SkippedPlanIssue,
} from "../scripts/lib/skipped-develop-track.ts";
import {
  checkConvergenceScan,
  collectKnownIssueKeys,
  findMissingForeignConvergenceKeys,
  foreignReposOfPlan,
  readRoundScopeFilters,
  type PlanWithGoal,
} from "../scripts/lib/state-changed-tracker.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DESIGN = "vjpixel/diaria-design";
const key = (s: string | number): IssueKey => toIssueKey(s)!;

describe("#10618 fatia 3 — IssueKey", () => {
  it("toIssueKey canoniza toda forma; número sozinho = studio", () => {
    assert.equal(toIssueKey(21), "vjpixel/diaria-studio#21");
    assert.equal(toIssueKey("#21"), "vjpixel/diaria-studio#21");
    assert.equal(toIssueKey("VJPixel/Diaria-Design#21"), "vjpixel/diaria-design#21");
    assert.equal(toIssueKey({ repo: "github.com/vjpixel/diaria-design", number: 21 }), "vjpixel/diaria-design#21");
    assert.equal(toIssueKey("https://github.com/vjpixel/diaria-design/issues/21"), "vjpixel/diaria-design#21");
    assert.equal(toIssueKey("lixo"), null);
    assert.equal(toIssueKey({ repo: "x", number: 21 }), null);
    assert.notEqual(toIssueKey(21), toIssueKey(`${DESIGN}#21`));
  });

  it("label: #N pro studio (saída de sempre), owner/repo#N pros outros", () => {
    assert.equal(issueKeyLabel(key(21)), "#21");
    assert.equal(issueKeyLabel(key(`${DESIGN}#21`)), `${DESIGN}#21`);
    assert.equal(studioNumberOfIssueKey(key(`${DESIGN}#21`)), null);
    assert.equal(studioNumberOfIssueKey(key(21)), 21);
  });

  it("ordenação: studio primeiro, depois repo e número", () => {
    const keys = [key(`${DESIGN}#3`), key(10), key(`${DESIGN}#1`), key(2)];
    assert.deepEqual(keys.sort(compareIssueKeys), [key(2), key(10), key(`${DESIGN}#1`), key(`${DESIGN}#3`)]);
  });

  it("issueKeyOfPlanEntry lê a chave qualificada de um plan DICT (normalizeIssues)", () => {
    const entries = normalizeIssues({ issues: { [`${DESIGN}#21`]: { status: "mergeada" }, "21": {} } as never });
    assert.deepEqual(entries.map(issueKeyOfPlanEntry).sort(), [`${DESIGN}#21`, "vjpixel/diaria-studio#21"]);
  });

  it("claimKeysOf junta claims do studio e de outro repo sem colisão", () => {
    const keys = claimKeysOf({ claimed_issues: [21], claimed_foreign_issues: [`${DESIGN}#21`, "lixo"] });
    assert.deepEqual(keys, [key(21), key(`${DESIGN}#21`)]);
    // `*_effective` vence o cru nos DOIS espaços.
    assert.deepEqual(
      claimKeysOf({
        claimed_issues: [21],
        claimed_issues_effective: [],
        claimed_foreign_issues: [`${DESIGN}#21`],
        claimed_foreign_issues_effective: [],
      }),
      [],
    );
  });

  it("groupIssueKeysByRepo separa repo fora da allowlist", () => {
    const { byRepo, outsideAllowlist } = groupIssueKeysByRepo(
      [key(1), key(`${DESIGN}#2`), key("fork/diaria-design#3")],
      ["vjpixel/diaria-studio", DESIGN],
    );
    assert.deepEqual(byRepo.get(DESIGN), [key(`${DESIGN}#2`)]);
    assert.deepEqual(byRepo.get("vjpixel/diaria-studio"), [key(1)]);
    assert.deepEqual(outsideAllowlist, [key("fork/diaria-design#3")]);
  });
});

describe("#10618 fatia 3 — guard requireStudioIssueNumber", () => {
  it("entrada do studio devolve o número", () => {
    assert.equal(requireStudioIssueNumber({ number: 21 }, "t"), 21);
    assert.equal(requireStudioIssueNumber({ ref: "vjpixel/diaria-studio#7" }, "t"), 7);
  });

  it("entrada de outro repo com `number` preenchido pela chave LANÇA (não devolve 21)", () => {
    const [design] = normalizeIssues({ issues: { [`${DESIGN}#21`]: { status: "pulada" } } as never });
    assert.equal((design as { number: number }).number, 21, "pré-condição: normalizeIssues preenche number");
    assert.throws(() => requireStudioIssueNumber(design, "gate-x"), (e: unknown) => {
      assert.ok(e instanceof ForeignIssueNumberError);
      assert.equal(e.key, `${DESIGN}#21`);
      assert.match(e.message, /\[gate-x\].*diaria-design#21/);
      return true;
    });
  });

  it("identidade desconhecida (`repo` ilegível) também lança — nunca cai no studio", () => {
    assert.throws(() => requireStudioIssueNumber({ number: 5, repo: 42 }, "t"), ForeignIssueNumberError);
  });

  it("planIssuesRequiringRouting (API só-studio) lança com entrada do design; studio igual a antes", () => {
    const studioOnly = { issues: [{ number: 9379, status: "pulada", motivo: "guard-de-execucao" }] };
    assert.deepEqual(planIssuesRequiringRouting(studioOnly), [9379]);
    const mixed = {
      issues: { [`${DESIGN}#21`]: { status: "pulada", motivo: "requer-sessao-local" } } as never,
    } as IssuesBearing<SkippedPlanIssue>;
    assert.throws(() => planIssuesRequiringRouting(mixed), ForeignIssueNumberError);
    assert.deepEqual(planIssueKeysRequiringRouting(mixed), {
      keys: [key(`${DESIGN}#21`)],
      unknownIdentity: 0,
      unknownEntries: [],
    });
  });

  it("entrada pulada SEM número nem ref é ignorada (não vira identidade desconhecida) — como o caminho legado", () => {
    const plan = { issues: [{ status: "pulada", motivo: "guard-de-execucao" }] } as IssuesBearing<SkippedPlanIssue>;
    assert.deepEqual(planIssuesRequiringRouting(plan), []);
    assert.deepEqual(planIssueKeysRequiringRouting(plan), { keys: [], unknownIdentity: 0, unknownEntries: [] });
  });

  it("só `repo`/`ref` presente mas ilegível conta como identidade desconhecida, com índice e campos crus", () => {
    const plan = {
      issues: [
        { number: 1, status: "pulada", motivo: "guard-de-execucao" },
        { number: 5, repo: 42, status: "pulada", motivo: "guard-de-execucao" },
        { ref: "lixo", status: "pulada", motivo: "requer-sessao-local" },
      ],
    } as IssuesBearing<SkippedPlanIssue>;
    const r = planIssueKeysRequiringRouting(plan);
    assert.deepEqual(r.keys, [key(1)]);
    assert.equal(r.unknownIdentity, 2);
    assert.deepEqual(r.unknownEntries, ['entrada [1] (repo=42, number=5)', 'entrada [2] (ref="lixo")']);
  });
});

describe("#10618 fatia 3 — skipped-develop-track consulta o repo da issue", () => {
  const plan = {
    issues: {
      [`${DESIGN}#21`]: { status: "pulada", motivo: "guard-de-execucao" },
      "21": { status: "pulada", motivo: "guard-de-execucao" },
    } as never,
  } as IssuesBearing<SkippedPlanIssue>;

  it("design#21 sem develop-track é acusada; studio#21 com develop-track não", () => {
    const snaps = new Map<IssueKey, IssueSnapshot>([
      [key(`${DESIGN}#21`), { labels: [], body: "" }],
      [key(21), { labels: ["develop-track"], body: "" }],
    ]);
    assert.deepEqual(findUnroutedSkipKeys(normalizeIssues(plan), snaps), [key(`${DESIGN}#21`)]);
  });

  it("findUnroutedSkips (por número, só-studio) não julga a design#21 pelo snapshot da studio#21", () => {
    // snapshot da studio#21 SEM develop-track: só a entrada do studio deve aparecer, uma vez.
    const snaps = new Map<number, IssueSnapshot>([[21, { labels: [], body: "" }]]);
    assert.deepEqual(findUnroutedSkips(normalizeIssues(plan), snaps), [21]);
  });
});

describe("#10618 fatia 3 — block-staleness avalia a entrada no repo dela", () => {
  const plan = {
    issues: {
      [`${DESIGN}#21`]: { status: "pulada", motivo: "claimed-por-outra-sessao" },
      "21": { status: "pulada", motivo: "claimed-por-outra-sessao" },
    } as never,
  } as IssuesBearing<BlockStalenessPlanIssue>;

  it("consultor multiRepo recebe o repo da design#21 e nada no studio#21", () => {
    const asked: Array<[number, string | undefined]> = [];
    const consultor: BlockStalenessConsultor = {
      multiRepo: true,
      getPrState: () => "UNKNOWN",
      // design#21 liberada, studio#21 ainda reivindicada.
      isIssueClaimedActive: (n, repo) => {
        asked.push([n, repo]);
        return repo === undefined;
      },
      hasLabel: () => null,
      getIssueState: () => "OPEN",
    };
    const findings = findStaleBlocks(normalizeIssues(plan), consultor);
    // Ordem do plan DICT normalizado: chave numérica (studio) antes da qualificada.
    assert.deepEqual(asked, [
      [21, undefined],
      [21, DESIGN],
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].key, `${DESIGN}#21`);
    assert.equal(findings[0].number, 21);
  });

  it("consultor legado (sem multiRepo) nunca é consultado pela design#21", () => {
    const asked: Array<[number, string | undefined]> = [];
    const consultor: BlockStalenessConsultor = {
      getPrState: () => "UNKNOWN",
      isIssueClaimedActive: (n, repo) => {
        asked.push([n, repo]);
        return false;
      },
      hasLabel: () => null,
      getIssueState: () => "OPEN",
    };
    const findings = findStaleBlocks(normalizeIssues(plan), consultor);
    assert.deepEqual(asked, [[21, undefined]]);
    assert.deepEqual(findings.map((f) => f.key), [key(21)]);
  });

  it("pr-em-voo da design#21 consulta o PR no diaria-design", () => {
    const prs: Array<[number, string | undefined]> = [];
    const consultor: BlockStalenessConsultor = {
      multiRepo: true,
      getPrState: (pr, repo) => {
        prs.push([pr, repo]);
        return repo === DESIGN ? "MERGED" : "OPEN";
      },
      isIssueClaimedActive: () => true,
      hasLabel: () => null,
      getIssueState: () => "OPEN",
    };
    const findings = findStaleBlocks(
      normalizeIssues({ issues: { [`${DESIGN}#21`]: { status: "pulada", motivo: "pr-em-voo", pr: 23 } } as never }),
      consultor,
    );
    assert.deepEqual(prs, [[23, DESIGN]]);
    assert.equal(findings[0]?.key, `${DESIGN}#21`);
  });

  it("suppressAgedClaimOverlap: claim envelhecida da studio#21 (número) não suprime a design#21", () => {
    const findings = [
      { number: 21, key: key(`${DESIGN}#21`), category: "claimed-por-outra-sessao" as const, motivo: "m", reason: "r" },
      { number: 21, key: key(21), category: "claimed-por-outra-sessao" as const, motivo: "m", reason: "r" },
    ];
    assert.deepEqual(
      suppressAgedClaimOverlap(findings, new Set([21])).map((f) => f.key),
      [key(`${DESIGN}#21`)],
    );
    assert.deepEqual(
      suppressAgedClaimOverlap(findings, new Set<IssueKey>([key(`${DESIGN}#21`)])).map((f) => f.key),
      [key(21)],
    );
  });
});

describe("#10618 fatia 3 — claim-staleness com claims de outro repo", () => {
  const NOW = Date.parse("2026-10-22T12:00:00Z");
  const old = new Date(NOW - CLAIM_STALE_AGE_MS - 60_000).toISOString();
  const sessions = [
    {
      kind: "develop",
      machineTag: "neo",
      sessionId: "s1",
      claimed_issues: [21],
      claimed_issues_at: { "21": old },
      claimed_foreign_issues: [`${DESIGN}#21`],
      claimed_foreign_issues_at: { [`${DESIGN}#21`]: old },
    },
  ];

  it("flattenClaims segue só-studio (shape do painel /triagem); flattenAllClaims inclui a design#21", () => {
    assert.deepEqual(flattenClaims(sessions).map((c) => c.issueNumber), [21]);
    const all = flattenAllClaims(sessions);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((c) => c.issueKey ?? null), [null, `${DESIGN}#21`]);
  });

  it("findAgedClaims passa o repo só pra claim de outro repo e devolve a chave", () => {
    const calls: Array<[number, string | undefined]> = [];
    const findings = findAgedClaims(flattenAllClaims(sessions), NOW, CLAIM_STALE_AGE_MS, (n, repo) => {
      calls.push([n, repo]);
      return repo === DESIGN ? false : true; // studio#21 tem PR aberto; design#21 não
    });
    assert.deepEqual(calls, [
      [21, undefined],
      [21, DESIGN],
    ]);
    assert.deepEqual(findings.map((f) => f.issueKey), [key(`${DESIGN}#21`)]);
  });
});

describe("#10618 fatia 3 — pr-terminal-state cruza PR pelo repo da issue", () => {
  const planIssues = normalizeIssues<PlanIssueWithPrLike>({
    issues: { [`${DESIGN}#21`]: { status: "pendente", pr: 23 } } as never,
  });

  it("PR #23 aberto no STUDIO não vira divergência da design#21", () => {
    const openPrs: OpenPrLike[] = [{ number: 23, headRefName: "overnight/fix-99-x" }];
    assert.deepEqual(findRegisteredNotTerminal(openPrs, planIssues), []);
    // E o #23 do studio segue candidato do studio (não "registrado" pela design#21).
    const v = checkPrTerminalState(openPrs, planIssues);
    assert.deepEqual(v.unregisteredCandidates.map((c) => [c.pr, c.repo]), [[23, undefined]]);
  });

  it("PR #23 aberto no DESIGN vira divergência com repo", () => {
    const openPrs: OpenPrLike[] = [{ number: 23, headRefName: "develop/fix-21", repo: DESIGN }];
    assert.deepEqual(findRegisteredNotTerminal(openPrs, planIssues), [
      { kind: "registered-not-terminal", pr: 23, repo: DESIGN, issueNumbers: [21], statuses: ["pendente"] },
    ]);
  });

  it("plano só-studio: shape de sempre (sem campo repo)", () => {
    const studio = normalizeIssues<PlanIssueWithPrLike>({ issues: [{ number: 5, status: "pendente", pr: 7 }] });
    assert.deepEqual(findRegisteredNotTerminal([{ number: 7, headRefName: "develop/fix-5" }], studio), [
      { kind: "registered-not-terminal", pr: 7, issueNumbers: [5], statuses: ["pendente"] },
    ]);
  });

  it("autoria alheia por chave: claim da design#21 confirma o PR do design, nunca o do studio", () => {
    const sessions = [
      { sessionId: "me", claimed_issues_effective: [] },
      { sessionId: "other", claimed_issues_effective: [], claimed_foreign_issues_effective: [`${DESIGN}#21`] },
    ];
    const liveKeys = foreignClaimedIssueKeys(sessions, "me");
    assert.deepEqual([...liveKeys], [`${DESIGN}#21`]);
    const openPrs: OpenPrLike[] = [
      { number: 30, headRefName: "develop/fix-21-a", repo: DESIGN },
      { number: 31, headRefName: "develop/fix-21-b" },
    ];
    const v = checkPrTerminalState(openPrs, [], undefined, { liveForeignClaimedKeys: liveKeys });
    assert.deepEqual(v.alienConfirmed.map((a) => [a.pr, a.repo]), [[30, DESIGN]]);
    assert.deepEqual(v.unregisteredCandidates.map((c) => c.pr), [31]);
  });

  it("alien_prs_confirmed aceita owner/repo#N; número segue sendo PR do studio", () => {
    const keys = readAlienPrKeysConfirmed({ alien_prs_confirmed: [`${DESIGN}#30`, 31, "lixo"] });
    assert.deepEqual([...keys].sort(), [`${DESIGN}#30`, "vjpixel/diaria-studio#31"]);
    const v = checkPrTerminalState(
      [
        { number: 31, headRefName: "develop/fix-1", repo: DESIGN },
        { number: 30, headRefName: "develop/fix-2", repo: DESIGN },
      ],
      [],
      undefined,
      { confirmedPrs: new Set([31]), confirmedPrKeys: keys },
    );
    assert.deepEqual(v.alienConfirmed.map((a) => a.pr), [30]);
    assert.deepEqual(v.unregisteredCandidates.map((c) => c.pr), [31]);
  });
});

describe("#10618 fatia 3 — convergência multi-repo (state-changed-tracker)", () => {
  const plan: PlanWithGoal = {
    goal: { target_set: [`${DESIGN}#21`, 21] },
    issues: { [`${DESIGN}#21`]: { status: "mergeada" } },
  };

  it("collectKnownIssueKeys e foreignReposOfPlan", () => {
    assert.deepEqual([...collectKnownIssueKeys(plan)].sort(compareIssueKeys), [key(21), key(`${DESIGN}#21`)]);
    assert.deepEqual(foreignReposOfPlan(plan), [DESIGN]);
    assert.deepEqual(foreignReposOfPlan({ goal: { target_set: [1, 2] } }), []);
    assert.deepEqual(foreignReposOfPlan({ state_changed_issues: [`${DESIGN}#9`] }), [DESIGN]);
  });

  it("issue nova do design é acusada pela chave; a conhecida (design#21) não", () => {
    const open = [
      { number: 21, labels: [] },
      { number: 22, labels: [] },
      { number: 23, labels: ["on-hold"] },
    ];
    assert.deepEqual(findMissingForeignConvergenceKeys(plan, DESIGN, open), [key(`${DESIGN}#22`)]);
  });

  it("studio: a design#21 no plano NÃO torna conhecida a studio#21 (e vice-versa)", () => {
    const designOnly: PlanWithGoal = { goal: { target_set: [`${DESIGN}#21`] } };
    assert.deepEqual(checkConvergenceScan(designOnly, [{ number: 21, labels: [] }]), {
      status: "missing",
      issues: [21],
      novas_encontradas: 1,
    });
    const studioOnly: PlanWithGoal = { goal: { target_set: [21] } };
    assert.deepEqual(findMissingForeignConvergenceKeys(studioOnly, DESIGN, [{ number: 21, labels: [] }]), [
      key(`${DESIGN}#21`),
    ]);
  });

  it("issues_filter misto: cada repo só vê o próprio escopo", () => {
    const scoped: PlanWithGoal = { issues_filter: [5, `${DESIGN}#22`] };
    const f = readRoundScopeFilters(scoped);
    assert.deepEqual(f.issuesFilter, [5]);
    assert.deepEqual([...(f.issuesFilterKeys ?? [])].sort(), [`${DESIGN}#22`, "vjpixel/diaria-studio#5"]);
    assert.deepEqual(
      findMissingForeignConvergenceKeys(scoped, DESIGN, [
        { number: 22, labels: [] },
        { number: 24, labels: [] },
      ]),
      [key(`${DESIGN}#22`)],
    );
    // Filtro só com números do studio: nada do design está em escopo.
    assert.deepEqual(findMissingForeignConvergenceKeys({ issues_filter: [5] }, DESIGN, [{ number: 22, labels: [] }]), []);
    // Item ilegível desliga o filtro (comportamento de sempre).
    assert.equal(readRoundScopeFilters({ issues_filter: [5, "lixo"] }).issuesFilter, null);
  });
});

// ---------------------------------------------------------------------------
// CLI: check-state-changed-pending com `gh` fake que responde por `-R`
// ---------------------------------------------------------------------------

describe("#10618 fatia 3 — CLI check-state-changed-pending varre o repo de outro repo do plano", () => {
  let root: string | null = null;
  afterEach(() => {
    // maxRetries: no Windows o gh.exe fake às vezes ainda segura o diretório.
    // Mesmo padrão de `check-overnight-fila-convergence-gate.test.ts`: no
    // Windows o antivírus pode segurar o gh.exe recém-copiado — resíduo no
    // tmp não é falha do teste.
    if (root) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (e) {
        console.warn(`[issue-key-10618-fatia3.test] cleanup residual de ${root}: ${(e as Error).message}`);
      }
    }
    root = null;
  });

  function setup(plan: unknown, responses: Record<string, unknown[]>) {
    root = mkdtempSync(join(tmpdir(), "fatia3-convergence-"));
    const planPath = join(root, "plan.json");
    writeFileSync(planPath, JSON.stringify(plan));
    const ghDir = join(root, "bin");
    mkdirSync(ghDir);
    const ghBin = join(ghDir, process.platform === "win32" ? "gh.exe" : "gh");
    copyFileSync(process.execPath, ghBin);
    if (process.platform !== "win32") chmodSync(ghBin, 0o755);
    const respDir = join(root, "resp");
    mkdirSync(respDir);
    for (const [repo, body] of Object.entries(responses)) {
      writeFileSync(join(respDir, repo.replace("/", "--") + ".json"), JSON.stringify(body));
    }
    const logPath = join(root, "calls.log");
    const preload = join(ghDir, "preload.cjs");
    writeFileSync(
      preload,
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "if (process.argv[1] && path.basename(process.argv[1]) === 'issue') {",
        "  const args = process.argv.slice(2);",
        "  fs.appendFileSync(process.env.GH_FAKE_LOG, JSON.stringify(args) + '\\n');",
        "  const i = args.indexOf('-R');",
        "  const repo = i === -1 ? 'default' : args[i + 1].replace('/', '--');",
        "  const f = path.join(process.env.GH_FAKE_RESP_DIR, repo + '.json');",
        "  if (!fs.existsSync(f)) { process.stderr.write('repo desconhecido'); process.exit(1); }",
        "  process.stdout.write(fs.readFileSync(f, 'utf8'));",
        "  process.exit(0);",
        "}",
      ].join("\n"),
    );
    const env = {
      ...process.env,
      PATH: ghDir,
      Path: ghDir,
      NODE_OPTIONS: `--require ${preload}`,
      GH_FAKE_RESP_DIR: respDir,
      GH_FAKE_LOG: logPath,
    };
    const run = () =>
      spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts/check-state-changed-pending.ts"), "--plan", planPath], {
        cwd: ROOT,
        encoding: "utf8",
        env,
      });
    const calls = () =>
      readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]);
    return { run, calls, planPath };
  }

  it("design#22 nova é acusada como owner/repo#N; a studio#22 aberta e conhecida não confunde", () => {
    const { run, calls } = setup(
      { goal: { target_set: [`${DESIGN}#21`, 22] } },
      {
        default: [{ number: 22, labels: [], body: "" }],
        [DESIGN]: [
          { number: 21, labels: [], body: "" },
          { number: 22, labels: [], body: "" },
        ],
      },
    );
    const r = run();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /vjpixel\/diaria-design#22/);
    assert.doesNotMatch(r.stderr, /(?<!diaria-design)#2[12]\b/, "nenhuma issue do studio acusada");
    const c = calls();
    assert.equal(c.length, 2);
    assert.equal(c[0].includes("-R"), false, "a chamada do studio é a de sempre");
    assert.deepEqual(c[1].slice(c[1].indexOf("-R"), c[1].indexOf("-R") + 2), ["-R", DESIGN]);
  });

  it("plano só-studio: uma chamada só, sem -R (comportamento de sempre)", () => {
    const { run, calls } = setup({ goal: { target_set: [22] } }, { default: [{ number: 22, labels: [], body: "" }] });
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(calls().length, 1);
    assert.equal(calls()[0].includes("-R"), false);
  });

  it("falha do gh no repo extra: aviso de NÃO varrido, sem acusar nada nem dar ok enganoso", () => {
    const { run } = setup(
      { goal: { target_set: [`${DESIGN}#21`] } },
      { default: [] }, // sem resposta pro design → gh do design sai 1
    );
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /NÃO executada para: vjpixel\/diaria-design/);
    assert.match(r.stdout, /exceto nos repos NÃO varridos/);
  });

  it("repo fora de issue_repos nunca é consultado", () => {
    const { run, calls } = setup({ goal: { target_set: ["fork/diaria-design#21"] } }, { default: [] });
    const r = run();
    assert.match(r.stderr, /fork\/diaria-design \(fora de issue_repos\)/);
    assert.equal(calls().length, 1);
  });
});

// O teste de CLI de check-block-staleness (antes aqui, com PATH sem gh e
// asserções só negativas) foi substituído por gh fake com asserção positiva
// em test/issue-key-10618-fatia3-cli.test.ts.
