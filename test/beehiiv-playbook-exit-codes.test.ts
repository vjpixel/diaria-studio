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

    // Isolar o bloco de re-render do §4c.6b (entre o marcador #2617 e o
    // início do §4c.6c que o segue). Garante que o assert mira nesse bloco,
    // não em outra invocação dos scripts no arquivo (ex: o re-render do
    // social em §4c.6c, que agora também chama embed-images-base64.ts/
    // serve-preview.ts — #3546 alongou este bloco além dos 1200 chars fixos
    // usados antes, daí o corte por marcador de seção em vez de offset).
    const blockStart = stage4Src.indexOf("Re-render newsletter HTML");
    assert.ok(blockStart >= 0, "bloco §4c.6b de re-render não encontrado");
    const blockEnd = stage4Src.indexOf("**4c.6c —", blockStart);
    assert.ok(blockEnd > blockStart, "início do §4c.6c não encontrado após o bloco §4c.6b");
    const block = stage4Src.slice(blockStart, blockEnd);

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

    // #3546: o preview do gate agora é servido LOCALMENTE (loopback, sem
    // Worker/KV, sem Artifact/CSP) — este bloco de re-render pós-autofix
    // precisa re-gerar a variante embedded e re-servir, não chamar
    // upload-html-public.ts (Worker) nem o tool Artifact.
    assert.doesNotMatch(
      block,
      /\bArtifact\b/,
      "#3546: republicação pós-autofix não deve chamar o tool Artifact — preview é servido localmente",
    );
    assert.doesNotMatch(
      block,
      /upload-html-public\.ts\s+--/,
      "#3546: republicação pós-autofix não deve mais chamar upload-html-public.ts (Worker) — usa serve-preview.ts",
    );
    assert.match(
      block,
      /embed-images-base64\.ts/,
      "#3546: re-render pós-autofix deve gerar a variante embedded via embed-images-base64.ts antes de re-servir",
    );
    assert.match(
      block,
      /serve-preview\.ts/,
      "#3546: re-render pós-autofix deve re-servir localmente via serve-preview.ts",
    );
    assert.match(
      block,
      /serve-preview\.ts[\s\S]*?--stop-pid/,
      "#3546: deve encerrar o servidor de preview anterior (--stop-pid) antes de subir o novo",
    );
    assert.match(
      block,
      /04-newsletter-url\.json/,
      "#3546: deve persistir a URL nova (loopback) em 04-newsletter-url.json via --persist-to",
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

// ── #3546: preview do gate (Stage 4) é servido LOCALMENTE, não Worker/KV ──
// #3420 tinha revertido pra Worker-hosted (upload-html-public.ts) porque
// #3214/Claude Artifacts quebrava por CSP (bloqueia imagem remota, só
// `data:` URI). #3546 resolve isso de outra forma: serve o HTML localmente
// via scripts/serve-preview.ts (loopback, sem CSP, sem cota Workers KV, sem
// rede), com imagens embutidas via scripts/embed-images-base64.ts (mesmo
// script que o mensal já usa pro preview via Artifact, #3392). Cobre Stage 4
// (revisão) — Stage 5 (§5f-ter, pós-dispatch) fica FORA de escopo do #3546
// e continua Worker-hosted (ver describe #3420 acima, ainda válido pra ele).

describe("#3546: preview do Stage 4 é servido localmente (serve-preview.ts), não Worker/Artifact", () => {
  it("orchestrator-stage-4.md §4b (steps 2b/3): serve o preview via serve-preview.ts + embed-images-base64.ts, não via upload-html-public.ts/Artifact", () => {
    const stage4Src = readFileSync(
      resolve(ROOT, ".claude/agents/orchestrator-stage-4.md"),
      "utf8",
    );

    // Isolar o bloco do §4b (entre o step "2b." e o começo do §4c) — cobre a
    // publicação inicial do preview de newsletter e social, o site real do
    // bug original (não só o re-render pós-autofix, já coberto acima).
    const blockStart = stage4Src.indexOf("2b. **Servir preview");
    assert.ok(blockStart >= 0, "step 2b (servir preview localmente) não encontrado");
    const blockEnd = stage4Src.indexOf("### 4c.", blockStart);
    assert.ok(blockEnd > blockStart, "início do §4c não encontrado após step 2b");
    const block = stage4Src.slice(blockStart, blockEnd);

    // `Artifact` entre backticks = sintaxe de invocação do tool. Prosa
    // histórica mencionando "Claude Artifacts"/"Artifact (CSP)" sem
    // backticks (explicando por que #3420 revertera o Worker) é permitida.
    assert.doesNotMatch(
      block,
      /`Artifact`/,
      "#3546: publicação do preview (newsletter + social) não deve chamar o tool Artifact",
    );
    // upload-html-public.ts pode aparecer em PROSA (explicando o histórico
    // #3420 e reservando o script pro upload real da Etapa 5) — o que não
    // pode é ser INVOCADO (seguido de flag) neste bloco de revisão.
    assert.doesNotMatch(
      block,
      /upload-html-public\.ts\s+--/,
      "#3546: publicação do preview não deve invocar upload-html-public.ts (Worker) — usa serve-preview.ts localmente",
    );
    assert.match(
      block,
      /embed-images-base64\.ts/,
      "#3546: preview de newsletter deve gerar a variante embedded via embed-images-base64.ts",
    );
    assert.match(
      block,
      /serve-preview\.ts/,
      "#3546: publicação do preview de newsletter deve usar serve-preview.ts (servidor local)",
    );
    // Preview de social também precisa ser servido localmente.
    assert.match(
      block,
      /serve-preview\.ts[\s\S]*social_preview_url/,
      "#3546: publicação do preview social também deve usar serve-preview.ts (--persist-to/--field social_preview_url)",
    );
  });

  it("orchestrator-stage-4.md: nenhuma instrução residual manda republicar preview via Artifact (edição inline, reordenação, humanização scoped)", () => {
    const stage4Src = readFileSync(
      resolve(ROOT, ".claude/agents/orchestrator-stage-4.md"),
      "utf8",
    );
    assert.doesNotMatch(
      stage4Src,
      /republicar[^\n]*Artifact/i,
      "nenhuma instrução de republicação de preview deve referenciar o tool Artifact",
    );
  });

  it("orchestrator-stage-4.md: teardown dos preview servers locais está presente e cobre newsletter + social (#3546 critério de aceite)", () => {
    const stage4Src = readFileSync(
      resolve(ROOT, ".claude/agents/orchestrator-stage-4.md"),
      "utf8",
    );
    // Precisa encerrar ambos os PIDs persistidos (newsletter e social) em
    // algum ponto do fluxo pós-gate — senão os servidores locais ficam
    // pendurados indefinidamente após o editor decidir sim/abortar/editar.
    assert.match(
      stage4Src,
      /serve-preview\.ts\s+--stop-pid[\s\S]*?newsletter_url_pid/,
      "#3546: deve haver teardown do servidor de preview da newsletter via --stop-pid",
    );
    assert.match(
      stage4Src,
      /serve-preview\.ts\s+--stop-pid[\s\S]*?social_preview_url_pid/,
      "#3546: deve haver teardown do servidor de preview social via --stop-pid",
    );
  });
});

// ── #3420: preview do Stage 5 (pós-dispatch) permanece Worker-hosted ─────
// Fora de escopo do #3546 (issue restringe explicitamente a mudança ao
// caminho de REVISÃO — Stage 4/mensal Etapa 4). O re-render de
// social-preview.html em §5f-ter roda DEPOIS do dispatch real (não é mais
// uma etapa de revisão pré-publicação) e continua usando o mecanismo
// Worker-hosted introduzido em #3420, inalterado por este PR.

describe("#3420: preview do Stage 5 (pós-dispatch) é Worker-hosted, não Claude Artifact", () => {
  it("orchestrator-stage-5.md §5f-ter: re-render do social preview pós-dispatch usa upload-html-public.ts, não Artifact/embed-images-base64", () => {
    const stage5Src = readFileSync(
      resolve(ROOT, ".claude/agents/orchestrator-stage-5.md"),
      "utf8",
    );

    const blockStart = stage5Src.indexOf("### 5f-ter.");
    assert.ok(blockStart >= 0, "§5f-ter (render social preview) não encontrado");
    const block = stage5Src.slice(blockStart, blockStart + 1200);

    assert.doesNotMatch(
      block,
      /`Artifact`/,
      "#3420: §5f-ter não deve chamar o tool Artifact",
    );
    assert.doesNotMatch(
      block,
      /embed-images-base64\.ts/,
      "#3420: §5f-ter não deve chamar embed-images-base64.ts",
    );
    assert.match(
      block,
      /upload-html-public\.ts[\s\S]*?--persist-to[\s\S]*?05-social-preview\.json/,
      "#3420: §5f-ter deve re-upload via upload-html-public.ts --persist-to 05-social-preview.json",
    );
  });

  it("scripts/upload-html-public.ts (mecanismo Worker-hosted) continua presente e exportando persistFieldToJsonFile", () => {
    const scriptSrc = readFileSync(
      resolve(ROOT, "scripts/upload-html-public.ts"),
      "utf8",
    );
    assert.match(
      scriptSrc,
      /export function persistFieldToJsonFile/,
      "upload-html-public.ts deve continuar exportando persistFieldToJsonFile (usado pelo --persist-to, inclusive por scripts/serve-preview.ts #3546)",
    );
  });
});
