import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeProjectDirName,
  claudeProjectsDir,
  resolveTranscriptsDir,
  parseTranscriptFile,
  listTranscriptFiles,
  collectUsageInWindow,
  currentSessionId,
} from "../scripts/lib/session-transcript.ts";

describe("encodeProjectDirName", () => {
  it("substitui : \\ / por - (Windows path)", () => {
    assert.equal(
      encodeProjectDirName("C:\\Users\\x\\Projects\\diaria-studio"),
      "C--Users-x-Projects-diaria-studio",
    );
  });

  it("substitui / por - (POSIX path)", () => {
    assert.equal(encodeProjectDirName("/home/x/diaria-studio"), "-home-x-diaria-studio");
  });

  it("preserva hifens já existentes no nome (ex: diaria-studio)", () => {
    // já coberto pelos casos acima — diaria-studio mantém o hífen interno.
    assert.ok(encodeProjectDirName("/a/diaria-studio").endsWith("diaria-studio"));
  });
});

describe("claudeProjectsDir + resolveTranscriptsDir", () => {
  it("compõe home/.claude/projects/{encoded-cwd}", () => {
    const home = "/home/x";
    const cwd = "/home/x/Projects/diaria-studio";
    const expected = join(claudeProjectsDir(home), encodeProjectDirName(cwd));
    assert.equal(resolveTranscriptsDir(cwd, home), expected);
  });
});

function usageLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-05-08T08:35:00.000Z",
    message: {
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 20,
      },
    },
    ...overrides,
  });
}

describe("parseTranscriptFile", () => {
  function withTempFile(lines: string[], fn: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "session-transcript-test-"));
    const file = join(dir, "session.jsonl");
    writeFileSync(file, lines.join("\n"), "utf8");
    try {
      fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("extrai entradas assistant com usage", () => {
    withTempFile([usageLine()], (file) => {
      const { entries, parseErrors } = parseTranscriptFile(file);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].model, "claude-opus-4-8");
      assert.equal(entries[0].inputTokens, 100);
      assert.equal(entries[0].outputTokens, 50);
      assert.equal(entries[0].cacheCreationInputTokens, 10);
      assert.equal(entries[0].cacheReadInputTokens, 20);
      assert.equal(parseErrors, 0);
    });
  });

  it("pula linhas não-assistant (user, system, file-history-snapshot)", () => {
    withTempFile(
      [
        JSON.stringify({ type: "user", timestamp: "2026-05-08T08:34:00.000Z" }),
        JSON.stringify({ type: "system", timestamp: "2026-05-08T08:34:30.000Z" }),
        usageLine(),
      ],
      (file) => {
        const { entries, parseErrors } = parseTranscriptFile(file);
        assert.equal(entries.length, 1);
        // JSON válido sem usage — caminho `!usage continue`, nunca o `catch`.
        // Não é erro de parse, é o formato esperado da maioria das linhas.
        assert.equal(parseErrors, 0);
      },
    );
  });

  it("pula linhas assistant sem usage (ex: mensagens de controle) sem contar como erro", () => {
    withTempFile(
      [JSON.stringify({ type: "assistant", timestamp: "2026-05-08T08:34:00.000Z", message: { model: "x" } })],
      (file) => {
        const { entries, parseErrors } = parseTranscriptFile(file);
        assert.equal(entries.length, 0);
        assert.equal(parseErrors, 0);
      },
    );
  });

  it("tolera linha JSON corrompida (lixo genérico, não parece evento) sem lançar nem contar", () => {
    withTempFile(["{not valid json", usageLine()], (file) => {
      const { entries, parseErrors } = parseTranscriptFile(file);
      assert.equal(entries.length, 1);
      // "{not valid json" não começa como `{"type":"...` — não parece
      // truncamento de evento real, comportamento pré-#5423 preservado.
      assert.equal(parseErrors, 0);
    });
  });

  it("retorna vazio pra arquivo inexistente", () => {
    assert.deepEqual(parseTranscriptFile("/does/not/exist.jsonl"), { entries: [], parseErrors: 0 });
  });

  it("ignora linhas em branco", () => {
    withTempFile(["", usageLine(), ""], (file) => {
      assert.equal(parseTranscriptFile(file).entries.length, 1);
    });
  });

  describe("#5423 — linha truncada por escrita concorrente conta em parseErrors", () => {
    it("conta linha que COMEÇA como {\"type\":\"assistant\" mas é cortada no meio", () => {
      // Simula o harness fechando a escrita do turno no meio — o prefixo é
      // válido (`{"type":"assistant",...`), mas o objeto nunca fecha.
      const truncated =
        '{"type":"assistant","timestamp":"2026-05-08T08:35:00.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output';
      withTempFile([truncated, usageLine()], (file) => {
        const { entries, parseErrors } = parseTranscriptFile(file);
        // a linha truncada não vira entrada (não parseou), mas a linha boa sim
        assert.equal(entries.length, 1);
        assert.equal(parseErrors, 1);
      });
    });

    it("linha de controle genuína (não-JSON esperado) não é contada como erro", () => {
      // Linha que nunca teve intenção de ser um evento de transcript — não
      // começa com `{"type":"`, então não é confundida com truncamento.
      withTempFile(["not-json-at-all, some log fragment", usageLine()], (file) => {
        const { entries, parseErrors } = parseTranscriptFile(file);
        assert.equal(entries.length, 1);
        assert.equal(parseErrors, 0);
      });
    });

    it("múltiplas linhas truncadas somam parseErrors", () => {
      const truncatedA = '{"type":"assistant","timestamp":"2026-05-08T08:35:00.000Z","message":{"usage":{"in';
      const truncatedB = '{"type":"user","timestamp":"2026-05-08T08:36:00.000Z","message":{"cont';
      withTempFile([truncatedA, truncatedB, usageLine()], (file) => {
        const { entries, parseErrors } = parseTranscriptFile(file);
        assert.equal(entries.length, 1);
        assert.equal(parseErrors, 2);
      });
    });
  });
});

describe("listTranscriptFiles", () => {
  it("retorna vazio pra diretório inexistente, sem logar (caso esperado)", () => {
    const originalError = console.error;
    let called = false;
    console.error = () => {
      called = true;
    };
    try {
      assert.deepEqual(listTranscriptFiles("/does/not/exist"), []);
      assert.equal(called, false);
    } finally {
      console.error = originalError;
    }
  });

  it("#5423 F4 — loga quando readdirSync falha num path que existsSync confirmou existir", () => {
    // Um arquivo comum passa `existsSync` mas `readdirSync` nele lança
    // ENOTDIR — reproduz a mesma classe de anomalia de FS que a issue pede
    // pra não engolir em silêncio (permissão, corrida de FS no diretório real).
    const dir = mkdtempSync(join(tmpdir(), "list-transcripts-notdir-test-"));
    const notADir = join(dir, "not-a-directory.txt");
    writeFileSync(notADir, "conteudo", "utf8");
    const originalError = console.error;
    let loggedArgs: unknown[] | null = null;
    console.error = (...args: unknown[]) => {
      loggedArgs = args;
    };
    try {
      const result = listTranscriptFiles(notADir);
      assert.deepEqual(result, []);
      assert.ok(loggedArgs, "console.error deveria ter sido chamado");
    } finally {
      console.error = originalError;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lista só .jsonl, ignora outros arquivos", () => {
    const dir = mkdtempSync(join(tmpdir(), "list-transcripts-test-"));
    try {
      writeFileSync(join(dir, "a.jsonl"), "", "utf8");
      writeFileSync(join(dir, "b.jsonl"), "", "utf8");
      writeFileSync(join(dir, "notes.txt"), "", "utf8");
      const files = listTranscriptFiles(dir);
      assert.equal(files.length, 2);
      assert.ok(files.every((f) => f.endsWith(".jsonl")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collectUsageInWindow", () => {
  function setupDir(): string {
    return mkdtempSync(join(tmpdir(), "collect-usage-test-"));
  }

  it("agrega tokens de múltiplos arquivos dentro da janela", () => {
    const dir = setupDir();
    try {
      writeFileSync(
        join(dir, "session-a.jsonl"),
        [usageLine({ timestamp: "2026-05-08T08:35:00.000Z" })].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(dir, "session-b.jsonl"),
        [
          usageLine({
            timestamp: "2026-05-08T08:40:00.000Z",
            message: { model: "claude-sonnet-5", usage: { input_tokens: 200, output_tokens: 30 } },
          }),
        ].join("\n"),
        "utf8",
      );
      const result = collectUsageInWindow(dir, "2026-05-08T08:30:00.000Z", "2026-05-08T08:48:00.000Z");
      assert.equal(result.sessionsScanned, 2);
      assert.equal(result.entries.length, 2);
      // tokensIn = (100+10+20) + 200 = 330; tokensOut = 50 + 30 = 80
      assert.equal(result.tokensIn, 330);
      assert.equal(result.tokensOut, 80);
      assert.deepEqual(result.models.sort(), ["claude-opus-4-8", "claude-sonnet-5"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exclui entradas fora da janela de tempo", () => {
    const dir = setupDir();
    try {
      writeFileSync(
        join(dir, "session.jsonl"),
        [
          usageLine({ timestamp: "2026-05-08T07:00:00.000Z" }), // antes da janela
          usageLine({ timestamp: "2026-05-08T08:35:00.000Z" }), // dentro
          usageLine({ timestamp: "2026-05-08T09:30:00.000Z" }), // depois da janela
        ].join("\n"),
        "utf8",
      );
      const result = collectUsageInWindow(dir, "2026-05-08T08:30:00.000Z", "2026-05-08T08:48:00.000Z");
      assert.equal(result.entries.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna vazio (não lança) quando diretório não existe", () => {
    const result = collectUsageInWindow("/does/not/exist", "2026-05-08T08:30:00.000Z", "2026-05-08T08:48:00.000Z");
    assert.equal(result.sessionsScanned, 0);
    assert.equal(result.entries.length, 0);
    assert.equal(result.tokensIn, 0);
    assert.equal(result.tokensOut, 0);
  });
});

describe("currentSessionId (#5413)", () => {
  it("lê CLAUDE_CODE_SESSION_ID do ambiente", () => {
    assert.equal(currentSessionId({ CLAUDE_CODE_SESSION_ID: "abc-123" }), "abc-123");
  });

  it("devolve null quando ausente, vazio ou só espaço", () => {
    assert.equal(currentSessionId({}), null);
    assert.equal(currentSessionId({ CLAUDE_CODE_SESSION_ID: "" }), null);
    assert.equal(currentSessionId({ CLAUDE_CODE_SESSION_ID: "   " }), null);
  });
});

describe("collectUsageInWindow — filtro por sessão (#5413)", () => {
  const WIN = ["2026-05-08T08:30:00.000Z", "2026-05-08T08:48:00.000Z"] as const;

  /**
   * Reproduz a contaminação medida na edição 260814: a sessão da edição
   * (`edicao`) e uma sessão concorrente (`concorrente`, um /diaria-continuo
   * rodando ao lado) gravam turnos na MESMA janela de tempo do stage. Antes
   * do #5413 os dois entravam na conta — 29% do total atribuído à edição
   * vinha de sessões que não eram a edição.
   */
  function setupTwoSessions(): string {
    const dir = mkdtempSync(join(tmpdir(), "session-filter-test-"));
    writeFileSync(
      join(dir, "edicao.jsonl"),
      usageLine({ timestamp: "2026-05-08T08:35:00.000Z" }),
      "utf8",
    );
    writeFileSync(
      join(dir, "concorrente.jsonl"),
      usageLine({
        timestamp: "2026-05-08T08:40:00.000Z",
        message: { model: "claude-sonnet-5", usage: { input_tokens: 900, output_tokens: 700 } },
      }),
      "utf8",
    );
    return dir;
  }

  it("conta SÓ a sessão pedida e reporta a concorrente como excluída", () => {
    const dir = setupTwoSessions();
    try {
      const r = collectUsageInWindow(dir, WIN[0], WIN[1], { sessionId: "edicao" });
      assert.equal(r.sessionFilter, "current_session");
      assert.equal(r.filterReason, undefined);
      assert.equal(r.entries.length, 1);
      // só os 100+10+20 da edição — os 900 da concorrente NÃO entram
      assert.equal(r.tokensIn, 130);
      assert.equal(r.tokensOut, 50);
      assert.equal(r.sessionsExcluded, 1);
      assert.deepEqual(r.models, ["claude-opus-4-8"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem sessionId mantém o comportamento antigo, mas diz que não filtrou", () => {
    const dir = setupTwoSessions();
    try {
      const r = collectUsageInWindow(dir, WIN[0], WIN[1]);
      assert.equal(r.sessionFilter, "all_sessions");
      assert.equal(r.filterReason, "no_session_id");
      assert.equal(r.tokensIn, 130 + 900);
      assert.equal(r.sessionsExcluded, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sessionId inexistente cai em all_sessions com motivo — nunca devolve vazio silencioso", () => {
    const dir = setupTwoSessions();
    try {
      const r = collectUsageInWindow(dir, WIN[0], WIN[1], { sessionId: "sessao-que-nao-existe" });
      assert.equal(r.sessionFilter, "all_sessions");
      assert.equal(r.filterReason, "session_file_not_found");
      assert.equal(r.entries.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("não conta como excluída uma sessão concorrente FORA da janela", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-filter-test-"));
    try {
      writeFileSync(join(dir, "edicao.jsonl"), usageLine(), "utf8");
      writeFileSync(
        join(dir, "outra.jsonl"),
        usageLine({ timestamp: "2026-05-08T23:00:00.000Z" }),
        "utf8",
      );
      const r = collectUsageInWindow(dir, WIN[0], WIN[1], { sessionId: "edicao" });
      assert.equal(r.sessionsExcluded, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collectUsageInWindow — tokens de subagente (#5413)", () => {
  const WIN = ["2026-05-08T08:30:00.000Z", "2026-05-08T08:48:00.000Z"] as const;

  it("devolve null (não 0) quando nenhum turno sidechain existe — o caso real do harness", () => {
    const dir = mkdtempSync(join(tmpdir(), "sidechain-test-"));
    try {
      writeFileSync(join(dir, "s.jsonl"), usageLine(), "utf8");
      const r = collectUsageInWindow(dir, WIN[0], WIN[1], { sessionId: "s" });
      assert.equal(r.subagentTokensIn, null, "null = não registrado, nunca 'custou zero'");
      assert.equal(r.subagentTokensOut, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("soma sidechain separadamente se o harness voltar a gravá-lo", () => {
    const dir = mkdtempSync(join(tmpdir(), "sidechain-test-"));
    try {
      writeFileSync(
        join(dir, "s.jsonl"),
        [
          usageLine(),
          usageLine({
            isSidechain: true,
            message: { model: "claude-sonnet-5", usage: { input_tokens: 500, output_tokens: 40 } },
          }),
        ].join("\n"),
        "utf8",
      );
      const r = collectUsageInWindow(dir, WIN[0], WIN[1], { sessionId: "s" });
      assert.equal(r.subagentTokensIn, 500);
      assert.equal(r.subagentTokensOut, 40);
      // continua dentro do total — o campo é decomposição, não exclusão
      assert.equal(r.tokensIn, 130 + 500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
