/**
 * test/studio-issues.test.ts (#3562) — cobertura de
 * scripts/studio-ui/studio-issues.ts: derivação pura (prioridade, trilha),
 * parsing do JSON cru do `gh`, e a camada de cache/fail-soft de
 * `fetchTriageData` com um runner de `gh` mockado (sem invocar o binário
 * real nem rede).
 *
 * Extensão (#3562, entrega 2): `files`/`dispatchTrack` em `parseIssues`
 * (derivados via `studio-waves.ts`) e `ciState`/`reviewDecision` em
 * `parsePrs` (via `summarizeChecks`). A cobertura das funções puras de
 * classificação/extração em si (regex de path, heurística
 * elegível/bloqueada/ambígua) mora em `test/studio-waves.test.ts` — aqui só
 * cobrimos a INTEGRAÇÃO (parseIssues/parsePrs chamando essas funções
 * corretamente) + `summarizeChecks`, que é local deste arquivo.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  derivePriority,
  deriveTrackFromBranch,
  parseIssues,
  parsePrs,
  summarizeChecks,
  fetchTriageData,
  clearTriageCache,
  defaultGhRun,
  type GhRunFn,
  type GhIssueRaw,
  type GhPrRaw,
} from "../scripts/studio-ui/studio-issues.ts";

describe("derivePriority (#3562)", () => {
  it("acha a primeira label P0-P3", () => {
    assert.equal(derivePriority(["bug", "P2", "diaria"]), "P2");
  });
  it("null quando nenhuma label bate", () => {
    assert.equal(derivePriority(["bug", "enhancement"]), null);
  });
  it("não confunde 'P10' ou 'p2' minúsculo com prioridade válida", () => {
    assert.equal(derivePriority(["P10", "p2"]), null);
  });
});

describe("deriveTrackFromBranch (#3562)", () => {
  it("overnight/fix-NNNN-slug -> overnight", () => {
    assert.equal(deriveTrackFromBranch("overnight/fix-3562-studio-issues-cockpit"), "overnight");
  });
  it("overnight/batch-slug -> overnight", () => {
    assert.equal(deriveTrackFromBranch("overnight/batch-cleanup"), "overnight");
  });
  it("develop/fix-NNNN -> develop", () => {
    assert.equal(deriveTrackFromBranch("develop/fix-1234"), "develop");
  });
  it("develop/blast-NNNN -> develop", () => {
    assert.equal(deriveTrackFromBranch("develop/blast-1234"), "develop");
  });
  it("branch manual do editor -> other", () => {
    assert.equal(deriveTrackFromBranch("editor/hotfix-urgente"), "other");
  });
  it("undefined/null/vazio -> other, sem lançar", () => {
    assert.equal(deriveTrackFromBranch(undefined), "other");
    assert.equal(deriveTrackFromBranch(null), "other");
    assert.equal(deriveTrackFromBranch(""), "other");
  });
});

describe("parseIssues (#3562)", () => {
  it("normaliza labels + deriva prioridade", () => {
    const raw: GhIssueRaw[] = [
      {
        number: 3562,
        title: "Cockpit de issues",
        url: "https://github.com/x/y/issues/3562",
        state: "OPEN",
        labels: [{ name: "P1" }, { name: "enhancement" }],
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-15T00:00:00Z",
      },
    ];
    const [issue] = parseIssues(raw);
    assert.equal(issue.number, 3562);
    assert.deepEqual(issue.labels, ["P1", "enhancement"]);
    assert.equal(issue.priority, "P1");
    assert.equal(issue.createdAt, "2026-07-01T00:00:00Z");
  });

  it("labels ausentes/malformadas viram array vazio, sem lançar", () => {
    const raw = [
      { number: 1, title: "sem labels", url: "u", state: "OPEN" },
    ] as GhIssueRaw[];
    const [issue] = parseIssues(raw);
    assert.deepEqual(issue.labels, []);
    assert.equal(issue.priority, null);
    assert.equal(issue.createdAt, null);
  });
});

describe("parsePrs (#3562)", () => {
  it("deriva track do headRefName + prioridade das labels", () => {
    const raw: GhPrRaw[] = [
      {
        number: 100,
        title: "fix overnight",
        url: "u",
        state: "OPEN",
        isDraft: false,
        headRefName: "overnight/fix-99-slug",
        labels: [{ name: "P0" }],
      },
      {
        number: 101,
        title: "fix develop",
        url: "u2",
        state: "OPEN",
        isDraft: true,
        headRefName: "develop/fix-1234",
        labels: [],
      },
    ];
    const [pr1, pr2] = parsePrs(raw);
    assert.equal(pr1.track, "overnight");
    assert.equal(pr1.priority, "P0");
    assert.equal(pr2.track, "develop");
    assert.equal(pr2.isDraft, true);
    assert.equal(pr2.priority, null);
  });
});

describe("parseIssues — files + dispatchTrack (#3562, entrega 2)", () => {
  it("deriva files do corpo e dispatchTrack='elegivel' sem label de bloqueio", () => {
    const raw: GhIssueRaw[] = [
      {
        number: 1,
        title: "Fix em scripts/studio-ui/server.ts",
        url: "u",
        state: "OPEN",
        labels: [{ name: "bug" }],
        body: "Toca `context/overnight-dispatch-rules.md` também.",
      },
    ];
    const [issue] = parseIssues(raw);
    assert.deepEqual(issue.files, ["context/overnight-dispatch-rules.md", "scripts/studio-ui/server.ts"]);
    assert.equal(issue.dispatchTrack, "elegivel");
  });

  it("label external-blocker -> dispatchTrack='bloqueada'", () => {
    const raw: GhIssueRaw[] = [
      { number: 2, title: "t", url: "u", state: "OPEN", labels: [{ name: "external-blocker" }], body: "" },
    ];
    const [issue] = parseIssues(raw);
    assert.equal(issue.dispatchTrack, "bloqueada");
  });

  it("corpo sem label de bloqueio mas com marcador de decisão -> 'ambigua'", () => {
    const raw: GhIssueRaw[] = [
      { number: 3, title: "t", url: "u", state: "OPEN", labels: [], body: "precisamos decidir entre X e Y" },
    ];
    const [issue] = parseIssues(raw);
    assert.equal(issue.dispatchTrack, "ambigua");
  });

  it("body ausente -> files vazio, sem lançar", () => {
    const raw = [{ number: 4, title: "sem corpo", url: "u", state: "OPEN" }] as GhIssueRaw[];
    const [issue] = parseIssues(raw);
    assert.deepEqual(issue.files, []);
    assert.equal(issue.dispatchTrack, "elegivel");
  });
});

describe("summarizeChecks (#3562, entrega 2)", () => {
  it("array vazio ou ausente -> 'none'", () => {
    assert.equal(summarizeChecks([]), "none");
    assert.equal(summarizeChecks(undefined), "none");
    assert.equal(summarizeChecks(null), "none");
  });

  it("todos os checks concluídos com sucesso -> 'green'", () => {
    assert.equal(
      summarizeChecks([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { state: "SUCCESS" },
      ]),
      "green",
    );
  });

  it("qualquer check com falha -> 'red', mesmo com outros passando", () => {
    assert.equal(
      summarizeChecks([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "FAILURE" },
      ]),
      "red",
    );
    assert.equal(summarizeChecks([{ state: "ERROR" }]), "red");
  });

  it("check ainda rodando (sem falha) -> 'pending'", () => {
    assert.equal(summarizeChecks([{ status: "IN_PROGRESS", conclusion: null }]), "pending");
    assert.equal(summarizeChecks([{ state: "PENDING" }]), "pending");
  });

  it("shape desconhecido/malformado conta como 'pending', nunca 'green' silencioso", () => {
    assert.equal(summarizeChecks([{}]), "pending");
    assert.equal(summarizeChecks([null]), "pending");
  });

  it("falha vence pendência quando ambos presentes", () => {
    assert.equal(summarizeChecks([{ status: "IN_PROGRESS" }, { conclusion: "FAILURE", status: "COMPLETED" }]), "red");
  });
});

describe("parsePrs — ciState + reviewDecision (#3562, entrega 2)", () => {
  it("deriva ciState de statusCheckRollup e repassa reviewDecision", () => {
    const raw: GhPrRaw[] = [
      {
        number: 5,
        title: "t",
        url: "u",
        state: "OPEN",
        isDraft: false,
        headRefName: "develop/fix-5",
        labels: [],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        reviewDecision: "APPROVED",
      },
    ];
    const [pr] = parsePrs(raw);
    assert.equal(pr.ciState, "green");
    assert.equal(pr.reviewDecision, "APPROVED");
  });

  it("statusCheckRollup ausente -> ciState='none', reviewDecision null", () => {
    const raw: GhPrRaw[] = [
      { number: 6, title: "t", url: "u", state: "OPEN", isDraft: false, headRefName: "x", labels: [] },
    ];
    const [pr] = parsePrs(raw);
    assert.equal(pr.ciState, "none");
    assert.equal(pr.reviewDecision, null);
  });
});

describe("fetchTriageData (#3562)", () => {
  beforeEach(() => {
    clearTriageCache();
  });

  function mockRun(issues: unknown[], prs: unknown[], status = 0): GhRunFn {
    return (args: string[]) => {
      if (args[0] === "issue") {
        return { status, stdout: JSON.stringify(issues), stderr: "" };
      }
      return { status, stdout: JSON.stringify(prs), stderr: "" };
    };
  }

  it("busca issues + PRs via o runner injetado e monta o snapshot", () => {
    const run = mockRun(
      [{ number: 1, title: "a", url: "u", state: "OPEN", labels: [] }],
      [{ number: 2, title: "b", url: "u2", state: "OPEN", isDraft: false, headRefName: "overnight/fix-1-x", labels: [] }],
    );
    const data = fetchTriageData("/tmp/root-a", { run, now: () => 1000 });
    assert.equal(data.error, null);
    assert.equal(data.cached, false);
    assert.equal(data.issues.length, 1);
    assert.equal(data.prs.length, 1);
    assert.equal(data.prs[0].track, "overnight");
  });

  it("dentro do TTL, uma segunda chamada serve do cache sem invocar o runner de novo", () => {
    let calls = 0;
    const run: GhRunFn = (args) => {
      calls++;
      return { status: 0, stdout: args[0] === "issue" ? "[]" : "[]", stderr: "" };
    };
    let nowMs = 1000;
    fetchTriageData("/tmp/root-b", { run, cacheTtlMs: 60_000, now: () => nowMs });
    const callsAfterFirst = calls;
    nowMs += 1000; // ainda dentro do TTL
    const second = fetchTriageData("/tmp/root-b", { run, cacheTtlMs: 60_000, now: () => nowMs });
    assert.equal(calls, callsAfterFirst); // não chamou o runner de novo
    assert.equal(second.cached, true);
  });

  it("após o TTL expirar, refaz o fetch", () => {
    let calls = 0;
    const run: GhRunFn = () => {
      calls++;
      return { status: 0, stdout: "[]", stderr: "" };
    };
    let nowMs = 1000;
    fetchTriageData("/tmp/root-c", { run, cacheTtlMs: 1000, now: () => nowMs });
    const callsAfterFirst = calls;
    nowMs += 2000; // passou do TTL
    fetchTriageData("/tmp/root-c", { run, cacheTtlMs: 1000, now: () => nowMs });
    assert.ok(calls > callsAfterFirst);
  });

  it("gh falhando (status != 0) sem cache anterior: arrays vazios + error preenchido, nunca lança", () => {
    const run: GhRunFn = () => ({ status: 1, stdout: "", stderr: "rate limit exceeded" });
    const data = fetchTriageData("/tmp/root-d", { run, now: () => 1000 });
    assert.deepEqual(data.issues, []);
    assert.deepEqual(data.prs, []);
    assert.match(data.error ?? "", /rate limit exceeded/);
    assert.equal(data.cached, false);
  });

  it("gh falhando DEPOIS de um fetch bom: serve o cache stale com error preenchido", () => {
    let shouldFail = false;
    const run: GhRunFn = (args) => {
      if (shouldFail) return { status: 1, stdout: "", stderr: "boom" };
      return { status: 0, stdout: args[0] === "issue" ? '[{"number":1,"title":"x","url":"u","state":"OPEN"}]' : "[]", stderr: "" };
    };
    let nowMs = 1000;
    const first = fetchTriageData("/tmp/root-e", { run, cacheTtlMs: 500, now: () => nowMs });
    assert.equal(first.issues.length, 1);

    shouldFail = true;
    nowMs += 1000; // expira o cache
    const second = fetchTriageData("/tmp/root-e", { run, cacheTtlMs: 500, now: () => nowMs });
    assert.equal(second.issues.length, 1); // stale, mas ainda presente
    assert.equal(second.cached, true);
    assert.match(second.error ?? "", /boom/);
  });

  it("stdout que não é JSON válido vira erro tratado, nunca lança", () => {
    const run: GhRunFn = () => ({ status: 0, stdout: "não é json", stderr: "" });
    assert.doesNotThrow(() => fetchTriageData("/tmp/root-f", { run, now: () => 1000 }));
    const data = fetchTriageData("/tmp/root-g", { run, now: () => 1000 });
    assert.ok(data.error);
  });

  it("forceRefresh ignora o cache mesmo dentro do TTL", () => {
    let calls = 0;
    const run: GhRunFn = () => {
      calls++;
      return { status: 0, stdout: "[]", stderr: "" };
    };
    fetchTriageData("/tmp/root-h", { run, cacheTtlMs: 60_000, now: () => 1000 });
    const callsAfterFirst = calls;
    fetchTriageData("/tmp/root-h", { run, cacheTtlMs: 60_000, now: () => 1000, forceRefresh: true });
    assert.ok(calls > callsAfterFirst);
  });
});

describe("defaultGhRun timeout (#3783 — regressão)", () => {
  it("mata um processo pendurado dentro do timeout dado, em vez de bloquear indefinidamente (mesmo padrão do #3773 pra spawnGhSync)", () => {
    // Regressão do bug real: `defaultGhRun` chamava `spawnSync("gh", ...)` sem
    // `timeout` — exatamente o gap que o #3773 já tinha corrigido no módulo
    // irmão (`studio-wave-fire.ts`), nunca reusado aqui até o #3783. Mais
    // severo aqui: `defaultGhRun` alimenta `fetchTriageData`, chamada por
    // `GET /api/issues`/`GET /api/waves` — rotas de uso normal do Studio, não
    // gateadas por env var. Simulamos com um processo Node genuíno que dorme
    // 60s — MUITO mais que o `timeoutMs` de 300ms dado — e provamos que
    // `defaultGhRun` retorna rápido em vez de esperar os 60s completos.
    // `timeoutMs`/`bin` paramétricos existem SÓ pra este teste (produção
    // sempre usa `"gh"` + `GH_SPAWN_TIMEOUT_MS`, ver doc-comment de
    // `defaultGhRun`).
    const start = Date.now();
    const result = defaultGhRun(
      ["-e", "setTimeout(() => {}, 60000)"],
      process.cwd(),
      300, // timeoutMs bem menor que os 60s do processo pendurado
      process.execPath, // "node" real — não precisa de `gh` instalado
    );
    const elapsedMs = Date.now() - start;

    assert.ok(elapsedMs < 10_000, `defaultGhRun não deveria esperar perto dos 60s do processo pendurado (levou ${elapsedMs}ms)`);
    // `spawnSync` mata o processo via sinal quando estoura o timeout —
    // `status` vem `null`, o mesmo shape que `runGhJson` já trata como falha
    // (`status !== 0`), então este cenário nunca vira sucesso silencioso.
    assert.equal(result.status, null, "processo morto por timeout reporta status null, não 0");
  });
});
