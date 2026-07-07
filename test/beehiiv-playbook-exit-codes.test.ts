/**
 * test/beehiiv-playbook-exit-codes.test.ts (#2335, #2341)
 *
 * Regression guard: verifica que todos os exit codes emitidos por
 * substitute-image-urls.ts estão documentados em beehiiv-playbook.md
 * (evita drift doc↔código).
 *
 * #2341: a invariante "tentar #1500 antes de declarar falha de cover" é
 * enforced pelo playbook §4b (regras que o orchestrator segue), não por um
 * guard de runtime TS — porque o orchestrator é um agent prompt, não código TS.
 * Testes abaixo verificam que o playbook documenta as regras corretas.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
    assert.ok(exitCodes.length >= 3, `Expected ≥3 exit codes, got: ${exitCodes}`);
    assert.ok(exitCodes.includes(1), "exit(1) deve existir (args inválidos)");
    assert.ok(exitCodes.includes(2), "exit(2) deve existir (placeholders não resolvidas)");
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

// ── #2341: playbook rules enforcement ───────────────────────────────────────
// Note: assertDataTransferAttempted() was removed (dead code — no TS caller).
// The invariant is enforced by playbook §4b rules the orchestrator follows.
// Tests below verify the playbook documents those rules correctly.

describe("#2341: beehiiv-playbook.md rules — #1500 primeiro, 2-step só como fallback", () => {
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

  it("orchestrator-stage-4.md §4c.6b: re-render pós-autofix usa flags que batem com o argv real (#2598 follow-up)", () => {
    const stage4Src = readFileSync(
      resolve(ROOT, ".claude/agents/orchestrator-stage-4.md"),
      "utf8",
    );

    // Isolar o bloco de re-render do §4c.6b (entre o marcador #2617 e a tabela
    // de exit codes #2335 que o segue). Garante que o assert mira nesse bloco,
    // não em outra invocação dos scripts no arquivo.
    const blockStart = stage4Src.indexOf("Re-render newsletter HTML");
    assert.ok(blockStart >= 0, "bloco §4c.6b de re-render não encontrado");
    const block = stage4Src.slice(blockStart, blockStart + 1200);

    // render-newsletter-html.ts: edition-dir é POSICIONAL + escreve em arquivo via --out.
    // O bug original (#2598 follow-up) usava --edition-dir (flag inexistente) e omitia
    // --out → HTML ia pra stdout, newsletter-draft.html nunca era regenerado.
    assert.doesNotMatch(
      block,
      /render-newsletter-html\.ts\s+--edition-dir/,
      "render-newsletter-html.ts recebe edition-dir POSICIONAL, não --edition-dir",
    );
    // #3025: o path da edição agora é {EDITION_DIR}/ (resolvido dinamicamente,
    // flat legado ou nested #2463), não mais o literal data/editions/{AAMMDD}/.
    assert.match(
      block,
      /render-newsletter-html\.ts\s+\{EDITION_DIR\}\/[^\n]*--out\s+\S*newsletter-draft\.html/,
      "render-newsletter-html.ts precisa de --out newsletter-draft.html (senão escreve em stdout)",
    );

    // substitute-image-urls.ts: lê --html (args.html), NÃO --in. Com --in o htmlArg
    // fica undefined → process.exit(1) e o re-render falha silenciosamente.
    assert.doesNotMatch(
      block,
      /substitute-image-urls\.ts[^#]*--in\b/,
      "substitute-image-urls.ts lê --html, não --in (--in → exit 1)",
    );
    assert.doesNotMatch(
      block,
      /substitute-image-urls\.ts[^#]*--edition-dir\b/,
      "substitute-image-urls.ts não aceita --edition-dir",
    );
    assert.match(
      block,
      /substitute-image-urls\.ts[\s\S]*?--html\s+\S*newsletter-draft\.html/,
      "substitute-image-urls.ts precisa de --html newsletter-draft.html",
    );

    // upload-html-public.ts: --no-wrap é OBRIGATÓRIO (#2550) — sobe o fragmento bruto,
    // igual ao §4b. Sem ele, o HTML re-uploadado vai embrulhado no preview-wrapper.
    assert.match(
      block,
      /upload-html-public\.ts[\s\S]*?--no-wrap/,
      "upload-html-public.ts no re-render precisa de --no-wrap (fragmento bruto, #2550)",
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
