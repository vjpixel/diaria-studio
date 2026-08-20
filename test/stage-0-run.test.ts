/**
 * test/stage-0-run.test.ts (#5415, incremento 1/3)
 *
 * Cobre `scripts/stage-0-run.ts` — o orquestrador determinístico do Stage 0
 * (Preflight) do orchestrator diar.ia.br. Mesmo padrão de
 * `test/audience-run.test.ts`/`test/clarice-novos-run.test.ts`: `exec`/
 * `execAsync` são fakes injetados (nenhum spawn real, nenhuma rede real,
 * nenhum `data/` real tocado) — os testes verificam RESULTADO (exit code,
 * shape do JSON) e a SEQUÊNCIA/ARGS dos passos que importam.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync as nodeMkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runStage0,
  parseStage0RunArgs,
  editionIsoFromAammdd,
  isoDateOnly,
  subtractDaysIso,
  defaultWindowDays,
  parseStepJson,
  Stage0Abort,
  type Stage0RunDeps,
  type ExecFn,
  type AsyncExecFn,
  type StepResult,
} from "../scripts/stage-0-run.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(stdout = "{}"): StepResult {
  return { code: 0, stdout, stderr: "" };
}
function fail(code = 1, stderr = "erro"): StepResult {
  return { code, stdout: "", stderr };
}

/** Fake exec dispatcher — casa pelo NOME DO ARQUIVO (basename) do script,
 * não pelo path relativo inteiro, pra os testes não quebrarem se o script
 * mudar de subdiretório. Handlers ausentes caem no default (sucesso, `{}`). */
function makeFakeExec(handlers: Record<string, (args: string[]) => StepResult> = {}) {
  const calls: Array<{ script: string; args: string[] }> = [];
  const exec: ExecFn = (script, args) => {
    calls.push({ script, args });
    const base = script.split("/").pop() ?? script;
    const handler = handlers[base];
    return handler ? handler(args) : ok("{}");
  };
  return { exec, calls };
}

function makeFakeExecAsync(handlers: Record<string, (args: string[]) => StepResult> = {}) {
  const calls: Array<{ script: string; args: string[] }> = [];
  const execAsync: AsyncExecFn = async (script, args) => {
    calls.push({ script, args });
    const base = script.split("/").pop() ?? script;
    const handler = handlers[base];
    return handler ? handler(args) : ok("{}");
  };
  return { execAsync, calls };
}

function baseDeps(overrides: Partial<Stage0RunDeps> = {}): Stage0RunDeps {
  const { exec } = makeFakeExec();
  const { execAsync } = makeFakeExecAsync();
  return {
    rootDir: "/fake-root",
    now: () => new Date("2026-04-23T08:00:00Z"),
    exec,
    execAsync,
    existsSync: () => false,
    mkdirSync: () => {},
    writeFile: (p) => {
      throw new Error(`writeFile não mockado: ${p}`);
    },
    readFile: (p) => {
      if (p.endsWith("platform.config.json")) {
        return JSON.stringify({ newsletter_auto_capture: { enabled: false, senders: [], since_hours: 48 } });
      }
      throw new Error(`readFile não mockado: ${p}`);
    },
    ...overrides,
  };
}

/** Um exec "feliz" mínimo que faz `find-current-edition --resolve` devolver
 * um path fixo, e todo o resto responder sucesso genérico — usado como base
 * pros testes de fase `continue` que não precisam customizar quase nada. */
function happyExecHandlers(overrides: Record<string, (args: string[]) => StepResult> = {}): Record<string, (args: string[]) => StepResult> {
  return {
    "find-current-edition.ts": () => ({ code: 0, stdout: "data/editions/2604/260423\n", stderr: "" }),
    "refresh-dedup.ts": () => ok(JSON.stringify({ new_posts: 2, most_recent_date: "2026-04-22" })),
    "check-invariants.ts": () => ok(JSON.stringify({ passed: true, violations: [] })),
    "capture-stage-usage.ts": () => ok(JSON.stringify({ source: "ok" })),
    "find-pending-issue-drafts.ts": () => ok("[]"),
    "find-last-edition-with-fb.ts": () => ({ code: 0, stdout: "data/editions/2604/260422\n", stderr: "" }),
    "check-prev-social-status.ts": () => ok(JSON.stringify({ findings: [], total: 0 })),
    ...overrides,
  };
}

function happyExecAsyncHandlers(overrides: Record<string, (args: string[]) => StepResult> = {}): Record<string, (args: string[]) => StepResult> {
  return {
    "merge-local-pending.ts": () => ok(JSON.stringify({ pending_found: 0, editions: [] })),
    "sync-eia-used.ts": () => ok(JSON.stringify({ scanned: 3, added: 0, already_present: 3, skipped_no_meta: 0 })),
    "check-dedup-freshness.ts": () => ok(JSON.stringify({ ok: true, most_recent: "2026-04-22", age_hours: 12 })),
    "beehiiv-sync.ts": () => ok(JSON.stringify({ posts_needing_clicks: [] })),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Funções puras — datas
// ---------------------------------------------------------------------------

describe("editionIsoFromAammdd", () => {
  it("converte AAMMDD para YYYY-MM-DD", () => {
    assert.equal(editionIsoFromAammdd("260423"), "2026-04-23");
  });
  it("lança Stage0Abort em formato inválido", () => {
    assert.throws(() => editionIsoFromAammdd("abc"), Stage0Abort);
    assert.throws(() => editionIsoFromAammdd("2604234"), Stage0Abort);
  });
});

describe("isoDateOnly / subtractDaysIso", () => {
  it("isoDateOnly trunca pra data", () => {
    assert.equal(isoDateOnly(new Date("2026-04-23T14:32:00Z")), "2026-04-23");
  });
  it("subtractDaysIso subtrai em UTC", () => {
    assert.equal(subtractDaysIso("2026-04-23", 4), "2026-04-19");
    assert.equal(subtractDaysIso("2026-04-01", 3), "2026-03-29");
  });
});

describe("defaultWindowDays", () => {
  it("quarta/quinta/sexta = 3", () => {
    assert.equal(defaultWindowDays(new Date("2026-04-22T00:00:00Z")), 3); // wed
    assert.equal(defaultWindowDays(new Date("2026-04-23T00:00:00Z")), 3); // thu
    assert.equal(defaultWindowDays(new Date("2026-04-24T00:00:00Z")), 3); // fri
  });
  it("segunda/terça e fim de semana = 4", () => {
    assert.equal(defaultWindowDays(new Date("2026-04-20T00:00:00Z")), 4); // mon
    assert.equal(defaultWindowDays(new Date("2026-04-21T00:00:00Z")), 4); // tue
    assert.equal(defaultWindowDays(new Date("2026-04-25T00:00:00Z")), 4); // sat
    assert.equal(defaultWindowDays(new Date("2026-04-26T00:00:00Z")), 4); // sun
  });
});

// ---------------------------------------------------------------------------
// parseStepJson
// ---------------------------------------------------------------------------

describe("parseStepJson", () => {
  it("parseia JSON puro", () => {
    assert.deepEqual(parseStepJson('{"a":1}'), { a: 1 });
  });
  it("ignora prefixo antes do primeiro { ou [", () => {
    assert.deepEqual(parseStepJson('log line\n{"a":1}'), { a: 1 });
  });
  it("stdout vazio -> undefined", () => {
    assert.equal(parseStepJson(""), undefined);
  });
  it("JSON inválido -> undefined (nunca lança)", () => {
    assert.equal(parseStepJson("{not json"), undefined);
  });
});

// ---------------------------------------------------------------------------
// parseStage0RunArgs
// ---------------------------------------------------------------------------

describe("parseStage0RunArgs", () => {
  it("phase default é preflight", () => {
    const o = parseStage0RunArgs(["--edition", "260423"]);
    assert.equal(o.phase, "preflight");
    assert.equal(o.edition, "260423");
    assert.equal(o.autoApprove, false);
    assert.equal(o.preGate, false);
  });

  it("--edition ausente -> Stage0Abort", () => {
    assert.throws(() => parseStage0RunArgs([]), Stage0Abort);
  });

  it("--edition mal formado -> Stage0Abort", () => {
    assert.throws(() => parseStage0RunArgs(["--edition", "abc"]), Stage0Abort);
  });

  it("--phase inválido -> Stage0Abort", () => {
    assert.throws(() => parseStage0RunArgs(["--edition", "260423", "--phase", "bogus"]), Stage0Abort);
  });

  it("--phase continue sem os 3 --mcp-* -> Stage0Abort", () => {
    assert.throws(() => parseStage0RunArgs(["--edition", "260423", "--phase", "continue"]), Stage0Abort);
    assert.throws(
      () => parseStage0RunArgs(["--edition", "260423", "--phase", "continue", "--mcp-chrome", "true"]),
      Stage0Abort,
    );
  });

  it("--phase continue com os 3 --mcp-* -> parseia bools", () => {
    const o = parseStage0RunArgs([
      "--edition",
      "260423",
      "--phase",
      "continue",
      "--mcp-chrome",
      "true",
      "--mcp-gmail",
      "false",
      "--mcp-beehiiv",
      "true",
      "--auto-approve",
      "--pre-gate",
      "--window-days",
      "5",
    ]);
    assert.equal(o.mcpChrome, true);
    assert.equal(o.mcpGmail, false);
    assert.equal(o.mcpBeehiiv, true);
    assert.equal(o.autoApprove, true);
    assert.equal(o.preGate, true);
    assert.equal(o.windowDays, 5);
  });

  it("--mcp-chrome com valor inválido -> Stage0Abort", () => {
    assert.throws(
      () => parseStage0RunArgs(["--edition", "260423", "--phase", "continue", "--mcp-chrome", "yes", "--mcp-gmail", "true", "--mcp-beehiiv", "true"]),
      Stage0Abort,
    );
  });

  it("--window-days não-inteiro -> Stage0Abort", () => {
    assert.throws(() => parseStage0RunArgs(["--edition", "260423", "--window-days", "abc"]), Stage0Abort);
    assert.throws(() => parseStage0RunArgs(["--edition", "260423", "--window-days", "0"]), Stage0Abort);
  });
});

// ---------------------------------------------------------------------------
// runStage0 — fase "preflight" (reconnaissance, zero escrita)
// ---------------------------------------------------------------------------

describe("runStage0 --phase preflight", () => {
  it("resolve EDITION_DIR/datas e pede os 3 pings MCP, sem tocar log-event/mkdir/stage-status/0b-bis", async () => {
    const mkdirCalls: string[] = [];
    const { exec, calls } = makeFakeExec({
      "find-current-edition.ts": () => ({ code: 0, stdout: "data/editions/2604/260423\n", stderr: "" }),
      "check-cloudflare-token.ts": () => ok(),
      "clarice-healthcheck.ts": () => ok(),
      "preflight-external-locks.ts": () => ok(),
    });
    const deps = baseDeps({ exec, mkdirSync: (p) => mkdirCalls.push(p) });

    const result = await runStage0(["--edition", "260423", "--window-days", "4", "--now", "2026-04-23T08:00:00Z"], deps);

    assert.equal(result.code, 0);
    assert.equal(result.phase, "preflight");
    assert.equal(result.editionDir, "data/editions/2604/260423");
    assert.equal(result.editionIso, "2026-04-23");
    assert.equal(result.anchorIso, "2026-04-23");
    assert.equal(result.cutoffIso, "2026-04-19");
    assert.equal(result.windowDays, 4);
    assert.equal(result.clariceRest, true);
    assert.equal(result.cloudflareTokenOk, true);
    assert.ok(result.needsMcpProbes);
    assert.match(result.needsMcpProbes!.chrome, /tabs_context_mcp/);
    assert.match(result.needsMcpProbes!.gmail, /list_labels/);
    assert.match(result.needsMcpProbes!.beehiiv, /get_current_user/);
    assert.deepEqual(result.pendingAgentDispatch, []);
    assert.deepEqual(result.pendingHumanDecision, []);
    assert.ok(result.delegatedSteps.some((s) => s.startsWith("0n")));
    assert.ok(result.delegatedSteps.some((s) => s.startsWith("0-replies")));

    // Zero escrita — mkdir nunca chamado, log-event/stage-status/preflight-state
    // nunca disparados na fase de reconnaissance.
    assert.equal(mkdirCalls.length, 0);
    assert.ok(!calls.some((c) => c.script.includes("log-event")));
    assert.ok(!calls.some((c) => c.script.includes("update-stage-status")));
    assert.ok(!calls.some((c) => c.script.includes("preflight-state")));
    assert.ok(!calls.some((c) => c.script.includes("fetch-newsletter-threads")));
  });

  it("sinaliza clariceRest=false / cloudflareTokenOk=false quando os checks HTTPS falham (fail-soft, nunca aborta)", async () => {
    const { exec } = makeFakeExec({
      "find-current-edition.ts": () => ({ code: 0, stdout: "data/editions/2604/260423\n", stderr: "" }),
      "check-cloudflare-token.ts": () => fail(1),
      "clarice-healthcheck.ts": () => fail(2),
      "preflight-external-locks.ts": () => fail(1),
      "render-halt-banner.ts": () => ok("banner text"),
    });
    const deps = baseDeps({ exec });
    const result = await runStage0(["--edition", "260423"], deps);
    assert.equal(result.code, 0);
    assert.equal(result.clariceRest, false);
    assert.equal(result.cloudflareTokenOk, false);
  });
});

// ---------------------------------------------------------------------------
// runStage0 — fase "continue" (execução real)
// ---------------------------------------------------------------------------

describe("runStage0 --phase continue — caminho feliz", () => {
  it("roda a sequência completa e devolve code 0, sem pendências", async () => {
    const { exec, calls } = makeFakeExec(happyExecHandlers());
    const { execAsync, calls: asyncCalls } = makeFakeExecAsync(happyExecAsyncHandlers());
    const deps = baseDeps({ exec, execAsync });

    const argv = [
      "--edition",
      "260423",
      "--phase",
      "continue",
      "--mcp-chrome",
      "true",
      "--mcp-gmail",
      "true",
      "--mcp-beehiiv",
      "true",
    ];
    const result = await runStage0(argv, deps);

    assert.equal(result.code, 0);
    assert.equal(result.phase, "continue");
    assert.equal(result.editionDir, "data/editions/2604/260423");
    assert.deepEqual(result.pendingAgentDispatch, []);
    assert.deepEqual(result.pendingHumanDecision, []);
    assert.equal(result.haltRequired, undefined);

    // preflight-state recebeu os 5 sinais corretos.
    const preflightStateCall = calls.find((c) => c.script.includes("preflight-state"));
    assert.ok(preflightStateCall);
    assert.ok(preflightStateCall!.args.includes("--chrome-mcp"));
    assert.ok(preflightStateCall!.args.includes("true"));

    // refresh-dedup e maintain-valid-editions-window rodaram.
    assert.ok(calls.some((c) => c.script.includes("refresh-dedup")));
    const maintainCall = calls.find((c) => c.script.includes("maintain-valid-editions-window"));
    assert.ok(maintainCall);
    assert.ok(maintainCall!.args.includes("--current"));
    assert.ok(maintainCall!.args.includes("260423"));

    // batch paralelo rodou os 4.
    assert.ok(asyncCalls.some((c) => c.script.includes("merge-local-pending")));
    assert.ok(asyncCalls.some((c) => c.script.includes("sync-eia-used")));
    assert.ok(asyncCalls.some((c) => c.script.includes("check-dedup-freshness")));
    assert.ok(asyncCalls.some((c) => c.script.includes("beehiiv-sync")));

    // 0i, 0z rodaram.
    assert.ok(calls.some((c) => c.script.includes("update-audience")));
    assert.ok(calls.some((c) => c.script.includes("snapshot-audience-profile")));
    assert.ok(calls.some((c) => c.script.includes("check-invariants")));
    const statusDoneCall = calls.find(
      (c) => c.script.includes("update-stage-status") && c.args.includes("done"),
    );
    assert.ok(statusDoneCall);
  });

  it("HALT (code 2) quando maintain-valid-editions-window falha — nunca bypassa mesmo com --auto-approve", async () => {
    const { exec, calls } = makeFakeExec(
      happyExecHandlers({
        "maintain-valid-editions-window.ts": () => fail(2, "read_failed"),
        "render-halt-banner.ts": () => ok("=== PIPELINE PAROU ==="),
      }),
    );
    const { execAsync } = makeFakeExecAsync(happyExecAsyncHandlers());
    const deps = baseDeps({ exec, execAsync });

    const result = await runStage0(
      ["--edition", "260423", "--phase", "continue", "--mcp-chrome", "true", "--mcp-gmail", "true", "--mcp-beehiiv", "true", "--auto-approve"],
      deps,
    );

    assert.equal(result.code, 2);
    assert.ok(result.haltRequired);
    assert.match(result.haltRequired!.reason, /read_failed/);

    // Nunca chegou no batch paralelo nem em 0z — parou no halt.
    assert.ok(!calls.some((c) => c.script.includes("check-invariants")));
  });

  it("erro duro (code 1) quando refresh-dedup falha — nunca prossegue com dedup stale", async () => {
    const { exec } = makeFakeExec(
      happyExecHandlers({
        "refresh-dedup.ts": () => fail(1, "beehiiv api down"),
      }),
    );
    const { execAsync } = makeFakeExecAsync(happyExecAsyncHandlers());
    const deps = baseDeps({ exec, execAsync });

    const result = await runStage0(
      ["--edition", "260423", "--phase", "continue", "--mcp-chrome", "true", "--mcp-gmail", "true", "--mcp-beehiiv", "true"],
      deps,
    );

    assert.equal(result.code, 1);
    assert.ok(result.notes.some((n) => /refresh-dedup/.test(n)));
  });

  it("erro duro (code 1) quando check-invariants --stage 0 reprova (exit 1)", async () => {
    const { exec } = makeFakeExec(
      happyExecHandlers({
        "check-invariants.ts": () => ({ code: 1, stdout: JSON.stringify({ passed: false, violations: [{ rule: "x" }] }), stderr: "" }),
      }),
    );
    const { execAsync } = makeFakeExecAsync(happyExecAsyncHandlers());
    const deps = baseDeps({ exec, execAsync });

    const result = await runStage0(
      ["--edition", "260423", "--phase", "continue", "--mcp-chrome", "true", "--mcp-gmail", "true", "--mcp-beehiiv", "true"],
      deps,
    );

    assert.equal(result.code, 1);
    // Stage 0 nunca foi marcado done.
  });

  it("0h.2 — posts_needing_clicks não-vazio vira pendingAgentDispatch, grava manifest de verdade (dir temp real), nunca dispatcha Agent sozinho", async () => {
    const manifest = [{ id: "post_1", title: "Título A" }];
    const { exec } = makeFakeExec(
      happyExecHandlers({
        "beehiiv-sync.ts": () => ok(JSON.stringify({ posts_needing_clicks: manifest })),
      }),
    );
    const { execAsync } = makeFakeExecAsync(
      happyExecAsyncHandlers({
        "beehiiv-sync.ts": () => ok(JSON.stringify({ posts_needing_clicks: manifest })),
      }),
    );
    const root = mkdtempSync(join(tmpdir(), "stage-0-run-0h2-"));
    try {
      const deps = baseDeps({
        rootDir: root,
        exec,
        execAsync,
        writeFile: (p, c) => writeFileSync(p, c, "utf8"),
        mkdirSync: (p) => {
          // find-current-edition.ts é mockado (retorna path fixo), então
          // ninguém cria o diretório de verdade — criar aqui pro
          // writeFile real do manifest ter onde escrever.
          try {
            nodeMkdirSync(p, { recursive: true });
          } catch {
            /* noop */
          }
        },
        readFile: (p) => {
          if (p.endsWith("platform.config.json")) return JSON.stringify({ newsletter_auto_capture: { enabled: false } });
          throw new Error(`unmocked readFile: ${p}`);
        },
      });
      // O manifest é escrito sob editionDir/_internal — garantir que o
      // diretório existe (find-current-edition.ts é mockado, não roda de
      // verdade, então ninguém cria a árvore de pastas).
      nodeMkdirSync(join(root, "data/editions/2604/260423/_internal"), { recursive: true });

      const result = await runStage0(
        ["--edition", "260423", "--phase", "continue", "--mcp-chrome", "true", "--mcp-gmail", "true", "--mcp-beehiiv", "true"],
        deps,
      );

      assert.equal(result.code, 0);
      assert.equal(result.pendingAgentDispatch.length, 1);
      assert.equal(result.pendingAgentDispatch[0].step, "0h.2");
      assert.equal(result.pendingAgentDispatch[0].agent, "beehiiv-clicks-enricher");
      assert.ok(result.pendingAgentDispatch[0].manifestPath?.includes("posts-needing-clicks.json"));

      // Assertar o CONTEÚDO gravado de verdade, não só a forma do dispatch.
      const manifestPath = join(root, result.pendingAgentDispatch[0].manifestPath!);
      const written = JSON.parse(readFileSync(manifestPath, "utf8"));
      assert.deepEqual(written, manifest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("0h.2 — falha ao gravar o manifest não gera pendingAgentDispatch (sem manifest fantasma), fica fail-soft", async () => {
    const manifest = [{ id: "post_1", title: "Título A" }];
    const { exec } = makeFakeExec(
      happyExecHandlers({
        "beehiiv-sync.ts": () => ok(JSON.stringify({ posts_needing_clicks: manifest })),
      }),
    );
    const { execAsync } = makeFakeExecAsync(
      happyExecAsyncHandlers({
        "beehiiv-sync.ts": () => ok(JSON.stringify({ posts_needing_clicks: manifest })),
      }),
    );
    const deps = baseDeps({
      exec,
      execAsync,
      writeFile: () => {
        throw new Error("disco cheio");
      },
      readFile: (p) => {
        if (p.endsWith("platform.config.json")) return JSON.stringify({ newsletter_auto_capture: { enabled: false } });
        throw new Error(`unmocked readFile: ${p}`);
      },
    });

    const result = await runStage0(
      ["--edition", "260423", "--phase", "continue", "--mcp-chrome", "true", "--mcp-gmail", "true", "--mcp-beehiiv", "true"],
      deps,
    );

    // fail-soft: Stage 0 não aborta.
    assert.equal(result.code, 0);
    // mas SEM manifest fantasma: nenhum dispatch pendente pro enricher.
    assert.equal(result.pendingAgentDispatch.length, 0);
  });

  it("0g — dedup freshness stale vira pendingHumanDecision, não aborta o Stage 0", async () => {
    const { exec } = makeFakeExec(happyExecHandlers());
    const { execAsync } = makeFakeExecAsync(
      happyExecAsyncHandlers({
        "check-dedup-freshness.ts": () => ({ code: 1, stdout: JSON.stringify({ ok: false, most_recent: "2026-04-18", age_hours: 96 }), stderr: "" }),
      }),
    );
    const deps = baseDeps({ exec, execAsync });

    const result = await runStage0(
      ["--edition", "260423", "--phase", "continue", "--mcp-chrome", "true", "--mcp-gmail", "true", "--mcp-beehiiv", "true"],
      deps,
    );

    assert.equal(result.code, 0);
    assert.equal(result.pendingHumanDecision.length, 1);
    assert.equal(result.pendingHumanDecision[0].step, "0g");
  });

  it("0j — issues-draft pendentes viram pendingHumanDecision, nunca dispatcham auto-reporter sozinho", async () => {
    const drafts = [{ edition: "260422", draft_path: "x", signal_count: 3, has_report: false }];
    const { exec } = makeFakeExec(
      happyExecHandlers({
        "find-pending-issue-drafts.ts": () => ok(JSON.stringify(drafts)),
      }),
    );
    const { execAsync } = makeFakeExecAsync(happyExecAsyncHandlers());
    const deps = baseDeps({ exec, execAsync });

    const result = await runStage0(
      ["--edition", "260423", "--phase", "continue", "--mcp-chrome", "true", "--mcp-gmail", "true", "--mcp-beehiiv", "true"],
      deps,
    );

    assert.equal(result.code, 0);
    assert.equal(result.pendingHumanDecision.length, 1);
    assert.equal(result.pendingHumanDecision[0].step, "0j");
    assert.match(result.pendingHumanDecision[0].detail, /260422/);
  });

  it("delegatedSteps sempre lista 0n e 0-replies, mesmo no caminho feliz", async () => {
    const { exec } = makeFakeExec(happyExecHandlers());
    const { execAsync } = makeFakeExecAsync(happyExecAsyncHandlers());
    const deps = baseDeps({ exec, execAsync });
    const result = await runStage0(
      ["--edition", "260423", "--phase", "continue", "--mcp-chrome", "true", "--mcp-gmail", "true", "--mcp-beehiiv", "true"],
      deps,
    );
    assert.ok(result.delegatedSteps.some((s) => s.startsWith("0n")));
    assert.ok(result.delegatedSteps.some((s) => s.startsWith("0-replies")));
  });

  it("0b-bis roda fetch-newsletter-threads quando newsletter_auto_capture está habilitado, e detecta o guard #1756 (threads_found>0 mas arquivo vazio)", async () => {
    const { exec, calls } = makeFakeExec(
      happyExecHandlers({
        "fetch-newsletter-threads.ts": () => ok(JSON.stringify({ threads_found: 3, threads_written: 0, skipped_no_body: 3 })),
      }),
    );
    const { execAsync } = makeFakeExecAsync(happyExecAsyncHandlers());
    const logEventCalls: string[][] = [];
    const deps = baseDeps({
      exec: (script, args) => {
        if (script.includes("log-event")) logEventCalls.push(args);
        return exec(script, args);
      },
      execAsync,
      existsSync: () => false, // captured-newsletters.json nunca existe -> guard dispara
      readFile: (p) => {
        if (p.endsWith("platform.config.json")) {
          return JSON.stringify({
            newsletter_auto_capture: { enabled: true, senders: ["a@example.com", "b@example.com"], since_hours: 48 },
          });
        }
        throw new Error(`unmocked readFile: ${p}`);
      },
    });

    const result = await runStage0(
      ["--edition", "260423", "--phase", "continue", "--mcp-chrome", "true", "--mcp-gmail", "true", "--mcp-beehiiv", "true"],
      deps,
    );

    assert.equal(result.code, 0);
    assert.ok(calls.some((c) => c.script.includes("fetch-newsletter-threads")));
    // Guard #1756: threads_found>0 + arquivo ausente -> warn loud via log-event.
    assert.ok(logEventCalls.some((args) => args.includes("warn") && args.some((a) => a.includes("threads_found"))));
  });
});
