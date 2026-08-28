/**
 * test/studio-issues.test.ts (#3562) — cobertura de
 * scripts/studio-ui/studio-issues.ts: derivação pura (prioridade, trilha),
 * parsing do JSON cru do `gh`, e a camada de cache/fail-soft de
 * `fetchTriageData` com um runner de `gh` mockado (sem invocar o binário
 * real nem rede).
 *
 * Extensão (#3562, entrega 2): `files`/`dispatchTrack` em `parseIssues` e
 * `ciState`/`reviewDecision` em `parsePrs` (via `summarizeChecks`).
 *
 * #4004: `extractFilePaths`/`classifyDispatchTrack` (e a cobertura de
 * `test/studio-waves.test.ts`, que testava as duas) foram relocadas de
 * `studio-waves.ts` pra cá na limpeza da seção "Composição de wave —
 * preview" — `studio-issues.ts` é o único consumidor real (a análise de
 * cluster/composição de onda que também vivia lá foi removida, não
 * relocada). `test/studio-waves.test.ts` foi deletado.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSession, claimIssueCheckAndSet } from "../scripts/lib/session-registry.ts";
import {
  derivePriority,
  deriveTrackFromBranch,
  extractFilePaths,
  parseIssues,
  parsePrs,
  summarizeChecks,
  fetchTriageData,
  clearTriageCache,
  defaultGhRun,
  attachClaims,
  isPanelDisplayStale,
  PANEL_DISPLAY_STALE_MS,
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
  it("continuo/fix-NNNN-slug -> continuo (#6446 v0.5.0 — pedido do editor 28/08)", () => {
    assert.equal(deriveTrackFromBranch("continuo/fix-6431-sync-code-scheduled"), "continuo");
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

// ─── relocadas de test/studio-waves.test.ts no #4004 ───────────────────

describe("extractFilePaths (#3562, relocado no #4004)", () => {
  it("extrai paths em code-span", () => {
    const text = "Estender `scripts/studio-ui/studio-issues.ts` (é seu) e `context/overnight-dispatch-rules.md`.";
    assert.deepEqual(extractFilePaths(text), ["context/overnight-dispatch-rules.md", "scripts/studio-ui/studio-issues.ts"]);
  });

  it("extrai paths nus com prefixo de diretório-raiz conhecido", () => {
    const text = "Mexe em scripts/lib/publish-state.ts e também test/studio-issues.test.ts.";
    assert.deepEqual(extractFilePaths(text), ["scripts/lib/publish-state.ts", "test/studio-issues.test.ts"]);
  });

  it("remove pontuação de trailing (vírgula, ponto, parêntese)", () => {
    const text = "Ver `scripts/studio-ui/server.ts`, e (`context/editorial-rules.md`).";
    assert.deepEqual(extractFilePaths(text), ["context/editorial-rules.md", "scripts/studio-ui/server.ts"]);
  });

  it("dedup entre code-span e path nu do mesmo arquivo", () => {
    const text = "`scripts/foo.ts` é o mesmo arquivo que scripts/foo.ts mencionado sem backtick.";
    assert.deepEqual(extractFilePaths(text), ["scripts/foo.ts"]);
  });

  it("ignora tokens sem prefixo de diretório-raiz conhecido (falso-negativo é seguro)", () => {
    const text = "Isso não é path: 10/20 nem foo/bar.ts (sem prefixo reconhecido).";
    assert.deepEqual(extractFilePaths(text), []);
  });

  it("null/undefined/vazio -> array vazio, sem lançar", () => {
    assert.deepEqual(extractFilePaths(null), []);
    assert.deepEqual(extractFilePaths(undefined), []);
    assert.deepEqual(extractFilePaths(""), []);
  });
});

describe("classificação de issue migrou pro lib compartilhado (#5462)", () => {
  // `classifyDispatchTrack` (elegível/bloqueada/ambígua) foi substituído por
  // `classifyExecTrack` (overnight/develop/bloqueada/fora-de-rodada) em
  // `scripts/lib/issue-exec-track.ts` — a tabela de precedência é testada lá
  // (`test/issue-exec-track.test.ts`). Aqui fica só o guard de que a Triagem
  // não voltou a ter classificador PRÓPRIO: uma 2ª fonte de verdade divergindo
  // da Fase 0 das skills é exatamente o que o #5462 removeu.
  it("studio-issues.ts não exporta mais classificador próprio", async () => {
    const mod = await import("../scripts/studio-ui/studio-issues.ts");
    assert.equal("classifyDispatchTrack" in mod, false);
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

describe("parseIssues — files + execTrack (#3562, entrega 2; #5462)", () => {
  it("deriva files do corpo e execTrack='overnight' sem label de bloqueio", () => {
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
    assert.equal(issue.execTrack, "overnight");
  });

  it("label external-blocker -> execTrack='bloqueada'", () => {
    const raw: GhIssueRaw[] = [
      { number: 2, title: "t", url: "u", state: "OPEN", labels: [{ name: "external-blocker" }], body: "" },
    ];
    const [issue] = parseIssues(raw);
    assert.equal(issue.execTrack, "bloqueada");
  });

  it("label windows -> execTrack='develop'", () => {
    const raw: GhIssueRaw[] = [
      { number: 3, title: "t", url: "u", state: "OPEN", labels: [{ name: "windows" }], body: "" },
    ];
    const [issue] = parseIssues(raw);
    assert.equal(issue.execTrack, "develop");
  });

  it("corpo com marcador de decisão em aberto NÃO classifica sozinho (#5462)", () => {
    // Regressão do `AMBIGUITY_RE` removido: este corpo virava 'ambigua' antes,
    // tirando da fila do overnight uma issue que o briefing destrava.
    const raw: GhIssueRaw[] = [
      { number: 4, title: "t", url: "u", state: "OPEN", labels: [], body: "precisamos decidir entre X e Y" },
    ];
    const [issue] = parseIssues(raw);
    assert.equal(issue.execTrack, "overnight");
  });

  it("body ausente -> files vazio, sem lançar", () => {
    const raw = [{ number: 5, title: "sem corpo", url: "u", state: "OPEN" }] as GhIssueRaw[];
    const [issue] = parseIssues(raw);
    assert.deepEqual(issue.files, []);
    assert.equal(issue.execTrack, "overnight");
  });

  it("issue fechada -> execTrack='fora-de-rodada', nunca 'overnight' (#5948 — parseIssues esquecia de propagar `state` pra classifyExecTrack)", () => {
    const raw: GhIssueRaw[] = [
      { number: 6, title: "t", url: "u", state: "CLOSED", labels: [{ name: "bug" }], body: "" },
    ];
    const [issue] = parseIssues(raw);
    assert.equal(issue.execTrack, "fora-de-rodada");
  });

  it("label develop-track -> execTrack='develop' (#5948 — bloqueio humano sem data)", () => {
    const raw: GhIssueRaw[] = [
      { number: 7, title: "t", url: "u", state: "OPEN", labels: [{ name: "develop-track" }], body: "" },
    ];
    const [issue] = parseIssues(raw);
    assert.equal(issue.execTrack, "develop");
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

  describe("fetchTriageData + claim de data/sessions/ real (#6436)", () => {
    let root: string | null = null;
    afterEach(() => {
      if (root) {
        rmSync(root, { recursive: true, force: true });
        root = null;
      }
    });

    it("claim de sessão ATIVA aparece na issue", () => {
      root = mkdtempSync(join(tmpdir(), "studio-issues-claims-"));
      registerSession(root, "continuo", "5d791ef6", { tag: "helios" });
      claimIssueCheckAndSet(root, "continuo", "5d791ef6", 6051, "helios");

      const run = mockRun([{ number: 6051, title: "x", url: "u", state: "OPEN", labels: [] }], []);
      const data = fetchTriageData(root, { run, now: () => Date.now() });
      assert.equal(data.issues[0]?.claim?.kind, "continuo");
      assert.equal(data.issues[0]?.claim?.sessionId, "5d791ef6");
    });

    it("claim de sessão STALE NÃO aparece — não deveria ler 'em andamento' pra uma sessão morta", () => {
      root = mkdtempSync(join(tmpdir(), "studio-issues-claims-stale-"));
      const staleStart = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h > SOFT_STALE_MS (90min)
      registerSession(root, "continuo", "sess-morta", { tag: "helios", startedAt: staleStart });
      claimIssueCheckAndSet(root, "continuo", "sess-morta", 6051, "helios", staleStart);

      const run = mockRun([{ number: 6051, title: "x", url: "u", state: "OPEN", labels: [] }], []);
      const data = fetchTriageData(root, { run, now: () => Date.now() });
      assert.equal(data.issues[0]?.claim, null);
    });

    it("#6592 — claim com heartbeat > PANEL_DISPLAY_STALE_MS (20min) NÃO aparece no painel, mesmo dentro de SOFT_STALE_MS (90min)", () => {
      root = mkdtempSync(join(tmpdir(), "studio-issues-claims-panel-stale-"));
      // 25min: > PANEL_DISPLAY_STALE_MS (20min), mas < SOFT_STALE_MS (90min) —
      // `listActiveSessions` ainda considera esta sessão `stale: false`.
      const heartbeat = new Date(Date.now() - 25 * 60 * 1000).toISOString();
      registerSession(root, "continuo", "sess-heartbeat-velho", { tag: "helios", startedAt: heartbeat });
      claimIssueCheckAndSet(root, "continuo", "sess-heartbeat-velho", 6051, "helios", heartbeat);

      const run = mockRun([{ number: 6051, title: "x", url: "u", state: "OPEN", labels: [] }], []);
      const data = fetchTriageData(root, { run, now: () => Date.now() });
      assert.equal(data.issues[0]?.claim, null);
    });

    it("#6592 — claim com heartbeat < PANEL_DISPLAY_STALE_MS (20min) continua aparecendo (não regride #6436)", () => {
      root = mkdtempSync(join(tmpdir(), "studio-issues-claims-panel-fresh-"));
      const heartbeat = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      registerSession(root, "continuo", "sess-fresca", { tag: "helios", startedAt: heartbeat });
      claimIssueCheckAndSet(root, "continuo", "sess-fresca", 6051, "helios", heartbeat);

      const run = mockRun([{ number: 6051, title: "x", url: "u", state: "OPEN", labels: [] }], []);
      const data = fetchTriageData(root, { run, now: () => Date.now() });
      assert.equal(data.issues[0]?.claim?.sessionId, "sess-fresca");
    });
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
    // `timeout` — exatamente o gap que o #3773 já tinha corrigido num módulo
    // irmão (removido desde, #4004), nunca reusado aqui até o #3783. Mais
    // severo aqui: `defaultGhRun` alimenta `fetchTriageData`, chamada por
    // `GET /api/issues` — rota de uso normal do Studio, não gateada por env
    // var. Simulamos com um processo Node genuíno que dorme
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

describe("isPanelDisplayStale (#6592, puro)", () => {
  it("heartbeat dentro do limiar → não stale", () => {
    const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
    const lastHeartbeat = new Date(nowMs - 5 * 60 * 1000).toISOString();
    assert.equal(isPanelDisplayStale({ lastHeartbeat, startedAt: lastHeartbeat }, nowMs), false);
  });

  it("heartbeat > PANEL_DISPLAY_STALE_MS (20min) → stale de exibição", () => {
    const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
    const lastHeartbeat = new Date(nowMs - 25 * 60 * 1000).toISOString();
    assert.equal(isPanelDisplayStale({ lastHeartbeat, startedAt: lastHeartbeat }, nowMs), true);
  });

  it("exatamente no limiar (não excede) → não stale (comparação é estrita '>')", () => {
    const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
    const lastHeartbeat = new Date(nowMs - PANEL_DISPLAY_STALE_MS).toISOString();
    assert.equal(isPanelDisplayStale({ lastHeartbeat, startedAt: lastHeartbeat }, nowMs), false);
  });

  it("fallback pra startedAt quando lastHeartbeat ausente", () => {
    const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
    const startedAt = new Date(nowMs - 25 * 60 * 1000).toISOString();
    assert.equal(isPanelDisplayStale({ lastHeartbeat: undefined as unknown as string, startedAt }, nowMs), true);
  });

  it("data inválida nunca lança e nunca marca stale (fail-soft — idade desconhecida não esconde claim ativo)", () => {
    const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
    assert.equal(isPanelDisplayStale({ lastHeartbeat: "not-a-date", startedAt: "not-a-date" }, nowMs), false);
  });

  it("aceita maxAgeMs custom (override do default)", () => {
    const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
    const lastHeartbeat = new Date(nowMs - 10 * 60 * 1000).toISOString();
    assert.equal(isPanelDisplayStale({ lastHeartbeat, startedAt: lastHeartbeat }, nowMs, 5 * 60 * 1000), true);
    assert.equal(isPanelDisplayStale({ lastHeartbeat, startedAt: lastHeartbeat }, nowMs, 15 * 60 * 1000), false);
  });
});

describe("attachClaims (#6436)", () => {
  function issue(number: number): ReturnType<typeof parseIssues>[number] {
    return parseIssues([
      { number, title: `issue ${number}`, url: "https://x", state: "OPEN", labels: [], body: "" },
    ])[0]!;
  }

  it("issue reivindicada por sessão continuo mostra o claim, não fica indistinguível de 'sem sinal'", () => {
    const [claimed] = attachClaims([issue(6051)], [
      {
        kind: "continuo",
        machineTag: "helios",
        sessionId: "5d791ef6",
        claimed_issues: [6051],
        claimed_issues_at: { "6051": "2026-08-20T00:00:00Z" },
      },
    ]);
    assert.deepEqual(claimed!.claim, {
      kind: "continuo",
      machineTag: "helios",
      sessionId: "5d791ef6",
      claimedAt: "2026-08-20T00:00:00Z",
    });
  });

  it("issue sem claim de nenhuma sessão ativa → claim null", () => {
    const [free] = attachClaims([issue(1)], [
      { kind: "overnight", machineTag: "helios", sessionId: "x", claimed_issues: [2] },
    ]);
    assert.equal(free!.claim, null);
  });

  it("sem sessões ativas nenhuma → todas as issues com claim null, nunca lança", () => {
    const [a, b] = attachClaims([issue(1), issue(2)], []);
    assert.equal(a!.claim, null);
    assert.equal(b!.claim, null);
  });

  it("issue reivindicada por 2 sessões simultaneamente (dado corrompido) → a 1ª da lista vence, sem lançar", () => {
    const [claimed] = attachClaims([issue(9)], [
      { kind: "overnight", machineTag: "helios", sessionId: "first", claimed_issues: [9] },
      { kind: "develop", machineTag: "neo", sessionId: "second", claimed_issues: [9] },
    ]);
    assert.equal(claimed!.claim?.sessionId, "first");
  });
});
