import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  signalsFromSourceHealth,
  signalsFromPublished,
  signalsFromRunLog,
  signalsFromMcpUnavailable,
  signalsFromTestWarnings,
  normalizeMessageKey,
  collectSignals,
  writeDraft,
  pairDisconnectReconnect,
  severityFromDuration,
} from "../scripts/collect-edition-signals.ts";

describe("signalsFromSourceHealth", () => {
  it("detecta streak de 3 failures consecutivos", () => {
    const signals = signalsFromSourceHealth({
      sources: {
        "Tecnoblog (IA)": {
          recent_outcomes: [
            { outcome: "ok" },
            { outcome: "fail" },
            { outcome: "fail" },
            { outcome: "fail" },
          ],
        },
      },
    });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].kind, "source_streak");
    assert.equal(signals[0].severity, "medium");
    assert.equal(signals[0].details.consecutive_failures, 3);
  });

  it("streak ≥ 5 vira severity high", () => {
    const signals = signalsFromSourceHealth({
      sources: {
        X: {
          recent_outcomes: [
            { outcome: "fail" },
            { outcome: "fail" },
            { outcome: "fail" },
            { outcome: "fail" },
            { outcome: "fail" },
          ],
        },
      },
    });
    assert.equal(signals[0].severity, "high");
  });

  it("streak < 3 não dispara", () => {
    const signals = signalsFromSourceHealth({
      sources: {
        X: { recent_outcomes: [{ outcome: "fail" }, { outcome: "fail" }] },
      },
    });
    assert.equal(signals.length, 0);
  });

  it("mix de fontes retorna só as que batem threshold", () => {
    const signals = signalsFromSourceHealth({
      sources: {
        good: { recent_outcomes: [{ outcome: "ok" }, { outcome: "ok" }] },
        bad: {
          recent_outcomes: [
            { outcome: "fail" },
            { outcome: "fail" },
            { outcome: "fail" },
          ],
        },
      },
    });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].details.source, "bad");
  });

  it("source sem recent_outcomes é ignorado", () => {
    const signals = signalsFromSourceHealth({ sources: { X: {} } });
    assert.equal(signals.length, 0);
  });

  it("recent_outcomes vazio é ignorado", () => {
    const signals = signalsFromSourceHealth({
      sources: { X: { recent_outcomes: [] } },
    });
    assert.equal(signals.length, 0);
  });
});

describe("signalsFromPublished", () => {
  it("unicode_corruption vira signal high severity", () => {
    const signals = signalsFromPublished({
      draft_url: "https://app.beehiiv.com/posts/x/edit",
      unfixed_issues: [
        { reason: "unicode_corruption_subtitle", section: "header", details: "8a vs 8ª" },
      ],
    });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].severity, "high");
    assert.ok(signals[0].title.includes("unicode_corruption"));
    assert.equal(signals[0].related_issue, "#39");
  });

  it("template_cleanup_failed vira high", () => {
    const signals = signalsFromPublished({
      unfixed_issues: [{ reason: "template_cleanup_failed", section: "LANÇAMENTOS" }],
    });
    assert.equal(signals[0].severity, "high");
  });

  it("image_upload_failed vira medium", () => {
    const signals = signalsFromPublished({
      unfixed_issues: [{ reason: "image_upload_failed_d2" }],
    });
    assert.equal(signals[0].severity, "medium");
  });

  it("published sem unfixed_issues retorna vazio", () => {
    const signals = signalsFromPublished({ draft_url: "x", unfixed_issues: [] });
    assert.equal(signals.length, 0);
  });

  it("published null retorna vazio", () => {
    assert.equal(signalsFromPublished(null).length, 0);
  });

  it("múltiplos issues geram múltiplos signals", () => {
    const signals = signalsFromPublished({
      unfixed_issues: [
        { reason: "unicode_corruption_title" },
        { reason: "image_upload_failed_d2" },
        { reason: "template_cleanup_failed", section: "LANÇAMENTOS" },
      ],
    });
    assert.equal(signals.length, 3);
  });
});

describe("signalsFromRunLog", () => {
  const mkLine = (obj: Record<string, unknown>) => JSON.stringify(obj);

  it("conta chrome_disconnected errors da edição", () => {
    const lines = [
      mkLine({ timestamp: "2026-04-24T10:00:00Z", edition: "260424", level: "error", message: "chrome_disconnected" }),
      mkLine({ timestamp: "2026-04-24T10:05:00Z", edition: "260424", level: "error", message: "not connected to extension" }),
      mkLine({ timestamp: "2026-04-24T10:10:00Z", edition: "260424", level: "error", message: "chrome desconectado" }),
    ];
    const signals = signalsFromRunLog(lines, "260424", 3);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].details.count, 3);
    assert.equal(signals[0].severity, "medium");
  });

  it("severity high com ≥ 5 desconexões", () => {
    const line = mkLine({ timestamp: "t", edition: "260424", level: "error", message: "chrome_disconnected" });
    const lines = Array(5).fill(line);
    const signals = signalsFromRunLog(lines, "260424", 3);
    assert.equal(signals[0].severity, "high");
  });

  it("filtra edições diferentes", () => {
    const lines = [
      mkLine({ edition: "260423", level: "error", message: "chrome_disconnected" }),
      mkLine({ edition: "260423", level: "error", message: "chrome_disconnected" }),
      mkLine({ edition: "260423", level: "error", message: "chrome_disconnected" }),
      mkLine({ edition: "260424", level: "error", message: "chrome_disconnected" }),
    ];
    const signals = signalsFromRunLog(lines, "260424", 1);
    assert.equal(signals[0].details.count, 1);
  });

  it("sem edition filter: conta todas", () => {
    const lines = [
      mkLine({ edition: "260423", level: "error", message: "chrome_disconnected" }),
      mkLine({ edition: "260424", level: "error", message: "chrome_disconnected" }),
      mkLine({ edition: "260424", level: "error", message: "chrome_disconnected" }),
    ];
    const signals = signalsFromRunLog(lines, null, 3);
    assert.equal(signals[0].details.count, 3);
  });

  it("threshold não atingido: retorna vazio", () => {
    const lines = [
      mkLine({ edition: "260424", level: "error", message: "chrome_disconnected" }),
    ];
    const signals = signalsFromRunLog(lines, "260424", 3);
    assert.equal(signals.length, 0);
  });

  it("ignora eventos sem o termo e de level info", () => {
    const lines = [
      mkLine({ edition: "260424", level: "info", message: "chrome_disconnected" }),
      mkLine({ edition: "260424", level: "error", message: "something else" }),
    ];
    assert.equal(signalsFromRunLog(lines, "260424", 1).length, 0);
  });

  it("linhas malformadas são puladas", () => {
    const lines = ["{garbage", "", "{\"edition\":\"260424\",\"level\":\"error\",\"message\":\"chrome_disconnected\"}"];
    const signals = signalsFromRunLog(lines, "260424", 1);
    assert.equal(signals[0].details.count, 1);
  });
});

describe("signalsFromMcpUnavailable", () => {
  const mkLine = (obj: Record<string, unknown>) => JSON.stringify(obj);

  it("captura warning 'claude-in-chrome MCP unavailable'", () => {
    const lines = [
      mkLine({
        timestamp: "2026-04-26T04:03:55Z",
        edition: "260426",
        level: "warn",
        message: "stage 5 skipped — claude-in-chrome MCP unavailable in this session",
      }),
    ];
    const signals = signalsFromMcpUnavailable(lines, "260426");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].kind, "mcp_unavailable");
    assert.equal(signals[0].severity, "medium");
    assert.equal(signals[0].details.count, 1);
    assert.equal(signals[0].related_issue, "#143");
  });

  it("conta múltiplas ocorrências na mesma edição", () => {
    const lines = [
      mkLine({ edition: "260426", level: "warn", message: "claude-in-chrome MCP unavailable" }),
      mkLine({ edition: "260426", level: "warn", message: "linkedin pending — claude_in_chrome_mcp_unavailable" }),
    ];
    const signals = signalsFromMcpUnavailable(lines, "260426");
    assert.equal(signals[0].details.count, 2);
    assert.match(signals[0].title, /2 ocorr/);
  });

  it("variante genérica 'MCP unavailable' SÓ matcha em contexto claude/chrome", () => {
    const lines = [
      mkLine({ edition: "260426", level: "warn", message: "claude-in-chrome MCP unavailable mid-flight" }),
      mkLine({ edition: "260426", level: "warn", message: "Stage 5 chrome session: MCP unavailable" }),
    ];
    const signals = signalsFromMcpUnavailable(lines, "260426");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].details.count, 2);
  });

  it("não matcha 'MCP unavailable' fora de contexto claude/chrome", () => {
    const lines = [
      mkLine({ edition: "260426", level: "warn", message: "Beehiiv MCP unavailable, retrying" }),
      mkLine({ edition: "260426", level: "warn", message: "Clarice MCP unavailable" }),
    ];
    const signals = signalsFromMcpUnavailable(lines, "260426");
    assert.equal(signals.length, 0);
  });

  // --- #759: new structured mcp_disconnect: format ---

  it("captura 'mcp_disconnect: clarice' do formato estruturado (#759)", () => {
    const lines = [
      mkLine({
        timestamp: "2026-05-05T10:00:00Z",
        edition: "260505",
        stage: 2,
        agent: "orchestrator",
        level: "warn",
        message: "mcp_disconnect: clarice",
        details: { server: "clarice", kind: "mcp_disconnect" },
      }),
    ];
    const signals = signalsFromMcpUnavailable(lines, "260505");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].kind, "mcp_unavailable");
    assert.ok(
      signals[0].title.includes("clarice"),
      `title should mention clarice: ${signals[0].title}`,
    );
    assert.deepEqual(signals[0].details.servers, ["clarice"]);
  });

  it("captura 'mcp_disconnect: beehiiv' e usa título genérico (#759)", () => {
    const lines = [
      mkLine({ edition: "260505", level: "warn", message: "mcp_disconnect: beehiiv" }),
      mkLine({ edition: "260505", level: "warn", message: "mcp_disconnect: beehiiv" }),
    ];
    const signals = signalsFromMcpUnavailable(lines, "260505");
    assert.equal(signals.length, 1);
    assert.ok(
      signals[0].title.includes("MCP indisponível na edição"),
      `generic title expected: ${signals[0].title}`,
    );
    assert.equal(signals[0].details.count, 2);
  });

  it("mcp_reconnect não gera sinal — apenas info-level reconnect (#759)", () => {
    const lines = [
      mkLine({ edition: "260505", level: "info", message: "mcp_reconnect: clarice" }),
    ];
    const signals = signalsFromMcpUnavailable(lines, "260505");
    assert.equal(signals.length, 0);
  });

  it("mcp_disconnect: chrome-only ainda usa título específico Claude in Chrome", () => {
    // #766: precisa de timestamp pra signal não cair no filtro de flapping (low severity)
    const lines = [
      mkLine({
        edition: "260505",
        level: "warn",
        timestamp: "2026-05-05T10:00:00Z",
        message: "mcp_disconnect: claude-in-chrome",
      }),
    ];
    const signals = signalsFromMcpUnavailable(lines, "260505");
    assert.equal(signals.length, 1);
    assert.ok(
      signals[0].title.includes("Claude in Chrome"),
      `should use Chrome-specific title: ${signals[0].title}`,
    );
  });

  it("mcp_disconnect não duplica em signalsFromTestWarnings (#759)", () => {
    // mcp_disconnect: events should be filtered by TEST_WARNING_SKIP_PATTERNS
    // so they don't appear as test_warning signals (already covered by mcp_unavailable)
    const lines = [
      mkLine({
        edition: "260505",
        agent: "orchestrator",
        level: "warn",
        message: "mcp_disconnect: clarice",
      }),
    ];
    const signals = signalsFromTestWarnings(lines, "260505");
    assert.equal(signals.length, 0);
  });

  it("filtra edições diferentes", () => {
    // #766: timestamps necessários pra signal sobreviver ao filtro de flapping
    const lines = [
      mkLine({
        edition: "260424", level: "warn",
        timestamp: "2026-04-24T10:00:00Z",
        message: "claude-in-chrome MCP unavailable",
      }),
      mkLine({
        edition: "260426", level: "warn",
        timestamp: "2026-04-26T10:00:00Z",
        message: "claude-in-chrome MCP unavailable",
      }),
    ];
    const signals = signalsFromMcpUnavailable(lines, "260426");
    assert.equal(signals[0].details.count, 1);
  });

  it("ignora info-level e mensagens não relacionadas", () => {
    const lines = [
      mkLine({ edition: "260426", level: "info", message: "claude-in-chrome MCP unavailable" }),
      mkLine({ edition: "260426", level: "warn", message: "tudo certo" }),
    ];
    const signals = signalsFromMcpUnavailable(lines, "260426");
    assert.equal(signals.length, 0);
  });

  it("zero ocorrências não gera sinal", () => {
    const signals = signalsFromMcpUnavailable([], "260426");
    assert.equal(signals.length, 0);
  });
});

// ---------------------------------------------------------------------------
// #766 — duration tracking + severity threshold
// ---------------------------------------------------------------------------

describe("severityFromDuration (#766)", () => {
  it("max < 60s e sem unpaired → low (será filtrado)", () => {
    assert.equal(severityFromDuration(30000, false), "low");
    assert.equal(severityFromDuration(59000, false), "low");
    assert.equal(severityFromDuration(0, false), "low");
  });

  it("60s ≤ max < 5min → medium", () => {
    assert.equal(severityFromDuration(60000, false), "medium");
    assert.equal(severityFromDuration(120000, false), "medium");
    assert.equal(severityFromDuration(299999, false), "medium");
  });

  it("≥ 5min → high", () => {
    assert.equal(severityFromDuration(300000, false), "high");
    assert.equal(severityFromDuration(600000, false), "high");
    assert.equal(severityFromDuration(60 * 60 * 1000, false), "high");
  });

  it("hasUnpaired=true → high (server ainda down)", () => {
    assert.equal(severityFromDuration(null, true), "high");
    assert.equal(severityFromDuration(30000, true), "high"); // overrides
    assert.equal(severityFromDuration(120000, true), "high");
  });

  it("max=null sem unpaired → low (sem dado pra escalar)", () => {
    assert.equal(severityFromDuration(null, false), "low");
  });
});

describe("pairDisconnectReconnect (#766)", () => {
  it("pareia disconnect + reconnect mesmo server → 1 duração", () => {
    const result = pairDisconnectReconnect([
      { kind: "disconnect", server: "clarice", timestamp: "2026-05-06T10:00:00Z" },
      { kind: "reconnect", server: "clarice", timestamp: "2026-05-06T10:05:00Z" },
    ]);
    assert.equal(result.durations.length, 1);
    assert.equal(result.durations[0].server, "clarice");
    assert.equal(result.durations[0].ms, 5 * 60 * 1000);
    assert.equal(result.hasUnpaired, false);
  });

  it("disconnect sem reconnect → hasUnpaired=true", () => {
    const result = pairDisconnectReconnect([
      { kind: "disconnect", server: "clarice", timestamp: "2026-05-06T10:00:00Z" },
    ]);
    assert.equal(result.durations.length, 0);
    assert.equal(result.hasUnpaired, true);
  });

  it("múltiplos servers — pareados independentemente", () => {
    const result = pairDisconnectReconnect([
      { kind: "disconnect", server: "clarice", timestamp: "2026-05-06T10:00:00Z" },
      { kind: "disconnect", server: "beehiiv", timestamp: "2026-05-06T10:01:00Z" },
      { kind: "reconnect", server: "beehiiv", timestamp: "2026-05-06T10:02:00Z" },
      { kind: "reconnect", server: "clarice", timestamp: "2026-05-06T10:05:00Z" },
    ]);
    assert.equal(result.durations.length, 2);
    const byServer = Object.fromEntries(result.durations.map((d) => [d.server, d.ms]));
    assert.equal(byServer.clarice, 5 * 60 * 1000);
    assert.equal(byServer.beehiiv, 60 * 1000);
    assert.equal(result.hasUnpaired, false);
  });

  it("disconnect duplo (sem reconnect entre eles) — só primeiro pareia, segundo absorvido", () => {
    const result = pairDisconnectReconnect([
      { kind: "disconnect", server: "clarice", timestamp: "2026-05-06T10:00:00Z" },
      { kind: "disconnect", server: "clarice", timestamp: "2026-05-06T10:01:00Z" },
      { kind: "reconnect", server: "clarice", timestamp: "2026-05-06T10:05:00Z" },
    ]);
    assert.equal(result.durations.length, 1);
    // duração é do primeiro disconnect (10:00) ao reconnect (10:05) = 5min
    assert.equal(result.durations[0].ms, 5 * 60 * 1000);
    assert.equal(result.hasUnpaired, false);
  });

  it("reconnect sem disconnect prévio → ignorado", () => {
    const result = pairDisconnectReconnect([
      { kind: "reconnect", server: "clarice", timestamp: "2026-05-06T10:00:00Z" },
    ]);
    assert.equal(result.durations.length, 0);
    assert.equal(result.hasUnpaired, false);
  });

  it("flapping: disconnect-reconnect repetidos rápido → durações curtas individuais", () => {
    const result = pairDisconnectReconnect([
      { kind: "disconnect", server: "clarice", timestamp: "2026-05-06T10:00:00Z" },
      { kind: "reconnect", server: "clarice", timestamp: "2026-05-06T10:00:30Z" },
      { kind: "disconnect", server: "clarice", timestamp: "2026-05-06T10:01:00Z" },
      { kind: "reconnect", server: "clarice", timestamp: "2026-05-06T10:01:30Z" },
    ]);
    assert.equal(result.durations.length, 2);
    assert.deepEqual(result.durations.map((d) => d.ms), [30000, 30000]);
  });
});

describe("signalsFromMcpUnavailable — duration & severity (#766)", () => {
  const mkLine = (obj: Record<string, unknown>) => JSON.stringify(obj);

  it("flap < 60s pareado → drop signal", () => {
    const lines = [
      mkLine({
        edition: "260506", level: "warn",
        timestamp: "2026-05-06T10:00:00Z",
        message: "mcp_disconnect: clarice",
      }),
      mkLine({
        edition: "260506", level: "info",
        timestamp: "2026-05-06T10:00:30Z",
        message: "mcp_reconnect: clarice",
      }),
    ];
    const signals = signalsFromMcpUnavailable(lines, "260506");
    assert.equal(signals.length, 0, "flapping aceitável — drop signal");
  });

  it("disconnect 5min → severity high + max_duration_ms preenchido", () => {
    const lines = [
      mkLine({
        edition: "260506", level: "warn",
        timestamp: "2026-05-06T10:00:00Z",
        message: "mcp_disconnect: clarice",
      }),
      mkLine({
        edition: "260506", level: "info",
        timestamp: "2026-05-06T10:05:00Z",
        message: "mcp_reconnect: clarice",
      }),
    ];
    const signals = signalsFromMcpUnavailable(lines, "260506");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].severity, "high");
    assert.equal(signals[0].details.max_duration_ms, 5 * 60 * 1000);
    assert.deepEqual(signals[0].details.durations_ms, [5 * 60 * 1000]);
    assert.equal(signals[0].details.unpaired_disconnects, false);
  });

  it("disconnect 2min → severity medium", () => {
    const lines = [
      mkLine({
        edition: "260506", level: "warn",
        timestamp: "2026-05-06T10:00:00Z",
        message: "mcp_disconnect: beehiiv",
      }),
      mkLine({
        edition: "260506", level: "info",
        timestamp: "2026-05-06T10:02:00Z",
        message: "mcp_reconnect: beehiiv",
      }),
    ];
    const signals = signalsFromMcpUnavailable(lines, "260506");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].severity, "medium");
    assert.equal(signals[0].details.max_duration_ms, 2 * 60 * 1000);
  });

  it("disconnect sem reconnect → severity high + unpaired_disconnects=true", () => {
    const lines = [
      mkLine({
        edition: "260506", level: "warn",
        timestamp: "2026-05-06T10:00:00Z",
        message: "mcp_disconnect: clarice",
      }),
    ];
    const signals = signalsFromMcpUnavailable(lines, "260506");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].severity, "high");
    assert.equal(signals[0].details.unpaired_disconnects, true);
    assert.equal(signals[0].details.max_duration_ms, null);
    assert.deepEqual(signals[0].details.durations_ms, []);
  });

  it("compat com formato legado (claude-in-chrome MCP unavailable) — preserva severity medium", () => {
    // Logs antigos não têm "mcp_disconnect:" estruturado → fallback pra
    // severity=medium do comportamento prévio. Sem dados de duração → durations
    // ficam vazias e unpaired_disconnects=false (não tem evento estruturado).
    const lines = [
      mkLine({
        edition: "260426", level: "warn",
        timestamp: "2026-04-26T10:00:00Z",
        message: "claude-in-chrome MCP unavailable, retrying",
      }),
    ];
    const signals = signalsFromMcpUnavailable(lines, "260426");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].severity, "medium");
    assert.deepEqual(signals[0].details.durations_ms, []);
    assert.equal(signals[0].details.max_duration_ms, null);
    assert.equal(signals[0].details.unpaired_disconnects, false);
  });

  it("eventos fora de ordem cronológica são ordenados antes do pareamento", () => {
    // disconnect 10:05, reconnect 10:00 (impossível mas pode acontecer com backfill)
    const lines = [
      mkLine({
        edition: "260506", level: "warn",
        timestamp: "2026-05-06T10:05:00Z",
        message: "mcp_disconnect: clarice",
      }),
      mkLine({
        edition: "260506", level: "info",
        timestamp: "2026-05-06T10:00:00Z",
        message: "mcp_reconnect: clarice",
      }),
    ];
    const signals = signalsFromMcpUnavailable(lines, "260506");
    // após sort: reconnect 10:00 primeiro (sem disconnect prévio → drop),
    // disconnect 10:05 sem reconnect subsequente → unpaired
    assert.equal(signals[0].severity, "high");
    assert.equal(signals[0].details.unpaired_disconnects, true);
  });
});

describe("signalsFromTestWarnings (#519)", () => {
  const mkLine = (obj: Record<string, unknown>) => JSON.stringify(obj);

  it("captura erro de eai-composer (Gemini API esgotada)", () => {
    const lines = [
      mkLine({
        timestamp: "2026-04-28T18:37:53.974Z",
        edition: "260429",
        stage: 1,
        agent: "eai-composer",
        level: "error",
        message:
          "Gemini API 429 RESOURCE_EXHAUSTED — monthly spending cap exceeded",
      }),
    ];
    const signals = signalsFromTestWarnings(lines, "260429");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].kind, "test_warning");
    assert.equal(signals[0].severity, "high");
    assert.equal(signals[0].details.agent, "eai-composer");
    assert.equal(signals[0].details.count, 1);
    assert.ok(String(signals[0].title).includes("eai-composer"));
  });

  it("agrupa eventos repetidos do mesmo agent + mensagem (count agregado)", () => {
    const lines = [
      mkLine({
        timestamp: "2026-04-29T20:11:10Z",
        edition: "260430",
        stage: 2,
        agent: "drive-sync",
        level: "warn",
        message: "1 sync warning(s) em push (Stage 2)",
      }),
      mkLine({
        timestamp: "2026-04-29T20:15:10Z",
        edition: "260430",
        stage: 2,
        agent: "drive-sync",
        level: "warn",
        message: "1 sync warning(s) em push (Stage 2)",
      }),
      mkLine({
        timestamp: "2026-04-29T20:20:10Z",
        edition: "260430",
        stage: 2,
        agent: "drive-sync",
        level: "warn",
        message: "1 sync warning(s) em push (Stage 2)",
      }),
    ];
    const signals = signalsFromTestWarnings(lines, "260430");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].details.count, 3);
    assert.equal(signals[0].severity, "medium");
    assert.equal(signals[0].details.first_at, "2026-04-29T20:11:10Z");
    assert.equal(signals[0].details.last_at, "2026-04-29T20:20:10Z");
  });

  it("eventos de agents diferentes viram signals separados", () => {
    const lines = [
      mkLine({ edition: "260424", agent: "drive-sync", level: "warn", message: "a" }),
      mkLine({ edition: "260424", agent: "link-verifier", level: "warn", message: "a" }),
    ];
    const signals = signalsFromTestWarnings(lines, "260424");
    assert.equal(signals.length, 2);
  });

  it("filtra edições diferentes", () => {
    const lines = [
      mkLine({ edition: "260423", agent: "x", level: "error", message: "boom" }),
      mkLine({ edition: "260424", agent: "x", level: "error", message: "boom" }),
    ];
    const signals = signalsFromTestWarnings(lines, "260424");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].details.count, 1);
  });

  it("filtra warns by-design em test_mode (#556, #559) — message contém 'test_mode'", () => {
    const lines = [
      mkLine({
        edition: "260509",
        stage: 4,
        agent: "orchestrator",
        level: "warn",
        message: "stage 4 publishers skipped (test_mode + CHROME_MCP=false)",
      }),
      mkLine({
        edition: "260509",
        stage: 1,
        agent: "writer",
        level: "error",
        message: "writer falhou de verdade",
      }),
    ];
    const signals = signalsFromTestWarnings(lines, "260509");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].details.agent, "writer");
  });

  it("filtra warns com details.informational=true (#565, replaces #557 textual tag)", () => {
    const lines = [
      mkLine({
        edition: "260509",
        stage: 0,
        agent: "orchestrator",
        level: "warn",
        message: "edição anterior 260504 tem 3 posts FB com status=failed",
        details: { prev_edition: "260504", failed_count: 3, informational: true },
      }),
    ];
    const signals = signalsFromTestWarnings(lines, "260509");
    assert.equal(signals.length, 0);
  });

  it("warn sem flag informational ainda vira signal (regressão #565)", () => {
    // Mesmo agent/message/edition do teste acima, mas SEM informational:true.
    // Garante que a flag é o único mecanismo — sem ela, o warn vira issue.
    const lines = [
      mkLine({
        edition: "260509",
        stage: 0,
        agent: "orchestrator",
        level: "warn",
        message: "edição anterior 260504 tem 3 posts FB com status=failed",
        details: { prev_edition: "260504", failed_count: 3 },
      }),
    ];
    const signals = signalsFromTestWarnings(lines, "260509");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].details.agent, "orchestrator");
  });

  it("filtra warns com details.reason='test_mode' (#556) — dedup_freshness_override", () => {
    const lines = [
      mkLine({
        edition: "260509",
        stage: 0,
        agent: "orchestrator",
        level: "warn",
        message: "dedup_freshness_override",
        details: {
          most_recent: "2026-04-30T08:00:00Z",
          age_hours: 104.8,
          reason: "test_mode auto-approve",
        },
      }),
    ];
    const signals = signalsFromTestWarnings(lines, "260509");
    assert.equal(signals.length, 0);
  });

  it("dedup_freshness_override em produção (sem test_mode no reason) ainda vira signal", () => {
    const lines = [
      mkLine({
        edition: "260424",
        stage: 0,
        agent: "orchestrator",
        level: "warn",
        message: "dedup_freshness_override",
        details: {
          most_recent: "2026-04-22T08:00:00Z",
          age_hours: 50,
          reason: "editor override após falha real",
        },
      }),
    ];
    const signals = signalsFromTestWarnings(lines, "260424");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].details.agent, "orchestrator");
  });

  it("não duplica chrome_disconnected nem mcp_unavailable (signals 3 e 4 já cobrem)", () => {
    const lines = [
      mkLine({ edition: "260424", agent: "publish-social", level: "error", message: "chrome_disconnected mid-flight" }),
      mkLine({ edition: "260424", agent: "orchestrator", level: "warn", message: "claude-in-chrome MCP unavailable" }),
      mkLine({ edition: "260424", agent: "writer", level: "error", message: "writer falhou inesperadamente" }),
    ];
    const signals = signalsFromTestWarnings(lines, "260424");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].details.agent, "writer");
  });

  it("ignora info-level e linhas malformadas", () => {
    const lines = [
      "{garbage",
      mkLine({ edition: "260424", agent: "x", level: "info", message: "tudo certo" }),
      mkLine({ edition: "260424", agent: "x", level: "error", message: "real error" }),
    ];
    const signals = signalsFromTestWarnings(lines, "260424");
    assert.equal(signals.length, 1);
  });

  it("error level vira severity high; warn level vira medium", () => {
    const lines = [
      mkLine({ edition: "260424", agent: "a", level: "error", message: "boom error" }),
      mkLine({ edition: "260424", agent: "b", level: "warn", message: "warn message" }),
    ];
    const signals = signalsFromTestWarnings(lines, "260424");
    const byAgent = Object.fromEntries(
      signals.map((s) => [s.details.agent, s.severity]),
    );
    assert.equal(byAgent.a, "high");
    assert.equal(byAgent.b, "medium");
  });

  it("eventos sem edition no log são ignorados quando edition filter está ativo", () => {
    const lines = [
      mkLine({ agent: "inbox-drainer", level: "error", message: "credentials missing" }),
      mkLine({ edition: "260424", agent: "writer", level: "error", message: "real" }),
    ];
    const signals = signalsFromTestWarnings(lines, "260424");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].details.agent, "writer");
  });

  it("normalizeMessageKey gera keys idênticas pra mensagens com pontuação variável", () => {
    const a = normalizeMessageKey("Erro X — falha foo");
    const b = normalizeMessageKey("erro x falha foo");
    assert.equal(a, b);
  });

  it("array vazio retorna []", () => {
    assert.equal(signalsFromTestWarnings([], "260424").length, 0);
  });
});

describe("collectSignals + writeDraft — integração", () => {
  function setup(): { root: string; editionDir: string } {
    const root = mkdtempSync(join(tmpdir(), "diaria-signals-"));
    const editionDir = join(root, "data/editions/260424");
    mkdirSync(editionDir, { recursive: true });
    mkdirSync(join(root, "data"), { recursive: true });
    return { root, editionDir };
  }

  it("coleta de múltiplas fontes simultâneas", () => {
    const { root, editionDir } = setup();
    try {
      writeFileSync(
        join(root, "data/source-health.json"),
        JSON.stringify({
          sources: {
            X: { recent_outcomes: Array(3).fill({ outcome: "fail" }) },
          },
        }),
      );
      writeFileSync(
        join(editionDir, "05-published.json"),
        JSON.stringify({
          unfixed_issues: [{ reason: "unicode_corruption_title" }],
        }),
      );
      writeFileSync(
        join(root, "data/run-log.jsonl"),
        Array(3)
          .fill({ edition: "260424", level: "error", message: "chrome_disconnected" })
          .map((o) => JSON.stringify(o))
          .join("\n"),
      );

      const draft = collectSignals({ rootDir: root, editionDir });
      assert.equal(draft.edition, "260424");
      assert.equal(draft.signals.length, 3);
      const kinds = new Set(draft.signals.map((s) => s.kind));
      assert.ok(kinds.has("source_streak"));
      assert.ok(kinds.has("unfixed_issue"));
      assert.ok(kinds.has("chrome_disconnects"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writeDraft grava em _internal/issues-draft.json", () => {
    const { root, editionDir } = setup();
    try {
      const draft = {
        edition: "260424",
        collected_at: "2026-04-24T12:00:00Z",
        signals: [],
      };
      const outPath = writeDraft(draft, editionDir);
      const expected = resolve(editionDir, "_internal/issues-draft.json");
      assert.equal(outPath, expected);
      const content = JSON.parse(readFileSync(outPath, "utf8"));
      assert.equal(content.edition, "260424");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem arquivos → signals vazio (não quebra)", () => {
    const { root, editionDir } = setup();
    try {
      const draft = collectSignals({ rootDir: root, editionDir });
      assert.equal(draft.signals.length, 0);
      assert.equal(draft.edition, "260424");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--include-test-warnings (#519): erros de agents viram signals test_warning", () => {
    const { root, editionDir } = setup();
    try {
      writeFileSync(
        join(root, "data/run-log.jsonl"),
        [
          { edition: "260424", agent: "eai-composer", level: "error", message: "Gemini API revogada" },
          { edition: "260424", agent: "drive-sync", level: "warn", message: "drive sync warning push" },
        ]
          .map((o) => JSON.stringify(o))
          .join("\n"),
      );
      const draft = collectSignals({
        rootDir: root,
        editionDir,
        includeTestWarnings: true,
      });
      const testSignals = draft.signals.filter((s) => s.kind === "test_warning");
      assert.equal(testSignals.length, 2);

      // Sem a flag, signals test_warning não são gerados.
      const draftDefault = collectSignals({ rootDir: root, editionDir });
      assert.equal(
        draftDefault.signals.filter((s) => s.kind === "test_warning").length,
        0,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
