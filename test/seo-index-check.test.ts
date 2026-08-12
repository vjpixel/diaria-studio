/**
 * test/seo-index-check.test.ts (#4105)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GSC_DEFAULT_SITE } from "../scripts/lib/gsc.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";
import {
  parseInspection,
  summarize,
  filterPosts,
  mapLimit,
  renderMd,
  parseIntFlag,
  resolveExitCode,
  defaultJsonOutPath,
  resolveMdPath,
  isSitemapReferrer,
  applyLimit,
  resolveCollisionSafeJsonPath,
  extractSnapshotFamily,
  findPreviousSnapshotPath,
  computeRegressions,
  type IndexStatus,
} from "../scripts/seo-index-check.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Resposta real da API (recortada) pra uma URL indexada. */
const INDEXED = {
  inspectionResult: {
    indexStatusResult: {
      verdict: "PASS",
      coverageState: "Enviada e indexada",
      robotsTxtState: "ALLOWED",
      indexingState: "INDEXING_ALLOWED",
      lastCrawlTime: "2026-07-26T03:40:18Z",
      googleCanonical: "https://diar.ia.br/",
      referringUrls: ["https://diar.ia.br/archive"],
    },
  },
};

/** Caso real de 260727: post detectado via sitemap, nunca rastreado, sem referrer. */
const DISCOVERED = {
  inspectionResult: {
    indexStatusResult: {
      verdict: "NEUTRAL",
      coverageState: "Detectada, mas não indexada no momento",
      referringUrls: [],
    },
  },
};

describe("parseInspection (#4105)", () => {
  it("achata a resposta da URL Inspection API", () => {
    const s = parseInspection("https://diar.ia.br/", INDEXED);
    assert.equal(s.verdict, "PASS");
    assert.equal(s.coverageState, "Enviada e indexada");
    assert.equal(s.lastCrawlTime, "2026-07-26T03:40:18Z");
    assert.deepEqual(s.referringUrls, ["https://diar.ia.br/archive"]);
    assert.equal(s.error, undefined);
  });

  it("resposta sem indexStatusResult vira error, não status falso-negativo", () => {
    const s = parseInspection("https://diar.ia.br/x", {});
    assert.equal(s.error, "resposta sem indexStatusResult");
    assert.equal(s.verdict, undefined);
  });

  it("referringUrls ausente → array vazio (órfã), nunca undefined", () => {
    const s = parseInspection("https://diar.ia.br/x", {
      inspectionResult: { indexStatusResult: { verdict: "NEUTRAL" } },
    });
    assert.deepEqual(s.referringUrls, []);
  });
});

describe("summarize (#4105)", () => {
  it("conta indexadas por verdict PASS, não pelo texto localizado de coverageState", () => {
    // Regressão do #573: coverageState é pt-BR na conta do editor e muda de
    // idioma/redação; comparar por string daria contagem errada.
    const rows: IndexStatus[] = [
      { url: "a", verdict: "PASS", coverageState: "Submitted and indexed", referringUrls: ["x"] },
      { url: "b", verdict: "PASS", coverageState: "Enviada e indexada", referringUrls: ["x"] },
      { url: "c", verdict: "NEUTRAL", coverageState: "Detectada, mas não indexada no momento", referringUrls: [] },
    ];
    const s = summarize(rows);
    assert.equal(s.indexed, 2);
    assert.equal(s.not_indexed, 1);
    assert.equal(s.coverage_pct, 66.7);
  });

  it("erros não contam como não-indexadas (não poluem o denominador)", () => {
    const rows: IndexStatus[] = [
      { url: "a", verdict: "PASS", referringUrls: ["x"] },
      { url: "b", error: "429 — quota estourada" },
    ];
    const s = summarize(rows);
    assert.equal(s.errors, 1);
    assert.equal(s.total, 2);
    assert.equal(s.indexed, 1);
    assert.equal(s.not_indexed, 0);
    assert.equal(s.coverage_pct, 100); // 1/1 avaliada, não 1/2
  });

  it("conta órfãs (sem página de referência) — o achado estrutural de 260727", () => {
    const rows = [
      parseInspection("https://diar.ia.br/p/x", DISCOVERED),
      parseInspection("https://diar.ia.br/", INDEXED),
    ];
    const s = summarize(rows);
    assert.equal(s.orphan_count, 1);
    assert.equal(s.by_coverage_state["Detectada, mas não indexada no momento"], 1);
  });

  it("#5118 item 2: orphan_count (0 referrer) != no_html_referrer_count (referrer só sitemap)", () => {
    // Regressão do achado do #5118: a URL Inspection API lista o sitemap
    // dentro de referringUrls — contá-lo como referente subcontava orfandade
    // em 2,4x (62 vs 147/233 no snapshot real de 10/08, reproduzido aqui em
    // miniatura: 1 zero-referrer + 1 sitemap-only + 1 com link HTML real).
    const rows: IndexStatus[] = [
      { url: "a", verdict: "NEUTRAL", referringUrls: [] },
      { url: "b", verdict: "NEUTRAL", referringUrls: ["https://diar.ia.br/sitemap.xml"] },
      { url: "c", verdict: "PASS", referringUrls: ["https://diar.ia.br/archive"] },
    ];
    const s = summarize(rows);
    assert.equal(s.orphan_count, 1, "só 'a' tem zero referrer");
    assert.equal(s.no_html_referrer_count, 2, "'a' e 'b' não têm nenhum referrer HTML");
  });

  it("isSitemapReferrer reconhece sitemap.xml e variantes com sufixo, não confunde com /p/sitemap-do-mercado", () => {
    assert.ok(isSitemapReferrer("https://diar.ia.br/sitemap.xml"));
    assert.ok(isSitemapReferrer("https://arquivo.diar.ia.br/sitemap.xml"));
    assert.ok(isSitemapReferrer("https://diar.ia.br/sitemap-posts.xml?v=2"));
    assert.ok(!isSitemapReferrer("https://diar.ia.br/archive"));
    assert.ok(!isSitemapReferrer("https://diar.ia.br/p/sitemap-do-mercado-de-ia"));
  });

  it("lista vazia não divide por zero", () => {
    const s = summarize([]);
    assert.equal(s.coverage_pct, 0);
    assert.equal(s.total, 0);
  });

  it("todas com erro → coverage 0 sem NaN", () => {
    const s = summarize([{ url: "a", error: "boom" }]);
    assert.equal(s.coverage_pct, 0);
    assert.equal(s.errors, 1);
  });
});

describe("filterPosts (#4105)", () => {
  it("mantém só URLs de edição", () => {
    const kept = filterPosts([
      "https://diar.ia.br/",
      "https://diar.ia.br/archive",
      "https://diar.ia.br/p/brasil-investe-em-ia",
      "https://diar.ia.br/forms/abc",
    ]);
    assert.deepEqual(kept, ["https://diar.ia.br/p/brasil-investe-em-ia"]);
  });
});

describe("applyLimit (#5118 item 1 — bomba de truncamento)", () => {
  // Sitemap real é newest-first (confirmado no #5118 medindo 233 rows contra
  // publish_date). "a" = mais nova, "d" = mais antiga.
  const NEWEST_FIRST = ["a-newest", "b", "c", "d-oldest"];

  it("sem corte necessário: mantém tudo, dropped = 0", () => {
    const { kept, dropped } = applyLimit(NEWEST_FIRST, 10);
    assert.deepEqual(kept, NEWEST_FIRST);
    assert.equal(dropped, 0);
  });

  it("com corte: descarta as MAIS NOVAS (início do array), preserva as mais antigas", () => {
    // Regressão do achado central do #5118: o comportamento antigo
    // (`slice(0, limit)`) descartava as mais ANTIGAS — a coorte de pior
    // indexação, exatamente o que a medição existe pra capturar.
    const { kept, dropped } = applyLimit(NEWEST_FIRST, 2);
    assert.deepEqual(kept, ["c", "d-oldest"]);
    assert.equal(dropped, 2);
  });

  it("--limit 0 é pedido explícito de não inspecionar nada: kept vazio", () => {
    const { kept, dropped } = applyLimit(NEWEST_FIRST, 0);
    assert.deepEqual(kept, []);
    assert.equal(dropped, 4);
  });

  it("limit negativo se comporta como 0 (nunca lança, nunca retorna array negativo)", () => {
    const { kept } = applyLimit(NEWEST_FIRST, -5);
    assert.deepEqual(kept, []);
  });
});

describe("resolveCollisionSafeJsonPath (#5118 item 3b)", () => {
  const NOW = Date.parse("2026-08-16T07:10:00Z");

  it("path ainda não existe em disco: mantém o nome limpo (1ª rodada do dia)", () => {
    const p = resolveCollisionSafeJsonPath("/repo/data/seo/index-status-2026-08-16.json", NOW, () => false);
    assert.equal(p, "/repo/data/seo/index-status-2026-08-16.json");
  });

  it("path já existe (2ª rodada do mesmo dia): sufixa por HHMM (UTC), não sobrescreve", () => {
    const p = resolveCollisionSafeJsonPath("/repo/data/seo/index-status-2026-08-16.json", NOW, () => true);
    assert.equal(p, "/repo/data/seo/index-status-2026-08-16-0710.json");
  });

  it("path sem extensão .json: sufixa mesmo assim, sem lançar", () => {
    const p = resolveCollisionSafeJsonPath("/repo/data/seo/relatorio-sem-extensao", NOW, () => true);
    assert.equal(p, "/repo/data/seo/relatorio-sem-extensao-0710");
  });
});

describe("extractSnapshotFamily + findPreviousSnapshotPath (#5118 item 3a)", () => {
  it("extrai o prefixo antes da data, sem suffix", () => {
    assert.equal(extractSnapshotFamily("/repo/data/seo/index-status-2026-08-10.json"), "index-status");
  });

  it("extrai o prefixo antes da data, com --out-suffix", () => {
    assert.equal(extractSnapshotFamily("/repo/data/seo/index-status-arquivo-2026-08-10.json"), "index-status-arquivo");
  });

  it("reconhece também o sufixo -HHMM de colisão (item 3b)", () => {
    assert.equal(extractSnapshotFamily("/repo/data/seo/index-status-2026-08-10-0710.json"), "index-status");
  });

  it("path fora da convenção (--out arbitrário): null, não lança", () => {
    assert.equal(extractSnapshotFamily("/tmp/relatorio-custom.json"), null);
  });

  it("acha o snapshot anterior mais recente da MESMA família, ignora outras famílias e o path atual", () => {
    const listing = [
      "index-status-2026-08-03.json",
      "index-status-2026-08-05.json",
      "index-status-2026-08-10.json",
      "index-status-arquivo-2026-08-10.json", // família diferente — não deve entrar
      "index-status-2026-08-16.json", // é o path ATUAL — excluído mesmo existindo
    ];
    const prev = findPreviousSnapshotPath(
      "/repo/data/seo",
      "/repo/data/seo/index-status-2026-08-16.json",
      () => listing,
    );
    assert.equal(prev, "/repo/data/seo/index-status-2026-08-10.json");
  });

  it("nenhum snapshot anterior da família: null", () => {
    const prev = findPreviousSnapshotPath("/repo/data/seo", "/repo/data/seo/index-status-2026-08-16.json", () => []);
    assert.equal(prev, null);
  });

  it("path atual fora da convenção: null sem sequer listar o diretório", () => {
    let called = false;
    const prev = findPreviousSnapshotPath("/repo/data/seo", "/tmp/custom.json", () => {
      called = true;
      return [];
    });
    assert.equal(prev, null);
    assert.equal(called, false);
  });
});

describe("computeRegressions (#5118 item 3a — regressão de indexação invisível)", () => {
  it("URL que TINHA indexação (PASS) e perdeu vira regressão", () => {
    // Cenário real do #5118: 5 URLs passaram de "Enviada e indexada" pra
    // "Rastreada, mas não indexada no momento" entre 05 e 10/08 sem alarmar.
    const previous: IndexStatus[] = [
      { url: "https://diar.ia.br/p/x", verdict: "PASS", coverageState: "Enviada e indexada" },
    ];
    const current: IndexStatus[] = [
      {
        url: "https://diar.ia.br/p/x",
        verdict: "NEUTRAL",
        coverageState: "Rastreada, mas não indexada no momento",
      },
    ];
    const regs = computeRegressions(current, previous);
    assert.equal(regs.length, 1);
    assert.equal(regs[0].url, "https://diar.ia.br/p/x");
    assert.equal(regs[0].from, "Enviada e indexada");
    assert.equal(regs[0].to, "Rastreada, mas não indexada no momento");
  });

  it("URL que já não estava indexada não conta como regressão (não é 'mudou de estado', é 'perdeu indexação')", () => {
    const previous: IndexStatus[] = [
      { url: "a", verdict: "NEUTRAL", coverageState: "Detectada, mas não indexada no momento" },
    ];
    const current: IndexStatus[] = [{ url: "a", verdict: "NEUTRAL", coverageState: "Rastreada, mas não indexada no momento" }];
    assert.deepEqual(computeRegressions(current, previous), []);
  });

  it("URL que continua indexada não conta", () => {
    const previous: IndexStatus[] = [{ url: "a", verdict: "PASS" }];
    const current: IndexStatus[] = [{ url: "a", verdict: "PASS" }];
    assert.deepEqual(computeRegressions(current, previous), []);
  });

  it("URL nova (sem par na rodada anterior) não conta — não há indexação prévia pra perder", () => {
    const current: IndexStatus[] = [{ url: "a", verdict: "NEUTRAL" }];
    assert.deepEqual(computeRegressions(current, []), []);
  });

  it("regressão pra erro de API usa 'erro: ...' como 'to', não string vazia", () => {
    const previous: IndexStatus[] = [{ url: "a", verdict: "PASS", coverageState: "Enviada e indexada" }];
    const current: IndexStatus[] = [{ url: "a", error: "429 — quota estourada" }];
    const regs = computeRegressions(current, previous);
    assert.equal(regs.length, 1);
    assert.equal(regs[0].to, "erro: 429 — quota estourada");
  });
});

describe("mapLimit (#4105)", () => {
  it("preserva a ordem da entrada mesmo com durações diferentes", async () => {
    const out = await mapLimit([30, 1, 15], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    assert.deepEqual(out, ["0:30", "1:1", "2:15"]);
  });

  it("respeita o teto de concorrência (nunca mais que N em voo)", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return null;
    });
    assert.ok(peak <= 3, `pico ${peak} > 3`);
  });

  it("lista vazia não trava", async () => {
    assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  });
});

describe("renderMd (#4105)", () => {
  it("marca órfãs e mostra a taxa de cobertura", () => {
    const rows = [parseInspection("https://diar.ia.br/p/x", DISCOVERED)];
    const md = renderMd(rows, summarize(rows), GSC_DEFAULT_SITE, "2026-07-27");
    assert.match(md, /0\/1 indexadas \(0%\)/);
    assert.match(md, /órfã \(sem link interno\)/);
    assert.match(md, /sc-domain:diar\.ia\.br/);
  });

  it("#5118 item 1b: sem truncamento (dropped=0), não imprime a seção 'Truncado'", () => {
    const rows = [parseInspection("https://diar.ia.br/p/x", DISCOVERED)];
    const md = renderMd(rows, summarize(rows), GSC_DEFAULT_SITE, "2026-07-27", { dropped: 0, limit: 2000 });
    assert.ok(!md.includes("Truncado"));
  });

  it("#5118 item 1b: com truncamento, grava dropped/limit no .md pra série futura não confundir composição com melhora", () => {
    const rows = [parseInspection("https://diar.ia.br/p/x", DISCOVERED)];
    const md = renderMd(rows, summarize(rows), GSC_DEFAULT_SITE, "2026-07-27", { dropped: 17, limit: 250 });
    assert.match(md, /Truncado/);
    assert.match(md, /17 URL\(s\)/);
    assert.match(md, /--limit 250/);
  });

  it("#5118 item 3a: sem regressões, não imprime a seção", () => {
    const rows = [parseInspection("https://diar.ia.br/", INDEXED)];
    const md = renderMd(rows, summarize(rows), GSC_DEFAULT_SITE, "2026-08-10", undefined, []);
    assert.ok(!md.includes("Regressões"));
  });

  it("#5118 item 3a: com regressões, lista URL + from → to", () => {
    const rows = [parseInspection("https://diar.ia.br/", INDEXED)];
    const md = renderMd(rows, summarize(rows), GSC_DEFAULT_SITE, "2026-08-10", undefined, [
      { url: "https://diar.ia.br/p/x", from: "Enviada e indexada", to: "Rastreada, mas não indexada no momento" },
    ]);
    assert.match(md, /Regressões/);
    assert.match(md, /https:\/\/diar\.ia\.br\/p\/x — Enviada e indexada → Rastreada, mas não indexada no momento/);
  });
});

describe("constante única de propriedade GSC (#4108)", () => {
  // O literal duplicado é o modo de falha real: se a verificação no Search
  // Console mudar de forma e só um dos dois scripts for atualizado, o outro
  // passa a dar 403 em silêncio — e o que falha é justamente o que deveria
  // avisar que a medição parou. Nasceu de duas PRs paralelas (#4099/#4106).
  for (const rel of ["scripts/seo-pull.ts", "scripts/seo-index-check.ts"]) {
    it(`${rel} não re-inlina a propriedade como default`, () => {
      const src = readFileSync(resolve(ROOT, rel), "utf8");
      assert.ok(
        !/\?\?\s*"sc-domain:/.test(src),
        `${rel} voltou a hardcodar a propriedade — importar GSC_DEFAULT_SITE de scripts/lib/gsc.ts`,
      );
      assert.match(src, /from "\.\/lib\/gsc\.ts"/);
    });
  }
});

describe("GSC_DEFAULT_SITE (#4105, consolidado no #4108)", () => {
  it("é a domain property verificada — o host beehiiv dá 403 (siteUnverifiedUser)", () => {
    assert.equal(GSC_DEFAULT_SITE, "sc-domain:diar.ia.br");
  });
});

describe("resolveExitCode + parseIntFlag (code-review PR #4106)", () => {
  it("zero URLs inspecionadas reprova a rodada — a task semanal não pode ficar verde sem medir nada", () => {
    // Cenário: o sitemap muda de forma (slug deixa de ser /p/…) e --only-posts
    // zera o filtro. Antes, `errors === rows.length && rows.length > 0` era
    // false → exit 0, e a série temporal congelava silenciosamente.
    assert.equal(resolveExitCode([], 200), 1);
  });

  it("--limit 0 é pedido explícito de não inspecionar nada → sucesso", () => {
    assert.equal(resolveExitCode([], 0), 0);
  });

  it("todas com erro reprova; ao menos uma medida aprova", () => {
    assert.equal(resolveExitCode([{ url: "a", error: "429" }], 200), 1);
    assert.equal(resolveExitCode([{ url: "a", error: "429" }, { url: "b", verdict: "PASS" }], 200), 0);
  });

  it("parseIntFlag preserva o 0 explícito (o `|| default` o engolia)", () => {
    assert.equal(parseIntFlag("0", 200), 0);
    assert.equal(parseIntFlag("50", 200), 50);
  });

  it("parseIntFlag cai no default em valor inválido ou negativo", () => {
    assert.equal(parseIntFlag("abc", 200), 200);
    assert.equal(parseIntFlag("-5", 200), 200);
    assert.equal(parseIntFlag(undefined, 200), 200);
  });
});

describe("defaultJsonOutPath + resolveMdPath (#4909 — .md não pode mais colidir entre rodadas do mesmo dia)", () => {
  it("defaultJsonOutPath sem suffix é o path histórico index-status-{data}.json", () => {
    assert.equal(
      defaultJsonOutPath("/repo/data/seo", "2026-08-10"),
      "/repo/data/seo/index-status-2026-08-10.json",
    );
  });

  it("defaultJsonOutPath com suffix insere -{suffix} antes da data (2ª fonte no mesmo dia)", () => {
    assert.equal(
      defaultJsonOutPath("/repo/data/seo", "2026-08-10", "arquivo"),
      "/repo/data/seo/index-status-arquivo-2026-08-10.json",
    );
  });

  it("resolveMdPath sem --out-md deriva do jsonPath trocando .json por .md", () => {
    assert.equal(
      resolveMdPath("/repo/data/seo/index-status-2026-08-10.json"),
      "/repo/data/seo/index-status-2026-08-10.md",
    );
  });

  it("resolveMdPath: --out-md explícito sempre vence", () => {
    assert.equal(
      resolveMdPath("/repo/data/seo/index-status-2026-08-10.json", "/tmp/relatorio-custom.md"),
      "/tmp/relatorio-custom.md",
    );
  });

  it("regressão do #4909: duas rodadas no mesmo dia com --out diferentes não colidem mais no .md", () => {
    // Antes do fix, o .md era SEMPRE index-status-{data}.md (path fixo) —
    // rodar o host principal e depois o host arquivo no mesmo dia com --out
    // diferentes ainda apagava o relatório .md da 1ª rodada.
    const jsonMain = defaultJsonOutPath("/repo/data/seo", "2026-08-10");
    const jsonArquivo = defaultJsonOutPath("/repo/data/seo", "2026-08-10", "arquivo");
    const mdMain = resolveMdPath(jsonMain);
    const mdArquivo = resolveMdPath(jsonArquivo);
    assert.notEqual(jsonMain, jsonArquivo);
    assert.notEqual(mdMain, mdArquivo);
  });

  it("jsonPath sem extensão .json (--out custom) ainda produz um .md distinto, sem lançar", () => {
    assert.equal(resolveMdPath("/repo/data/seo/relatorio-sem-extensao"), "/repo/data/seo/relatorio-sem-extensao.md");
  });
});

describe("Diaria-SEO-Weekly inclui /temas/ na checagem de indexação (#4909)", () => {
  it("tem um step 'index-arquivo' pro sitemap de arquivo.diar.ia.br", () => {
    const task = getScheduledTaskByName("Diaria-SEO-Weekly");
    assert.ok(task, "task Diaria-SEO-Weekly não encontrada no registro");
    const step = task!.steps.find((s) => s.key === "index-arquivo");
    assert.ok(step, "step 'index-arquivo' ausente — /temas/ ainda fora da checagem de indexação");
    assert.equal(step!.script, "scripts/seo-index-check.ts");
    assert.ok(step!.args?.includes("https://arquivo.diar.ia.br/sitemap.xml"));
    // --only-posts filtraria por /\/p\//, que zeraria TODAS as URLs de
    // /temas/{slug} (achado do #4909 — armadilha explícita).
    assert.ok(!step!.args?.includes("--only-posts"), "--only-posts zeraria /temas/* (filtro é /\\/p\\//)");
    // --out-suffix evita colidir com o index-status-{data}.json/.md do
    // step "index" (host principal) rodando no mesmo dia.
    assert.ok(step!.args?.includes("--out-suffix"));
  });

  it("o step 'index-arquivo' roda DEPOIS do 'index' do host principal (não substitui, adiciona)", () => {
    const task = getScheduledTaskByName("Diaria-SEO-Weekly");
    const keys = task!.steps.map((s) => s.key);
    assert.ok(keys.includes("index"), "step 'index' original (host principal) não pode sumir — #3527/#4106");
    assert.ok(keys.indexOf("index") < keys.indexOf("index-arquivo"));
  });
});

// Cobertura de agendamento semanal (#4105) — o describe original checava o
// `.ps1` de setup/runner (BOM, ambos scripts do loop, step de arquivo, guard
// Register-ScheduledTask). Removidos no #5115 (cutover final); os mesmos
// invariantes de conteúdo (ambos scripts chamados, step "index-arquivo" com
// os args corretos, ordem index -> index-arquivo) seguem cobertos acima em
// `describe("Diaria-SEO-Weekly inclui /temas/ na checagem de indexação (#4909)")`,
// direto contra o registro declarativo (`scripts/lib/scheduled-tasks.ts`),
// que é a fonte de verdade única desde o #4805.
