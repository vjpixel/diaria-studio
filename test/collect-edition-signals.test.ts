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

  it("filtra edições diferentes", () => {
    const lines = [
      mkLine({ edition: "260424", level: "warn", message: "claude-in-chrome MCP unavailable" }),
      mkLine({ edition: "260426", level: "warn", message: "claude-in-chrome MCP unavailable" }),
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
