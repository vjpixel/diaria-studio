/**
 * Tests for #2489 (cpStart guard, EMAIL_CTA_RE simplification, slug in error msgs)
 * and #2494 (lintCredentialBio — no-credential-bio check).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  lintLinkedinPageLink,
  lintLinkedinEmailCTA,
  lintCredentialBio,
  DIARIA_LINKEDIN_PAGE_SLUG,
} from "../scripts/lint-social-md.ts";

// ---------------------------------------------------------------------------
// #2489: lintLinkedinPageLink — cpStart guard (comment_pixel antes de comment_diaria)
// ---------------------------------------------------------------------------

describe("lintLinkedinPageLink — cpStart guard (#2489)", () => {
  it("PASSA quando comment_pixel vem antes de comment_diaria (ordem invertida)", () => {
    // Reproduz o bug: se comment_pixel vier antes de comment_diaria, cpStart < cdStart
    // → end ficava = cpStart < start → slice vazio → falso-positivo "link ausente".
    const md = [
      "# LinkedIn",
      "",
      "## d1",
      "",
      "Texto editorial d1.",
      "",
      "### comment_pixel",
      "",
      "Comentário pessoal antes do diaria.",
      "",
      "### comment_diaria",
      "",
      "Edição completa em {edition_url}",
      "",
      "Siga a Diar.ia em linkedin.com/company/diar.ia.br",
      "",
      "## post_pixel",
      "",
      "<!-- destaque: d1 -->",
      "",
      "Post pessoal.",
      "",
      "Siga a Diar.ia em linkedin.com/company/diar.ia.br",
      "",
      "# Facebook",
      "",
      "## d1",
      "",
      "fb",
    ].join("\n");
    const r = lintLinkedinPageLink(md);
    // O link está presente no comment_diaria — deve PASSAR, não falso-positivo
    assert.equal(r.ok, true, `falso-positivo com cpStart < cdStart: ${JSON.stringify(r.errors)}`);
  });

  it("FALHA quando comment_diaria SEM link e comment_pixel vem antes (ordem invertida)", () => {
    // Garante que o guard não cega o lint: ausência real de link ainda é detectada
    const md = [
      "# LinkedIn",
      "",
      "## d1",
      "",
      "Texto editorial d1.",
      "",
      "### comment_pixel",
      "",
      "Comentário antes.",
      "",
      "### comment_diaria",
      "",
      "Edição completa em {edition_url}",
      "",
      "# Facebook",
      "",
      "## d1",
      "",
      "fb",
    ].join("\n");
    const r = lintLinkedinPageLink(md);
    assert.equal(r.ok, false, "link ausente com ordem invertida deve falhar");
    assert.ok(r.errors.some((e) => e.destaque === "d1"), JSON.stringify(r.errors));
  });
});

// ---------------------------------------------------------------------------
// #2489: EMAIL_CTA_RE simplificado — verificar cobertura das variantes originais
// ---------------------------------------------------------------------------

describe("EMAIL_CTA_RE simplificado (#2489) — cobertura semântica mantida", () => {
  // Verifica que a simplificação do regex não perdeu as variantes que o original cobria.
  // Usa lintLinkedinEmailCTA como proxy (a função que usa EMAIL_CTA_RE).
  const mkPost = (cta: string) =>
    [
      "# LinkedIn",
      "",
      "## d1",
      "",
      "Texto editorial.",
      "",
      "### comment_diaria",
      "",
      `Edição em {edition_url}\n\n${cta}`,
      "",
      "### comment_pixel",
      "",
      "Ok.",
      "",
      "## post_pixel",
      "",
      "Ok.",
      "",
      "# Facebook",
      "",
      "## d1",
      "",
      "fb",
    ].join("\n");

  it("ainda detecta 'assine grátis'", () => {
    const r = lintLinkedinEmailCTA(mkPost("assine grátis em diar.ia.br"));
    assert.equal(r.ok, false, "assine grátis deve ser flagado");
  });

  it("ainda detecta 'assine a Diar.ia'", () => {
    const r = lintLinkedinEmailCTA(mkPost("assine a Diar.ia em diar.ia.br"));
    assert.equal(r.ok, false, "assine a Diar.ia deve ser flagado");
  });

  it("ainda detecta 'assine a newsletter'", () => {
    const r = lintLinkedinEmailCTA(mkPost("assine a newsletter hoje"));
    assert.equal(r.ok, false, "assine a newsletter deve ser flagado");
  });

  it("ainda detecta 'receba por e-mail'", () => {
    const r = lintLinkedinEmailCTA(mkPost("receba por e-mail diariamente"));
    assert.equal(r.ok, false, "receba por e-mail deve ser flagado");
  });

  it("ainda detecta 'inscreva-se na newsletter'", () => {
    const r = lintLinkedinEmailCTA(mkPost("inscreva-se na newsletter de graca"));
    assert.equal(r.ok, false, "inscreva-se na newsletter deve ser flagado");
  });

  it("ainda detecta 'cadastre-se por email'", () => {
    const r = lintLinkedinEmailCTA(mkPost("cadastre-se por email para receber"));
    assert.equal(r.ok, false, "cadastre-se por email deve ser flagado");
  });

  it("ainda detecta 'nossa newsletter'", () => {
    const r = lintLinkedinEmailCTA(mkPost("assine nossa newsletter"));
    assert.equal(r.ok, false, "assine nossa newsletter deve ser flagado");
  });
});

// ---------------------------------------------------------------------------
// #2489: DIARIA_LINKEDIN_PAGE_SLUG nas mensagens de erro
// ---------------------------------------------------------------------------

describe("lintLinkedinPageLink — msgs de erro usam DIARIA_LINKEDIN_PAGE_SLUG (#2489)", () => {
  it("mensagem de erro do comment_diaria contém o slug canônico", () => {
    const md = [
      "# LinkedIn",
      "",
      "## d1",
      "",
      "Texto editorial d1.",
      "",
      "### comment_diaria",
      "",
      "Edicao completa em {edition_url}",
      "",
      "### comment_pixel",
      "",
      "Comentário pessoal.",
      "",
      `## post_pixel`,
      "",
      "<!-- destaque: d1 -->",
      "",
      "Post pessoal.",
      "",
      `Siga a Diar.ia em ${DIARIA_LINKEDIN_PAGE_SLUG}`,
      "",
      "# Facebook",
      "",
      "## d1",
      "",
      "fb",
    ].join("\n");
    const r = lintLinkedinPageLink(md);
    assert.equal(r.ok, false, "deve falhar — comment_diaria sem link");
    const cdErr = r.errors.find((e) => e.section === "comment_diaria");
    assert.ok(cdErr, "erro em comment_diaria esperado");
    assert.ok(
      cdErr!.detail.includes(DIARIA_LINKEDIN_PAGE_SLUG),
      `mensagem de erro deve conter "${DIARIA_LINKEDIN_PAGE_SLUG}", got: ${cdErr!.detail}`,
    );
  });

  it("mensagem de erro do post_pixel contém o slug canônico", () => {
    const md = [
      "# LinkedIn",
      "",
      "## d1",
      "",
      "Texto editorial d1.",
      "",
      "### comment_diaria",
      "",
      "Edicao em {edition_url}",
      "",
      `Siga a Diar.ia em ${DIARIA_LINKEDIN_PAGE_SLUG}`,
      "",
      "### comment_pixel",
      "",
      "Comentário pessoal.",
      "",
      "## post_pixel",
      "",
      "<!-- destaque: d1 -->",
      "",
      "Post pessoal sem link da pagina.",
      "",
      "# Facebook",
      "",
      "## d1",
      "",
      "fb",
    ].join("\n");
    const r = lintLinkedinPageLink(md);
    assert.equal(r.ok, false, "deve falhar — post_pixel sem link");
    const ppErr = r.errors.find((e) => e.section === "post_pixel");
    assert.ok(ppErr, "erro em post_pixel esperado");
    assert.ok(
      ppErr!.detail.includes(DIARIA_LINKEDIN_PAGE_SLUG),
      `mensagem de erro deve conter "${DIARIA_LINKEDIN_PAGE_SLUG}", got: ${ppErr!.detail}`,
    );
  });
});

// ---------------------------------------------------------------------------
// #2494: lintCredentialBio
// ---------------------------------------------------------------------------

/** Helper: monta 03-social.md com post_pixel e comment_pixel configuráveis */
function mkSocialWithBio(opts: {
  postPixel?: string;
  commentPixelD1?: string;
}): string {
  const postPixel =
    opts.postPixel ??
    "A estratégia da Anthropic faz sentido quando você vê o padrão.";
  const commentPixelD1 =
    opts.commentPixelD1 ?? "O frame mudou pra quem implanta agente em producao.";
  return [
    "# LinkedIn",
    "",
    "## d1",
    "",
    "Texto editorial sobre estratégia da Anthropic.",
    "",
    "### comment_diaria",
    "",
    "Edição completa em {edition_url}",
    "",
    "Siga a Diar.ia em linkedin.com/company/diar.ia.br",
    "",
    "### comment_pixel",
    "",
    commentPixelD1,
    "",
    "## d2",
    "",
    "Texto editorial d2.",
    "",
    "### comment_diaria",
    "",
    "Edição completa em {edition_url}",
    "",
    "Siga a Diar.ia em linkedin.com/company/diar.ia.br",
    "",
    "### comment_pixel",
    "",
    "Comentário d2 ok.",
    "",
    "## d3",
    "",
    "Texto editorial d3.",
    "",
    "### comment_diaria",
    "",
    "Edição completa em {edition_url}",
    "",
    "Siga a Diar.ia em linkedin.com/company/diar.ia.br",
    "",
    "### comment_pixel",
    "",
    "Comentário d3 ok.",
    "",
    "## post_pixel",
    "",
    "<!-- destaque: d1 -->",
    "",
    postPixel,
    "",
    "Siga a Diar.ia em linkedin.com/company/diar.ia.br",
    "",
    "#IA #Anthropic",
    "",
    "# Facebook",
    "",
    "## d1",
    "",
    "Post do Facebook.",
    "",
    "Receba noticias de IA todo dia por e-mail, assine gratis em https://diar.ia.br.",
  ].join("\n");
}

describe("lintCredentialBio (#2494)", () => {
  it("FALHA: 'Trabalho com IA ha alguns anos e faco uma newsletter' em post_pixel (caso real 260623)", () => {
    const md = mkSocialWithBio({
      postPixel:
        "Trabalho com IA há alguns anos e faço uma newsletter de IA, a Diar.ia. Esse destaque me chamou atenção.",
    });
    const r = lintCredentialBio(md);
    assert.equal(r.ok, false, "deve falhar com frase de credencial em post_pixel");
    assert.ok(r.matches.some((m) => m.section === "post_pixel"), JSON.stringify(r.matches));
  });

  it("FALHA: 'faco uma newsletter' em post_pixel", () => {
    const md = mkSocialWithBio({
      postPixel: "Faço uma newsletter de IA há anos, então acompanho esse debate bem de perto.",
    });
    const r = lintCredentialBio(md);
    assert.equal(r.ok, false);
    assert.ok(r.matches.some((m) => m.section === "post_pixel"), JSON.stringify(r.matches));
  });

  it("FALHA: 'como alguém que acompanha o setor' em post_pixel", () => {
    const md = mkSocialWithBio({
      postPixel: "Como alguém que acompanha o setor há anos, esse movimento era esperado.",
    });
    const r = lintCredentialBio(md);
    assert.equal(r.ok, false);
    assert.ok(r.matches.some((m) => m.section === "post_pixel"), JSON.stringify(r.matches));
  });

  it("FALHA: 'trabalho com IA há' em comment_pixel (d1)", () => {
    const md = mkSocialWithBio({
      commentPixelD1: "Trabalho com IA há 3 anos e esse frame nunca ficou tão claro.",
    });
    const r = lintCredentialBio(md);
    assert.equal(r.ok, false);
    assert.ok(r.matches.some((m) => m.section.includes("d1")), JSON.stringify(r.matches));
  });

  it("FALHA: 'ha anos que trabalho' em post_pixel", () => {
    const md = mkSocialWithBio({
      postPixel: "Há anos que trabalho com isso e essa decisão me surpreendeu.",
    });
    const r = lintCredentialBio(md);
    assert.equal(r.ok, false);
    assert.ok(r.matches.some((m) => m.section === "post_pixel"), JSON.stringify(r.matches));
  });

  it("PASSA: mencao biográfica sem padrao proibido ('a newsletter de IA que escrevo')", () => {
    const md = mkSocialWithBio({
      postPixel:
        "A newsletter de IA que escrevo cobre exatamente esse tipo de decisão todo dia.",
    });
    const r = lintCredentialBio(md);
    assert.equal(r.ok, true, "menção biográfica sem padrão proibido não deve ser flagada");
    assert.equal(r.matches.length, 0);
  });

  it("PASSA: post_pixel sobre o conteúdo, sem auto-apresentação", () => {
    const md = mkSocialWithBio({
      postPixel:
        "A frase da Anthropic sobre alinhamento como vantagem competitiva é a mais honesta que ouvi de uma big lab em tempos.",
    });
    const r = lintCredentialBio(md);
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 0);
  });

  it("NAO flaga no main post d1 (post de marca — nao é secao pessoal)", () => {
    // O main post da company page nao deve ser avaliado pelo no-credential-bio
    const md = [
      "# LinkedIn",
      "",
      "## d1",
      "",
      "Como alguem que acompanha o setor de IA, essa decisao da Anthropic e relevante.",
      "",
      "### comment_diaria",
      "",
      "Edicao em {edition_url}",
      "",
      "Siga em linkedin.com/company/diar.ia.br",
      "",
      "### comment_pixel",
      "",
      "Comentário ok.",
      "",
      "## post_pixel",
      "",
      "<!-- destaque: d1 -->",
      "",
      "Post sem credential.",
      "",
      "Siga a Diar.ia em linkedin.com/company/diar.ia.br",
      "",
      "# Facebook",
      "",
      "## d1",
      "",
      "fb",
    ].join("\n");
    const r = lintCredentialBio(md);
    // Main post nao deve ser avaliado pelo lint
    assert.equal(r.ok, true, "main post d1 com padrao nao deve ser flagado pelo no-credential-bio");
  });

  it("sem secao LinkedIn = no-op (ok: true)", () => {
    const r = lintCredentialBio("# Facebook\n## d1\nTexto.");
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 0);
  });

  it("CLI: exit 1 com frase de credencial em post_pixel, exit 0 sem credencial", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const scriptPath = join(import.meta.dirname, "..", "scripts", "lint-social-md.ts");
    const run = (md: string) => {
      const dir = mkdtempSync(join(tmpdir(), "cred-bio-cli-"));
      try {
        const p = join(dir, "03-social.md");
        writeFileSync(p, md, "utf8");
        return spawnSync(
          process.execPath,
          ["--import", "tsx", scriptPath, "--check", "no-credential-bio", "--md", p],
          { encoding: "utf8" },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    const withCredential = mkSocialWithBio({
      postPixel:
        "Trabalho com IA há alguns anos e faço uma newsletter de IA, a Diar.ia.",
    });
    assert.equal(run(withCredential).status, 1, "frase de credencial -> exit 1");

    const withoutCredential = mkSocialWithBio({
      postPixel:
        "A decisao da Anthropic sobre alinhamento muda o jogo pra quem constroi em cima dessas APIs.",
    });
    assert.equal(run(withoutCredential).status, 0, "sem credencial -> exit 0");
  });
});
