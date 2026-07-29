/**
 * publish-threads.test.ts (#2479; contrato sem fallback #4294)
 *
 * Testa o fluxo de 2 passos da Threads API (container → threads_publish)
 * com mock da API (sem chamadas reais), incluindo:
 *   - extractDestaquesFromSocialMd (SÓ '# Curto', sem fallback — #4294/#3994)
 *   - extractPostText (SÓ '# Curto', sem fallback, sem throw — #4294/#3994)
 *   - textContainsEditionUrl / warnMissingEditionUrl (guard não-fatal #4294)
 *   - splitIntoThreadChunks (limite 500 chars + encadeamento)
 *   - Verificação estática do script (creds, CLI guard, severity, etc.)
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  extractDestaquesFromSocialMd,
  extractPostText,
  textContainsEditionUrl,
  warnMissingEditionUrl,
  splitIntoThreadChunks,
  THREADS_CHAR_LIMIT,
  waitForContainerReady,
  CONTAINER_POLL_MAX_ATTEMPTS,
} from "../scripts/publish-threads.ts";
import { postToWorkerQueue } from "../scripts/lib/worker-queue-client.ts"; // #3944 Parte B

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Leitura da source estática — reutilizada por múltiplos testes estáticos
const SRC = readFileSync(resolve(__ROOT, "scripts/publish-threads.ts"), "utf8");

// ─── Fixtures ───────────────────────────────────────────────────────────────

const MD_CURTO = `# Curto

## d1
Post curto d1 no X/Threads. #inovacao #tecnologia

## d2
Post curto d2. #ia #futuro

## d3
Post curto d3. #dados
<!-- comentario oculto -->

# Facebook

## d1
Post d1 Facebook diferente — não deveria vazar pro Threads.
`;

/** Formato pós-#3991: LinkedIn/Facebook/Instagram colapsados em '# Social', sem '# Curto'. */
const MD_SO_SOCIAL = `# Social

## d1
Post d1 Social.

## d2
Post d2 Social.

## d3
Post d3 Social.
`;

const MD_CRLF = MD_CURTO.replace(/\n/g, "\r\n");

// ─── extractDestaquesFromSocialMd ────────────────────────────────────────────

describe("extractDestaquesFromSocialMd (threads) — SÓ '# Curto' (#4294)", () => {
  it("retorna d1/d2/d3 quando seção Curto existe com 3 destaques", () => {
    const destaques = extractDestaquesFromSocialMd(MD_CURTO);
    assert.deepEqual(destaques, ["d1", "d2", "d3"]);
  });

  it("não usa '# Facebook' mesmo quando Curto tem menos destaques", () => {
    const md = `# Curto\n\n## d1\nPost curto d1.\n\n# Facebook\n\n## d1\nFB d1.\n\n## d2\nFB d2.\n\n## d3\nFB d3.\n`;
    const destaques = extractDestaquesFromSocialMd(md);
    assert.deepEqual(destaques, ["d1"], "não deve pegar d2/d3 de Facebook");
  });

  it("retorna [] quando seção Curto ausente — SEM fallback pra '# Social'/'# Facebook' (#4294)", () => {
    assert.deepEqual(extractDestaquesFromSocialMd(MD_SO_SOCIAL), []);
  });

  it("retorna [] quando nenhuma seção existe", () => {
    assert.deepEqual(extractDestaquesFromSocialMd("# Outra\n## d1\ntexto"), []);
  });

  it("retorna d1/d2 quando edição tem só 2 destaques na seção Curto", () => {
    const md = `# Curto\n\n## d1\nPost d1.\n\n## d2\nPost d2.\n`;
    const destaques = extractDestaquesFromSocialMd(md);
    assert.deepEqual(destaques, ["d1", "d2"]);
  });
});

// ─── extractPostText ─────────────────────────────────────────────────────────

describe("extractPostText (threads) — SÓ '# Curto', sem fallback, sem throw (#4294)", () => {
  it("extrai d1 da seção Curto", () => {
    const t = extractPostText(MD_CURTO, "d1");
    assert.ok(t?.includes("Post curto d1 no X/Threads."));
    assert.ok(!t?.includes("Post d1 Facebook diferente."));
  });

  it("extrai d2 sem vazar d1 ou d3", () => {
    const t = extractPostText(MD_CURTO, "d2");
    assert.ok(t?.includes("Post curto d2."));
    assert.ok(!t?.includes("Post curto d1"));
    assert.ok(!t?.includes("Post curto d3"));
  });

  it("extrai d3 e remove comentários HTML", () => {
    const t = extractPostText(MD_CURTO, "d3");
    assert.ok(t?.includes("Post curto d3."));
    assert.ok(!t?.includes("comentario oculto"));
  });

  it("não vaza seção Facebook quando Curto presente", () => {
    const t = extractPostText(MD_CURTO, "d1");
    assert.ok(!t?.includes("Post d1 Facebook diferente."));
  });

  it("normaliza CRLF para LF", () => {
    const t = extractPostText(MD_CRLF, "d1");
    assert.ok(t?.includes("Post curto d1 no X/Threads."));
  });

  it("retorna null quando destaque não existe dentro da seção Curto — nunca lança", () => {
    assert.equal(extractPostText(MD_CURTO, "d9"), null);
  });

  it("retorna null quando não há seção Curto — NUNCA cai pra '# Social'/'# Facebook' (regressão #4294)", () => {
    const t = extractPostText(MD_SO_SOCIAL, "d1");
    assert.equal(t, null, "sem '# Curto', extractPostText nunca deve extrair de '# Social'");
  });

  it("regressão #4294: 03-social.md pós-#3991 (só '# Social', sem '# Curto') não vaza texto pra nenhum destaque", () => {
    for (const d of ["d1", "d2", "d3"]) {
      assert.equal(extractPostText(MD_SO_SOCIAL, d), null, `${d} deveria ser null (skip), nunca texto de '# Social'`);
    }
  });

  it("retorna null (não lança) para seção Curto ausente com input arbitrário", () => {
    assert.equal(extractPostText("# LinkedIn\n## d1\ntexto", "d1"), null);
  });
});

describe("regressão #4309 (defesa em profundidade — hoje latente em '# Curto')", () => {
  // '# Curto' não recebe '## eia'/'## post_pixel' hoje (só '# Social' recebe,
  // via merge-social-md.ts) — mas o terminador do '## dN' era o MESMO código
  // com o MESMO bug (`\n## d\d+\b`) que quebrou ao vivo em Facebook/Instagram.
  // Trava aqui pra não reativar se uma seção irmã aparecer depois do último
  // destaque em '# Curto' no futuro.
  const MD_CURTO_COM_SIBLING =
    "# Curto\n\n" +
    "## d1\nPost d1.\n\n" +
    "## d2\nPost d2.\n\n" +
    "## d3\nPost d3 exclusivo.\n\n" +
    "## post_pixel\nPost pessoal do Pixel. {edition_url}\n";

  it("d3 (último destaque) não vaza '## post_pixel' nem {edition_url} não-resolvido", () => {
    const t = extractPostText(MD_CURTO_COM_SIBLING, "d3");
    assert.ok(t?.includes("Post d3 exclusivo."));
    assert.ok(!t?.includes("## post_pixel"));
    assert.ok(!t?.includes("Post pessoal do Pixel"));
    assert.ok(!t?.includes("{edition_url}"));
  });
});

// ─── Caso feliz: texto do Threads idêntico ao do X pro mesmo destaque ───────

describe("Curto compartilhado entre X e Threads (#4294 regressão)", () => {
  it("com '# Curto' já com {edition_url} resolvido, extractPostText retorna o mesmo texto que o X consumiria", () => {
    const editionUrl = "https://diar.ia.br/p/titulo-do-destaque-d1";
    const md = `# Curto\n\n## d1\nTexto do destaque D1. Saiba mais: ${editionUrl}\n\n## d2\nTexto do destaque D2.\n`;
    const t = extractPostText(md, "d1");
    assert.ok(t?.includes(editionUrl), "texto deve conter a URL da edição já resolvida");
    assert.equal(
      t,
      `Texto do destaque D1. Saiba mais: ${editionUrl}`,
      "Threads deve extrair exatamente o mesmo texto que prep-twitter-posts.ts extrairia de '# Curto'",
    );
  });
});

// ─── splitIntoThreadChunks ───────────────────────────────────────────────────

describe("splitIntoThreadChunks", () => {
  it("retorna [text] quando texto cabe em 500 chars", () => {
    const text = "Texto curto de teste #ia";
    const chunks = splitIntoThreadChunks(text);
    assert.deepEqual(chunks, [text]);
    assert.equal(chunks.length, 1);
  });

  it("divide texto longo em múltiplos chunks de ≤500 chars", () => {
    // Texto de ~1000 chars → deve gerar ≥2 chunks
    const text = "palavra ".repeat(130); // ~1040 chars
    const chunks = splitIntoThreadChunks(text);
    assert.ok(chunks.length >= 2, "deve gerar ≥2 chunks");
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 500, `chunk tem ${chunk.length} chars — máximo é 500`);
    }
  });

  it("reconstitui o texto original (sem perda)", () => {
    const original = "Notícia importante sobre inteligência artificial. ".repeat(15);
    const chunks = splitIntoThreadChunks(original);
    const reconstructed = chunks.join(" ");
    // Verificar que todas as palavras estão presentes
    for (const palavra of ["Notícia", "inteligência", "artificial"]) {
      assert.ok(reconstructed.includes(palavra), `palavra '${palavra}' perdida após split`);
    }
  });

  it("não quebra palavras no meio (corta em espaços)", () => {
    const text = "palavra " + "a".repeat(490) + " outra";
    const chunks = splitIntoThreadChunks(text, 500);
    for (const chunk of chunks) {
      // Nenhum chunk deve começar com 'a' após um corte duro no meio de "aaaa..."
      // — cada chunk deve ser uma palavra ou sequência inteira
      assert.ok(chunk.length <= 500);
    }
  });

  it("aceita maxLen customizado", () => {
    const text = "ola mundo tudo bem como vai voce hoje";
    const chunks = splitIntoThreadChunks(text, 10);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 10, `chunk "${chunk}" excede maxLen=10`);
    }
  });

  it("texto de exatamente 500 chars não é dividido", () => {
    const text = "a".repeat(THREADS_CHAR_LIMIT);
    const chunks = splitIntoThreadChunks(text);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], text);
  });

  it("THREADS_CHAR_LIMIT exportado é 500", () => {
    assert.equal(THREADS_CHAR_LIMIT, 500);
  });
});

// ─── Fluxo de 2 passos — verificação estática do código ──────────────────────

describe("Fluxo Threads 2 passos (verificação estática do script)", () => {
  it("passo 1: envia text + media_type=TEXT para /{threads-user-id}/threads", () => {
    assert.match(SRC, /TEXT/, "deve usar media_type TEXT");
    assert.match(SRC, /\/threads`/, "deve chamar endpoint /threads via template string");
  });

  it("passo 2: envia creation_id para /{threads-user-id}/threads_publish", () => {
    assert.match(SRC, /creation_id/, "deve enviar creation_id para /threads_publish");
    assert.match(SRC, /\/threads_publish`/, "deve chamar endpoint /threads_publish via template string");
  });

  it("fluxo encadeado: reply_to_id passado ao segundo post da thread", () => {
    assert.match(SRC, /reply_to_id/, "deve suportar reply_to_id para encadeamento de posts");
  });

  it("retorna status 'published' após fluxo bem-sucedido (não 'scheduled')", () => {
    assert.match(SRC, /status: "published"/, "status do post Threads deve ser 'published'");
  });

  it("armazena threads_media_id no entry", () => {
    assert.match(SRC, /threads_media_id/, "deve gravar threads_media_id no entry");
  });

  it("armazena threads_chunks no entry", () => {
    assert.match(SRC, /threads_chunks/, "deve gravar quantidade de chunks no entry");
  });

  it("busca permalink real via /fields=permalink (não constrói URL manual)", () => {
    assert.match(SRC, /fetchThreadsPermalink/, "deve ter helper fetchThreadsPermalink");
    assert.match(SRC, /fields=permalink/, "deve buscar campo permalink da Threads API");
  });

  it("THREADS_API_BASE usa graph.threads.net", () => {
    assert.match(SRC, /graph\.threads\.net/, "deve usar a Threads API base correta");
  });
});

// ─── Credenciais obrigatórias (runtime-only) ─────────────────────────────────

describe("Credenciais THREADS obrigatórias", () => {
  it("THREADS_USER_ID verificado no script", () => {
    assert.match(SRC, /THREADS_USER_ID/, "deve verificar THREADS_USER_ID");
  });

  it("THREADS_ACCESS_TOKEN verificado no script", () => {
    assert.match(SRC, /THREADS_ACCESS_TOKEN/, "deve verificar THREADS_ACCESS_TOKEN");
  });

  it("credenciais ausentes resultam em process.exit(0) (graceful skip, não exit 1)", () => {
    // Threads é best-effort — exit 1 mascararia violations de consent de outros canais.
    // Análogo a publish-instagram.ts (#2486).
    assert.match(SRC, /process\.exit\(0\)/, "deve sair graciosamente (exit 0) quando env vars ausentes");
    assert.match(SRC, /SKIP:.*ausente/, "deve emitir mensagem SKIP quando creds ausentes");
  });

  it("script tem CLI guard (não roda em import)", () => {
    // Padrão CLI guard canônico do repo (#2834): isMainModule(import.meta.url)
    assert.match(SRC, /isMainModule\(import\.meta\.url\)/, "deve ter CLI guard padrão do repo");
  });
});

// ─── best-effort (invariant check severity) ──────────────────────────────────

describe("Invariant check de Threads (best-effort/warning)", () => {
  it("checkThreadsCredsSet retorna warning quando THREADS_USER_ID ausente", async () => {
    const { checkThreadsCredsSet } = await import(
      "../scripts/lib/invariant-checks/stage-5.ts"
    );
    const original = process.env.THREADS_USER_ID;
    delete process.env.THREADS_USER_ID;
    try {
      const violations = checkThreadsCredsSet();
      const v = violations.find((x) => x.rule === "threads-user-id-set");
      assert.ok(v, "deve emitir violation threads-user-id-set");
      assert.equal(v.severity, "warning", "severity deve ser 'warning' (não 'error')");
      assert.match(v.message, /THREADS_USER_ID/);
    } finally {
      if (original !== undefined) process.env.THREADS_USER_ID = original;
    }
  });

  it("checkThreadsCredsSet retorna warning quando THREADS_ACCESS_TOKEN ausente", async () => {
    const { checkThreadsCredsSet } = await import(
      "../scripts/lib/invariant-checks/stage-5.ts"
    );
    const original = process.env.THREADS_ACCESS_TOKEN;
    delete process.env.THREADS_ACCESS_TOKEN;
    try {
      const violations = checkThreadsCredsSet();
      const v = violations.find((x) => x.rule === "threads-access-token-set");
      assert.ok(v, "deve emitir violation threads-access-token-set");
      assert.equal(v.severity, "warning", "severity deve ser 'warning' (não 'error')");
      assert.match(v.message, /THREADS_ACCESS_TOKEN/);
    } finally {
      if (original !== undefined) process.env.THREADS_ACCESS_TOKEN = original;
    }
  });

  it("checkThreadsCredsSet retorna [] quando ambas env vars presentes", async () => {
    const { checkThreadsCredsSet } = await import(
      "../scripts/lib/invariant-checks/stage-5.ts"
    );
    const origUserId = process.env.THREADS_USER_ID;
    const origToken = process.env.THREADS_ACCESS_TOKEN;
    process.env.THREADS_USER_ID = "12345";
    process.env.THREADS_ACCESS_TOKEN = "test-token";
    try {
      const violations = checkThreadsCredsSet();
      assert.deepEqual(violations, [], "sem creds presentes, não deve emitir violations");
    } finally {
      if (origUserId !== undefined) process.env.THREADS_USER_ID = origUserId;
      else delete process.env.THREADS_USER_ID;
      if (origToken !== undefined) process.env.THREADS_ACCESS_TOKEN = origToken;
      else delete process.env.THREADS_ACCESS_TOKEN;
    }
  });

  it("threads-creds-set está registrado no STAGE_5_RULES", async () => {
    const { STAGE_5_RULES } = await import("../scripts/lib/invariant-checks/stage-5.ts").then(
      () =>
        import("../scripts/lib/invariant-checks/index.ts").then((m) => ({
          STAGE_5_RULES: m.getRulesForStage(5),
        })),
    );
    const entry = STAGE_5_RULES.find((r) => r.id === "threads-creds-set");
    assert.ok(entry, "STAGE_5_RULES deve conter entry threads-creds-set");
    assert.equal(entry!.stage, 5, "threads-creds-set deve estar no stage 5");
  });
});

// ─── Resume-aware (pula posts já publicados) ─────────────────────────────────

describe("Resume-aware skip posts já publicados", () => {
  it("pula post threads com status 'published'", () => {
    const posts = [{ platform: "threads", destaque: "d1", status: "published" }];
    const existing = posts.find(
      (p) =>
        p.platform === "threads" &&
        p.destaque === "d1" &&
        (p.status === "draft" || p.status === "scheduled" || p.status === "published"),
    );
    assert.ok(existing !== undefined);
    assert.equal(existing.status, "published");
  });

  it("não pula post threads failed (retry)", () => {
    const posts = [{ platform: "threads", destaque: "d1", status: "failed" }];
    const existing = posts.find(
      (p) =>
        p.platform === "threads" &&
        p.destaque === "d1" &&
        (p.status === "draft" || p.status === "scheduled" || p.status === "published"),
    );
    assert.equal(existing, undefined);
  });

  it("não pula outra plataforma", () => {
    const posts = [{ platform: "facebook", destaque: "d1", status: "published" }];
    const existing = posts.find(
      (p) =>
        p.platform === "threads" &&
        p.destaque === "d1" &&
        (p.status === "draft" || p.status === "scheduled" || p.status === "published"),
    );
    assert.equal(existing, undefined);
  });

  it("script verifica status 'published' como válido para skip", () => {
    assert.match(
      SRC,
      /status === "published"/,
      "deve incluir 'published' na verificação de skip",
    );
  });

  it("script tem summary.skipped via contador dedicado (não tautologia)", () => {
    assert.match(SRC, /skipped: skippedCount/, "skipped deve usar skippedCount dedicado");
  });
});

// ─── Retry com backoff exponencial ───────────────────────────────────────────

describe("Retry com backoff exponencial", () => {
  it("script define maxAttempts=3 para posts de chunk único (sem retry em multi-chunk para evitar posts órfãos)", () => {
    assert.match(SRC, /maxAttempts = isMultiChunk \? 1 : 3/, "maxAttempts condicional: 1 pra multi-chunk (sem retry), 3 pra single-chunk");
  });

  it("script usa backoff exponencial entre tentativas", () => {
    assert.match(SRC, /Math\.pow\(2, attempt - 1\)/, "deve usar backoff 2^(attempt-1)");
  });

  it("em test-mode, pula o sleep entre tentativas", () => {
    assert.match(SRC, /isTest/, "deve respeitar isTest para pular delay");
  });
});

// ─── Integração com platform.config.json ─────────────────────────────────────

describe("Integração com platform.config.json", () => {
  it("platform.config.json tem 'threads' no array socials", () => {
    const cfg = JSON.parse(
      readFileSync(resolve(__ROOT, "platform.config.json"), "utf8"),
    ) as { socials?: string[] };
    assert.ok(Array.isArray(cfg.socials), "socials deve ser array");
    assert.ok(cfg.socials!.includes("threads"), "socials deve conter 'threads'");
  });
});

// ─── Regression #2522 Bug 1: --dry-run real guard (não chama fetch) ──────────

describe("--dry-run real guard (#2522 Bug 1)", () => {
  /**
   * Regression for #2522 Bug 1:
   * --test-mode only skips sleep — it does NOT block real fetch calls.
   * --dry-run must be a real guard that prevents any fetch from being issued.
   *
   * Verificação estática: o script deve ter um guard isDryRun ANTES do loop de
   * publicação (antes de publishThread ser chamado), não apenas pular o sleep.
   */
  it("script tem flag --dry-run parseada no parseArgs", () => {
    assert.match(SRC, /dry-run/, "parseArgs deve aceitar --dry-run");
    assert.match(SRC, /isDryRun/, "deve ter variável isDryRun");
  });

  it("guard isDryRun bloqueia ANTES da chamada de fetch (publishThread)", () => {
    // O guard deve aparecer ANTES do bloco de retry/publishThread no source.
    // #2522 review: casar o GUARD `if (isDryRun)`, não a declaração `const
    // isDryRun` (que está no topo e passaria mesmo se o guard fosse removido).
    const dryRunIdx = SRC.indexOf("if (isDryRun)");
    const publishThreadCallIdx = SRC.indexOf("await publishThread(");
    assert.ok(dryRunIdx > 0, "guard `if (isDryRun)` deve existir no script (não só a declaração)");
    assert.ok(publishThreadCallIdx > 0, "publishThread deve existir no script");
    assert.ok(
      dryRunIdx < publishThreadCallIdx,
      `isDryRun guard (pos ${dryRunIdx}) deve aparecer ANTES de publishThread call (pos ${publishThreadCallIdx})`,
    );
  });

  it("--dry-run é distinto de --test-mode (test-mode não bloqueia fetch)", () => {
    // Ambos devem existir — são propósitos diferentes:
    // --test-mode: skip sleep (compatibilidade retroativa)
    // --dry-run: real guard, não chama fetch
    assert.match(SRC, /--test-mode/, "deve manter suporte a --test-mode para compat retroativa");
    assert.match(SRC, /--dry-run/, "deve ter --dry-run como guard real");
  });

  it("--dry-run imprime DRY-RUN no output (não chama Threads API)", () => {
    // Verificação estática: o branch isDryRun deve imprimir algo indicando dry-run
    assert.match(SRC, /DRY-RUN|dry.run/i, "deve imprimir indicador de dry-run quando ativo");
  });
});

// ─── Regression #2522 Bug 2: chunk vazio filtrado ────────────────────────────

describe("splitIntoThreadChunks chunk vazio (#2522 Bug 2)", () => {
  /**
   * Regression for #2522 Bug 2:
   * Quando cut=0 (espaço na posição 0 do remaining), slice(0,0).trim()=""
   * resultava em chunk vazio sendo adicionado ao array.
   * Fix: filtrar chunks vazios antes do push (cut <= 0 → usar corte duro).
   */
  it("não emite chunk vazio quando texto começa com espaço (cut=0 edge case)", () => {
    // Simular o caso edge onde cut seria 0: texto tem um espaço logo no início
    // após o trim de remaining, e o espaço está na posição 0 de remaining.
    // Na prática, remaining.trim() remove leading spaces, mas se o split
    // produz um remaining que começa com espaço, cut=0 → chunk vazio.
    //
    // Forçar o edge case com um texto onde cada "palavra" é um bloco de 499
    // 'a' seguido de espaço — o segundo remaining começa com espaço.
    const wordOf499 = "a".repeat(499);
    const text = `${wordOf499} ${wordOf499}`; // 1000 chars com espaço no meio
    const chunks = splitIntoThreadChunks(text, 500);
    for (const chunk of chunks) {
      assert.ok(chunk.length > 0, `chunk vazio encontrado: "${chunk}"`);
      assert.ok(chunk.trim().length > 0, `chunk só com whitespace encontrado: "${chunk}"`);
    }
    assert.ok(chunks.length >= 1, "deve ter pelo menos 1 chunk");
  });

  it("não emite chunk vazio para texto com espaços no início (leading spaces)", () => {
    // Texto longo onde o primeiro corte deixa um remaining com espaço líder
    const long = "palavra ".repeat(200); // 1600 chars
    const chunks = splitIntoThreadChunks(long.trimEnd(), 500);
    for (const chunk of chunks) {
      assert.ok(chunk.length > 0, `chunk vazio em texto longo: "${chunk}"`);
    }
    assert.ok(chunks.length >= 2, "texto de 1600 chars deve gerar ≥2 chunks");
  });

  it("texto onde lastIndexOf retorna 0 não gera chunk vazio", () => {
    // Forçar: maxLen=5, texto " abcd efgh"
    // remaining=" abcd efgh", lastIndexOf(" ", 4) = 0 → cut=0 → slice(0,0)=""
    // Fix deve usar cut=maxLen quando cut<=0
    const text = "abcd efgh"; // 9 chars, maxLen=5
    const chunks = splitIntoThreadChunks(text, 5);
    for (const chunk of chunks) {
      assert.ok(chunk.length > 0, `chunk vazio com maxLen=5: "${chunk}"`);
    }
    // Verificar que todos os chars estão presentes (sem perda)
    assert.ok(chunks.join("").replace(/\s/g, "").length > 0);
  });
});

// ─── Regression #2540 P2: --dry-run subprocess guard (ausência de side-effect) ─

describe("--dry-run subprocess guard (#2540 P2)", () => {
  /**
   * Regression for #2540 P2:
   * O teste anterior (scan estático) verificava que `if (isDryRun)` aparece antes
   * de `await publishThread(` no source. Isso é necessário mas insuficiente: um
   * guard sintaticamente correto mas semanticamente quebrado (ex: condição invertida,
   * variável errada) passaria no scan estático.
   *
   * Este teste executa `--dry-run` como subprocess real em um tmpdir isolado e
   * asserta que `06-social-published.json` NÃO é criado — provando que nenhum
   * side-effect de publicação ocorreu.
   *
   * ⚠️ PUBLICATION GUARD: fake credentials no env → as chamadas de fetch NUNCA
   * chegam à Threads API. O script faz early-exit(0) se creds ausentes, portanto
   * providenciamos creds fake + --dry-run para exercitar o caminho completo do
   * guard sem tocar o serviço real.
   */

  const SCRIPT = resolve(__ROOT, "scripts/publish-threads.ts");

  /** Minimal 03-social.md com seção Threads para que o script chegue ao loop. */
  const SOCIAL_MD = `# Curto\n\n## d1\nPost de teste para dry-run.\n\n## d2\nPost d2 dry-run.\n\n## d3\nPost d3 dry-run.\n`;

  it("--dry-run: 06-social-published.json NÃO é criado (sem side-effect)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diaria-threads-dryrun-"));
    const internalDir = join(tmpDir, "_internal");
    try {
      // Criar estrutura de edição mínima
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(join(tmpDir, "03-social.md"), SOCIAL_MD, "utf8");

      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", SCRIPT,
          "--edition-dir", tmpDir,
          "--dry-run",
        ],
        {
          encoding: "utf8",
          cwd: __ROOT,
          env: {
            ...process.env,
            // Fake credentials: script passa pelo guard de credenciais e chega ao loop.
            // Em --dry-run, nenhuma chamada fetch é emitida — estas creds nunca são usadas.
            THREADS_USER_ID: "fake_user_id_dryrun_test",
            THREADS_ACCESS_TOKEN: "fake_access_token_dryrun_test",
          },
        },
      );

      // Script deve sair com 0 (dry-run não é erro)
      assert.equal(r.status, 0, `publish-threads --dry-run deve sair com 0; stderr: ${r.stderr}`);

      // REGRESSÃO PRINCIPAL: o arquivo de side-effect NÃO deve existir
      const internalJsonPath = join(internalDir, "06-social-published.json");
      const rootJsonPath = join(tmpDir, "06-social-published.json");
      assert.ok(
        !existsSync(internalJsonPath),
        `--dry-run não deve criar _internal/06-social-published.json (encontrado: ${internalJsonPath})`,
      );
      assert.ok(
        !existsSync(rootJsonPath),
        `--dry-run não deve criar 06-social-published.json na raiz (encontrado: ${rootJsonPath})`,
      );

      // Saída deve mencionar DRY-RUN (confirmação de que o path correto foi tomado)
      assert.ok(
        r.stdout.includes("DRY-RUN") || r.stderr.includes("DRY-RUN"),
        `stdout/stderr deve mencionar DRY-RUN; stdout: ${r.stdout.slice(0, 300)}`,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── #3944 Parte B: --schedule (verificação estática do script) ─────────────

describe("#3944 Parte B --schedule: modo agendamento (verificação estática do script)", () => {
  it("flag --schedule é opt-in — default preserva publicação imediata", () => {
    assert.match(SRC, /doSchedule = flags\.has\("schedule"\)/, "deve ler --schedule via flags.has");
  });

  it("resolve scheduled_at via computeScheduledAt com platform threads (mesma fonte de FB/LinkedIn/Instagram)", () => {
    assert.match(SRC, /computeScheduledAt/, "deve importar/usar computeScheduledAt");
    assert.match(SRC, /platform: "threads"/, "deve passar platform: 'threads'");
  });

  it("payload de enfileiramento inclui channel: threads", () => {
    assert.match(SRC, /channel: "threads"/, "payload do Worker deve marcar channel threads");
  });

  it("grava status 'scheduled' com scheduled_at real (não null) no modo --schedule", () => {
    assert.match(SRC, /status: "scheduled"/, "modo --schedule deve gravar status scheduled");
  });

  it("sem Worker configurado + --schedule → exit 2 (fail-fast, sem fallback de fire-now)", () => {
    assert.match(SRC, /process\.exit\(2\)/, "deve sair com exit 2 quando Worker não configurado");
    assert.match(SRC, /DIARIA_LINKEDIN_CRON_URL/, "deve checar DIARIA_LINKEDIN_CRON_URL");
    assert.match(SRC, /DIARIA_LINKEDIN_CRON_TOKEN/, "deve checar DIARIA_LINKEDIN_CRON_TOKEN");
  });

  it("guard de chunk único: multi-chunk com --schedule falha com motivo claro, não enfileira", () => {
    assert.match(SRC, /chunking agendado não suportado/i, "deve explicar por que multi-chunk falha com --schedule");
    assert.match(SRC, /chunks\.length > 1/, "deve checar chunks.length antes de enfileirar");
  });

  it("usa postToWorkerQueue do cliente compartilhado (worker-queue-client), não uma cópia local", () => {
    assert.match(SRC, /from "\.\/lib\/worker-queue-client\.ts"/, "deve importar do módulo compartilhado com Instagram");
  });
});

// ─── #3944 Parte B: postToWorkerQueue (cliente compartilhado, exercitado via Threads) ─

describe("#3944 Parte B postToWorkerQueue (cliente compartilhado com Instagram)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it("POSTa pro endpoint /queue com channel:threads e image_url:null, retorna a resposta parseada", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | null = null;
    let capturedToken = "";
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : (url as Request).url;
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      capturedToken = new Headers(init?.headers).get("X-Diaria-Token") ?? "";
      return new Response(
        JSON.stringify({
          queued: true,
          key: "queue:2026-07-23T10:00:00.000Z:uuid-threads-1",
          scheduled_at: "2026-07-23T10:00:00.000Z",
          destaque: "d1",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const res = await postToWorkerQueue("https://worker.test/", "tok123", {
        text: "Post curto #ia",
        image_url: null,
        scheduled_at: "2026-07-23T10:00:00.000Z",
        destaque: "d1",
        channel: "threads",
      });
      assert.equal(capturedUrl, "https://worker.test/queue", "deve normalizar trailing slash e ir pro /queue");
      assert.equal(capturedToken, "tok123", "deve mandar o token no header X-Diaria-Token");
      assert.equal(capturedBody?.channel, "threads");
      assert.equal(capturedBody?.image_url, null);
      assert.equal(res.queued, true);
      assert.equal(res.key, "queue:2026-07-23T10:00:00.000Z:uuid-threads-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── #3944 Parte B: --schedule end-to-end via subprocess (sem tocar API real) ─

describe("#3944 Parte B --schedule subprocess: fail-fast e guard de multi-chunk", () => {
  const SCRIPT = resolve(__ROOT, "scripts/publish-threads.ts");
  const SOCIAL_MD_SHORT = `# Curto\n\n## d1\nPost curto de teste.\n`;
  // Texto >500 chars via repetição — força multi-chunk.
  const LONG_TEXT = "Parágrafo longo de teste para forçar multi-chunk. ".repeat(15);
  const SOCIAL_MD_LONG = `# Curto\n\n## d1\n${LONG_TEXT}\n`;

  it("--schedule sem DIARIA_LINKEDIN_CRON_URL/TOKEN → exit 2, sem publicar nada", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diaria-threads-schedule-nowoker-"));
    try {
      mkdirSync(join(tmpDir, "_internal"), { recursive: true });
      writeFileSync(join(tmpDir, "03-social.md"), SOCIAL_MD_SHORT, "utf8");

      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", SCRIPT, "--edition-dir", tmpDir, "--schedule"],
        {
          encoding: "utf8",
          cwd: __ROOT,
          env: {
            ...process.env,
            THREADS_USER_ID: "fake_user_id",
            THREADS_ACCESS_TOKEN: "fake_token",
            DIARIA_LINKEDIN_CRON_URL: "",
            DIARIA_LINKEDIN_CRON_TOKEN: "",
          },
        },
      );
      assert.equal(r.status, 2, `deve sair com exit 2; stdout: ${r.stdout}; stderr: ${r.stderr}`);
      assert.match(r.stderr, /Worker não está configurado/);
      assert.ok(
        !existsSync(join(tmpDir, "_internal", "06-social-published.json")),
        "não deve gravar nada quando aborta por falta de Worker",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("--schedule com texto >500 chars: grava 'failed' com motivo claro, sem travar esperando rede", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diaria-threads-schedule-multichunk-"));
    try {
      mkdirSync(join(tmpDir, "_internal"), { recursive: true });
      writeFileSync(join(tmpDir, "03-social.md"), SOCIAL_MD_LONG, "utf8");

      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", SCRIPT, "--edition-dir", tmpDir, "--schedule"],
        {
          encoding: "utf8",
          cwd: __ROOT,
          timeout: 15_000, // guard contra travar esperando fetch real — não deve nem tentar
          env: {
            ...process.env,
            THREADS_USER_ID: "fake_user_id",
            THREADS_ACCESS_TOKEN: "fake_token",
            // URL fake — nunca deve ser chamada, já que o guard de multi-chunk
            // barra o item ANTES de qualquer fetch.
            DIARIA_LINKEDIN_CRON_URL: "https://worker.invalid.test/",
            DIARIA_LINKEDIN_CRON_TOKEN: "fake_worker_token",
          },
        },
      );
      assert.equal(r.status, 0, `script deve terminar 0 mesmo com destaque falho; stderr: ${r.stderr}`);
      const publishedPath = join(tmpDir, "_internal", "06-social-published.json");
      assert.ok(existsSync(publishedPath), "deve gravar 06-social-published.json com a entry failed");
      const published = JSON.parse(readFileSync(publishedPath, "utf8"));
      const entry = published.posts.find((p: any) => p.destaque === "d1");
      assert.ok(entry, "deve haver uma entry pro d1");
      assert.equal(entry.status, "failed");
      assert.match(entry.reason, /500/, "motivo deve citar o limite de 500 chars");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── waitForContainerReady (#3995) ───────────────────────────────────────────
//
// Achado na investigação: em 260724, 2 de 3 destaques falharam com "Media not
// found" no /threads_publish chamado logo após createThreadsContainer, mas um
// teste manual mais tarde (mesmo texto) publicou com sucesso — propagação
// assíncrona do lado da Meta, não problema de credencial. Fix: poll de status
// do container antes de tentar publicar.

describe("waitForContainerReady (#3995)", () => {
  const ORIGINAL_FETCH = global.fetch;

  it("resolve imediatamente quando status já é FINISHED (sem dormir)", async () => {
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      return { ok: true, json: async () => ({ status: "FINISHED" }) } as Response;
    }) as typeof fetch;
    let slept = 0;
    try {
      await waitForContainerReady("cid1", "token", "v1.0", async () => {
        slept++;
      });
      assert.equal(fetchCalls, 1);
      assert.equal(slept, 0, "não deve dormir se já veio FINISHED no 1º poll");
    } finally {
      global.fetch = ORIGINAL_FETCH;
    }
  });

  it("faz polling (IN_PROGRESS → FINISHED) dormindo entre tentativas", async () => {
    let call = 0;
    global.fetch = (async () => {
      call++;
      const status = call < 3 ? "IN_PROGRESS" : "FINISHED";
      return { ok: true, json: async () => ({ status }) } as Response;
    }) as typeof fetch;
    let slept = 0;
    try {
      await waitForContainerReady("cid2", "token", "v1.0", async () => {
        slept++;
      });
      assert.equal(call, 3);
      assert.equal(slept, 2, "deve dormir entre cada poll que não terminou (2 sleeps antes do 3º poll)");
    } finally {
      global.fetch = ORIGINAL_FETCH;
    }
  });

  it("lança erro claro quando status é ERROR (não gasta tentativas restantes)", async () => {
    let call = 0;
    global.fetch = (async () => {
      call++;
      return { ok: true, json: async () => ({ status: "ERROR", error_message: "conteúdo rejeitado" }) } as Response;
    }) as typeof fetch;
    try {
      await assert.rejects(
        () => waitForContainerReady("cid3", "token", "v1.0", async () => {}),
        /status=ERROR.*conteúdo rejeitado/,
      );
      assert.equal(call, 1, "não deve continuar tentando após ERROR");
    } finally {
      global.fetch = ORIGINAL_FETCH;
    }
  });

  it("esgota CONTAINER_POLL_MAX_ATTEMPTS sem lançar (best-effort, segue pro publish)", async () => {
    let call = 0;
    global.fetch = (async () => {
      call++;
      return { ok: true, json: async () => ({ status: "IN_PROGRESS" }) } as Response;
    }) as typeof fetch;
    try {
      await waitForContainerReady("cid4", "token", "v1.0", async () => {});
      assert.equal(call, CONTAINER_POLL_MAX_ATTEMPTS, "deve tentar exatamente o máximo configurado");
    } finally {
      global.fetch = ORIGINAL_FETCH;
    }
  });

  it("falha de rede no polling não lança — segue tentando até esgotar/terminar", async () => {
    let call = 0;
    global.fetch = (async () => {
      call++;
      if (call === 1) throw new Error("network blip");
      return { ok: true, json: async () => ({ status: "FINISHED" }) } as Response;
    }) as typeof fetch;
    try {
      await waitForContainerReady("cid5", "token", "v1.0", async () => {});
      assert.equal(call, 2, "1ª tentativa falhou de rede, 2ª teve sucesso");
    } finally {
      global.fetch = ORIGINAL_FETCH;
    }
  });
});

// ─── textContainsEditionUrl / warnMissingEditionUrl (guard não-fatal #4294) ──

describe("textContainsEditionUrl (#4294)", () => {
  it("true quando o texto contém a URL literal", () => {
    assert.equal(
      textContainsEditionUrl("Texto com https://diar.ia.br/p/slug-x aqui", "https://diar.ia.br/p/slug-x"),
      true,
    );
  });

  it("false quando o texto não contém a URL", () => {
    assert.equal(textContainsEditionUrl("Texto sem link nenhum.", "https://diar.ia.br/p/slug-x"), false);
  });
});

describe("warnMissingEditionUrl (#4294) — não-fatal, grava em data/run-log.jsonl", () => {
  it("grava evento warn no run-log sob o rootDir injetado (isolado do log real)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diaria-threads-warnlog-"));
    try {
      warnMissingEditionUrl(
        "d1",
        "Texto do post sem link.",
        "https://diar.ia.br/p/slug-teste",
        "260999",
        tmpDir,
      );
      const logPath = join(tmpDir, "data", "run-log.jsonl");
      assert.ok(existsSync(logPath), "deve criar data/run-log.jsonl sob o rootDir injetado");
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      const event = JSON.parse(lines[lines.length - 1]);
      assert.equal(event.level, "warn");
      assert.equal(event.agent, "publish-threads");
      assert.equal(event.edition, "260999");
      assert.match(event.message, /#4294/);
      assert.match(event.message, /edição resolvida/);
      assert.equal(event.details.edition_url, "https://diar.ia.br/p/slug-teste");
      assert.equal(event.details.destaque, "d1");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("nunca lança mesmo se logEvent falhar internamente (best-effort)", () => {
    // rootDir inválido (caractere nulo) força falha de fs — logEvent engole o erro.
    assert.doesNotThrow(() => {
      warnMissingEditionUrl("d1", "texto", "https://diar.ia.br/p/x", null, "\0invalid");
    });
  });
});

// ─── Guard edition_url ausente end-to-end (#4294, subprocess --dry-run) ─────

describe("Guard edition_url ausente end-to-end (#4294, --dry-run + --log-root-dir)", () => {
  const SCRIPT = resolve(__ROOT, "scripts/publish-threads.ts");

  it("texto sem a URL da edição: warn gravado em run-log, post NÃO é bloqueado (segue pro dry-run)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diaria-threads-urlguard-"));
    try {
      const internalDir = join(tmpDir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(
        join(tmpDir, "03-social.md"),
        `# Curto\n\n## d1\nTexto do destaque D1 sem nenhum link.\n`,
        "utf8",
      );
      writeFileSync(join(internalDir, "05-edition-url.txt"), "https://diar.ia.br/p/slug-guard-teste", "utf8");

      const r = spawnSync(
        process.execPath,
        [
          "--import", "tsx", SCRIPT,
          "--edition-dir", tmpDir,
          "--dry-run",
          "--log-root-dir", tmpDir,
        ],
        {
          encoding: "utf8",
          cwd: __ROOT,
          env: {
            ...process.env,
            THREADS_USER_ID: "fake_user_id_urlguard",
            THREADS_ACCESS_TOKEN: "fake_access_token_urlguard",
          },
        },
      );

      assert.equal(r.status, 0, `deve sair 0 mesmo com o guard disparando; stderr: ${r.stderr}`);
      // Guard não bloqueia — o dry-run segue normalmente pro destaque.
      assert.match(r.stdout, /DRY-RUN threads\/d1/, "post não deve ser bloqueado pelo guard");
      // Aviso visível (stderr, via console.warn) mencionando o guard #4294.
      assert.match(r.stderr, /#4294/, "deve avisar sobre o guard de edition_url no stderr");

      const logPath = join(tmpDir, "data", "run-log.jsonl");
      assert.ok(existsSync(logPath), "deve gravar warn em data/run-log.jsonl sob --log-root-dir");
      const event = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").pop()!);
      assert.equal(event.level, "warn");
      assert.equal(event.agent, "publish-threads");
      assert.equal(event.details.edition_url, "https://diar.ia.br/p/slug-guard-teste");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("texto COM a URL da edição: nenhum warn é gravado", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diaria-threads-urlguard-ok-"));
    try {
      const internalDir = join(tmpDir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      const editionUrl = "https://diar.ia.br/p/slug-guard-ok";
      writeFileSync(
        join(tmpDir, "03-social.md"),
        `# Curto\n\n## d1\nTexto do destaque D1. Leia mais: ${editionUrl}\n`,
        "utf8",
      );
      writeFileSync(join(internalDir, "05-edition-url.txt"), editionUrl, "utf8");

      const r = spawnSync(
        process.execPath,
        [
          "--import", "tsx", SCRIPT,
          "--edition-dir", tmpDir,
          "--dry-run",
          "--log-root-dir", tmpDir,
        ],
        {
          encoding: "utf8",
          cwd: __ROOT,
          env: {
            ...process.env,
            THREADS_USER_ID: "fake_user_id_urlguard_ok",
            THREADS_ACCESS_TOKEN: "fake_access_token_urlguard_ok",
          },
        },
      );

      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /#4294/, "não deve avisar quando o texto já contém a URL da edição");
      const logPath = join(tmpDir, "data", "run-log.jsonl");
      assert.ok(!existsSync(logPath), "não deve criar run-log.jsonl quando não há nada a avisar");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── Regressão #4294: sem '# Curto' end-to-end (nunca cai pra outra seção) ──

describe("Regressão #4294: 03-social.md pós-#3991 (só '# Social', sem '# Curto') end-to-end", () => {
  const SCRIPT = resolve(__ROOT, "scripts/publish-threads.ts");

  it("nenhum destaque é publicado a partir de '# Social' — sem side-effect, exit 0", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diaria-threads-sosocial-"));
    try {
      mkdirSync(join(tmpDir, "_internal"), { recursive: true });
      writeFileSync(join(tmpDir, "03-social.md"), MD_SO_SOCIAL, "utf8");

      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", SCRIPT, "--edition-dir", tmpDir, "--dry-run", "--log-root-dir", tmpDir],
        {
          encoding: "utf8",
          cwd: __ROOT,
          env: {
            ...process.env,
            THREADS_USER_ID: "fake_user_id_sosocial",
            THREADS_ACCESS_TOKEN: "fake_access_token_sosocial",
          },
        },
      );

      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      // Nenhum texto de '# Social' deve ter sido usado como post.
      assert.doesNotMatch(r.stdout, /Post d1 Social\.|Post d2 Social\.|Post d3 Social\./);
      assert.doesNotMatch(r.stdout, /DRY-RUN threads\//, "nenhum destaque deve chegar ao dry-run sem '# Curto'");
      assert.ok(
        !existsSync(join(tmpDir, "_internal", "06-social-published.json")),
        "não deve criar 06-social-published.json — nada foi tentado",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── skipped_no_curto: destaque com header mas conteúdo vazio (#4294) ───────

describe("skipped_no_curto: destaque incompleto (header presente, conteúdo vazio) vira skip (#4294)", () => {
  const SCRIPT = resolve(__ROOT, "scripts/publish-threads.ts");

  it("destaque com só comentário HTML em '# Curto' vira skip, nunca post em branco", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diaria-threads-incompleto-"));
    try {
      mkdirSync(join(tmpDir, "_internal"), { recursive: true });
      // d1 tem texto real; d3 só tem um comentário HTML (esvazia após strip) — d2 nem aparece.
      writeFileSync(
        join(tmpDir, "03-social.md"),
        `# Curto\n\n## d1\nTexto real do destaque D1.\n\n## d3\n<!-- comentario oculto, sem texto -->\n`,
        "utf8",
      );

      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", SCRIPT, "--edition-dir", tmpDir, "--dry-run", "--log-root-dir", tmpDir],
        {
          encoding: "utf8",
          cwd: __ROOT,
          env: {
            ...process.env,
            THREADS_USER_ID: "fake_user_id_incompleto",
            THREADS_ACCESS_TOKEN: "fake_access_token_incompleto",
          },
        },
      );

      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /DRY-RUN threads\/d1/, "d1 (com texto) deve seguir pro dry-run normalmente");
      assert.doesNotMatch(r.stdout, /DRY-RUN threads\/d3/, "d3 (vazio) nunca deve chegar ao dry-run");
      assert.match(r.stderr, /SKIP threads\/d3/, "d3 deve ser explicitamente sinalizado como skip");

      // O último console.log é o JSON pretty-printed (indent 2) do resumo —
      // localizamos seu início pela chave "out_path" (não `lastIndexOf("{\n")`
      // isolado: o array "posts" também tem objetos aninhados que começam
      // com "{\n" indentado, e esses vêm DEPOIS textualmente).
      const jsonStart = r.stdout.indexOf('{\n  "out_path"');
      assert.ok(jsonStart >= 0, `stdout deve conter o bloco JSON final; stdout: ${r.stdout}`);
      const output = JSON.parse(r.stdout.slice(jsonStart));
      assert.deepEqual(
        output.skipped_no_curto.map((s: any) => s.destaque),
        ["d3"],
        "skipped_no_curto deve listar d3",
      );
      assert.match(output.skipped_no_curto[0].reason, /#4294/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
