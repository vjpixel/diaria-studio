/**
 * test/dashboard-tokens.test.ts (#6445)
 *
 * Cobre `scripts/studio-ui/dashboard-tokens.ts` — painel "Uso de tokens" do
 * Studio (`GET /painel/tokens`). `buildTokensDashboardHtml` é pura (dado
 * `rootDir`/`now` fixos), mesmo padrão de teste de
 * `dashboard-clarice.test.ts`/`dashboard-diaria` — sem precisar subir o
 * servidor HTTP inteiro. Isolado em tmpdir — nunca toca `data/` real do repo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTokensDashboardHtml } from "../scripts/studio-ui/dashboard-tokens.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "dashboard-tokens-"));
}

describe("buildTokensDashboardHtml (#6445)", () => {
  it("root sem data/ nenhum → HTML válido, sem lançar, com o título do painel", () => {
    const root = tmpRoot();
    try {
      const html = buildTokensDashboardHtml({ rootDir: root });
      assert.match(html, /<!doctype html>/i);
      assert.match(html, /Uso de tokens/);
      assert.match(html, /Sem dados/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("aplica a janela default de 14 dias quando since/until não são passados", () => {
    const root = tmpRoot();
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(
      join(root, "data", "run-log.jsonl"),
      [
        // Dentro da janela (14 dias atrás de 2026-08-28 = 260814).
        JSON.stringify({ agent: "overnight", edition: "260820", message: "coordinator_tokens_estimate", details: { tokens: 5000, source: "harness_usage" } }),
        // Fora da janela (antes de 260814) — não deve aparecer na tabela.
        JSON.stringify({ agent: "overnight", edition: "260101", message: "coordinator_tokens_estimate", details: { tokens: 999999, source: "harness_usage" } }),
      ].join("\n") + "\n",
      "utf8",
    );
    try {
      const now = new Date("2026-08-28T12:00:00Z");
      const html = buildTokensDashboardHtml({ rootDir: root }, now);
      assert.match(html, /260820/);
      assert.doesNotMatch(html, /260101/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--since/--until explícitos sobrepõem o default de 14 dias", () => {
    const root = tmpRoot();
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(
      join(root, "data", "run-log.jsonl"),
      JSON.stringify({ agent: "develop", edition: "260101", message: "coordinator_tokens_estimate", details: { tokens: 1234, source: "harness_usage" } }) + "\n",
      "utf8",
    );
    try {
      const now = new Date("2026-08-28T12:00:00Z");
      const html = buildTokensDashboardHtml({ rootDir: root, since: "260101", until: "260101" }, now);
      assert.match(html, /260101/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("self-review: since/until com aspas duplas não escapam do atributo value= (regressão contra attribute-injection)", () => {
    const root = tmpRoot();
    try {
      const html = buildTokensDashboardHtml({ rootDir: root, since: '260101" onmouseover="alert(1)', until: undefined });
      assert.doesNotMatch(html, /value="260101" onmouseover="alert\(1\)"/);
      assert.match(html, /&quot;/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("nunca lança mesmo com run-log.jsonl corrompido (fail-soft herdado de aggregateRunLogByKindAndDay)", () => {
    const root = tmpRoot();
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "run-log.jsonl"), "{ isto não é json válido\n", "utf8");
    try {
      assert.doesNotThrow(() => buildTokensDashboardHtml({ rootDir: root }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
