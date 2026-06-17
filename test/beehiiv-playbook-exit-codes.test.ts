/**
 * test/beehiiv-playbook-exit-codes.test.ts (#2335, #2341)
 *
 * Regression guard: verifica que todos os exit codes emitidos por
 * substitute-image-urls.ts estão documentados em beehiiv-playbook.md
 * (evita drift doc↔código).
 *
 * Também testa o guard assertDataTransferAttempted (#2341).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDataTransferAttempted } from "../scripts/lib/beehiiv-cover-upload.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── #2335: exit-code coverage ────────────────────────────────────────────────

describe("#2335: substitute-image-urls.ts exit codes documentados em beehiiv-playbook.md", () => {
  it("extrai todos os process.exit(N) do script e verifica que cada um está no playbook", () => {
    // 1. Ler substitute-image-urls.ts e extrair todos os exit codes
    const scriptSrc = readFileSync(
      resolve(ROOT, "scripts/substitute-image-urls.ts"),
      "utf8",
    );
    const exitCodeMatches = [...scriptSrc.matchAll(/process\.exit\((\d+)\)/g)];
    const exitCodes = [...new Set(exitCodeMatches.map((m) => parseInt(m[1], 10)))].sort(
      (a, b) => a - b,
    );

    // Sanity: o script deve ter pelo menos os 3 exit codes conhecidos
    assert.ok(exitCodes.length >= 2, `Expected ≥2 exit codes, got: ${exitCodes}`);
    assert.ok(exitCodes.includes(1), "exit(1) deve existir (args inválidos)");
    assert.ok(exitCodes.includes(3), "exit(3) deve existir (HTML stale — #2316)");

    // 2. Ler beehiiv-playbook.md e verificar que cada exit code é mencionado
    const playbookSrc = readFileSync(
      resolve(ROOT, "context/publishers/beehiiv-playbook.md"),
      "utf8",
    );

    for (const code of exitCodes) {
      // Aceitar "exit 3", "`3`", "Exit 3", "exit(3)", etc.
      const patterns = [
        new RegExp(`exit\\s*${code}\\b`, "i"),
        new RegExp(`\\b${code}\\b.*stale|stale.*\\b${code}\\b`, "i"),
        new RegExp(`\`${code}\``, "g"),
      ];
      const mentioned = patterns.some((p) => p.test(playbookSrc));
      assert.ok(
        mentioned,
        `Exit code ${code} (de substitute-image-urls.ts) NÃO está documentado em beehiiv-playbook.md. ` +
          `Adicionar entrada na tabela de exit codes do §1.3 (#2335).`,
      );
    }
  });

  it("beehiiv-playbook.md documenta exit 3 com ação de re-render (não como fatal)", () => {
    const playbookSrc = readFileSync(
      resolve(ROOT, "context/publishers/beehiiv-playbook.md"),
      "utf8",
    );
    // Deve mencionar exit 3 e render-newsletter-html (ação de re-render)
    assert.match(
      playbookSrc,
      /render-newsletter-html/,
      "playbook deve mencionar render-newsletter-html como ação para exit 3",
    );
    // Deve deixar claro que NÃO é fatal (aceita "Não é fatal", "not fatal", "não é irrecuperável")
    assert.match(
      playbookSrc,
      /fatal/i,
      "playbook deve mencionar 'fatal' no contexto do exit 3 (#2335)",
    );
  });

  it("orchestrator-stage-4.md também documenta exit 3 de substitute-image-urls", () => {
    const stage4Src = readFileSync(
      resolve(ROOT, ".claude/agents/orchestrator-stage-4.md"),
      "utf8",
    );
    // Deve mencionar exit 3 e que não é fatal
    assert.match(
      stage4Src,
      /\b3\b.*[Hh]TML.*stale|[Hh]TML.*stale.*\b3\b/,
      "orchestrator-stage-4.md deve documentar exit 3 = HTML stale",
    );
    assert.match(
      stage4Src,
      /render-newsletter-html/,
      "orchestrator-stage-4.md deve mencionar render-newsletter-html como ação para exit 3",
    );
  });
});

// ── #2341: assertDataTransferAttempted guard ─────────────────────────────────

describe("#2341: assertDataTransferAttempted — guard pré-cover_status:stale", () => {
  it("não lança quando buildCoverDataTransferJs foi tentado (attempted=true)", () => {
    assert.doesNotThrow(
      () => assertDataTransferAttempted(true),
      "não deve lançar quando DataTransfer foi tentado",
    );
  });

  it("lança Error quando attempted=false (invariante #2341 violada)", () => {
    assert.throws(
      () => assertDataTransferAttempted(false),
      (err: unknown) => {
        assert.ok(err instanceof Error, "deve lançar Error");
        assert.match(err.message, /#2341/, "mensagem deve referenciar #2341");
        assert.match(
          err.message,
          /buildCoverDataTransferJs|#1500/,
          "mensagem deve mencionar buildCoverDataTransferJs ou #1500",
        );
        assert.match(
          err.message,
          /stale_pending_manual|cover_replace_failed/,
          "mensagem deve mencionar os status proibidos",
        );
        return true;
      },
    );
  });

  it("beehiiv-playbook.md documenta o guard (#2341): #1500 primeiro, 2-step só como fallback", () => {
    const playbookSrc = readFileSync(
      resolve(ROOT, "context/publishers/beehiiv-playbook.md"),
      "utf8",
    );
    // Deve mencionar a invariante: #1500 primeiro, inclusive em replace
    assert.match(
      playbookSrc,
      /#2341|#1500.*primeiro|primeiro.*#1500/i,
      "playbook deve mencionar #2341 ou que #1500 vem primeiro (#2341)",
    );
    // Deve mencionar stale_pending_manual como proibido sem ter tentado #1500
    assert.match(
      playbookSrc,
      /stale_pending_manual/,
      "playbook deve mencionar stale_pending_manual no contexto do guard (#2341)",
    );
  });

  it("beehiiv-playbook.md documenta verificação via thumbnail_url da API (#2341)", () => {
    const playbookSrc = readFileSync(
      resolve(ROOT, "context/publishers/beehiiv-playbook.md"),
      "utf8",
    );
    assert.match(
      playbookSrc,
      /thumbnail_url/,
      "playbook deve mencionar thumbnail_url de get_post para verificação (#2341)",
    );
  });

  it("beehiiv-playbook.md nota #1705: campo existe mas plan-gated — não diz mais 'não há via de API' (#2340)", () => {
    const playbookSrc = readFileSync(
      resolve(ROOT, "context/publishers/beehiiv-playbook.md"),
      "utf8",
    );
    // A nota antiga dizia "não há via de API/MCP pra setar/confirmar a capa (thumbnail é UI-only)"
    // Deve ter sido corrigida — campo existe mas plan-gated
    assert.doesNotMatch(
      playbookSrc,
      /thumbnail.*UI-only/,
      "playbook NÃO deve mais dizer 'thumbnail é UI-only' — campo existe mas plan-gated (#2340)",
    );
    // Deve dizer que está gated
    assert.match(
      playbookSrc,
      /plan.*gated|gated.*plan|pago.*plano|plano.*pago/i,
      "playbook deve mencionar que o campo é plan-gated (#2340)",
    );
  });
});
