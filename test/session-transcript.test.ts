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
      const entries = parseTranscriptFile(file);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].model, "claude-opus-4-8");
      assert.equal(entries[0].inputTokens, 100);
      assert.equal(entries[0].outputTokens, 50);
      assert.equal(entries[0].cacheCreationInputTokens, 10);
      assert.equal(entries[0].cacheReadInputTokens, 20);
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
        const entries = parseTranscriptFile(file);
        assert.equal(entries.length, 1);
      },
    );
  });

  it("pula linhas assistant sem usage (ex: mensagens de controle)", () => {
    withTempFile(
      [JSON.stringify({ type: "assistant", timestamp: "2026-05-08T08:34:00.000Z", message: { model: "x" } })],
      (file) => {
        assert.equal(parseTranscriptFile(file).length, 0);
      },
    );
  });

  it("tolera linha JSON corrompida sem lançar", () => {
    withTempFile(["{not valid json", usageLine()], (file) => {
      const entries = parseTranscriptFile(file);
      assert.equal(entries.length, 1);
    });
  });

  it("retorna vazio pra arquivo inexistente", () => {
    assert.deepEqual(parseTranscriptFile("/does/not/exist.jsonl"), []);
  });

  it("ignora linhas em branco", () => {
    withTempFile(["", usageLine(), ""], (file) => {
      assert.equal(parseTranscriptFile(file).length, 1);
    });
  });
});

describe("listTranscriptFiles", () => {
  it("retorna vazio pra diretório inexistente", () => {
    assert.deepEqual(listTranscriptFiles("/does/not/exist"), []);
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
