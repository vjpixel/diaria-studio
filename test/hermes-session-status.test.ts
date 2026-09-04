/**
 * test/hermes-session-status.test.ts (#6817 item 2)
 *
 * Cobre a função pura (`extractSessionStatus`) e o CLI
 * (`scripts/read-hermes-session-status.ts`) — allowlist de saída pra leitura
 * de `sessions.json`, decisão do editor 03/09/2026 (ver docstring de
 * `scripts/lib/hermes-session-status.ts`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DEFAULT_ALLOWED_SESSION_FIELDS, extractSessionStatus } from "../scripts/lib/hermes-session-status.ts";

describe("extractSessionStatus — objeto mapa sessionId -> registro", () => {
  it("mantém a CHAVE (id estrutural) e filtra o VALOR pelos campos permitidos", () => {
    const raw = {
      "sess-1": { last_status: "ok", model_override: "sonnet", exhausted: false, secret_token: "sk-or-abc123" },
    };
    const out = extractSessionStatus(raw, DEFAULT_ALLOWED_SESSION_FIELDS) as Record<string, unknown>;
    assert.deepEqual(out["sess-1"], { last_status: "ok", model_override: "sonnet", exhausted: false });
    assert.equal(JSON.stringify(out).includes("sk-or-abc123"), false, "campo não-declarado vazou");
  });

  it("campo declarado mas ausente no registro não vira null/undefined explícito — só some", () => {
    const raw = { "sess-1": { last_status: "ok" } };
    const out = extractSessionStatus(raw, DEFAULT_ALLOWED_SESSION_FIELDS) as Record<string, unknown>;
    assert.deepEqual(out["sess-1"], { last_status: "ok" });
    assert.equal(Object.prototype.hasOwnProperty.call(out["sess-1"], "model_override"), false);
  });

  it("campo novo/desconhecido nunca sai por padrão (allowlist fecha, não abre) — o motivo de existir #6817 item 2", () => {
    const raw = { "sess-1": { last_status: "ok", auth_token: "should-never-leak", codex_oauth: "xyz" } };
    const out = extractSessionStatus(raw, DEFAULT_ALLOWED_SESSION_FIELDS) as Record<string, unknown>;
    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes("should-never-leak"), false);
    assert.equal(serialized.includes("codex_oauth"), false);
  });
});

describe("extractSessionStatus — array de registros", () => {
  it("filtra cada elemento; sem allowlist de id, nenhuma identidade vaza por acidente", () => {
    const raw = [
      { session_id: "a", last_status: "ok", token: "secret" },
      { session_id: "b", last_status: "exhausted", token: "secret2" },
    ];
    const out = extractSessionStatus(raw, DEFAULT_ALLOWED_SESSION_FIELDS) as Record<string, unknown>[];
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { last_status: "ok" });
    assert.equal(JSON.stringify(out).includes("session_id"), false, "id não estava na allowlist — não deveria sair");
  });

  it("`--fields` customizado (via allowedFields explícito) inclui o que for pedido, inclusive identidade", () => {
    const raw = [{ session_id: "a", last_status: "ok", token: "secret" }];
    const out = extractSessionStatus(raw, ["session_id", "last_status"]) as Record<string, unknown>[];
    assert.deepEqual(out[0], { session_id: "a", last_status: "ok" });
    assert.equal(JSON.stringify(out).includes("secret"), false);
  });
});

describe("extractSessionStatus — formas inesperadas", () => {
  it("elemento de array que não é objeto -> registro vazio, nunca repassado cru", () => {
    const out = extractSessionStatus(["not-an-object", 42, null], DEFAULT_ALLOWED_SESSION_FIELDS) as unknown[];
    assert.deepEqual(out, [{}, {}, {}]);
  });

  it("topo escalar/null -> null (nada seguro a extrair, nunca adivinha forma)", () => {
    assert.equal(extractSessionStatus("string solta", DEFAULT_ALLOWED_SESSION_FIELDS), null);
    assert.equal(extractSessionStatus(null, DEFAULT_ALLOWED_SESSION_FIELDS), null);
    assert.equal(extractSessionStatus(42, DEFAULT_ALLOWED_SESSION_FIELDS), null);
  });

  it("mapa vazio -> mapa vazio (não lança)", () => {
    assert.deepEqual(extractSessionStatus({}, DEFAULT_ALLOWED_SESSION_FIELDS), {});
  });
});

describe("CLI read-hermes-session-status.ts", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const script = resolve(repoRoot, "scripts/read-hermes-session-status.ts");

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  }

  it("path FORA da allowlist (ex: /tmp) -> denied, exit 1, nada no stdout", () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-session-status-"));
    try {
      const file = join(dir, "sessions.json");
      writeFileSync(file, JSON.stringify({ "sess-1": { last_status: "ok" } }));
      const r = runCli(["--path", file]);
      assert.equal(r.status, 1);
      assert.equal(r.stdout.trim(), "");
      assert.match(r.stderr, /denied/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uso inválido (sem --path) -> exit 2", () => {
    const r = runCli([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /uso:/);
  });

  it("arquivo ausente sob raiz permitida -> exit 2 (path passa a allowlist, mas arquivo não existe)", () => {
    const missing = join(repoRoot, "data", "___arquivo-inexistente-hermes-session-status-test.json");
    const r = runCli(["--path", missing]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /não existe/);
  });
});
