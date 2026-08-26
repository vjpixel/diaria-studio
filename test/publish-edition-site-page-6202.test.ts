/**
 * test/publish-edition-site-page-6202.test.ts (#6202)
 *
 * Dois invariantes:
 *
 * 1. **Falhar aqui nunca pode derrubar a edição.** Publicar no site é
 *    acessório ao envio; todo caminho ruim vira código != 0 com motivo, e a
 *    Etapa 6 trata como warning.
 * 2. **Nunca gerar página de slug inválido.** `new-post` é lixo real do
 *    cache (achado ao vivo no #6167) — deixá-lo passar criaria a página que o
 *    próprio gerador do acervo se recusa a criar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEditionArchivePost,
  extractSlugFromPostUrl,
  wrapFragmentAsDocument,
} from "../scripts/lib/edition-site-page.ts";
import { publishEditionSitePage, type PublishPageDeps } from "../scripts/publish-edition-site-page.ts";
import type { EditionPageInputs } from "../scripts/lib/edition-site-page.ts";

const INPUTS: EditionPageInputs = {
  html: "<p>corpo da edição</p>",
  postUrl: "https://diar.ia.br/p/titulo-da-edicao",
  title: "Título da edição",
  subtitle: "Subtítulo",
  publishedAtIso: "2026-08-27T09:00:00Z",
};

describe("#6202 extractSlugFromPostUrl", () => {
  it("extrai o slug de uma URL de edição", () => {
    assert.equal(extractSlugFromPostUrl("https://diar.ia.br/p/abc-def"), "abc-def");
  });

  it("tolera barra final", () => {
    assert.equal(extractSlugFromPostUrl("https://diar.ia.br/p/abc-def/"), "abc-def");
  });

  it("REGRESSÃO: recusa `new-post` — lixo real do cache (#6167)", () => {
    assert.equal(extractSlugFromPostUrl("https://diar.ia.br/p/new-post"), null);
  });

  it("URL sem /p/ ⇒ null, não chute", () => {
    for (const u of ["https://diar.ia.br/", "https://diar.ia.br/sobre", "não é url", ""]) {
      assert.equal(extractSlugFromPostUrl(u), null, `aceitou: ${u}`);
    }
  });
});

describe("#6202 buildEditionArchivePost — recusa em vez de gerar página quebrada", () => {
  it("caminho feliz produz post com status confirmed", () => {
    const r = buildEditionArchivePost(INPUTS);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.post.slug, "titulo-da-edicao");
      assert.equal(r.post.status, "confirmed", "buildArchivePageHtml recusa rascunho");
      assert.match(r.post.content?.free?.web ?? "", /<html/i, "fragmento precisa virar documento");
      assert.ok((r.post.content?.free?.web ?? "").includes(INPUTS.html), "o corpo original é preservado dentro");
      assert.equal(r.post.publish_date, Math.floor(Date.parse(INPUTS.publishedAtIso!) / 1000));
    }
  });

  it("HTML vazio ⇒ recusa (não publica página em branco)", () => {
    const r = buildEditionArchivePost({ ...INPUTS, html: "   " });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /vazio/);
  });

  it("título ausente ⇒ recusa (página sem <title> é pior que página nenhuma)", () => {
    const r = buildEditionArchivePost({ ...INPUTS, title: "" });
    assert.equal(r.ok, false);
  });

  it("data ausente/inválida ⇒ publish_date null, sem quebrar", () => {
    for (const iso of [null, undefined, "não é data"]) {
      const r = buildEditionArchivePost({ ...INPUTS, publishedAtIso: iso as string | null });
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.post.publish_date, null);
    }
  });
});

interface Harness {
  deps: PublishPageDeps;
  escritas: { slug: string; html: string }[];
  contarDeploys(): number;
}

function makeDeps(over: Partial<PublishPageDeps> = {}): Harness {
  const escritas: { slug: string; html: string }[] = [];
  let deploys = 0;
  const deps: PublishPageDeps = {
    readEditionInputs: () => INPUTS,
    writePage: (slug, html) => void escritas.push({ slug, html }),
    deploy: () => void deploys++,
    log: () => {},
    ...over,
  };
  return { deps, escritas, contarDeploys: () => deploys };
}

describe("#6202 publishEditionSitePage — fail-soft em todo caminho ruim", () => {
  it("caminho feliz: escreve e deploya", () => {
    const { deps, escritas } = makeDeps();
    const r = publishEditionSitePage("/x", deps);
    assert.equal(r.code, 0);
    if (r.code === 0) {
      assert.equal(r.slug, "titulo-da-edicao");
      assert.equal(r.deployed, true);
    }
    assert.equal(escritas.length, 1);
    assert.match(escritas[0].html, /<html/i, "saiu pelo buildArchivePageHtml, documento completo");
  });

  it("--skip-deploy escreve mas NÃO deploya", () => {
    const { deps, escritas } = makeDeps();
    const r = publishEditionSitePage("/x", deps, { skipDeploy: true });
    assert.equal(r.code, 0);
    if (r.code === 0) assert.equal(r.deployed, false);
    assert.equal(escritas.length, 1, "a página é escrita mesmo assim");
  });

  it("edição sem artefatos ⇒ code 2 (não é erro, é 'nada a publicar')", () => {
    const { deps } = makeDeps({ readEditionInputs: () => null });
    const r = publishEditionSitePage("/x", deps);
    assert.equal(r.code, 2);
  });

  it("leitura lança ⇒ code 3, sem escrever nada", () => {
    const { deps, escritas } = makeDeps({
      readEditionInputs: () => {
        throw new Error("JSON inválido");
      },
    });
    const r = publishEditionSitePage("/x", deps);
    assert.equal(r.code, 3);
    assert.equal(escritas.length, 0);
  });

  it("slug inválido ⇒ code 2, NUNCA escreve página", () => {
    const { deps, escritas } = makeDeps({
      readEditionInputs: () => ({ ...INPUTS, postUrl: "https://diar.ia.br/p/new-post" }),
    });
    const r = publishEditionSitePage("/x", deps);
    assert.equal(r.code, 2);
    assert.equal(escritas.length, 0, "página de slug lixo nunca é criada");
  });

  it("escrita falha ⇒ code 3, sem tentar deploy", () => {
    let deployChamado = false;
    const { deps } = makeDeps({
      writePage: () => {
        throw new Error("EACCES");
      },
      deploy: () => void (deployChamado = true),
    });
    const r = publishEditionSitePage("/x", deps);
    assert.equal(r.code, 3);
    assert.equal(deployChamado, false, "não adianta deployar o que não foi escrito");
  });

  it("REGRESSÃO: deploy falha ⇒ code 3, mas a página FICA escrita", () => {
    // O trabalho não se perde: a próxima regeneração/deploy leva a página
    // junto. Por isso a mensagem diz isso explicitamente.
    const { deps, escritas } = makeDeps({
      deploy: () => {
        throw new Error("wrangler: unauthorized");
      },
    });
    const r = publishEditionSitePage("/x", deps);
    assert.equal(r.code, 3);
    if (r.code === 3) assert.match(r.reason, /ficou escrita localmente/);
    assert.equal(escritas.length, 1, "a escrita local sobrevive à falha de deploy");
  });

  it("nenhum caminho lança — a Etapa 6 nunca cai por causa deste passo", () => {
    const explosivos: Partial<PublishPageDeps>[] = [
      { readEditionInputs: () => { throw new Error("x"); } },
      { writePage: () => { throw new Error("x"); } },
      { deploy: () => { throw new Error("x"); } },
    ];
    for (const over of explosivos) {
      const { deps } = makeDeps(over);
      assert.doesNotThrow(() => publishEditionSitePage("/x", deps));
    }
  });
});

describe("#6202 wrapFragmentAsDocument", () => {
  it("fragmento vira documento com <html>", () => {
    const d = wrapFragmentAsDocument("<p>oi</p>");
    assert.match(d, /<html>/);
    assert.ok(d.includes("<p>oi</p>"));
  });

  it("IDEMPOTENTE: documento completo passa intocado (sem aninhar)", () => {
    const doc = "<!doctype html><html><body><p>oi</p></body></html>";
    assert.equal(wrapFragmentAsDocument(doc), doc);
  });

  it("NÃO injeta <head> — buildArchivePageHtml é o único dono dos metadados", () => {
    // Duplicar aqui criaria duas convenções de <head> divergindo com o
    // tempo, justamente entre a edição nova e as 253 antigas.
    assert.doesNotMatch(wrapFragmentAsDocument("<p>oi</p>"), /<head/i);
  });
});
