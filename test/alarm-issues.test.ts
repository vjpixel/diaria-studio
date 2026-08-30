/**
 * test/alarm-issues.test.ts (#5112)
 *
 * Regressão pura + I/O injetado pra `scripts/lib/alarm-issues.ts` — nenhum
 * teste aqui chama `gh` de verdade (mock via `GhRunFn` injetável, mesmo
 * padrão de `test/home-meta-check-script.test.ts`). Cobre a lista
 * de testes pedida pela issue #5112:
 *
 *   - mesmo fingerprint em 2 execuções -> 1 issue só (2ª reusa)
 *   - issue com marcador + estado local apagado -> adota a existente
 *   - achado some 1 execução -> comenta, não fecha
 *   - achado some 2 execuções -> fecha
 *   - falha na criação -> e-mail teria o motivo, cursor não avança
 *   - corpo do e-mail contém a URL da issue (via wiring de
 *     home-meta-check, testado em test/home-meta-check.test.ts)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";
import {
  alarmFindingMarker,
  alarmIssueStateKey,
  emptyAlarmIssuesState,
  findExistingAlarmIssue,
  ensureAlarmIssue,
  fetchAlarmIssueState,
  commentAlarmIssueResolved,
  closeAlarmIssue,
  planAlarmReconciliation,
  applyAlarmReconciliation,
  isAllowlisted,
  aggregateFindingsOnDebut,
  ALARM_ACTION_LABEL,
  type AlarmFinding,
  type AlarmIssuesState,
  type AlarmAllowlist,
  type GhRunFn,
} from "../scripts/lib/alarm-issues.ts";
import { classifyExecTrack } from "../scripts/lib/issue-exec-track.ts";

const CWD = "/repo";

function ok(stdout: string): GhSpawnResult {
  return { status: 0, stdout, stderr: "" };
}
function fail(stderr: string, status = 1): GhSpawnResult {
  return { status, stdout: "", stderr };
}

const FINDING_A: AlarmFinding = {
  check: "english-labels",
  fingerprint: "english-labels:rótulo(s) em inglês residual(is) encontrado(s): \"N min read\"",
  title: 'Home Beehiiv: rótulo em inglês residual — "N min read"',
  body: "Achado do smoke-test diário.",
  family: "estado",
  labels: ["bug"],
};

// ─── alarmFindingMarker / alarmIssueStateKey (puro) ────────────────────────

describe("alarmFindingMarker / alarmIssueStateKey (#5112)", () => {
  it("marcador é determinístico pro mesmo check+fingerprint", () => {
    assert.equal(
      alarmFindingMarker("english-labels", "x"),
      "<!-- alarm-finding: english-labels:x -->",
    );
  });

  it("stateKey combina check e fingerprint", () => {
    assert.equal(alarmIssueStateKey("a", "b"), "a:b");
  });
});

// ─── findExistingAlarmIssue (I/O injetado) ─────────────────────────────────

describe("findExistingAlarmIssue (#5112 item 2 — fallback de dedup por marcador)", () => {
  it("acha issue existente cujo body contém o marcador exato", () => {
    const marker = alarmFindingMarker(FINDING_A.check, FINDING_A.fingerprint);
    const run: GhRunFn = () =>
      ok(JSON.stringify([{ number: 5101, url: "https://github.com/x/y/issues/5101", body: `algo\n\n${marker}\n` }]));
    const found = findExistingAlarmIssue(FINDING_A.check, FINDING_A.fingerprint, CWD, run);
    assert.deepEqual(found, { issueNumber: 5101, url: "https://github.com/x/y/issues/5101", state: "OPEN" });
  });

  it("nenhum match -> null", () => {
    const run: GhRunFn = () => ok(JSON.stringify([{ number: 1, url: "u", body: "sem marcador nenhum" }]));
    assert.equal(findExistingAlarmIssue(FINDING_A.check, FINDING_A.fingerprint, CWD, run), null);
  });

  it("gh falha (status != 0) -> null, nunca lança", () => {
    const run: GhRunFn = () => fail("rate limited");
    assert.equal(findExistingAlarmIssue(FINDING_A.check, FINDING_A.fingerprint, CWD, run), null);
  });

  it("JSON malformado -> null, nunca lança", () => {
    const run: GhRunFn = () => ok("não é json");
    assert.equal(findExistingAlarmIssue(FINDING_A.check, FINDING_A.fingerprint, CWD, run), null);
  });
});

// ─── ensureAlarmIssue ───────────────────────────────────────────────────────

describe("ensureAlarmIssue (#5112)", () => {
  it("sem cache, sem match no gh search -> cria, retorna action created", () => {
    let createCalled = false;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") {
        createCalled = true;
        return ok("https://github.com/x/y/issues/5101\n");
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    };
    const result = ensureAlarmIssue(FINDING_A, undefined, CWD, run);
    assert.equal(createCalled, true);
    assert.deepEqual(result, { issueNumber: 5101, url: "https://github.com/x/y/issues/5101", action: "created" });
  });

  it("com cache local, família 'estado' -> confirma via 'gh issue view' antes de reusar (#5989)", () => {
    let viewArgs: string[] | null = null;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "view") {
        viewArgs = args;
        return ok(JSON.stringify({ state: "OPEN" }));
      }
      throw new Error(`não deveria chamar ${args.join(" ")}`);
    };
    const result = ensureAlarmIssue(FINDING_A, { issueNumber: 42, url: "https://x/42" }, CWD, run);
    assert.deepEqual(result, { issueNumber: 42, url: "https://x/42", action: "reused" });
    assert.ok(viewArgs, "deveria ter confirmado o estado real via 'gh issue view'");
    assert.equal(viewArgs![2], "42");
  });

  it("sem cache, MAS marcador encontrado no gh search -> adota a existente, action reused (#5112: 'issue com marcador + estado local apagado')", () => {
    const marker = alarmFindingMarker(FINDING_A.check, FINDING_A.fingerprint);
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") {
        return ok(JSON.stringify([{ number: 777, url: "https://github.com/x/y/issues/777", body: marker }]));
      }
      throw new Error("não deveria criar quando já existe");
    };
    const result = ensureAlarmIssue(FINDING_A, undefined, CWD, run);
    assert.deepEqual(result, { issueNumber: 777, url: "https://github.com/x/y/issues/777", action: "reused" });
  });

  it("mesmo fingerprint em 2 chamadas -> 1 issue só (2ª reusa via cache)", () => {
    let createCount = 0;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") {
        createCount++;
        return ok("https://github.com/x/y/issues/5101\n");
      }
      if (args[0] === "issue" && args[1] === "view") return ok(JSON.stringify({ state: "OPEN" }));
      throw new Error("unexpected");
    };
    const first = ensureAlarmIssue(FINDING_A, undefined, CWD, run);
    assert.equal(first.action, "created");
    // 2ª chamada simula a execução seguinte: o caller passa o cache
    // persistido da 1ª chamada.
    const second = ensureAlarmIssue(
      FINDING_A,
      { issueNumber: first.issueNumber!, url: first.url! },
      CWD,
      run,
    );
    assert.equal(second.action, "reused");
    assert.equal(second.issueNumber, first.issueNumber);
    assert.equal(createCount, 1, "gh issue create só deveria ter sido chamado 1 vez");
  });

  it("falha na criação NÃO relacionada a label (ex: rate limit) -> action failed direto, sem tentar retry", () => {
    let createCalls = 0;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") {
        createCalls++;
        return fail("HTTP 403: rate limited");
      }
      throw new Error("unexpected");
    };
    const result = ensureAlarmIssue(FINDING_A, undefined, CWD, run);
    assert.equal(result.action, "failed");
    assert.equal(result.issueNumber, null);
    assert.equal(result.url, null);
    assert.match(result.error ?? "", /rate limited/);
    assert.equal(createCalls, 1, "não deveria retentar uma falha que não é de label ausente");
  });

  it("labels incluem sempre 'alarm' + a prioridade resolvida (default P2)", () => {
    let labelArg: string | null = null;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") {
        const idx = args.indexOf("--label");
        labelArg = args[idx + 1];
        return ok("https://github.com/x/y/issues/1\n");
      }
      throw new Error("unexpected");
    };
    ensureAlarmIssue(FINDING_A, undefined, CWD, run);
    assert.ok(labelArg);
    assert.match(labelArg!, /\balarm\b/);
    assert.match(labelArg!, /\bP2\b/);
    assert.match(labelArg!, /\bbug\b/);
  });

  it("#5553: family 'estado' -> labels NÃO incluem 'alarm-evento'", () => {
    let labelArg: string | null = null;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") {
        labelArg = args[args.indexOf("--label") + 1];
        return ok("https://github.com/x/y/issues/1\n");
      }
      throw new Error("unexpected");
    };
    ensureAlarmIssue({ ...FINDING_A, family: "estado" }, undefined, CWD, run);
    assert.match(labelArg!, /\balarm\b/);
    assert.doesNotMatch(labelArg!, /alarm-evento/);
  });

  it("#5553: family 'evento' -> labels incluem 'alarm' E 'alarm-evento'", () => {
    let labelArg: string | null = null;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") {
        labelArg = args[args.indexOf("--label") + 1];
        return ok("https://github.com/x/y/issues/1\n");
      }
      throw new Error("unexpected");
    };
    ensureAlarmIssue({ ...FINDING_A, family: "evento" }, undefined, CWD, run);
    const labels = labelArg!.split(",");
    assert.ok(labels.includes("alarm"), "issue de evento continua achável por 'gh issue list --label alarm'");
    assert.ok(labels.includes("alarm-evento"));
  });

  it("#6205: labels da criação já classificam o track certo em classifyExecTrack, sem passo extra — família estado → fora-de-rodada (auto-resolve)", () => {
    let labelArg: string | null = null;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") {
        labelArg = args[args.indexOf("--label") + 1];
        return ok("https://github.com/x/y/issues/1\n");
      }
      throw new Error("unexpected");
    };
    ensureAlarmIssue({ ...FINDING_A, family: "estado" }, undefined, CWD, run);
    const track = classifyExecTrack({ labels: labelArg!.split(","), body: "", state: "OPEN" });
    assert.equal(track, "fora-de-rodada", "família estado nasce já classificável — nenhum route-issue extra na criação");
  });

  it("#6205: labels da criação já classificam o track certo em classifyExecTrack — família evento → overnight", () => {
    let labelArg: string | null = null;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") {
        labelArg = args[args.indexOf("--label") + 1];
        return ok("https://github.com/x/y/issues/1\n");
      }
      throw new Error("unexpected");
    };
    ensureAlarmIssue({ ...FINDING_A, family: "evento" }, undefined, CWD, run);
    const track = classifyExecTrack({ labels: labelArg!.split(","), body: "", state: "OPEN" });
    assert.equal(track, "overnight", "família evento nasce já classificável — alarm-evento vence alarm na precedência");
  });

  it("corpo da issue criada carrega o marcador de dedup", () => {
    let bodyArg: string | null = null;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") {
        const idx = args.indexOf("--body");
        bodyArg = args[idx + 1];
        return ok("https://github.com/x/y/issues/1\n");
      }
      throw new Error("unexpected");
    };
    ensureAlarmIssue(FINDING_A, undefined, CWD, run);
    assert.ok(bodyArg!.includes(alarmFindingMarker(FINDING_A.check, FINDING_A.fingerprint)));
  });
});

// ─── #5978: issue localizada CLOSED nunca é "reused" silenciosamente ──────

describe("ensureAlarmIssue — reabre issue fechada em vez de reusar silenciosamente (#5978)", () => {
  it("cachedEntry com closedAt setado -> chama 'gh issue reopen' + comment, action 'reopened'", () => {
    let reopenArgs: string[] | null = null;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "reopen") {
        reopenArgs = args;
        return ok("");
      }
      throw new Error(`não deveria chamar ${args.join(" ")} — deveria ir direto pro reopen`);
    };
    const result = ensureAlarmIssue(
      FINDING_A,
      { issueNumber: 5942, url: "https://github.com/x/y/issues/5942", closedAt: "2026-08-20T00:00:00Z" },
      CWD,
      run,
    );
    assert.deepEqual(result, { issueNumber: 5942, url: "https://github.com/x/y/issues/5942", action: "reopened" });
    assert.ok(reopenArgs, "deveria ter chamado 'gh issue reopen'");
    assert.equal(reopenArgs![2], "5942");
    assert.ok(reopenArgs!.includes("--comment"), "reopen deveria comentar o motivo (preserva histórico do achado)");
  });

  it("sem cache, mas findExistingAlarmIssue acha issue CLOSED via marcador -> reabre também", () => {
    const marker = alarmFindingMarker(FINDING_A.check, FINDING_A.fingerprint);
    let reopenCalled = false;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") {
        return ok(
          JSON.stringify([
            { number: 5826, url: "https://github.com/x/y/issues/5826", body: marker, state: "CLOSED" },
          ]),
        );
      }
      if (args[0] === "issue" && args[1] === "reopen") {
        reopenCalled = true;
        return ok("");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const result = ensureAlarmIssue(FINDING_A, undefined, CWD, run);
    assert.equal(reopenCalled, true);
    assert.deepEqual(result, { issueNumber: 5826, url: "https://github.com/x/y/issues/5826", action: "reopened" });
  });

  it("findExistingAlarmIssue acha issue OPEN via marcador -> comportamento antigo preservado (reused, sem reopen)", () => {
    const marker = alarmFindingMarker(FINDING_A.check, FINDING_A.fingerprint);
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") {
        return ok(JSON.stringify([{ number: 999, url: "https://github.com/x/y/issues/999", body: marker, state: "OPEN" }]));
      }
      throw new Error("não deveria chamar reopen pra issue já aberta");
    };
    const result = ensureAlarmIssue(FINDING_A, undefined, CWD, run);
    assert.deepEqual(result, { issueNumber: 999, url: "https://github.com/x/y/issues/999", action: "reused" });
  });

  it("'gh issue reopen' falha -> action 'failed', nunca fabrica sucesso (fail-soft #5112 item 6)", () => {
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "reopen") return fail("HTTP 403: rate limited");
      throw new Error("unexpected");
    };
    const result = ensureAlarmIssue(
      FINDING_A,
      { issueNumber: 5942, url: "https://x/5942", closedAt: "2026-08-20T00:00:00Z" },
      CWD,
      run,
    );
    assert.equal(result.action, "failed");
    assert.equal(result.issueNumber, null);
    assert.equal(result.url, null);
    assert.match(result.error ?? "", /rate limited/);
  });
});

// ─── #5989: cache-hit com closedAt:null NÃO é garantia de "aberta" ────────

describe("fetchAlarmIssueState (#5989 — unidade isolada)", () => {
  it("'gh issue view' com JSON malformado -> null, fail-soft", () => {
    const run: GhRunFn = () => ok("isto não é JSON{");
    assert.equal(fetchAlarmIssueState(42, CWD, run), null);
  });

  it("'gh issue view' com state fora do enum esperado -> null, fail-soft", () => {
    const run: GhRunFn = () => ok(JSON.stringify({ state: "MERGED" }));
    assert.equal(fetchAlarmIssueState(42, CWD, run), null);
  });

  it("'gh issue view' com campo state ausente -> null, fail-soft", () => {
    const run: GhRunFn = () => ok(JSON.stringify({}));
    assert.equal(fetchAlarmIssueState(42, CWD, run), null);
  });

  it("'gh issue view' com status != 0 -> null, sem tentar parsear stdout", () => {
    const run: GhRunFn = () => fail("gh: not authenticated");
    assert.equal(fetchAlarmIssueState(42, CWD, run), null);
  });

  it("'gh issue view' com state OPEN -> 'OPEN'", () => {
    const run: GhRunFn = () => ok(JSON.stringify({ state: "OPEN" }));
    assert.equal(fetchAlarmIssueState(42, CWD, run), "OPEN");
  });

  it("'gh issue view' com state CLOSED -> 'CLOSED'", () => {
    const run: GhRunFn = () => ok(JSON.stringify({ state: "CLOSED" }));
    assert.equal(fetchAlarmIssueState(42, CWD, run), "CLOSED");
  });
});

describe("ensureAlarmIssue — cache-hit confirma estado real pra família 'estado' (#5989)", () => {
  it("cachedEntry.closedAt: null MAS estado real (mockado) CLOSED -> AINDA REABRE, action 'reopened' (cenário exato do bug)", () => {
    let viewArgs: string[] | null = null;
    let reopenArgs: string[] | null = null;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "view") {
        viewArgs = args;
        return ok(JSON.stringify({ state: "CLOSED" }));
      }
      if (args[0] === "issue" && args[1] === "reopen") {
        reopenArgs = args;
        return ok("");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const result = ensureAlarmIssue(
      FINDING_A,
      { issueNumber: 5826, url: "https://github.com/x/y/issues/5826", closedAt: null },
      CWD,
      run,
    );
    assert.deepEqual(result, { issueNumber: 5826, url: "https://github.com/x/y/issues/5826", action: "reopened" });
    assert.ok(viewArgs, "deveria ter confirmado o estado real via 'gh issue view' mesmo com closedAt: null local");
    assert.equal(viewArgs![2], "5826");
    assert.ok(reopenArgs, "estado real CLOSED -> deveria ter reaberto de verdade");
    assert.equal(reopenArgs![2], "5826");
  });

  it("cachedEntry.closedAt: null E estado real OPEN -> action 'reused', sem chamar 'gh issue reopen'", () => {
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "view") return ok(JSON.stringify({ state: "OPEN" }));
      if (args[0] === "issue" && args[1] === "reopen") {
        throw new Error("não deveria chamar reopen — estado real é OPEN");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const result = ensureAlarmIssue(
      FINDING_A,
      { issueNumber: 42, url: "https://x/42", closedAt: null },
      CWD,
      run,
    );
    assert.deepEqual(result, { issueNumber: 42, url: "https://x/42", action: "reused" });
  });

  it("'gh issue view' falhando -> fail-soft, action 'reused', NUNCA reabre às cegas", () => {
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "view") return fail("gh: connection reset");
      if (args[0] === "issue" && args[1] === "reopen") {
        throw new Error("não deveria chamar reopen — 'gh issue view' falhou, estado real é desconhecido");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const result = ensureAlarmIssue(
      FINDING_A,
      { issueNumber: 42, url: "https://x/42", closedAt: null },
      CWD,
      run,
    );
    assert.deepEqual(result, { issueNumber: 42, url: "https://x/42", action: "reused" });
  });

  it("família 'evento' -> cache-hit NUNCA chama 'gh issue view' (checagem é exclusiva de 'estado', não-regressão)", () => {
    const eventoFinding: AlarmFinding = { ...FINDING_A, family: "evento" };
    const run: GhRunFn = () => {
      throw new Error("não deveria chamar gh nenhum — família 'evento' nunca é checada no cache-hit");
    };
    const result = ensureAlarmIssue(
      eventoFinding,
      { issueNumber: 42, url: "https://x/42", closedAt: null },
      CWD,
      run,
    );
    assert.deepEqual(result, { issueNumber: 42, url: "https://x/42", action: "reused" });
  });
});

describe("applyAlarmReconciliation — cenário real da issue #5978 (issue fechada reproduz de novo)", () => {
  it("achado que reproduz com issue local marcada closedAt -> vira REOPENED, state volta a closedAt: null", () => {
    const state: AlarmIssuesState = {
      [alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint)]: {
        issueNumber: 5942,
        url: "https://github.com/x/y/issues/5942",
        missingStreak: 2,
        closedAt: "2026-08-21T08:00:00Z",
        family: "estado",
      },
    };
    let reopenArgs: string[] | null = null;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "reopen") {
        reopenArgs = args;
        return ok("");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const { nextState, findingOutcomes } = applyAlarmReconciliation([FINDING_A], state, {
      cwd: CWD,
      closeAfterRuns: 2,
      run,
    });
    assert.equal(findingOutcomes[0].action, "reopened");
    assert.ok(reopenArgs, "deveria ter chamado 'gh issue reopen' de verdade");
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    assert.equal(nextState[key].closedAt, null, "tracking local volta a tratar a issue como aberta");
    assert.equal(nextState[key].issueNumber, 5942, "mesma issue reaberta, nunca uma nova");
  });
});

// ─── #5338: label 'alarm' ausente no repo -> self-heal + retry ────────────

describe("ensureAlarmIssue — retry fail-soft de label ausente (#5338)", () => {
  it("erro real do gh ('could not add label') na label 'alarm' -> self-heal cria a label, retry mantém 'alarm', 2ª tentativa cria a issue", () => {
    let createAttempts = 0;
    let labelCreateCalled = false;
    let lastLabelArg: string | null = null;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "label" && args[1] === "create") {
        labelCreateCalled = true;
        assert.equal(args[2], "alarm");
        assert.ok(args.includes("--force"));
        return ok("");
      }
      if (args[0] === "issue" && args[1] === "create") {
        createAttempts++;
        const idx = args.indexOf("--label");
        lastLabelArg = idx >= 0 ? args[idx + 1] : null;
        if (createAttempts === 1) return fail("could not add label: 'alarm' not found");
        return ok("https://github.com/x/y/issues/6001\n");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const result = ensureAlarmIssue(FINDING_A, undefined, CWD, run);
    assert.equal(labelCreateCalled, true, "deveria ter tentado auto-criar a label 'alarm'");
    assert.equal(createAttempts, 2, "deveria retentar 'gh issue create' após o self-heal");
    assert.match(lastLabelArg ?? "", /\balarm\b/, "self-heal bem-sucedido -> retry mantém 'alarm' na lista");
    assert.deepEqual(result, { issueNumber: 6001, url: "https://github.com/x/y/issues/6001", action: "created" });
  });

  it("self-heal da label 'alarm' também falha -> retry cai pra lista SEM 'alarm', ainda cria a issue", () => {
    let createAttempts = 0;
    let lastLabelArg: string | null = null;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "label" && args[1] === "create") return fail("gh: permission denied");
      if (args[0] === "issue" && args[1] === "create") {
        createAttempts++;
        const idx = args.indexOf("--label");
        lastLabelArg = idx >= 0 ? args[idx + 1] : null;
        if (createAttempts === 1) return fail("could not add label: 'alarm' not found");
        return ok("https://github.com/x/y/issues/6002\n");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const result = ensureAlarmIssue(FINDING_A, undefined, CWD, run);
    assert.equal(createAttempts, 2);
    assert.ok(lastLabelArg, "retry ainda deveria mandar --label (com as outras labels válidas)");
    assert.doesNotMatch(lastLabelArg!, /\balarm\b/, "self-heal falhou -> 'alarm' cai fora do retry");
    assert.match(lastLabelArg!, /\bbug\b/, "labels que não falharam continuam no retry");
    assert.match(lastLabelArg!, /\bP2\b/);
    assert.equal(result.action, "created");
    assert.equal(result.issueNumber, 6002);
  });

  it("retry sem a label ausente TAMBÉM falha -> action failed com o motivo de ambas as tentativas, nunca perde o achado silenciosamente", () => {
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "label" && args[1] === "create") return ok("");
      if (args[0] === "issue" && args[1] === "create") return fail("could not add label: 'alarm' not found");
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const result = ensureAlarmIssue(FINDING_A, undefined, CWD, run);
    assert.equal(result.action, "failed");
    assert.equal(result.issueNumber, null);
    assert.equal(result.url, null);
    assert.match(result.error ?? "", /ausente/);
    assert.match(result.error ?? "", /alarm/);
  });

  it("label ausente que NÃO é 'alarm' -> dropada do retry sem tentar self-heal (só 'alarm' é auto-criável por este módulo)", () => {
    let labelCreateCalled = false;
    let createAttempts = 0;
    let lastLabelArg: string | null = null;
    const findingWithExtraLabel: AlarmFinding = { ...FINDING_A, labels: ["bug", "nivel-inexistente"] };
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "label" && args[1] === "create") {
        labelCreateCalled = true;
        return ok("");
      }
      if (args[0] === "issue" && args[1] === "create") {
        createAttempts++;
        const idx = args.indexOf("--label");
        lastLabelArg = idx >= 0 ? args[idx + 1] : null;
        if (createAttempts === 1) return fail("could not add label: 'nivel-inexistente' not found");
        return ok("https://github.com/x/y/issues/6003\n");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const result = ensureAlarmIssue(findingWithExtraLabel, undefined, CWD, run);
    assert.equal(
      labelCreateCalled,
      false,
      "'nivel-inexistente' não está em SELF_HEALABLE_LABELS — outra label ausente não dispara self-heal",
    );
    assert.equal(createAttempts, 2);
    assert.doesNotMatch(lastLabelArg ?? "", /nivel-inexistente/);
    assert.match(lastLabelArg ?? "", /\balarm\b/, "'alarm' não estava entre as ausentes -> segue no retry");
    assert.equal(result.action, "created");
  });

  it("#5553: label 'alarm-evento' ausente no repo -> self-heal generalizado cria a label, retry mantém 'alarm-evento'", () => {
    let createAttempts = 0;
    let labelCreateArgs: string[][] = [];
    let lastLabelArg: string | null = null;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "label" && args[1] === "create") {
        labelCreateArgs.push(args);
        return ok("");
      }
      if (args[0] === "issue" && args[1] === "create") {
        createAttempts++;
        const idx = args.indexOf("--label");
        lastLabelArg = idx >= 0 ? args[idx + 1] : null;
        if (createAttempts === 1) return fail("could not add label: 'alarm-evento' not found");
        return ok("https://github.com/x/y/issues/6004\n");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const result = ensureAlarmIssue({ ...FINDING_A, family: "evento" }, undefined, CWD, run);
    assert.equal(labelCreateArgs.length, 1, "deveria ter tentado auto-criar só a label ausente");
    assert.equal(labelCreateArgs[0][2], "alarm-evento");
    assert.equal(createAttempts, 2);
    assert.match(lastLabelArg ?? "", /\balarm-evento\b/);
    assert.match(lastLabelArg ?? "", /\balarm\b/, "'alarm' nunca esteve ausente -> segue no retry normalmente");
    assert.equal(result.action, "created");
    assert.equal(result.issueNumber, 6004);
  });

  it("#5553: descrição de toda label self-healable respeita o teto de 100 chars do GitHub (regressão — 1ª tentativa de 'alarm-evento' deu HTTP 422 'description is too long')", () => {
    const descriptions: string[] = [];
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "label" && args[1] === "create") {
        const idx = args.indexOf("--description");
        descriptions.push(args[idx + 1]);
        return ok("");
      }
      if (args[0] === "issue" && args[1] === "create") {
        return fail("could not add label: 'alarm' not found, could not add label: 'alarm-evento' not found");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    ensureAlarmIssue({ ...FINDING_A, family: "evento" }, undefined, CWD, run);
    assert.equal(descriptions.length, 2, "deveria ter tentado self-heal de 'alarm' e 'alarm-evento'");
    for (const d of descriptions) {
      assert.ok(d.length <= 100, `descrição com ${d.length} chars excede o teto do GitHub: "${d}"`);
    }
  });

  it("#6772: label 'alarm-acao' ausente no repo -> self-heal generalizado cria a label, retry mantém 'alarm-acao'", () => {
    let createAttempts = 0;
    let labelCreateArgs: string[][] = [];
    let lastLabelArg: string | null = null;
    const findingWithAlarmAcao: AlarmFinding = { ...FINDING_A, labels: [ALARM_ACTION_LABEL] };
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "label" && args[1] === "create") {
        labelCreateArgs.push(args);
        return ok("");
      }
      if (args[0] === "issue" && args[1] === "create") {
        createAttempts++;
        const idx = args.indexOf("--label");
        lastLabelArg = idx >= 0 ? args[idx + 1] : null;
        if (createAttempts === 1) return fail("could not add label: 'alarm-acao' not found");
        return ok("https://github.com/x/y/issues/6005\n");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const result = ensureAlarmIssue(findingWithAlarmAcao, undefined, CWD, run);
    assert.equal(labelCreateArgs.length, 1, "deveria ter tentado auto-criar só a label ausente");
    assert.equal(labelCreateArgs[0][2], "alarm-acao");
    assert.equal(createAttempts, 2);
    assert.match(lastLabelArg ?? "", /\balarm-acao\b/);
    assert.match(lastLabelArg ?? "", /\balarm\b/, "'alarm' nunca esteve ausente -> segue no retry normalmente");
    assert.equal(result.action, "created");
    assert.equal(result.issueNumber, 6005);
  });

  it("#6772: descrição de 'alarm-acao' respeita o teto de 100 chars do GitHub (mesma pegadinha do #5553)", () => {
    const descriptions: string[] = [];
    const findingWithAlarmAcao: AlarmFinding = { ...FINDING_A, labels: [ALARM_ACTION_LABEL] };
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "label" && args[1] === "create") {
        const idx = args.indexOf("--description");
        descriptions.push(args[idx + 1]);
        return ok("");
      }
      if (args[0] === "issue" && args[1] === "create") {
        return fail("could not add label: 'alarm' not found, could not add label: 'alarm-acao' not found");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    ensureAlarmIssue(findingWithAlarmAcao, undefined, CWD, run);
    assert.equal(descriptions.length, 2, "deveria ter tentado self-heal de 'alarm' e 'alarm-acao'");
    for (const d of descriptions) {
      assert.ok(d.length <= 100, `descrição com ${d.length} chars excede o teto do GitHub: "${d}"`);
    }
  });
});

// ─── commentAlarmIssueResolved / closeAlarmIssue ───────────────────────────

describe("commentAlarmIssueResolved / closeAlarmIssue (#5112 item 3)", () => {
  it("comment: sucesso -> true", () => {
    const run: GhRunFn = () => ok("");
    assert.equal(commentAlarmIssueResolved(42, new Date("2026-08-12T00:00:00Z"), CWD, run), true);
  });

  it("comment: falha -> false, nunca lança", () => {
    const run: GhRunFn = () => fail("boom");
    assert.equal(commentAlarmIssueResolved(42, new Date(), CWD, run), false);
  });

  it("close: sucesso -> true", () => {
    const run: GhRunFn = () => ok("");
    assert.equal(closeAlarmIssue(42, 2, CWD, run), true);
  });

  it("close: falha -> false, nunca lança", () => {
    const run: GhRunFn = () => fail("boom");
    assert.equal(closeAlarmIssue(42, 2, CWD, run), false);
  });
});

// ─── planAlarmReconciliation (puro) ────────────────────────────────────────

describe("planAlarmReconciliation (#5112 item 3 — puro)", () => {
  it("achado pendente novo -> action ensure", () => {
    const actions = planAlarmReconciliation([FINDING_A], emptyAlarmIssuesState(), 2);
    assert.deepEqual(actions, [{ kind: "ensure", finding: FINDING_A }]);
  });

  it("achado que já era pendente continua tendo action ensure (idempotente)", () => {
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    const state: AlarmIssuesState = {
      [key]: { issueNumber: 1, url: "u", missingStreak: 0, closedAt: null },
    };
    const actions = planAlarmReconciliation([FINDING_A], state, 2);
    assert.deepEqual(actions, [{ kind: "ensure", finding: FINDING_A }]);
  });

  it("achado sumiu 1x (streak 0->1) -> comment_resolved, não fecha", () => {
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    const state: AlarmIssuesState = {
      [key]: { issueNumber: 1, url: "u", missingStreak: 0, closedAt: null },
    };
    const actions = planAlarmReconciliation([], state, 2);
    assert.deepEqual(actions, [{ kind: "comment_resolved", key, issueNumber: 1 }]);
  });

  it("achado sumiu 2x consecutivas (streak 1->2, closeAfterRuns=2) -> close", () => {
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    const state: AlarmIssuesState = {
      [key]: { issueNumber: 1, url: "u", missingStreak: 1, closedAt: null },
    };
    const actions = planAlarmReconciliation([], state, 2);
    assert.deepEqual(actions, [{ kind: "close", key, issueNumber: 1 }]);
  });

  it("issue já fechada (closedAt setado) nunca gera ação, mesmo ausente", () => {
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    const state: AlarmIssuesState = {
      [key]: { issueNumber: 1, url: "u", missingStreak: 5, closedAt: "2026-08-01T00:00:00Z" },
    };
    assert.deepEqual(planAlarmReconciliation([], state, 2), []);
  });

  it("#5172: closeAfterRuns=3, streak no meio da faixa (1->2) -> advance_streak, nunca comment/close de novo", () => {
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    const state: AlarmIssuesState = {
      [key]: { issueNumber: 1, url: "u", missingStreak: 1, closedAt: null },
    };
    const actions = planAlarmReconciliation([], state, 3);
    assert.deepEqual(actions, [{ kind: "advance_streak", key }]);
  });

  describe("#5553 — família evento nunca gera comment_resolved/advance_streak/close", () => {
    it("entry family:'evento' sumiu de pending -> NENHUMA ação (congelada, mesmo padrão da allowlist)", () => {
      const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
      const state: AlarmIssuesState = {
        [key]: { issueNumber: 1, url: "u", missingStreak: 0, closedAt: null, family: "evento" },
      };
      assert.deepEqual(planAlarmReconciliation([], state, 2), []);
    });

    it("entry family:'evento' sumiu por MUITAS execuções (streak alto) -> ainda assim nenhuma ação, nunca fecha", () => {
      const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
      const state: AlarmIssuesState = {
        [key]: { issueNumber: 1, url: "u", missingStreak: 50, closedAt: null, family: "evento" },
      };
      assert.deepEqual(planAlarmReconciliation([], state, 2), []);
    });

    it("entry family:'estado' explícita sumiu -> comportamento normal (comment_resolved), não é afetada pela exceção acima", () => {
      const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
      const state: AlarmIssuesState = {
        [key]: { issueNumber: 1, url: "u", missingStreak: 0, closedAt: null, family: "estado" },
      };
      const actions = planAlarmReconciliation([], state, 2);
      assert.deepEqual(actions, [{ kind: "comment_resolved", key, issueNumber: 1 }]);
    });

    it("entry SEM `family` (state.json pré-#5553) -> tratada como 'estado', auto-close preservado", () => {
      const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
      const state: AlarmIssuesState = {
        [key]: { issueNumber: 1, url: "u", missingStreak: 1, closedAt: null }, // sem `family`
      };
      const actions = planAlarmReconciliation([], state, 2);
      assert.deepEqual(actions, [{ kind: "close", key, issueNumber: 1 }]);
    });

    it("achado family:'evento' ainda PENDENTE continua gerando 'ensure' normalmente (a exceção é só pro lado ausente)", () => {
      const findingEvento: AlarmFinding = { ...FINDING_A, family: "evento" };
      const actions = planAlarmReconciliation([findingEvento], emptyAlarmIssuesState(), 2);
      assert.deepEqual(actions, [{ kind: "ensure", finding: findingEvento }]);
    });
  });
});

// ─── applyAlarmReconciliation (I/O injetado) ───────────────────────────────

describe("applyAlarmReconciliation (#5112) — cenários fim-a-fim da issue", () => {
  it("achado sumiu 1 execução -> comenta na issue, NÃO fecha (missingStreak vira 1)", () => {
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    const state: AlarmIssuesState = {
      [key]: { issueNumber: 1, url: "u", missingStreak: 0, closedAt: null },
    };
    let commentCalled = false;
    let closeCalled = false;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "comment") {
        commentCalled = true;
        return ok("");
      }
      if (args[0] === "issue" && args[1] === "close") {
        closeCalled = true;
        return ok("");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const { nextState } = applyAlarmReconciliation([], state, { cwd: CWD, closeAfterRuns: 2, run });
    assert.equal(commentCalled, true);
    assert.equal(closeCalled, false);
    assert.equal(nextState[key].missingStreak, 1);
    assert.equal(nextState[key].closedAt, null);
  });

  it("achado sumiu 2 execuções consecutivas -> fecha (missingStreak 1 -> 2, closedAt setado)", () => {
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    const state: AlarmIssuesState = {
      [key]: { issueNumber: 1, url: "u", missingStreak: 1, closedAt: null },
    };
    let closeCalled = false;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "close") {
        closeCalled = true;
        return ok("");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const now = new Date("2026-08-14T00:00:00Z");
    const { nextState } = applyAlarmReconciliation([], state, { cwd: CWD, closeAfterRuns: 2, run, now });
    assert.equal(closeCalled, true);
    assert.equal(nextState[key].missingStreak, 2);
    assert.equal(nextState[key].closedAt, now.toISOString());
  });

  it("mesmo fingerprint em 2 execuções (via state persistido) -> 1 issue só", () => {
    let createCount = 0;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") {
        createCount++;
        return ok("https://github.com/x/y/issues/9001\n");
      }
      if (args[0] === "issue" && args[1] === "view") return ok(JSON.stringify({ state: "OPEN" }));
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const first = applyAlarmReconciliation([FINDING_A], emptyAlarmIssuesState(), {
      cwd: CWD,
      closeAfterRuns: 2,
      run,
    });
    assert.equal(first.findingOutcomes[0].action, "created");

    const second = applyAlarmReconciliation([FINDING_A], first.nextState, { cwd: CWD, closeAfterRuns: 2, run });
    assert.equal(second.findingOutcomes[0].action, "reused");
    assert.equal(second.findingOutcomes[0].issueNumber, 9001);
    assert.equal(createCount, 1);
  });

  it("issue com marcador no GitHub + estado local apagado -> adota a existente (não duplica)", () => {
    const marker = alarmFindingMarker(FINDING_A.check, FINDING_A.fingerprint);
    let createCalled = false;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") {
        return ok(JSON.stringify([{ number: 555, url: "https://github.com/x/y/issues/555", body: marker }]));
      }
      if (args[0] === "issue" && args[1] === "create") {
        createCalled = true;
        return ok("https://github.com/x/y/issues/999\n");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    // estado local vazio simula o state.json apagado
    const { nextState, findingOutcomes } = applyAlarmReconciliation([FINDING_A], emptyAlarmIssuesState(), {
      cwd: CWD,
      closeAfterRuns: 2,
      run,
    });
    assert.equal(createCalled, false, "não deveria ter criado — deveria ter adotado a existente");
    assert.equal(findingOutcomes[0].action, "reused");
    assert.equal(findingOutcomes[0].issueNumber, 555);
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    assert.equal(nextState[key].issueNumber, 555);
  });

  it("falha na criação -> outcome 'failed' com motivo, estado NÃO avança (cursor não marca como tratado)", () => {
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") return fail("HTTP 403: rate limited");
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const { nextState, findingOutcomes } = applyAlarmReconciliation([FINDING_A], emptyAlarmIssuesState(), {
      cwd: CWD,
      closeAfterRuns: 2,
      run,
    });
    assert.equal(findingOutcomes[0].action, "failed");
    assert.match(findingOutcomes[0].error ?? "", /rate limited/);
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    assert.equal(nextState[key], undefined, "estado não deveria ganhar entry pra um achado que falhou ao criar");
  });

  it("#5172 REGRESSÃO: closeAfterRuns=3, 3 execuções consecutivas sem o achado -> fecha na 3ª, não antes, não nunca", () => {
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    let commentCount = 0;
    let closeCount = 0;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "comment") {
        commentCount++;
        return ok("");
      }
      if (args[0] === "issue" && args[1] === "close") {
        closeCount++;
        return ok("");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    let state: AlarmIssuesState = {
      [key]: { issueNumber: 1, url: "u", missingStreak: 0, closedAt: null },
    };

    // Execução 1: 1ª ausência -> comenta, missingStreak 0 -> 1. Antes do fix,
    // isto já ficava certo (era o caminho `nextStreak === 1`).
    let result = applyAlarmReconciliation([], state, { cwd: CWD, closeAfterRuns: 3, run });
    state = result.nextState;
    assert.equal(commentCount, 1);
    assert.equal(closeCount, 0);
    assert.equal(state[key].missingStreak, 1);
    assert.equal(state[key].closedAt, null);

    // Execução 2: 2ª ausência consecutiva -> nem comenta nem fecha ainda
    // (nextStreak=2 < closeAfterRuns=3), MAS o streak precisa avançar pra 2
    // — é exatamente o incremento que #5172 perdia (ficava travado em 1).
    result = applyAlarmReconciliation([], state, { cwd: CWD, closeAfterRuns: 3, run });
    state = result.nextState;
    assert.equal(commentCount, 1, "não deveria comentar de novo na 2ª ausência");
    assert.equal(closeCount, 0, "ainda não é hora de fechar (nextStreak=2 < 3)");
    assert.equal(state[key].missingStreak, 2, "REGRESSÃO #5172: sem o fix ficaria travado em 1");
    assert.equal(state[key].closedAt, null);

    // Execução 3: 3ª ausência consecutiva -> agora fecha (nextStreak=3 >= 3).
    const now = new Date("2026-08-14T00:00:00Z");
    result = applyAlarmReconciliation([], state, { cwd: CWD, closeAfterRuns: 3, run, now });
    state = result.nextState;
    assert.equal(closeCount, 1, "deveria fechar exatamente na 3ª execução consecutiva");
    assert.equal(state[key].missingStreak, 3);
    assert.equal(state[key].closedAt, now.toISOString());
  });

  it("achado reaparece depois de fechado -> REABRE a issue no GitHub (#5978, não só reusa localmente), closedAt reseta pra null", () => {
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    const state: AlarmIssuesState = {
      [key]: { issueNumber: 1, url: "https://x/1", missingStreak: 2, closedAt: "2026-08-01T00:00:00Z" },
    };
    // #5978: cache sabe que a issue está fechada (closedAt setado) -> ensureAlarmIssue
    // chama 'gh issue reopen' de verdade, nunca trata como reuse silencioso.
    let reopenArgs: string[] | null = null;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "reopen") {
        reopenArgs = args;
        return ok("");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const { nextState, findingOutcomes } = applyAlarmReconciliation([FINDING_A], state, { cwd: CWD, closeAfterRuns: 2, run });
    assert.equal(findingOutcomes[0].action, "reopened");
    assert.ok(reopenArgs, "deveria ter chamado 'gh issue reopen'");
    assert.equal(reopenArgs![2], "1");
    assert.equal(nextState[key].closedAt, null);
    assert.equal(nextState[key].missingStreak, 0);
    assert.equal(nextState[key].issueNumber, 1, "mesma issue reaberta, nunca uma nova");
  });

  describe("#5553 — família estampada em `ensure` + entry de evento nunca auto-fecha (regressão #5525)", () => {
    it("`ensure` estampa `family` do finding na entry de estado (criação)", () => {
      const run: GhRunFn = (args) => {
        if (args[0] === "issue" && args[1] === "list") return ok("[]");
        if (args[0] === "issue" && args[1] === "create") return ok("https://github.com/x/y/issues/9101\n");
        throw new Error(`unexpected: ${args.join(" ")}`);
      };
      const eventoFinding: AlarmFinding = { ...FINDING_A, family: "evento" };
      const { nextState } = applyAlarmReconciliation([eventoFinding], emptyAlarmIssuesState(), {
        cwd: CWD,
        closeAfterRuns: 2,
        run,
      });
      const key = alarmIssueStateKey(eventoFinding.check, eventoFinding.fingerprint);
      assert.equal(nextState[key].family, "evento");
    });

    it("REGRESSÃO #5525: campanha avaliada 1x (family:'evento') some de pending na execução seguinte -> " +
      "NUNCA comenta/fecha, mesmo depois de várias execuções ausente", () => {
      const key = alarmIssueStateKey("clarice-guardrail", "campaign-146");
      let commentCalled = false;
      let closeCalled = false;
      const run: GhRunFn = (args) => {
        if (args[0] === "issue" && args[1] === "comment") {
          commentCalled = true;
          return ok("");
        }
        if (args[0] === "issue" && args[1] === "close") {
          closeCalled = true;
          return ok("");
        }
        throw new Error(`unexpected: ${args.join(" ")}`);
      };
      let state: AlarmIssuesState = {
        [key]: { issueNumber: 5525, url: "https://x/5525", missingStreak: 0, closedAt: null, family: "evento" },
      };
      // A campanha 146 nunca é reavaliada (markEvaluated) — `pending` fica
      // vazio em TODAS as execuções seguintes, indefinidamente.
      for (let i = 0; i < 5; i++) {
        const result = applyAlarmReconciliation([], state, { cwd: CWD, closeAfterRuns: 2, run });
        state = result.nextState;
      }
      assert.equal(commentCalled, false, "nunca deveria comentar 'não reproduz mais' — ninguém consertou nada");
      assert.equal(closeCalled, false, "nunca deveria fechar sozinha — #5525 ficaria enterrada em silêncio");
      assert.equal(state[key].closedAt, null);
      assert.equal(state[key].missingStreak, 0, "streak nunca avança pra uma entry de evento — congelada de propósito");
    });
  });
});

// ─── Allowlist de achados aceitos como limitação permanente (#5364) ────────

describe("isAllowlisted (#5364 — puro)", () => {
  const ALLOWLIST: AlarmAllowlist = [
    {
      check: FINDING_A.check,
      fingerprint: FINDING_A.fingerprint,
      reason: "limitação de plataforma, sem alavanca no código",
      accepted_at: "2026-08-16",
      ref_issue: "#5364",
    },
  ];

  it("check+fingerprint EXATOS -> true", () => {
    assert.equal(isAllowlisted(FINDING_A.check, FINDING_A.fingerprint, ALLOWLIST), true);
  });

  it("fingerprint diferente (mesmo check) -> false — guard contra over-match", () => {
    assert.equal(isAllowlisted(FINDING_A.check, "english-labels:outro achado qualquer", ALLOWLIST), false);
  });

  it("fingerprint similar mas NÃO idêntico (ex: rótulo extra no texto) -> false", () => {
    assert.equal(
      isAllowlisted(
        FINDING_A.check,
        'english-labels:rótulo(s) em inglês residual(is) encontrado(s): "N min read", "Sign Up"',
        ALLOWLIST,
      ),
      false,
    );
  });

  it("check diferente, mesmo fingerprint -> false", () => {
    assert.equal(isAllowlisted("outro-check", FINDING_A.fingerprint, ALLOWLIST), false);
  });

  it("allowlist vazia -> sempre false", () => {
    assert.equal(isAllowlisted(FINDING_A.check, FINDING_A.fingerprint, []), false);
  });
});

describe("planAlarmReconciliation com allowlist (#5364)", () => {
  const ALLOWLIST: AlarmAllowlist = [
    {
      check: FINDING_A.check,
      fingerprint: FINDING_A.fingerprint,
      reason: "limitação de plataforma, sem alavanca no código",
      accepted_at: "2026-08-16",
      ref_issue: "#5364",
    },
  ];

  it("(a) achado pendente com fingerprint na allowlist -> NENHUMA ação, mesmo achado reproduzindo", () => {
    const actions = planAlarmReconciliation([FINDING_A], emptyAlarmIssuesState(), 2, ALLOWLIST);
    assert.deepEqual(actions, []);
  });

  it("(a) issue já rastreada localmente pra um fingerprint allowlisted -> nunca comenta/fecha/avança streak, mesmo o achado sumindo", () => {
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    const state: AlarmIssuesState = {
      [key]: { issueNumber: 1, url: "u", missingStreak: 0, closedAt: null },
    };
    // achado ausente de `pending` (sumiu) — sem allowlist isso geraria
    // comment_resolved; com allowlist, a entry fica congelada.
    const actions = planAlarmReconciliation([], state, 2, ALLOWLIST);
    assert.deepEqual(actions, []);
  });

  it("(b) fingerprint FORA da allowlist -> comportamento inalterado, cria/reabre normalmente", () => {
    const OTHER: AlarmFinding = {
      check: "http-self-link",
      fingerprint: "http-self-link:algum outro achado",
      title: "outro achado",
      body: "corpo",
      family: "estado",
    };
    const actions = planAlarmReconciliation([OTHER], emptyAlarmIssuesState(), 2, ALLOWLIST);
    assert.deepEqual(actions, [{ kind: "ensure", finding: OTHER }]);
  });

  it("(c) fingerprint similar mas NÃO exato (texto do achado mudou) -> NÃO é silenciado, action ensure normal", () => {
    const CHANGED: AlarmFinding = {
      ...FINDING_A,
      fingerprint: 'english-labels:rótulo(s) em inglês residual(is) encontrado(s): "N min read", "Sign Up"',
    };
    const actions = planAlarmReconciliation([CHANGED], emptyAlarmIssuesState(), 2, ALLOWLIST);
    assert.deepEqual(actions, [{ kind: "ensure", finding: CHANGED }]);
  });

  it("sem allowlist (default []) -> comportamento idêntico ao de antes do #5364", () => {
    const actions = planAlarmReconciliation([FINDING_A], emptyAlarmIssuesState(), 2);
    assert.deepEqual(actions, [{ kind: "ensure", finding: FINDING_A }]);
  });

  it("achado allowlisted convive com achado não-allowlisted na mesma execução -> só o não-allowlisted gera ação", () => {
    const OTHER: AlarmFinding = {
      check: "http-self-link",
      fingerprint: "http-self-link:algum outro achado",
      title: "outro achado",
      body: "corpo",
      family: "estado",
    };
    const actions = planAlarmReconciliation([FINDING_A, OTHER], emptyAlarmIssuesState(), 2, ALLOWLIST);
    assert.deepEqual(actions, [{ kind: "ensure", finding: OTHER }]);
  });
});

describe("applyAlarmReconciliation com allowlist (#5364) — I/O injetado", () => {
  const ALLOWLIST: AlarmAllowlist = [
    {
      check: FINDING_A.check,
      fingerprint: FINDING_A.fingerprint,
      reason: "limitação de plataforma, sem alavanca no código",
      accepted_at: "2026-08-16",
      ref_issue: "#5364",
    },
  ];

  it("(a) achado allowlisted reproduzindo indefinidamente -> gh NUNCA é chamado, nenhuma entry de estado criada", () => {
    const run: GhRunFn = () => {
      throw new Error("não deveria chamar gh pra um achado allowlisted");
    };
    const { nextState, findingOutcomes } = applyAlarmReconciliation([FINDING_A], emptyAlarmIssuesState(), {
      cwd: CWD,
      closeAfterRuns: 2,
      run,
      allowlist: ALLOWLIST,
    });
    assert.deepEqual(findingOutcomes, []);
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    assert.equal(nextState[key], undefined);
  });

  it("(a) rodando 3x seguidas com o mesmo achado allowlisted -> segue sem gh/estado em toda execução (nunca reabre)", () => {
    const run: GhRunFn = () => {
      throw new Error("não deveria chamar gh pra um achado allowlisted");
    };
    let state = emptyAlarmIssuesState();
    for (let i = 0; i < 3; i++) {
      const result = applyAlarmReconciliation([FINDING_A], state, {
        cwd: CWD,
        closeAfterRuns: 2,
        run,
        allowlist: ALLOWLIST,
      });
      state = result.nextState;
      assert.deepEqual(result.findingOutcomes, []);
    }
    assert.deepEqual(state, {});
  });

  it("(b) achado FORA da allowlist -> cria issue normalmente (comportamento inalterado)", () => {
    const OTHER: AlarmFinding = {
      check: "http-self-link",
      fingerprint: "http-self-link:algum outro achado",
      title: "outro achado",
      body: "corpo",
      family: "estado",
    };
    let createCalled = false;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") {
        createCalled = true;
        return ok("https://github.com/x/y/issues/8001\n");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const { findingOutcomes } = applyAlarmReconciliation([OTHER], emptyAlarmIssuesState(), {
      cwd: CWD,
      closeAfterRuns: 2,
      run,
      allowlist: ALLOWLIST,
    });
    assert.equal(createCalled, true);
    assert.equal(findingOutcomes[0].action, "created");
    assert.equal(findingOutcomes[0].issueNumber, 8001);
  });
});

describe("aggregateFindingsOnDebut (#6572 — generaliza o cap de estreia do #6562/#6564)", () => {
  function findingWithGroup(fingerprint: string, group: string): AlarmFinding {
    return {
      check: "some-check",
      fingerprint,
      title: `achado ${fingerprint}`,
      body: "corpo",
      family: "estado",
      group,
    };
  }

  const buildAggregate = (group: string, findings: readonly AlarmFinding[]): AlarmFinding => ({
    check: "some-check",
    fingerprint: `${group}:aggregate`,
    title: `${findings.length} achados agregados de ${group}`,
    body: findings.map((f) => f.fingerprint).join(", "),
    family: "estado",
  });

  it("findings sem group NUNCA agregam, mesmo em estreia acima do teto (retrocompat — comportamento pré-#6572)", () => {
    const findings: AlarmFinding[] = [
      { check: "x", fingerprint: "1", title: "t1", body: "b", family: "estado" },
      { check: "x", fingerprint: "2", title: "t2", body: "b", family: "estado" },
      { check: "x", fingerprint: "3", title: "t3", body: "b", family: "estado" },
    ];
    const result = aggregateFindingsOnDebut(findings, { threshold: 1, stateIsEmpty: true, buildAggregate });
    assert.deepEqual(result, findings);
  });

  it("state vazio + volume ACIMA do teto → 1 finding agregado por grupo", () => {
    const findings = [
      findingWithGroup("a", "grupo-x"),
      findingWithGroup("b", "grupo-x"),
      findingWithGroup("c", "grupo-x"),
    ];
    const result = aggregateFindingsOnDebut(findings, { threshold: 2, stateIsEmpty: true, buildAggregate });
    assert.equal(result.length, 1);
    assert.equal(result[0].fingerprint, "grupo-x:aggregate");
    assert.equal(result[0].title, "3 achados agregados de grupo-x");
  });

  it("state vazio + volume NO/abaixo do teto → passa direto, 1-por-finding", () => {
    const findings = [findingWithGroup("a", "grupo-x"), findingWithGroup("b", "grupo-x")];
    const result = aggregateFindingsOnDebut(findings, { threshold: 2, stateIsEmpty: true, buildAggregate });
    assert.deepEqual(result, findings);
  });

  it("state NÃO vazio → nunca agrega, mesmo acima do teto (agregação só na estreia)", () => {
    const findings = [
      findingWithGroup("a", "grupo-x"),
      findingWithGroup("b", "grupo-x"),
      findingWithGroup("c", "grupo-x"),
    ];
    const result = aggregateFindingsOnDebut(findings, { threshold: 2, stateIsEmpty: false, buildAggregate });
    assert.deepEqual(result, findings);
  });

  it("grupos distintos são agregados/preservados independentemente uns dos outros", () => {
    const findings = [
      findingWithGroup("a", "grupo-x"),
      findingWithGroup("b", "grupo-x"),
      findingWithGroup("c", "grupo-x"), // grupo-x: 3 > threshold(2) → agrega
      findingWithGroup("d", "grupo-y"), // grupo-y: 1 <= threshold(2) → passa direto
    ];
    const result = aggregateFindingsOnDebut(findings, { threshold: 2, stateIsEmpty: true, buildAggregate });
    assert.equal(result.length, 2);
    const aggregated = result.find((f) => f.fingerprint === "grupo-x:aggregate");
    const passthrough = result.find((f) => f.fingerprint === "d");
    assert.ok(aggregated);
    assert.ok(passthrough);
  });
});
