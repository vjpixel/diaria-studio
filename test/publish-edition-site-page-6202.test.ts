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
  EditionInputsInvalid,
  type PublishPageDeps,
  type GitRunner,
} from "../scripts/publish-edition-site-page.ts";
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
      return { pushed: true };
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
        return { pushed: true };
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
    const { deps } = makeDeps({ publish: () => ({ pushed: false }) });
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

    it("erro de render que NÃO é UnresolvedMergeTagError continua caindo no code 3 genérico (sem título ⇒ falha ANTES de chegar em buildArchivePageHtml)", () => {
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
        publish: () => ({ pushed: true }),
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

    it("backend kit, COM --slug ⇒ ainda cai no null benigno (slug não resolve o arquivo faltante de qualquer forma)", () => {
      const dir = makeKitLikeEditionDir();
      const rootDir = makeRootWithBackend("kit");
      try {
        // Com slugOverride, o guard do P2-F não entra em ação — mas o
        // arquivo 05-published.json continua ausente, então o caminho antigo
        // (`!htmlExists || !publishedExists`) devolve null (code 2) mesmo
        // assim. Documentado aqui pra não regredir: o guard é só pra
        // DIAGNÓSTICO do caso mudo, não uma segunda fonte de slug pro Kit.
        assert.equal(readEditionInputs(dir, "um-slug-qualquer", rootDir), null);
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
  });
});

describe("#6202 commitAndPushSitePage — publicar é git commit+push, nunca wrangler deploy", () => {
  /** git de teste com defaults sãos (branch master, sem staged alheio, status limpo). */
  function makeGit(overrides: Partial<Record<string, (args: string[]) => string>> = {}) {
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push(args);
      const cmd = args[0];
      if (overrides[cmd]) return overrides[cmd]!(args);
      if (cmd === "rev-parse") return "master\n";
      if (cmd === "status") return "";
      if (cmd === "diff") return "";
      return "";
    };
    return { git, calls };
  }

  it("caminho feliz: add, status, diff, commit e push, nesta ordem", () => {
    const { git, calls } = makeGit({
      status: () => " M workers/site/public/p/abc/index.html\n",
      diff: () => "workers/site/public/p/abc/index.html\n",
    });
    const r = commitAndPushSitePage("/repo", "abc", git);
    assert.equal(r.committed, true);
    assert.equal(r.pushed, true);
    assert.deepEqual(
      calls.map((c) => c[0]),
      ["rev-parse", "add", "status", "diff", "commit", "push"],
    );
  });

  it("commit é escopado ao pathspec da página, nunca o índice inteiro (#6202 review P1-A)", () => {
    const { git, calls } = makeGit({
      status: () => " M workers/site/public/p/abc/index.html\n",
      diff: () => "workers/site/public/p/abc/index.html\n",
    });
    commitAndPushSitePage("/repo", "abc", git);
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
    assert.throws(() => commitAndPushSitePage("/repo", "abc", git), /algum-arquivo-de-outra-sessao\.ts/);
    assert.ok(!calls.some((c) => c[0] === "commit"), "nunca commita quando há staged alheio");
    assert.ok(!calls.some((c) => c[0] === "push"), "nunca empurra quando o commit foi abortado");
  });

  it("2ª chamada sem mudança pula o commit, MAS ainda tenta o push (idempotente, sem commit vazio)", () => {
    const calls: string[][] = [];
    let statusCallCount = 0;
    const git: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === "rev-parse") return "master\n";
      if (args[0] === "status") {
        statusCallCount++;
        return statusCallCount === 1 ? " M workers/site/public/p/abc/index.html\n" : "";
      }
      if (args[0] === "diff") return "workers/site/public/p/abc/index.html\n";
      return "";
    };
    const r1 = commitAndPushSitePage("/repo", "abc", git);
    const r2 = commitAndPushSitePage("/repo", "abc", git);
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
      if (args[0] === "rev-parse") return "master\n";
      if (args[0] === "status") return ""; // limpo: nada novo pra commitar
      if (args[0] === "push") {
        pushCalls.push(args);
        return "";
      }
      return "";
    };
    const r = commitAndPushSitePage("/repo", "abc", git);
    assert.equal(r.committed, false, "nada novo a commitar");
    assert.equal(r.pushed, true, "mas o push roda mesmo assim");
    assert.equal(pushCalls.length, 1, "push foi de fato tentado, não pulado por status limpo");
  });

  it("REGRESSÃO P1-C: branch != master ⇒ lança, sem add/commit/push (#6202 review)", () => {
    const { git, calls } = makeGit({ "rev-parse": () => "overnight/algo\n" });
    assert.throws(() => commitAndPushSitePage("/repo", "abc", git), /overnight\/algo/);
    assert.equal(calls.length, 1, "para no rev-parse — nunca chega a tocar working tree/index");
  });

  it("push que lança propaga — chamador decide (vira code 3 em publishEditionSitePage)", () => {
    const { git } = makeGit({
      status: () => " M x\n",
      diff: () => "workers/site/public/p/abc\n",
      push: () => {
        throw new Error("non-fast-forward");
      },
    });
    assert.throws(() => commitAndPushSitePage("/repo", "abc", git), /non-fast-forward/);
  });

  it("nunca chama wrangler — mecanismo é só git", () => {
    const { git, calls } = makeGit({ status: () => " M x\n", diff: () => "workers/site/public/p/abc\n" });
    commitAndPushSitePage("/repo", "abc", git);
    for (const c of calls) assert.notEqual(c[0], "wrangler");
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

  it("publish() amarra corretamente com um GitRunner injetado (commit+push reais simulados)", () => {
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === "rev-parse") return "master\n";
      if (args[0] === "status") return " M workers/site/public/p/meu-slug/index.html\n";
      if (args[0] === "diff") return "workers/site/public/p/meu-slug/index.html\n";
      return "";
    };
    const deps = productionDeps("/repo", git);
    const result = deps.publish("meu-slug");
    assert.equal(result.pushed, true);
    assert.deepEqual(
      calls.map((c) => c[0]),
      ["rev-parse", "add", "status", "diff", "commit", "push"],
    );
  });

  it("publish() propaga falha do GitRunner injetado (branch errada)", () => {
    const git: GitRunner = (args) => (args[0] === "rev-parse" ? "outra-branch\n" : "");
    const deps = productionDeps("/repo", git);
    assert.throws(() => deps.publish("meu-slug"), /outra-branch/);
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
