/**
 * test/seo-slug-pull.test.ts (#1989)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { slugify, seoSlug, seoMetaDescription, formatManualSlugFixInstructions } from "../scripts/lib/slug.ts";
import { scoreOpportunities, parseGscResponse, isoDate, buildSeoPullOutput, type GscRow } from "../scripts/seo-pull.ts";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("slug acent-correto (#1989)", () => {
  it("slugify: strip de acentos PT-BR (o bug do auto-slug do Beehiiv)", () => {
    // Beehiiv auto-derivava `automa-o`/`p-nico`; o slugify NFD resolve.
    assert.equal(slugify("Empregos e automação: pânico vs dados"), "empregos-e-automacao-panico-vs-dados");
    assert.equal(slugify("Inteligência Artificial à brasileira"), "inteligencia-artificial-a-brasileira");
    assert.equal(slugify("ChatGPT, Gemini & Claude"), "chatgpt-gemini-claude");
  });

  it("#3449 regressão: título real da edição 260714 (â→a) — 'câncer' vira 'cancer', não 'c-ncer'", () => {
    // Caso real do post-mortem #3449: Beehiiv REMOVEU o 'â' em vez de
    // transliterar, gerando `ia-do-google-detecta-c-ncer-raro-no-sus`.
    assert.equal(
      slugify("IA do Google detecta câncer raro no SUS"),
      "ia-do-google-detecta-cancer-raro-no-sus",
    );
    assert.equal(
      seoSlug("IA do Google detecta câncer raro no SUS"),
      "ia-do-google-detecta-cancer-raro-no-sus",
    );
  });

  it("#3449: cobertura de todos os acentos PT-BR comuns (â/ç/ã/é/í/ó/ú)", () => {
    assert.equal(slugify("Câmera"), "camera"); // â
    assert.equal(slugify("Ação"), "acao"); // ã + ç (cedilha)
    assert.equal(slugify("Café"), "cafe"); // é
    assert.equal(slugify("País"), "pais"); // í
    assert.equal(slugify("Órgão"), "orgao"); // ó + ã
    assert.equal(slugify("Última"), "ultima"); // ú
    assert.equal(slugify("Reação química"), "reacao-quimica"); // ç + í
  });

  it("seoSlug: trunca em palavra inteira até maxLen (sem cortar palavra/hífen pendente)", () => {
    const long = "Microsoft lança sete modelos proprios da familia MAI para competir com OpenAI e Google";
    const s = seoSlug(long, 60);
    assert.ok(s.length <= 60);
    assert.ok(!s.endsWith("-"), "sem hífen pendente");
    assert.ok(!s.includes("--"), "sem hífen duplo");
    // não corta no meio de palavra: o último segmento é palavra inteira
    assert.match(s, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    // slug curto passa intacto
    assert.equal(seoSlug("GPT-5 chega ao Brasil"), "gpt-5-chega-ao-brasil");
  });

  it("seoMetaDescription: combina título+subtítulo, trunca em palavra + reticências", () => {
    const d = seoMetaDescription("Título curto", "Subtítulo curto");
    assert.equal(d, "Título curto — Subtítulo curto");
    const long = seoMetaDescription("A".repeat(100), "B".repeat(100), 80);
    assert.ok(long.length <= 81, "≤ maxLen + reticências");
    assert.ok(long.endsWith("…"));
  });

  // #7280 (investigação, 03/09/2026): 21 páginas do acervo têm URL com
  // acento destruído em 2 padrões distintos ("lanc-a" decomposição,
  // "amea-as" descarte). NENHUM dos dois é produzido por `slugify`/`seoSlug`
  // — as 21 são resíduo histórico de slug auto-derivado direto pela Beehiiv
  // (antes do slug SEO passar a ser SETADO explicitamente via `seoSlug` no
  // Stage 5, #1989, e GATE-BLOCKED no Stage 6 contra divergência, #4570).
  // Este teste ancora essa conclusão: reconstrói os títulos prováveis por
  // trás de cada slug corrompido do corpo do #7280 e confirma que o
  // algoritmo ATIVO hoje nunca reproduziria o padrão quebrado — não há
  // fix de código pendente aqui, só a decisão editorial (fora de escopo
  // técnico) sobre renomear/redirecionar as 21 URLs públicas já existentes.
  it("REGRESSÃO #7280: nenhum dos 2 padrões de corrupção do acervo (decomposição/descarte) sai de seoSlug hoje", () => {
    // Cada caso: título provável reconstruído a partir do slug corrompido
    // registrado no corpo do #7280, o slug CORRETO que `seoSlug` produz hoje,
    // e o slug CORROMPIDO observado no acervo (2 padrões: "lanc-a" decompõe o
    // caractere acentuado deixando a letra-base + hífen; "amea-as" descarta o
    // caractere inteiro). Nota de método (#7280, correção do próprio autor):
    // "-a-"/"-e-"/"-o-" isolados são palavras legítimas em PT-BR (artigo/
    // conjunção) — por isso a asserção usa IGUALDADE exata contra o slug
    // correto esperado, nunca um regex genérico que confundiria as duas
    // coisas (foi exatamente esse erro que inflou a contagem original de
    // 107 para os 21 casos reais).
    const casosDoAcervo: Array<[titulo: string, correto: string, corrompido: string]> = [
      [
        "90% das pessoas não reconhecem vídeos de IA",
        "90-das-pessoas-nao-reconhecem-videos-de-ia",
        "90-das-pessoas-na-o-reconhecem-vi-deos-de-ia",
      ],
      [
        "IA com lança agentes de IA autônomos",
        "ia-com-lanca-agentes-de-ia-autonomos",
        "ai-com-lanc-a-agentes-de-ia-auto-nomos",
      ],
      [
        "Alibaba lança três modelos de open source",
        "alibaba-lanca-tres-modelos-de-open-source",
        "alibaba-lanc-a-tre-s-modelos-de-open-source",
      ],
      [
        "Anthropic e Gates: 200 mi em saúde e educação",
        "anthropic-e-gates-200-mi-em-saude-e-educacao",
        "anthropic-e-gates-200-mi-em-sa-de-e-educa-o",
      ],
      [
        "Altman admite: a IA trará ameaças",
        "altman-admite-a-ia-trara-ameacas",
        "altman-admite-a-ia-trar-amea-as",
      ],
      [
        "Anthropic expõe código do Claude Code",
        "anthropic-expoe-codigo-do-claude-code",
        "anthropic-expo-e-co-digo-do-claude-code",
      ],
      [
        "Claude Code afunda ações da IBM",
        "claude-code-afunda-acoes-da-ibm",
        "claude-code-afunda-ac-o-es-da-ibm",
      ],
      [
        "Brasil: 70% da geração Z usa ChatGPT todo mês",
        "brasil-70-da-geracao-z-usa-chatgpt-todo-mes",
        "brasil-70-da-gera-o-z-usa-chatgpt-todo-m-s",
      ],
    ];
    for (const [titulo, correto, corrompido] of casosDoAcervo) {
      assert.equal(seoSlug(titulo), correto, `seoSlug("${titulo}")`);
      assert.notEqual(
        seoSlug(titulo),
        corrompido,
        `seoSlug("${titulo}") não pode reproduzir o padrão corrompido observado no acervo`,
      );
    }
  });
});

describe("formatManualSlugFixInstructions (#3449)", () => {
  it("inclui post_id, slug alvo e localização do campo na UI Beehiiv", () => {
    const msg = formatManualSlugFixInstructions("post_abc123", "ia-do-google-detecta-cancer-raro-no-sus");
    assert.match(msg, /post_abc123/);
    assert.match(msg, /ia-do-google-detecta-cancer-raro-no-sus/);
    assert.match(msg, /#text-input-slug/);
    assert.match(msg, /SEO/i);
    assert.match(msg, /app\.beehiiv\.com\/posts\/post_abc123\/edit/);
  });

  it("é determinística (mesma entrada → mesma saída)", () => {
    const a = formatManualSlugFixInstructions("post_x", "slug-x");
    const b = formatManualSlugFixInstructions("post_x", "slug-x");
    assert.equal(a, b);
  });
});

describe("scoreOpportunities (#1989)", () => {
  const row = (o: Partial<GscRow>): GscRow => ({ page: "p", clicks: 0, impressions: 100, ctr: 0.01, position: 8, ...o });

  it("low_ctr: impressões altas + CTR << esperado pra posição", () => {
    // posição 2 espera ~12%; CTR 1% << metade (6%) → low_ctr
    const opps = scoreOpportunities([row({ position: 2, ctr: 0.01, impressions: 500 })]);
    assert.equal(opps.length, 1);
    assert.equal(opps[0].type, "low_ctr");
  });

  it("near_first_page: posição 5-15 com impressões (CTR ok pra posição)", () => {
    // posição 8 espera ~2.5%; CTR 2% > metade (1.25%) → não low_ctr; 5≤8≤15 → near_first_page
    const opps = scoreOpportunities([row({ position: 8, ctr: 0.02, impressions: 300 })]);
    assert.equal(opps.length, 1);
    assert.equal(opps[0].type, "near_first_page");
  });

  it("ignora impressões abaixo do mínimo (ruído)", () => {
    assert.equal(scoreOpportunities([row({ impressions: 10 })]).length, 0);
  });

  it("ordena por impressões desc (maior potencial primeiro)", () => {
    const opps = scoreOpportunities([
      row({ page: "a", position: 8, ctr: 0.02, impressions: 100 }),
      row({ page: "b", position: 8, ctr: 0.02, impressions: 900 }),
    ]);
    assert.equal(opps[0].page, "b");
  });
});

describe("parseGscResponse + isoDate (#1989)", () => {
  it("parseia rows [page,query] da Search Analytics API", () => {
    const rows = parseGscResponse({
      rows: [{ keys: ["https://x.com/p", "como usar ia"], clicks: 5, impressions: 200, ctr: 0.025, position: 7.3 }],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].page, "https://x.com/p");
    assert.equal(rows[0].query, "como usar ia");
    assert.equal(rows[0].position, 7.3);
  });

  it("resposta vazia/sem rows → []", () => {
    assert.deepEqual(parseGscResponse({}), []);
    assert.deepEqual(parseGscResponse({ rows: null }), []);
  });

  it("code-review: elemento null no array não crasha", () => {
    const rows = parseGscResponse({ rows: [null, { keys: ["p"], impressions: 10 }] });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].page, ""); // null → defaults
    assert.equal(rows[1].page, "p");
  });

  it("isoDate: epoch ms → YYYY-MM-DD", () => {
    assert.equal(isoDate(Date.UTC(2026, 5, 9, 12, 0, 0)), "2026-06-09");
  });
});

describe("buildSeoPullOutput (#4908 item 1)", () => {
  const row = (o: Partial<GscRow>): GscRow => ({ page: "p", clicks: 0, impressions: 10, ctr: 0.01, position: 8, ...o });

  it("inclui as N rows de entrada na saída, e total_rows bate com N", () => {
    const rows = [row({ page: "a" }), row({ page: "b" }), row({ page: "c" })];
    const out = buildSeoPullOutput(rows, "sc-domain:diar.ia.br", "2026-07-13_2026-08-10");
    assert.equal(out.total_rows, 3);
    assert.equal(out.rows.length, 3);
    assert.deepEqual(out.rows, rows);
  });

  it("rows vazio → total_rows 0 e rows []", () => {
    const out = buildSeoPullOutput([], "sc-domain:diar.ia.br", "p");
    assert.equal(out.total_rows, 0);
    assert.deepEqual(out.rows, []);
  });

  it("site/period são repassados tal qual, sem transformação", () => {
    const out = buildSeoPullOutput([], "sc-domain:x.com", "2026-01-01_2026-01-28");
    assert.equal(out.site, "sc-domain:x.com");
    assert.equal(out.period, "2026-01-01_2026-01-28");
  });

  it("opportunities continua derivado de scoreOpportunities — mesmo resultado, sem duplicar lógica", () => {
    const rows = [row({ position: 2, ctr: 0.01, impressions: 500 })];
    const out = buildSeoPullOutput(rows, "s", "p");
    assert.deepEqual(out.opportunities, scoreOpportunities(rows));
  });

  it("#5119 item 4: discover/news default pra {total_rows: 0, rows: []} — REGISTRADO, não ausente", () => {
    const out = buildSeoPullOutput([], "s", "p");
    assert.deepEqual(out.discover, { total_rows: 0, rows: [] });
    assert.deepEqual(out.news, { total_rows: 0, rows: [] });
  });

  it("#5119 item 4: discover/news preenchidos ficam separados de rows/total_rows do web", () => {
    const webRows = [row({ page: "https://diar.ia.br/p/x" })];
    const discoverRows = [row({ page: "https://diar.ia.br/p/y", query: undefined })];
    const newsRows = [row({ page: "https://diar.ia.br/p/z", query: undefined })];
    const out = buildSeoPullOutput(webRows, "s", "p", discoverRows, newsRows);
    assert.equal(out.total_rows, 1);
    assert.deepEqual(out.rows, webRows);
    assert.equal(out.discover.total_rows, 1);
    assert.deepEqual(out.discover.rows, discoverRows);
    assert.equal(out.news.total_rows, 1);
    assert.deepEqual(out.news.rows, newsRows);
  });
});

describe("parseGscResponse — dimensões ampliadas (#5119 item 2/3)", () => {
  it("dimensions default [page,query] continua funcionando sem mudança de assinatura pro caller antigo", () => {
    const rows = parseGscResponse({
      rows: [{ keys: ["https://x.com/p", "como usar ia"], clicks: 5, impressions: 200, ctr: 0.025, position: 7.3 }],
    });
    assert.equal(rows[0].page, "https://x.com/p");
    assert.equal(rows[0].query, "como usar ia");
    assert.equal(rows[0].date, undefined);
    assert.equal(rows[0].country, undefined);
  });

  it("dimensions [page,query,date,country]: keys[] mapeiam na mesma ordem", () => {
    const rows = parseGscResponse(
      {
        rows: [
          {
            keys: ["https://diar.ia.br/p/x", "assistente de ia brasileiro", "2026-08-05", "bra"],
            clicks: 3,
            impressions: 120,
            ctr: 0.025,
            position: 9.1,
          },
        ],
      },
      ["page", "query", "date", "country"],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].page, "https://diar.ia.br/p/x");
    assert.equal(rows[0].query, "assistente de ia brasileiro");
    assert.equal(rows[0].date, "2026-08-05");
    assert.equal(rows[0].country, "bra");
  });

  it("dimensions [page,date] (discover/news, sem query): query fica undefined, não a data por engano", () => {
    const rows = parseGscResponse(
      { rows: [{ keys: ["https://diar.ia.br/p/x", "2026-08-05"], clicks: 0, impressions: 40, ctr: 0, position: 0 }] },
      ["page", "date"],
    );
    assert.equal(rows[0].page, "https://diar.ia.br/p/x");
    assert.equal(rows[0].date, "2026-08-05");
    assert.equal(rows[0].query, undefined);
  });

  it("resposta vazia com dimensions ampliadas ainda retorna []", () => {
    assert.deepEqual(parseGscResponse({}, ["page", "query", "date", "country"]), []);
  });
});

describe("scripts/lib/scheduled-tasks.ts — Diaria-SEO-Weekly usa as dimensões ampliadas (#5119)", () => {
  it("o step 'pull' (seo-pull.ts) não fixa --dimensions antigo (page,query) que reverteria o #5119", () => {
    // Não é teste de conteúdo do array de args (o default já cobre isso em
    // main()) — é guard contra alguém reintroduzir um --dimensions
    // explícito estreito no registry sem perceber que isso pisa no default
    // ampliado.
    const src = readFileSync(resolve(ROOT, "scripts/lib/scheduled-tasks.ts"), "utf8");
    const pullStepMatch = src.match(/key:\s*"pull"[^}]*args:\s*\[[^\]]*\]/);
    assert.ok(pullStepMatch, "step 'pull' não encontrado em Diaria-SEO-Weekly");
    assert.ok(
      !pullStepMatch![0].includes("--dimensions"),
      "step 'pull' não deve fixar --dimensions — usar o default ampliado de seo-pull.ts (#5119)",
    );
  });
});
