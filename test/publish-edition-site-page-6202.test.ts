/**
 * test/publish-edition-site-page-6202.test.ts (#6202)
 *
 * Invariantes:
 *
 * 1. **Falhar aqui nunca pode derrubar a edição.** Publicar no site é
 *    acessório ao envio; todo caminho ruim vira código != 0 com motivo, e a
 *    Etapa 6 trata como warning.
 * 2. **Nunca gerar página de slug inválido.** `new-post` é lixo real do
 *    cache (achado ao vivo no #6167) — deixá-lo passar criaria a página que o
 *    próprio gerador do acervo se recusa a criar. O mesmo vale para um slug
 *    que só vira `/`/`..` DEPOIS de decodificado (#6202 review, problema 5).
 * 3. **REGRESSÃO DO P0:** `post_url` nunca está populado em
 *    `05-published.json` no momento em que o Stage 6 chama este passo — sem
 *    `--slug`, o passo tinha virado um no-op permanente e silencioso. A
 *    implementação REAL de `readEditionInputs` (não mockada) contra uma
 *    fixture no formato real do §8 do playbook prova que isso está corrigido.
 * 4. **Publicar é `git commit` + `push`, nunca `wrangler deploy` local**
 *    (#6202 review, problema 3) — o deploy real acontece via CI em push a
 *    master (`.github/workflows/deploy-site.yml`).
 * 5. **GUARD de merge tag não resolvida (#6202, achado P0 do fleet review
 *    não incorporado à PR #6209).** `buildArchivePageHtml` (o MESMO usado
 *    pelo gerador do acervo, `lib/site-archive-pages.ts`) já recusa HTML com
 *    `{{...}}` não resolvido via `UnresolvedMergeTagError` (guard entregue
 *    sob #6210/#6256, PRs #6214/#6255/#6260 — confirmado no histórico antes
 *    deste branch existir). O que faltava — e é o que este arquivo cobre a
 *    partir daqui — é `publishEditionSitePage` reconhecer esse tipo
 *    ESPECÍFICO de erro e mapear pra um exit code PRÓPRIO (`5`) com mensagem
 *    acionável, em vez de cair no balde genérico `3` ("render falhou"), que
 *    mistura bug de código com recusa deliberada de publicação. Não
 *    reimplementa detecção — reusa o guard existente, escopo estritamente de
 *    wiring + exit code dedicado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEditionArchivePost,
  extractSlugFromPostUrl,
  wrapFragmentAsDocument,
} from "../scripts/lib/edition-site-page.ts";
import {
  publishEditionSitePage,
  readEditionInputs,
  commitAndPushSitePage,
  productionDeps,
  createExecFileSyncLockRunner,
  needsShellForNpx,
  writeSitePageState,
  EditionInputsInvalid,
  type PublishPageDeps,
  type PublishPageResult,
  type GitRunner,
  type GhRunner,
  type LockRunner,
  type SleepFn,
} from "../scripts/publish-edition-site-page.ts";
import type { EditionPageInputs } from "../scripts/lib/edition-site-page.ts";

const INPUTS: EditionPageInputs = {
  html: "<p>corpo da edição</p>",
  postUrl: "https://diar.ia.br/p/titulo-da-edicao",
  title: "Título da edição",
  subtitle: "Subtítulo",
  publishedAtIso: "2026-08-27T09:00:00Z",
};

/**
 * lock de teste (#6626), escopo de módulo — usado tanto pelas suítes de
 * `commitAndPushSitePage` quanto de `productionDeps`. Por padrão concede na
 * 1ª tentativa, sempre; `ok` por chamada (`acquireResults`) permite simular
 * negação/retry sem tocar o subprocesso real. Nunca chama
 * `session-registry.ts` de verdade.
 */
function makeLock(acquireResults: boolean[] = []) {
  const calls: string[][] = [];
  let acquireCall = 0;
  const lock: LockRunner = (args) => {
    calls.push(args);
    if (args[0] === "merge-lock-acquire") {
      const ok = acquireCall < acquireResults.length ? acquireResults[acquireCall] : true;
      acquireCall++;
      return { ok, stdout: ok ? "ok\n" : "", stderr: ok ? "" : "denied (held by another session)\n" };
    }
    return { ok: true, stdout: "ok\n", stderr: "" };
  };
  return { lock, calls };
}

/** sleep de teste — nunca dorme de verdade, só registra que foi chamado. */
function makeSleep() {
  const calls: number[] = [];
  const sleep: SleepFn = (ms) => {
    calls.push(ms);
  };
  return { sleep, calls };
}

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

  describe("guard pós-decode (#6202 review, problema 5)", () => {
    it("rejeita %2F que só vira barra DEPOIS de decodificado", () => {
      assert.equal(extractSlugFromPostUrl("https://diar.ia.br/p/a%2F..%2Fsecret"), null);
    });

    it("rejeita %2E%2E%2F (`..` inteiramente codificado)", () => {
      assert.equal(extractSlugFromPostUrl("https://diar.ia.br/p/%2E%2E%2Fsecret"), null);
    });

    it("rejeita `..` misturado com barra codificada", () => {
      assert.equal(extractSlugFromPostUrl("https://diar.ia.br/p/..%2Fsecret"), null);
    });

    it("rejeita barra invertida pós-decode", () => {
      assert.equal(extractSlugFromPostUrl("https://diar.ia.br/p/a%5Cb"), null);
    });

    it("slug legítimo com pontos (não `..`) continua aceito", () => {
      assert.equal(extractSlugFromPostUrl("https://diar.ia.br/p/v2.5-lancamento"), "v2.5-lancamento");
    });
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
  contarPublishes(): number;
}

function makeDeps(over: Partial<PublishPageDeps> = {}): Harness {
  const escritas: { slug: string; html: string }[] = [];
  let publishes = 0;
  const deps: PublishPageDeps = {
    readEditionInputs: () => INPUTS,
    writePage: (slug, html) => void escritas.push({ slug, html }),
    publish: () => {
      publishes++;
      return { pushed: true, prUrl: "https://github.com/vjpixel/diaria-studio/pull/1", prNumber: 1, prCreated: true };
    },
    log: () => {},
    ...over,
  };
  return { deps, escritas, contarPublishes: () => publishes };
}

describe("#6202 publishEditionSitePage — fail-soft em todo caminho ruim", () => {
  it("caminho feliz: escreve e publica (commit+push)", () => {
    const { deps, escritas } = makeDeps();
    const r = publishEditionSitePage("/x", deps);
    assert.equal(r.code, 0);
    if (r.code === 0) {
      assert.equal(r.slug, "titulo-da-edicao");
      assert.equal(r.published, true);
    }
    assert.equal(escritas.length, 1);
    assert.match(escritas[0].html, /<html/i, "saiu pelo buildArchivePageHtml, documento completo");
  });

  it("--skip-publish escreve mas NÃO publica", () => {
    const { deps, escritas } = makeDeps();
    const r = publishEditionSitePage("/x", deps, { skipPublish: true });
    assert.equal(r.code, 0);
    if (r.code === 0) assert.equal(r.published, false);
    assert.equal(escritas.length, 1, "a página é escrita mesmo assim");
  });

  it("edição sem artefatos ⇒ code 2 (não é erro, é 'nada a publicar')", () => {
    const { deps } = makeDeps({ readEditionInputs: () => null });
    const r = publishEditionSitePage("/x", deps);
    assert.equal(r.code, 2);
  });

  it("leitura lança erro genérico ⇒ code 3, sem escrever nada", () => {
    const { deps, escritas } = makeDeps({
      readEditionInputs: () => {
        throw new Error("JSON inválido");
      },
    });
    const r = publishEditionSitePage("/x", deps);
    assert.equal(r.code, 3);
    assert.equal(escritas.length, 0);
  });

  it("leitura lança EditionInputsInvalid ⇒ code 4 (artefato presente, conteúdo inválido)", () => {
    const { deps, escritas } = makeDeps({
      readEditionInputs: () => {
        throw new EditionInputsInvalid("sem post_url e sem --slug");
      },
    });
    const r = publishEditionSitePage("/x", deps);
    assert.equal(r.code, 4);
    if (r.code === 4) assert.match(r.reason, /post_url/);
    assert.equal(escritas.length, 0);
  });

  it("slug inválido (buildEditionArchivePost recusa) ⇒ code 4, NUNCA escreve página", () => {
    const { deps, escritas } = makeDeps({
      readEditionInputs: () => ({ ...INPUTS, postUrl: "https://diar.ia.br/p/new-post" }),
    });
    const r = publishEditionSitePage("/x", deps);
    assert.equal(r.code, 4, "artefato presente (readEditionInputs resolveu) mas conteúdo inválido — não é o 2 benigno");
    assert.equal(escritas.length, 0, "página de slug lixo nunca é criada");
  });

  it("escrita falha ⇒ code 3, sem tentar publicar", () => {
    let publishChamado = false;
    const { deps } = makeDeps({
      writePage: () => {
        throw new Error("EACCES");
      },
      publish: () => {
        publishChamado = true;
        return { pushed: true, prCreated: true };
      },
    });
    const r = publishEditionSitePage("/x", deps);
    assert.equal(r.code, 3);
    assert.equal(publishChamado, false, "não adianta publicar o que não foi escrito");
  });

  it("REGRESSÃO: commit/push falha ⇒ code 3, mas a página FICA escrita", () => {
    // O trabalho não se perde: a próxima rodada/push manual leva a página
    // junto. Por isso a mensagem diz isso explicitamente.
    const { deps, escritas } = makeDeps({
      publish: () => {
        throw new Error("git: non-fast-forward");
      },
    });
    const r = publishEditionSitePage("/x", deps);
    assert.equal(r.code, 3);
    if (r.code === 3) assert.match(r.reason, /ficou escrita localmente/);
    assert.equal(escritas.length, 1, "a escrita local sobrevive à falha de publicação");
  });

  it("nenhum caminho lança — a Etapa 6 nunca cai por causa deste passo", () => {
    const explosivos: Partial<PublishPageDeps>[] = [
      {
        readEditionInputs: () => {
          throw new Error("x");
        },
      },
      {
        writePage: () => {
          throw new Error("x");
        },
      },
      {
        publish: () => {
          throw new Error("x");
        },
      },
    ];
    for (const over of explosivos) {
      const { deps } = makeDeps(over);
      assert.doesNotThrow(() => publishEditionSitePage("/x", deps));
    }
  });

  it("idempotência: publicar 2× com a mesma entrada não duplica página nem quebra", () => {
    const { deps, escritas } = makeDeps();
    const r1 = publishEditionSitePage("/x", deps);
    const r2 = publishEditionSitePage("/x", deps);
    assert.equal(r1.code, 0);
    assert.equal(r2.code, 0);
    assert.equal(escritas.length, 2, "cada chamada escreve — a idempotência real vive em commitAndPushSitePage");
    assert.deepEqual(escritas[0], escritas[1], "mesmo slug, mesmo html nas duas chamadas");
    if (r1.code === 0 && r2.code === 0) assert.equal(r1.slug, r2.slug);
  });

  it("REGRESSÃO P1-B: publish() não lança mas não confirma push ⇒ code 0, published:false (nunca inferido de ausência de exceção)", () => {
    const { deps } = makeDeps({ publish: () => ({ pushed: false, prCreated: false }) });
    const r = publishEditionSitePage("/x", deps);
    assert.equal(r.code, 0);
    if (r.code === 0) assert.equal(r.published, false, "published só é true quando publish() confirma o push");
  });

  describe("GUARD (#6202): UnresolvedMergeTagError ⇒ code 5, nada escrito/publicado", () => {
    it("merge tag DESCONHECIDA (não coberta pelo sanitize de {{email}}/{{email_address_id}}) ⇒ code 5", () => {
      // {{first_name}} é o mesmo fixture usado em
      // test/gen-archive-pages.test.ts pro guard #6256 — não é uma tag real
      // do pipeline diário, só ilustra "qualquer tag que o sanitize não
      // cobre" (o caso motivador real seria o backend Kit, `{{
      // subscriber.email_address }}`, que também não está na whitelist).
      const { deps, escritas, contarPublishes } = makeDeps({
        readEditionInputs: () => ({ ...INPUTS, html: "<p>Olá {{first_name}}, bem-vindo</p>" }),
      });
      const r = publishEditionSitePage("/x", deps);
      assert.equal(r.code, 5);
      if (r.code === 5) {
        assert.deepEqual(r.tags, ["{{first_name}}"]);
        assert.match(r.reason, /\{\{first_name\}\}/);
        assert.match(r.reason, /6210/, "aponta pra onde a decisão de fundo é tomada, sem tomá-la aqui");
      }
      assert.equal(escritas.length, 0, "falha fechada: NADA escrito em disco");
      assert.equal(contarPublishes(), 0, "e nada commitado/publicado");
    });

    it("2 tags diferentes, uma repetida ⇒ `tags` deduplicado (mesmo dedup de UnresolvedMergeTagError)", () => {
      const { deps } = makeDeps({
        readEditionInputs: () => ({
          ...INPUTS,
          html: "<p>{{first_name}} e {{first_name}} de novo, e {{last_name}}</p>",
        }),
      });
      const r = publishEditionSitePage("/x", deps);
      assert.equal(r.code, 5);
      if (r.code === 5) assert.deepEqual(r.tags, ["{{first_name}}", "{{last_name}}"]);
    });

    it("REGRESSÃO — não regride o caso PADRÃO: `?email={{email}}` (link de voto Beehiiv) publica normalmente, code 0", () => {
      // A tag mais comum do pipeline (presente em toda edição Beehiiv) é
      // sanitizada DENTRO de buildArchivePageHtml antes deste guard rodar —
      // não deveria disparar `5`. Ver docstring do módulo (exit code 5) e
      // `buildArchivePageHtml — link de voto com merge tag padrão` em
      // test/gen-archive-pages.test.ts.
      const { deps, escritas } = makeDeps({
        readEditionInputs: () => ({
          ...INPUTS,
          html: '<p><a href="https://joga.diar.ia.br/vote/260827/A?email={{email}}">Vote</a></p>',
        }),
      });
      const r = publishEditionSitePage("/x", deps);
      assert.equal(r.code, 0, "a tag padrão do voto é sanitizada, não rejeitada — não deveria virar 5");
      assert.equal(escritas.length, 1);
      assert.ok(!escritas[0].html.includes("{{email}}"), "a tag crua não sobrevive na página publicada");
    });

    it("caso não relacionado (título vazio) continua code 4 — o novo `instanceof` não engoliu códigos existentes", () => {
      // buildEditionArchivePost já recusa título vazio (code 4) antes de
      // buildArchivePageHtml rodar — este teste existe só pra deixar
      // explícito que o guard novo (5) não engoliu nenhum dos códigos
      // existentes (2/3/4) por engano de `instanceof`.
      const { deps } = makeDeps({ readEditionInputs: () => ({ ...INPUTS, title: "" }) });
      const r = publishEditionSitePage("/x", deps);
      assert.equal(r.code, 4, "título vazio continua code 4, não foi capturado pelo novo ramo");
    });
  });
});

describe("#6202 readEditionInputs — implementação REAL contra fixture (regressão do P0)", () => {
  // Formato de `_internal/05-published.json` que o §8 do
  // `beehiiv-playbook.md` de fato produz neste ponto do pipeline: tem
  // `draft_url`/`post_id`, NUNCA `post_url` (só `refresh-dedup.ts` grava
  // isso, no dia seguinte). Reproduzir esse formato exato é o que garante
  // que este teste teria pego o bug original — a suíte anterior só
  // exercitava `readEditionInputs` MOCKADO, por isso o P0 passou.
  function makeFixtureEditionDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "diaria-site-page-6202-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "newsletter-final.html"), "<p>corpo real da edição</p>", "utf8");
    writeFileSync(
      join(dir, "_internal", "05-published.json"),
      JSON.stringify(
        {
          draft_url: "https://app.beehiiv.com/posts/post_abc123/edit",
          title: "...",
          subject_set: "...",
          template_used: "Default",
          test_email_sent_to: "vjpixel@gmail.com",
          test_email_sent_at: "2026-08-27T12:34:56.789Z",
          status: "scheduled",
          post_id: "post_abc123",
          scheduled_at: "2026-08-28T09:00:00.000Z",
          unfixed_issues: [],
          test_email_count: 1,
          draft_verified: true,
          // POR DESIGN: sem `post_url` — é exatamente o que o Stage 6 vê
          // na prática antes do refresh-dedup do dia seguinte.
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(
      join(dir, "02-reviewed.md"),
      ["TÍTULO", "Título real da fixture", "", "SUBTÍTULO", "Subtítulo real"].join("\n"),
      "utf8",
    );
    return dir;
  }

  it("sem --slug ⇒ code 4 (é isto que teria pego o P0 antes do fix)", () => {
    const dir = makeFixtureEditionDir();
    try {
      const deps: PublishPageDeps = {
        readEditionInputs,
        writePage: () => {
          throw new Error("não deveria escrever nada neste caminho");
        },
        publish: () => {
          throw new Error("não deveria publicar nada neste caminho");
        },
        log: () => {},
      };
      const r = publishEditionSitePage(dir, deps);
      assert.equal(r.code, 4, "sem --slug e sem post_url, o passo é um no-op — mas AGORA visível (4), não silencioso (2)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("com slugOverride ⇒ resolve normal, sem depender de post_url", () => {
    const dir = makeFixtureEditionDir();
    try {
      const escritas: { slug: string; html: string }[] = [];
      const deps: PublishPageDeps = {
        readEditionInputs,
        writePage: (slug, html) => void escritas.push({ slug, html }),
        publish: () => ({ pushed: true, prCreated: true, prUrl: "https://github.com/vjpixel/diaria-studio/pull/2" }),
        log: () => {},
      };
      const r = publishEditionSitePage(dir, deps, { slug: "titulo-real-da-fixture" });
      assert.equal(r.code, 0);
      if (r.code === 0) assert.equal(r.slug, "titulo-real-da-fixture");
      assert.equal(escritas.length, 1);
      assert.ok(escritas[0].html.includes("corpo real da edição"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readEditionInputs direto: slugOverride vence mesmo se post_url estivesse presente", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-site-page-6202-override-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "newsletter-final.html"), "<p>x</p>", "utf8");
      writeFileSync(
        join(dir, "_internal", "05-published.json"),
        JSON.stringify({ post_url: "https://diar.ia.br/p/slug-antigo" }),
        "utf8",
      );
      const inputs = readEditionInputs(dir, "slug-novo-do-get-post");
      assert.ok(inputs);
      assert.equal(inputs!.postUrl, "https://diar.ia.br/p/slug-novo-do-get-post");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arquivos ausentes ⇒ null (code 2, benigno) mesmo com --slug", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-site-page-6202-empty-"));
    try {
      assert.equal(readEditionInputs(dir, "qualquer-slug"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("REGRESSÃO P2-F: backend Kit não pode virar no-op silencioso permanente", () => {
    function makeKitLikeEditionDir(): string {
      // newsletter-final.html existe (pré-render é backend-agnóstico) MAS
      // 05-published.json NUNCA existe em edição Kit — ela escreve
      // newsletter-kit-published.json em vez disso.
      const dir = mkdtempSync(join(tmpdir(), "diaria-site-page-6202-kit-"));
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "newsletter-final.html"), "<p>corpo Kit</p>", "utf8");
      return dir;
    }

    function makeRootWithBackend(backend: string): string {
      const rootDir = mkdtempSync(join(tmpdir(), "diaria-site-page-6202-root-"));
      writeFileSync(
        join(rootDir, "platform.config.json"),
        JSON.stringify({ publishing: { newsletter: { backend } } }),
        "utf8",
      );
      return rootDir;
    }

    it("backend kit, sem --slug ⇒ lança EditionInputsInvalid nomeando a lacuna (não mais null/code 2 silencioso)", () => {
      const dir = makeKitLikeEditionDir();
      const rootDir = makeRootWithBackend("kit");
      try {
        assert.throws(
          () => readEditionInputs(dir, undefined, rootDir),
          (err: unknown) => err instanceof EditionInputsInvalid && /Kit/.test((err as Error).message),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("#7420: backend kit, COM --slug ⇒ resolve normalmente, SEM depender de 05-published.json", () => {
      const dir = makeKitLikeEditionDir();
      const rootDir = makeRootWithBackend("kit");
      try {
        // Achado ao vivo na edição 260904: antes do #7420, `slugOverride`
        // não bastava — o guard `!htmlExists || !publishedExists` devolvia
        // null (code 2) mesmo com --slug passado, contradizendo a própria
        // instrução de §6d-site ("passe --slug explicitamente"). Agora
        // `slugOverride` ignora `05-published.json` por completo.
        const result = readEditionInputs(dir, "um-slug-qualquer", rootDir);
        assert.deepEqual(result, {
          html: "<p>corpo Kit</p>",
          postUrl: "https://diar.ia.br/p/um-slug-qualquer",
          title: "",
          subtitle: null,
          publishedAtIso: null,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("backend beehiiv (default) com o mesmo estado de arquivos ⇒ continua null benigno (code 2)", () => {
      const dir = makeKitLikeEditionDir();
      const rootDir = makeRootWithBackend("beehiiv");
      try {
        assert.equal(readEditionInputs(dir, undefined, rootDir), null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("#7420: --slug bypassa 05-published.json ausente independente do backend (beehiiv também)", () => {
      const dir = makeKitLikeEditionDir();
      const rootDir = makeRootWithBackend("beehiiv");
      try {
        const result = readEditionInputs(dir, "outro-slug", rootDir);
        assert.deepEqual(result, {
          html: "<p>corpo Kit</p>",
          postUrl: "https://diar.ia.br/p/outro-slug",
          title: "",
          subtitle: null,
          publishedAtIso: null,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });
});

describe("#6202/#6598 commitAndPushSitePage — branch dedicada + PR, nunca push direto em master", () => {
  /**
   * git de teste com defaults sãos (branch master, HEAD == origin/master —
   * guard do #7287 passa por padrão —, sem staged alheio, status limpo).
   * `rev-parse` tem 2 formas de chamada desde o #7287: `--abbrev-ref HEAD`
   * (nome da branch, só usado pro checkout de volta) e `HEAD origin/master`
   * (1 chamada, 2 revs — o guard em si). Um override para a chave
   * `"rev-parse"` recebe TODAS as chamadas de rev-parse (a função decide
   * com base em `args`), pra permitir simular as duas formas com valores
   * diferentes quando o teste precisar.
   */
  function makeGit(overrides: Partial<Record<string, (args: string[]) => string>> = {}) {
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push(args);
      const cmd = args[0];
      if (overrides[cmd]) return overrides[cmd]!(args);
      if (cmd === "rev-parse") {
        if (args[1] === "--abbrev-ref") return "master\n";
        // `rev-parse HEAD origin/master`: mesmo commit por padrão — guard passa.
        return "deadbeef\ndeadbeef\n";
      }
      if (cmd === "status") return "";
      if (cmd === "diff") return "";
      return "";
    };
    return { git, calls };
  }

  /** gh de teste com defaults sãos: nenhum PR aberto ainda, `pr create` devolve uma URL. */
  function makeGh(overrides: Partial<Record<string, (args: string[]) => string>> = {}) {
    const calls: string[][] = [];
    const gh: GhRunner = (args) => {
      calls.push(args);
      const cmd = args.slice(0, 2).join(" ");
      if (overrides[cmd]) return overrides[cmd]!(args);
      if (cmd === "pr list") return "[]";
      if (cmd === "pr create") return "https://github.com/vjpixel/diaria-studio/pull/9999\n";
      return "";
    };
    return { gh, calls };
  }

  it("caminho feliz: checkout -B, add, status, diff, commit, push, checkout de volta — nesta ordem", () => {
    const { git, calls } = makeGit({
      status: () => " M workers/site/public/p/abc/index.html\n",
      diff: () => "workers/site/public/p/abc/index.html\n",
    });
    const { gh } = makeGh();
    const r = commitAndPushSitePage("/repo", "abc", git, undefined, gh, makeLock().lock, makeSleep().sleep);
    assert.equal(r.committed, true);
    assert.equal(r.pushed, true);
    assert.equal(r.prCreated, true);
    assert.equal(r.prUrl, "https://github.com/vjpixel/diaria-studio/pull/9999");
    assert.deepEqual(
      calls.map((c) => c[0]),
      // #7287: 2 rev-parse agora — abbrev-ref (nome, pro checkout de volta) +
      // HEAD/origin-master (o guard em si, por commit).
      ["rev-parse", "rev-parse", "checkout", "add", "status", "diff", "commit", "push", "checkout"],
    );
    const revParseCall = calls[0];
    const guardCall = calls[1];
    const checkoutBack = calls[calls.length - 1];
    assert.deepEqual(revParseCall, ["rev-parse", "--abbrev-ref", "HEAD"]);
    assert.deepEqual(guardCall, ["rev-parse", "HEAD", "origin/master"]);
    assert.deepEqual(checkoutBack, ["checkout", "master"]);
  });

  it("checkout -B usa a branch determinística site-publish/{slug} — nunca toca master diretamente", () => {
    const { git, calls } = makeGit({
      status: () => " M workers/site/public/p/abc/index.html\n",
      diff: () => "workers/site/public/p/abc/index.html\n",
    });
    const { gh } = makeGh();
    commitAndPushSitePage("/repo", "abc", git, undefined, gh, makeLock().lock, makeSleep().sleep);
    const checkoutB = calls.find((c) => c[0] === "checkout" && c[1] === "-B")!;
    assert.deepEqual(checkoutB, ["checkout", "-B", "site-publish/abc"]);
    const push = calls.find((c) => c[0] === "push")!;
    assert.deepEqual(push, ["push", "--force-with-lease", "-u", "origin", "site-publish/abc"]);
    assert.ok(!calls.some((c) => c[0] === "push" && c.includes("master")), "nunca empurra pra master");
  });

  it("commit é escopado ao pathspec da página, nunca o índice inteiro (#6202 review P1-A)", () => {
    const { git, calls } = makeGit({
      status: () => " M workers/site/public/p/abc/index.html\n",
      diff: () => "workers/site/public/p/abc/index.html\n",
    });
    const { gh } = makeGh();
    commitAndPushSitePage("/repo", "abc", git, undefined, gh, makeLock().lock, makeSleep().sleep);
    const commitCall = calls.find((c) => c[0] === "commit")!;
    assert.deepEqual(commitCall.slice(-2), ["--", "workers/site/public/p/abc"]);
  });

  it("REGRESSÃO P1-A: staged alheio fora do pathspec ⇒ lança, NÃO commita (checkout compartilhado, #5156)", () => {
    const { git, calls } = makeGit({
      status: () => " M workers/site/public/p/abc/index.html\n",
      // `git diff --cached --name-only` mostra um arquivo de outra sessão além
      // do nosso — cenário real de `git add` alheio no mesmo checkout.
      diff: () => "workers/site/public/p/abc/index.html\nscripts/algum-arquivo-de-outra-sessao.ts\n",
    });
    const { gh } = makeGh();
    assert.throws(() => commitAndPushSitePage("/repo", "abc", git, undefined, gh, makeLock().lock, makeSleep().sleep), /algum-arquivo-de-outra-sessao\.ts/);
    assert.ok(!calls.some((c) => c[0] === "commit"), "nunca commita quando há staged alheio");
    assert.ok(!calls.some((c) => c[0] === "push"), "nunca empurra quando o commit foi abortado");
    assert.deepEqual(calls[calls.length - 1], ["checkout", "master"], "volta pro branch original mesmo em erro");
  });

  it("2ª chamada sem mudança pula o commit, MAS ainda tenta o push (idempotente, sem commit vazio)", () => {
    const calls: string[][] = [];
    let statusCallCount = 0;
    const git: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === "rev-parse") {
        if (args[1] === "--abbrev-ref") return "master\n";
        return "deadbeef\ndeadbeef\n";
      }
      if (args[0] === "status") {
        statusCallCount++;
        return statusCallCount === 1 ? " M workers/site/public/p/abc/index.html\n" : "";
      }
      if (args[0] === "diff") return "workers/site/public/p/abc/index.html\n";
      return "";
    };
    const { gh } = makeGh();
    const r1 = commitAndPushSitePage("/repo", "abc", git, undefined, gh, makeLock().lock, makeSleep().sleep);
    const r2 = commitAndPushSitePage("/repo", "abc", git, undefined, gh, makeLock().lock, makeSleep().sleep);
    assert.equal(r1.committed, true);
    assert.equal(r2.committed, false, "sem diff no path, não há o que comitar");
    assert.equal(r2.pushed, true, "push ainda roda mesmo sem commit novo nesta chamada");
    assert.equal(
      calls.filter((c) => c[0] === "commit").length,
      1,
      "2ª chamada não gera commit vazio",
    );
    assert.equal(calls.filter((c) => c[0] === "push").length, 2, "push é tentado nas 2 chamadas");
  });

  it("REGRESSÃO P1-B: commit sem push (rodada anterior) ⇒ 2ª chamada com status limpo AINDA tenta o push", () => {
    // Reproduz o cenário do finding: um commit já existe localmente (de uma
    // rodada anterior cujo push falhou), então `status --porcelain` já sai
    // limpo — mas o push nunca aconteceu. A chamada precisa tentar de novo.
    const pushCalls: string[][] = [];
    const git: GitRunner = (args) => {
      if (args[0] === "rev-parse") {
        if (args[1] === "--abbrev-ref") return "master\n";
        return "deadbeef\ndeadbeef\n";
      }
      if (args[0] === "status") return ""; // limpo: nada novo pra commitar
      if (args[0] === "push") {
        pushCalls.push(args);
        return "";
      }
      return "";
    };
    const { gh } = makeGh();
    const r = commitAndPushSitePage("/repo", "abc", git, undefined, gh, makeLock().lock, makeSleep().sleep);
    assert.equal(r.committed, false, "nada novo a commitar");
    assert.equal(r.pushed, true, "mas o push roda mesmo assim");
    assert.equal(pushCalls.length, 1, "push foi de fato tentado, não pulado por status limpo");
  });

  it("REGRESSÃO P1-C→#7287: HEAD != origin/master (checkout divergente) ⇒ lança, sem checkout/add/commit/push", () => {
    const { git, calls } = makeGit({
      "rev-parse": (args) => {
        if (args[1] === "--abbrev-ref") return "overnight/algo\n";
        return "commitantigo1\ncommitnovo22\n"; // HEAD diverge de origin/master
      },
    });
    const { gh } = makeGh();
    assert.throws(
      () => commitAndPushSitePage("/repo", "abc", git, undefined, gh, makeLock().lock, makeSleep().sleep),
      /commitantigo1/,
    );
    assert.equal(
      calls.length,
      2,
      "para no 2º rev-parse (o guard por commit) — nunca chega a tocar working tree/index/branch",
    );
  });

  it("REGRESSÃO #7287: branch local NÃO se chama 'master', mas HEAD == origin/master ⇒ publica normalmente", () => {
    // O caso medido ao vivo em 03/09/2026: `master` estava tomada por outro
    // worktree, então o checkout compartilhado (com o CONTEÚDO exato de
    // origin/master) vivia numa branch de nome diferente — o guard antigo
    // (por NOME) recusava aqui; o guard novo (por COMMIT) tem que passar.
    const { git, calls } = makeGit({
      "rev-parse": (args) => {
        if (args[1] === "--abbrev-ref") return "site-publish-master-worktree-elsewhere\n";
        return "mesmocommit1\nmesmocommit1\n"; // HEAD == origin/master
      },
      status: () => " M workers/site/public/p/abc/index.html\n",
      diff: () => "workers/site/public/p/abc/index.html\n",
    });
    const { gh } = makeGh();
    const r = commitAndPushSitePage("/repo", "abc", git, undefined, gh, makeLock().lock, makeSleep().sleep);
    assert.equal(r.pushed, true, "publica mesmo com branch local != 'master', desde que o commit bata");
    const checkoutBack = calls[calls.length - 1];
    assert.deepEqual(
      checkoutBack,
      ["checkout", "site-publish-master-worktree-elsewhere"],
      "volta pro branch ORIGINAL (nome não-master), nunca força 'master'",
    );
  });

  it("REGRESSÃO #7287 (defensivo): saída malformada de 'git rev-parse HEAD origin/master' (menos de 2 linhas) ⇒ lança com mensagem clara, nunca 'undefined' cru", () => {
    // Cobre o ramo `!headCommit || !originMasterCommit` do guard — nunca
    // exercitado pelos testes acima, que sempre fornecem 2 linhas bem
    // formadas. Simula uma saída de `git` vazia/truncada (ex: `origin/master`
    // não existe localmente e alguma versão de git imprime menos linhas em
    // vez de lançar) — o guard precisa recusar, não seguir com
    // headCommit/originMasterCommit undefined.
    const { git, calls } = makeGit({
      "rev-parse": (args) => {
        if (args[1] === "--abbrev-ref") return "master\n";
        return ""; // saída vazia — split("\n") após trim produz [""], só 1 elemento
      },
    });
    const { gh } = makeGh();
    assert.throws(
      () => commitAndPushSitePage("/repo", "abc", git, undefined, gh, makeLock().lock, makeSleep().sleep),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, /não está sincronizado com origin\/master/);
        assert.doesNotMatch(msg, /\bundefined\b/, "nunca imprime 'undefined' cru — usa o fallback '?'");
        return true;
      },
    );
    assert.equal(calls.length, 2, "para no guard, antes de checkout/add/commit/push");
  });

  it("REGRESSÃO #7287 (defensivo): 2ª linha (origin/master) vem vazia em saída de 3 linhas ⇒ lança (guard não confia em string vazia como commit válido)", () => {
    // `.trim()` só afeta as bordas da string inteira — uma linha vazia no
    // MEIO da saída sobrevive ao split. Aqui a saída tem 3 linhas
    // ("abc123", "", "def456"); a destructuring `[headCommit,
    // originMasterCommit]` só pega as 2 primeiras, então
    // originMasterCommit === "" (falsy) — cenário diferente do teste
    // anterior (saída truncada pra 1 linha só).
    const { git } = makeGit({
      "rev-parse": (args) => {
        if (args[1] === "--abbrev-ref") return "master\n";
        return "abc123\n\ndef456\n";
      },
    });
    const { gh } = makeGh();
    assert.throws(
      () => commitAndPushSitePage("/repo", "abc", git, undefined, gh, makeLock().lock, makeSleep().sleep),
      /não está sincronizado com origin\/master/,
    );
  });

  it("push que lança propaga — chamador decide (vira code 3 em publishEditionSitePage) — e volta pro master mesmo assim", () => {
    const { git, calls } = makeGit({
      status: () => " M x\n",
      diff: () => "workers/site/public/p/abc\n",
      push: () => {
        throw new Error("non-fast-forward");
      },
    });
    const { gh } = makeGh();
    assert.throws(() => commitAndPushSitePage("/repo", "abc", git, undefined, gh, makeLock().lock, makeSleep().sleep), /non-fast-forward/);
    assert.deepEqual(
      calls[calls.length - 1],
      ["checkout", "master"],
      "finally sempre volta pro branch original, mesmo quando o push lança",
    );
  });

  it("PR já aberto pra essa branch ⇒ reusa, não cria um 2º (nunca duplica)", () => {
    const { git } = makeGit({
      status: () => " M x\n",
      diff: () => "workers/site/public/p/abc\n",
    });
    const { gh, calls: ghCalls } = makeGh({
      "pr list": () => JSON.stringify([{ number: 42, url: "https://github.com/vjpixel/diaria-studio/pull/42" }]),
    });
    const r = commitAndPushSitePage("/repo", "abc", git, undefined, gh, makeLock().lock, makeSleep().sleep);
    assert.equal(r.prCreated, false, "PR existente reusado, não criado de novo");
    assert.equal(r.prNumber, 42);
    assert.equal(r.prUrl, "https://github.com/vjpixel/diaria-studio/pull/42");
    assert.ok(!ghCalls.some((c) => c[0] === "pr" && c[1] === "create"), "nunca chama pr create quando já existe um aberto");
  });

  it("nunca chama wrangler nem git push origin master — mecanismo é branch + PR", () => {
    const { git, calls } = makeGit({ status: () => " M x\n", diff: () => "workers/site/public/p/abc\n" });
    const { gh } = makeGh();
    commitAndPushSitePage("/repo", "abc", git, undefined, gh, makeLock().lock, makeSleep().sleep);
    for (const c of calls) {
      assert.notEqual(c[0], "wrangler");
      if (c[0] === "push") assert.ok(!c.includes("master"), "push nunca referencia master diretamente");
    }
  });

  describe("#6626 merge lock cross-sessão em torno da troca de checkout", () => {
    it("adquire o lock ANTES do checkout -B e libera DEPOIS do checkout de volta — nesta ordem", () => {
      const order: string[] = [];
      const { git } = makeGit({
        status: () => " M workers/site/public/p/abc/index.html\n",
        diff: () => "workers/site/public/p/abc/index.html\n",
      });
      const trackedGit: GitRunner = (args, cwd) => {
        order.push(`git:${args[0]}${args[1] === "-B" ? ":-B" : ""}`);
        return git(args, cwd);
      };
      const { gh } = makeGh();
      const { lock: rawLock } = makeLock();
      const trackedLock: LockRunner = (args, cwd) => {
        order.push(`lock:${args[0]}`);
        return rawLock(args, cwd);
      };
      const { sleep } = makeSleep();

      commitAndPushSitePage("/repo", "abc", trackedGit, undefined, gh, trackedLock, sleep);

      const acquireIdx = order.indexOf("lock:merge-lock-acquire");
      const checkoutBIdx = order.indexOf("git:checkout:-B");
      const checkoutBackIdx = order.lastIndexOf("git:checkout");
      const releaseIdx = order.indexOf("lock:merge-lock-release");

      assert.ok(acquireIdx !== -1 && checkoutBIdx !== -1 && checkoutBackIdx !== -1 && releaseIdx !== -1);
      assert.ok(acquireIdx < checkoutBIdx, "lock adquirido antes do checkout -B");
      assert.ok(checkoutBackIdx < releaseIdx, "checkout de volta acontece antes do lock ser liberado");
      // O `rev-parse` inicial não precisa do lock — só lê a branch atual.
      assert.equal(order[0], "git:rev-parse", "rev-parse roda antes de qualquer acquire");
    });

    it("libera o lock mesmo quando o push lança (finally cobre erro no meio da janela)", () => {
      const { git } = makeGit({
        status: () => " M x\n",
        diff: () => "workers/site/public/p/abc\n",
        push: () => {
          throw new Error("non-fast-forward");
        },
      });
      const { gh } = makeGh();
      const { lock, calls: lockCalls } = makeLock();
      const { sleep } = makeSleep();

      assert.throws(() => commitAndPushSitePage("/repo", "abc", git, undefined, gh, lock, sleep), /non-fast-forward/);

      assert.ok(lockCalls.some((c) => c[0] === "merge-lock-acquire"), "lock foi adquirido");
      assert.ok(lockCalls.some((c) => c[0] === "merge-lock-release"), "lock foi liberado mesmo com o push lançando");
    });

    it("lock negado nas 2 primeiras tentativas, concedido na 3ª ⇒ segue normalmente, com retry entre elas", () => {
      const { git } = makeGit({
        status: () => " M x\n",
        diff: () => "workers/site/public/p/abc\n",
      });
      const { gh } = makeGh();
      const { lock, calls: lockCalls } = makeLock([false, false, true]);
      const { sleep, calls: sleepCalls } = makeSleep();

      const r = commitAndPushSitePage("/repo", "abc", git, undefined, gh, lock, sleep);

      assert.equal(r.pushed, true);
      assert.equal(
        lockCalls.filter((c) => c[0] === "merge-lock-acquire").length,
        3,
        "3 tentativas de acquire — nega, nega, concede",
      );
      assert.equal(sleepCalls.length, 2, "dorme entre a 1ª e 2ª, e entre a 2ª e 3ª tentativa — nunca após a última");
    });

    it("lock negado em TODAS as tentativas ⇒ lança, sem tocar checkout/commit/push (#6626)", () => {
      const { git, calls: gitCalls } = makeGit({
        status: () => " M x\n",
        diff: () => "workers/site/public/p/abc\n",
      });
      const { gh } = makeGh();
      const { lock, calls: lockCalls } = makeLock([false, false, false]);
      const { sleep } = makeSleep();

      assert.throws(
        () => commitAndPushSitePage("/repo", "abc", git, undefined, gh, lock, sleep),
        /merge lock não adquirido/,
      );

      assert.equal(
        lockCalls.filter((c) => c[0] === "merge-lock-acquire").length,
        3,
        "esgota as 3 tentativas, nunca mais",
      );
      assert.ok(!lockCalls.some((c) => c[0] === "merge-lock-release"), "nunca libera um lock que não adquiriu");
      assert.deepEqual(
        gitCalls.map((c) => c[0]),
        // #7287: 2 rev-parse (abbrev-ref + guard por commit) rodam ANTES do
        // acquire do lock — inalterado por este achado, só a contagem muda.
        ["rev-parse", "rev-parse"],
        "para nos rev-parse — nunca chega a fazer checkout -B/add/commit/push quando o lock esgota",
      );
    });

    it("#6703 achado 1: lock falha por ERRO DE INFRA (não denied) ⇒ mensagem NÃO afirma 'outra sessão detém o lock'", () => {
      const { git, calls: gitCalls } = makeGit({
        status: () => " M x\n",
        diff: () => "workers/site/public/p/abc\n",
      });
      const { gh } = makeGh();
      // Simula `npx tsx` quebrado/script ausente/timeout — `ok: false` sem
      // "denied" em stdout/stderr, diferente de contenção genuína.
      const lock: LockRunner = () => ({ ok: false, stdout: "", stderr: "spawnSync npx ENOENT" });
      const { sleep } = makeSleep();

      assert.throws(() => commitAndPushSitePage("/repo", "abc", git, undefined, gh, lock, sleep), (err: unknown) => {
        const msg = (err as Error).message;
        assert.doesNotMatch(msg, /outra sessão detém/, "não deve afirmar contenção quando a causa é infra");
        assert.match(msg, /erro de infra/i, "deve nomear a causa real como erro de infra");
        assert.match(msg, /ENOENT/, "preserva o detalhe original do stderr");
        return true;
      });
      assert.deepEqual(
        gitCalls.map((c) => c[0]),
        ["rev-parse", "rev-parse"],
        "nunca chega a tocar checkout/commit/push quando o lock falha por infra",
      );
    });

    it("#6703 achado 3: checkout de volta lança ⇒ releaseSitePublishLock AINDA roda (lock não vaza)", () => {
      const { git: baseGit } = makeGit({
        status: () => " M x\n",
        diff: () => "workers/site/public/p/abc\n",
      });
      const git: GitRunner = (args, cwd) => {
        // O checkout de VOLTA (2º argumento é o nome da branch original, não
        // "-B") lança — simula conflito/I/O/branch removida por outra sessão.
        if (args[0] === "checkout" && args[1] === "master") {
          throw new Error("fatal: cannot lock ref (checkout de volta falhou)");
        }
        return baseGit(args, cwd);
      };
      const { gh } = makeGh();
      const { lock, calls: lockCalls } = makeLock();
      const { sleep } = makeSleep();

      // A função NÃO deve lançar — o erro do checkout de volta é capturado
      // internamente (loga um aviso), nunca mascara o resultado do
      // commit/push que já teve sucesso.
      const r = commitAndPushSitePage("/repo", "abc", git, undefined, gh, lock, sleep);
      assert.equal(r.pushed, true, "commit/push já tinha sucedido antes do checkout de volta falhar");
      assert.ok(lockCalls.some((c) => c[0] === "merge-lock-acquire"), "lock foi adquirido");
      assert.ok(
        lockCalls.some((c) => c[0] === "merge-lock-release"),
        "REGRESSÃO: release roda mesmo quando o checkout de volta lança — sem isto o lock só sairia pelo TTL",
      );
    });

    it("#6703 achado 2: renova o lock antes de cada round-trip de rede da janela longa (push, gh pr list/create)", () => {
      const { git } = makeGit({
        status: () => " M workers/site/public/p/abc/index.html\n",
        diff: () => "workers/site/public/p/abc/index.html\n",
      });
      const { gh } = makeGh();
      const order: string[] = [];
      const { lock: rawLock } = makeLock();
      const trackedLock: LockRunner = (args, cwd) => {
        order.push(args[0]);
        return rawLock(args, cwd);
      };
      const { sleep } = makeSleep();

      commitAndPushSitePage("/repo", "abc", git, undefined, gh, trackedLock, sleep);

      const renewCount = order.filter((a) => a === "merge-lock-renew").length;
      assert.ok(renewCount >= 2, `esperava pelo menos 2 renovações na janela longa, teve ${renewCount}`);
      const acquireIdx = order.indexOf("merge-lock-acquire");
      const firstRenewIdx = order.indexOf("merge-lock-renew");
      const releaseIdx = order.indexOf("merge-lock-release");
      assert.ok(acquireIdx < firstRenewIdx, "1ª renovação acontece depois do acquire");
      assert.ok(order.lastIndexOf("merge-lock-renew") < releaseIdx, "renovações acontecem antes do release final");
    });
  });
});

describe("#6202 productionDeps — fiação real (#6202 review P2-G)", () => {
  it("writePage escreve de verdade no disco (fs real, não mockado)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-site-page-6202-prod-"));
    try {
      const deps = productionDeps(dir);
      deps.writePage("meu-slug", "<html><body>oi</body></html>");
      const written = readFileSync(join(dir, "workers", "site", "public", "p", "meu-slug", "index.html"), "utf8");
      assert.equal(written, "<html><body>oi</body></html>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publish() amarra corretamente com um GitRunner + GhRunner injetados (branch+PR reais simulados)", () => {
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === "rev-parse") {
        if (args[1] === "--abbrev-ref") return "master\n";
        return "deadbeef\ndeadbeef\n";
      }
      if (args[0] === "status") return " M workers/site/public/p/meu-slug/index.html\n";
      if (args[0] === "diff") return "workers/site/public/p/meu-slug/index.html\n";
      return "";
    };
    const ghCalls: string[][] = [];
    const gh: GhRunner = (args) => {
      ghCalls.push(args);
      if (args.slice(0, 2).join(" ") === "pr list") return "[]";
      if (args.slice(0, 2).join(" ") === "pr create") return "https://github.com/vjpixel/diaria-studio/pull/1\n";
      return "";
    };
    const deps = productionDeps("/repo", git, gh, makeLock().lock, makeSleep().sleep);
    const result = deps.publish("meu-slug");
    assert.equal(result.pushed, true);
    assert.equal(result.prCreated, true);
    assert.equal(result.prUrl, "https://github.com/vjpixel/diaria-studio/pull/1");
    assert.deepEqual(
      calls.map((c) => c[0]),
      ["rev-parse", "rev-parse", "checkout", "add", "status", "diff", "commit", "push", "checkout"],
    );
    assert.ok(
      ghCalls.some((c) => c[0] === "pr" && c[1] === "create"),
      "productionDeps amarra o GhRunner até gh pr create",
    );
  });

  it("publish() propaga falha do GitRunner injetado (commit divergente de origin/master, #7287)", () => {
    const git: GitRunner = (args) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "outra-branch\n";
      if (args[0] === "rev-parse") return "aaa1111\nbbb2222\n"; // HEAD != origin/master
      return "";
    };
    const deps = productionDeps("/repo", git);
    assert.throws(() => deps.publish("meu-slug"), /aaa1111/);
  });
});

describe("#7283 writeSitePageState — teste DIRETO (achado do review do #7311: cobertura anterior era só indireta via checkSitePagePublished fabricando o JSON à mão)", () => {
  let dir: string;

  function readState(d: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(d, "_internal", "site-page-published.json"), "utf8"));
  }

  it("code:0 published:true com prUrl — grava o shape completo, checked_at é ISO parseável", () => {
    dir = mkdtempSync(join(tmpdir(), "diaria-site-page-state-"));
    try {
      const result: PublishPageResult = {
        code: 0,
        slug: "titulo-da-edicao",
        bytes: 1234,
        published: true,
        prUrl: "https://github.com/vjpixel/diaria-studio/pull/1",
      };
      writeSitePageState(dir, result);
      const state = readState(dir);
      assert.equal(state.code, 0);
      assert.equal(state.slug, "titulo-da-edicao");
      assert.equal(state.published, true);
      assert.equal(state.prUrl, "https://github.com/vjpixel/diaria-studio/pull/1");
      assert.ok(!("reason" in state), "reason ausente do result não vira chave no JSON (undefined é dropado)");
      assert.ok(
        typeof state.checked_at === "string" && !Number.isNaN(Date.parse(state.checked_at as string)),
        "checked_at precisa ser ISO parseável",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("code:0 published:false (--skip-publish) — published fica false, sem prUrl", () => {
    dir = mkdtempSync(join(tmpdir(), "diaria-site-page-state-"));
    try {
      const result: PublishPageResult = { code: 0, slug: "abc", bytes: 10, published: false };
      writeSitePageState(dir, result);
      const state = readState(dir);
      assert.equal(state.code, 0);
      assert.equal(state.published, false);
      assert.ok(!("prUrl" in state));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("code:2/3/4 (reason, sem slug) — published cai no default false, reason preservado, slug ausente", () => {
    for (const code of [2, 3, 4] as const) {
      dir = mkdtempSync(join(tmpdir(), "diaria-site-page-state-"));
      try {
        const result = { code, reason: `motivo do code ${code}` } as PublishPageResult;
        writeSitePageState(dir, result);
        const state = readState(dir);
        assert.equal(state.code, code);
        assert.equal(state.reason, `motivo do code ${code}`);
        assert.equal(
          state.published,
          false,
          "'published' não está no result ⇒ default false, nunca undefined/true por engano",
        );
        assert.ok(!("slug" in state));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("code:5 (guard de merge tag) — reason preservado, published:false (tags do result não vazam pro state — fora do schema)", () => {
    dir = mkdtempSync(join(tmpdir(), "diaria-site-page-state-"));
    try {
      const result: PublishPageResult = { code: 5, reason: "merge tag não resolvida: {{foo}}", tags: ["foo"] };
      writeSitePageState(dir, result);
      const state = readState(dir);
      assert.equal(state.code, 5);
      assert.equal(state.published, false);
      assert.match(state.reason as string, /merge tag não resolvida/);
      assert.ok(!("tags" in state), "campo 'tags' não faz parte do schema de site-page-published.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("2ª chamada SOBRESCREVE — reflete só a ÚLTIMA tentativa (mesma convenção de 05-published.json)", () => {
    dir = mkdtempSync(join(tmpdir(), "diaria-site-page-state-"));
    try {
      writeSitePageState(dir, { code: 3, reason: "falhou na 1ª tentativa" });
      writeSitePageState(dir, { code: 0, slug: "abc", bytes: 5, published: true });
      const state = readState(dir);
      assert.equal(state.code, 0, "reflete a 2ª chamada, não acumula/mescla com a 1ª");
      assert.equal(state.published, true);
      assert.ok(!("reason" in state), "reason da 1ª tentativa não vaza pra 2ª chamada");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cria _internal/ se ainda não existir (mkdirSync recursive)", () => {
    dir = mkdtempSync(join(tmpdir(), "diaria-site-page-state-"));
    try {
      // Sem criar _internal/ antes — writeSitePageState precisa criar sozinho.
      writeSitePageState(dir, { code: 2, reason: "nada a publicar ainda" });
      const state = readState(dir);
      assert.equal(state.code, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REGRESSÃO fail-soft: falha ao escrever (ex: '_internal' já existe como ARQUIVO, não diretório) nunca lança", () => {
    dir = mkdtempSync(join(tmpdir(), "diaria-site-page-state-"));
    try {
      // `_internal` já existe como arquivo comum — mkdirSync(..., {recursive:true})
      // lança ENOTDIR/EEXIST nesse caso. writeSitePageState precisa engolir isso
      // (loga aviso em stderr) e NUNCA propagar — mascarar o `result` real que
      // já foi computado e impresso seria pior que perder só o estado auxiliar.
      writeFileSync(join(dir, "_internal"), "não sou um diretório");
      assert.doesNotThrow(() => writeSitePageState(dir, { code: 0, slug: "abc", bytes: 1, published: true }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#6630 defaultLockRunner nunca trava indefinidamente", () => {
  it("passa timeout: 60_000 pro execFileSync — mesmo valor de merge-train-live.ts:107", () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const fakeExec = (
      _cmd: string,
      _args: string[],
      options: { cwd: string; stdio: ["ignore", "pipe", "pipe"]; timeout: number },
    ) => {
      capturedOptions = options as unknown as Record<string, unknown>;
      return Buffer.from("ok");
    };
    const runner = createExecFileSyncLockRunner(fakeExec);
    const result = runner(["merge-lock-acquire"], "/repo");

    assert.ok(capturedOptions, "o exec injetado foi de fato chamado");
    assert.equal(capturedOptions?.timeout, 60_000, "timeout precisa bater com merge-train-live.ts (60s)");
    assert.equal(result.ok, true);
  });

  it("timeout do subprocesso cai no branch catch — vira { ok: false }, não lança", () => {
    const timeoutError = Object.assign(new Error("ETIMEDOUT"), {
      status: null,
      stdout: Buffer.from(""),
      stderr: Buffer.from("spawnSync npx ETIMEDOUT"),
    });
    const fakeExec = () => {
      throw timeoutError;
    };
    const runner = createExecFileSyncLockRunner(fakeExec);
    const result = runner(["merge-lock-acquire"], "/repo");

    assert.equal(result.ok, false);
    assert.match(result.stderr, /ETIMEDOUT/);
  });
});

describe("#6899 execFileSync('npx', ...) precisa de shell:true no Windows", () => {
  it("needsShellForNpx é true só em win32 — puro, sem tocar process.platform real", () => {
    assert.equal(needsShellForNpx("win32"), true);
    assert.equal(needsShellForNpx("linux"), false);
    assert.equal(needsShellForNpx("darwin"), false);
  });

  it("platform win32: createExecFileSyncLockRunner passa shell:true pro exec injetado", () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const fakeExec = (
      _cmd: string,
      _args: string[],
      options: { cwd: string; stdio: ["ignore", "pipe", "pipe"]; timeout: number; shell?: boolean },
    ) => {
      capturedOptions = options as unknown as Record<string, unknown>;
      return Buffer.from("ok");
    };
    const runner = createExecFileSyncLockRunner(fakeExec, "win32");
    const result = runner(["merge-lock-acquire"], "/repo");

    assert.equal(capturedOptions?.shell, true, "sem shell:true, execFileSync('npx',...) lança ENOENT no Windows");
    assert.equal(result.ok, true);
  });

  it("platform linux/darwin: createExecFileSyncLockRunner NÃO passa shell — evita risco de escaping à toa", () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const fakeExec = (
      _cmd: string,
      _args: string[],
      options: { cwd: string; stdio: ["ignore", "pipe", "pipe"]; timeout: number; shell?: boolean },
    ) => {
      capturedOptions = options as unknown as Record<string, unknown>;
      return Buffer.from("ok");
    };
    const runner = createExecFileSyncLockRunner(fakeExec, "linux");
    runner(["merge-lock-acquire"], "/repo");

    assert.equal(capturedOptions?.shell, undefined);
  });

  it("regressão: ENOENT sem detalhe (stdout/stderr undefined) é exatamente o sintoma reportado no #6899", () => {
    // Reproduz o erro real de execFileSync('npx', ...) sem shell:true no
    // Windows — err.stdout/err.stderr ficam undefined, daí a mensagem "sem
    // detalhe" no halt do Stage 6. O fix (shell:true) evita que esse catch
    // dispare; este teste documenta o formato do erro que o fix elimina.
    const enoentError = Object.assign(new Error("spawnSync npx ENOENT"), {
      status: null,
      errno: -4058,
      code: "ENOENT",
      stdout: undefined,
      stderr: undefined,
    });
    const fakeExec = () => {
      throw enoentError;
    };
    const runner = createExecFileSyncLockRunner(fakeExec, "win32");
    const result = runner(["merge-lock-acquire"], "/repo");

    assert.equal(result.ok, false);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
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
