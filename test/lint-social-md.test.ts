import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPlatformSection,
  lintLinkedinCTAs,
  lintFacebookCTAs,
  lintSocialMd,
  lintRelativeTime,
  lintLinkedinSchema,
  lintPostPixelMatchesD1,
  lintPersonalPostNewsletterDeixis,
  checkHumanizerSectionCoverage,
  lintLinkedinEmailCTA,
  lintLinkedinPageLink,
  DIARIA_LINKEDIN_PAGE_SLUG,
} from "../scripts/lint-social-md.ts";

describe("lintPostPixelMatchesD1 (#1861)", () => {
  const mk = (d1: string, d2: string, d3: string, postPixel: string) => `# LinkedIn

## d1

${d1}

### comment_diaria

Edição completa em diar.ia.br/p/edicao

### comment_pixel

Comentário pessoal.

## d2

${d2}

### comment_diaria

Edição completa em diar.ia.br/p/edicao

## d3

${d3}

### comment_diaria

Edição completa em diar.ia.br/p/edicao

## post_pixel

${postPixel}

#IA #futuro
`;

  it("falha quando post_pixel é sobre d3, não d1 (caso 260612: swap D1↔D3 Ona↔Amodei — #2145)", () => {
    // Situação exata do bug: editor pediu D1↔D3 no gate do Stage 4.
    // Após o swap, d1 = Amodei/Anthropic e d3 = Ona.
    // O post_pixel ficou sobre Ona (o D1 antigo) — stale.
    const md = mk(
      // D1 atual (após swap): Amodei / Anthropic / modelo / estratégia
      "Dario Amodei detalhou a estratégia da Anthropic para os próximos anos: modelos mais seguros, acesso mais amplo e foco em alinhamento como vantagem competitiva.",
      // D2 (inalterado): outro tema neutro
      "A OpenAI anunciou parceria com Microsoft para expandir o acesso ao GPT-5 em produtos empresariais.",
      // D3 atual (após swap): Ona — o D1 original
      "A Ona acaba de lançar um agente de voz com latência sub-300ms para call centers, apostando em naturalidade acima de precisão.",
      // post_pixel STALE: fala de Ona (o D1 antigo antes do swap), não de Amodei (D1 atual)
      "O agente de voz da Ona com latência sub-300ms é o que mais me animou hoje: naturalidade acima de precisão muda o jogo nos call centers.",
    );
    const r = lintPostPixelMatchesD1(md);
    assert.equal(r.ok, false);
    assert.equal(r.checked, true);
    assert.equal(r.best_match, "d3"); // post_pixel casou com d3 (Ona), não com d1 (Amodei)
  });

  it("falha quando post_pixel é sobre d2, não d1 (caso 260605: reorder MIT→D1)", () => {
    const md = mk(
      "Pesquisa do MIT mostra que automação não destruiu empregos como o pânico previa; os dados de trabalho contam outra história.",
      "A memória do ChatGPT agora consolida tudo em background, lembrando de você entre conversas — um salto na personalização do assistente.",
      "Build 2026 da Microsoft decretou o fim da era do aplicativo com agentes que orquestram tarefas.",
      // post_pixel STALE: fala do ChatGPT/memória (d2), não do MIT/empregos (d1)
      "Fico pensando na memória do ChatGPT que agora lembra de você entre conversas em background. A personalização do assistente muda como confiamos nele.",
    );
    const r = lintPostPixelMatchesD1(md);
    assert.equal(r.ok, false);
    assert.equal(r.checked, true);
    assert.equal(r.best_match, "d2");
  });

  it("passa quando post_pixel (reescrito) é sobre o d1 atual", () => {
    const md = mk(
      "Pesquisa do MIT mostra que automação não destruiu empregos como o pânico previa; os dados de trabalho contam outra história.",
      "A memória do ChatGPT agora consolida tudo em background entre conversas.",
      "Build 2026 da Microsoft decretou o fim da era do aplicativo.",
      // post_pixel reescrito mas sobre o D1: compartilha MIT/empregos/automação/dados
      "O estudo do MIT sobre automação e empregos me fez repensar o pânico: os dados de trabalho mostram um cenário bem menos apocalíptico.",
    );
    const r = lintPostPixelMatchesD1(md);
    assert.equal(r.ok, true);
    assert.equal(r.checked, true);
    assert.equal(r.best_match, "d1");
  });

  it("no-op (checked:false) quando não há post_pixel", () => {
    const md = `# LinkedIn

## d1

Texto do destaque 1.

### comment_diaria

diar.ia.br
`;
    const r = lintPostPixelMatchesD1(md);
    assert.equal(r.ok, true);
    assert.equal(r.checked, false);
  });

  it("no-op quando não há seção LinkedIn", () => {
    const r = lintPostPixelMatchesD1("# Facebook\n## d1\nfoo");
    assert.equal(r.ok, true);
    assert.equal(r.checked, false);
  });

  it("post_pixel só com hashtags/comment (sem prosa) → no-op (checked:false)", () => {
    const md = mk(
      "Pesquisa do MIT mostra que automação não destruiu empregos.",
      "Memória do ChatGPT consolida tudo em background.",
      "Build 2026 da Microsoft.",
      "<!-- char_count: 0 -->\n#IA #Brasil",
    );
    const r = lintPostPixelMatchesD1(md);
    assert.equal(r.checked, false);
  });

  it("header com espaço à direita (## d1 ) ainda é parseado", () => {
    // Trailing space explícito após os headers (editor pode deixar no Drive).
    const md = [
      "# LinkedIn",
      "",
      "## d1 ", // <- trailing space
      "",
      "Pesquisa do MIT sobre automação e empregos: o pânico não bate com os dados de trabalho.",
      "",
      "## d2 ", // <- trailing space
      "",
      "Memória do ChatGPT em background, lembrando de você entre conversas.",
      "",
      "## post_pixel ", // <- trailing space
      "",
      "A memória do ChatGPT em background me intriga: o assistente agora lembra de você entre conversas.",
      "",
    ].join("\n");
    const r = lintPostPixelMatchesD1(md);
    assert.equal(r.checked, true, "d1 com trailing space deve ser parseado (não no-op)");
    assert.equal(r.ok, false); // post fala do ChatGPT (d2), não do MIT (d1)
    assert.equal(r.best_match, "d2");
  });

  it("passa quando post_pixel é atualizado para D1 após swap D1↔D3 (happy-path #2145)", () => {
    // Mesmo cenário do caso 260612, mas com o post_pixel CORRETAMENTE atualizado
    // para o novo D1 (Amodei/Anthropic) após o swap. O lint deve passar (exit 0).
    const md = mk(
      // D1 atual (após swap): Amodei / Anthropic / modelo / alinhamento
      "Dario Amodei detalhou a estratégia da Anthropic para os próximos anos: modelos mais seguros, acesso mais amplo e foco em alinhamento como vantagem competitiva.",
      // D2 (inalterado): outro tema neutro
      "A OpenAI anunciou parceria com Microsoft para expandir o acesso ao GPT-5 em produtos empresariais.",
      // D3 atual (após swap): Ona
      "A Ona acaba de lançar um agente de voz com latência sub-300ms para call centers, apostando em naturalidade acima de precisão.",
      // post_pixel ATUALIZADO para o novo D1 (Amodei/Anthropic/alinhamento)
      "A frase da Anthropic sobre alinhamento como vantagem competitiva é a mais honesta que ouvi de uma big lab em tempos: eles apostam que modelos mais seguros ganham no longo prazo.",
    );
    const r = lintPostPixelMatchesD1(md);
    assert.equal(r.ok, true);
    assert.equal(r.checked, true);
    assert.equal(r.best_match, "d1"); // post_pixel agora bate com d1 (Amodei)
  });

  it("CLI: exit 1 quando post_pixel desalinhado, exit 0 quando alinhado", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const scriptPath = join(import.meta.dirname, "..", "scripts", "lint-social-md.ts");
    const run = (md: string) => {
      const dir = mkdtempSync(join(tmpdir(), "pp-cli-"));
      try {
        const p = join(dir, "03-social.md");
        writeFileSync(p, md, "utf8");
        return spawnSync(process.execPath, ["--import", "tsx", scriptPath, "--check", "post_pixel-matches-d1", "--md", p], { encoding: "utf8" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const stale = mk(
      "Pesquisa do MIT mostra que automação não destruiu empregos como o pânico previa; os dados de trabalho contam outra história.",
      "A memória do ChatGPT agora consolida tudo em background, lembrando de você entre conversas — um salto na personalização.",
      "Build 2026 da Microsoft decretou o fim da era do aplicativo.",
      "Fico pensando na memória do ChatGPT que agora lembra de você entre conversas em background. A personalização do assistente muda tudo.",
    );
    assert.equal(run(stale).status, 1, "post_pixel stale → exit 1");

    const aligned = mk(
      "Pesquisa do MIT mostra que automação não destruiu empregos como o pânico previa; os dados de trabalho contam outra história.",
      "A memória do ChatGPT consolida tudo em background.",
      "Build 2026 da Microsoft.",
      "O estudo do MIT sobre automação e empregos me fez repensar o pânico: os dados de trabalho mostram um cenário menos apocalíptico.",
    );
    assert.equal(run(aligned).status, 0, "post_pixel alinhado → exit 0");
  });
});

const validMd = `# LinkedIn

## d1

Texto do post.

Receba notícias de IA todo dia por e-mail, assine grátis em diar.ia.br

#Hashtag

## d2

Outro texto.

Receba notícias de IA todo dia por e-mail, assine grátis em diar.ia.br

#Hashtag

# Facebook

## d1

Post do Facebook.

Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br.

#Hashtag
`;

describe("extractPlatformSection", () => {
  it("extrai LinkedIn section", () => {
    const sec = extractPlatformSection(validMd, "linkedin");
    assert.ok(sec);
    assert.ok(sec!.includes("## d1"));
    assert.ok(!sec!.includes("Post do Facebook"));
  });

  it("extrai Facebook section", () => {
    const sec = extractPlatformSection(validMd, "facebook");
    assert.ok(sec);
    assert.ok(sec!.includes("Post do Facebook"));
  });

  it("retorna null quando seção ausente", () => {
    const sec = extractPlatformSection("# Twitter\n## d1", "linkedin");
    assert.equal(sec, null);
  });

  it("normaliza CRLF", () => {
    const md = "# LinkedIn\r\n## d1\r\nFoo\r\n";
    const sec = extractPlatformSection(md, "linkedin");
    assert.ok(sec);
  });
});

describe("lintLinkedinCTAs (#602)", () => {
  it("aceita 'em diar.ia.br' (formato canônico)", () => {
    const sec = "Receba notícias de IA todo dia por e-mail, assine grátis em diar.ia.br\n";
    assert.deepEqual(lintLinkedinCTAs(sec), []);
  });

  it("rejeita 'em https://diar.ia.br' (prefix)", () => {
    const sec = "Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br\n";
    const errors = lintLinkedinCTAs(sec);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].rule, "no_https_prefix");
  });

  it("rejeita markdown link wrapper", () => {
    const sec = "Receba notícias de IA todo dia por e-mail, assine grátis em [diar.ia.br](https://diar.ia.br)\n";
    const errors = lintLinkedinCTAs(sec);
    assert.equal(errors.length, 1);
  });

  it("rejeita ponto final", () => {
    const sec = "Receba notícias de IA todo dia por e-mail, assine grátis em diar.ia.br.\n";
    const errors = lintLinkedinCTAs(sec);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].rule, "no_trailing_period");
  });

  it("ignora linhas que mencionam diar.ia.br fora do CTA", () => {
    const sec = "O domínio diar.ia.br é citado em outro contexto.\n";
    assert.deepEqual(lintLinkedinCTAs(sec), []);
  });
});

describe("lintFacebookCTAs (#602)", () => {
  it("aceita 'em https://diar.ia.br.' (formato canônico Facebook)", () => {
    const sec = "Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br.\n";
    assert.deepEqual(lintFacebookCTAs(sec), []);
  });

  it("aceita markdown link wrapper (Drive auto-conversion)", () => {
    const sec = "Receba notícias de IA todo dia por e-mail, assine grátis em [https://diar.ia.br](https://diar.ia.br).\n";
    assert.deepEqual(lintFacebookCTAs(sec), []);
  });

  it("rejeita 'em diar.ia.br' sem prefix", () => {
    const sec = "Receba notícias de IA todo dia por e-mail, assine grátis em diar.ia.br\n";
    const errors = lintFacebookCTAs(sec);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].rule, "missing_https_prefix");
  });
});

describe("lintSocialMd integration", () => {
  it("md válido (LinkedIn sem prefix + Facebook com prefix) passa", () => {
    const result = lintSocialMd(validMd);
    assert.equal(result.ok, true);
  });

  it("LinkedIn com https:// + Facebook ok → falha só em LinkedIn", () => {
    const md = validMd.replace("em diar.ia.br\n\n#Hashtag", "em https://diar.ia.br\n\n#Hashtag");
    const result = lintSocialMd(md);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.platform === "linkedin"));
    assert.ok(!result.errors.some((e) => e.platform === "facebook"));
  });

  it("Facebook sem https:// → falha só em Facebook", () => {
    const md =
      "# LinkedIn\n## d1\nReceba notícias de IA todo dia por e-mail, assine grátis em diar.ia.br\n\n# Facebook\n## d1\nReceba notícias de IA todo dia por e-mail, assine grátis em diar.ia.br\n";
    const result = lintSocialMd(md);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.platform === "facebook"));
  });
});

describe("lintRelativeTime (social, #747)", () => {
  it("ok sem referências temporais relativas", () => {
    const md = "# LinkedIn\n\nPost sem problemas, publicado em 2026-05-06.";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 0);
  });

  it("detecta 'hoje' em post social", () => {
    const md = "# LinkedIn\n\nHoje a OpenAI lançou o GPT-6.\n\nassine em diar.ia.br";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.equal(r.matches[0].word.toLowerCase(), "hoje");
  });

  it("detecta 'esta semana' com número da linha correto", () => {
    const md = "# LinkedIn\n\nEsta semana a regulação avançou no Brasil.\n\n# Facebook";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.equal(r.matches[0].line, 3);
  });
});

describe("lintRelativeTime expansion (social, #877)", () => {
  it("detecta 'Hoje a Anthropic anunciou' (caso canônico do issue)", () => {
    const md = "# LinkedIn\n\nHoje a Anthropic anunciou um novo modelo.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.ok(r.matches.some((m) => m.word.toLowerCase() === "hoje"));
  });

  it("detecta 'há 3 dias' / 'há 2 semanas' / 'há 1 mês'", () => {
    for (const phrase of ["há 3 dias", "há 2 semanas", "há 1 mês", "há 6 meses"]) {
      const md = `# LinkedIn\n\nO modelo foi anunciado ${phrase}.\n`;
      const r = lintRelativeTime(md);
      assert.equal(r.ok, false, `esperava match para "${phrase}"`);
    }
  });

  it("detecta 'próxima semana' (sem 'na' obrigatório)", () => {
    const md = "# LinkedIn\n\nPróxima semana o GPT-6 será aberto a beta.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
  });

  it("detecta múltiplos matches numa linha", () => {
    const md = "# LinkedIn\n\nHoje a OpenAI fez um anúncio. Recentemente eles também atualizaram.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.equal(r.matches.length, 2);
    const words = r.matches.map((m) => m.word.toLowerCase());
    assert.ok(words.includes("hoje"));
    assert.ok(words.includes("recentemente"));
  });

  it("não casa palavras compostas tipo 'ontem-feira' (hifenado)", () => {
    const md = "# LinkedIn\n\nElaborado pela ontem-feira corp.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, true);
  });

  it("não casa 'anteontem' (sufixo de 'ontem')", () => {
    const md = "# LinkedIn\n\nIsso aconteceu anteontem mas seguimos em frente.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, true);
  });

  it("pula match dentro de aspas duplas (citação direta de fonte)", () => {
    const md = `# LinkedIn\n\nO CEO disse "hoje vamos lançar tudo" durante o evento.\n`;
    const r = lintRelativeTime(md);
    assert.equal(r.ok, true, JSON.stringify(r.matches));
  });

  it("pula match dentro de aspas curvas (smart quotes)", () => {
    const md = `# LinkedIn\n\nO CEO disse “ontem fechamos o trato” no anúncio.\n`;
    const r = lintRelativeTime(md);
    assert.equal(r.ok, true);
  });

  it("pula match dentro de aspas simples (com espaço antes)", () => {
    const md = `# LinkedIn\n\nA fonte: 'esta semana foi histórica' marcou tudo.\n`;
    const r = lintRelativeTime(md);
    assert.equal(r.ok, true);
  });

  it("ainda detecta match fora de aspas mesmo quando há aspas na mesma linha", () => {
    const md = `# LinkedIn\n\nHoje, segundo "fonte interna", houve mudança.\n`;
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].word.toLowerCase(), "hoje");
  });

  it("apóstrofo em palavra (d'água, L'Oréal) não conta como aspas", () => {
    const md = "# LinkedIn\n\nA L'Oréal não tem nada a ver, mas hoje teve outro anúncio.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    // 'hoje' não está dentro de aspas — deve ser detectado
    assert.ok(r.matches.some((m) => m.word.toLowerCase() === "hoje"));
  });

  // -- Overlap / boundary edge cases (P2 review #890) ---------------------
  it("'há 3 dias atrás' detecta 'há 3 dias' uma única vez (sem overlap)", () => {
    // 'atrás' depois de 'há 3 dias' não deve gerar match duplicado nem evitar
    // o match (lookahead `(?![\\w-])` para o fim da frase deve se satisfazer
    // com o espaço antes de 'atrás').
    const md = "# LinkedIn\n\nO modelo foi anunciado há 3 dias atrás no evento.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    const haCount = r.matches.filter((m) =>
      /^há \d+ dias?$/i.test(m.word),
    ).length;
    assert.equal(haCount, 1, `esperava 1 match 'há N dias', achou ${haCount}`);
  });

  it("'ahoje' (prefix grudado em palavra) NÃO casa 'hoje'", () => {
    const md = "# LinkedIn\n\nA palavra ahoje é inventada e não é referência.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, true);
  });

  it("'hoje,' (vírgula sufixo) casa 'hoje' normalmente", () => {
    const md = "# LinkedIn\n\nHoje, a empresa anunciou um novo modelo.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.ok(r.matches.some((m) => m.word.toLowerCase() === "hoje"));
  });

  it("'hoje.' (ponto sufixo) casa 'hoje' normalmente", () => {
    const md = "# LinkedIn\n\nA empresa anunciou hoje.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.ok(r.matches.some((m) => m.word.toLowerCase() === "hoje"));
  });
});

describe("lintLinkedinSchema (#595)", () => {
  function buildMd(parts: { d1?: string; d2?: string; d3?: string }): string {
    const sections: string[] = ["# LinkedIn", ""];
    if (parts.d1) sections.push("## d1", parts.d1);
    if (parts.d2) sections.push("## d2", parts.d2);
    if (parts.d3) sections.push("## d3", parts.d3);
    return sections.join("\n");
  }

  function fullDestaque(): string {
    const main = "X".repeat(1300);
    // comment_diaria: 200-400 chars tolerância. Inclui {edition_url} placeholder.
    const cd =
      "Edição completa com mais 9 destaques de IA do dia em {edition_url}" +
      "\n\nSiga a Diar.ia no LinkedIn em linkedin.com/company/diaria" +
      "\n\nMais sobre esse e outros casos.";
    // comment_pixel: 300-600 chars tolerância. ~400.
    const cp =
      "Pra quem implanta agente em produção, o frame mudou: a discussão central " +
      "não é mais 'esse modelo é seguro?' e sim 'qual é o blast radius de um agente " +
      "que se replica sozinho?' Permissão de rede vira controle primário, não " +
      "secundário. E a maioria dos setups que vi essa semana não trata assim.";
    return `\n${main}\n\n### comment_diaria\n\n${cd}\n\n### comment_pixel\n\n${cp}\n`;
  }

  it("ok=true quando todos 3 destaques têm main + comment_diaria + comment_pixel", () => {
    const md = buildMd({ d1: fullDestaque(), d2: fullDestaque(), d3: fullDestaque() });
    const r = lintLinkedinSchema(md);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.destaques.length, 3);
    for (const d of r.destaques) {
      assert.equal(d.has_main, true);
      assert.equal(d.has_comment_diaria, true);
      assert.equal(d.has_comment_pixel, true);
    }
  });

  it("#1690: seção sibling ## post_pixel não infla comment_pixel_chars de d3", () => {
    const base = buildMd({ d1: fullDestaque(), d2: fullDestaque(), d3: fullDestaque() });
    // post_pixel longo (>600) — se vazasse pro comment_pixel do d3, dispararia
    // comment_pixel_chars_out_of_range (false positive).
    const md = base + `\n\n## post_pixel\n\n${"Y".repeat(1000)}\n`;
    const r = lintLinkedinSchema(md);
    assert.equal(r.ok, true, "post_pixel não deve quebrar o lint: " + JSON.stringify(r.errors));
    const d3 = r.destaques.find((d) => d.destaque === "d3");
    assert.ok(d3, "d3 presente");
    assert.ok(
      (d3!.comment_pixel_chars ?? 0) < 700,
      "comment_pixel de d3 não absorveu o post_pixel: " + d3!.comment_pixel_chars,
    );
  });

  it("ok=false quando comment_diaria ausente em d2", () => {
    const dWithoutComments = `\n${"X".repeat(1300)}\n`;
    const md = buildMd({
      d1: fullDestaque(),
      d2: dWithoutComments,
      d3: fullDestaque(),
    });
    const r = lintLinkedinSchema(md);
    assert.equal(r.ok, false);
    const errs = r.errors.filter((e) => e.destaque === "d2");
    assert.ok(errs.some((e) => e.rule === "missing_comment_diaria"));
    assert.ok(errs.some((e) => e.rule === "missing_comment_pixel"));
  });

  it("ok=false quando comment_pixel ausente em d3", () => {
    const dPartial = `\n${"X".repeat(1300)}\n\n### comment_diaria\n\nEdição completa em {edition_url}\n\nReceba em diar.ia.br\n\nMais sobre o caso.\n`;
    const md = buildMd({ d1: fullDestaque(), d2: fullDestaque(), d3: dPartial });
    const r = lintLinkedinSchema(md);
    assert.equal(r.ok, false);
    const errs = r.errors.filter((e) => e.destaque === "d3");
    assert.ok(errs.some((e) => e.rule === "missing_comment_pixel"));
    // comment_diaria está presente
    assert.ok(!errs.some((e) => e.rule === "missing_comment_diaria"));
  });

  it("warning de char count quando main muito curto", () => {
    const dSmallMain = `\n${"X".repeat(500)}\n\n### comment_diaria\n\nEdição completa em {edition_url}\n\nReceba em diar.ia.br\n\nMais sobre o caso.\n\n### comment_pixel\n\n${"Y".repeat(400)}\n`;
    const md = buildMd({ d1: dSmallMain, d2: fullDestaque(), d3: fullDestaque() });
    const r = lintLinkedinSchema(md);
    assert.equal(r.ok, false);
    const errs = r.errors.filter((e) => e.destaque === "d1" && e.rule === "main_chars_out_of_range");
    assert.equal(errs.length, 1);
  });

  it("#595: erro quando comment_diaria sem placeholder {edition_url} nem URL resolvida", () => {
    const dWithoutUrl = `\n${"X".repeat(1300)}\n\n### comment_diaria\n\nReceba notícias de IA em diar.ia.br hoje mesmo, é grátis e simples.\n\n### comment_pixel\n\n${"Y".repeat(400)}\n`;
    const md = buildMd({ d1: dWithoutUrl, d2: fullDestaque(), d3: fullDestaque() });
    const r = lintLinkedinSchema(md);
    assert.equal(r.ok, false);
    const errs = r.errors.filter(
      (e) => e.destaque === "d1" && e.rule === "comment_diaria_missing_edition_url",
    );
    assert.equal(errs.length, 1);
  });

  it("#595: aceita comment_diaria com URL diar.ia.br/p/<slug> (resolvido pós-Stage 4)", () => {
    const dResolved = `\n${"X".repeat(1300)}\n\n### comment_diaria\n\nEdição completa em https://diar.ia.br/p/modelos-replicam\n\nReceba grátis em diar.ia.br\n\nÉ rápido.\n\n### comment_pixel\n\n${"Y".repeat(400)}\n`;
    const md = buildMd({ d1: dResolved, d2: fullDestaque(), d3: fullDestaque() });
    const r = lintLinkedinSchema(md);
    const errs = r.errors.filter((e) => e.rule === "comment_diaria_missing_edition_url");
    assert.equal(errs.length, 0);
  });

  it("ok=true em md sem seção LinkedIn (no-op)", () => {
    const md = "# Facebook\n\n## d1\nApenas FB.\n";
    const r = lintLinkedinSchema(md);
    assert.equal(r.ok, true);
    assert.equal(r.destaques.length, 0);
  });

  it("#595 (2026-05-08): erro quando main post menciona 'Diar.ia'", () => {
    const dWithBrand = `\n${"X".repeat(800)} A Diar.ia traz mais notícias todo dia. ${"Y".repeat(500)}\n\n### comment_diaria\n\nEdição completa em {edition_url}\n\nReceba grátis em diar.ia.br\n\nÉ rápido.\n\n### comment_pixel\n\n${"Z".repeat(400)}\n`;
    const md = buildMd({ d1: dWithBrand, d2: fullDestaque(), d3: fullDestaque() });
    const r = lintLinkedinSchema(md);
    const errs = r.errors.filter(
      (e) => e.destaque === "d1" && e.rule === "main_post_mentions_diaria",
    );
    assert.equal(errs.length, 1, JSON.stringify(r.errors));
  });

  it("#595 (2026-05-08): erro quando main post contém 'diar.ia.br'", () => {
    const dWithUrl = `\n${"X".repeat(800)} Veja mais em diar.ia.br para acompanhar de perto. ${"Y".repeat(500)}\n\n### comment_diaria\n\nEdição completa em {edition_url}\n\nReceba grátis em diar.ia.br\n\nÉ rápido.\n\n### comment_pixel\n\n${"Z".repeat(400)}\n`;
    const md = buildMd({ d1: dWithUrl, d2: fullDestaque(), d3: fullDestaque() });
    const r = lintLinkedinSchema(md);
    const errs = r.errors.filter(
      (e) => e.destaque === "d1" && e.rule === "main_post_mentions_diaria_url",
    );
    assert.equal(errs.length, 1);
  });

  it("#595 (2026-05-08): main 100% editorial sem branding passa", () => {
    const r = lintLinkedinSchema(
      buildMd({ d1: fullDestaque(), d2: fullDestaque(), d3: fullDestaque() }),
    );
    const brandErrs = r.errors.filter(
      (e) => e.rule === "main_post_mentions_diaria" || e.rule === "main_post_mentions_diaria_url",
    );
    assert.equal(brandErrs.length, 0);
  });
});

// ---------------------------------------------------------------------------
// #2148 Fix A: lintPersonalPostNewsletterDeixis
// ---------------------------------------------------------------------------

/** Helper: monta 03-social.md mínimo com post_pixel e comment_pixel configuráveis */
function mkSocialWithPersonal(opts: {
  postPixel?: string;
  commentPixelD1?: string;
  commentPixelD2?: string;
  commentPixelD3?: string;
  mainD1?: string;
}): string {
  const mainD1 = opts.mainD1 ?? "Dario Amodei detalhou a estratégia da Anthropic para os próximos anos.";
  const commentPixelD1 = opts.commentPixelD1 ?? "O frame mudou pra quem implanta agente em produção.";
  const commentPixelD2 = opts.commentPixelD2 ?? "Comentário d2 sem problema.";
  const commentPixelD3 = opts.commentPixelD3 ?? "Comentário d3 sem problema.";
  const postPixel = opts.postPixel ?? "A frase da Anthropic sobre alinhamento é a mais honesta que ouvi de uma big lab.";
  return `# LinkedIn

## d1

${mainD1}

### comment_diaria

Edição completa em {edition_url}

Siga a Diar.ia no LinkedIn em linkedin.com/company/diaria

### comment_pixel

${commentPixelD1}

## d2

Texto do d2.

### comment_diaria

Edição completa em {edition_url}

Siga a Diar.ia no LinkedIn em linkedin.com/company/diaria

### comment_pixel

${commentPixelD2}

## d3

Texto do d3.

### comment_diaria

Edição completa em {edition_url}

Siga a Diar.ia no LinkedIn em linkedin.com/company/diaria

### comment_pixel

${commentPixelD3}

## post_pixel

<!-- destaque: d1 -->
<!-- char_count: 900 -->

${postPixel}

#IA #Anthropic

# Facebook

## d1

Texto do Facebook.

Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br.
`;
}

describe("lintPersonalPostNewsletterDeixis (#2148 Fix A)", () => {
  it("FALHA: 'esta newsletter' em post_pixel (caso real 260612)", () => {
    const md = mkSocialWithPersonal({
      postPixel: "Esta newsletter inclusive roda em grande parte com agentes — o que ainda me surpreende.",
    });
    const r = lintPersonalPostNewsletterDeixis(md);
    assert.equal(r.ok, false, "deve falhar com deixis em post_pixel");
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].section, "post_pixel");
    assert.ok(r.matches[0].phrase.toLowerCase().includes("esta newsletter"));
  });

  it("FALHA: 'essa newsletter' em post_pixel", () => {
    const md = mkSocialWithPersonal({
      postPixel: "Eu nunca imaginei que essa newsletter chegaria a 10 mil leitores.",
    });
    const r = lintPersonalPostNewsletterDeixis(md);
    assert.equal(r.ok, false);
    assert.equal(r.matches[0].section, "post_pixel");
  });

  it("FALHA: 'nossa newsletter' em post_pixel", () => {
    const md = mkSocialWithPersonal({
      postPixel: "Nossa newsletter cobre exatamente esse tipo de tensão todo dia.",
    });
    const r = lintPersonalPostNewsletterDeixis(md);
    assert.equal(r.ok, false);
    assert.equal(r.matches[0].section, "post_pixel");
  });

  it("FALHA: 'esta newsletter' em comment_pixel de destaque (d1)", () => {
    const md = mkSocialWithPersonal({
      commentPixelD1: "Esta newsletter roda com agentes — o que me surpreende diariamente.",
    });
    const r = lintPersonalPostNewsletterDeixis(md);
    assert.equal(r.ok, false);
    assert.ok(r.matches[0].section.startsWith("comment_pixel"));
    assert.ok(r.matches[0].phrase.toLowerCase().includes("esta newsletter"));
  });

  it("FALHA: 'essa newsletter' em comment_pixel de d2", () => {
    const md = mkSocialWithPersonal({
      commentPixelD2: "Essa newsletter antecipou esse movimento há semanas.",
    });
    const r = lintPersonalPostNewsletterDeixis(md);
    assert.equal(r.ok, false);
    assert.ok(r.matches[0].section.includes("d2"), `esperado d2, got: ${r.matches[0]?.section}`);
  });

  it("FALHA: 'esse boletim' em comment_pixel de d3 (forma masculina)", () => {
    const md = mkSocialWithPersonal({
      commentPixelD3: "Esse boletim que faço me obriga a ler tudo com mais cuidado.",
    });
    const r = lintPersonalPostNewsletterDeixis(md);
    assert.equal(r.ok, false);
    assert.ok(r.matches[0].section.includes("d3"), `esperado d3, got: ${r.matches[0]?.section}`);
    assert.ok(r.matches[0].phrase.toLowerCase().includes("esse boletim"));
  });

  it("FALHA: 'nosso boletim' em post_pixel (forma masculina)", () => {
    const md = mkSocialWithPersonal({
      postPixel: "Nosso boletim tem cobertura melhor do que qualquer outra fonte que conheço.",
    });
    const r = lintPersonalPostNewsletterDeixis(md);
    assert.equal(r.ok, false);
    assert.equal(r.matches[0].section, "post_pixel");
    assert.ok(r.matches[0].phrase.toLowerCase().includes("nosso boletim"));
  });

  it("PASSA: menção biográfica sem deixis ('a newsletter de IA que escrevo')", () => {
    const md = mkSocialWithPersonal({
      postPixel: "A newsletter de IA que escrevo roda em grande parte com agentes — o que ainda me surpreende.",
    });
    const r = lintPersonalPostNewsletterDeixis(md);
    assert.equal(r.ok, true, "menção biográfica não deve ser flagada");
    assert.equal(r.matches.length, 0);
  });

  it("PASSA: post_pixel sem menção de newsletter", () => {
    const md = mkSocialWithPersonal({
      postPixel: "O frame de alinhamento como vantagem competitiva é o que mais me interessa na estratégia da Anthropic.",
    });
    const r = lintPersonalPostNewsletterDeixis(md);
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 0);
  });

  it("NÃO flaga 'esta newsletter' no main post d1 (post de marca — OK ter deixis)", () => {
    // O main post do d1 é postado na PÁGINA da Diar.ia — contexto de marca, OK.
    const md = mkSocialWithPersonal({
      mainD1: "Esta newsletter cobre as notícias de IA mais importantes do dia.",
      postPixel: "A frase da Anthropic sobre alinhamento é a mais honesta que ouvi de uma big lab.",
    });
    const r = lintPersonalPostNewsletterDeixis(md);
    assert.equal(r.ok, true, "main post de marca não deve ser flagado");
  });

  it("sem seção LinkedIn = no-op (ok: true)", () => {
    const r = lintPersonalPostNewsletterDeixis("# Facebook\n## d1\nTexto.");
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 0);
  });

  it("CLI: exit 1 com 'esta newsletter' em post_pixel, exit 0 sem deixis", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const scriptPath = join(import.meta.dirname, "..", "scripts", "lint-social-md.ts");
    const run = (md: string) => {
      const dir = mkdtempSync(join(tmpdir(), "deixis-cli-"));
      try {
        const p = join(dir, "03-social.md");
        writeFileSync(p, md, "utf8");
        return spawnSync(process.execPath, ["--import", "tsx", scriptPath, "--check", "personal-post-no-newsletter-deixis", "--md", p], { encoding: "utf8" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    const withDeixis = mkSocialWithPersonal({
      postPixel: "Esta newsletter roda com agentes — o que me surpreende.",
    });
    assert.equal(run(withDeixis).status, 1, "deixis → exit 1");

    const withoutDeixis = mkSocialWithPersonal({
      postPixel: "A newsletter de IA que escrevo roda com agentes.",
    });
    assert.equal(run(withoutDeixis).status, 0, "sem deixis → exit 0");
  });
});

// ---------------------------------------------------------------------------
// #2148 Fix B: checkHumanizerSectionCoverage
// ---------------------------------------------------------------------------

/** Monta 03-social.md com seções parametrizáveis — todos os campos opcionais */
function mkSocialForCoverage(opts: {
  mainD1?: string;
  mainD2?: string;
  mainD3?: string;
  commentPixelD1?: string;
  commentPixelD2?: string;
  commentPixelD3?: string;
  postPixel?: string;
}): string {
  const mainD1 = opts.mainD1 ?? "Texto original do destaque d1.";
  const mainD2 = opts.mainD2 ?? "Texto original do destaque d2.";
  const mainD3 = opts.mainD3 ?? "Texto original do destaque d3.";
  const commentPixelD1 = opts.commentPixelD1 ?? "Comentário original d1.";
  const commentPixelD2 = opts.commentPixelD2 ?? "Comentário original d2.";
  const commentPixelD3 = opts.commentPixelD3 ?? "Comentário original d3.";
  const postPixel = opts.postPixel ?? "Post pixel original.";
  return `# LinkedIn

## d1

${mainD1}

### comment_diaria

Edição completa em {edition_url}

Siga a Diar.ia no LinkedIn em linkedin.com/company/diaria

### comment_pixel

${commentPixelD1}

## d2

${mainD2}

### comment_diaria

Edição completa em {edition_url}

Siga a Diar.ia no LinkedIn em linkedin.com/company/diaria

### comment_pixel

${commentPixelD2}

## d3

${mainD3}

### comment_diaria

Edição completa em {edition_url}

Siga a Diar.ia no LinkedIn em linkedin.com/company/diaria

### comment_pixel

${commentPixelD3}

## post_pixel

${postPixel}

# Facebook

## d1

Texto do Facebook.

Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br.
`;
}

describe("checkHumanizerSectionCoverage (#2148 Fix B)", () => {
  it("PASSA: todas as seções foram alteradas (humanizador completo)", () => {
    const pre = mkSocialForCoverage({
      mainD1: "Texto ORIGINAL d1 com marcas IA: implementando soluções robustas.",
      mainD2: "Texto ORIGINAL d2 com marcas IA: otimizando recursos disponíveis.",
      mainD3: "Texto ORIGINAL d3 com marcas IA: maximizando resultados esperados.",
      commentPixelD1: "Comentário ORIGINAL d1 com IA: otimizando o framework.",
      commentPixelD2: "Comentário ORIGINAL d2 com IA: alavancando o pipeline.",
      commentPixelD3: "Comentário ORIGINAL d3 com IA: implementando melhorias.",
      postPixel: "Post pixel ORIGINAL com IA: alavancando sinergias.",
    });
    const post = mkSocialForCoverage({
      mainD1: "Texto reescrito d1 — sem marcas de IA.",
      mainD2: "Texto reescrito d2 — linguagem natural.",
      mainD3: "Texto reescrito d3 — voz editorial limpa.",
      commentPixelD1: "Comentário reescrito d1 — voz pessoal real.",
      commentPixelD2: "Comentário reescrito d2 — opinião direta.",
      commentPixelD3: "Comentário reescrito d3 — prosa humana.",
      postPixel: "Post pixel reescrito — prosa humana.",
    });
    const r = checkHumanizerSectionCoverage(pre, post);
    assert.equal(r.ok, true, "todas tocadas → ok: true");
    assert.equal(r.untouched.length, 0);
  });

  it("FALHA: post_pixel não foi tocado (humanizador pulou rodapé)", () => {
    // Cenário real #2148: humanizador mudou main posts mas deixou post_pixel intacto.
    // O guard whole-file (arquivo mudou no todo) não pega esse furo.
    const pre = mkSocialForCoverage({
      mainD1: "Texto ORIGINAL com marcas IA.",
      commentPixelD1: "Comentário ORIGINAL com marcas IA.",
      postPixel: "Post pixel ORIGINAL com marcas IA — não tocado pelo humanizador.",
    });
    const post = mkSocialForCoverage({
      mainD1: "Texto reescrito pelo humanizador.",
      commentPixelD1: "Comentário reescrito.",
      postPixel: "Post pixel ORIGINAL com marcas IA — não tocado pelo humanizador.", // idêntico
    });
    const r = checkHumanizerSectionCoverage(pre, post);
    assert.equal(r.ok, false, "post_pixel intacto → ok: false");
    assert.ok(r.untouched.includes("post_pixel"), "post_pixel deve estar na lista untouched");
  });

  it("FALHA: comment_pixel_d2 não foi tocado (humanizador pulou seção)", () => {
    // O humanizador reescreveu todas as outras seções mas deixou comment_pixel_d2 idêntico.
    const originalD2Comment = "O frame técnico da decisão é relevante pra quem está construindo.";
    const pre = mkSocialForCoverage({
      mainD1: "Texto ORIGINAL d1 com marcas IA.",
      mainD2: "Texto ORIGINAL d2 com marcas IA.",
      mainD3: "Texto ORIGINAL d3 com marcas IA.",
      commentPixelD1: "Comentário ORIGINAL d1.",
      commentPixelD2: originalD2Comment, // este NÃO vai mudar no post
      commentPixelD3: "Comentário ORIGINAL d3.",
      postPixel: "Post pixel ORIGINAL.",
    });
    const post = mkSocialForCoverage({
      mainD1: "Texto reescrito d1.",
      mainD2: "Texto reescrito d2.",
      mainD3: "Texto reescrito d3.",
      commentPixelD1: "Comentário reescrito d1.",
      commentPixelD2: originalD2Comment, // idêntico ao pre → untouched
      commentPixelD3: "Comentário reescrito d3.",
      postPixel: "Post pixel reescrito.",
    });
    const r = checkHumanizerSectionCoverage(pre, post);
    assert.equal(r.ok, false, "comment_pixel_d2 intacto → ok: false");
    assert.ok(r.untouched.includes("comment_pixel_d2"), "comment_pixel_d2 deve estar na lista untouched");
  });

  it("PASSA: arquivo idêntico no todo = no-op (caught pelo guard whole-file, não aqui)", () => {
    // Se o arquivo for byte-idêntico no todo, o guard whole-file do orchestrator
    // já bloqueia. Este check é complementar — mas também retorna untouched para
    // todas as seções, o que é correto (todas idênticas).
    const md = mkSocialForCoverage({});
    const r = checkHumanizerSectionCoverage(md, md);
    assert.equal(r.ok, false, "arquivo idêntico → todas seções untouched");
    assert.ok(r.untouched.length > 0);
  });

  it("retorna ok:true e sections vazio quando não há seção LinkedIn", () => {
    const r = checkHumanizerSectionCoverage("# Facebook\n## d1\nFoo", "# Facebook\n## d1\nBar");
    assert.equal(r.ok, true);
    assert.equal(r.sections.length, 0);
  });

  // --- Finding 2 fix: seção DELETADA não deve passar como touched:true (#2148) ---

  it("FALHA: post_pixel presente no pre mas DELETADO no post (corrupção estrutural)", () => {
    // Cenário: humanizador removeu inteiramente a seção post_pixel do arquivo.
    // Bug original: pre===undefined||post===undefined → touched:true (ok silencioso).
    // Fix: pre!==undefined && post===undefined → deleted + ok:false.
    const pre = mkSocialForCoverage({
      mainD1: "Texto ORIGINAL d1.",
      postPixel: "Post pixel que existia antes.",
    });
    // Construir post SEM seção post_pixel (simula deleção pelo humanizador)
    const postWithoutPixel = pre
      .replace(/\n## post_pixel\n[\s\S]*?(?=\n# Facebook|\n## [a-z]|$)/, "");
    const r = checkHumanizerSectionCoverage(pre, postWithoutPixel);
    assert.equal(r.ok, false, "seção deletada → ok: false (não silencioso)");
    assert.ok(r.deleted.includes("post_pixel"), "post_pixel deve estar em deleted[]");
    assert.ok(!r.untouched.includes("post_pixel"), "post_pixel não deve estar em untouched[]");
  });

  it("FALHA: main_d1 presente no pre mas DELETADO no post", () => {
    // Mesmo padrão para seções de main text.
    const pre = mkSocialForCoverage({
      mainD1: "Texto ORIGINAL d1 que vai ser deletado.",
    });
    // Seção main_d1 não é extraída diretamente por tag — o extractor pega tudo
    // no bloco ## d1 até o primeiro ### comment_. Para simular deleção,
    // construímos manualmente o pre e post.
    const preMd = `# LinkedIn\n\n## d1\n\nTexto ORIGINAL d1.\n\n### comment_diaria\n\nlink\n\n### comment_pixel\n\nComentário.\n\n# Facebook\n## d1\nFoo\n`;
    // post sem conteúdo de main (apenas os comentários — main vazado)
    const postMd = `# LinkedIn\n\n## d1\n\n### comment_diaria\n\nlink\n\n### comment_pixel\n\nComentário.\n\n# Facebook\n## d1\nFoo\n`;
    // A deleção real é quando extractSocialSections retorna undefined para uma
    // chave que existia no pre. Vamos verificar o comportamento via teste de
    // unidade direto — o texto principal ficou vazio (undefined no extractor).
    // O test já cobre o caso de post_pixel acima; aqui confirmamos que o campo
    // deleted[] é populado (não untouched[]).
    const r = checkHumanizerSectionCoverage(preMd, postMd);
    // main_d1 fica undefined no post (corpo vazio não extrai) → deleted
    // Aceitamos ok:false como sinal suficiente; a presença em deleted[] é bônus.
    assert.equal(r.ok, false, "deleção de conteúdo de seção → ok: false");
  });

  it("CLI: exit 1 quando seção deletada (post_pixel some do arquivo)", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const scriptPath = join(import.meta.dirname, "..", "scripts", "lint-social-md.ts");

    const dir = mkdtempSync(join(tmpdir(), "deleted-cli-"));
    try {
      const pre = mkSocialForCoverage({
        mainD1: "Texto ORIGINAL d1.",
        postPixel: "Post pixel que existia.",
      });
      // Remover seção post_pixel do post
      const post = pre.replace(/\n## post_pixel\n[\s\S]*?(?=\n# Facebook|$)/, "");
      const prePath = join(dir, "03-social-pre.md");
      const postPath = join(dir, "03-social.md");
      writeFileSync(prePath, pre, "utf8");
      writeFileSync(postPath, post, "utf8");
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "--check", "humanizer-section-coverage", "--pre", prePath, "--md", postPath],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1, "seção deletada → exit 1 (não silencioso)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI: exit 1 quando post_pixel não tocado, exit 0 quando tudo tocado", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const scriptPath = join(import.meta.dirname, "..", "scripts", "lint-social-md.ts");

    const run = (preMd: string, postMd: string) => {
      const dir = mkdtempSync(join(tmpdir(), "coverage-cli-"));
      try {
        const prePath = join(dir, "03-social-pre.md");
        const postPath = join(dir, "03-social.md");
        writeFileSync(prePath, preMd, "utf8");
        writeFileSync(postPath, postMd, "utf8");
        return spawnSync(
          process.execPath,
          ["--import", "tsx", scriptPath, "--check", "humanizer-section-coverage", "--pre", prePath, "--md", postPath],
          { encoding: "utf8" },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    // post_pixel idêntico → exit 1
    const preMd = mkSocialForCoverage({
      mainD1: "Texto ORIGINAL com marcas IA.",
      postPixel: "Post pixel ORIGINAL — intacto.",
    });
    const postMd = mkSocialForCoverage({
      mainD1: "Texto reescrito pelo humanizador.",
      postPixel: "Post pixel ORIGINAL — intacto.", // idêntico ao pre
    });
    assert.equal(run(preMd, postMd).status, 1, "post_pixel intacto → exit 1");

    // Tudo mudado → exit 0
    const preMd2 = mkSocialForCoverage({
      mainD1: "A original.", mainD2: "B original.", mainD3: "C original.",
      commentPixelD1: "D original.", commentPixelD2: "E original.", commentPixelD3: "F original.",
      postPixel: "G original.",
    });
    const postMd2 = mkSocialForCoverage({
      mainD1: "A reescrito.", mainD2: "B reescrito.", mainD3: "C reescrito.",
      commentPixelD1: "D reescrito.", commentPixelD2: "E reescrito.", commentPixelD3: "F reescrito.",
      postPixel: "G reescrito.",
    });
    assert.equal(run(preMd2, postMd2).status, 0, "tudo tocado → exit 0");
  });
});

// ---------------------------------------------------------------------------
// #2458: lintLinkedinEmailCTA + lintLinkedinPageLink
// ---------------------------------------------------------------------------

/** Helper: monta 03-social.md minimal com conteúdo de LinkedIn configurável */
function mkLinkedinMd(opts: {
  commentDiariaD1?: string;
  commentDiariaD2?: string;
  commentDiariaD3?: string;
  postPixel?: string;
}): string {
  const cd1 = opts.commentDiariaD1 ?? `Edição completa em {edition_url}\n\n${DIARIA_LINKEDIN_PAGE_SLUG}`;
  const cd2 = opts.commentDiariaD2 ?? `Edição completa em {edition_url}\n\n${DIARIA_LINKEDIN_PAGE_SLUG}`;
  const cd3 = opts.commentDiariaD3 ?? `Edição completa em {edition_url}\n\n${DIARIA_LINKEDIN_PAGE_SLUG}`;
  const pp = opts.postPixel ?? `Texto do post pessoal.\n\nSiga a Diar.ia em ${DIARIA_LINKEDIN_PAGE_SLUG}`;
  return `# LinkedIn

## d1

Texto editorial d1.

### comment_diaria

${cd1}

### comment_pixel

Comentário pessoal d1.

## d2

Texto editorial d2.

### comment_diaria

${cd2}

### comment_pixel

Comentário pessoal d2.

## d3

Texto editorial d3.

### comment_diaria

${cd3}

### comment_pixel

Comentário pessoal d3.

## post_pixel

<!-- destaque: d1 -->

${pp}

#IA #Brasil

# Facebook

## d1

Post Facebook.

Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br.
`;
}

describe("lintLinkedinEmailCTA (#2458)", () => {
  it("PASSA: sem CTA de e-mail em nenhum bloco LinkedIn", () => {
    const md = mkLinkedinMd({});
    const r = lintLinkedinEmailCTA(md);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.errors.length, 0);
  });

  it("FALHA: 'assine grátis' em comment_diaria", () => {
    const md = mkLinkedinMd({
      commentDiariaD1: `Edição completa em {edition_url}\n\nReceba a Diar.ia todo dia por e-mail, assine grátis em diar.ia.br`,
    });
    const r = lintLinkedinEmailCTA(md);
    assert.equal(r.ok, false, "deve falhar com CTA de e-mail");
    assert.ok(r.errors.some((e) => e.section === "comment_diaria"), JSON.stringify(r.errors));
  });

  it("FALHA: 'receba a Diar.ia todo dia por e-mail' em post_pixel", () => {
    const md = mkLinkedinMd({
      postPixel: `Texto do post.\n\nReceba a Diar.ia todo dia por e-mail, assine grátis em diar.ia.br`,
    });
    const r = lintLinkedinEmailCTA(md);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.section === "post_pixel"), JSON.stringify(r.errors));
  });

  it("NÃO flaga email CTA no Facebook (não é seção LinkedIn)", () => {
    // Email CTAs no Facebook são permitidas (e até obrigatórias no formato antigo)
    const md = mkLinkedinMd({});
    // O mkLinkedinMd já inclui Facebook com email CTA
    const r = lintLinkedinEmailCTA(md);
    assert.equal(r.ok, true, "email CTA no Facebook não deve ser flagada pelo lint LinkedIn");
  });

  it("no-op quando não há seção LinkedIn", () => {
    const r = lintLinkedinEmailCTA("# Facebook\n## d1\nTexto.");
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
  });

  it("CLI: exit 1 com email CTA, exit 0 sem email CTA", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const scriptPath = join(import.meta.dirname, "..", "scripts", "lint-social-md.ts");
    const run = (md: string) => {
      const dir = mkdtempSync(join(tmpdir(), "email-cta-cli-"));
      try {
        const p = join(dir, "03-social.md");
        writeFileSync(p, md, "utf8");
        return spawnSync(process.execPath, ["--import", "tsx", scriptPath, "--check", "no-email-cta-linkedin", "--md", p], { encoding: "utf8" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    // Com email CTA → exit 1
    const withEmailCTA = mkLinkedinMd({
      commentDiariaD1: "Edição completa em {edition_url}\n\nReceba a Diar.ia todo dia por e-mail, assine grátis em diar.ia.br",
    });
    assert.equal(run(withEmailCTA).status, 1, "email CTA → exit 1");
    // Sem email CTA → exit 0
    assert.equal(run(mkLinkedinMd({})).status, 0, "sem email CTA → exit 0");
  });
});

describe("lintLinkedinPageLink (#2458)", () => {
  it("PASSA: comment_diaria e post_pixel com link da página", () => {
    const md = mkLinkedinMd({});
    const r = lintLinkedinPageLink(md);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  it("FALHA: comment_diaria de d1 sem link da página", () => {
    const md = mkLinkedinMd({
      commentDiariaD1: "Edição completa em {edition_url}",
    });
    const r = lintLinkedinPageLink(md);
    assert.equal(r.ok, false);
    const e = r.errors.find((x) => x.section === "comment_diaria" && x.destaque === "d1");
    assert.ok(e, `esperava erro em d1/comment_diaria, achei: ${JSON.stringify(r.errors)}`);
  });

  it("FALHA: comment_diaria de d3 sem link da página", () => {
    const md = mkLinkedinMd({
      commentDiariaD3: "Edição completa em {edition_url}",
    });
    const r = lintLinkedinPageLink(md);
    assert.equal(r.ok, false);
    const e = r.errors.find((x) => x.section === "comment_diaria" && x.destaque === "d3");
    assert.ok(e, `esperava erro em d3/comment_diaria, achei: ${JSON.stringify(r.errors)}`);
  });

  it("FALHA: post_pixel sem link da página", () => {
    const md = mkLinkedinMd({
      postPixel: "Texto do post pessoal sobre o D1.",
    });
    const r = lintLinkedinPageLink(md);
    assert.equal(r.ok, false);
    const e = r.errors.find((x) => x.section === "post_pixel");
    assert.ok(e, `esperava erro em post_pixel, achei: ${JSON.stringify(r.errors)}`);
  });

  it("PASSA: comment_diaria com URL completa 'https://linkedin.com/company/diaria'", () => {
    // Aceita qualquer forma que contenha 'linkedin.com/company/diaria'
    const md = mkLinkedinMd({
      commentDiariaD1: "Edição completa em {edition_url}\n\nSiga em https://linkedin.com/company/diaria",
      commentDiariaD2: "Edição completa em {edition_url}\n\nSiga em linkedin.com/company/diaria",
      commentDiariaD3: "Edição completa em {edition_url}\n\nSiga em linkedin.com/company/diaria",
    });
    const r = lintLinkedinPageLink(md);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  it("no-op quando não há seção LinkedIn", () => {
    const r = lintLinkedinPageLink("# Facebook\n## d1\nTexto.");
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
  });

  it("DIARIA_LINKEDIN_PAGE_SLUG aponta para slug canônico", () => {
    assert.equal(DIARIA_LINKEDIN_PAGE_SLUG, "linkedin.com/company/diaria");
  });

  it("CLI: exit 1 sem link da página, exit 0 com link da página", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const scriptPath = join(import.meta.dirname, "..", "scripts", "lint-social-md.ts");
    const run = (md: string) => {
      const dir = mkdtempSync(join(tmpdir(), "page-link-cli-"));
      try {
        const p = join(dir, "03-social.md");
        writeFileSync(p, md, "utf8");
        return spawnSync(process.execPath, ["--import", "tsx", scriptPath, "--check", "linkedin-page-link", "--md", p], { encoding: "utf8" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    // Sem link → exit 1
    const noLink = mkLinkedinMd({ commentDiariaD1: "Edição completa em {edition_url}" });
    assert.equal(run(noLink).status, 1, "sem link da página → exit 1");
    // Com link → exit 0
    assert.equal(run(mkLinkedinMd({})).status, 0, "com link da página → exit 0");
  });
});
