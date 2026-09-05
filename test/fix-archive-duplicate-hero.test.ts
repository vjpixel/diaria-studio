import { test } from "node:test";
import * as assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runByHash } from "../scripts/fix-archive-duplicate-hero.ts";

/**
 * Cobre `runByHash` — a parte que decide POR CONTEÚDO e que os testes da lib
 * pura (`strip-duplicate-hero.test.ts`) não alcançam, porque envolve rede.
 * O `fetch` é injetado; nenhum teste aqui toca a rede.
 */

const img = (url: string) => `<img style="margin:0 auto;" src="${url}">`;
const URL_A = "https://media.beehiiv.com/x/uploads/asset/file/11111111-1111-1111-1111-111111111111/a.png";
const URL_B = "https://media.beehiiv.com/x/uploads/asset/file/22222222-2222-2222-2222-222222222222/b.png";
const URL_C = "https://media.beehiiv.com/x/uploads/asset/file/33333333-3333-3333-3333-333333333333/c.png";

/** Cria um acervo temporário; devolve a raiz e um leitor de página. */
function acervo(paginas: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "acervo-"));
  for (const [slug, html] of Object.entries(paginas)) {
    mkdirSync(join(root, slug), { recursive: true });
    writeFileSync(join(root, slug, "index.html"), html, "utf8");
  }
  return {
    root,
    ler: (slug: string) => readFileSync(join(root, slug, "index.html"), "utf8"),
    limpar: () => rmSync(root, { recursive: true, force: true }),
  };
}

const pagina = (heroUrl: string | null, bodyUrls: string[]) =>
  (heroUrl ? `<div style='padding-bottom:2rem;'>${img(heroUrl)}</div>` : "") +
  `<div id='content-blocks'><h1>T</h1>${bodyUrls.map(img).join("<p>x</p>")}</div>`;

/** fetch falso: mapeia URL → conteúdo. URL ausente = falha de rede. */
function fakeFetch(conteudo: Record<string, string>, log?: string[]) {
  return async (url: string) => {
    log?.push(url);
    const c = conteudo[url];
    if (c === undefined) throw new Error("network");
    return { ok: true, bytes: Buffer.from(c) };
  };
}

test("hero idêntico a imagem do corpo → corrige", async () => {
  const a = acervo({ p1: pagina(URL_A, [URL_B, URL_C]) });
  try {
    const r = await runByHash(true, {
      root: a.root,
      // A e C têm o MESMO conteúdo, com URLs (e portanto asset ids) diferentes
      fetchImpl: fakeFetch({ [URL_A]: "MESMA", [URL_B]: "outra", [URL_C]: "MESMA" }),
    });
    assert.equal(r.fixed, 1);
    const html = a.ler("p1");
    assert.ok(!html.includes(URL_A), "hero removido");
    assert.ok(html.includes(URL_C), "a cópia do corpo permanece");
    assert.ok(!html.includes("padding-bottom:2rem"), "wrapper removido");
  } finally {
    a.limpar();
  }
});

test("compara contra TODAS as imagens do corpo, não só a primeira", async () => {
  // a cópia está na SEGUNDA imagem — caso real medido no acervo
  const a = acervo({ p1: pagina(URL_A, [URL_B, URL_C]) });
  try {
    const r = await runByHash(false, {
      root: a.root,
      fetchImpl: fakeFetch({ [URL_A]: "X", [URL_B]: "difere", [URL_C]: "X" }),
    });
    assert.equal(r.fixed, 1, "precisa achar a cópia mesmo em posição posterior");
  } finally {
    a.limpar();
  }
});

test("hero diferente de tudo no corpo → não toca, não polui o relatório", async () => {
  const a = acervo({ p1: pagina(URL_A, [URL_B]) });
  try {
    const antes = a.ler("p1");
    const r = await runByHash(true, {
      root: a.root,
      fetchImpl: fakeFetch({ [URL_A]: "hero", [URL_B]: "outra" }),
    });
    assert.equal(r.fixed, 0);
    assert.equal(r.outcomes.length, 0, "não é duplicata: nada a relatar");
    assert.equal(a.ler("p1"), antes, "arquivo intacto");
  } finally {
    a.limpar();
  }
});

test("download do hero falha → abstém-se e sinaliza", async () => {
  const a = acervo({ p1: pagina(URL_A, [URL_B]) });
  try {
    const antes = a.ler("p1");
    const r = await runByHash(true, {
      root: a.root,
      fetchImpl: fakeFetch({ [URL_B]: "outra" }), // URL_A ausente = falha
    });
    assert.equal(r.fixed, 0);
    assert.equal(r.outcomes[0].status, "skipped");
    assert.match(r.outcomes[0].detail, /falha ao baixar o hero/);
    assert.equal(a.ler("p1"), antes);
  } finally {
    a.limpar();
  }
});

test("falha ao baixar UMA do corpo, mas outra dá match → ainda corrige", async () => {
  const a = acervo({ p1: pagina(URL_A, [URL_B, URL_C]) });
  try {
    const r = await runByHash(true, {
      root: a.root,
      fetchImpl: fakeFetch({ [URL_A]: "IGUAL", [URL_C]: "IGUAL" }), // URL_B falha
    });
    assert.equal(r.fixed, 1, "uma falha isolada não pode impedir um match real");
  } finally {
    a.limpar();
  }
});

test("sem match E com download falho → 'não decidido', não 'não é duplicata'", async () => {
  const a = acervo({ p1: pagina(URL_A, [URL_B]) });
  try {
    const r = await runByHash(true, {
      root: a.root,
      fetchImpl: fakeFetch({ [URL_A]: "hero" }), // URL_B falha
    });
    assert.equal(r.fixed, 0);
    assert.equal(r.outcomes.length, 1, "não pode calar sobre um caso indeterminado");
    assert.match(r.outcomes[0].detail, /nao pôde ser baixada|nao decidido/);
  } finally {
    a.limpar();
  }
});

test("hero é a única imagem → nunca remove (deixaria a página sem imagem)", async () => {
  const a = acervo({ p1: pagina(URL_A, []) });
  try {
    const antes = a.ler("p1");
    const r = await runByHash(true, { root: a.root, fetchImpl: fakeFetch({ [URL_A]: "x" }) });
    assert.equal(r.fixed, 0);
    assert.match(r.outcomes[0].detail, /unica imagem/);
    assert.equal(a.ler("p1"), antes);
  } finally {
    a.limpar();
  }
});

test("dry-run não grava", async () => {
  const a = acervo({ p1: pagina(URL_A, [URL_C]) });
  try {
    const antes = a.ler("p1");
    const r = await runByHash(false, {
      root: a.root,
      fetchImpl: fakeFetch({ [URL_A]: "IGUAL", [URL_C]: "IGUAL" }),
    });
    assert.equal(r.fixed, 1, "reporta o que faria");
    assert.equal(a.ler("p1"), antes, "mas não escreve");
  } finally {
    a.limpar();
  }
});

test("cache: a mesma URL não é baixada duas vezes", async () => {
  const log: string[] = [];
  const a = acervo({ p1: pagina(URL_A, [URL_B]), p2: pagina(URL_A, [URL_B]) });
  try {
    await runByHash(false, {
      root: a.root,
      fetchImpl: fakeFetch({ [URL_A]: "h", [URL_B]: "b" }, log),
    });
    assert.equal(log.filter((u) => u === URL_A).length, 1, "hero baixado 1× para 2 páginas");
    assert.equal(log.filter((u) => u === URL_B).length, 1);
  } finally {
    a.limpar();
  }
});

test("falha de rede também é cacheada — não repete o download que já falhou", async () => {
  const log: string[] = [];
  const a = acervo({ p1: pagina(URL_A, [URL_B]), p2: pagina(URL_A, [URL_B]) });
  try {
    await runByHash(false, { root: a.root, fetchImpl: fakeFetch({ [URL_B]: "b" }, log) });
    assert.equal(log.filter((u) => u === URL_A).length, 1, "hero falho não é retentado por página");
  } finally {
    a.limpar();
  }
});

test("é idempotente — segunda passada não acha mais nada", async () => {
  const a = acervo({ p1: pagina(URL_A, [URL_C]) });
  try {
    const f = fakeFetch({ [URL_A]: "IGUAL", [URL_C]: "IGUAL" });
    const first = await runByHash(true, { root: a.root, fetchImpl: f });
    assert.equal(first.fixed, 1);
    const second = await runByHash(true, { root: a.root, fetchImpl: f });
    assert.equal(second.fixed, 0, "página já corrigida não tem mais hero");
  } finally {
    a.limpar();
  }
});
