/**
 * test/check-seed-html-sync.test.ts (#3105)
 *
 * Cobre a lógica pura do guard CI #3105 (findDriftedPairs). Não testa main()
 * (depende de `git diff` externo — testado via integração no GH Action real,
 * mesmo padrão de test/check-pr-bugfix.test.ts).
 *
 * Regressão: commit 00dcb5a1 (#2451) atualizou seed/courses/cursos-ia.json
 * com 2 cursos novos e o HTML committed correspondente, mas o Worker nunca
 * foi re-deployado (#3105) — a página ao vivo ficou defasada por semanas.
 * Este check ataca o sintoma de PR (seed muda sem o HTML acompanhar no
 * mesmo PR), que é o sinal mais barato e cedo de "builder não rodou".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findDriftedPairs,
  getChangedFiles,
  renderHomePageAtRef,
  confirmHomeDrift,
  filterConfirmedDrift,
  SEED_HTML_PAIRS,
  type SeedHtmlPair,
  type SpawnFn,
} from "../scripts/check-seed-html-sync.ts";
import { buildHomeFeed, buildIndexHtml } from "../scripts/lib/site-home-page.ts";

const CURSOS_PAIR = SEED_HTML_PAIRS.find((p) => p.name === "cursos") as SeedHtmlPair;
const LIVROS_PAIR = SEED_HTML_PAIRS.find((p) => p.name === "livros") as SeedHtmlPair;
const HOME_PAIR = SEED_HTML_PAIRS.find((p) => p.name === "home-do-site") as SeedHtmlPair;

function mockSpawn(stdout: string): SpawnFn {
  return () => ({ status: 0, stdout, stderr: "" });
}

/**
 * Mocka `git show {ref}:{path}` — só responde pro `ref` esperado; qualquer
 * outro ref, ou path ausente de `files`, simula o `status != 0` real do git
 * pra revisão/arquivo inexistente (mesmo padrão de `readFileAtRef`).
 */
function mockGitShow(expectedRef: string, files: Record<string, string>): SpawnFn {
  return (cmd, args) => {
    if (cmd !== "git" || args[0] !== "show") {
      throw new Error(`mockGitShow: chamada inesperada — ${cmd} ${args.join(" ")}`);
    }
    const spec = args[1] ?? "";
    const sep = spec.indexOf(":");
    const ref = spec.slice(0, sep);
    const path = spec.slice(sep + 1);
    if (ref !== expectedRef || !(path in files)) {
      return { status: 128, stdout: "", stderr: `fatal: path '${path}' does not exist in '${ref}'` };
    }
    return { status: 0, stdout: files[path] as string, stderr: "" };
  };
}

function fakePageHtml(title: string, description: string): string {
  return `<!DOCTYPE html><html><head><title>${title}</title><meta name="description" content="${description}"></head><body></body></html>`;
}

describe("findDriftedPairs (#3105)", () => {
  it("seed de cursos mudou junto com o HTML — sem drift", () => {
    const changed = ["seed/courses/cursos-ia.json", "workers/cursos/public/index.html"];
    assert.deepEqual(findDriftedPairs(changed), []);
  });

  it("seed de cursos mudou SEM o HTML — drift detectado (repro #3105)", () => {
    const changed = ["seed/courses/cursos-ia.json"];
    const drifted = findDriftedPairs(changed);
    assert.equal(drifted.length, 1);
    assert.equal(drifted[0]?.name, "cursos");
  });

  it("seed de livros mudou SEM o HTML — drift detectado", () => {
    const changed = ["seed/books/livros-ia.json", "README.md"];
    const drifted = findDriftedPairs(changed);
    assert.equal(drifted.length, 1);
    assert.equal(drifted[0]?.name, "livros");
  });

  it("#6454: sitemap.xml do site mudou SEM index.html (home) — drift detectado", () => {
    const changed = ["workers/site/public/sitemap.xml"];
    const drifted = findDriftedPairs(changed);
    assert.equal(drifted.length, 1);
    assert.equal(drifted[0]?.name, "home-do-site");
  });

  it("#6454: sitemap.xml e index.html mudaram juntos — sem drift", () => {
    const changed = ["workers/site/public/sitemap.xml", "workers/site/public/index.html"];
    assert.deepEqual(findDriftedPairs(changed), []);
  });

  it("nenhum seed mudou — sem drift mesmo se o HTML mudar sozinho", () => {
    const changed = ["workers/cursos/public/index.html", "scripts/build-cursos-page.ts"];
    assert.deepEqual(findDriftedPairs(changed), []);
  });

  it("PR não toca nem seed nem HTML — sem drift", () => {
    const changed = ["README.md", "scripts/other-thing.ts"];
    assert.deepEqual(findDriftedPairs(changed), []);
  });

  it("ambos os seeds mudam sem seus HTMLs — 2 pares driftados", () => {
    const changed = ["seed/courses/cursos-ia.json", "seed/books/livros-ia.json"];
    const drifted = findDriftedPairs(changed);
    assert.equal(drifted.length, 2);
    assert.deepEqual(
      drifted.map((p) => p.name).sort(),
      ["cursos", "livros"],
    );
  });

  it("arquivo dentro do prefixo do seed mas não .json ainda conta (ex: novo doc na pasta)", () => {
    // Qualquer arquivo sob o prefixo do seed já é sinal suficiente de mudança
    // relevante — não restringimos por extensão pra manter a heurística simples.
    const changed = ["seed/courses/NOTES.md"];
    const drifted = findDriftedPairs(changed);
    assert.equal(drifted.length, 1);
    assert.equal(drifted[0]?.name, "cursos");
  });

  it("usa pares customizados quando passados explicitamente", () => {
    const customPair: SeedHtmlPair = {
      name: "custom",
      seedPrefix: "seed/custom/",
      htmlPath: "workers/custom/public/index.html",
      buildCommand: "npx tsx scripts/build-custom-page.ts",
    };
    const changed = ["seed/custom/data.json"];
    const drifted = findDriftedPairs(changed, [customPair]);
    assert.equal(drifted.length, 1);
    assert.equal(drifted[0]?.name, "custom");
  });

  it("sanity: os pares default apontam pros paths reais do repo", () => {
    assert.equal(CURSOS_PAIR.seedPrefix, "seed/courses/");
    assert.equal(CURSOS_PAIR.htmlPath, "workers/cursos/public/index.html");
    assert.equal(LIVROS_PAIR.seedPrefix, "seed/books/");
    assert.equal(LIVROS_PAIR.htmlPath, "workers/livros/public/index.html");
  });
});

describe("getChangedFiles (#3105) — parsing de `git diff --name-status`", () => {
  it("A/M/D: reporta o path como mudado", () => {
    const stdout = "A\tseed/courses/cursos-ia.json\nM\tworkers/cursos/public/index.html\nD\tREADME.md\n";
    const files = getChangedFiles("base", "head", mockSpawn(stdout));
    assert.deepEqual(files.sort(), [
      "README.md",
      "seed/courses/cursos-ia.json",
      "workers/cursos/public/index.html",
    ]);
  });

  it("rename: usa só o path NOVO, não o antigo (regressão do self-review)", () => {
    // htmlPath renomeado pra fora — o path antigo NÃO deve aparecer em
    // changedFiles, senão findDriftedPairs reportaria falso-negativo (achar
    // que o HTML "mudou" quando na verdade ele deixou de existir ali).
    const stdout = "R100\tworkers/cursos/public/index.html\tworkers/cursos/public/index-old.html\n";
    const files = getChangedFiles("base", "head", mockSpawn(stdout));
    assert.deepEqual(files, ["workers/cursos/public/index-old.html"]);
    assert.ok(!files.includes("workers/cursos/public/index.html"));
  });

  it("rename + seed change: ainda detecta drift (htmlPath não está no diff sob o path esperado)", () => {
    const stdout =
      "M\tseed/courses/cursos-ia.json\nR100\tworkers/cursos/public/index.html\tworkers/cursos/public/index-old.html\n";
    const files = getChangedFiles("base", "head", mockSpawn(stdout));
    const drifted = findDriftedPairs(files);
    assert.equal(drifted.length, 1);
    assert.equal(drifted[0]?.name, "cursos");
  });

  it("git diff falha (status != 0): lança erro", () => {
    const failingSpawn: SpawnFn = () => ({ status: 1, stdout: "", stderr: "fatal: bad revision" });
    assert.throws(() => getChangedFiles("base", "head", failingSpawn), /git diff falhou/);
  });

  it("linhas vazias são ignoradas", () => {
    const files = getChangedFiles("base", "head", mockSpawn("\n\n"));
    assert.deepEqual(files, []);
  });
});

describe("#7864: confirmHomeDrift/filterConfirmedDrift — falso-positivo do par home-do-site", () => {
  const REF = "deadbeef";
  // Datas fixas e distantes o bastante do "hoje" real (qualquer dia em que o
  // teste rodar) pra `buildHomeFeed` sempre classificar do mesmo jeito:
  // 2020 é sempre passado, 2099 é sempre futuro (filtrado da home).
  const SITEMAP_XML = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<urlset>",
    "<url><loc>https://diar.ia.br/p/edicao-atual/</loc><lastmod>2020-01-01</lastmod></url>",
    // #7864: entrada nova (D+1) cujo lastmod ainda não chegou — o achado ao
    // vivo da issue. Ela muda o sitemap.xml no diff, mas nunca fica
    // elegível pra home enquanto `lastmod` > hoje.
    "<url><loc>https://diar.ia.br/p/edicao-d-mais-1/</loc><lastmod>2099-01-01</lastmod></url>",
    "</urlset>",
  ].join("");
  const PAGE_HTML = fakePageHtml("Título Atual", "Descrição atual");

  function baseFiles(): Record<string, string> {
    return {
      "workers/site/public/sitemap.xml": SITEMAP_XML,
      "workers/site/public/p/edicao-atual/index.html": PAGE_HTML,
    };
  }

  /** O que `gen-home-page.ts`/produção já teria renderizado pra este sitemap. */
  function expectedRenderedHtml(): string {
    const feed = buildHomeFeed(
      SITEMAP_XML,
      (slug) => baseFiles()[`workers/site/public/p/${slug}/index.html`] ?? null,
      7,
    );
    return buildIndexHtml({ feature: feed[0] ?? null, archive: feed.slice(1) });
  }

  it("renderHomePageAtRef reproduz o mesmo HTML que gen-home-page.ts produziria (lendo via git show)", () => {
    const files = baseFiles();
    const spawnFn = mockGitShow(REF, files);
    assert.equal(renderHomePageAtRef(REF, spawnFn), expectedRenderedHtml());
  });

  it("(a) achado da issue: sitemap mudou, index.html não, mas re-render BATE com o committed — não é drift", () => {
    const files = baseFiles();
    files["workers/site/public/index.html"] = expectedRenderedHtml();
    const spawnFn = mockGitShow(REF, files);

    assert.equal(confirmHomeDrift(REF, spawnFn), false);
    assert.deepEqual(filterConfirmedDrift([HOME_PAIR], REF, spawnFn), []);
  });

  it("(b) sitemap mudou, index.html não, re-render NÃO bate — drift real (regressão do comportamento original)", () => {
    const files = baseFiles();
    // index.html committed ficou pra trás de verdade — nunca foi
    // regenerado, nem pra refletir a edição já elegível hoje.
    files["workers/site/public/index.html"] = "<html><body>home defasada, nunca regenerada</body></html>";
    const spawnFn = mockGitShow(REF, files);

    assert.equal(confirmHomeDrift(REF, spawnFn), true);
    assert.deepEqual(filterConfirmedDrift([HOME_PAIR], REF, spawnFn), [HOME_PAIR]);
  });

  it("index.html ausente no ref inteiramente — tratado como drift (nunca engolido em silêncio)", () => {
    const files = baseFiles(); // sem "workers/site/public/index.html"
    const spawnFn = mockGitShow(REF, files);
    assert.equal(confirmHomeDrift(REF, spawnFn), true);
  });

  it("sitemap ausente/corrompido no ref — renderHomePageAtRef lança, confirmHomeDrift trata como drift (fail-safe)", () => {
    const spawnFn = mockGitShow(REF, {
      "workers/site/public/index.html": "<html></html>",
      // sem "workers/site/public/sitemap.xml"
    });
    assert.throws(() => renderHomePageAtRef(REF, spawnFn), /sitemap\.xml não encontrado/);
    assert.equal(confirmHomeDrift(REF, spawnFn), true);
  });

  it("(c) cursos/livros NUNCA disparam re-render — passam por filterConfirmedDrift sem chamar git", () => {
    const throwingSpawn: SpawnFn = () => {
      throw new Error("filterConfirmedDrift não deveria chamar git para pares que não são home-do-site");
    };
    const candidates = [CURSOS_PAIR, LIVROS_PAIR];
    assert.deepEqual(filterConfirmedDrift(candidates, REF, throwingSpawn), candidates);
  });

  it("(c) lote misto: home confirmado + cursos/livros passam intactos", () => {
    const files = baseFiles();
    files["workers/site/public/index.html"] = expectedRenderedHtml(); // home: falso-positivo, não é drift
    const spawnFn = mockGitShow(REF, files);

    const candidates = [CURSOS_PAIR, HOME_PAIR, LIVROS_PAIR];
    assert.deepEqual(filterConfirmedDrift(candidates, REF, spawnFn), [CURSOS_PAIR, LIVROS_PAIR]);
  });
});
