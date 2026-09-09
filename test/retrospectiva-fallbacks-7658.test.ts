/**
 * test/retrospectiva-fallbacks-7658.test.ts (#7658)
 *
 * Cobre os caminhos de ERRO que a unificação criou ou moveu, e que o review da
 * PR #7709 (pr-test-analyzer) apontou como escuros:
 *
 *   1. `annualKvKey`/`annualTeaserKvKey` — a derivação de chave que passou a
 *      LANÇAR em slug malformado. O gêmeo do mensal ganhou teste; este não.
 *   2. O `try/catch` do trecho não-injetável, nos DOIS gates. É um invariante
 *      declarado ("publicar o trecho SEM o bloco de conversão entregaria
 *      conteúdo de graça sem pedir nada em troca") e só o `throw` estava
 *      testado — nunca o catch que o transforma em página segura.
 *   3. `ARTICLES.get()` estourando no gate de CADASTRO — o gate de apoio já
 *      tinha esse caso; o de cadastro, não.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { annualKvKey, annualTeaserKvKey } from "../scripts/build-annual-page.ts";
import { annualSlug } from "../scripts/lib/anual/annual-paths.ts";
import { readRetrospectivaNamespaceId } from "../scripts/lib/shared/retrospectiva-kv-namespaces.ts";
import { handleGet, legacyRedirectPath, type Env } from "../workers/retrospectiva/src/index.ts";

describe("#7658 — annualKvKey deriva do PATH e lança em slug malformado", () => {
  it("os dois slugs que a pipeline REALMENTE produz viram as chaves certas", () => {
    // Contra `annualSlug`, não contra strings hipotéticas: é a mesma
    // disciplina que pegou o off-by-one de ano em `anualPathFromSlug`.
    assert.equal(annualKvKey(annualSlug(2026, "aniversario")), "article:aniversario2026");
    assert.equal(annualKvKey(annualSlug(2026, "janeiro")), "article:2026");
  });

  it("o trecho é sufixo da chave, não um namespace paralelo", () => {
    assert.equal(annualTeaserKvKey("2026-aniversario"), "article:aniversario2026:teaser");
  });

  it("slug malformado LANÇA — nunca grava sob uma chave que o Worker não leria", () => {
    for (const ruim of ["2026", "aniversario2026", "2026-agosto", "janeiro-2026", ""]) {
      assert.throws(() => annualKvKey(ruim), /não vira path de retrospectiva/, ruim);
    }
  });

  it("o teaser herda o mesmo throw (não constrói chave a partir de lixo)", () => {
    assert.throws(() => annualTeaserKvKey("2026-agosto"), /não vira path de retrospectiva/);
  });
});

// ── trecho não-injetável: o catch precisa produzir a página SEGURA ──────────

const SEM_BODY = "<html><p>trecho sem tag de fechamento</p>"; // `renderTeaser*` lança nisto
const COMPLETO = "<html><body>MARCADOR-SO-DA-EDICAO-PAGA</body></html>";

function envComTeaser(articleKey: string, teaser: string, allowlist: string | null, kitKey?: string): Env {
  return {
    ARTICLES: {
      async get(key: string): Promise<string | null> {
        if (key === `${articleKey}:teaser`) return teaser;
        if (key === articleKey) return COMPLETO;
        return null;
      },
    },
    ALLOWLIST: { async get(): Promise<string | null> { return allowlist; } },
    KIT_API_KEY: kitKey,
  } as unknown as Env;
}

const kitVazio = (async () =>
  new Response(JSON.stringify({ subscribers: [] }), { status: 200 })) as unknown as typeof fetch;

describe("#7658 — trecho presente mas NÃO injetável cai na página seca, nunca no completo", () => {
  it("gate de cadastro: serve `renderNoTeaser`, sem vazar a edição", async () => {
    const env = envComTeaser("article:2026", SEM_BODY, null, "key");
    const res = await handleGet(new Request("https://retrospectiva.diar.ia.br/2026"), env, kitVazio);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.notEqual(body, COMPLETO, "a edição completa NUNCA sai por este caminho");
    assert.doesNotMatch(body, /MARCADOR-SO-DA-EDICAO-PAGA/);
    // A página seca ainda precisa convidar ao cadastro — senão o leitor recebe
    // uma porta fechada sem maçaneta.
    assert.match(body, /assinar|cadastr/i);
  });

  it("gate de apoio: serve o PAYWALL SECO (não o form), sem vazar a edição", async () => {
    const env = envComTeaser("article:2607", SEM_BODY, JSON.stringify([]));
    const res = await handleGet(new Request("https://retrospectiva.diar.ia.br/2607"), env, kitVazio);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.notEqual(body, COMPLETO);
    assert.doesNotMatch(body, /MARCADOR-SO-DA-EDICAO-PAGA/);
    // Assertion do PAYWALL SECO, não do form: as duas páginas compartilham
    // "exclusivo para apoiadores", e foi por isso que o review pegou o
    // template errado sendo servido sem nenhum teste reclamar.
    assert.match(body, /R\$25\/mês/);
    assert.doesNotMatch(body, /<form/i, "o form é a porta de ?entrar=1, nunca a primeira tela");
  });

  it("trecho AUSENTE (não só inválido) também cai na página seca nos dois gates", async () => {
    const vazio = {
      ARTICLES: { async get(key: string): Promise<string | null> { return key.endsWith(":teaser") ? null : COMPLETO; } },
      ALLOWLIST: { async get(): Promise<string | null> { return JSON.stringify([]); } },
      KIT_API_KEY: "key",
    } as unknown as Env;
    for (const p of ["/2026", "/2607"]) {
      const res = await handleGet(new Request(`https://retrospectiva.diar.ia.br${p}`), vazio, kitVazio);
      assert.notEqual(await res.text(), COMPLETO, p);
    }
  });
});

describe("#7658 — KV estourando no gate de CADASTRO (o de apoio já tinha este caso)", () => {
  it("ARTICLES.get() lançando → nunca serve a edição, nunca propaga a exceção", async () => {
    const env = {
      ARTICLES: { async get(): Promise<string | null> { throw new Error("KV fora do ar"); } },
      KIT_API_KEY: "key",
    } as unknown as Env;
    const kitAtivo = (async (url: string | URL) => {
      const email = new URL(String(url)).searchParams.get("email_address") ?? "";
      return new Response(JSON.stringify({ subscribers: [{ email_address: email, state: "active" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    // Assinante ATIVO — passa no gate, mas o conteúdo não pode ser lido.
    const res = await handleGet(
      new Request("https://retrospectiva.diar.ia.br/2026?email=ativo@x.com"),
      env,
      kitAtivo,
    );
    assert.equal(res.status, 404, "conteúdo indisponível é 404, não 500 nem 200");
    assert.doesNotMatch(await res.text(), /MARCADOR-SO-DA-EDICAO-PAGA/);
  });
});

describe("#7658 — arestas do redirect legado e do leitor de namespace", () => {
  it("raiz do host antigo → raiz do novo, preservando a query", () => {
    assert.equal(legacyRedirectPath("anual.diar.ia.br", "/", ""), "/");
    assert.equal(legacyRedirectPath("artigo.diar.ia.br", "/", "?utm_source=kit"), "/?utm_source=kit");
  });

  it("host desconhecido não traduz (o caller manda pra raiz, nunca inventa path)", () => {
    assert.equal(legacyRedirectPath("outro.diar.ia.br", "/2607-08", ""), null);
  });

  it("wrangler.toml ausente LANÇA nomeando o arquivo, em vez de devolver id vazio", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "retro-kv-"));
    assert.throws(
      () => readRetrospectivaNamespaceId("ARTICLES", resolve(dir, "nao-existe.toml")),
      /wrangler\.toml não encontrado/,
    );
  });

  it("wrangler.toml presente mas sem o binding LANÇA nomeando o binding", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "retro-kv2-"));
    const toml = resolve(dir, "wrangler.toml");
    writeFileSync(toml, '[[kv_namespaces]]\nbinding = "OUTRO"\nid = "abc"\n', "utf8");
    assert.throws(() => readRetrospectivaNamespaceId("ALLOWLIST", toml), /"ALLOWLIST" não encontrado/);
  });
});

describe("#7658 — quem informa e-mail e NÃO está na allowlist recebe o mesmo trecho de quem não informou", () => {
  const TRECHO = "<html><body>começo do artigo, amostra pública</body></html>";

  function envComTrecho(): Env {
    return {
      ARTICLES: {
        async get(key: string): Promise<string | null> {
          if (key === "article:2607:teaser") return TRECHO;
          if (key === "article:2607") return COMPLETO;
          return null;
        },
      },
      ALLOWLIST: { async get(): Promise<string | null> { return JSON.stringify(["mantenedor@x.com"]); } },
    } as unknown as Env;
  }

  it("e-mail fora da allowlist → trecho + bloco de conversão, nunca o paywall seco", async () => {
    // A 1ª versão desta unificação devolvia o paywall seco aqui, engolindo a
    // amostra justamente pra quem está decidindo se apoia.
    const res = await handleGet(
      new Request("https://retrospectiva.diar.ia.br/2607?email=naoapoia@x.com"),
      envComTrecho(),
      kitVazio,
    );
    const body = await res.text();
    assert.match(body, /amostra pública/, "o trecho tem que aparecer");
    assert.doesNotMatch(body, /MARCADOR-SO-DA-EDICAO-PAGA/, "a edição paga NUNCA");
  });

  it("sem e-mail → o MESMO trecho (os dois casos são indistinguíveis, como antes da unificação)", async () => {
    const res = await handleGet(new Request("https://retrospectiva.diar.ia.br/2607"), envComTrecho(), kitVazio);
    assert.match(await res.text(), /amostra pública/);
  });

  it("?entrar=1 continua abrindo o form, com ou sem e-mail", async () => {
    for (const q of ["?entrar=1", "?entrar=1&email=naoapoia@x.com"]) {
      const res = await handleGet(new Request(`https://retrospectiva.diar.ia.br/2607${q}`), envComTrecho(), kitVazio);
      assert.match(await res.text(), /<form/i, q);
    }
  });

  it("e-mail NA allowlist continua lendo a edição completa", async () => {
    const res = await handleGet(
      new Request("https://retrospectiva.diar.ia.br/2607?email=mantenedor@x.com"),
      envComTrecho(),
      kitVazio,
    );
    assert.equal(await res.text(), COMPLETO);
  });
});
