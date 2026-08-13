/**
 * test/generate-hub-sources.test.ts (#4558 Parte A)
 *
 * Cobre a parte PURA de `scripts/generate-hub-sources.ts` (`collectHubSources`)
 * — sem tocar `data/beehiiv-cache/`. Cobre em particular o achado ao vivo da
 * sessão que implementou o hub Anthropic/Claude: o cache Beehiiv guarda
 * texto em NFD (acento como combining mark separado) — `stripAccents()` é
 * defensiva aqui (o `PATTERN` de teste abaixo tem um termo acentuado de
 * propósito, pra realmente exercitar o caminho que `HUB_KEYWORD_PATTERNS`
 * de produção hoje não exercita — ver nota do módulo sob teste). Também
 * cobre o achado do fleet review da PR: post confirmado e casado mas sem
 * `slug`/`publish_date` resolvível vira WARNING, nunca um drop mudo.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectHubSources,
  backfillEditionTitles,
  computeHubSourcesDiff,
  writeGeneratedHubSources,
  type HubSourceEntry,
} from "../scripts/generate-hub-sources.ts";
import type { RawCachedPost } from "../scripts/generate-arquivo-titles.ts";

// Termo acentuado ("análise") de propósito — diferente de HUB_KEYWORD_PATTERNS
// de produção (sem acento), isso garante que o teste de NFD abaixo realmente
// dependeria de `stripAccents()` pra passar, não passaria de qualquer jeito.
const PATTERN = /anthropic|\bclaude\b|\bopus\b|análise/i;

describe("collectHubSources (#4558 Parte A)", () => {
  it("casa mesmo quando o texto vem em NFD (combining mark separado) — regression do achado ao vivo", () => {
    // "á" armazenado como "a" + U+0301 (combining acute), igual ao cache real.
    const nfdTitle = "Claude submetido a análise psicológica".normalize("NFD");
    const posts: RawCachedPost[] = [
      { slug: "edicao-nfd", title: nfdTitle, status: "confirmed", publish_date: Date.UTC(2026, 3, 9, 18) / 1000 },
    ];
    const { rows } = collectHubSources(posts, PATTERN);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].matchedHeadlines.length, 1);
  });

  it("ignora posts não confirmados (draft)", () => {
    const posts: RawCachedPost[] = [
      { slug: "rascunho", title: "Anthropic lança algo", status: "draft", publish_date: 1753000000 },
    ];
    const { rows, warnings } = collectHubSources(posts, PATTERN);
    assert.deepEqual(rows, []);
    assert.deepEqual(warnings, []);
  });

  it("post confirmado e casado sem slug vira warning, não drop mudo", () => {
    const posts: RawCachedPost[] = [
      { title: "Anthropic lança algo", status: "confirmed", publish_date: 1753000000 },
    ];
    const { rows, warnings } = collectHubSources(posts, PATTERN);
    assert.deepEqual(rows, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /sem slug resolvível/);
  });

  it("post confirmado e casado sem publish_date vira warning, não drop mudo (e não entra com date vazio)", () => {
    const posts: RawCachedPost[] = [{ slug: "sem-data", title: "Claude faz algo", status: "confirmed" }];
    const { rows, warnings } = collectHubSources(posts, PATTERN);
    assert.deepEqual(rows, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /sem publish_date/);
  });

  it("só inclui os destaques (título/itens do subtítulo) que batem a palavra-chave, não a edição inteira", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "edicao-mista",
        title: "Google lança Gemini 4",
        subtitle: "Anthropic lança Claude Opus 5 | Meta compra startup",
        status: "confirmed",
        publish_date: Date.UTC(2026, 6, 27, 18) / 1000,
      },
    ];
    const { rows } = collectHubSources(posts, PATTERN);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].matchedHeadlines, ["Anthropic lança Claude Opus 5"]);
  });

  it("url usa o domínio de marca diar.ia.br, não o slug bruto do Beehiiv", () => {
    const posts: RawCachedPost[] = [
      { slug: "meu-slug", title: "Claude faz algo", status: "confirmed", publish_date: 1753000000 },
    ];
    const { rows } = collectHubSources(posts, PATTERN);
    assert.equal(rows[0].url, "https://diar.ia.br/p/meu-slug");
    assert.equal(rows[0].editionSlug, "meu-slug");
  });

  it("ordena por data crescente", () => {
    const posts: RawCachedPost[] = [
      { slug: "b", title: "Claude B", status: "confirmed", publish_date: Date.UTC(2026, 5, 1, 18) / 1000 },
      { slug: "a", title: "Claude A", status: "confirmed", publish_date: Date.UTC(2026, 0, 1, 18) / 1000 },
    ];
    const { rows } = collectHubSources(posts, PATTERN);
    assert.deepEqual(
      rows.map((r) => r.editionSlug),
      ["a", "b"],
    );
  });

  it("mistura de posts válidos e inválidos: só os válidos entram em rows, cada inválido gera 1 warning", () => {
    const posts: RawCachedPost[] = [
      { slug: "valido", title: "Claude válido", status: "confirmed", publish_date: Date.UTC(2026, 0, 1, 18) / 1000 },
      { title: "Claude sem slug", status: "confirmed", publish_date: 1753000000 },
      { slug: "sem-data", title: "Claude sem data", status: "confirmed" },
      { slug: "irrelevante", title: "Google lança algo", status: "confirmed", publish_date: 1753000000 },
    ];
    const { rows, warnings } = collectHubSources(posts, PATTERN);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].editionSlug, "valido");
    assert.equal(warnings.length, 2);
  });
});

describe("collectHubSources — primarySourceUrls (#4919 Parte A)", () => {
  it("post sem content.free.web: linha sai sem o campo primarySourceUrls", () => {
    const posts: RawCachedPost[] = [
      { slug: "sem-content", title: "Claude faz algo", status: "confirmed", publish_date: 1753000000 },
    ];
    const { rows } = collectHubSources(posts, PATTERN);
    assert.equal(rows.length, 1);
    assert.equal("primarySourceUrls" in rows[0], false);
  });

  it("âncora de texto idêntico casada: primarySourceUrls alinhado por índice com matchedHeadlines, UTM removido", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "com-fonte",
        title: "Claude faz algo",
        status: "confirmed",
        publish_date: 1753000000,
        content: {
          free: {
            web: `<a class="headline" href="https://anthropic.com/index/x?utm_source=diaria.beehiiv.com">Claude faz algo</a>`,
          },
        },
      },
    ];
    const { rows } = collectHubSources(posts, PATTERN);
    assert.deepEqual(rows[0].matchedHeadlines, ["Claude faz algo"]);
    assert.deepEqual(rows[0].primarySourceUrls, ["https://anthropic.com/index/x"]);
  });

  it("regressão do erro medido: manchete sem âncora + link de patrocinador logo depois — sai SEM o campo, nunca herda o link vizinho", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "sem-fonte-com-patrocinador",
        title: "Claude faz algo",
        status: "confirmed",
        publish_date: 1753000000,
        content: {
          free: {
            web: `
              <h3>Claude faz algo</h3>
              <p>Texto sem CTA de aprofundamento.</p>
              <p><a href="https://deel.com/patrocinador?utm_source=diaria.beehiiv.com">Saiba mais sobre a Deel</a></p>
            `,
          },
        },
      },
    ];
    const { rows } = collectHubSources(posts, PATTERN);
    assert.equal(rows.length, 1);
    // Nenhuma posição achou fonte -> campo inteiro fica ausente (array de
    // só null não carregaria informação nova), nunca o href do patrocinador.
    assert.equal("primarySourceUrls" in rows[0], false);
  });

  it("2 manchetes casadas na mesma edição: 1 encontra âncora, a outra não — array preserva alinhamento com null", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "duas-manchetes",
        title: "Anthropic lança Claude Opus 5",
        subtitle: "Anthropic triplica valuation",
        status: "confirmed",
        publish_date: 1753000000,
        content: {
          free: {
            web: `<a class="headline" href="https://anthropic.com/opus-5?utm_source=diar.ia.br">Anthropic lança Claude Opus 5</a>`,
          },
        },
      },
    ];
    const { rows } = collectHubSources(posts, PATTERN);
    assert.deepEqual(rows[0].matchedHeadlines, ["Anthropic lança Claude Opus 5", "Anthropic triplica valuation"]);
    assert.deepEqual(rows[0].primarySourceUrls, ["https://anthropic.com/opus-5", null]);
  });
});

describe("collectHubSources — propagação do override de data (#4803)", () => {
  it("um override presente e válido vence o publish_date bruto na entrada final", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "edicao-antiga",
        title: "Anthropic lança algo antigo",
        status: "confirmed",
        publish_date: Date.UTC(2025, 8, 3, 18, 0, 0) / 1000,
      },
    ];
    const { rows, warnings } = collectHubSources(posts, PATTERN, {
      overrides: { "edicao-antiga": "2025-06-15" },
      discarded: [],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, "2025-06-15");
    assert.deepEqual(warnings, []);
  });

  it("overridesResult.error vira warning visível, sem bloquear o resto do processamento", () => {
    const posts: RawCachedPost[] = [
      { slug: "edicao-x", title: "Claude X", status: "confirmed", publish_date: Date.UTC(2026, 6, 1, 18) / 1000 },
    ];
    const { rows, warnings } = collectHubSources(posts, PATTERN, {
      overrides: {},
      error: "Unexpected end of JSON input",
      discarded: [],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, "2026-07-01");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /malformado/);
  });

  it("overridesResult.discarded (entrada de formato inválido) vira warning visível", () => {
    const posts: RawCachedPost[] = [
      { slug: "edicao-y", title: "Claude Y", status: "confirmed", publish_date: Date.UTC(2026, 6, 1, 18) / 1000 },
    ];
    const { warnings } = collectHubSources(posts, PATTERN, {
      overrides: {},
      discarded: [`slug "edicao-y": valor de override inválido (esperado "YYYY-MM-DD", recebido "")`],
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /edicao-y/);
  });
});

describe("collectHubSources — editionTitle, caminho ideal (#4918 Conserto 2)", () => {
  it("preenche editionTitle com post.title (já em escopo pra montar destaques)", () => {
    const posts: RawCachedPost[] = [
      { slug: "edicao-x", title: "Anthropic lança algo", status: "confirmed", publish_date: 1753000000 },
    ];
    const { rows } = collectHubSources(posts, PATTERN);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].editionTitle, "Anthropic lança algo");
  });
});

describe('backfillEditionTitles (#4918 Conserto 2, "caminho barato") — pure, sem junction data/', () => {
  it("preenche editionTitle a partir do titlesCache quando ausente na linha", () => {
    const rows: HubSourceEntry[] = [
      {
        date: "2025-09-03",
        editionSlug: "brasil-pretende-investir-r-23-bilh-es-em-ia",
        url: "https://diar.ia.br/p/brasil-pretende-investir-r-23-bilh-es-em-ia",
        matchedHeadlines: ["Anthropic triplica valuation"],
      },
    ];
    const titlesCache = {
      "brasil-pretende-investir-r-23-bilh-es-em-ia": {
        title: "Brasil pretende investir R$ 23 bi em IA",
        publishDate: "2025-09-03",
      },
    };
    const filled = backfillEditionTitles(rows, titlesCache);
    assert.equal(filled[0].editionTitle, "Brasil pretende investir R$ 23 bi em IA");
    // Pure: não muta o array/objetos originais.
    assert.equal(rows[0].editionTitle, undefined);
  });

  it("não sobrescreve editionTitle já presente na linha (caminho ideal já rodou)", () => {
    const rows: HubSourceEntry[] = [
      {
        date: "2026-01-01",
        editionSlug: "edicao-1",
        url: "https://diar.ia.br/p/edicao-1",
        matchedHeadlines: ["Manchete"],
        editionTitle: "Título já preenchido",
      },
    ];
    const filled = backfillEditionTitles(rows, { "edicao-1": { title: "Outro título", publishDate: "2026-01-01" } });
    assert.equal(filled[0].editionTitle, "Título já preenchido");
  });

  it("slug ausente do titlesCache: linha fica sem editionTitle (fallback ativo do lado do renderer, sem lançar)", () => {
    const rows: HubSourceEntry[] = [
      {
        date: "2026-01-01",
        editionSlug: "slug-nao-no-cache",
        url: "https://diar.ia.br/p/slug-nao-no-cache",
        matchedHeadlines: ["Manchete"],
      },
    ];
    const filled = backfillEditionTitles(rows, {});
    assert.equal(filled[0].editionTitle, undefined);
  });
});

describe("computeHubSourcesDiff (#5203)", () => {
  it("classifica added/changed/removed/unchanged por editionSlug", () => {
    const oldRows: HubSourceEntry[] = [
      { date: "2026-01-01", editionSlug: "a", url: "https://diar.ia.br/p/a", matchedHeadlines: ["A"] },
      { date: "2026-01-02", editionSlug: "b", url: "https://diar.ia.br/p/b", matchedHeadlines: ["B"] },
      { date: "2026-01-03", editionSlug: "c", url: "https://diar.ia.br/p/c", matchedHeadlines: ["C"] },
    ];
    const newRows: HubSourceEntry[] = [
      { date: "2026-01-01", editionSlug: "a", url: "https://diar.ia.br/p/a", matchedHeadlines: ["A"] }, // unchanged
      { date: "2026-01-02", editionSlug: "b", url: "https://diar.ia.br/p/b", matchedHeadlines: ["B", "B2"] }, // changed
      // "c" ausente -> removed
      { date: "2026-01-04", editionSlug: "d", url: "https://diar.ia.br/p/d", matchedHeadlines: ["D"] }, // added
    ];
    const diff = computeHubSourcesDiff(oldRows, newRows);
    assert.deepEqual(diff.added, ["d"]);
    assert.deepEqual(diff.changed, ["b"]);
    assert.deepEqual(diff.removed, ["c"]);
    assert.equal(diff.unchanged, 1);
  });
});

describe("writeGeneratedHubSources (#5203) — regressão: --dry-run não escreve", () => {
  let tmpDir: string;
  let outPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "generate-hub-sources-"));
    outPath = join(tmpDir, "brasil-regulacao-sources.generated.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const preservedRow: HubSourceEntry = {
    date: "2026-07-03",
    editionSlug: "governo-dos-eua-pode-virar-socio-da-openai",
    url: "https://diar.ia.br/p/governo-dos-eua-pode-virar-socio-da-openai",
    matchedHeadlines: ["Gestão lança Matriz de Competências em Inteligência Artificial"],
  };
  const freshRow: HubSourceEntry = {
    date: "2026-08-10",
    editionSlug: "edicao-nova",
    url: "https://diar.ia.br/p/edicao-nova",
    matchedHeadlines: ["Nova manchete"],
  };

  it("com --dry-run: arquivo em disco não muda (cenário exato da issue #5203 — 2 entradas a mão não somem)", () => {
    // Simula o estado commitado: entrada adicionada a mão (#5124), que uma
    // regeneração sem merge apagaria.
    writeGeneratedHubSources(outPath, [preservedRow], { dryRun: false });
    const before = readFileSync(outPath, "utf8");
    const mtimeBefore = statSync(outPath).mtimeMs;

    // Regeneração "fresca" (sem a entrada preservada) rodando em --dry-run
    // NUNCA deveria sobrescrever o arquivo.
    writeGeneratedHubSources(outPath, [freshRow], { dryRun: true });

    const after = readFileSync(outPath, "utf8");
    assert.equal(after, before, "conteúdo do arquivo mudou apesar de --dry-run");
    assert.equal(statSync(outPath).mtimeMs, mtimeBefore, "mtime mudou apesar de --dry-run");
    assert.match(after, /governo-dos-eua-pode-virar-socio-da-openai/);
  });

  it("sem --dry-run: arquivo é sobrescrito normalmente (comportamento pré-#5203 preservado)", () => {
    writeGeneratedHubSources(outPath, [preservedRow], { dryRun: false });
    writeGeneratedHubSources(outPath, [freshRow], { dryRun: false });

    const after = readFileSync(outPath, "utf8");
    assert.doesNotMatch(after, /governo-dos-eua-pode-virar-socio-da-openai/);
    assert.match(after, /edicao-nova/);
  });

  it("com --dry-run e arquivo ainda inexistente: não cria o arquivo", () => {
    writeGeneratedHubSources(outPath, [freshRow], { dryRun: true });
    assert.equal(existsSync(outPath), false);
  });
});
