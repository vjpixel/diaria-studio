/**
 * test/publish-edition-site-page-sitemap-6454.test.ts (#6454)
 *
 * REGRESSÃO do defeito confirmado ao vivo em 04/09/2026 (comentário do
 * #6454): `publish-edition-site-page.ts` já aceitava `--sitemap <path>`,
 * mas a flag só STAGEAVA o arquivo pro commit — nenhum código escrevia
 * conteúdo nele. Resultado: `sitemap.xml` nunca mudava de verdade e
 * `workers/site/public/index.html` (a home) ficava congelado, mesmo com
 * `--sitemap` passado em toda chamada do Stage 6.
 *
 * Cobre o CENÁRIO REAL da issue, não só a aritmética adjacente:
 *
 *   "publicar uma edição nova faz a entrada dela aparecer no sitemap.xml
 *    E no feed (index.html) da home."
 *
 * Sem o fix (`updateSitemapAndHome` em `productionDeps`, chamado por
 * `publishEditionSitePage` antes do commit/push), o 1º teste abaixo
 * falharia: `sitemap.xml` continuaria vazio e `index.html` nunca seria
 * escrito.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishEditionSitePage,
  productionDeps,
  homePageRelPathFromSitemap,
  type PublishPageDeps,
} from "../scripts/publish-edition-site-page.ts";
import type { EditionPageInputs } from "../scripts/lib/edition-site-page.ts";
import { buildSitemapXml } from "../scripts/lib/site-archive-pages.ts";
import type { GitRunner, GhRunner, LockRunner, SleepFn } from "../scripts/publish-edition-site-page.ts";

const SITEMAP_REL = "workers/site/public/sitemap.xml";

function makeInputs(overrides: Partial<EditionPageInputs> = {}): EditionPageInputs {
  return {
    html: "<p>corpo da edição nova</p>",
    postUrl: "https://diar.ia.br/p/edicao-nova-do-dia",
    title: "Edição nova do dia",
    subtitle: "Subtítulo da edição nova",
    publishedAtIso: "2026-09-04T09:00:00Z",
    ...overrides,
  };
}

/** git/gh/lock fakes — nunca tocam subprocesso real; só confirmam que os
 * paths certos (página + sitemap + home) chegam staged no commit. */
function makeGitFakes(stagedPaths: string[][]) {
  const git: GitRunner = (args) => {
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "master\n";
    if (args[0] === "rev-parse") return "deadbeef\ndeadbeef\n";
    if (args[0] === "add") {
      stagedPaths.push(args.slice(2));
      return "";
    }
    if (args[0] === "status") return " M workers/site/public/p/edicao-nova-do-dia/index.html\n";
    if (args[0] === "diff") {
      return [
        "workers/site/public/p/edicao-nova-do-dia/index.html",
        SITEMAP_REL,
        homePageRelPathFromSitemap(SITEMAP_REL),
      ].join("\n");
    }
    return "";
  };
  const gh: GhRunner = (args) => {
    if (args.slice(0, 2).join(" ") === "pr list") return "[]";
    if (args.slice(0, 2).join(" ") === "pr create") return "https://github.com/vjpixel/diaria-studio/pull/1\n";
    return "";
  };
  const lock: LockRunner = () => ({ ok: true, stdout: "", stderr: "" });
  const sleep: SleepFn = () => {};
  return { git, gh, lock, sleep };
}

describe("#6454 publishEditionSitePage --sitemap — atualiza sitemap.xml e regenera a home de verdade", () => {
  it("CENÁRIO REAL: publicar uma edição nova faz sua entrada aparecer no sitemap E no feed da home", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-site-sitemap-6454-"));
    try {
      const sitemapAbsPath = join(dir, ...SITEMAP_REL.split("/"));
      const homeAbsPath = join(dir, ...homePageRelPathFromSitemap(SITEMAP_REL).split("/"));

      // Pré-condição: nem sitemap nem home existem ainda (acervo "congelado"
      // — mesmo estado inicial descrito no achado ao vivo do #6454).
      assert.equal(existsSync(sitemapAbsPath), false);
      assert.equal(existsSync(homeAbsPath), false);

      const stagedPaths: string[][] = [];
      const { git, gh, lock, sleep } = makeGitFakes(stagedPaths);
      const deps: PublishPageDeps = {
        ...productionDeps(dir, git, gh, lock, sleep),
        readEditionInputs: () => makeInputs(),
      };

      const result = publishEditionSitePage(dir, deps, { sitemap: SITEMAP_REL });
      assert.equal(result.code, 0, `esperava code 0, teve: ${JSON.stringify(result)}`);

      // 1. sitemap.xml agora existe e lista a edição nova.
      assert.equal(existsSync(sitemapAbsPath), true, "REGRESSÃO: sitemap.xml continua ausente");
      const sitemapXml = readFileSync(sitemapAbsPath, "utf8");
      assert.match(
        sitemapXml,
        /https:\/\/diar\.ia\.br\/p\/edicao-nova-do-dia/,
        "REGRESSÃO: entrada da edição nova não apareceu no sitemap.xml",
      );

      // 2. index.html (a home) foi regenerado e reflete a edição nova como
      //    destaque — o feed real que o leitor vê em https://diar.ia.br/.
      assert.equal(existsSync(homeAbsPath), true, "REGRESSÃO: index.html (home) nunca foi escrito");
      const homeHtml = readFileSync(homeAbsPath, "utf8");
      assert.match(
        homeHtml,
        /Edição nova do dia/,
        "REGRESSÃO: a home não reflete o título da edição recém-publicada",
      );
      assert.match(homeHtml, /\/p\/edicao-nova-do-dia/, "REGRESSÃO: a home não linka pra página da edição nova");

      // 3. sitemap.xml E home entraram no MESMO commit/push da página —
      //    nenhum dos dois pode ficar de fora do pathspec staged.
      const staged = stagedPaths.flat();
      assert.ok(staged.includes(SITEMAP_REL), "sitemap.xml não foi staged no commit");
      assert.ok(
        staged.includes(homePageRelPathFromSitemap(SITEMAP_REL)),
        "index.html (home) não foi staged no commit",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("idempotente: publicar a MESMA edição duas vezes não duplica a entrada no sitemap", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-site-sitemap-6454-idem-"));
    try {
      const { git, gh, lock, sleep } = makeGitFakes([]);
      const deps: PublishPageDeps = {
        ...productionDeps(dir, git, gh, lock, sleep),
        readEditionInputs: () => makeInputs(),
      };

      publishEditionSitePage(dir, deps, { sitemap: SITEMAP_REL });
      const sitemapAbsPath = join(dir, ...SITEMAP_REL.split("/"));
      const afterFirst = readFileSync(sitemapAbsPath, "utf8");
      const occurrencesFirst = afterFirst.split("edicao-nova-do-dia").length - 1;

      publishEditionSitePage(dir, deps, { sitemap: SITEMAP_REL });
      const afterSecond = readFileSync(sitemapAbsPath, "utf8");
      const occurrencesSecond = afterSecond.split("edicao-nova-do-dia").length - 1;

      assert.ok(occurrencesFirst > 0, "1ª publicação devia ter escrito a entrada");
      assert.equal(
        occurrencesSecond,
        occurrencesFirst,
        "REGRESSÃO: publicar a mesma edição 2x duplicou a entrada no sitemap",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uma edição PRÉ-EXISTENTE no sitemap não é perdida quando uma edição nova é adicionada", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-site-sitemap-6454-preserva-"));
    try {
      const sitemapAbsPath = join(dir, ...SITEMAP_REL.split("/"));
      mkdirSync(join(dir, "workers", "site", "public"), { recursive: true });
      writeFileSync(
        sitemapAbsPath,
        buildSitemapXml([{ loc: "https://diar.ia.br/p/edicao-antiga", lastmod: "2026-08-20" }]),
        "utf8",
      );
      // Página da edição antiga precisa existir pro buildHomeFeed conseguir
      // ler título/description dela (senão o feed pula a entrada — mesmo
      // comportamento de gen-home-page.ts).
      mkdirSync(join(dir, "workers", "site", "public", "p", "edicao-antiga"), { recursive: true });
      writeFileSync(
        join(dir, "workers", "site", "public", "p", "edicao-antiga", "index.html"),
        "<!doctype html><html><head><title>Edição antiga</title></head><body>oi</body></html>",
        "utf8",
      );

      const { git, gh, lock, sleep } = makeGitFakes([]);
      const deps: PublishPageDeps = {
        ...productionDeps(dir, git, gh, lock, sleep),
        readEditionInputs: () => makeInputs(),
      };

      publishEditionSitePage(dir, deps, { sitemap: SITEMAP_REL });

      const sitemapXml = readFileSync(sitemapAbsPath, "utf8");
      assert.match(sitemapXml, /edicao-antiga/, "REGRESSÃO: entrada pré-existente foi perdida");
      assert.match(sitemapXml, /edicao-nova-do-dia/, "entrada nova precisa estar presente também");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#6454 homePageRelPathFromSitemap — deriva o path da home a partir do sitemap", () => {
  it("mesmo diretório do sitemap, index.html", () => {
    assert.equal(
      homePageRelPathFromSitemap("workers/site/public/sitemap.xml"),
      "workers/site/public/index.html",
    );
  });

  it("sitemap sem diretório (path relativo simples)", () => {
    assert.equal(homePageRelPathFromSitemap("sitemap.xml"), "index.html");
  });
});
