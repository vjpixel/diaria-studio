/**
 * #10618 (fatia 3, fixer da PR #10852) — gates de fim de rodada multi-repo:
 * nenhum gate pode dizer "ok" sem ressalva quando deixou de verificar algo de
 * outro repo.
 *
 * Duas metades:
 * - unidades puras das mudanças do fixer (PR registrado em repo não
 *   consultado, `findRetrackedUnworkedForeignIssues`, `onUnverifiable`/
 *   `onUnevaluated`, rótulos `owner/repo#N`);
 * - CLIs reais contra um `gh` FAKE que registra o argv de cada chamada e
 *   responde por regra — prova POSITIVA de que a entrada do design é
 *   consultada com `-R vjpixel/diaria-design` (ou `gh api
 *   repos/vjpixel/diaria-design/…`). Cada CLI roda com `cwd` num diretório
 *   temporário que tem o próprio `platform.config.json` (fixture de
 *   `issue_repos`) e o próprio `data/sessions/` — nunca o config nem as
 *   sessões reais do checkout.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describeUnknownPlanEntry, toIssueKey, type IssueKey } from "../scripts/lib/issue-key.ts";
import {
  checkPrTerminalState,
  findRegisteredInUnevaluatedRepos,
  findRegisteredNotTerminal,
  type OpenPrLike,
  type PlanIssueWithPrLike,
} from "../scripts/lib/pr-terminal-state.ts";
import {
  findStaleBlocks,
  isTransientBlockEntry,
  type BlockStalenessConsultor,
} from "../scripts/lib/block-staleness.ts";
import { findAgedClaims, flattenAllClaims } from "../scripts/lib/claim-staleness.ts";
import { findUnroutedSkipKeys, type IssueSnapshot } from "../scripts/lib/skipped-develop-track.ts";
import {
  findRetrackedUnworkedForeignIssues,
  findRetrackedUnworkedIssues,
  recordConvergenceScan,
} from "../scripts/lib/state-changed-tracker.ts";
import {
  findDeixadoPara300Buraco,
  findDeixadoPara300BuracoLabels,
  findInvalidPuladaMotivos,
  planEntryLabel,
} from "../scripts/lib/develop-plan-motivo.ts";
import { normalizeIssues, type IssuesBearing } from "../scripts/lib/plan-issues-normalize.ts";
import { claimIssueCheckAndSet, registerSession } from "../scripts/lib/session-registry.ts";

const ROOT = resolve(import.meta.dirname, "..");
const STUDIO = "vjpixel/diaria-studio";
const DESIGN = "vjpixel/diaria-design";
const key = (s: string | number): IssueKey => toIssueKey(s)!;
/** Loader do tsx por URL absoluta — o subprocesso roda com `cwd` no tmp, de
 * onde `--import tsx` não resolveria. */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

// ---------------------------------------------------------------------------
// Unidades puras
// ---------------------------------------------------------------------------

describe("#10618 fixer — pr-terminal-state: PR de repo não consultado nunca é lido como fechado", () => {
  const plan: PlanIssueWithPrLike[] = normalizeIssues({
    issues: {
      [`${DESIGN}#21`]: { status: "pendente", pr: 23 },
      "21": { status: "pendente", pr: 23 },
    } as never,
  } as IssuesBearing<PlanIssueWithPrLike>);

  it("sem repo não consultado: o design#23 ausente da lista conta como fechado (comportamento de sempre)", () => {
    assert.deepEqual(findRegisteredNotTerminal([{ number: 23 }], plan).map((d) => d.repo ?? STUDIO), [STUDIO]);
  });

  it("repo não consultado: o PR registrado vai pra notEvaluated, nunca pra 'fechado' nem pra divergência", () => {
    const unevaluated = new Set([DESIGN]);
    assert.deepEqual(findRegisteredInUnevaluatedRepos(plan, unevaluated), [{ pr: 23, repo: DESIGN, issueNumbers: [21] }]);
    const v = checkPrTerminalState([{ number: 23 }], plan, undefined, {}, unevaluated);
    assert.equal(v.status, "divergent", "o studio#23 aberto continua divergente");
    assert.deepEqual(v.registeredNotTerminal.map((d) => d.repo ?? STUDIO), [STUDIO]);
    assert.deepEqual(v.notEvaluated, [{ pr: 23, repo: DESIGN, issueNumbers: [21] }]);
  });

  it("verdict sem repo não consultado traz notEvaluated vazio", () => {
    assert.deepEqual(checkPrTerminalState([], plan).notEvaluated, []);
  });
});

describe("#10618 fixer — block-staleness: rótulo do PR com repo e 'não sei' por chave", () => {
  function consultor(over: Partial<BlockStalenessConsultor> = {}): BlockStalenessConsultor {
    return {
      multiRepo: true,
      getPrState: () => "MERGED",
      isIssueClaimedActive: () => true,
      hasLabel: () => false,
      getIssueState: () => "OPEN",
      ...over,
    };
  }

  it("pr-em-voo do design cita `vjpixel/diaria-design PR #23` (o PR mora no repo da issue)", () => {
    const issues = normalizeIssues({
      issues: {
        [`${DESIGN}#21`]: { status: "pulada", motivo: "pr-em-voo", pr: 23 },
        "5": { status: "pulada", motivo: "pr-em-voo", pr: 6 },
      } as never,
    } as IssuesBearing<never>);
    const reasons = findStaleBlocks(issues, consultor()).map((f) => f.reason);
    assert.deepEqual(reasons, ["PR #6 já está mergeado — bloqueio caducou", `${DESIGN} PR #23 já está mergeado — bloqueio caducou`]);
  });

  it("onUnverifiable recebe a chave quando o estado do PR ou as labels voltam 'não sei'", () => {
    const issues = normalizeIssues({
      issues: {
        [`${DESIGN}#21`]: { status: "pulada", motivo: "pr-em-voo", pr: 23 },
        [`${DESIGN}#22`]: { status: "pulada", motivo: "bloqueio-execucao" },
      } as never,
    } as IssuesBearing<never>);
    const seen: string[] = [];
    const findings = findStaleBlocks(
      issues,
      consultor({ getPrState: () => "UNKNOWN", hasLabel: () => null }),
      (k, what) => seen.push(`${k}: ${what}`),
    );
    assert.deepEqual(findings, []);
    assert.deepEqual(seen.sort(), [`${DESIGN}#21: estado do PR #23`, `${DESIGN}#22: labels da issue`]);
  });

  it("isTransientBlockEntry: só pulada com motivo transitório", () => {
    assert.equal(isTransientBlockEntry({ status: "pulada", motivo: "pr-em-voo" }), true);
    assert.equal(isTransientBlockEntry({ status: "pulada", motivo: "ambigua" }), false);
    assert.equal(isTransientBlockEntry({ status: "pendente", motivo: "pr-em-voo" }), false);
  });
});

describe("#10618 fixer — claim-staleness: claimKeysOf, número pela chave e claim não avaliada", () => {
  const OLD = new Date(Date.now() - 7 * 3_600_000).toISOString();

  it("flattenAllClaims canoniza a chave e acha o timestamp gravado com outra caixa", () => {
    const entries = flattenAllClaims([
      {
        kind: "develop",
        machineTag: "h",
        sessionId: "s",
        claimed_foreign_issues: ["VJPixel/Diaria-Design#21", "lixo"],
        claimed_foreign_issues_at: { "VJPixel/Diaria-Design#21": OLD },
      },
    ]);
    assert.deepEqual(
      entries.map((e) => [e.issueKey, e.issueNumber, e.claimedAt]),
      [[`${DESIGN}#21`, 21, OLD]],
    );
  });

  it("findAgedClaims deriva o número da chave e reporta claim sem timestamp / não verificável", () => {
    const calls: string[] = [];
    const seen: string[] = [];
    const out = findAgedClaims(
      [
        // issueNumber legado divergente da chave: a chave vence.
        { issueNumber: 999, issueKey: key(`${DESIGN}#21`), kind: "k", machineTag: "m", sessionId: "s", claimedAt: OLD, stale: false },
        { issueNumber: 30, issueKey: key(`${DESIGN}#30`), kind: "k", machineTag: "m", sessionId: "s", claimedAt: null, stale: false },
        { issueNumber: 31, issueKey: key(`${DESIGN}#31`), kind: "k", machineTag: "m", sessionId: "s", claimedAt: OLD, stale: false },
      ],
      Date.now(),
      6 * 3_600_000,
      (n, repo) => {
        calls.push(`${repo}#${n}`);
        return n === 31 ? null : false;
      },
      undefined,
      (k, reason) => seen.push(`${k}:${reason}`),
    );
    assert.deepEqual(out.map((c) => [c.issueKey, c.issueNumber]), [[`${DESIGN}#21`, 21]]);
    assert.deepEqual(calls, [`${DESIGN}#21`, `${DESIGN}#31`]);
    assert.deepEqual(seen, [`${DESIGN}#30:sem-timestamp`, `${DESIGN}#31:nao-verificavel`]);
  });
});

describe("#10618 fixer — skipped-develop-track: regressões do #9516 sobre findUnroutedSkipKeys", () => {
  it("bloqueada/agendada/fechada/fora-de-rodada e windows não são acusadas; overnight sim; sem duplicar", () => {
    const issues = [
      ...[4, 5, 6, 7, 8, 9].map((number) => ({ number, status: "pulada", motivo: "guard-de-execucao" })),
      { number: 8, status: "pulada", motivo: "requer-sessao-local" }, // duplicada
      { ref: `${DESIGN}#8`, status: "pulada", motivo: "guard-de-execucao" },
    ];
    const snaps = new Map<IssueKey, IssueSnapshot>([
      [key(4), { labels: ["external-blocker"], body: "" }],
      [key(5), { labels: [], body: "", state: "closed" }],
      [key(6), { labels: ["on-hold"], body: "" }],
      [key(7), { labels: [], body: "<!-- aguardando-ate: 2099-01-01 -->" }],
      [key(8), { labels: [], body: "", state: "open" }],
      [key(9), { labels: ["windows"], body: "" }],
      [key(`${DESIGN}#8`), { labels: ["develop-track"], body: "" }],
    ]);
    assert.deepEqual(findUnroutedSkipKeys(issues, snaps), [key(8)]);
  });
});

describe("#10618 fixer — state-changed-tracker: re-roteamento (#10407) no repo extra", () => {
  const plan = {
    issues: {
      [`${DESIGN}#21`]: { status: "pulada", motivo: "deixado-para-o-300", exec_track_painel: "overnight" },
      "21": { status: "pulada", motivo: "deixado-para-o-300", exec_track_painel: "overnight" },
    },
  };

  it("a design#21 re-roteada é acusada pelas labels do DESIGN; a studio#21 não é julgada por elas", () => {
    const design = [{ number: 21, labels: ["develop-track"], body: "" }];
    assert.deepEqual(findRetrackedUnworkedForeignIssues(plan, DESIGN, design), [
      { number: 21, key: key(`${DESIGN}#21`), motivo: "deixado-para-o-300", track_gravado: "overnight", track_atual: "develop" },
    ]);
    assert.deepEqual(findRetrackedUnworkedIssues(plan, design), [
      { number: 21, motivo: "deixado-para-o-300", track_gravado: "overnight", track_atual: "develop" },
    ], "a função do studio, com a lista do design, julgaria a studio#21 — por isso o CLI só passa a lista do studio a ela");
    assert.deepEqual(findRetrackedUnworkedIssues(plan, [{ number: 21, labels: [], body: "" }]), []);
    assert.deepEqual(findRetrackedUnworkedForeignIssues(plan, DESIGN, [{ number: 21, labels: [], body: "" }]), []);
  });

  it("recordConvergenceScan grava repos_nao_varridos só quando há repo não varrido", () => {
    const dir = mkdtempSync(join(tmpdir(), "fatia3-scan-"));
    try {
      const p = join(dir, "plan.json");
      writeFileSync(p, JSON.stringify({ goal: {} }));
      recordConvergenceScan(p, 0, "2026-10-22T00:00:00.000Z");
      assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).goal.last_convergence_scan, {
        at: "2026-10-22T00:00:00.000Z",
        novas_encontradas: 0,
      });
      recordConvergenceScan(p, 1, "2026-10-22T00:00:00.000Z", [`${DESIGN} (gh falhou)`]);
      assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).goal.last_convergence_scan.repos_nao_varridos, [
        `${DESIGN} (gh falhou)`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#10618 fixer — develop-plan-motivo rotula a entrada de outro repo pela chave", () => {
  const issues = normalizeIssues({
    issues: {
      [`${DESIGN}#21`]: { status: "pulada", motivo: "inventado" },
      "21": { status: "deixado-para-o-300", exec_track_painel: "develop" },
      [`${DESIGN}#22`]: { status: "deixado-para-o-300", exec_track_painel: "bloqueada" },
    } as never,
  } as IssuesBearing<never>);

  it("InvalidMotivoEntry traz `ref` só pra outro repo; rótulo nunca é o #21 cru", () => {
    const invalid = findInvalidPuladaMotivos(issues);
    assert.deepEqual(invalid, [{ number: 21, ref: `${DESIGN}#21`, motivo: "inventado" }]);
    assert.equal(planEntryLabel(invalid[0]), `${DESIGN}#21`);
    assert.equal(planEntryLabel({ number: 42, motivo: null }), "#42");
    assert.equal(planEntryLabel({ number: Number.NaN }), "#?");
  });

  it("buraco do 300: números (API de sempre) e rótulos por chave", () => {
    assert.deepEqual(findDeixadoPara300Buraco(issues), [21, 22]);
    assert.deepEqual(findDeixadoPara300BuracoLabels(issues), ["#21", `${DESIGN}#22`]);
  });
});

describe("#10618 fixer — describeUnknownPlanEntry", () => {
  it("índice + campos crus", () => {
    assert.equal(describeUnknownPlanEntry({ number: 5, repo: 42 }, 3), "entrada [3] (repo=42, number=5)");
    assert.equal(describeUnknownPlanEntry({ ref: "lixo" }, 0), 'entrada [0] (ref="lixo")');
    assert.equal(describeUnknownPlanEntry({}, 1), "entrada [1] (sem ref/repo/number)");
  });
});

// ---------------------------------------------------------------------------
// CLIs com gh fake
// ---------------------------------------------------------------------------

interface GhRule {
  /** Substrings que precisam estar TODAS no argv juntado por espaço. */
  match: string[];
  /** Substrings que NÃO podem estar (ex.: `-R` pra regra do studio). */
  not?: string[];
  stdout?: unknown;
  status?: number;
}

const PRELOAD = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const sub = process.argv[1] ? path.basename(process.argv[1]) : '';",
  "if (sub === 'issue' || sub === 'pr' || sub === 'api') {",
  "  const args = [sub, ...process.argv.slice(2)];",
  "  fs.appendFileSync(process.env.GH_FAKE_LOG, JSON.stringify(args) + '\\n');",
  "  const joined = args.join(' ');",
  "  const rules = JSON.parse(fs.readFileSync(process.env.GH_FAKE_RULES, 'utf8'));",
  "  for (const r of rules) {",
  "    if (!r.match.every((m) => joined.includes(m))) continue;",
  "    if ((r.not || []).some((m) => joined.includes(m))) continue;",
  "    if (r.status) { process.stderr.write('falha fake'); process.exit(r.status); }",
  "    process.stdout.write(typeof r.stdout === 'string' ? r.stdout : JSON.stringify(r.stdout));",
  "    process.exit(0);",
  "  }",
  "  process.stderr.write('gh fake: sem resposta pra ' + joined);",
  "  process.exit(1);",
  "}",
].join("\n");

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) {
    try {
      // maxRetries: no Windows o gh.exe fake (cópia do node) às vezes ainda
      // segura o diretório — resíduo no tmp não é falha do teste.
      rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      console.warn(`[issue-key-10618-fatia3-cli.test] cleanup residual de ${r}: ${(e as Error).message}`);
    }
  }
  roots = [];
});

function sandbox(rules: GhRule[], issueRepos: string[] = [STUDIO, DESIGN]) {
  const root = mkdtempSync(join(tmpdir(), "fatia3-cli-"));
  roots.push(root);
  // Fixture de config no cwd/`--root` do subprocesso. Só vale pra quem lê a
  // allowlist pela raiz passada (`check-block-staleness`, `--root`); os gates
  // que usam `ISSUE_REPOS_CONFIG_ROOT` (#10990) leem o config do checkout.
  writeFileSync(join(root, "platform.config.json"), JSON.stringify({ issue_repos: issueRepos }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const gh = join(bin, process.platform === "win32" ? "gh.exe" : "gh");
  copyFileSync(process.execPath, gh);
  if (process.platform !== "win32") chmodSync(gh, 0o755);
  const preload = join(bin, "preload.cjs");
  writeFileSync(preload, PRELOAD);
  const rulesPath = join(root, "rules.json");
  writeFileSync(rulesPath, JSON.stringify(rules));
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  const env = {
    ...process.env,
    PATH: bin,
    Path: bin,
    NODE_OPTIONS: `--require ${preload}`,
    GH_FAKE_RULES: rulesPath,
    GH_FAKE_LOG: log,
  };
  const run = (script: string, plan: unknown) => {
    const planPath = join(root, "plan.json");
    writeFileSync(planPath, JSON.stringify(plan));
    return spawnSync(process.execPath, ["--import", TSX_LOADER, join(ROOT, "scripts", script), "--plan", planPath], {
      cwd: root,
      encoding: "utf8",
      env,
    });
  };
  const calls = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
  return { root, run, calls };
}

const hasRepoFlag = (c: string[], repo: string) => {
  const i = c.indexOf("-R");
  return i !== -1 && c[i + 1] === repo;
};

describe("#10618 fixer — CLI check-skipped-develop-track", () => {
  const issueApi = (repo: string, n: number, body: unknown): GhRule => ({
    match: ["api", `repos/${repo}/issues/${n}`],
    stdout: body,
  });

  it("plano só-studio: consulta repos/vjpixel/diaria-studio/issues/N, exit 0", () => {
    const { run, calls } = sandbox([issueApi(STUDIO, 9379, { labels: [{ name: "develop-track" }], body: "", state: "open" })]);
    const r = run("check-skipped-develop-track.ts", { issues: [{ number: 9379, status: "pulada", motivo: "guard-de-execucao" }] });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok — /m);
    assert.deepEqual(calls(), [["api", `repos/${STUDIO}/issues/9379`]]);
  });

  it("plano misto: design#21 consultada em repos/vjpixel/diaria-design/issues/21 e acusada como owner/repo#N", () => {
    const { run, calls } = sandbox([
      issueApi(DESIGN, 21, { labels: [], body: "", state: "open" }),
      issueApi(STUDIO, 21, { labels: [{ name: "develop-track" }], body: "", state: "open" }),
    ]);
    const r = run("check-skipped-develop-track.ts", {
      issues: {
        [`${DESIGN}#21`]: { status: "pulada", motivo: "guard-de-execucao" },
        "21": { status: "pulada", motivo: "guard-de-execucao" },
      },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /sem trilha Develop: vjpixel\/diaria-design#21$/m);
    const paths = calls().map((c) => c[1]).sort();
    assert.deepEqual(paths, [`repos/${DESIGN}/issues/21`, `repos/${STUDIO}/issues/21`]);
  });

  it("#9516 no CLI: bloqueada/agendada/fechada/windows não acusadas, duplicada consultada e acusada uma vez", () => {
    const { run, calls } = sandbox([
      issueApi(STUDIO, 4, { labels: [{ name: "external-blocker" }], body: "", state: "open" }),
      issueApi(STUDIO, 5, { labels: [], body: "", state: "closed" }),
      issueApi(STUDIO, 7, { labels: [], body: "<!-- aguardando-ate: 2099-01-01 -->", state: "open" }),
      issueApi(STUDIO, 8, { labels: [], body: "", state: "open" }),
      issueApi(STUDIO, 9, { labels: [{ name: "windows" }], body: "", state: "open" }),
    ]);
    const r = run("check-skipped-develop-track.ts", {
      issues: [4, 5, 7, 8, 9, 8].map((number) => ({ number, status: "pulada", motivo: "guard-de-execucao" })),
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /sem trilha Develop: #8$/m);
    assert.equal(calls().filter((c) => c[1] === `repos/${STUDIO}/issues/8`).length, 1);
  });

  it("repo fora de issue_repos e identidade desconhecida: exit 2, mensagem cita os três motivos e a entrada crua", () => {
    const { run, calls } = sandbox([]);
    const r = run("check-skipped-develop-track.ts", {
      issues: [
        { ref: "fork/diaria-design#3", status: "pulada", motivo: "guard-de-execucao" },
        { number: 5, repo: 42, status: "pulada", motivo: "guard-de-execucao" },
        { status: "pulada", motivo: "guard-de-execucao" }, // sem número nem ref: ignorada
      ],
    });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /fork\/diaria-design fora de issue_repos/);
    assert.match(r.stderr, /entrada \[1\] \(repo=42, number=5\): identidade desconhecida/);
    assert.match(r.stderr, /2 issue\(s\) não verificadas \(gh falhou, repo fora de issue_repos ou identidade desconhecida/);
    assert.deepEqual(calls(), [], "nenhum repo fora da allowlist é consultado");
  });
});

describe("#10618 fixer — CLI check-block-staleness (gh fake, sessões no tmp)", () => {
  const OLD = new Date(Date.now() - 7 * 3_600_000).toISOString();

  /** Sessão develop viva no `data/sessions/` do tmp com claim(s) envelhecida(s). */
  function seedClaim(root: string, refs: Record<string, string | null>) {
    const now = new Date().toISOString();
    registerSession(root, "develop", "sess-x", { tag: "host", startedAt: now });
    for (const ref of Object.keys(refs)) {
      if (ref.startsWith(`${DESIGN}#`)) {
        claimIssueCheckAndSet(root, "develop", "sess-x", { repo: DESIGN, number: Number(ref.split("#")[1]) }, "host", now);
      }
    }
    const dir = join(root, "data", "sessions");
    const file = readdirSync(dir).find((f) => f.includes("sess-x") && f.endsWith(".json") && !f.includes("safeBackup"))!;
    const rec = JSON.parse(readFileSync(join(dir, file), "utf8"));
    rec.claimed_foreign_issues = Object.keys(refs);
    rec.claimed_foreign_issues_at = Object.fromEntries(
      Object.entries(refs).filter((e): e is [string, string] => e[1] !== null),
    );
    writeFileSync(join(dir, file), JSON.stringify(rec));
  }

  it("design#21 (pr-em-voo) usa -R em issue view e pr view; claim design#30 usa -R no pr list --search; achados positivos", () => {
    const sb = sandbox([
      { match: ["issue", "view", "21", "-R", DESIGN], stdout: { labels: [], state: "OPEN" } },
      { match: ["pr", "view", "23", "-R", DESIGN], stdout: { state: "MERGED" } },
      { match: ["issue", "view", "21"], not: ["-R"], stdout: { labels: [], state: "OPEN" } },
      { match: ["pr", "view", "23"], not: ["-R"], stdout: { state: "OPEN" } },
      { match: ["issue", "view", "30", "-R", DESIGN], stdout: { state: "OPEN" } },
      { match: ["pr", "list", "-R", DESIGN, "--search", "#30"], stdout: [] },
    ]);
    seedClaim(sb.root, { [`${DESIGN}#30`]: OLD });
    const r = sb.run("check-block-staleness.ts", {
      issues: {
        [`${DESIGN}#21`]: { status: "pulada", motivo: "pr-em-voo", pr: 23 },
        "21": { status: "pulada", motivo: "pr-em-voo", pr: 23 },
      },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(
      r.stderr,
      /vjpixel\/diaria-design#21 \(motivo "pr-em-voo"\): vjpixel\/diaria-design PR #23 já está mergeado/,
    );
    assert.doesNotMatch(r.stderr, /^\s+#21 /m, "a studio#21 (PR #23 do studio aberto) não vira achado");
    assert.match(r.stderr, /vjpixel\/diaria-design#30 — claimed por develop-/);
    const c = sb.calls();
    assert.ok(c.some((x) => x[0] === "issue" && x[1] === "view" && x[2] === "21" && hasRepoFlag(x, DESIGN)));
    assert.ok(c.some((x) => x[0] === "pr" && x[1] === "view" && x[2] === "23" && hasRepoFlag(x, DESIGN)));
    assert.ok(c.some((x) => x[0] === "pr" && x[1] === "list" && x.includes("#30") && hasRepoFlag(x, DESIGN)));
  });

  it("'não sei' do gh, claim sem timestamp e claim fora da allowlist: listados por chave e 'ok PARCIAL — … exceto'", () => {
    const sb = sandbox([]); // nenhuma resposta: todo gh falha
    seedClaim(sb.root, { [`${DESIGN}#31`]: null, "fork/diaria-design#5": OLD });
    const r = sb.run("check-block-staleness.ts", {
      issues: { [`${DESIGN}#22`]: { status: "pulada", motivo: "bloqueio-execucao" } },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok PARCIAL — .*\(exceto 3 não verificáveis, listadas acima\)$/m);
    assert.match(r.stderr, /vjpixel\/diaria-design#22 — labels da issue/);
    assert.match(r.stderr, /vjpixel\/diaria-design#31 — claim sem timestamp/);
    assert.match(r.stderr, /fork\/diaria-design#5 — claim de repo fora de issue_repos/);
    assert.ok(!sb.calls().some((x) => x.includes("fork/diaria-design")), "repo fora da allowlist nunca é consultado");
  });

  it("aviso de identidade desconhecida nomeia índice e campos, e só pra entrada que o gate avaliaria", () => {
    const sb = sandbox([]);
    const r = sb.run("check-block-staleness.ts", {
      issues: [
        { number: 5, repo: 42, status: "pulada", motivo: "pr-em-voo", pr: 6 },
        { number: 7, repo: 42, status: "pulada", motivo: "ambigua" }, // o gate não avalia
      ],
    });
    assert.match(r.stderr, /1 entrada\(s\) FORA desta checagem.*entrada \[0\] \(repo=42, number=5\) \(identidade desconhecida\)/);
    assert.doesNotMatch(r.stderr, /entrada \[1\]/);
    assert.match(r.stdout, /^ok PARCIAL — .*exceto 1 entrada\(s\) fora da checagem/m);
  });
});

describe("#10618 fixer — CLI check-pr-terminal-state multi-repo", () => {
  const studioList = (prs: unknown[]): GhRule => ({ match: ["pr", "list"], not: ["-R"], stdout: prs });
  const designList = (prs: unknown[]): GhRule => ({ match: ["pr", "list", "-R", DESIGN], stdout: prs });

  it("PR #23 do design e PR #23 do studio: a divergência é atribuída ao repo certo", () => {
    const sb = sandbox([
      studioList([{ number: 23, headRefName: "develop/fix-21-studio", labels: [], body: "" }]),
      designList([{ number: 23, headRefName: "develop/fix-21-design", labels: [], body: "" }]),
    ]);
    const r = sb.run("check-pr-terminal-state.ts", {
      issues: {
        [`${DESIGN}#21`]: { status: "pendente", pr: 23 },
        "21": { status: "mergeada", pr: 23 },
      },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /vjpixel\/diaria-design PR #23 — issue\(s\) vjpixel\/diaria-design#21, status atual: pendente/);
    assert.doesNotMatch(r.stderr, /^\s+PR #23 /m, "o PR #23 do studio está accounted (mergeada)");
    assert.ok(sb.calls().some((c) => c[0] === "pr" && c[1] === "list" && hasRepoFlag(c, DESIGN)));
  });

  it("entrada do design SEM `pr` também faz o design ser consultado (PR não registrado vira candidato)", () => {
    const sb = sandbox([studioList([]), designList([{ number: 40, headRefName: "develop/fix-21-x", labels: [], body: "" }])]);
    const r = sb.run("check-pr-terminal-state.ts", { issues: { [`${DESIGN}#21`]: { status: "pulada" } } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /vjpixel\/diaria-design PR #40 — branch develop\/fix-21-x/);
    assert.match(r.stdout, /^ok — nenhuma divergência confirmada/m);
  });

  it("repo extra falhando: PR registrado lá fica NÃO avaliado (nunca 'fechado') e a linha final é 'ok PARCIAL'", () => {
    const sb = sandbox([studioList([])]); // sem regra pro -R → gh do design sai 1
    const r = sb.run("check-pr-terminal-state.ts", { issues: { [`${DESIGN}#21`]: { status: "pendente", pr: 23 } } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /PRs de vjpixel\/diaria-design NÃO avaliados — gh falhou/);
    assert.match(r.stderr, /num repo NÃO consultado — estado desconhecido \(não lido como fechado\)/);
    assert.match(r.stderr, /vjpixel\/diaria-design PR #23 — issue\(s\) vjpixel\/diaria-design#21/);
    assert.match(r.stdout, /^ok PARCIAL — .*NÃO avaliados: vjpixel\/diaria-design \(gh falhou/m);
    assert.doesNotMatch(r.stdout, /^ok — /m);
  });

  it("repo fora de issue_repos (allowlist da raiz do módulo, nunca do cwd — #10990): nunca consultado, ressalva na linha final", () => {
    // Fixture no cwd só com o studio. Desde o #10990 a allowlist sai da raiz
    // do módulo (`ISSUE_REPOS_CONFIG_ROOT`), não do cwd: a fixture NÃO pode
    // restringir (o design, que o config real permite, segue consultado) —
    // e o fork, fora do config real, nunca é consultado.
    const sb = sandbox([studioList([]), designList([])], [STUDIO]);
    const r = sb.run("check-pr-terminal-state.ts", {
      issues: {
        [`${DESIGN}#21`]: { status: "pendente", pr: 23 },
        "fork/diaria-design#3": { status: "pendente" },
      },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok PARCIAL — .*NÃO avaliados: .*fork\/diaria-design \(fora de issue_repos\)/m);
    assert.doesNotMatch(r.stdout, /vjpixel\/diaria-design \(/, "o design não fica de fora pela fixture do cwd");
    assert.ok(sb.calls().some((c) => hasRepoFlag(c, DESIGN)), "o design é consultado (allowlist do módulo)");
    assert.ok(!sb.calls().some((c) => c.includes("fork/diaria-design")), "o fork nunca é consultado");
  });

  it("identidade desconhecida com PR: aviso com índice e ressalva na linha final", () => {
    const sb = sandbox([studioList([])]);
    const r = sb.run("check-pr-terminal-state.ts", { issues: [{ number: 5, repo: 42, status: "pendente", pr: 9 }] });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /entrada \[0\] \(repo=42, number=5\) com identidade desconhecida/);
    assert.match(r.stdout, /^ok PARCIAL — .*1 entrada\(s\) de identidade desconhecida/m);
  });
});

describe("#10618 fixer — CLI check-state-changed-pending aplica o #10407 ao repo extra", () => {
  it("design#21 deixada pro 300 e re-roteada pra develop no design é acusada como owner/repo#N", () => {
    const sb = sandbox([
      { match: ["issue", "list"], not: ["-R"], stdout: [{ number: 21, labels: [], body: "" }] },
      { match: ["issue", "list", "-R", DESIGN], stdout: [{ number: 21, labels: [{ name: "develop-track" }], body: "" }] },
    ]);
    const r = sb.run("check-state-changed-pending.ts", {
      issues: {
        [`${DESIGN}#21`]: { status: "pulada", motivo: "deixado-para-o-300", exec_track_painel: "overnight" },
        "21": { status: "pulada", motivo: "deixado-para-o-300", exec_track_painel: "overnight" },
      },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /re-classificação \(#10407\).*vjpixel\/diaria-design#21 \(deixado-para-o-300, overnight → develop\)/);
    assert.doesNotMatch(r.stderr, /re-classificação.*[ :]#21 \(/, "a studio#21 (labels do studio, overnight) não é acusada");
  });

  it("repo não varrido entra em last_convergence_scan.repos_nao_varridos", () => {
    const sb = sandbox([{ match: ["issue", "list"], not: ["-R"], stdout: [] }]);
    const r = sb.run("check-state-changed-pending.ts", { goal: { target_set: [`${DESIGN}#21`] } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /exceto nos repos NÃO varridos/);
    const plan = JSON.parse(readFileSync(join(sb.root, "plan.json"), "utf8"));
    assert.equal(plan.goal.last_convergence_scan.repos_nao_varridos.length, 1);
    assert.match(plan.goal.last_convergence_scan.repos_nao_varridos[0], /^vjpixel\/diaria-design \(/);
  });
});
