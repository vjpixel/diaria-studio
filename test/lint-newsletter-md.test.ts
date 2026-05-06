import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  extractUrlsBySection,
  buildUrlBucketMap,
  lintNewsletter,
  countTitlesPerHighlight,
  checkEaiSection,
  checkTitleLengths,
  checkWhyMattersFormat,
  checkEiaAnswer,
  lintIntroCount,
  lintRelativeTime,
} from "../scripts/lint-newsletter-md.ts";

describe("extractUrlsBySection", () => {
  it("extrai URLs por seção LANÇAMENTOS / PESQUISAS / OUTRAS NOTÍCIAS", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "https://destaque-fora.com",
      "",
      "---",
      "",
      "LANÇAMENTOS",
      "Item",
      "https://openai.com/x",
      "",
      "---",
      "",
      "PESQUISAS",
      "Paper",
      "https://arxiv.org/y",
      "",
      "---",
      "",
      "OUTRAS NOTÍCIAS",
      "Notícia",
      "https://techcrunch.com/z",
    ].join("\n");

    const r = extractUrlsBySection(md);
    assert.equal(r["LANÇAMENTOS"]?.length, 1);
    assert.equal(r["LANÇAMENTOS"][0].url, "https://openai.com/x");
    assert.equal(r["PESQUISAS"]?.length, 1);
    assert.equal(r["OUTRAS NOTÍCIAS"]?.length, 1);
  });

  it("ignora URLs em destaques (fora das seções secundárias)", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "https://destaque.com",
      "Texto.",
    ].join("\n");
    const r = extractUrlsBySection(md);
    assert.equal(Object.keys(r).length, 0);
  });

  it("#599: extrai URL de inline link `[título](URL)` em seções secundárias", () => {
    const md = [
      "LANÇAMENTOS",
      "[GPT-5 lançado](https://openai.com/gpt5)",
      "Descrição.",
      "",
      "---",
      "PESQUISAS",
      "[Novo paper](https://arxiv.org/abs/1234.5678)",
      "Descrição.",
    ].join("\n");
    const r = extractUrlsBySection(md);
    // URL extraída de dentro do inline link
    assert.equal(r["LANÇAMENTOS"]?.length, 1);
    assert.equal(r["LANÇAMENTOS"][0].url, "https://openai.com/gpt5");
    assert.equal(r["PESQUISAS"]?.length, 1);
    assert.equal(r["PESQUISAS"][0].url, "https://arxiv.org/abs/1234.5678");
  });
});

describe("buildUrlBucketMap", () => {
  it("highlights têm prioridade sobre buckets", () => {
    const approved = {
      highlights: [{ url: "https://x/destaque", title: "D1" }],
      lancamento: [{ url: "https://x/destaque", title: "D1" }],
      pesquisa: [],
      noticias: [],
    };
    const { byUrl } = buildUrlBucketMap(approved);
    assert.equal(byUrl.get("https://x/destaque")?.bucket, "highlights");
  });

  it("buckets mapeados corretamente", () => {
    const approved = {
      highlights: [],
      lancamento: [{ url: "https://l/x" }],
      pesquisa: [{ url: "https://p/x" }],
      noticias: [{ url: "https://n/x" }],
    };
    const { byUrl } = buildUrlBucketMap(approved);
    assert.equal(byUrl.get("https://l/x")?.bucket, "lancamento");
    assert.equal(byUrl.get("https://p/x")?.bucket, "pesquisa");
    assert.equal(byUrl.get("https://n/x")?.bucket, "noticias");
  });
});

describe("lintNewsletter", () => {
  it("ok quando todas URLs batem com bucket esperado", () => {
    const approved = {
      highlights: [],
      lancamento: [{ url: "https://openai.com/x" }],
      pesquisa: [{ url: "https://arxiv.org/y" }],
      noticias: [{ url: "https://techcrunch.com/z" }],
    };
    const md = [
      "LANÇAMENTOS",
      "Item",
      "https://openai.com/x",
      "",
      "---",
      "PESQUISAS",
      "https://arxiv.org/y",
      "",
      "---",
      "OUTRAS NOTÍCIAS",
      "https://techcrunch.com/z",
    ].join("\n");
    const r = lintNewsletter(md, approved);
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
  });

  it("erro quando URL com bucket noticias está em LANÇAMENTOS (caso ComfyUI 260426)", () => {
    const approved = {
      highlights: [],
      lancamento: [],
      pesquisa: [],
      noticias: [
        { url: "https://techcrunch.com/comfyui-500m", title: "ComfyUI hits $500M valuation" },
      ],
    };
    const md = [
      "LANÇAMENTOS",
      "ComfyUI atinge $500M",
      "https://techcrunch.com/comfyui-500m",
    ].join("\n");
    const r = lintNewsletter(md, approved);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].expected_bucket, "lancamento");
    assert.equal(r.errors[0].found_in_bucket, "noticias");
    assert.ok(r.errors[0].title?.includes("ComfyUI"));
  });

  it("erro quando URL não existe no approved", () => {
    const approved = { highlights: [], lancamento: [], pesquisa: [], noticias: [] };
    const md = [
      "LANÇAMENTOS",
      "Artigo fantasma",
      "https://ghost.com/x",
    ].join("\n");
    const r = lintNewsletter(md, approved);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].found_in_bucket, "missing");
  });

  it("destaque que aparece em seção secundária vira warning, não error", () => {
    const approved = {
      highlights: [{ url: "https://x/destaque", title: "Destaque" }],
      lancamento: [],
      pesquisa: [],
      noticias: [],
    };
    const md = [
      "LANÇAMENTOS",
      "Item",
      "https://x/destaque",
    ].join("\n");
    const r = lintNewsletter(md, approved);
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
    assert.equal(r.warnings.length, 1);
  });

  it("dedup markdown link [url](url)", () => {
    const approved = {
      highlights: [],
      lancamento: [{ url: "https://openai.com/x" }],
      pesquisa: [],
      noticias: [],
    };
    const md = [
      "LANÇAMENTOS",
      "Item",
      "[https://openai.com/x](https://openai.com/x)",
    ].join("\n");
    const r = lintNewsletter(md, approved);
    assert.equal(r.ok, true);
  });
});

describe("countTitlesPerHighlight (#178, #245)", () => {
  it("ok quando todos 3 destaques têm exatamente 1 título — formato single-newline (legado)", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título único do destaque 1",
      "https://example.com/1",
      "",
      "Corpo do destaque.",
      "",
      "---",
      "",
      "DESTAQUE 2 | PESQUISA",
      "Título único do destaque 2",
      "https://example.com/2",
      "",
      "Corpo.",
      "",
      "---",
      "",
      "DESTAQUE 3 | MERCADO",
      "Título único do destaque 3",
      "https://example.com/3",
      "",
      "Corpo.",
    ].join("\n");
    const r = countTitlesPerHighlight(md);
    assert.equal(r.ok, true);
    assert.equal(r.destaques.length, 3);
    for (const d of r.destaques) {
      assert.equal(d.title_count, 1);
      assert.equal(d.status, "ok");
    }
  });

  it("ok com formato double-newline (#245) — blank line entre cada elemento", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "Título único do destaque 1",
      "",
      "https://example.com/1",
      "",
      "Corpo do destaque.",
      "",
      "---",
      "",
      "DESTAQUE 2 | PESQUISA",
      "",
      "Título único do destaque 2",
      "",
      "https://example.com/2",
      "",
      "Corpo.",
      "",
      "---",
      "",
      "DESTAQUE 3 | MERCADO",
      "",
      "Título único do destaque 3",
      "",
      "https://example.com/3",
      "",
      "Corpo.",
    ].join("\n");
    const r = countTitlesPerHighlight(md);
    assert.equal(r.ok, true);
    assert.equal(r.destaques.length, 3);
    for (const d of r.destaques) {
      assert.equal(d.title_count, 1);
      assert.equal(d.status, "ok");
    }
  });

  it("erro quando destaque tem 3 títulos (editor não podou) — single-newline", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Opção 1 de título",
      "Opção 2 de título",
      "Opção 3 de título",
      "https://example.com/1",
      "",
      "Corpo.",
      "",
      "DESTAQUE 2 | PESQUISA",
      "Título único",
      "https://example.com/2",
      "",
      "Corpo.",
      "",
      "DESTAQUE 3 | MERCADO",
      "Título único",
      "https://example.com/3",
      "",
      "Corpo.",
    ].join("\n");
    const r = countTitlesPerHighlight(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.destaques[0].title_count, 3);
    assert.equal(r.destaques[0].status, "needs_pruning");
    assert.equal(r.destaques[1].status, "ok");
    assert.equal(r.destaques[2].status, "ok");
  });

  it("erro quando destaque tem 3 títulos (editor não podou) — double-newline (#245)", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "Opção 1 de título",
      "",
      "Opção 2 de título",
      "",
      "Opção 3 de título",
      "",
      "https://example.com/1",
      "",
      "Corpo.",
      "",
      "DESTAQUE 2 | PESQUISA",
      "",
      "Título único",
      "",
      "https://example.com/2",
      "",
      "Corpo.",
      "",
      "DESTAQUE 3 | MERCADO",
      "",
      "Título único",
      "",
      "https://example.com/3",
      "",
      "Corpo.",
    ].join("\n");
    const r = countTitlesPerHighlight(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.destaques[0].title_count, 3);
    assert.deepEqual(r.destaques[0].titles, [
      "Opção 1 de título",
      "Opção 2 de título",
      "Opção 3 de título",
    ]);
    assert.equal(r.destaques[1].status, "ok");
    assert.equal(r.destaques[2].status, "ok");
  });

  it("erro quando há menos de 3 destaques", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "Título",
      "",
      "https://example.com/1",
      "",
      "Corpo.",
    ].join("\n");
    const r = countTitlesPerHighlight(md);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("Esperado 3 destaques")));
  });

  it("URL na linha logo abaixo do header é ignorada (não conta como título)", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título único",
      "https://example.com/1",
      "",
      "Corpo.",
      "",
      "DESTAQUE 2 | PESQUISA",
      "Título único",
      "https://example.com/2",
      "",
      "DESTAQUE 3 | MERCADO",
      "Título único",
      "https://example.com/3",
    ].join("\n");
    const r = countTitlesPerHighlight(md);
    assert.equal(r.destaques[0].title_count, 1);
    assert.equal(r.destaques[0].titles[0], "Título único");
  });

  it("para em outro DESTAQUE quando bloco anterior não tem URL", () => {
    // Caso degenerado: destaque sem URL nenhum. Sem URL, o terminador
    // alternativo é o próximo DESTAQUE.
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "Título único",
      "",
      "DESTAQUE 2 | PESQUISA",
      "",
      "Título 2",
      "",
      "https://example.com/2",
      "",
      "DESTAQUE 3 | MERCADO",
      "",
      "Título 3",
      "",
      "https://example.com/3",
    ].join("\n");
    const r = countTitlesPerHighlight(md);
    assert.equal(r.destaques[0].title_count, 1);
    assert.equal(r.destaques[0].titles[0], "Título único");
  });

  it("#599: formato inline `[título](URL)` é contado como título", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "[Título único embedado](https://example.com/x)",
      "",
      "Corpo do destaque.",
      "",
      "DESTAQUE 2 | PESQUISA",
      "",
      "[Título D2](https://b.com/y)",
      "",
      "Corpo.",
      "",
      "DESTAQUE 3 | MERCADO",
      "",
      "[Título D3](https://c.com/z)",
      "",
      "Corpo.",
    ].join("\n");
    const r = countTitlesPerHighlight(md);
    assert.equal(r.ok, true);
    assert.equal(r.destaques.length, 3);
    assert.equal(r.destaques[0].title_count, 1);
    assert.equal(r.destaques[0].titles[0], "Título único embedado");
  });

  it("#599: formato inline com 3 opções pré-gate é detectado como needs_pruning", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "[Opção 1 do título](https://example.com/x)",
      "",
      "[Opção 2 do título](https://example.com/x)",
      "",
      "[Opção 3 do título](https://example.com/x)",
      "",
      "Corpo do destaque.",
      "",
      "DESTAQUE 2 | PESQUISA",
      "",
      "[Título único](https://b.com/y)",
      "",
      "Corpo.",
      "",
      "DESTAQUE 3 | MERCADO",
      "",
      "[Título único](https://c.com/z)",
      "",
      "Corpo.",
    ].join("\n");
    const r = countTitlesPerHighlight(md);
    assert.equal(r.ok, false);
    assert.equal(r.destaques[0].title_count, 3);
    assert.equal(r.destaques[0].status, "needs_pruning");
  });

  it("para em section break --- quando não há URL no bloco", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "Título único",
      "",
      "---",
      "",
      "DESTAQUE 2 | PESQUISA",
      "",
      "Título 2",
      "",
      "https://example.com/2",
      "",
      "DESTAQUE 3 | MERCADO",
      "",
      "Título 3",
      "",
      "https://example.com/3",
    ].join("\n");
    const r = countTitlesPerHighlight(md);
    assert.equal(r.destaques[0].title_count, 1);
  });
});

describe("checkTitleLengths (#701)", () => {
  it("ok quando todos títulos cabem em ≤52 chars", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "Título curto",
      "",
      "https://example.com/1",
      "",
      "Corpo.",
      "",
      "DESTAQUE 2 | PESQUISA",
      "",
      "Outro título dentro do limite",
      "",
      "https://example.com/2",
      "",
      "Corpo.",
      "",
      "DESTAQUE 3 | MERCADO",
      "",
      "Terceiro título OK",
      "",
      "https://example.com/3",
      "",
      "Corpo.",
    ].join("\n");
    const r = checkTitleLengths(md);
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
  });

  it("erro quando 1+ título excede 52 chars", () => {
    const longTitle = "Título extremamente longo que claramente passa do limite de 52 caracteres";
    assert.ok(longTitle.length > 52);
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      longTitle,
      "",
      "https://example.com/1",
      "",
      "Corpo.",
      "",
      "DESTAQUE 2 | PESQUISA",
      "",
      "Título OK",
      "",
      "https://example.com/2",
      "",
      "Corpo.",
      "",
      "DESTAQUE 3 | MERCADO",
      "",
      "Outro OK",
      "",
      "https://example.com/3",
      "",
      "Corpo.",
    ].join("\n");
    const r = checkTitleLengths(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].destaque, 1);
    assert.equal(r.errors[0].title, longTitle);
    assert.equal(r.errors[0].length, longTitle.length);
    assert.equal(r.errors[0].max, 52);
  });

  it("#599: formato inline `[título](URL)` mede só o texto, não o markdown", () => {
    // URL longa faria a linha inteira passar de 52 chars, mas o título é curto
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "[Título curto](https://example.com/path/with/very/long/segments/that/would/break/length-check)",
      "",
      "https://example.com/d1",
      "",
      "Corpo.",
      "",
      "DESTAQUE 2 | PESQUISA",
      "",
      "[Título OK](https://b.com)",
      "",
      "Corpo.",
      "",
      "DESTAQUE 3 | MERCADO",
      "",
      "[Outro OK](https://c.com)",
      "",
      "Corpo.",
    ].join("\n");
    const r = checkTitleLengths(md);
    assert.equal(r.ok, true, `esperado ok mas: ${JSON.stringify(r.errors)}`);
  });

  it("#599: formato inline com título DENTRO de `[]` excedendo 52 chars falha", () => {
    const longTitle = "Título extremamente longo dentro do markdown link que excede facilmente 52 chars";
    assert.ok(longTitle.length > 52);
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      `[${longTitle}](https://example.com/x)`,
      "",
      "Corpo.",
      "",
      "DESTAQUE 2 | PESQUISA",
      "",
      "[Título OK](https://b.com)",
      "",
      "Corpo.",
      "",
      "DESTAQUE 3 | MERCADO",
      "",
      "[Outro OK](https://c.com)",
      "",
      "Corpo.",
    ].join("\n");
    const r = checkTitleLengths(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].title, longTitle);
    assert.equal(r.errors[0].length, longTitle.length);
  });

  it("conta múltiplas opções de título (3 por destaque) — todas validadas", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Opção curta",
      "Opção também curta",
      "Opção bem longa que excede o limite de cinquenta e dois caracteres com folga",
      "https://example.com/1",
      "",
      "Corpo.",
      "",
      "DESTAQUE 2 | PESQUISA",
      "Título OK",
      "https://example.com/2",
      "",
      "Corpo.",
      "",
      "DESTAQUE 3 | MERCADO",
      "Outro OK",
      "https://example.com/3",
      "",
      "Corpo.",
    ].join("\n");
    const r = checkTitleLengths(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1); // só a 3ª opção falha
    assert.equal(r.errors[0].destaque, 1);
  });

  it("#801: título com emoji de bandeira 🇧🇷 não gera falso positivo (grapheme ≠ UTF-16 length)", () => {
    // "Brasil lidera ranking de IA 🇧🇷" = 31 grafemas mas 🇧🇷 = 4 code units
    // Com .length: 33 code units mas ainda abaixo de 52 — ok
    // Caso mais crítico: título de exatamente 52 grafemas com 🇧🇷 embutido
    // seria 54+ code units mas deve passar no check de grafemas.
    // Aqui: 48 grafemas + 🇧🇷 (1 grafema) = 49 grafemas total → ok (≤52)
    const titleWith49Graphemes = "OpenAI e Microsoft anunciam parceria no Brasil 🇧🇷";
    // Verificação: grapheme count < 52
    const graphemeCount = [...new Intl.Segmenter().segment(titleWith49Graphemes)].length;
    assert.ok(graphemeCount <= 52, `grafemas: ${graphemeCount}`);
    // Mas .length pode ser > graphemeCount por causa do emoji de bandeira
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      titleWith49Graphemes,
      "",
      "https://example.com/1",
      "",
      "Corpo.",
      "",
      "DESTAQUE 2 | PESQUISA",
      "",
      "Título OK",
      "",
      "https://example.com/2",
      "",
      "Corpo.",
      "",
      "DESTAQUE 3 | MERCADO",
      "",
      "Outro OK",
      "",
      "https://example.com/3",
      "",
      "Corpo.",
    ].join("\n");
    const r = checkTitleLengths(md);
    assert.equal(r.ok, true, `falso positivo: ${JSON.stringify(r.errors)}`);
    assert.equal(r.errors.length, 0);
  });

  it("#801: reported length usa grafemas, não code units", () => {
    // Título com 53 grafemas (excede limite) incluindo emoji de bandeira:
    // precisa checar que r.errors[0].length retorna 53 (grafemas), não > 53 (code units)
    const titleOver52Graphemes = "OpenAI e Microsoft anunciam grande parceria no Brasil 🇧🇷";
    const graphemeCount = [...new Intl.Segmenter().segment(titleOver52Graphemes)].length;
    assert.ok(graphemeCount > 52, `esperado >52 grafemas, got ${graphemeCount}`);
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      titleOver52Graphemes,
      "",
      "https://example.com/1",
      "",
      "Corpo.",
      "",
      "DESTAQUE 2 | PESQUISA",
      "",
      "Título OK",
      "",
      "https://example.com/2",
      "",
      "Corpo.",
      "",
      "DESTAQUE 3 | MERCADO",
      "",
      "Outro OK",
      "",
      "https://example.com/3",
      "",
      "Corpo.",
    ].join("\n");
    const r = checkTitleLengths(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    // length reportado deve ser o número de grafemas, não code units
    assert.equal(r.errors[0].length, graphemeCount);
  });
});

describe("checkWhyMattersFormat (#701)", () => {
  it("ok quando 'Por que isso importa:' não começa com 'Para [audiência],'", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título",
      "https://x.com",
      "",
      "Corpo.",
      "",
      "Por que isso importa:",
      "O dado muda a forma como a equipe avalia agentes em produção.",
    ].join("\n");
    const r = checkWhyMattersFormat(md);
    assert.equal(r.ok, true);
  });

  it("erro quando próxima linha começa com 'Para profissionais,'", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título",
      "https://x.com",
      "",
      "Por que isso importa:",
      "Para profissionais de tecnologia, o dado muda...",
    ].join("\n");
    const r = checkWhyMattersFormat(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].text, /^Para profissionais/);
  });

  it("erro inline 'Por que isso importa: Para X,'", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título",
      "https://x.com",
      "",
      "Por que isso importa: Para times de IA, o dado muda...",
    ].join("\n");
    const r = checkWhyMattersFormat(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
  });

  it("ok quando começa com 'Para que' (não é audiência)", () => {
    // Edge case: "Para que" é conjunção, não vocativo. Regex
    // /^Para\s+[a-z]/ casa, mas é falso positivo aceitável — raro no
    // corpus real e o benefício de não pular falsos negativos vale o
    // ruído ocasional. Documentando aqui pra revisar se virar problema.
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título",
      "https://x.com",
      "",
      "Por que isso importa: Para que o time entenda...",
    ].join("\n");
    const r = checkWhyMattersFormat(md);
    // Sim, é falso positivo conhecido — assert que casa pra documentar
    assert.equal(r.ok, false);
  });

  it("CRLF é normalizado", () => {
    const md = "DESTAQUE 1\r\nTítulo\r\nhttps://x.com\r\n\r\nPor que isso importa:\r\nO dado muda...";
    const r = checkWhyMattersFormat(md);
    assert.equal(r.ok, true);
  });
});

describe("checkEaiSection (#588)", () => {
  it("aceita 'É IA?' como linha solo (formato writer)", () => {
    const md = "DESTAQUE 1\n...\n\n---\n\nÉ IA?\n\nCrédito.\n\n---\n\nDESTAQUE 3";
    assert.equal(checkEaiSection(md).ok, true);
  });

  it("aceita '## É IA?' (formato categorized embedded #371)", () => {
    const md = "DESTAQUE 1\n...\n\n## É IA?\n\nCrédito.\n\nDESTAQUE 3";
    assert.equal(checkEaiSection(md).ok, true);
  });

  it("falha quando seção ausente", () => {
    const md = "DESTAQUE 1\n...\n\nDESTAQUE 2\n...\n\nDESTAQUE 3\n...";
    const result = checkEaiSection(md);
    assert.equal(result.ok, false);
    assert.match(result.error!, /É IA\?/);
    assert.match(result.error!, /writer\.md step 2b/);
  });

  it("normaliza CRLF", () => {
    const md = "DESTAQUE 1\r\n\r\n## É IA?\r\nCrédito.\r\n";
    assert.equal(checkEaiSection(md).ok, true);
  });
});

describe("checkEiaAnswer (#744)", () => {
  const TMP = "test/_tmp_eia_answer";

  it("ok quando 01-eia.md não existe (check não aplicável)", () => {
    const dir = join(TMP, "no_eia");
    mkdirSync(dir, { recursive: true });
    // Não cria 01-eia.md — check não deve falhar
    const mdPath = join(dir, "02-reviewed.md");
    writeFileSync(mdPath, "Texto sem frontmatter.");
    const result = checkEiaAnswer(mdPath, dir);
    assert.equal(result.ok, true);
    rmSync(dir, { recursive: true });
  });

  it("ok quando 01-eia.md existe e 02-reviewed.md tem eia_answer no frontmatter", () => {
    const dir = join(TMP, "with_eia_ok");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-eia.md"), "---\neia_answer:\n  A: real\n  B: ia\n---\n\nÉ IA?\n");
    const mdPath = join(dir, "02-reviewed.md");
    writeFileSync(mdPath, "---\neia_answer:\n  A: real\n  B: ia\n---\n\nTexto da newsletter.");
    const result = checkEiaAnswer(mdPath, dir);
    assert.equal(result.ok, true);
    rmSync(dir, { recursive: true });
  });

  it("falha quando 01-eia.md existe mas 02-reviewed.md não tem eia_answer", () => {
    const dir = join(TMP, "missing_eia");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-eia.md"), "---\neia_answer:\n  A: real\n  B: ia\n---\n\nÉ IA?\n");
    const mdPath = join(dir, "02-reviewed.md");
    writeFileSync(mdPath, "Para esta edição, selecionamos os 12 mais relevantes.\n\nTexto.");
    const result = checkEiaAnswer(mdPath, dir);
    assert.equal(result.ok, false);
    assert.match(result.label!, /eia_answer_missing/);
    assert.match(result.label!, /02-reviewed\.md has no eia_answer frontmatter/);
    rmSync(dir, { recursive: true });
  });

  it("falha quando 01-eia.md existe mas 02-reviewed.md não existe", () => {
    const dir = join(TMP, "no_reviewed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-eia.md"), "---\neia_answer: ia\n---\nÉ IA?\n");
    const mdPath = join(dir, "02-reviewed.md");
    // Não cria o arquivo
    const result = checkEiaAnswer(mdPath, dir);
    assert.equal(result.ok, false);
    assert.match(result.label!, /not found/);
    rmSync(dir, { recursive: true });
  });
});

describe("lintIntroCount (#743)", () => {
  function buildMd(count: number): string {
    // Constrói um MD com 3 destaques + N itens adicionais em seções
    const lines: string[] = [
      `Para esta edição, eu (o editor) enviei 3 submissões e a Diar.ia encontrou outros 100 artigos. Selecionamos os ${count} mais relevantes para as pessoas que assinam a newsletter.`,
      "",
      "---",
      "",
      "DESTAQUE 1 | PRODUTO",
      "Título",
      "https://example.com/d1",
      "",
      "Corpo.",
      "",
      "---",
      "",
      "DESTAQUE 2 | PESQUISA",
      "Título",
      "https://example.com/d2",
      "",
      "Corpo.",
      "",
      "---",
      "",
      "É IA?",
      "",
      "Crédito de imagem.",
      "",
      "---",
      "",
      "DESTAQUE 3 | MERCADO",
      "Título",
      "https://example.com/d3",
      "",
      "Corpo.",
      "",
      "---",
      "",
      "LANÇAMENTOS",
      "Item 1",
      "https://example.com/l1",
      "Descrição.",
      "",
      "---",
      "",
      "PESQUISAS",
      "Paper",
      "https://example.com/p1",
      "Resumo.",
      "",
      "---",
      "",
      "OUTRAS NOTÍCIAS",
      "Notícia 1",
      "https://example.com/n1",
      "Desc.",
      "",
      "Notícia 2",
      "https://example.com/n2",
      "Desc.",
    ];
    return lines.join("\n");
  }

  it("ok quando claimed === actual (3d + 1l + 1p + 2n = 7)", () => {
    const md = buildMd(7);
    const r = lintIntroCount(md);
    assert.equal(r.ok, true, `claimed=${r.claimed} actual=${r.actual}`);
    assert.equal(r.claimed, 7);
    assert.equal(r.actual, 7);
  });

  it("falha quando claimed > actual", () => {
    const md = buildMd(12); // declara 12 mas tem 7
    const r = lintIntroCount(md);
    assert.equal(r.ok, false);
    assert.equal(r.claimed, 12);
    assert.equal(r.actual, 7);
  });

  it("falha quando claimed < actual", () => {
    const md = buildMd(3); // declara 3 mas tem 7
    const r = lintIntroCount(md);
    assert.equal(r.ok, false);
    assert.equal(r.claimed, 3);
    assert.equal(r.actual, 7);
  });

  it("É IA? não conta como URL editorial", () => {
    const md = [
      "Selecionamos os 1 mais relevantes para as pessoas que assinam a newsletter.",
      "",
      "DESTAQUE 1 | PRODUTO",
      "Título",
      "https://example.com/d1",
      "",
      "Corpo.",
      "",
      "---",
      "",
      "É IA?",
      "",
      "Crédito: https://commons.wikimedia.org/wiki/XYZ — imagem real.",
    ].join("\n");
    const r = lintIntroCount(md);
    // só 1 destaque conta; É IA? não conta
    assert.equal(r.actual, 1);
    assert.equal(r.ok, true);
  });

  it("forma singular não é verificada (retorna ok: true)", () => {
    const md = "Selecionamos o artigo mais relevante para as pessoas que assinam a newsletter.";
    const r = lintIntroCount(md);
    assert.equal(r.ok, true);
    assert.equal(r.claimed, undefined);
  });

  it("#804: reconhece 'Escolhemos os N' (pós-humanizador) e detecta divergência", () => {
    // Phrasing alternativa introduzida por humanizador/Clarice
    const md = [
      "Escolhemos os 12 mais relevantes para as pessoas que assinam a newsletter.",
      "",
      "---",
      "",
      "DESTAQUE 1 | PRODUTO",
      "Título",
      "https://example.com/d1",
      "",
      "Corpo.",
      "",
      "---",
      "",
      "DESTAQUE 2 | PESQUISA",
      "Título",
      "https://example.com/d2",
      "",
      "Corpo.",
      "",
      "---",
      "",
      "DESTAQUE 3 | MERCADO",
      "Título",
      "https://example.com/d3",
      "",
      "Corpo.",
    ].join("\n");
    const r = lintIntroCount(md);
    // claimed = 12, actual = 3 destaques = 3
    assert.equal(r.claimed, 12);
    assert.equal(r.actual, 3);
    assert.equal(r.ok, false);
  });

  it("#804: reconhece 'Reunimos os N' e valida corretamente", () => {
    const md = [
      "Reunimos os 3 mais relevantes para as pessoas que assinam a newsletter.",
      "",
      "DESTAQUE 1 | PRODUTO",
      "Título",
      "https://example.com/d1",
      "",
      "Corpo.",
      "",
      "---",
      "",
      "DESTAQUE 2 | PESQUISA",
      "Título",
      "https://example.com/d2",
      "",
      "Corpo.",
      "",
      "---",
      "",
      "DESTAQUE 3 | MERCADO",
      "Título",
      "https://example.com/d3",
      "",
      "Corpo.",
    ].join("\n");
    const r = lintIntroCount(md);
    assert.equal(r.claimed, 3);
    assert.equal(r.actual, 3);
    assert.equal(r.ok, true);
  });

  it("#804: reconhece 'Separamos os N', 'Destacamos os N', 'Trouxemos os N'", () => {
    // Cada uma das alternativas deve fazer lintIntroCount extrair o número
    for (const verb of ["Separamos", "Destacamos", "Trouxemos"]) {
      const md = `${verb} os 5 mais relevantes para as pessoas que assinam a newsletter.`;
      const r = lintIntroCount(md);
      // Sem body, actual = 0 → not ok, but claimed must be parsed
      assert.equal(r.claimed, 5, `${verb}: claimed deveria ser 5`);
    }
  });

  it("#599: conta itens de seção no formato inline [Título](url)", () => {
    const md = [
      "Selecionamos os 4 mais relevantes para as pessoas que assinam a newsletter.",
      "",
      "DESTAQUE 1 | PRODUTO",
      "[Título D1](https://example.com/d1)",
      "",
      "Corpo.",
      "",
      "---",
      "",
      "LANÇAMENTOS",
      "",
      "[Item inline](https://example.com/l1)",
      "Descrição do item.",
      "",
      "---",
      "",
      "PESQUISAS",
      "",
      "[Paper inline](https://example.com/p1)",
      "Resumo.",
      "",
      "---",
      "",
      "OUTRAS NOTÍCIAS",
      "",
      "[Notícia inline](https://example.com/n1)",
      "Desc.",
    ].join("\n");
    const r = lintIntroCount(md);
    assert.equal(r.actual, 4, `actual=${r.actual} claimed=${r.claimed}`);
    assert.equal(r.ok, true);
  });
});

describe("lintRelativeTime (#747)", () => {
  it("ok quando não há referências temporais relativas", () => {
    const md = "O relatório foi publicado em 5 de maio de 2026. Dados de 2025 confirmam tendência.";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 0);
  });

  it("detecta 'hoje'", () => {
    const md = "O ChatGPT anunciou hoje uma nova versão do modelo.";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].word, "hoje");
  });

  it("detecta 'ontem', 'esta semana', 'recentemente'", () => {
    const md = [
      "Ontem a OpenAI publicou os dados.",
      "Esta semana a regulação avançou.",
      "O modelo foi lançado recentemente.",
    ].join("\n");
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.equal(r.matches.length, 3);
    const words = r.matches.map((m) => m.word.toLowerCase());
    assert.ok(words.some((w) => w === "ontem"));
    assert.ok(words.some((w) => w === "esta semana"));
    assert.ok(words.some((w) => w === "recentemente"));
  });

  it("detecta 'amanhã'", () => {
    const md = "A votação acontece amanhã no Senado.";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.equal(r.matches.length, 1);
  });

  it("detecta dia da semana com 'nesta'", () => {
    const md = "A empresa anunciou nesta terça-feira os resultados.";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.equal(r.matches.length, 1);
    assert.match(r.matches[0].word, /nesta terça/i);
  });

  it("normaliza CRLF antes de testar", () => {
    const md = "O dado foi publicado\r\nontem no repositório.\r\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.equal(r.matches[0].word.toLowerCase(), "ontem");
  });

  it("inclui número da linha no match", () => {
    const md = "Linha 1 sem problemas.\nO dado saiu hoje mesmo.\nLinha 3 ok.";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.equal(r.matches[0].line, 2);
  });
});
