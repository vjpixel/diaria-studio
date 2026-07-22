import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  reconcilePost,
  verifyPublished,
  inferIsPublished,
  defaultFetchPost,
  resolveSocialPublishedPath,
  resolveGraphPostId,
  type PostEntry,
  type GraphPostResponse,
  type SocialPublished,
} from "../scripts/verify-facebook-posts.ts";

const now = new Date("2026-04-24T12:00:00Z");
const nowUnix = Math.floor(now.getTime() / 1000);

function scheduledEntry(overrides: Partial<PostEntry> = {}): PostEntry {
  return {
    platform: "facebook",
    destaque: "d1",
    url: "https://facebook.com/...",
    status: "scheduled",
    scheduled_at: "2026-04-24T10:00:00Z",
    fb_post_id: "12345_67890",
    ...overrides,
  };
}

describe("reconcilePost", () => {
  it("scheduled no futuro: mantém scheduled", () => {
    const entry = scheduledEntry();
    const graph: GraphPostResponse = {
      is_published: false,
      scheduled_publish_time: nowUnix + 3600,
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.status, "scheduled");
  });

  it("scheduled_publish_time passou + is_published=true: vira published", () => {
    const entry = scheduledEntry();
    const graph: GraphPostResponse = {
      is_published: true,
      scheduled_publish_time: nowUnix - 3600,
      created_time: "2026-04-24T11:00:00+0000",
      permalink_url: "https://facebook.com/post/123",
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.status, "published");
    assert.equal(result.url, "https://facebook.com/post/123");
    assert.equal(result.published_at, "2026-04-24T11:00:00+0000");
  });

  it("scheduled_publish_time passou + is_published=false: vira failed", () => {
    const entry = scheduledEntry();
    const graph: GraphPostResponse = {
      is_published: false,
      scheduled_publish_time: nowUnix - 3600,
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.status, "failed");
    assert.ok(result.failure_reason?.includes("is_published=false"));
  });

  it("Graph API retorna erro: vira failed com mensagem", () => {
    const entry = scheduledEntry();
    const graph: GraphPostResponse = {
      error: { message: "Invalid OAuth access token.", code: 190 },
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.status, "failed");
    assert.equal(result.failure_reason, "Invalid OAuth access token.");
  });

  it("sem scheduled_publish_time + is_published=true: vira published", () => {
    const entry = scheduledEntry();
    const graph: GraphPostResponse = {
      is_published: true,
      created_time: "2026-04-24T11:00:00+0000",
      permalink_url: "https://facebook.com/post/456",
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.status, "published");
  });

  it("published preserva fb_post_id original", () => {
    const entry = scheduledEntry({ fb_post_id: "SPECIFIC_ID" });
    const graph: GraphPostResponse = {
      is_published: true,
      created_time: "2026-04-24T11:00:00+0000",
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.fb_post_id, "SPECIFIC_ID");
  });

  // #3816 caso 2: erro de leitura (code 100) sobre entry com fb_post_id
  // existente NÃO deve virar failed — a causa real do incidente 260721 (3
  // posts publicados com sucesso na Graph API marcados "failed" localmente).
  it("#3816: erro #100 com fb_post_id existente (status scheduled) NÃO vira failed — mantém scheduled com nota de inconclusividade", () => {
    const entry = scheduledEntry({ status: "scheduled", fb_post_id: "839717705901271_122133515499184022" });
    const graph: GraphPostResponse = {
      error: { message: "(#100) Tried accessing nonexisting field (scheduled_publish_time)", code: 100 },
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.status, "scheduled", "erro de leitura não é evidência de falha — não deve sobrescrever scheduled");
    assert.ok(
      typeof result.verification_note === "string" && result.verification_note.includes("read_error_inconclusive_code_100"),
      "deve anotar a inconclusividade da leitura",
    );
  });

  it("#3816: erro #100 com fb_post_id existente (status failed de rodada anterior) permanece failed, mas NÃO reforça failure_reason incondicionalmente — só anota inconclusividade", () => {
    const entry = scheduledEntry({
      status: "failed",
      fb_post_id: "122133515499184022",
      failure_reason: "(#100) Tried accessing nonexisting field (scheduled_publish_time)",
    });
    const graph: GraphPostResponse = {
      error: { message: "(#100) Tried accessing nonexisting field (scheduled_publish_time)", code: 100 },
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.status, "failed", "sem leitura conclusiva, o status anterior é preservado (não piora, não conserta sozinho)");
    assert.ok(
      typeof result.verification_note === "string" && result.verification_note.includes("read_error_inconclusive_code_100"),
    );
  });

  it("#3816: erro #100 SEM fb_post_id confirmado ainda vira failed (não há criação confirmada pra proteger)", () => {
    const entry = scheduledEntry({ fb_post_id: undefined });
    const graph: GraphPostResponse = {
      error: { message: "(#100) Tried accessing nonexisting field (scheduled_publish_time)", code: 100 },
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.status, "failed");
    assert.equal(result.failure_reason, "(#100) Tried accessing nonexisting field (scheduled_publish_time)");
  });

  it("#3816: erro não-100 (ex: 190 invalid token) com fb_post_id existente CONTINUA virando failed — só erros de LEITURA (100) são protegidos", () => {
    const entry = scheduledEntry();
    const graph: GraphPostResponse = {
      error: { message: "Invalid OAuth access token.", code: 190 },
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.status, "failed");
    assert.equal(result.failure_reason, "Invalid OAuth access token.");
  });

  // #3816 caso 3: entry "failed" com fb_post_id É reconciliada quando a
  // leitura (agora com ID composto correto) volta conclusiva.
  it("#3816: entry failed com fb_post_id vira published quando a leitura conclusiva confirma sucesso", () => {
    const entry = scheduledEntry({
      status: "failed",
      fb_post_id: "839717705901271_122133515499184022",
      failure_reason: "(#100) Tried accessing nonexisting field (scheduled_publish_time)",
    });
    const graph: GraphPostResponse = {
      is_published: true,
      created_time: "2026-04-24T10:00:01+0000",
      scheduled_publish_time: nowUnix - 3600,
      permalink_url: "https://www.facebook.com/photo.php?fbid=122133515499184022",
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.status, "published");
    assert.equal(result.url, "https://www.facebook.com/photo.php?fbid=122133515499184022");
    assert.equal(result.failure_reason, undefined, "failure_reason de uma rodada failed anterior não deve sobreviver");
    assert.equal(result.verification_note, undefined, "leitura conclusiva (com created_time) não deve carregar nota de inconclusividade");
  });

  it("#3816: entry failed com fb_post_id volta pra scheduled quando a leitura conclusiva mostra que ainda está no futuro", () => {
    const entry = scheduledEntry({
      status: "failed",
      fb_post_id: "839717705901271_122133515499184022",
      failure_reason: "(#100) Tried accessing nonexisting field (scheduled_publish_time)",
    });
    const graph: GraphPostResponse = {
      scheduled_publish_time: nowUnix + 3600,
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.status, "scheduled", "leitura conclusiva mostra agendamento genuíno no futuro — não deve ficar presa em failed");
    assert.equal(result.failure_reason, undefined);
  });
});

describe("resolveGraphPostId (#3816)", () => {
  it("fb_post_id sem '_' + pageId presente → compõe {pageId}_{fb_post_id}", () => {
    assert.equal(resolveGraphPostId("122133515499184022", "839717705901271"), "839717705901271_122133515499184022");
  });

  it("fb_post_id já composto (contém '_') → usa como está, não duplica o prefixo", () => {
    assert.equal(
      resolveGraphPostId("839717705901271_122133515499184022", "839717705901271"),
      "839717705901271_122133515499184022",
    );
  });

  it("sem pageId disponível → retorna o fb_post_id original (best-effort)", () => {
    assert.equal(resolveGraphPostId("122133515499184022", undefined), "122133515499184022");
  });
});

describe("verifyPublished", () => {
  it("só verifica posts scheduled com fb_post_id do Facebook", async () => {
    const published: SocialPublished = {
      posts: [
        scheduledEntry({ destaque: "d1" }),
        { ...scheduledEntry({ destaque: "d2" }), status: "draft" },
        { ...scheduledEntry({ destaque: "d3", platform: "linkedin" }) },
      ],
    };

    const graphResponses: GraphPostResponse[] = [
      { is_published: true, scheduled_publish_time: nowUnix - 3600, permalink_url: "https://fb.com/1" },
    ];
    let callIndex = 0;
    const fetchPost = async () => graphResponses[callIndex++];

    const { updated, changes } = await verifyPublished(published, "TOKEN", "v18.0", fetchPost, now);
    assert.equal(changes, 1);
    // d1 atualizado
    const d1 = updated.posts.find((p) => p.destaque === "d1")!;
    assert.equal(d1.status, "published");
    // d2 intocado (era draft)
    const d2 = updated.posts.find((p) => p.destaque === "d2")!;
    assert.equal(d2.status, "draft");
    // d3 intocado (era linkedin)
    const d3 = updated.posts.find((p) => p.destaque === "d3")!;
    assert.equal(d3.status, "scheduled");
  });

  it("captura exceção do fetch e marca como failed", async () => {
    const published: SocialPublished = {
      posts: [scheduledEntry({ destaque: "d1" })],
    };
    const fetchPost = async () => {
      throw new Error("Network timeout");
    };

    const { updated, changes } = await verifyPublished(published, "TOKEN", "v18.0", fetchPost, now);
    assert.equal(changes, 1);
    assert.equal(updated.posts[0].status, "failed");
    assert.ok(updated.posts[0].failure_reason?.includes("Network timeout"));
  });

  it("0 mudanças quando tudo ainda está scheduled", async () => {
    const published: SocialPublished = {
      posts: [scheduledEntry({ destaque: "d1" })],
    };
    const fetchPost = async (): Promise<GraphPostResponse> => ({
      is_published: false,
      scheduled_publish_time: nowUnix + 7200,
    });

    const { changes } = await verifyPublished(published, "TOKEN", "v18.0", fetchPost, now);
    assert.equal(changes, 0);
  });

  it("posts sem fb_post_id são pulados (não tenta verificar)", async () => {
    const published: SocialPublished = {
      posts: [{ ...scheduledEntry({ destaque: "d1" }), fb_post_id: undefined }],
    };
    let fetchCalled = false;
    const fetchPost = async () => {
      fetchCalled = true;
      return {} as GraphPostResponse;
    };

    const { changes } = await verifyPublished(published, "TOKEN", "v18.0", fetchPost, now);
    assert.equal(fetchCalled, false);
    assert.equal(changes, 0);
  });

  // #3816 caso 1: fb_post_id sem "_" (ID de foto cru, o exato bug de 260721)
  // → a leitura deve compor {pageId}_{fb_post_id} antes de chamar fetchPost.
  it("#3816: fb_post_id sem '_' → verifyPublished consulta com o ID composto quando pageId é passado", async () => {
    const published: SocialPublished = {
      posts: [scheduledEntry({ destaque: "d1", fb_post_id: "122133515499184022" })],
    };
    let receivedPostId = "";
    const fetchPost = async (postId: string): Promise<GraphPostResponse> => {
      receivedPostId = postId;
      return { is_published: true, created_time: "2026-04-24T11:00:00+0000", scheduled_publish_time: nowUnix - 3600 };
    };

    await verifyPublished(published, "TOKEN", "v18.0", fetchPost, now, "839717705901271");
    assert.equal(
      receivedPostId,
      "839717705901271_122133515499184022",
      "fetchPost deve receber o ID composto {pageId}_{fb_post_id}, não o ID de foto cru",
    );
  });

  it("#3816: fb_post_id já composto (contém '_') → verifyPublished passa como está pro fetchPost, mesmo com pageId presente", async () => {
    const published: SocialPublished = {
      posts: [scheduledEntry({ destaque: "d1", fb_post_id: "839717705901271_122133515499184022" })],
    };
    let receivedPostId = "";
    const fetchPost = async (postId: string): Promise<GraphPostResponse> => {
      receivedPostId = postId;
      return { is_published: true, created_time: "2026-04-24T11:00:00+0000", scheduled_publish_time: nowUnix - 3600 };
    };

    await verifyPublished(published, "TOKEN", "v18.0", fetchPost, now, "839717705901271");
    assert.equal(receivedPostId, "839717705901271_122133515499184022");
  });

  // #3816 caso 3: entry "failed" (de uma rodada anterior travada pelo bug
  // do ID de foto) COM fb_post_id é reconciliada numa nova rodada de verify —
  // não fica presa em "failed" pra sempre.
  it("#3816: entry failed com fb_post_id É reconciliada (vira published) numa nova rodada de verify", async () => {
    const published: SocialPublished = {
      posts: [
        {
          ...scheduledEntry({ destaque: "d1" }),
          status: "failed",
          failure_reason: "(#100) Tried accessing nonexisting field (scheduled_publish_time)",
        },
      ],
    };
    const fetchPost = async (): Promise<GraphPostResponse> => ({
      is_published: true,
      created_time: "2026-04-24T10:00:01+0000",
      scheduled_publish_time: nowUnix - 3600,
      permalink_url: "https://www.facebook.com/photo.php?fbid=122133515499184022",
    });

    const { updated, changes } = await verifyPublished(published, "TOKEN", "v18.0", fetchPost, now);
    assert.equal(changes, 1, "failed → published deve contar como mudança");
    assert.equal(updated.posts[0].status, "published");
    assert.equal(updated.posts[0].failure_reason, undefined);
  });

  // #3816 caso 4 (não-regressão): entry "failed" SEM fb_post_id (falha real
  // de publish-facebook.ts — ex: imagem ausente) continua pulada, nunca
  // tenta verificar algo que nunca foi criado.
  it("#3816: entry failed SEM fb_post_id continua pulada (não regressão do caso legítimo)", async () => {
    const published: SocialPublished = {
      posts: [
        {
          ...scheduledEntry({ destaque: "d1" }),
          status: "failed",
          fb_post_id: undefined,
          failure_reason: "04-d1-1x1.jpg not found",
        },
      ],
    };
    let fetchCalled = false;
    const fetchPost = async (): Promise<GraphPostResponse> => {
      fetchCalled = true;
      return { is_published: true };
    };

    const { updated, changes } = await verifyPublished(published, "TOKEN", "v18.0", fetchPost, now);
    assert.equal(fetchCalled, false, "não deve tentar verificar um post que nunca foi criado");
    assert.equal(changes, 0);
    assert.equal(updated.posts[0].status, "failed");
    assert.equal(updated.posts[0].failure_reason, "04-d1-1x1.jpg not found");
  });

  it("#3816: entry scheduled com verification_note inconclusiva (erro #100) conta como mudança, pra persistir a nota", async () => {
    const published: SocialPublished = {
      posts: [scheduledEntry({ destaque: "d1" })],
    };
    const fetchPost = async (): Promise<GraphPostResponse> => ({
      error: { message: "(#100) Tried accessing nonexisting field (scheduled_publish_time)", code: 100 },
    });

    const { updated, changes } = await verifyPublished(published, "TOKEN", "v18.0", fetchPost, now);
    assert.equal(updated.posts[0].status, "scheduled", "erro de leitura não deve derrubar o status");
    assert.equal(changes, 1, "a nota de inconclusividade precisa contar como mudança pra ser persistida em disco");
  });
});

describe("inferIsPublished (#600)", () => {
  const fakeNow = Math.floor(new Date("2026-05-05T12:00:00Z").getTime() / 1000);

  it("created_time presente + sem scheduled_publish_time → is_published=true", () => {
    const r = inferIsPublished({ created_time: "2026-05-05T11:00:00Z" }, fakeNow);
    assert.equal(r.is_published, true);
  });

  it("scheduled_publish_time no futuro → is_published=false", () => {
    const r = inferIsPublished(
      { created_time: "2026-05-05T11:00:00Z", scheduled_publish_time: fakeNow + 3600 },
      fakeNow,
    );
    assert.equal(r.is_published, false);
  });

  it("scheduled_publish_time passou + created_time → is_published=true", () => {
    const r = inferIsPublished(
      { created_time: "2026-05-05T11:00:00Z", scheduled_publish_time: fakeNow - 60 },
      fakeNow,
    );
    assert.equal(r.is_published, true);
  });

  it("error presente → não modifica (mantém undefined)", () => {
    const r = inferIsPublished(
      { error: { message: "(#100) Tried accessing nonexisting field (is_published)", code: 100 } },
      fakeNow,
    );
    assert.equal(r.is_published, undefined);
    assert.ok(r.error);
  });

  it("created_time ausente → não infere", () => {
    const r = inferIsPublished({ scheduled_publish_time: fakeNow + 3600 }, fakeNow);
    assert.equal(r.is_published, undefined);
  });

  // #2676 F2: sem created_time, scheduled_publish_time no PASSADO era o único
  // caso não coberto — caía no "não infere" acima (mesmo guard `!data.created_time`)
  // e ficava indistinguível do caso "post nem existe ainda". Um
  // scheduled_publish_time vencido é sinal forte de que o post deveria ter
  // saído — tratar como published em vez de deixar is_published=undefined
  // (que reconcilePost resolve como "failed", mesma classe de bug do #600).
  it("#2676 F2: sem created_time + scheduled_publish_time no passado → infere is_published=true", () => {
    const r = inferIsPublished({ scheduled_publish_time: fakeNow - 60 }, fakeNow);
    assert.equal(
      r.is_published,
      true,
      "scheduled_publish_time vencido sem created_time deveria inferir published, não ficar undefined (mesma classe de bug do #600)",
    );
  });

  it("#2676 F2: sem created_time + sem scheduled_publish_time → continua sem inferir (undefined)", () => {
    // Sem nenhum sinal temporal, não há base pra inferir nada — mantém o
    // comportamento pré-#2676 (undefined, não published nem failed).
    const r = inferIsPublished({}, fakeNow);
    assert.equal(r.is_published, undefined);
  });
});

describe("defaultFetchPost — exercita o fetch real (#2676 F1)", () => {
  // #2676 F1: a suite "v25.0 regression (#600)" acima injeta um `fetchPost`
  // mockado direto em `verifyPublished`, então NUNCA exercita
  // `defaultFetchPost` — que é onde o bug #600 de fato morava (o `fields=`
  // passado pro fetch real). Se alguém reintroduzir "is_published" em
  // `safeFields` dentro de `defaultFetchPost`, a suite acima continuaria
  // verde (ela nem chama essa função) e a regressão passaria despercebida.
  // Este teste mocka `global.fetch` e inspeciona a URL de fato construída.
  it("nunca inclui is_published no fields= da chamada Graph API real", async () => {
    const origFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url.includes("fields=permalink_url")) {
        return new Response(
          JSON.stringify({ permalink_url: "https://facebook.com/post/999" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Resposta v25.0 real: sem is_published (deprecated), scheduled_publish_time
      // já vencido — dispara também a chamada best-effort de permalink_url.
      return new Response(
        JSON.stringify({
          created_time: "2026-04-24T10:30:00+0000",
          scheduled_publish_time: Math.floor(now.getTime() / 1000) - 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    try {
      const result = await defaultFetchPost("12345_67890", "TOKEN", "v25.0");

      const mainCall = calls.find((c) => !c.includes("fields=permalink_url"));
      assert.ok(mainCall, "esperava ao menos 1 chamada de fields principal");
      const fieldsParam = new URL(mainCall!).searchParams.get("fields") ?? "";
      // Esta é a asserção que teria pego o bug #600: se `safeFields` em
      // `defaultFetchPost` voltar a incluir "is_published", `fieldsParam`
      // passa a conter a string e este assert falha.
      assert.ok(
        !fieldsParam.includes("is_published"),
        `fields= não deve incluir is_published (regressão #600): "${fieldsParam}"`,
      );
      assert.ok(
        fieldsParam.includes("created_time") && fieldsParam.includes("scheduled_publish_time"),
        `fields= deve conter os campos seguros: "${fieldsParam}"`,
      );
      // Sanity: is_published no resultado veio de inferIsPublished (inferido),
      // nunca da API — confirma que defaultFetchPost chamou o inferidor.
      assert.equal(result.is_published, true);
      assert.equal(result.permalink_url, "https://facebook.com/post/999");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("v25.0 regression (#600): post agendado não vira failed", () => {
  // Cenário exato do bug #600: Graph API v25.0 não expõe o campo `is_published`
  // (deprecated). Antes do fix, verify-facebook-posts.ts requestava esse campo e
  // recebia `(#100) Tried accessing nonexisting field`, fazendo reconcilePost
  // marcar posts perfeitamente agendados como `failed`.
  //
  // Depois do fix: defaultFetchPost usa safeFields (created_time + scheduled_publish_time)
  // e chama inferIsPublished para derivar is_published por inferência — nunca pelo campo
  // deprecated. Este describe testa o end-to-end desse caminho.

  const nowUnix600 = Math.floor(now.getTime() / 1000);

  it("response v25.0 sem is_published, scheduled_publish_time futuro → fica scheduled (não failed)", async () => {
    const published: SocialPublished = {
      posts: [scheduledEntry({ destaque: "d1" })],
    };
    // Simula o que defaultFetchPost retorna após chamar inferIsPublished:
    // a Graph API v25.0 responde com created_time + scheduled_publish_time (futuro),
    // sem is_published. inferIsPublished infere is_published=false.
    const fetchPost = async (): Promise<GraphPostResponse> =>
      inferIsPublished(
        { created_time: "2026-04-24T10:00:00+0000", scheduled_publish_time: nowUnix600 + 7200 },
        nowUnix600,
      );
    const { updated, changes } = await verifyPublished(published, "TOKEN", "v25.0", fetchPost, now);
    assert.equal(changes, 0, "post agendado no futuro não deve gerar mudança de status");
    assert.equal(
      updated.posts[0].status,
      "scheduled",
      "post agendado v25.0 deve permanecer 'scheduled', não virar 'failed'",
    );
  });

  it("response v25.0 sem is_published, scheduled_publish_time passado → vira published", async () => {
    const published: SocialPublished = {
      posts: [scheduledEntry({ destaque: "d1" })],
    };
    // scheduled_publish_time já passou → inferIsPublished infere is_published=true
    const fetchPost = async (): Promise<GraphPostResponse> =>
      inferIsPublished(
        { created_time: "2026-04-24T10:30:00+0000", scheduled_publish_time: nowUnix600 - 3600 },
        nowUnix600,
      );
    const { updated, changes } = await verifyPublished(published, "TOKEN", "v25.0", fetchPost, now);
    assert.equal(changes, 1, "post publicado deve gerar mudança de status");
    assert.equal(updated.posts[0].status, "published");
    assert.equal(
      updated.posts[0].verification_note,
      undefined,
      "com created_time presente (confirmado pela API), não deve marcar verification_note",
    );
  });

  it("#2676 self-review: sem created_time + scheduled_publish_time passado → published com verification_note (#573 audit trail)", async () => {
    const published: SocialPublished = {
      posts: [scheduledEntry({ destaque: "d1" })],
    };
    // #2676 F2: mesmo caminho de inferência, mas SEM created_time — a confiança
    // é menor (só o relógio do scheduled_publish_time, sem confirmação direta
    // de que o post existe na API). reconcilePost deve marcar essa proveniência.
    const fetchPost = async (): Promise<GraphPostResponse> =>
      inferIsPublished({ scheduled_publish_time: nowUnix600 - 3600 }, nowUnix600);
    const { updated, changes } = await verifyPublished(published, "TOKEN", "v25.0", fetchPost, now);
    assert.equal(changes, 1, "post inferido como publicado deve gerar mudança de status");
    assert.equal(updated.posts[0].status, "published");
    assert.equal(
      updated.posts[0].verification_note,
      "inferred_from_expired_schedule_no_created_time",
      "sem created_time, o published deve carregar a marca de proveniência de baixa confiança",
    );
    assert.equal(
      updated.posts[0].published_at,
      undefined,
      "sem created_time da API, published_at não deve ser inventado",
    );
  });

  it("#3816: response v25.0 com error #100 sobre entry com fb_post_id confirmado NÃO vira failed — mantém scheduled com nota de inconclusividade", () => {
    // Antes do #3816, este teste esperava "failed" — era exatamente o padrão
    // estrutural que a issue pediu pra blindar: "se por algum motivo a API
    // ainda retornar o erro #100, o comportamento deve ser failed" tratava
    // TODO erro #100 como falha real. Mas #3816 mostrou que #100 também
    // ocorre por erro de LEITURA (ID de foto em vez do composto) sobre um
    // post publicado com sucesso — a 3ª recorrência dessa classe de bug
    // (#600, #920, #3816). `reconcilePost` agora distingue: erro de leitura
    // (code 100) sobre entry com fb_post_id confirmado não sobrescreve o
    // status; só uma leitura CONCLUSIVA (sem erro) decide published/failed.
    const entry = scheduledEntry({ destaque: "d1" });
    const graph = inferIsPublished(
      { error: { message: "(#100) Tried accessing nonexisting field (is_published)", code: 100 } },
      nowUnix600,
    );
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.status, "scheduled", "erro #100 de leitura não deve derrubar um post com fb_post_id confirmado");
    assert.ok(
      typeof result.verification_note === "string" && result.verification_note.includes("read_error_inconclusive_code_100"),
    );
  });
});

describe("resolveSocialPublishedPath (#920)", () => {
  it("prefere _internal/ quando existe (canonical write path de publish-facebook.ts)", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-fb-path-"));
    const editionRel = "data/editions/260507";
    const editionAbs = join(root, editionRel);
    mkdirSync(join(editionAbs, "_internal"), { recursive: true });
    writeFileSync(
      join(editionAbs, "_internal", "06-social-published.json"),
      "{}",
    );
    try {
      const out = resolveSocialPublishedPath(root, editionRel);
      assert.equal(
        out,
        resolve(editionAbs, "_internal", "06-social-published.json"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cai pra root quando só legacy existe (compat com edições antigas)", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-fb-path-"));
    const editionRel = "data/editions/260507";
    const editionAbs = join(root, editionRel);
    mkdirSync(editionAbs, { recursive: true });
    writeFileSync(join(editionAbs, "06-social-published.json"), "{}");
    try {
      const out = resolveSocialPublishedPath(root, editionRel);
      assert.equal(out, resolve(editionAbs, "06-social-published.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retorna null quando não existe em nenhum dos paths", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-fb-path-"));
    const editionRel = "data/editions/260507";
    mkdirSync(join(root, editionRel), { recursive: true });
    try {
      const out = resolveSocialPublishedPath(root, editionRel);
      assert.equal(out, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefere _internal/ mesmo quando legacy também existe", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-fb-path-"));
    const editionRel = "data/editions/260507";
    const editionAbs = join(root, editionRel);
    mkdirSync(join(editionAbs, "_internal"), { recursive: true });
    writeFileSync(join(editionAbs, "06-social-published.json"), "{\"legacy\":true}");
    writeFileSync(
      join(editionAbs, "_internal", "06-social-published.json"),
      "{\"canonical\":true}",
    );
    try {
      const out = resolveSocialPublishedPath(root, editionRel);
      assert.equal(
        out,
        resolve(editionAbs, "_internal", "06-social-published.json"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
