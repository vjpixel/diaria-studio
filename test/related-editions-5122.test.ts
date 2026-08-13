/**
 * test/related-editions-5122.test.ts (#5122 item 3, redesenhado #5181)
 *
 * Regressão pro bloco "Mais sobre {tema}" — a aresta edição->edição que
 * substitui, na prática, o mecanismo do #4907 (que exige match único
 * edição-wide e por isso quase nunca dispara, ver comentário registrado no
 * próprio #4907 a partir desta issue).
 *
 * Cobre: `selectRelatedEditions`/`renderRelatedEditionsMarkdown` (puros,
 * `scripts/lib/related-editions.ts`), a integração em `buildParaEncerrar`/
 * `stitchNewsletter` (`scripts/stitch-newsletter.ts`), a janela de dedup
 * entre edições (#5181 item 4), a exclusão mútua com o "Saiba mais:" do
 * #4907 (#5181 item 3), e — critério de pronto explícito da issue — que o
 * bloco sobrevive ao render HTML como `<a href>` de verdade (`renderEncerrar`,
 * `scripts/lib/newsletter-render-html.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectRelatedEditions,
  renderRelatedEditionsMarkdown,
  loadRecentRelatedEditionUrls,
  inferEditionsRoot,
  extractRelatedEditionsUrlsFromMarkdown,
  type RelatedEditionsGroup,
} from "../scripts/lib/related-editions.ts";
import { stitchNewsletter, buildParaEncerrar } from "../scripts/stitch-newsletter.ts";
import { renderEncerrar } from "../scripts/lib/newsletter-render-html.ts";
import { extractTemplateBlock } from "../scripts/lib/newsletter-parse.ts";

describe("selectRelatedEditions (#5122/#5181) — pura", () => {
  it("nenhuma manchete casa nenhum hub -> null", () => {
    const out = selectRelatedEditions([
      ["Notícia qualquer sem tema de hub"],
      ["Outra notícia genérica"],
    ]);
    assert.equal(out, null);
  });

  it("manchete claramente de um hub (OpenAI) -> grupo com hub + edições reais desse hub, urls de edição diar.ia.br", () => {
    const out = selectRelatedEditions([
      ["OpenAI lança GPT-Live para voz natural"],
      ["Notícia qualquer sem tema de hub"],
    ]);
    assert.ok(out, "deveria achar o hub openai-chatgpt");
    assert.equal(out!.hubSlug, "openai-chatgpt");
    assert.equal(out!.hubLabel, "OpenAI e ChatGPT");
    assert.match(out!.hubUrl, /^https:\/\/arquivo\.diar\.ia\.br\/temas\/openai-chatgpt/);
    assert.ok(out!.editions.length > 0, "deveria achar pelo menos 1 edição do hub");
    for (const r of out!.editions) {
      assert.equal(r.hubSlug, "openai-chatgpt");
      assert.match(r.url, /^https:\/\/diar\.ia\.br\/p\//);
      assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(r.title.length > 0);
    }
  });

  it("respeita maxEditions (default 2)", () => {
    const out = selectRelatedEditions([["OpenAI lança GPT-Live para voz natural"]]);
    assert.ok(out);
    assert.ok(out!.editions.length <= 2, "default maxEditions é 2");

    const out1 = selectRelatedEditions([["OpenAI lança GPT-Live para voz natural"]], { maxEditions: 1 });
    assert.ok(out1);
    assert.equal(out1!.editions.length, 1);
  });

  it("excludeUrls remove candidatos específicos (não repete a mesma URL 2x mesmo pedindo maxEditions alto)", () => {
    const first = selectRelatedEditions([["OpenAI lança GPT-Live para voz natural"]], { maxEditions: 1 });
    assert.ok(first && first.editions.length === 1, "sanity: precisa achar 1 candidato pro teste fazer sentido");
    const excluded = selectRelatedEditions(
      [["OpenAI lança GPT-Live para voz natural"]],
      { maxEditions: 1, excludeUrls: [first!.editions[0].url] },
    );
    assert.ok(excluded);
    assert.ok(excluded!.editions.length <= 1);
    if (excluded!.editions.length === 1) {
      assert.notEqual(
        excluded!.editions[0].url,
        first!.editions[0].url,
        "excludeUrls deveria pular o candidato já visto",
      );
    }
  });

  it("nunca retorna edições duplicadas dentro do mesmo grupo", () => {
    const out = selectRelatedEditions([["OpenAI lança GPT-Live para voz natural"]], { maxEditions: 10 });
    assert.ok(out);
    const urls = out!.editions.map((r) => r.url);
    assert.equal(new Set(urls).size, urls.length, "sem URL duplicada entre edições do grupo");
  });

  describe("#5181 item 1 — 1 hub por edição, desempate por especificidade (não ordem do Record)", () => {
    it("2 destaques casando hubs DIFERENTES (Anthropic + Google) -> escolhe 1 SÓ, todas as edições do MESMO hub", () => {
      const out = selectRelatedEditions([
        ["Anthropic lança novo modelo Claude"],
        ["Google atualiza o Gemini com nova versão"],
      ]);
      assert.ok(out, "ao contrário de matchEditionHub (#4907), ambiguidade NÃO suprime o resultado aqui");
      assert.ok(
        out!.hubSlug === "anthropic-claude" || out!.hubSlug === "google-gemini",
        "deveria escolher 1 dos 2 hubs casados",
      );
      for (const ed of out!.editions) {
        assert.equal(ed.hubSlug, out!.hubSlug, "todas as edições do grupo pertencem ao MESMO hub escolhido");
      }
    });

    it("manchete que casa meta-ai E mercado-trabalho -> escolhe meta-ai (mais específico), não o vocabulário genérico de mercado-trabalho", () => {
      // "demite" casa \bdemit\b de mercado-trabalho; "Meta" casa \bmeta\b de
      // meta-ai. Antes do #5181 a ordem de iteração do Record decidia (ou,
      // no bug original #5122, cada hub contribuía candidatos igualmente,
      // deixando mercado-trabalho dominar 14/28 edições medidas). Com o
      // desempate por especificidade (Nº de alternativas do regex — meta-ai
      // tem 3, mercado-trabalho tem dezenas), meta-ai deveria vencer sempre,
      // independente de qualquer reordenação futura do Record.
      const out = selectRelatedEditions([
        ["Meta demite 8 mil funcionários para dobrar aposta em IA"],
      ]);
      assert.ok(out);
      assert.equal(out!.hubSlug, "meta-ai", "meta-ai (3 alternativas) deveria vencer mercado-trabalho (vocabulário genérico)");
    });
  });
});

describe("renderRelatedEditionsMarkdown (#5122/#5181) — pura", () => {
  it("grupo null -> null (bloco inteiro omitido)", () => {
    assert.equal(renderRelatedEditionsMarkdown(null), null);
  });

  it("#5181 item 2/5 — formata como 'Mais sobre {tema}:' + 1 bullet de hub + edições com data (DD/MM/AAAA)", () => {
    const group: RelatedEditionsGroup = {
      hubSlug: "openai-chatgpt",
      hubLabel: "OpenAI e ChatGPT",
      hubUrl: "https://arquivo.diar.ia.br/temas/openai-chatgpt?utm_source=x",
      editions: [
        { title: "Título A", url: "https://diar.ia.br/p/a", date: "2026-08-01", hubSlug: "openai-chatgpt" },
        { title: "Título B", url: "https://diar.ia.br/p/b", date: "2026-07-01", hubSlug: "openai-chatgpt" },
      ],
    };
    const out = renderRelatedEditionsMarkdown(group);
    assert.equal(
      out,
      "Mais sobre OpenAI e ChatGPT:\n" +
        "- [Tudo sobre OpenAI e ChatGPT](https://arquivo.diar.ia.br/temas/openai-chatgpt?utm_source=x)\n" +
        "- [Título A (01/08/2026)](https://diar.ia.br/p/a)\n" +
        "- [Título B (01/07/2026)](https://diar.ia.br/p/b)",
    );
  });

  describe("#5181 item 3 — omitHubLink (exclusão mútua com 'Saiba mais:')", () => {
    const group: RelatedEditionsGroup = {
      hubSlug: "openai-chatgpt",
      hubLabel: "OpenAI e ChatGPT",
      hubUrl: "https://arquivo.diar.ia.br/temas/openai-chatgpt?utm_source=x",
      editions: [
        { title: "Título A", url: "https://diar.ia.br/p/a", date: "2026-08-01", hubSlug: "openai-chatgpt" },
      ],
    };

    it("omitHubLink:true -> omite só a linha do hub, preserva rótulo + edições", () => {
      const out = renderRelatedEditionsMarkdown(group, { omitHubLink: true });
      assert.equal(out, "Mais sobre OpenAI e ChatGPT:\n- [Título A (01/08/2026)](https://diar.ia.br/p/a)");
      assert.doesNotMatch(out!, /Tudo sobre/, "a linha do hub não deveria aparecer");
    });

    it("omitHubLink:true + zero edições -> null (nada sobra pra renderizar)", () => {
      const empty: RelatedEditionsGroup = { ...group, editions: [] };
      assert.equal(renderRelatedEditionsMarkdown(empty, { omitHubLink: true }), null);
    });
  });
});

describe("renderRelatedEditionsMarkdown -> renderEncerrar (hotfix: regex gulosa de newsletter-render-html.ts)", () => {
  // Regressão: `renderRelatedEditionsMarkdown` colocava a data DEPOIS do `)`
  // de fechamento do link (`[Título](url) (DD/MM/AAAA)`). A regex de parse de
  // pill em `newsletter-render-html.ts` (`/^\[([^\]]+)\]\((.+)\)$/`) é gulosa
  // e ancorada no FIM da string — capturava tudo até o ÚLTIMO `)`, incluindo
  // a data, dentro do próprio `href`. Este teste exercita o parser REAL (não
  // só `related-editions.ts` isolado) e afirma que o `href` final é
  // EXATAMENTE a URL da edição, sem sufixo vazado.
  it("href do <a> final é EXATAMENTE a URL da edição, sem ') (DD/MM/AAAA)' vazado no atributo", () => {
    const group: RelatedEditionsGroup = {
      hubSlug: "openai-chatgpt",
      hubLabel: "OpenAI e ChatGPT",
      hubUrl: "https://arquivo.diar.ia.br/temas/openai-chatgpt?utm_source=x",
      editions: [
        { title: "Título Exemplo", url: "https://diar.ia.br/p/exemplo", date: "2026-08-12", hubSlug: "openai-chatgpt" },
      ],
    };
    const related = renderRelatedEditionsMarkdown(group);
    assert.ok(related);

    const body = buildParaEncerrar({ slotA: "Texto A." }, related);
    const encerrarBody = extractTemplateBlock(body, "🙋🏼‍♀️ PARA ENCERRAR");
    assert.ok(encerrarBody, "PARA ENCERRAR deveria estar presente no bloco montado");
    const html = renderEncerrar(encerrarBody!);

    // A data agora mora DENTRO do label visível (fix: movida pra dentro dos
    // colchetes) — o texto do <a> é "Título Exemplo (12/08/2026)" inteiro.
    const anchorMatch = /<a href="([^"]*)"[^>]*>Título Exemplo \(12\/08\/2026\)<\/a>/.exec(html);
    assert.ok(anchorMatch, `esperava um <a> com o texto "Título Exemplo (12/08/2026)" — html: ${html}`);
    assert.equal(
      anchorMatch![1],
      "https://diar.ia.br/p/exemplo",
      "o href não deveria carregar sufixo ') (DD/MM/AAAA)' vazado do parêntese da data",
    );
    assert.doesNotMatch(anchorMatch![1], /[()]/, "href não deveria conter parênteses");
  });
});

describe("buildParaEncerrar — grupo 'Mais sobre {tema}' (#5122/#5181)", () => {
  it("relatedEditionsMarkdown ausente/null -> comportamento idêntico a antes do #5122 (sem grupo novo)", () => {
    const out = buildParaEncerrar({ slotA: "Texto A." }, null);
    assert.doesNotMatch(out, /Mais sobre /);
  });

  it("relatedEditionsMarkdown presente -> injetado ENTRE as pills de curadoria e o convite social", () => {
    const related = "Mais sobre OpenAI e ChatGPT:\n- [Outra edição](https://diar.ia.br/p/outra)";
    const out = buildParaEncerrar({ slotA: "Texto A." }, related);
    assert.match(out, /Mais sobre OpenAI e ChatGPT:\n- \[Outra edição\]\(https:\/\/diar\.ia\.br\/p\/outra\)/);
    const curadoriasPos = out.indexOf("Curadorias:");
    const relatedPos = out.indexOf("Mais sobre OpenAI e ChatGPT:");
    const socialInvitePos = out.indexOf("Para acompanhar as 3 principais notícias");
    assert.ok(curadoriasPos !== -1 && relatedPos !== -1 && socialInvitePos !== -1);
    assert.ok(curadoriasPos < relatedPos && relatedPos < socialInvitePos);
  });
});

describe("stitchNewsletter — 'Mais sobre {tema}' end-to-end (#5122/#5181)", () => {
  function setupEdition() {
    const dir = mkdtempSync(join(tmpdir(), "stitch-related-"));
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    return { dir, internalDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  function writeDestaqueFixtures(
    internalDir: string,
    d1Headline: string,
    d2Headline: string,
  ) {
    writeFileSync(
      join(internalDir, "02-d1-draft.md"),
      `**DESTAQUE 1 | 🚀 LANÇAMENTO**\n\n**[${d1Headline}](https://example.com/d1)**\n\nbody1`,
    );
    writeFileSync(
      join(internalDir, "02-d2-draft.md"),
      `**DESTAQUE 2 | 🔬 PESQUISA**\n\n**[${d2Headline}](https://example.com/d2)**\n\nbody2`,
    );
    writeFileSync(
      join(internalDir, "01-approved-capped.json"),
      JSON.stringify({ coverage: { line: "Coverage." } }),
    );
  }

  it("D1 casa um hub -> PARA ENCERRAR ganha o grupo 'Mais sobre {tema}' com hub + pelo menos 1 link real de edição", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      // D2 também casa um hub (Google/Gemini) de propósito: torna
      // `matchEditionHub` (#4907) AMBÍGUO (2 hubs casados -> null, sem
      // "Saiba mais:"), o que evita disparar o guard de exclusão mútua do
      // #5181 item 3 (testado à parte, abaixo) e isola o comportamento
      // "normal" — hub renderizado por inteiro no grupo.
      writeDestaqueFixtures(internalDir, "OpenAI lança GPT-Live para voz natural", "Google atualiza o Gemini com nova versão");
      const out = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
        sponsor: false,
      });

      assert.match(out, /Mais sobre OpenAI e ChatGPT:/);
      assert.match(out, /- \[Tudo sobre OpenAI e ChatGPT\]\(https:\/\/arquivo\.diar\.ia\.br\/temas\/openai-chatgpt/);
      assert.match(out, /- \[[^\]]+ \(\d{2}\/\d{2}\/\d{4}\)\]\(https:\/\/diar\.ia\.br\/p\/[^)]+\)/);

      // #5122 critério de pronto: o bloco emite <a href> pra outra edição no
      // HTML final — não só no markdown intermediário. Extrai o corpo de
      // PARA ENCERRAR (mesmo helper que a Etapa 4 usa) e roda pelo MESMO
      // renderer.
      const body = extractTemplateBlock(out, "🙋🏼‍♀️ PARA ENCERRAR");
      assert.ok(body, "PARA ENCERRAR deveria estar presente no output stitchado");
      const html = renderEncerrar(body!);
      // Regex apertada de propósito (hotfix, achado no review consolidado):
      // `[^"]+` sozinho mascarava o bug de #5122 (aceitava `)`/`(` dentro do
      // valor do href, exatamente o sufixo vazado que a regex gulosa de
      // `newsletter-render-html.ts` produzia). `[^")\s]+` rejeita qualquer
      // `)` ou espaço dentro do atributo — só passa se o href for a URL pura.
      assert.match(html, /<a href="https:\/\/diar\.ia\.br\/p\/[^")\s]+"[^>]*>[^<]+<\/a>/);
    } finally {
      cleanup();
    }
  });

  it("2 destaques casando hubs DIFERENTES (Anthropic + Google) -> ainda ganha o grupo, mas com 1 hub só (#5181 item 1)", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeDestaqueFixtures(internalDir, "Anthropic lança novo modelo Claude", "Google atualiza o Gemini com nova versão");
      const out = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
        sponsor: false,
      });

      assert.doesNotMatch(out, /Saiba mais:/, "sanity: #4907 continua ambíguo aqui, sem link contextual no destaque");
      assert.match(out, /Mais sobre (Anthropic e Claude|Google e Gemini):/, "mas o grupo (#5122/#5181) não herda essa restrição");
      // Só 1 "Mais sobre" — não 2 (não deveria haver um grupo por hub casado).
      const matches = out.match(/Mais sobre [^:]+:/g) ?? [];
      assert.equal(matches.length, 1, "exatamente 1 grupo, não 1 por hub casado");
    } finally {
      cleanup();
    }
  });

  it("nenhum destaque casa hub nenhum -> sem grupo 'Mais sobre' (comportamento preservado)", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeDestaqueFixtures(internalDir, "Notícia qualquer sem tema de hub", "Outra notícia genérica sem tema");
      const out = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
        sponsor: false,
      });

      assert.doesNotMatch(out, /Mais sobre /);
    } finally {
      cleanup();
    }
  });

  it("#5181 item 3 — hub do 'Mais sobre' é o MESMO do 'Saiba mais:' -> não duplica o mesmo <a href>", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      // Só 1 headline casando só 1 hub em TODA a edição -> matchEditionHub
      // (#4907) não fica ambíguo e injeta "Saiba mais:" no D1; o MESMO hub
      // é o único candidato de selectRelatedEditions -> teria que sair
      // duplicado no "Mais sobre" sem o guard do #5181 item 3.
      writeDestaqueFixtures(internalDir, "OpenAI lança GPT-Live para voz natural", "Notícia qualquer sem tema de hub");
      const out = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
        sponsor: false,
      });

      assert.match(out, /Saiba mais:\n\n\[OpenAI e ChatGPT\]\(https:\/\/arquivo\.diar\.ia\.br\/temas\/openai-chatgpt[^)]*\)/);
      assert.match(out, /Mais sobre OpenAI e ChatGPT:/, "o grupo continua existindo — só a linha do hub some");
      assert.doesNotMatch(
        out,
        /- \[Tudo sobre OpenAI e ChatGPT\]/,
        "a linha do hub NÃO deveria se repetir dentro de 'Mais sobre' quando já saiu em 'Saiba mais:'",
      );
      // O href do hub aparece EXATAMENTE 1x na edição inteira (no "Saiba mais:"),
      // não 2x (que seria o bug que este guard existe pra prevenir).
      const hubUrlMatch = /https:\/\/arquivo\.diar\.ia\.br\/temas\/openai-chatgpt[^)\s]*/.exec(out);
      assert.ok(hubUrlMatch);
      const hubHrefOccurrences = out.split(hubUrlMatch![0]).length - 1;
      assert.equal(hubHrefOccurrences, 1, "o link do hub deveria aparecer 1x só na edição inteira");

      // Ainda tem pelo menos 1 edição-filha no "Mais sobre" (não suprimiu o grupo inteiro).
      assert.match(out, /Mais sobre OpenAI e ChatGPT:\n- \[[^\]]+ \(\d{2}\/\d{2}\/\d{4}\)\]\(https:\/\/diar\.ia\.br\/p\/[^)]+\)/);
    } finally {
      cleanup();
    }
  });

  describe("#5181 item 4 — janela de dedup entre edições", () => {
    it("URLs já linkadas nas últimas ~10 edições (mesmo layout data/editions/{AAMMDD}/) são excluídas do candidato de hoje", () => {
      const root = mkdtempSync(join(tmpdir(), "editions-root-"));
      try {
        // 1º: descobre dinamicamente (sem hardcoded regeneration-sensitive
        // title) qual seria o candidato NATURAL de openai-chatgpt hoje.
        const natural = selectRelatedEditions([["OpenAI lança GPT-Live para voz natural"]], { maxEditions: 1 });
        assert.ok(natural && natural.editions.length === 1, "sanity: precisa de pelo menos 1 candidato real");
        const alreadyUsedEdition = natural!.editions[0];

        // 2º: monta uma edição PASSADA (dentro da janela de 10) cujo
        // 02-reviewed.md já cita esse candidato no grupo "Mais sobre".
        const pastAammdd = "260101";
        const pastDir = join(root, pastAammdd);
        mkdirSync(pastDir, { recursive: true });
        const pastMarkdown = renderRelatedEditionsMarkdown({
          hubSlug: natural!.hubSlug,
          hubLabel: natural!.hubLabel,
          hubUrl: natural!.hubUrl,
          editions: [alreadyUsedEdition],
        });
        writeFileSync(join(pastDir, "02-reviewed.md"), `Corpo qualquer.\n\n${pastMarkdown}\n\nResto do corpo.`);

        // 3º: a edição de HOJE mora na MESMA raiz (layout flat real).
        const todayAammdd = "260813";
        const todayDir = join(root, todayAammdd);
        const internalDir = join(todayDir, "_internal");
        mkdirSync(internalDir, { recursive: true });
        writeDestaqueFixtures(internalDir, "OpenAI lança GPT-Live para voz natural", "Notícia qualquer sem tema de hub");

        const excludeUrls = loadRecentRelatedEditionUrls(todayDir);
        assert.ok(
          excludeUrls.includes(alreadyUsedEdition.url),
          "loadRecentRelatedEditionUrls deveria ter capturado a URL já usada na edição passada",
        );

        const out = stitchNewsletter({
          d1Path: join(internalDir, "02-d1-draft.md"),
          d2Path: join(internalDir, "02-d2-draft.md"),
          approvedCappedPath: join(internalDir, "01-approved-capped.json"),
          editionDir: todayDir,
          sponsor: false,
        });

        assert.doesNotMatch(
          out,
          new RegExp(alreadyUsedEdition.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          "a edição já citada na janela recente não deveria ser recomendada de novo hoje",
        );
        assert.match(out, /Mais sobre OpenAI e ChatGPT:/, "o grupo ainda deveria existir, com OUTRO candidato");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("respeita a janela (edições mais antigas que `window` não entram no excludeUrls)", () => {
      const root = mkdtempSync(join(tmpdir(), "editions-root-window-"));
      try {
        // 12 edições fixture, "260101".."260112" — mais antigas que a
        // janela default de 10 quando a "de hoje" é a 13ª (260113).
        for (let i = 1; i <= 12; i++) {
          const aammdd = `2601${String(i).padStart(2, "0")}`;
          const pastDir = join(root, aammdd);
          mkdirSync(pastDir, { recursive: true });
          writeFileSync(
            join(pastDir, "02-reviewed.md"),
            `Corpo.\n\nMais sobre Tema Fixture:\n- [Tudo sobre Tema Fixture](https://arquivo.diar.ia.br/temas/fixture)\n- [Edição ${aammdd}](https://diar.ia.br/p/edicao-${aammdd}) (01/01/2026)\n\nResto.`,
          );
        }
        const todayDir = join(root, "260113");
        mkdirSync(todayDir, { recursive: true });

        const excludeUrls = loadRecentRelatedEditionUrls(todayDir, 10);
        // As 10 mais recentes das 12 (260103..260112) devem entrar; as 2
        // mais antigas (260101, 260102) devem ficar de fora da janela.
        assert.ok(excludeUrls.includes("https://diar.ia.br/p/edicao-260112"));
        assert.ok(excludeUrls.includes("https://diar.ia.br/p/edicao-260103"));
        assert.ok(!excludeUrls.includes("https://diar.ia.br/p/edicao-260102"), "260102 está fora da janela de 10");
        assert.ok(!excludeUrls.includes("https://diar.ia.br/p/edicao-260101"), "260101 está fora da janela de 10");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("edição no formato ANTIGO ('Edições relacionadas:', pré-#5181) contribui 0 URLs — sem quebrar", () => {
      const root = mkdtempSync(join(tmpdir(), "editions-root-legacy-"));
      try {
        const pastDir = join(root, "260101");
        mkdirSync(pastDir, { recursive: true });
        writeFileSync(
          join(pastDir, "02-reviewed.md"),
          "Corpo.\n\nEdições relacionadas:\n- [Título antigo](https://diar.ia.br/p/formato-antigo)\n\nResto.",
        );
        const todayDir = join(root, "260102");
        mkdirSync(todayDir, { recursive: true });
        const excludeUrls = loadRecentRelatedEditionUrls(todayDir);
        assert.deepEqual(excludeUrls, [], "formato antigo não casa o header novo — degrada pra sem histórico, sem lançar");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("editionDir de teste (nome arbitrário, não-AAMMDD) -> [] sem tocar o disco", () => {
      const dir = mkdtempSync(join(tmpdir(), "not-an-edition-dir-"));
      try {
        assert.deepEqual(loadRecentRelatedEditionUrls(dir), []);
        assert.equal(inferEditionsRoot(dir), null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("inferEditionsRoot (#5181 item 4) — pura", () => {
    it("layout flat: data/editions/{AAMMDD}/ -> root é o pai", () => {
      const out = inferEditionsRoot("/x/data/editions/260813");
      assert.deepEqual(out, { root: "/x/data/editions", aammdd: "260813" });
    });

    it("layout nested: data/editions/{AAMM}/{AAMMDD}/ -> root é o avô", () => {
      const out = inferEditionsRoot("/x/data/editions/2608/260813");
      assert.deepEqual(out, { root: "/x/data/editions", aammdd: "260813" });
    });

    it("nome que não é AAMMDD -> null", () => {
      assert.equal(inferEditionsRoot("/x/data/editions/replay-scorer-a"), null);
    });
  });

  describe("extractRelatedEditionsUrlsFromMarkdown (#5181 item 4) — pura", () => {
    it("extrai URLs do grupo até a 1ª linha em branco", () => {
      const text = "Prosa antes.\n\nMais sobre X:\n- [A](https://diar.ia.br/p/a)\n- [B](https://diar.ia.br/p/b)\n\nProsa depois.";
      assert.deepEqual(extractRelatedEditionsUrlsFromMarkdown(text), [
        "https://diar.ia.br/p/a",
        "https://diar.ia.br/p/b",
      ]);
    });

    it("sem grupo -> []", () => {
      assert.deepEqual(extractRelatedEditionsUrlsFromMarkdown("Corpo qualquer sem o grupo."), []);
    });
  });
});
