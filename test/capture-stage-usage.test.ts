import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureUsageForWindow } from "../scripts/capture-stage-usage.ts";
import { makeInitialDoc, applyUpdate, saveDoc, loadDoc } from "../scripts/update-stage-status.ts";

function usageLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-05-08T08:35:00.000Z",
    message: {
      model: "claude-opus-4-8",
      usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
    },
    ...overrides,
  });
}

describe("captureUsageForWindow", () => {
  it("retorna unavailable quando start/end ausentes", () => {
    const result = captureUsageForWindow("/whatever", undefined, undefined, "260508");
    assert.equal(result.source, "unavailable");
    assert.equal(result.reason, "missing_stage_timestamps");
  });

  it("retorna unavailable quando o diretório de transcripts não existe", () => {
    const result = captureUsageForWindow(
      "/does/not/exist",
      "2026-05-08T08:30:00.000Z",
      "2026-05-08T08:48:00.000Z",
      "260508",
    );
    assert.equal(result.source, "unavailable");
    assert.equal(result.reason, "no_local_transcripts_dir");
  });

  it("retorna unavailable quando não há entradas de usage na janela", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-stage-test-"));
    try {
      writeFileSync(join(dir, "session.jsonl"), usageLine({ timestamp: "2026-05-08T05:00:00.000Z" }), "utf8");
      const result = captureUsageForWindow(
        dir,
        "2026-05-08T08:30:00.000Z",
        "2026-05-08T08:48:00.000Z",
        "260508",
      );
      assert.equal(result.source, "unavailable");
      assert.equal(result.reason, "no_usage_records_in_window");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captura tokens + custo reais quando há entradas na janela", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-stage-test-"));
    try {
      writeFileSync(join(dir, "session.jsonl"), usageLine(), "utf8");
      const result = captureUsageForWindow(
        dir,
        "2026-05-08T08:30:00.000Z",
        "2026-05-08T08:48:00.000Z",
        "260508",
      );
      assert.equal(result.source, "session_transcript");
      assert.equal(result.tokens_in, 1_000_000);
      assert.equal(result.tokens_out, 100_000);
      // opus: $5/1M input + $25/1M output = $5 + $2.5 = $7.5
      assert.equal(result.cost_usd, 7.5);
      assert.deepEqual(result.models, ["opus-4-8"]);
      assert.equal(result.cost_partial, false);
      assert.equal(result.entries_matched, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marca cost_partial quando um modelo não é precificável (ex: gemini)", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-stage-test-"));
    try {
      writeFileSync(
        join(dir, "session.jsonl"),
        [usageLine(), usageLine({ message: { model: "gemini-2.5-flash", usage: { input_tokens: 500, output_tokens: 50 } } })].join(
          "\n",
        ),
        "utf8",
      );
      const result = captureUsageForWindow(
        dir,
        "2026-05-08T08:30:00.000Z",
        "2026-05-08T08:48:00.000Z",
        "260508",
      );
      assert.equal(result.source, "session_transcript");
      assert.equal(result.cost_partial, true);
      // custo só do opus (gemini não contribui pra $, mas tokens contam)
      assert.equal(result.cost_usd, 7.5);
      assert.equal(result.tokens_in, 1_000_500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("captureUsageForWindow + stage-status.json — integração de escrita", () => {
  it("popula cost_usd/tokens_in/tokens_out/models de uma linha existente sem tocar status/start/end", () => {
    const editionRoot = mkdtempSync(join(tmpdir(), "capture-stage-edition-"));
    try {
      const editionDir = join(editionRoot, "260508");
      mkdirSync(editionDir, { recursive: true });

      let doc = makeInitialDoc("260508", "2026-05-08T08:00:00.000Z");
      doc = applyUpdate(
        doc,
        {
          stage: 1,
          status: "done",
          start: "2026-05-08T08:30:00.000Z",
          end: "2026-05-08T08:48:00.000Z",
        },
        "2026-05-08T08:48:00.000Z",
      );
      saveDoc(editionDir, doc);

      const transcriptsDir = mkdtempSync(join(tmpdir(), "capture-stage-transcripts-"));
      writeFileSync(join(transcriptsDir, "session.jsonl"), usageLine(), "utf8");

      const row = doc.rows.find((r) => r.stage === 1)!;
      const result = captureUsageForWindow(transcriptsDir, row.start, row.end, "260508");
      assert.equal(result.source, "session_transcript");

      // Simula o que main() faz: aplica o resultado de volta ao doc e salva.
      const reloaded = loadDoc(editionDir, "260508");
      const updated = applyUpdate(
        reloaded,
        {
          stage: 1,
          status: "done",
          cost_usd: result.cost_usd,
          tokens_in: result.tokens_in,
          tokens_out: result.tokens_out,
          models: result.models,
        },
        "2026-05-08T09:00:00.000Z",
      );
      saveDoc(editionDir, updated);

      const finalDoc = loadDoc(editionDir, "260508");
      const finalRow = finalDoc.rows.find((r) => r.stage === 1)!;
      assert.equal(finalRow.status, "done");
      assert.equal(finalRow.start, "2026-05-08T08:30:00.000Z");
      assert.equal(finalRow.end, "2026-05-08T08:48:00.000Z");
      assert.equal(finalRow.cost_usd, 7.5);
      assert.equal(finalRow.tokens_in, 1_000_000);
      assert.equal(finalRow.tokens_out, 100_000);
      assert.deepEqual(finalRow.models, ["opus-4-8"]);

      // Renderiza a MD e confirma que a linha não fica mais com "-" em custo/tokens.
      const md = readFileSync(join(editionDir, "stage-status.md"), "utf8");
      const line1 = md.split("\n").find((l) => l.startsWith("| 1 |"))!;
      assert.ok(line1.includes("$7.5") || line1.includes("$7.500"));
      assert.ok(!line1.includes("| - | - | - |"));

      rmSync(transcriptsDir, { recursive: true, force: true });
    } finally {
      rmSync(editionRoot, { recursive: true, force: true });
    }
  });
});

describe("capture-stage-usage CLI (#3441) — invocação real via subprocess", () => {
  /**
   * `sessionId` controla `CLAUDE_CODE_SESSION_ID` no subprocesso (#5413).
   * Default `undefined` = variável REMOVIDA do ambiente — sem isso o
   * resultado do teste dependeria de a suíte estar rodando dentro de uma
   * sessão Claude Code ou não (herdaria o id real da sessão do editor),
   * o que dá verde por acaso na máquina e outro caminho no CI.
   */
  function runCli(args: string[], sessionId?: string) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "capture-stage-usage.ts");
    const env = { ...process.env };
    if (sessionId === undefined) delete env.CLAUDE_CODE_SESSION_ID;
    else env.CLAUDE_CODE_SESSION_ID = sessionId;
    return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
      cwd: projectRoot,
      encoding: "utf8",
      env,
    });
  }

  function setupEdition(): { editionRoot: string; editionDir: string; transcriptsDir: string } {
    const editionRoot = mkdtempSync(join(tmpdir(), "capture-cli-edition-"));
    const editionDir = join(editionRoot, "260508");
    mkdirSync(editionDir, { recursive: true });
    let doc = makeInitialDoc("260508", "2026-05-08T08:00:00.000Z");
    doc = applyUpdate(
      doc,
      { stage: 1, status: "done", start: "2026-05-08T08:30:00.000Z", end: "2026-05-08T08:48:00.000Z" },
      "2026-05-08T08:48:00.000Z",
    );
    saveDoc(editionDir, doc);
    const transcriptsDir = mkdtempSync(join(tmpdir(), "capture-cli-transcripts-"));
    return { editionRoot, editionDir, transcriptsDir };
  }

  it("--dry-run não escreve em stage-status.json", () => {
    const { editionRoot, editionDir, transcriptsDir } = setupEdition();
    try {
      writeFileSync(join(transcriptsDir, "session.jsonl"), usageLine(), "utf8");
      const r = runCli([
        "--edition-dir",
        editionDir,
        "--stage",
        "1",
        "--transcripts-dir",
        transcriptsDir,
        "--dry-run",
      ]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.source, "session_transcript");
      assert.equal(out.cost_usd, 7.5);
      assert.equal(out.path, undefined); // dry-run não grava, não retorna path

      const doc = loadDoc(editionDir, "260508");
      const row = doc.rows.find((row) => row.stage === 1)!;
      assert.equal(row.cost_usd, undefined); // confirma que nada foi persistido
    } finally {
      rmSync(editionRoot, { recursive: true, force: true });
      rmSync(transcriptsDir, { recursive: true, force: true });
    }
  });

  it("execução real grava cost_usd/tokens_in/tokens_out/models em stage-status.json", () => {
    const { editionRoot, editionDir, transcriptsDir } = setupEdition();
    try {
      writeFileSync(join(transcriptsDir, "session.jsonl"), usageLine(), "utf8");
      const r = runCli(["--edition-dir", editionDir, "--stage", "1", "--transcripts-dir", transcriptsDir]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.source, "session_transcript");
      assert.ok(out.path);

      const doc = loadDoc(editionDir, "260508");
      const row = doc.rows.find((row) => row.stage === 1)!;
      assert.equal(row.status, "done"); // não muda status
      assert.equal(row.start, "2026-05-08T08:30:00.000Z"); // não muda start
      assert.equal(row.end, "2026-05-08T08:48:00.000Z"); // não muda end
      assert.equal(row.cost_usd, 7.5);
      assert.equal(row.tokens_in, 1_000_000);
      assert.equal(row.tokens_out, 100_000);
      assert.deepEqual(row.models, ["opus-4-8"]);
    } finally {
      rmSync(editionRoot, { recursive: true, force: true });
      rmSync(transcriptsDir, { recursive: true, force: true });
    }
  });

  it("#5423 (self-review fleet review) — parse_errors persiste em stage-status.json, não só no stdout", () => {
    const { editionRoot, editionDir, transcriptsDir } = setupEdition();
    try {
      const truncated =
        '{"type":"assistant","timestamp":"2026-05-08T08:35:00.000Z","message":{"usage":{"input_to';
      writeFileSync(join(transcriptsDir, "session.jsonl"), [truncated, usageLine()].join("\n"), "utf8");
      const r = runCli(["--edition-dir", editionDir, "--stage", "1", "--transcripts-dir", transcriptsDir]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.source, "session_transcript");
      assert.equal(out.parse_errors, 1);

      // O bug real (#5423 fleet review): CaptureResult tinha o campo, mas
      // `applyUpdate` nunca recebia `parse_errors` — o diagnóstico morria no
      // stdout desta invocação isolada e nunca chegava no disco. Reler via
      // `loadDoc` (não o `out` do stdout) é o que prova que persistiu.
      const doc = loadDoc(editionDir, "260508");
      const row = doc.rows.find((row) => row.stage === 1)!;
      assert.equal(row.parse_errors, 1, "parse_errors precisa estar em stage-status.json, não só no stdout do CLI");
    } finally {
      rmSync(editionRoot, { recursive: true, force: true });
      rmSync(transcriptsDir, { recursive: true, force: true });
    }
  });

  it("sem transcript local: sai com status 0, source unavailable, não escreve nada (fail-soft)", () => {
    const { editionRoot, editionDir, transcriptsDir } = setupEdition();
    // Não escreve nenhum .jsonl no transcriptsDir — simula ausência de dado real.
    try {
      const r = runCli(["--edition-dir", editionDir, "--stage", "1", "--transcripts-dir", transcriptsDir]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.source, "unavailable");
      assert.equal(out.reason, "no_usage_records_in_window");

      const doc = loadDoc(editionDir, "260508");
      const row = doc.rows.find((row) => row.stage === 1)!;
      assert.equal(row.cost_usd, undefined); // nunca escreve zero/null como se fosse real
    } finally {
      rmSync(editionRoot, { recursive: true, force: true });
      rmSync(transcriptsDir, { recursive: true, force: true });
    }
  });

  it("--stage fora do range 0-6 (sem row em stage-status.json): falha cedo com unavailable/stage_not_tracked — nunca reporta sucesso sem persistir", () => {
    const { editionRoot, editionDir, transcriptsDir } = setupEdition();
    try {
      writeFileSync(
        join(transcriptsDir, "session.jsonl"),
        usageLine({ timestamp: "2026-05-08T08:35:00.000Z" }),
        "utf8",
      );
      const r = runCli([
        "--edition-dir",
        editionDir,
        "--stage",
        "7",
        "--start",
        "2026-05-08T08:30:00.000Z",
        "--end",
        "2026-05-08T08:48:00.000Z",
        "--transcripts-dir",
        transcriptsDir,
      ]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.source, "unavailable");
      assert.equal(out.reason, "stage_not_tracked");
      const doc = loadDoc(editionDir, "260508");
      assert.equal(
        doc.rows.find((row) => row.stage === 7),
        undefined,
      );
    } finally {
      rmSync(editionRoot, { recursive: true, force: true });
      rmSync(transcriptsDir, { recursive: true, force: true });
    }
  });

  /**
   * O filtro por sessão do #5413 depende, em produção, de UMA linha de
   * `main()`: ler `CLAUDE_CODE_SESSION_ID` do ambiente. Os testes de
   * `collectUsageInWindow` cobrem a lógica de filtragem, mas passam o
   * `sessionId` à mão — nenhum deles provaria que o CLI de fato lê a variável.
   * Um typo no nome dela passaria por toda a suíte e só apareceria numa
   * edição real, com o número inflado de novo. Estes testes fecham isso pelo
   * caminho que o orchestrator usa: subprocess, sem flag nenhuma.
   */
  describe("filtro por sessão via ambiente (#5413)", () => {
    /** Sessão da edição + uma concorrente, ambas dentro da janela do stage. */
    function writeTwoSessions(transcriptsDir: string): void {
      writeFileSync(join(transcriptsDir, "s1.jsonl"), usageLine(), "utf8");
      writeFileSync(
        join(transcriptsDir, "s2.jsonl"),
        usageLine({
          message: {
            model: "claude-opus-4-8",
            usage: { input_tokens: 5_000_000, output_tokens: 400_000 },
          },
        }),
        "utf8",
      );
    }

    it("sem flag nenhuma, conta só a sessão de CLAUDE_CODE_SESSION_ID", () => {
      const { editionRoot, editionDir, transcriptsDir } = setupEdition();
      try {
        writeTwoSessions(transcriptsDir);
        const r = runCli(
          ["--edition-dir", editionDir, "--stage", "1", "--transcripts-dir", transcriptsDir],
          "s1",
        );
        assert.equal(r.status, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        assert.equal(out.session_filter, "current_session");
        assert.equal(out.session_filter_reason, undefined);
        assert.equal(out.tokens_in, 1_000_000, "os 5M da sessão concorrente NÃO entram");
        assert.equal(out.sessions_excluded, 1);
        assert.equal(out.subagent_tokens_in, null, "null = não registrado, nunca 0");

        // A procedência precisa sobreviver EM DISCO, não só no stdout — é o
        // que permite auditar este número numa análise semanas depois.
        const row = loadDoc(editionDir, "260508").rows.find((x) => x.stage === 1)!;
        assert.equal(row.session_filter, "current_session");
        assert.equal(row.sessions_excluded, 1);
        assert.equal(row.subagent_tokens_in, null);
      } finally {
        rmSync(editionRoot, { recursive: true, force: true });
        rmSync(transcriptsDir, { recursive: true, force: true });
      }
    });

    it("--all-sessions reproduz o comportamento pré-#5413 mesmo com a variável setada", () => {
      const { editionRoot, editionDir, transcriptsDir } = setupEdition();
      try {
        writeTwoSessions(transcriptsDir);
        const r = runCli(
          [
            "--edition-dir",
            editionDir,
            "--stage",
            "1",
            "--transcripts-dir",
            transcriptsDir,
            "--all-sessions",
          ],
          "s1",
        );
        assert.equal(r.status, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        assert.equal(out.session_filter, "all_sessions");
        assert.equal(out.session_filter_reason, "no_session_id");
        assert.equal(out.tokens_in, 6_000_000, "soma as duas sessões");
        assert.equal(out.sessions_excluded, 0);

        // #6170: session_filter_reason precisa sobreviver ao roundtrip de
        // escrita+leitura de stage-status.json — antes desta issue, StageRow
        // não declarava o campo e ele era descartado silenciosamente no
        // persist, mesmo aparecendo corretamente no stdout desta mesma
        // invocação (achado ao vivo: edição 260826, Stage 1 sem motivo em
        // disco para um fallback all_sessions que atribuiu custo alheio).
        const row = loadDoc(editionDir, "260508").rows.find((x) => x.stage === 1)!;
        assert.equal(row.session_filter, "all_sessions");
        assert.equal(row.session_filter_reason, "no_session_id");
      } finally {
        rmSync(editionRoot, { recursive: true, force: true });
        rmSync(transcriptsDir, { recursive: true, force: true });
      }
    });

    it("--session-id vence a variável de ambiente (análise pós-hoc)", () => {
      const { editionRoot, editionDir, transcriptsDir } = setupEdition();
      try {
        writeTwoSessions(transcriptsDir);
        const r = runCli(
          [
            "--edition-dir",
            editionDir,
            "--stage",
            "1",
            "--transcripts-dir",
            transcriptsDir,
            "--session-id",
            "s2",
          ],
          "s1",
        );
        assert.equal(r.status, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        assert.equal(out.session_filter, "current_session");
        assert.equal(out.tokens_in, 5_000_000, "contou s2, não s1");
      } finally {
        rmSync(editionRoot, { recursive: true, force: true });
        rmSync(transcriptsDir, { recursive: true, force: true });
      }
    });

    it("sessão desconhecida cai em all_sessions com motivo — não devolve vazio", () => {
      const { editionRoot, editionDir, transcriptsDir } = setupEdition();
      try {
        writeTwoSessions(transcriptsDir);
        const r = runCli(
          ["--edition-dir", editionDir, "--stage", "1", "--transcripts-dir", transcriptsDir],
          "sessao-de-outra-maquina",
        );
        assert.equal(r.status, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        assert.equal(out.source, "session_transcript", "nunca vira 'unavailable' por causa do filtro");
        assert.equal(out.session_filter, "all_sessions");
        assert.equal(out.session_filter_reason, "session_file_not_found");
        assert.equal(out.tokens_in, 6_000_000);
      } finally {
        rmSync(editionRoot, { recursive: true, force: true });
        rmSync(transcriptsDir, { recursive: true, force: true });
      }
    });
  });
});

describe("captureUsageForWindow — mapeamento dos campos do #5413", () => {
  it("propaga sessionFilter/sessionsExcluded/subagentTokens pro JSON de saída", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-map-"));
    try {
      writeFileSync(join(dir, "a.jsonl"), usageLine(), "utf8");
      writeFileSync(join(dir, "b.jsonl"), usageLine(), "utf8");
      const r = captureUsageForWindow(
        dir,
        "2026-05-08T08:30:00.000Z",
        "2026-05-08T08:48:00.000Z",
        "260508",
        { sessionId: "a" },
      );
      assert.equal(r.session_filter, "current_session");
      assert.equal(r.sessions_excluded, 1);
      assert.equal(r.subagent_tokens_in, null);
      assert.equal(r.subagent_tokens_out, null);
      assert.equal(r.tokens_in, 1_000_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * O caso que o retorno `unavailable` mais precisa descrever: a sessão da
   * edição não tem turno na janela, mas UMA CONCORRENTE tem. Se
   * `sessions_excluded` sumisse aqui, o JSON ficaria idêntico ao de "stage
   * genuinamente sem atividade" — trocando um número contaminado por um
   * silêncio, que é a mesma classe de defeito que o #5413 existe pra matar.
   */
  it("preserva sessions_excluded quando a sessão própria está vazia e a concorrente não", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-map-"));
    try {
      writeFileSync(join(dir, "edicao.jsonl"), usageLine({ timestamp: "2026-05-08T23:00:00.000Z" }), "utf8");
      writeFileSync(join(dir, "concorrente.jsonl"), usageLine(), "utf8");
      const r = captureUsageForWindow(
        dir,
        "2026-05-08T08:30:00.000Z",
        "2026-05-08T08:48:00.000Z",
        "260508",
        { sessionId: "edicao" },
      );
      assert.equal(r.source, "unavailable");
      assert.equal(r.reason, "no_usage_records_in_window");
      assert.equal(r.session_filter, "current_session");
      assert.equal(r.sessions_excluded, 1, "sem isto, 'sem atividade' e 'contaminado' ficam iguais");
      assert.equal(r.subagent_tokens_in, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mantém session_filter no retorno 'unavailable' (janela sem turno da sessão)", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-map-"));
    try {
      writeFileSync(join(dir, "a.jsonl"), usageLine({ timestamp: "2026-05-08T23:00:00.000Z" }), "utf8");
      const r = captureUsageForWindow(
        dir,
        "2026-05-08T08:30:00.000Z",
        "2026-05-08T08:48:00.000Z",
        "260508",
        { sessionId: "a" },
      );
      assert.equal(r.source, "unavailable");
      assert.equal(r.reason, "no_usage_records_in_window");
      assert.equal(r.session_filter, "current_session");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#5423 — propaga parse_errors quando uma linha truncada está no transcript, no caminho de sucesso", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-map-parse-errors-"));
    try {
      const truncated =
        '{"type":"assistant","timestamp":"2026-05-08T08:35:00.000Z","message":{"usage":{"input_to';
      writeFileSync(join(dir, "a.jsonl"), [truncated, usageLine()].join("\n"), "utf8");
      const r = captureUsageForWindow(
        dir,
        "2026-05-08T08:30:00.000Z",
        "2026-05-08T08:48:00.000Z",
        "260508",
        { sessionId: "a" },
      );
      assert.equal(r.source, "session_transcript");
      assert.equal(r.parse_errors, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#5423 — propaga parse_errors também no caminho 'unavailable' (sem isso, o sinal de corrupção se perde exatamente quando o stage já reporta problema)", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-map-parse-errors-unavail-"));
    try {
      const truncated =
        '{"type":"assistant","timestamp":"2026-05-08T08:35:00.000Z","message":{"usage":{"input_to';
      // linha truncada + uma linha boa FORA da janela — resultado cai em
      // "unavailable/no_usage_records_in_window", mas o parse_errors não pode
      // sumir com o resto do diagnóstico.
      writeFileSync(
        join(dir, "a.jsonl"),
        [truncated, usageLine({ timestamp: "2026-05-08T23:00:00.000Z" })].join("\n"),
        "utf8",
      );
      const r = captureUsageForWindow(
        dir,
        "2026-05-08T08:30:00.000Z",
        "2026-05-08T08:48:00.000Z",
        "260508",
        { sessionId: "a" },
      );
      assert.equal(r.source, "unavailable");
      assert.equal(r.reason, "no_usage_records_in_window");
      assert.equal(r.parse_errors, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
