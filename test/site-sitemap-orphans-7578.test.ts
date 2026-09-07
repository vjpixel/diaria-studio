/**
 * test/site-sitemap-orphans-7578.test.ts (#7578)
 *
 * Regressão do bug que deixou o acervo público parado 12 dias.
 *
 * O sintoma foi "arquivo.diar.ia.br não mostra edições depois de 26/08", mas
 * a causa não estava no Worker `arquivo` — ele deriva o acervo do
 * `sitemap.xml` do apex em request-time e estava correto. O que quebrou foi o
 * elo anterior: **páginas gravadas em `workers/site/public/p/` sem entrada
 * correspondente no sitemap.** Elas respondiam 200 e mesmo assim eram
 * invisíveis no buscador e no arquivo ao mesmo tempo. Medido em 07/09/2026:
 * 259 páginas locais, 254 no sitemap, 5 órfãs — a mais antiga de 28/08.
 *
 * Invariantes travados aqui:
 *
 * 1. **Órfã é detectada.** Página com `index.html` e sem `<loc>` viola.
 * 2. **Slug PREFIXO de outro não vira falso negativo.** É a armadilha do
 *    #7280 (`addSitemapEntry` tinha exatamente este bug com `includes`): se a
 *    detecção casasse por substring, uma órfã cujo slug é prefixo de outra
 *    página já listada passaria despercebida — o mesmo silêncio que este
 *    módulo existe para acabar. Este é o teste que mais importa do arquivo.
 * 3. **Diretório sem `index.html` não conta como página.** Resto de execução
 *    interrompida não serve nada; declará-lo no sitemap criaria um 404
 *    anunciado ao crawler.
 * 4. **A ausência de `data/` não quebra nada.** `buildSlugDateMap` devolve
 *    mapa vazio em CI/clone fresco, e a entrada entra sem `<lastmod>`.
 * 5. **O invariante de Stage 6 BLOQUEIA (`severity: "error"`).** Era
 *    `warning`, e a docstring do próprio check já registrava que o silêncio
 *    tinha custado 4 edições — e voltou a custar 12 dias depois disso.
 *    Decisão do editor em 07/09/2026: travar o gate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSlugDateMap,
  findOrphanSlugs,
  listPageSlugs,
  slugsInSitemap,
} from "../scripts/lib/site-sitemap-orphans.ts";
import { STAGE_6_RULES, checkSiteSitemapNoOrphans } from "../scripts/lib/invariant-checks/stage-6.ts";
import { main as cliMain } from "../scripts/reconcile-site-sitemap.ts";
import {
  findPagesThatWouldBeDeleted,
  generateArchivePages,
  WouldDeleteUnknownPagesError,
} from "../scripts/gen-archive-pages.ts";

function sitemapWith(slugs: string[]): string {
  const urls = slugs
    .map((s) => `  <url>\n    <loc>https://diar.ia.br/p/${s}</loc>\n    <lastmod>2026-09-01</lastmod>\n  </url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function makePagesDir(slugs: string[], opts: { semIndex?: string[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "sitemap-orphans-"));
  for (const s of slugs) {
    mkdirSync(join(dir, s), { recursive: true });
    writeFileSync(join(dir, s, "index.html"), "<!doctype html><title>x</title>", "utf8");
  }
  for (const s of opts.semIndex ?? []) mkdirSync(join(dir, s), { recursive: true });
  return dir;
}

describe("#7578 — detecção de página órfã do sitemap", () => {
  it("acusa a página que existe em disco e não está no sitemap", () => {
    const dir = makePagesDir(["edicao-a", "edicao-b", "edicao-orfa"]);
    try {
      const orphans = findOrphanSlugs(listPageSlugs(dir), sitemapWith(["edicao-a", "edicao-b"]));
      assert.deepEqual(orphans, ["edicao-orfa"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("não reporta órfã quando o sitemap cobre tudo", () => {
    const dir = makePagesDir(["edicao-a", "edicao-b"]);
    try {
      assert.deepEqual(findOrphanSlugs(listPageSlugs(dir), sitemapWith(["edicao-a", "edicao-b"])), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REGRESSÃO #7280: slug que é PREFIXO de outro já listado ainda é órfã", () => {
    // `...-de-ia` é página DIFERENTE de `...-de-ia-ec15971b8c4f589e`. Uma
    // detecção por substring acharia a primeira "já presente" e a deixaria
    // fora do sitemap para sempre, sem erro nem log.
    const curta = "90-das-pessoas-nao-reconhecem-videos-de-ia";
    const longa = `${curta}-ec15971b8c4f589e`;
    const dir = makePagesDir([curta, longa]);
    try {
      const orphans = findOrphanSlugs(listPageSlugs(dir), sitemapWith([longa]));
      assert.deepEqual(orphans, [curta], "a página de slug mais curto precisa ser acusada como órfã");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("casa a URL exata, ignorando barra final e espaço em volta da tag", () => {
    const xml = `<?xml version="1.0"?>\n<urlset>\n  <url>\n    <loc> https://diar.ia.br/p/edicao-a/ </loc>\n  </url>\n</urlset>\n`;
    assert.ok(slugsInSitemap(xml).has("edicao-a"));
  });

  it("diretório sem index.html não conta como página", () => {
    const dir = makePagesDir(["edicao-a"], { semIndex: ["sobra-de-execucao-interrompida"] });
    try {
      assert.deepEqual(listPageSlugs(dir), ["edicao-a"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pagesDir inexistente devolve lista vazia em vez de lançar", () => {
    assert.deepEqual(listPageSlugs(join(tmpdir(), "nao-existe-7578")), []);
  });

  it("buildSlugDateMap devolve mapa vazio quando data/ não existe (CI, clone fresco)", () => {
    const ausente = join(tmpdir(), "nao-existe-7578");
    assert.equal(buildSlugDateMap(ausente, ausente).map.size, 0);
  });

  it("buildSlugDateMap mapeia a edição publicada pelo Kit via 05-edition-url.txt", () => {
    // Caminho que o cache Beehiiv NÃO cobre desde `backend = "kit"` (#7388) —
    // sem ele, toda edição de 04/09/2026 em diante entraria sem <lastmod>.
    const root = mkdtempSync(join(tmpdir(), "editions-7578-"));
    const internal = join(root, "2609", "260904", "_internal");
    mkdirSync(internal, { recursive: true });
    writeFileSync(join(internal, "05-edition-url.txt"), "https://diar.ia.br/p/nvidia-controla\n", "utf8");
    try {
      const { map } = buildSlugDateMap(join(tmpdir(), "nao-existe-7578"), root);
      assert.equal(map.get("nvidia-controla"), "2026-09-04");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#7578 — o invariante de Stage 6 bloqueia o gate", () => {
  const editionDir = mkdtempSync(join(tmpdir(), "stage6-7578-"));

  it("site-page-published é error, não warning, quando published != true", () => {
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeFileSync(
      join(editionDir, "_internal", "site-page-published.json"),
      JSON.stringify({ code: 3, slug: "x", published: false, reason: "checkout divergente" }),
      "utf8",
    );
    const rule = STAGE_6_RULES.find((r) => r.id === "site-page-published");
    assert.ok(rule, "regra site-page-published precisa existir");
    const violations = rule.run(editionDir);
    assert.equal(violations.length, 1);
    assert.equal(
      violations[0].severity,
      "error",
      "decisão do editor 07/09/2026 (#7578): falha de publicação do site trava o gate 6",
    );
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("a regra de órfã do sitemap está registrada no Stage 6 e é error", () => {
    const rule = STAGE_6_RULES.find((r) => r.id === "site-sitemap-no-orphans");
    assert.ok(rule, "regra site-sitemap-no-orphans precisa estar em STAGE_6_RULES");
    // O repo real precisa estar limpo; se houver órfã, a violação é error.
    for (const v of rule.run(mkdtempSync(join(tmpdir(), "vazio-7578-")))) {
      assert.equal(v.severity, "error");
    }
  });
});

/**
 * Achados do fleet de review da PR #7584 (07/09/2026). Os dois P1 diziam a
 * mesma coisa por caminhos diferentes: **o corretor não verificava o próprio
 * conserto, e o invariante novo não tinha teste que de fato executasse.** Os
 * dois reintroduziam, DENTRO da correção, a classe de falha silenciosa que a
 * correção existe para acabar.
 */
describe("#7578 — a CLI verifica o próprio conserto (achado P1 do review)", () => {
  it("--check devolve 2 quando há órfã e 0 quando não há", () => {
    const dir = makePagesDir(["a", "b"]);
    const smOk = join(dir, "ok.xml");
    const smFalta = join(dir, "falta.xml");
    writeFileSync(smOk, sitemapWith(["a", "b"]), "utf8");
    writeFileSync(smFalta, sitemapWith(["a"]), "utf8");
    try {
      assert.equal(cliMain(["--check", "--pages-dir", dir, "--sitemap", smOk]), 0);
      assert.equal(cliMain(["--check", "--pages-dir", dir, "--sitemap", smFalta]), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("modo escrita acrescenta a órfã e deixa o sitemap sem nenhuma", () => {
    const dir = makePagesDir(["a", "b"]);
    const sm = join(dir, "sitemap.xml");
    writeFileSync(sm, sitemapWith(["a"]), "utf8");
    try {
      assert.equal(cliMain(["--pages-dir", dir, "--sitemap", sm]), 0);
      const depois = readFileSync(sm, "utf8");
      assert.ok(depois.includes("/p/b"), "a órfã precisa ter entrado no sitemap");
      assert.deepEqual(findOrphanSlugs(listPageSlugs(dir), depois), []);
      // Idempotente: rodar de novo não duplica nem falha.
      assert.equal(cliMain(["--pages-dir", dir, "--sitemap", sm]), 0);
      assert.equal((readFileSync(sm, "utf8").match(/\/p\/b</g) ?? []).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REGRESSÃO P1: XML sem fechamento de urlset NÃO reporta sucesso", () => {
    // Sem esta guarda, `.replace("</urlset>", …)` devolvia a string intacta,
    // o script imprimia "1 entrada acrescentada" e saía 0 — mandando o editor
    // de volta ao gate achando que tinha corrigido.
    const dir = makePagesDir(["a", "b"]);
    const sm = join(dir, "quebrado.xml");
    writeFileSync(sm, '<?xml version="1.0"?>\n<urlset>\n  <url><loc>https://diar.ia.br/p/a</loc></url>\n', "utf8");
    try {
      assert.notEqual(cliMain(["--pages-dir", dir, "--sitemap", sm]), 0, "nunca pode sair 0 sem ter inserido");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sitemap ausente e diretório sem página nenhuma saem 1, não 0", () => {
    const dir = makePagesDir(["a"]);
    const vazio = mkdtempSync(join(tmpdir(), "vazio-cli-7578-"));
    const sm = join(dir, "sitemap.xml");
    writeFileSync(sm, sitemapWith(["a"]), "utf8");
    try {
      assert.equal(cliMain(["--pages-dir", dir, "--sitemap", join(dir, "nao-existe.xml")]), 1);
      assert.equal(cliMain(["--pages-dir", vazio, "--sitemap", sm]), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(vazio, { recursive: true, force: true });
    }
  });
});

describe("#7578 — o invariante de Stage 6 realmente executa (achado P1 do review)", () => {
  it("acusa error quando há órfã, com regra e issue corretas", () => {
    const dir = makePagesDir(["a", "orfa"]);
    const sm = join(dir, "sitemap.xml");
    writeFileSync(sm, sitemapWith(["a"]), "utf8");
    try {
      const v = checkSiteSitemapNoOrphans("qualquer-edicao", { pagesDir: dir, sitemapPath: sm });
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "site-sitemap-no-orphans");
      assert.equal(v[0].severity, "error");
      assert.equal(v[0].source_issue, "#7578");
      assert.match(v[0].message, /orfa/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REGRESSÃO: diretório de páginas VAZIO com sitemap cheio é perda de conteúdo, não zero órfãs", () => {
    // O pior caso possível — o acervo inteiro sumir do disco — passava como
    // verde, porque `findOrphanSlugs([], xml)` devolve `[]`.
    const vazio = mkdtempSync(join(tmpdir(), "apagado-7578-"));
    const sm = join(vazio, "sitemap.xml");
    writeFileSync(sm, sitemapWith(["a", "b", "c"]), "utf8");
    try {
      const v = checkSiteSitemapNoOrphans("qualquer-edicao", { pagesDir: vazio, sitemapPath: sm });
      assert.equal(v.length, 1, "sumiço do acervo inteiro não pode passar como verde");
      assert.equal(v[0].severity, "error");
      assert.match(v[0].message, /perda de conteúdo/);
    } finally {
      rmSync(vazio, { recursive: true, force: true });
    }
  });

  it("ausência do diretório inteiro continua não violando (checkout parcial)", () => {
    const ausente = join(tmpdir(), "nao-existe-7578");
    assert.deepEqual(checkSiteSitemapNoOrphans("x", { pagesDir: ausente, sitemapPath: ausente }), []);
  });
});

describe("#7578 — buildSlugDateMap reporta cache ilegível em vez de engolir", () => {
  it("arquivo corrompido entra em `corrupt` e não derruba o resto", () => {
    const posts = mkdtempSync(join(tmpdir(), "posts-7578-"));
    writeFileSync(join(posts, "bom.json"), JSON.stringify({ slug: "ok", publish_date: 1787937295 }), "utf8");
    writeFileSync(join(posts, "ruim.json"), "{ isto nao e json", "utf8");
    try {
      const { map, corrupt } = buildSlugDateMap(posts, join(tmpdir(), "nao-existe-7578"));
      assert.ok(map.has("ok"), "o arquivo bom precisa continuar sendo lido");
      assert.equal(corrupt.length, 1);
      assert.match(corrupt[0], /ruim\.json/);
    } finally {
      rmSync(posts, { recursive: true, force: true });
    }
  });

  it("cache Beehiiv tem precedência sobre a data editorial do AAMMDD", () => {
    const posts = mkdtempSync(join(tmpdir(), "posts-prec-7578-"));
    const eds = mkdtempSync(join(tmpdir(), "eds-prec-7578-"));
    // O cache diz uma data; o AAMMDD do diretório diz 2026-09-04. O cache vence.
    writeFileSync(join(posts, "p.json"), JSON.stringify({ slug: "dupla", publish_date: 1787937295 }), "utf8");
    const internal = join(eds, "2609", "260904", "_internal");
    mkdirSync(internal, { recursive: true });
    writeFileSync(join(internal, "05-edition-url.txt"), "https://diar.ia.br/p/dupla\n", "utf8");
    try {
      const { map } = buildSlugDateMap(posts, eds);
      assert.notEqual(map.get("dupla"), "2026-09-04", "a data editorial não pode sobrescrever a do cache");
    } finally {
      rmSync(posts, { recursive: true, force: true });
      rmSync(eds, { recursive: true, force: true });
    }
  });

  it("AAMMDD fora de faixa não vira lastmod inválido", () => {
    const eds = mkdtempSync(join(tmpdir(), "eds-inval-7578-"));
    const internal = join(eds, "2699", "269999", "_internal");
    mkdirSync(internal, { recursive: true });
    writeFileSync(join(internal, "05-edition-url.txt"), "https://diar.ia.br/p/impossivel\n", "utf8");
    try {
      const { map } = buildSlugDateMap(join(tmpdir(), "nao-existe-7578"), eds);
      assert.equal(map.get("impossivel"), undefined, "2099-99-99 nunca pode entrar no sitemap");
    } finally {
      rmSync(eds, { recursive: true, force: true });
    }
  });
});

describe("#7578 — gen-archive-pages não apaga página que não conhece", () => {
  it("REGRESSÃO P0: recusa (e não apaga) quando há página fora da sua fonte", () => {
    // `gen-archive-pages` faz rmSync do diretório inteiro e reescreve só o que
    // vem do cache Beehiiv. Com a diária publicando pelo Kit (#7388), rodá-lo
    // apagaria do DISCO toda edição nova — perda que nem o reconcile recupera,
    // porque ele só reconcilia o sitemap a partir de páginas existentes.
    const dir = makePagesDir(["do-cache", "publicada-pelo-kit"]);
    try {
      assert.deepEqual(findPagesThatWouldBeDeleted(dir, ["do-cache"]), ["publicada-pelo-kit"]);
      assert.throws(
        () => generateArchivePages([], dir, join(dir, "sitemap.xml")),
        WouldDeleteUnknownPagesError,
        "sem --allow-prune, precisa recusar em vez de apagar",
      );
      assert.ok(
        existsSync(join(dir, "publicada-pelo-kit", "index.html")),
        "a página não pode ter sido apagada pela tentativa recusada",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nada a apagar quando a fonte reproduz todas as páginas", () => {
    const dir = makePagesDir(["a", "b"]);
    try {
      assert.deepEqual(findPagesThatWouldBeDeleted(dir, ["a", "b"]), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `--keep-unknown` (#7576) — a terceira saída entre apagar e desistir.
 *
 * Com dois backends escrevendo em `public/p/`, propagar uma mudança de template
 * ao acervo inteiro exigia escolher entre `rmSync` (apaga o que veio do Kit) e
 * a recusa do #7578 (não roda). Este modo reescreve o que o gerador conhece e
 * não toca no resto.
 */
describe("#7576 — gen-archive-pages --keep-unknown regenera sem apagar", () => {
  it("não apaga a página desconhecida, e não precisa de --allow-prune", () => {
    const dir = makePagesDir(["do-cache", "publicada-pelo-kit"]);
    try {
      assert.doesNotThrow(() =>
        generateArchivePages([], dir, join(dir, "sitemap.xml"), { unknownPages: "keep" }),
      );
      assert.ok(
        existsSync(join(dir, "publicada-pelo-kit", "index.html")),
        "a página fora da fonte do gerador precisa sobreviver intacta",
      );
      assert.ok(existsSync(join(dir, "do-cache", "index.html")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o sitemap resultante só conhece a fonte do gerador — reconcile depois continua obrigatório", () => {
    const dir = makePagesDir(["publicada-pelo-kit"]);
    const sm = join(dir, "sitemap.xml");
    try {
      generateArchivePages([], dir, sm, { unknownPages: "keep" });
      assert.deepEqual(
        findOrphanSlugs(listPageSlugs(dir), readFileSync(sm, "utf8")),
        ["publicada-pelo-kit"],
        "é justamente por isso que reconcile-site-sitemap roda logo depois",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
