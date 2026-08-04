/**
 * test/check-whatsapp-slug-guard.test.ts (#4570)
 *
 * Testa o guard que fecha o item 3 do critério de pronto da issue #4570:
 * bloquear o Stage 6 (agendamento) quando o slug REAL do post Beehiiv
 * diverge do slug que a URL do bloco WhatsApp (entre D1/D2) já prevê
 * (`seoSlug(título do D1)`).
 *
 *   (a) checkWhatsappSlugMatch (scripts/lib/whatsapp-slug-guard.ts) —
 *       função pura, sem rede: slug bate → ok true; slug diverge/ausente →
 *       ok false + mensagem reusando `formatManualSlugFixInstructions`
 *       (scripts/lib/slug.ts, #3449).
 *   (b) CLI check-whatsapp-slug-guard.ts — integração via spawnSync:
 *       exit 0 (bate) / exit 1 (diverge, stderr com instruções) / exit 2
 *       (args inválidos).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { NPX, isWindows } from "./_helpers/spawn-npx.ts";
import { checkWhatsappSlugMatch } from "../scripts/lib/whatsapp-slug-guard.ts";
import { seoSlug, formatManualSlugFixInstructions } from "../scripts/lib/slug.ts";

const D1_TITLE = "Hacker chinês usa DeepSeek em ataques autônomos";
const POST_ID = "post_abc123";

// Título de PALAVRA ÚNICA pra testes que passam por spawnSync (CLI, shell:true
// no Windows) — `spawnSync(cmd, args, {shell:true})` no Windows apenas
// concatena os args (aviso DEP0190, "arguments are not escaped, only
// concatenated"), então um valor com espaço quebra o pareamento --flag/valor
// (mesmo padrão evitado em resolve-edition-url.test.ts:284, cujo único
// --title spawnado é "Automacao", palavra única; multi-palavra e acentos só
// são testados via chamada direta da função pura, nunca via CLI spawnada). A
// cobertura de acentos (#1989 mangling) já está garantida acima, em
// checkWhatsappSlugMatch chamado direto.
const CLI_TITLE = "Titulo";

// ── (a) checkWhatsappSlugMatch — unidade pura ──────────────────────────────

describe("#4570 checkWhatsappSlugMatch — comparação pura slug real vs. previsto", () => {
  it("slug real bate com seoSlug(d1Title) → ok true, sem message", () => {
    const expected = seoSlug(D1_TITLE);
    const result = checkWhatsappSlugMatch(POST_ID, expected, D1_TITLE);
    assert.equal(result.ok, true);
    assert.equal(result.expectedSlug, expected);
    assert.equal(result.actualSlug, expected);
    assert.equal(result.message, undefined);
  });

  it("slug real manglado (mangling PT-BR conhecido, #1989) → ok false + message com instruções manuais", () => {
    const manglado = "hacker-chin-s-usa-deepseek-em-ataques-aut-nomos"; // acentos comidos
    const result = checkWhatsappSlugMatch(POST_ID, manglado, D1_TITLE);
    assert.equal(result.ok, false);
    assert.equal(result.expectedSlug, seoSlug(D1_TITLE));
    assert.equal(result.actualSlug, manglado);
    assert.ok(result.message, "message deve estar presente quando ok=false");
    // A mensagem reusa formatManualSlugFixInstructions — não reinventa o texto.
    assert.ok(
      result.message!.includes(formatManualSlugFixInstructions(POST_ID, seoSlug(D1_TITLE))),
      "message deve conter as instruções formatadas de fix-post-slug.ts (reuse, não reinvenção)",
    );
  });

  it("slug ausente (null) → ok false, tratado como divergência", () => {
    const result = checkWhatsappSlugMatch(POST_ID, null, D1_TITLE);
    assert.equal(result.ok, false);
    assert.equal(result.actualSlug, null);
    assert.ok(result.message?.includes("(ausente)"));
  });

  it("slug ausente (undefined) → mesmo tratamento que null", () => {
    const result = checkWhatsappSlugMatch(POST_ID, undefined, D1_TITLE);
    assert.equal(result.ok, false);
    assert.equal(result.actualSlug, null);
  });

  it("caso real da issue #4570: título com 'chinês'/'autônomos' exige o slug exato citado na issue", () => {
    const expected = seoSlug(D1_TITLE);
    assert.equal(expected, "hacker-chines-usa-deepseek-em-ataques-autonomos");
    const result = checkWhatsappSlugMatch(POST_ID, expected, D1_TITLE);
    assert.equal(result.ok, true);
  });
});

// ── (b) CLI check-whatsapp-slug-guard.ts — integração via spawnSync ───────

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(
    NPX,
    ["tsx", "scripts/check-whatsapp-slug-guard.ts", ...args],
    { encoding: "utf8", stdio: "pipe", shell: isWindows },
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

describe("#4570 CLI check-whatsapp-slug-guard.ts", () => {
  it("exit 0 quando --actual-slug bate com seoSlug(--d1-title)", () => {
    const expected = seoSlug(CLI_TITLE);
    const { exitCode, stdout } = runCli([
      "--post-id", POST_ID,
      "--d1-title", CLI_TITLE,
      "--actual-slug", expected,
    ]);
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
  });

  it("exit 1 quando --actual-slug diverge — stderr traz instruções de correção manual", () => {
    const { exitCode, stdout, stderr } = runCli([
      "--post-id", POST_ID,
      "--d1-title", CLI_TITLE,
      "--actual-slug", "slug-completamente-errado",
    ]);
    assert.equal(exitCode, 1);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false);
    assert.match(stderr, /#4570/);
    assert.match(stderr, /Settings.*SEO\/URL slug|#text-input-slug/);
  });

  it("exit 1 quando --actual-slug é omitido (slug ainda não setado no post)", () => {
    const { exitCode, stdout } = runCli(["--post-id", POST_ID, "--d1-title", CLI_TITLE]);
    assert.equal(exitCode, 1);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.actualSlug, null);
  });

  it("exit 2 quando --post-id ausente", () => {
    const { exitCode } = runCli(["--d1-title", CLI_TITLE]);
    assert.equal(exitCode, 2);
  });

  it("exit 2 quando --d1-title ausente", () => {
    const { exitCode } = runCli(["--post-id", POST_ID]);
    assert.equal(exitCode, 2);
  });
});
