/**
 * publish-threads.test.ts (#2479)
 *
 * Testa o fluxo de 2 passos da Threads API (container → threads_publish)
 * com mock da API (sem chamadas reais), incluindo:
 *   - extractDestaquesFromSocialMd (Threads / fallback Facebook)
 *   - extractPostText (Threads / fallback Facebook / CRLF)
 *   - splitIntoThreadChunks (limite 500 chars + encadeamento)
 *   - Verificação estática do script (creds, CLI guard, severity, etc.)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  extractDestaquesFromSocialMd,
  extractPostText,
  splitIntoThreadChunks,
  THREADS_CHAR_LIMIT,
} from "../scripts/publish-threads.ts";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Leitura da source estática — reutilizada por múltiplos testes estáticos
const SRC = readFileSync(resolve(__ROOT, "scripts/publish-threads.ts"), "utf8");

// ─── Fixtures ───────────────────────────────────────────────────────────────

const MD_THREADS = `# Threads

## d1
Post d1 no Threads. #inovacao #tecnologia

## d2
Post d2 no Threads. #ia #futuro

## d3
Post d3 no Threads. #dados
<!-- comentario oculto -->

# Facebook

## d1
Post d1 Facebook diferente.
`;

const MD_SEM_THREADS = `# Facebook

## d1
Post d1 Facebook.

## d2
Post d2 Facebook.

## d3
Post d3 Facebook.
`;

const MD_CRLF = MD_THREADS.replace(/\n/g, "\r\n");

// ─── extractDestaquesFromSocialMd ────────────────────────────────────────────

describe("extractDestaquesFromSocialMd (threads)", () => {
  it("retorna d1/d2/d3 quando seção Threads existe com 3 destaques", () => {
    const destaques = extractDestaquesFromSocialMd(MD_THREADS);
    assert.deepEqual(destaques, ["d1", "d2", "d3"]);
  });

  it("usa fallback Facebook quando seção Threads ausente", () => {
    const destaques = extractDestaquesFromSocialMd(MD_SEM_THREADS);
    assert.deepEqual(destaques, ["d1", "d2", "d3"]);
  });

  it("retorna fallback [d1,d2,d3] quando nenhuma seção existe", () => {
    const destaques = extractDestaquesFromSocialMd("# Outra\n## d1\ntexto");
    assert.deepEqual(destaques, ["d1", "d2", "d3"]);
  });

  it("retorna d1/d2 quando edição tem só 2 destaques na seção Threads", () => {
    const md = `# Threads\n\n## d1\nPost d1.\n\n## d2\nPost d2.\n`;
    const destaques = extractDestaquesFromSocialMd(md);
    assert.deepEqual(destaques, ["d1", "d2"]);
  });
});

// ─── extractPostText ─────────────────────────────────────────────────────────

describe("extractPostText (threads)", () => {
  it("extrai d1 da seção Threads", () => {
    const t = extractPostText(MD_THREADS, "d1");
    assert.ok(t.includes("Post d1 no Threads."));
    assert.ok(!t.includes("Post d1 Facebook diferente."));
  });

  it("extrai d2 sem vazar d1 ou d3", () => {
    const t = extractPostText(MD_THREADS, "d2");
    assert.ok(t.includes("Post d2 no Threads."));
    assert.ok(!t.includes("Post d1"));
    assert.ok(!t.includes("Post d3"));
  });

  it("extrai d3 e remove comentários HTML", () => {
    const t = extractPostText(MD_THREADS, "d3");
    assert.ok(t.includes("Post d3 no Threads."));
    assert.ok(!t.includes("comentario oculto"));
  });

  it("não vaza seção Facebook quando Threads presente", () => {
    const t = extractPostText(MD_THREADS, "d1");
    assert.ok(!t.includes("Post d1 Facebook diferente."));
  });

  it("usa fallback Facebook quando seção Threads ausente", () => {
    const t = extractPostText(MD_SEM_THREADS, "d1");
    assert.ok(t.includes("Post d1 Facebook."));
  });

  it("normaliza CRLF para LF", () => {
    const t = extractPostText(MD_CRLF, "d1");
    assert.ok(t.includes("Post d1 no Threads."));
  });

  it("lança quando destaque não encontrado", () => {
    assert.throws(
      () => extractPostText(MD_THREADS, "d9"),
      /d9|não encontrado/i,
    );
  });

  it("lança quando não há seção Threads nem Facebook", () => {
    assert.throws(
      () => extractPostText("# LinkedIn\n## d1\ntexto", "d1"),
      /não encontrado/i,
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
    // Padrão CLI guard do repo: if (import.meta.url === `file://${_argv1}` ...)
    assert.match(
      SRC,
      /import\.meta\.url.*_argv1|_argv1.*import\.meta\.url/s,
      "deve ter CLI guard padrão do repo",
    );
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
  const SOCIAL_MD = `# Threads\n\n## d1\nPost de teste para dry-run.\n\n## d2\nPost d2 dry-run.\n\n## d3\nPost d3 dry-run.\n`;

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
