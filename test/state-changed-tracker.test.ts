/**
 * test/state-changed-tracker.test.ts (#5476, convergência #5706)
 *
 * Cobertura de `scripts/lib/state-changed-tracker.ts`: funções puras
 * (add/remove idempotentes, leitura fail-open de `state_changed_issues`
 * ausente, veredito de checagem) e a orquestração I/O (`addPendingToPlan`/
 * `removePendingFromPlan`/`checkStateChangedPending`) contra fixtures de
 * `plan.json` em tmpdir.
 *
 * Desde #5706, também cobre a re-varredura de convergência fundida neste
 * módulo (`collectKnownIssueNumbers`/`findMissingConvergenceIssues`/
 * `checkConvergenceScan`/`recordConvergenceScan`) — sempre via as funções
 * PURAS (issues abertas passadas como parâmetro, nunca `gh` real) e via a
 * CLI só com `--skip-convergence` ou `PATH` quebrado, nunca dependendo de
 * rede (regra do dispatch: testes locais não chamam rede).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  readStateChangedIssues,
  addStateChangedIssue,
  removeStateChangedIssue,
  checkStateChangedIssues,
  addPendingToPlan,
  removePendingFromPlan,
  checkStateChangedPending,
  collectKnownIssueNumbers,
  findMissingConvergenceIssues,
  filterIssuesByRoundScope,
  checkConvergenceScan,
  recordConvergenceScan,
  type PlanWithStateChanged,
  type PlanWithGoal,
  type ConvergenceScanIssue,
} from "../scripts/lib/state-changed-tracker.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "scripts/check-state-changed-pending.ts");

let root: string | null = null;
afterEach(() => {
  if (root) {
    // `maxRetries`/`retryDelay`: cleanup do `gh` fake (cópia de `node.exe`,
    // ver `setupFakeGh`) esbarra em `EPERM` no Windows — AV/indexador
    // segura um handle no binário recém-executado por um tempo variável
    // depois do processo terminar (observado ao vivo: sobrevive a 5
    // retries de 100ms). `rmSync` só tenta de novo em EBUSY/EPERM/etc.
    // quando `maxRetries` > 0 (comportamento documentado). Falha residual
    // após os retries vira warning, não falha de teste — é resíduo de
    // tmpdir do SO, não um sintoma de bug no código sob teste.
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      console.warn(`[state-changed-tracker.test] cleanup residual de ${root}: ${(e as Error).message}`);
    }
    root = null;
  }
});

function writePlanFixture(plan: Record<string, unknown>): string {
  root = mkdtempSync(join(tmpdir(), "state-changed-tracker-"));
  const planPath = join(root, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf8");
  return planPath;
}

describe("readStateChangedIssues — leitura pura fail-open", () => {
  it("campo ausente vira []", () => {
    const plan: PlanWithStateChanged = {};
    assert.deepEqual(readStateChangedIssues(plan), []);
  });

  it("campo presente com números é lido normalmente", () => {
    const plan: PlanWithStateChanged = { state_changed_issues: [5480, 5481] };
    assert.deepEqual(readStateChangedIssues(plan), [5480, 5481]);
  });

  it("valores não-array ou entries não-numéricas são descartados sem lançar", () => {
    const planNotArray: PlanWithStateChanged = { state_changed_issues: "oops" };
    assert.deepEqual(readStateChangedIssues(planNotArray), []);

    const planMixed: PlanWithStateChanged = { state_changed_issues: [5480, "abc", null, 5481] };
    assert.deepEqual(readStateChangedIssues(planMixed), [5480, 5481]);
  });
});

describe("addStateChangedIssue — idempotente", () => {
  it("adiciona issue nova", () => {
    assert.deepEqual(addStateChangedIssue([5480], 5481), [5480, 5481]);
  });

  it("adicionar o mesmo número 2x não duplica", () => {
    const once = addStateChangedIssue([], 5480);
    const twice = addStateChangedIssue(once, 5480);
    assert.deepEqual(twice, [5480]);
  });

  it("não muta o array original", () => {
    const original = [5480];
    addStateChangedIssue(original, 5481);
    assert.deepEqual(original, [5480]);
  });
});

describe("removeStateChangedIssue — idempotente", () => {
  it("remove issue presente", () => {
    assert.deepEqual(removeStateChangedIssue([5480, 5481], 5480), [5481]);
  });

  it("remover issue ausente é no-op", () => {
    assert.deepEqual(removeStateChangedIssue([5480], 9999), [5480]);
  });

  it("remover de array vazio é no-op", () => {
    assert.deepEqual(removeStateChangedIssue([], 5480), []);
  });
});

describe("checkStateChangedIssues — veredito puro", () => {
  it("array vazio → ok", () => {
    assert.deepEqual(checkStateChangedIssues([]), { status: "ok" });
  });

  it("array não-vazio → pending com issues ordenadas", () => {
    assert.deepEqual(checkStateChangedIssues([5481, 5480]), {
      status: "pending",
      issues: [5480, 5481],
    });
  });
});

describe("orquestração I/O contra plan.json em tmpdir", () => {
  it("addPendingToPlan cria o campo quando ausente no plan.json legado", () => {
    const planPath = writePlanFixture({ started_at: "2026-08-16T22:46:16Z" });
    addPendingToPlan(planPath, 5480);
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.deepEqual(written.state_changed_issues, [5480]);
  });

  it("addPendingToPlan é idempotente (2x não duplica)", () => {
    const planPath = writePlanFixture({ state_changed_issues: [] });
    addPendingToPlan(planPath, 5480);
    addPendingToPlan(planPath, 5480);
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.deepEqual(written.state_changed_issues, [5480]);
  });

  it("removePendingFromPlan remove e é idempotente", () => {
    const planPath = writePlanFixture({ state_changed_issues: [5480, 5481] });
    removePendingFromPlan(planPath, 5480);
    removePendingFromPlan(planPath, 5480);
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.deepEqual(written.state_changed_issues, [5481]);
  });

  it("checkStateChangedPending: plan.json sem o campo → ok, exit implícito 0", () => {
    const planPath = writePlanFixture({ started_at: "2026-08-16T22:46:16Z" });
    assert.deepEqual(checkStateChangedPending(planPath), { status: "ok" });
  });

  it("checkStateChangedPending: plan.json com pendências → pending com lista", () => {
    const planPath = writePlanFixture({ state_changed_issues: [5480, 5474] });
    assert.deepEqual(checkStateChangedPending(planPath), {
      status: "pending",
      issues: [5474, 5480],
    });
  });

  it("round-trip add → check → remove → check", () => {
    const planPath = writePlanFixture({ state_changed_issues: [] });
    addPendingToPlan(planPath, 5480);
    assert.deepEqual(checkStateChangedPending(planPath), { status: "pending", issues: [5480] });
    removePendingFromPlan(planPath, 5480);
    assert.deepEqual(checkStateChangedPending(planPath), { status: "ok" });
  });
});

describe("CLI (scripts/check-state-changed-pending.ts)", () => {
  function run(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env },
    });
  }

  // `--skip-convergence` em todos os testes de modo padrão abaixo: a
  // re-varredura de convergência (#5706) chama `gh` de verdade no modo
  // padrão — testes locais nunca chamam rede, então isolamos com a flag de
  // escape (comportamento dela própria é coberto na sua describe própria).

  it("--plan sozinho sobre plan.json vazio → exit 0, 'ok'", () => {
    const planPath = writePlanFixture({ state_changed_issues: [] });
    const r = run(["--plan", planPath, "--skip-convergence"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ok — nenhuma pendência de re-triagem/);
  });

  it("--plan sozinho sobre plan.json com pendências → exit 1, lista as issues", () => {
    const planPath = writePlanFixture({ state_changed_issues: [5480, 5474] });
    const r = run(["--plan", planPath, "--skip-convergence"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /#5474/);
    assert.match(r.stderr, /#5480/);
  });

  it("--add-pending grava e --remove-pending resolve, refletindo em --plan", () => {
    const planPath = writePlanFixture({ state_changed_issues: [] });
    run(["--add-pending", "5480", "--plan", planPath]);
    assert.equal(run(["--plan", planPath, "--skip-convergence"]).status, 1);
    run(["--remove-pending", "5480", "--plan", planPath]);
    assert.equal(run(["--plan", planPath, "--skip-convergence"]).status, 0);
  });

  it("plan.json ausente → erro acionável (path citado) e exit 2, nunca stack trace cru", () => {
    root = mkdtempSync(join(tmpdir(), "state-changed-tracker-cli-"));
    const missing = join(root, "plan.json");
    const r = run(["--plan", missing]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /plan\.json não encontrado/);
    assert.match(r.stderr, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(r.stderr, /at readFileSync/);
  });

  it("sem --plan → uso + exit 2", () => {
    const r = run([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /uso: --plan/);
  });

  it("--skip-convergence: avisa em stderr, nunca chama gh, e o stdout de sucesso NÃO afirma que a varredura rodou", () => {
    const planPath = writePlanFixture({ state_changed_issues: [] });
    const r = run(["--plan", planPath, "--skip-convergence"]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /--skip-convergence/);
    assert.match(r.stderr, /pulando re-varredura de convergência/);
    // Achado do self-review (#5706): "ok" no stdout tem que ser honesto
    // sobre o que rodou — senão reintroduz a mesma classe de falso-"ok" que
    // esta issue existe pra fechar (coordenador lê "ok" achando que a
    // convergência foi checada quando ela foi pulada).
    assert.match(r.stdout, /re-varredura de convergência NÃO executada/);
    assert.doesNotMatch(r.stdout, /nenhuma issue nova fora da varredura/);
  });

  it("gh indisponível (PATH sem o binário) → fail-soft, sem trava, sem crash (#738), e stdout honesto sobre o que rodou", () => {
    const planPath = writePlanFixture({ state_changed_issues: [] });
    // PATH vazio garante que `gh` não é encontrado — sem depender de rede,
    // só do spawn falhando localmente (ENOENT), exatamente o cenário
    // "gh indisponível/offline" que a issue #5706 pede pra não travar.
    const r = spawnSync(process.execPath, ["--import", "tsx", CLI, "--plan", planPath], {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env, PATH: "", Path: "" },
    });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /gh indisponível/);
    assert.match(r.stdout, /re-varredura de convergência NÃO executada/);
    assert.doesNotMatch(r.stdout, /nenhuma issue nova fora da varredura/);
  });

  // Achado do fleet review (#5713, confiança alta, "provado por mutation
  // testing"): nenhum teste até aqui roda a CLI com um `gh` que devolva
  // dados de verdade — todos passam `--skip-convergence` ou exercitam só o
  // caminho "gh indisponível". Um reviewer chegou a reverter a condição de
  // exit pro bug original do #5706 e os 40 testes daquela época seguiram
  // verdes, provando o buraco.
  //
  // A tentativa anterior deste bloco (comentário removido) tentou um `gh`
  // fake via `.cmd`/`.bat` no PATH invocado com `spawnSync("gh", ...)` sem
  // `shell: true` (mesmo padrão da produção) — no Windows isso dá `ENOENT`
  // (confirmado ao vivo): sem `shell: true`, o `CreateProcess` do Win32 só
  // resolve extensão `.exe` implicitamente, nunca `.cmd`/`.bat` (que
  // dependem do `cmd.exe` pra interpretar). A saída adotada aqui: em vez de
  // um script de shell, o `gh` fake é uma CÓPIA do próprio binário `node`
  // (que O PRÓPRIO Win32 acha via a resolução implícita de `.exe`, e que no
  // POSIX é um executável de verdade também) — `NODE_OPTIONS=--require
  // {preload}` injeta um preload que lê a resposta fixture de variáveis de
  // ambiente, escreve no stdout e chama `process.exit` ANTES do `node`
  // tentar resolver `argv[1]` ("issue", vindo de `gh issue list ...`) como
  // um módulo — que é o que causaria o crash sem o preload. Funciona nos
  // dois SO sem `shell: true` em lugar nenhum, espelhando fielmente o
  // `spawnSync("gh", [...])` sem-shell da produção.
  function setupFakeGh(ghResponse: {
    stdout?: string;
    exitCode?: number;
  }): { planPath: string; env: NodeJS.ProcessEnv } {
    root = mkdtempSync(join(tmpdir(), "state-changed-tracker-gh-"));
    const planPath = join(root, "plan.json");
    writeFileSync(planPath, JSON.stringify({ goal: { target_set: [] } }, null, 2), "utf8");

    const ghDir = join(root, "bin");
    mkdirSync(ghDir);
    const ghBinName = process.platform === "win32" ? "gh.exe" : "gh";
    const ghBinPath = join(ghDir, ghBinName);
    copyFileSync(process.execPath, ghBinPath);
    if (process.platform !== "win32") chmodSync(ghBinPath, 0o755);

    // `NODE_OPTIONS` é herdado por QUALQUER processo node no ambiente —
    // inclusive o processo da CLI-sob-teste em si (spawnado logo abaixo com
    // esse mesmo `env`), não só o `gh` fake. O preload por isso só age
    // quando reconhece a assinatura de invocação do `gh issue list ...`:
    // "issue" é o 1º argumento passado pela produção, e o `node`
    // copiado-como-`gh` o trata como o "script" a rodar (já que não temos
    // como injetar argv customizado) — só que ele CHEGA em `process.argv[1]`
    // já resolvido pro path absoluto (`{cwd}/issue`, confirmado ao vivo),
    // não a string crua "issue"; daí o `basename` abaixo em vez de
    // comparação direta. Em qualquer outra invocação (a CLI real,
    // `--import tsx {CLI}`), o preload não faz nada e a carga normal do
    // módulo prossegue.
    const preloadPath = join(ghDir, "gh-fake-preload.cjs");
    writeFileSync(
      preloadPath,
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "if (process.argv[1] && path.basename(process.argv[1]) === 'issue') {",
        "  const respPath = process.env.GH_FAKE_RESPONSE_FILE;",
        "  if (respPath) process.stdout.write(fs.readFileSync(respPath, 'utf8'));",
        "  process.exit(Number(process.env.GH_FAKE_EXIT_CODE || 0));",
        "}",
      ].join("\n"),
      "utf8",
    );
    const respPath = join(ghDir, "gh-fake-response.json");
    writeFileSync(respPath, ghResponse.stdout ?? "[]", "utf8");

    return {
      planPath,
      env: {
        ...process.env,
        PATH: ghDir,
        Path: ghDir,
        NODE_OPTIONS: `--require ${preloadPath}`,
        GH_FAKE_RESPONSE_FILE: respPath,
        GH_FAKE_EXIT_CODE: String(ghResponse.exitCode ?? 0),
      },
    };
  }

  it("gh real (fake) acha issue nova → exit 1 com a issue nomeada na saída", () => {
    const { planPath, env } = setupFakeGh({
      stdout: JSON.stringify([{ number: 555, labels: [{ name: "bug" }], body: null }]),
    });
    const r = spawnSync(process.execPath, ["--import", "tsx", CLI, "--plan", planPath], {
      encoding: "utf8",
      cwd: ROOT,
      env,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /re-varredura de convergência/);
    assert.match(r.stderr, /#555/);
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.equal(written.goal.last_convergence_scan.novas_encontradas, 1);
  });

  it("gh real (fake) sem novidade → exit 0, goal.last_convergence_scan: 0", () => {
    const { planPath, env } = setupFakeGh({ stdout: "[]" });
    const r = spawnSync(process.execPath, ["--import", "tsx", CLI, "--plan", planPath], {
      encoding: "utf8",
      cwd: ROOT,
      env,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ok — nenhuma pendência de re-triagem, nenhuma issue nova fora da varredura/);
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.equal(written.goal.last_convergence_scan.novas_encontradas, 0);
  });

  // Regressão específica do Achado 1 do #5713: com `gh` indisponível, o
  // stdout de sucesso NÃO pode conter a afirmação de que a varredura
  // rodou — já coberto acima ("gh indisponível ... PATH sem o binário"),
  // repetido aqui só como ponte de leitura entre os dois blocos de teste
  // (fake-gh de sucesso vs PATH quebrado) pra deixar claro que os três
  // vereditos (ok/missing/não-avaliado) têm cobertura ponta-a-ponta via CLI
  // real, não só via as funções puras.
});

describe("collectKnownIssueNumbers — issues já conhecidas pelo plano", () => {
  it("plano sem goal/issues → conjunto vazio", () => {
    const plan: PlanWithGoal = {};
    assert.deepEqual(collectKnownIssueNumbers(plan), new Set());
  });

  it("une goal.target_set + todos os tiers + issues[] top-level (shape array — overnight)", () => {
    const plan: PlanWithGoal = {
      goal: {
        target_set: [100, 101],
        tiers: { "1a": [100], "1b": [], "2": [101, 102], "3": [] },
      },
      issues: [{ number: 200 }, { number: 201 }],
    };
    assert.deepEqual(collectKnownIssueNumbers(plan), new Set([100, 101, 102, 200, 201]));
  });

  // #5706 self-review: /diaria-develop grava `issues` como DICT chaveado por
  // número (`{ "4800": {...} }`, ver scripts/lib/plan-issues-normalize.ts
  // #4817/#4860), não array — é a fonte MAIS crítica de cobertura, porque em
  // `policy: "table_only"` é a ÚNICA coisa que sobra em `known` (target_set/
  // tiers ficam vazios a sessão inteira nessa política). Sem passar por
  // `normalizeIssues`, este dict virava `known` vazio e toda issue aberta
  // seria reportada como "nova" — falso positivo permanente.
  it("issues como dict chaveado por número (shape develop) também é reconhecido", () => {
    const plan: PlanWithGoal = {
      goal: { target_set: [] },
      issues: { "300": { onda: "1a" }, "301": { number: 301, onda: "2" } },
    };
    assert.deepEqual(collectKnownIssueNumbers(plan), new Set([300, 301]));
  });

  it("entries não-numéricas/malformadas são ignoradas sem lançar", () => {
    const plan: PlanWithGoal = {
      goal: { target_set: [100, "abc", null], tiers: "not-an-object" as unknown as never },
      issues: "also-not-an-array",
    };
    assert.deepEqual(collectKnownIssueNumbers(plan), new Set([100]));
  });
});

describe("findMissingConvergenceIssues — só issue nova E classificável overnight/develop", () => {
  it("(a) todas as issues abertas já estão em known → nenhuma faltando", () => {
    const known = new Set([100, 101]);
    const openIssues: ConvergenceScanIssue[] = [
      { number: 100, labels: [] },
      { number: 101, labels: ["bug"] },
    ];
    assert.deepEqual(findMissingConvergenceIssues(openIssues, known, new Date()), []);
  });

  it("(b) issue nova sem label de exclusão → aparece na lista (classifica overnight)", () => {
    const known = new Set([100]);
    const openIssues: ConvergenceScanIssue[] = [
      { number: 100, labels: [] },
      { number: 555, labels: ["bug"] },
    ];
    assert.deepEqual(findMissingConvergenceIssues(openIssues, known, new Date()), [555]);
  });

  it("(b) issue nova classificada 'develop' (label windows) também aparece", () => {
    const known = new Set<number>();
    const openIssues: ConvergenceScanIssue[] = [{ number: 777, labels: ["windows"] }];
    assert.deepEqual(findMissingConvergenceIssues(openIssues, known, new Date()), [777]);
  });

  it("(c) issue nova classificada 'agendada' (marcador de data futura) NÃO é ruído", () => {
    const known = new Set<number>();
    const now = new Date("2026-08-19T00:00:00Z");
    const openIssues: ConvergenceScanIssue[] = [
      { number: 888, labels: [], body: "<!-- aguardando-ate: 2026-09-01 -->" },
    ];
    assert.deepEqual(findMissingConvergenceIssues(openIssues, known, now), []);
  });

  it("(c) issue nova classificada 'fora-de-rodada' (on-hold) NÃO é ruído", () => {
    const known = new Set<number>();
    const openIssues: ConvergenceScanIssue[] = [{ number: 999, labels: ["on-hold"] }];
    assert.deepEqual(findMissingConvergenceIssues(openIssues, known, new Date()), []);
  });

  it("(c) issue nova classificada 'bloqueada' (external-blocker) NÃO é ruído", () => {
    const known = new Set<number>();
    const openIssues: ConvergenceScanIssue[] = [
      { number: 1000, labels: ["external-blocker"] },
    ];
    assert.deepEqual(findMissingConvergenceIssues(openIssues, known, new Date()), []);
  });

  it("resultado vem ordenado numericamente", () => {
    const known = new Set<number>();
    const openIssues: ConvergenceScanIssue[] = [
      { number: 300, labels: [] },
      { number: 100, labels: [] },
      { number: 200, labels: [] },
    ];
    assert.deepEqual(findMissingConvergenceIssues(openIssues, known, new Date()), [100, 200, 300]);
  });
});

describe("filterIssuesByRoundScope — filtro --bugs/--priority", () => {
  it("bugs_only ausente e priority_filter ausente → passa tudo", () => {
    const plan: PlanWithGoal = {};
    const openIssues: ConvergenceScanIssue[] = [{ number: 1, labels: ["enhancement"] }];
    assert.deepEqual(filterIssuesByRoundScope(openIssues, plan), openIssues);
  });

  it("bugs_only: true remove issue sem label bug", () => {
    const plan: PlanWithGoal = { bugs_only: true };
    const openIssues: ConvergenceScanIssue[] = [
      { number: 1, labels: ["enhancement"] },
      { number: 2, labels: ["bug"] },
    ];
    assert.deepEqual(filterIssuesByRoundScope(openIssues, plan), [{ number: 2, labels: ["bug"] }]);
  });

  it("priority_filter shape errado (não-array) é ignorado, fail-open", () => {
    const plan: PlanWithGoal = { priority_filter: "P0" };
    const openIssues: ConvergenceScanIssue[] = [{ number: 1, labels: [] }];
    assert.deepEqual(filterIssuesByRoundScope(openIssues, plan), openIssues);
  });
});

describe("checkConvergenceScan — veredito puro combinando os dois", () => {
  it("(a) target_set cobre todas as abertas → ok, novas_encontradas: 0", () => {
    const plan: PlanWithGoal = { goal: { target_set: [100, 101] } };
    const openIssues: ConvergenceScanIssue[] = [
      { number: 100, labels: [] },
      { number: 101, labels: [] },
    ];
    assert.deepEqual(checkConvergenceScan(plan, openIssues), { status: "ok", novas_encontradas: 0 });
  });

  it("(b) issue aberta ausente do plano e não-excluída → missing com a issue", () => {
    const plan: PlanWithGoal = { goal: { target_set: [100] } };
    const openIssues: ConvergenceScanIssue[] = [
      { number: 100, labels: [] },
      { number: 555, labels: ["bug"] },
    ];
    assert.deepEqual(checkConvergenceScan(plan, openIssues), {
      status: "missing",
      issues: [555],
      novas_encontradas: 1,
    });
  });

  it("(c) issue ausente mas classificada agendada/fora-de-rodada → ok", () => {
    const plan: PlanWithGoal = { goal: { target_set: [] } };
    const now = new Date("2026-08-19T00:00:00Z");
    const openIssues: ConvergenceScanIssue[] = [
      { number: 888, labels: [], body: "<!-- aguardando-ate: 2026-09-01 -->" },
      { number: 999, labels: ["wontfix"] },
    ];
    assert.deepEqual(checkConvergenceScan(plan, openIssues, now), {
      status: "ok",
      novas_encontradas: 0,
    });
  });

  // Achado do fleet review (#5713): rodada --bugs/--priority restringe o
  // conjunto-alvo por DESENHO — issue elegível fora do filtro nunca entra em
  // target_set/tiers/issues[], e sem filtrar o scan pelo mesmo critério ela
  // vira ruído permanente ("issue nova") em toda rodada filtrada.
  it("--bugs (bugs_only: true): issue enhancement fora do target_set NÃO é ruído", () => {
    const plan: PlanWithGoal = { goal: { target_set: [] }, bugs_only: true };
    const openIssues: ConvergenceScanIssue[] = [
      { number: 700, labels: ["enhancement"] },
      { number: 701, labels: ["bug"] },
    ];
    assert.deepEqual(checkConvergenceScan(plan, openIssues), {
      status: "missing",
      issues: [701],
      novas_encontradas: 1,
    });
  });

  it("--priority P0,P1 (priority_filter): issue P2 fora do target_set NÃO é ruído", () => {
    const plan: PlanWithGoal = {
      goal: { target_set: [] },
      priority_filter: ["P0", "P1"],
    };
    const openIssues: ConvergenceScanIssue[] = [
      { number: 800, labels: ["P2"] },
      { number: 801, labels: ["P0"] },
    ];
    assert.deepEqual(checkConvergenceScan(plan, openIssues), {
      status: "missing",
      issues: [801],
      novas_encontradas: 1,
    });
  });

  it("--bugs --priority combinados: só issue que bate os dois critérios conta", () => {
    const plan: PlanWithGoal = {
      goal: { target_set: [] },
      bugs_only: true,
      priority_filter: ["P0"],
    };
    const openIssues: ConvergenceScanIssue[] = [
      { number: 900, labels: ["bug", "P1"] }, // bug mas prioridade errada
      { number: 901, labels: ["enhancement", "P0"] }, // prioridade certa mas não é bug
      { number: 902, labels: ["bug", "P0"] }, // bate os dois
    ];
    assert.deepEqual(checkConvergenceScan(plan, openIssues), {
      status: "missing",
      issues: [902],
      novas_encontradas: 1,
    });
  });

  it("sem bugs_only/priority_filter (rodada sem filtro): comportamento inalterado", () => {
    const plan: PlanWithGoal = { goal: { target_set: [] } };
    const openIssues: ConvergenceScanIssue[] = [{ number: 950, labels: ["enhancement"] }];
    assert.deepEqual(checkConvergenceScan(plan, openIssues), {
      status: "missing",
      issues: [950],
      novas_encontradas: 1,
    });
  });
});

describe("recordConvergenceScan — I/O grava goal.last_convergence_scan", () => {
  it("grava at + novas_encontradas no plan.json", () => {
    const planPath = writePlanFixture({ goal: { target_set: [] } });
    recordConvergenceScan(planPath, 2, "2026-08-19T10:00:00.000Z");
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.deepEqual(written.goal.last_convergence_scan, {
      at: "2026-08-19T10:00:00.000Z",
      novas_encontradas: 2,
    });
  });

  it("cria goal quando ausente (plano legado) em vez de lançar", () => {
    const planPath = writePlanFixture({ started_at: "2026-08-16T22:46:16Z" });
    recordConvergenceScan(planPath, 0, "2026-08-19T10:00:00.000Z");
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.deepEqual(written.goal.last_convergence_scan, {
      at: "2026-08-19T10:00:00.000Z",
      novas_encontradas: 0,
    });
  });

  it("preserva o resto de goal já existente (target_set, tiers, etc.)", () => {
    const planPath = writePlanFixture({ goal: { target_set: [100], reached: false } });
    recordConvergenceScan(planPath, 1, "2026-08-19T10:00:00.000Z");
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.deepEqual(written.goal.target_set, [100]);
    assert.equal(written.goal.reached, false);
    assert.deepEqual(written.goal.last_convergence_scan, {
      at: "2026-08-19T10:00:00.000Z",
      novas_encontradas: 1,
    });
  });
});
