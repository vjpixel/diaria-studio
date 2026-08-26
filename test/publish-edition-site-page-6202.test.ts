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
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
    publish: () => void publishes++,
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
      publish: () => void (publishChamado = true),
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
        publish: () => {},
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
});

describe("#6202 commitAndPushSitePage — publicar é git commit+push, nunca wrangler deploy", () => {
  it("caminho feliz: add, commit e push, nesta ordem", () => {
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === "status") return " M workers/site/public/p/abc/index.html\n";
      return "";
    };
    const r = commitAndPushSitePage("/repo", "abc", git);
    assert.equal(r.changed, true);
    assert.deepEqual(
      calls.map((c) => c[0]),
      ["add", "status", "commit", "push"],
    );
  });

  it("2ª chamada sem mudança pula commit/push (idempotente, sem commit vazio)", () => {
    const calls: string[][] = [];
    let statusCallCount = 0;
    const git: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === "status") {
        statusCallCount++;
        return statusCallCount === 1 ? " M workers/site/public/p/abc/index.html\n" : "";
      }
      return "";
    };
    const r1 = commitAndPushSitePage("/repo", "abc", git);
    const r2 = commitAndPushSitePage("/repo", "abc", git);
    assert.equal(r1.changed, true);
    assert.equal(r2.changed, false, "sem diff no path, não há o que comitar");
    assert.equal(
      calls.filter((c) => c[0] === "commit").length,
      1,
      "2ª chamada não gera commit vazio",
    );
    assert.equal(calls.filter((c) => c[0] === "push").length, 1);
  });

  it("push que lança propaga — chamador decide (vira code 3 em publishEditionSitePage)", () => {
    const git: GitRunner = (args) => {
      if (args[0] === "status") return " M x\n";
      if (args[0] === "push") throw new Error("non-fast-forward");
      return "";
    };
    assert.throws(() => commitAndPushSitePage("/repo", "abc", git), /non-fast-forward/);
  });

  it("nunca chama wrangler — mecanismo é só git", () => {
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === "status") return " M x\n";
      return "";
    };
    commitAndPushSitePage("/repo", "abc", git);
    for (const c of calls) assert.notEqual(c[0], "wrangler");
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
