/**
 * #14128 — caracterização do parser de `scripts/log-event.ts` antes e depois
 * da troca do parser próprio por `scripts/lib/cli-args.ts`.
 *
 * `log-event.ts` é chamado em centenas de pontos de playbooks e skills
 * (`.claude/agents/orchestrator-*.md`, `.claude/skills/**`), em geral numa
 * linha só com `--details '{...}'`. Qualquer divergência de parsing quebra o
 * run-log em silêncio, então cada forma real de chamada vira um caso aqui,
 * rodando o script de verdade num cwd temporário (o `platform.config.json`
 * do cwd aponta o `logging.path` para dentro do tmp).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "log-event.ts");
const TSX = import.meta.resolve("tsx");

function run(args: string[]): { status: number | null; stderr: string; events: Record<string, unknown>[] } {
  const dir = mkdtempSync(join(tmpdir(), "log-event-14128-"));
  try {
    writeFileSync(join(dir, "platform.config.json"), JSON.stringify({ logging: { path: "run-log.jsonl" } }));
    const r = spawnSync(process.execPath, ["--import", TSX, SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
    const logPath = join(dir, "run-log.jsonl");
    const events = existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return { status: r.status, stderr: r.stderr, events };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function only(args: string[]): Record<string, unknown> {
  const r = run(args);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.events.length, 1);
  const { timestamp, ...rest } = r.events[0];
  assert.equal(typeof timestamp, "string");
  return rest;
}

describe("log-event.ts — formas reais de chamada (#14128)", () => {
  it("forma canônica com --details JSON", () => {
    assert.deepEqual(
      only([
        "--edition", "260418", "--stage", "0", "--agent", "orchestrator", "--level", "warn",
        "--message", "mcp_disconnect: claude_ai_Gmail", "--details", '{"server":"claude_ai_Gmail","n":2}',
      ]),
      {
        edition: "260418", stage: 0, agent: "orchestrator", level: "warn",
        message: "mcp_disconnect: claude_ai_Gmail", details: { server: "claude_ai_Gmail", n: 2 },
      },
    );
  });

  it("sem --level cai em info; sem edition/stage/agent viram null", () => {
    assert.deepEqual(only(["--message", "edition run started"]), {
      edition: null, stage: null, agent: null, level: "info", message: "edition run started", details: null,
    });
  });

  it("--details que não é JSON vira string crua", () => {
    assert.equal(only(["--message", "m", "--details", "texto livre {sem json"]).details, "texto livre {sem json");
  });

  it("--details com aspas, chaves aninhadas e valores começando com '-'", () => {
    const d = '{"msg":"diz \\"oi\\"","nested":{"a":[1,-2]},"neg":"-5"}';
    assert.deepEqual(only(["--message", "m", "--details", d]).details, {
      msg: 'diz "oi"', nested: { a: [1, -2] }, neg: "-5",
    });
  });

  it("valor que começa com um só '-' é consumido como valor (message e details)", () => {
    const e = only(["--message", "-3 itens a menos", "--details", "-1"]);
    assert.equal(e.message, "-3 itens a menos");
    assert.equal(e.details, -1);
  });

  it("--informational sem valor injeta informational:true no details objeto", () => {
    assert.deepEqual(only(["--level", "warn", "--message", "m", "--details", '{"a":1}', "--informational"]).details, {
      a: 1, informational: true,
    });
  });

  it("--informational antes de outra flag também vale; details ausente vira {informational:true}", () => {
    assert.deepEqual(only(["--informational", "--level", "warn", "--message", "m"]).details, { informational: true });
  });

  it("--details vazio ('') é ignorado (details null), não vira true", () => {
    assert.equal(only(["--message", "m", "--details", ""]).details, null);
  });

  it("--message vazio sai 2 (obrigatório), sem gravar", () => {
    const r = run(["--message", ""]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--message é obrigatório/);
    assert.equal(r.events.length, 0);
  });

  it("--message no fim sem valor vira 'true' (comportamento histórico preservado)", () => {
    assert.equal(only(["--level", "info", "--message"]).message, "true");
  });

  it("sem --message sai 2", () => {
    const r = run(["--level", "info"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--message é obrigatório/);
  });

  it("level inválido sai 2", () => {
    const r = run(["--level", "debug", "--message", "m"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /level inválido: debug/);
  });

  it("token solto (posicional) é ignorado", () => {
    assert.equal(only(["solto", "--message", "m", "outro"]).message, "m");
  });

  it("valor com espaços, acentos e '=' fica intacto", () => {
    assert.equal(
      only(["--message", "gate revisao response: sim (via painel Studio, decided_at=2026-11-26T10:00Z)"]).message,
      "gate revisao response: sim (via painel Studio, decided_at=2026-11-26T10:00Z)",
    );
  });
});

describe("log-event.ts — aditivo depois do #14128", () => {
  it("--key=valor passa a ser reconhecido (antes virava a chave 'details={...}' e se perdia)", () => {
    assert.deepEqual(only(["--message=m", '--details={"a":1}']).details, { a: 1 });
  });
});
