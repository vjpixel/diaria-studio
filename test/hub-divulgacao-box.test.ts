/**
 * test/hub-divulgacao-box.test.ts (#5263)
 *
 * Cobre `scripts/lib/shared/hub-divulgacao-box.ts` (rotação + render, pure)
 * e `scripts/build-hub-divulgacao-box.ts` (resolução Node-side + asset
 * gerado). Ver docstring dos dois módulos pro estado do wiring — o box
 * ainda não está ligado a `boxes_divulgacao`/`stitchNewsletter`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  selectHubIndexForRotation,
  buildHubDivulgacaoBoxMarkdown,
  buildHubDivulgacaoBoxUrl,
} from "../scripts/lib/shared/hub-divulgacao-box.ts";
import { HUB_DIVULGACAO_BOX_UTM } from "../scripts/lib/shared/utm-registry.ts";
import { HUB_META } from "../workers/arquivo/src/hubs/meta.ts";
import {
  resolveHubDivulgacaoBoxSource,
  renderGeneratedSnippet,
} from "../scripts/build-hub-divulgacao-box.ts";

describe("selectHubIndexForRotation (#5263)", () => {
  it("é determinístico — a mesma edição sempre devolve o mesmo índice", () => {
    const a = selectHubIndexForRotation("260814", 6);
    const b = selectHubIndexForRotation("260814", 6);
    assert.equal(a, b);
  });

  it("índice sempre no intervalo [0, hubCount)", () => {
    for (let d = 0; d < 60; d++) {
      const date = new Date(Date.UTC(2026, 0, 1) + d * 86400000);
      const aammdd =
        String(date.getUTCFullYear() % 100).padStart(2, "0") +
        String(date.getUTCMonth() + 1).padStart(2, "0") +
        String(date.getUTCDate()).padStart(2, "0");
      const idx = selectHubIndexForRotation(aammdd, 6);
      assert.ok(idx >= 0 && idx < 6, `índice ${idx} fora de [0,6) pra ${aammdd}`);
    }
  });

  it("ao longo de uma janela de dias corridos suficiente, cobre TODOS os índices — nenhum hub estruturalmente excluído (issue #5263, achado do dia-da-semana mod 6)", () => {
    const seen = new Set<number>();
    for (let d = 0; d < 6; d++) {
      const date = new Date(Date.UTC(2026, 0, 1) + d * 86400000);
      const aammdd =
        String(date.getUTCFullYear() % 100).padStart(2, "0") +
        String(date.getUTCMonth() + 1).padStart(2, "0") +
        String(date.getUTCDate()).padStart(2, "0");
      seen.add(selectHubIndexForRotation(aammdd, 6));
    }
    assert.equal(seen.size, 6, `esperava os 6 índices em 6 dias corridos consecutivos, veio ${[...seen].sort()}`);
  });

  it("weekday mod 6 (a alternativa descartada) DEIXARIA o índice 5 inalcançável em qualquer segunda-sexta — documenta por que dias corridos foi escolhido", () => {
    const weekdayModIndexes = new Set<number>();
    for (let isoWeekday = 1; isoWeekday <= 5; isoWeekday++) {
      weekdayModIndexes.add((isoWeekday - 1) % 6);
    }
    assert.ok(!weekdayModIndexes.has(5), "sanity do racional documentado no módulo");
  });

  it("rejeita hubCount <= 0 ou não-inteiro", () => {
    assert.throws(() => selectHubIndexForRotation("260814", 0));
    assert.throws(() => selectHubIndexForRotation("260814", -1));
    assert.throws(() => selectHubIndexForRotation("260814", 1.5));
  });

  it("rejeita AAMMDD malformado", () => {
    assert.throws(() => selectHubIndexForRotation("2026-08-14", 6));
    assert.throws(() => selectHubIndexForRotation("", 6));
  });
});

describe("buildHubDivulgacaoBoxUrl / buildHubDivulgacaoBoxMarkdown (#5263)", () => {
  it("URL usa HUB_DIVULGACAO_BOX_UTM + campaign = slug", () => {
    const url = buildHubDivulgacaoBoxUrl("anthropic-claude");
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/temas/anthropic-claude");
    assert.equal(parsed.searchParams.get("utm_source"), HUB_DIVULGACAO_BOX_UTM.source);
    assert.equal(parsed.searchParams.get("utm_medium"), HUB_DIVULGACAO_BOX_UTM.medium);
    assert.equal(parsed.searchParams.get("utm_campaign"), "anthropic-claude");
  });

  it("markdown segue o formato bold-line/mid-callout — 1 bloco **...**, 1 link, texto da issue #5263", () => {
    const md = buildHubDivulgacaoBoxMarkdown({
      slug: "anthropic-claude",
      label: "Anthropic e Claude",
      since: "agosto de 2025",
      totalEditions: 78,
    });
    assert.match(md, /^\*\*.*\*\*$/);
    assert.match(md, /A cobertura completa de Anthropic e Claude desde agosto de 2025: 78 edições, cronologia e fontes/);
    assert.match(md, /\[arquivo\.diar\.ia\.br\/temas\/anthropic-claude\]\(https:\/\/arquivo\.diar\.ia\.br\/temas\/anthropic-claude\?/);
  });
});

describe("resolveHubDivulgacaoBoxSource (#5263) — Node-side, dados reais de HUB_LOADERS", () => {
  it("slug/label resolvidos batem com a entrada de HUB_META no índice esperado", () => {
    const source = resolveHubDivulgacaoBoxSource("260814");
    const expectedMeta = HUB_META[selectHubIndexForRotation("260814", HUB_META.length)];
    assert.equal(source.slug, expectedMeta.slug);
    assert.equal(source.label, expectedMeta.label);
    assert.ok(source.totalEditions > 0);
    assert.ok(source.since.length > 0);
  });

  it("todo hub de HUB_META é alcançável (nenhum lança ao ser resolvido)", () => {
    // Varre datas até ver os 6 slugs pelo menos 1x — se algum hub travar o
    // build (dataset vazio, etc.) este teste pega antes de virar um bug
    // só descoberto quando a rotação chegar naquele dia em produção.
    const seenSlugs = new Set<string>();
    for (let d = 0; d < 30 && seenSlugs.size < HUB_META.length; d++) {
      const date = new Date(Date.UTC(2026, 0, 1) + d * 86400000);
      const aammdd =
        String(date.getUTCFullYear() % 100).padStart(2, "0") +
        String(date.getUTCMonth() + 1).padStart(2, "0") +
        String(date.getUTCDate()).padStart(2, "0");
      seenSlugs.add(resolveHubDivulgacaoBoxSource(aammdd).slug);
    }
    assert.equal(seenSlugs.size, HUB_META.length, `esperava ver os ${HUB_META.length} slugs, veio ${[...seenSlugs]}`);
  });
});

// #5227: o asset GERADO passou a ser escrito em `data/snippets/` (gitignored,
// junction OneDrive) em vez de `context/snippets/` (git-tracked) — não é mais
// commitado, então não existe garantidamente num clone fresco/CI/worktree
// isolado (o script só o gera quando rodado, `npx tsx
// scripts/build-hub-divulgacao-box.ts --edition AAMMDD`). Os 2 testes que
// liam o arquivo do disco viram fixture sintética: exercitam o MESMO caminho
// de geração (`resolveHubDivulgacaoBoxSource` + `buildHubDivulgacaoBoxMarkdown`
// + `renderGeneratedSnippet`, os 3 já usados por `main()` em
// build-hub-divulgacao-box.ts) e verificam a FORMA do output em memória, sem
// depender do arquivo já ter sido escrito em disco.
describe("asset gerado — data/snippets/hub-divulgacao-rotativo.md (#5263, path migrado #5227)", () => {
  it("carrega o header GERADO/NÃO EDITAR + 1 bloco bold-line", () => {
    const source = resolveHubDivulgacaoBoxSource("260814");
    const markdown = buildHubDivulgacaoBoxMarkdown(source);
    const content = renderGeneratedSnippet("260814", markdown);
    assert.match(content, /GERADO, NÃO EDITAR À MÃO/);
    assert.match(content, /\*\*A cobertura completa de .+ → \[arquivo\.diar\.ia\.br\/temas\/.+\]\(.+\)\*\*/);
  });

  it("renderGeneratedSnippet é determinístico — mesmo input, mesmo output byte-a-byte", () => {
    const md = "**teste**";
    assert.equal(renderGeneratedSnippet("260814", md), renderGeneratedSnippet("260814", md));
  });
});
