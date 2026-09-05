/**
 * beehiiv-engagement-manifest.test.ts (#6465)
 *
 * Cobre os helpers puros do manifest de cobertura da extração de
 * per-subscriber engagement: bootstrap, merge não-destrutivo (retomada),
 * upsert de resultado, sumário de cobertura, e a tolerância de shape do
 * parser de arquivo de post.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildInitialManifest,
  mergeManifestPosts,
  upsertEntry,
  pendingEntries,
  coverageSummary,
  extractPostRefFromBackupFile,
  isNeverSentPost,
  NEVER_SENT_REASON,
  reconcileManifestWithDisk,
  reconcileShapeViolations,
  validateEngagementLine,
  validateEngagementLines,
  ENGAGEMENT_EVENT_STATUSES,
  type EngagementManifest,
  type LineShapeReport,
} from "../scripts/lib/beehiiv-engagement-manifest.ts";

describe("buildInitialManifest", () => {
  it("todo post nasce pending", () => {
    const m = buildInitialManifest([{ id: "post_1", title: "A" }, { id: "post_2" }], "2026-08-28T00:00:00.000Z");
    assert.equal(m.posts.length, 2);
    assert.ok(m.posts.every((p) => p.status === "pending"));
    assert.equal(m.posts[0].title, "A");
    assert.equal(m.posts[1].title, undefined);
  });
});

describe("mergeManifestPosts — retomada sem regressão de status", () => {
  it("preserva status ok de posts já processados ao re-descobrir", () => {
    const existing: EngagementManifest = {
      generated_at: "2026-08-27T00:00:00.000Z",
      posts: [
        { post_id: "post_1", title: "A", status: "ok", count: 42 },
        { post_id: "post_2", title: "B", status: "partial", count: 5, pages_fetched: 1, total_pages: 3 },
      ],
    };
    const merged = mergeManifestPosts(existing, [{ id: "post_1", title: "A" }, { id: "post_2", title: "B" }], "2026-08-28T00:00:00.000Z");
    const p1 = merged.posts.find((p) => p.post_id === "post_1")!;
    const p2 = merged.posts.find((p) => p.post_id === "post_2")!;
    assert.equal(p1.status, "ok", "merge nunca rebaixa um post já confirmado");
    assert.equal(p1.count, 42);
    assert.equal(p2.status, "partial", "merge preserva partial — retomada depende disso");
  });

  it("adiciona posts novos descobertos como pending", () => {
    const existing = buildInitialManifest([{ id: "post_1" }], "2026-08-27T00:00:00.000Z");
    const merged = mergeManifestPosts(existing, [{ id: "post_1" }, { id: "post_2", title: "Novo" }], "2026-08-28T00:00:00.000Z");
    assert.equal(merged.posts.length, 2);
    const novo = merged.posts.find((p) => p.post_id === "post_2")!;
    assert.equal(novo.status, "pending");
    assert.equal(novo.title, "Novo");
  });

  it("preenche title que faltava sem tocar o resto da entry", () => {
    const existing: EngagementManifest = {
      generated_at: "x",
      posts: [{ post_id: "post_1", status: "pending" }],
    };
    const merged = mergeManifestPosts(existing, [{ id: "post_1", title: "Título chegou depois" }], "2026-08-28T00:00:00.000Z");
    assert.equal(merged.posts[0].title, "Título chegou depois");
    assert.equal(merged.posts[0].status, "pending");
  });
});

describe("upsertEntry", () => {
  it("substitui a entry existente pelo mesmo post_id", () => {
    const m = buildInitialManifest([{ id: "post_1" }], "x");
    const updated = upsertEntry(m, { post_id: "post_1", status: "ok", count: 10, fetched_at: "2026-08-28T00:00:00.000Z" });
    assert.equal(updated.posts.length, 1);
    assert.equal(updated.posts[0].status, "ok");
    assert.equal(updated.posts[0].count, 10);
  });

  it("adiciona quando o post_id não existia ainda", () => {
    const m = buildInitialManifest([], "x");
    const updated = upsertEntry(m, { post_id: "post_new", status: "ok", count: 1 });
    assert.equal(updated.posts.length, 1);
  });
});

describe("pendingEntries — nunca reoferece ok", () => {
  it("pending/partial/error aparecem; ok não", () => {
    const m: EngagementManifest = {
      generated_at: "x",
      posts: [
        { post_id: "p1", status: "ok" },
        { post_id: "p2", status: "pending" },
        { post_id: "p3", status: "partial" },
        { post_id: "p4", status: "error" },
      ],
    };
    const pending = pendingEntries(m).map((p) => p.post_id);
    assert.deepEqual(pending.sort(), ["p2", "p3", "p4"]);
  });
});

describe("coverageSummary", () => {
  it("closed=true só quando 100% ok", () => {
    const allOk: EngagementManifest = { generated_at: "x", posts: [{ post_id: "p1", status: "ok" }, { post_id: "p2", status: "ok" }] };
    assert.equal(coverageSummary(allOk).closed, true);

    const oneMissing: EngagementManifest = { generated_at: "x", posts: [{ post_id: "p1", status: "ok" }, { post_id: "p2", status: "pending" }] };
    assert.equal(coverageSummary(oneMissing).closed, false);
  });

  it("manifest vazio nunca reporta closed=true (nada processado != gap fechado)", () => {
    const empty: EngagementManifest = { generated_at: "x", posts: [] };
    const summary = coverageSummary(empty);
    assert.equal(summary.total, 0);
    assert.equal(summary.closed, false);
  });

  it("conta cada status corretamente", () => {
    const m: EngagementManifest = {
      generated_at: "x",
      posts: [
        { post_id: "p1", status: "ok" },
        { post_id: "p2", status: "ok" },
        { post_id: "p3", status: "partial" },
        { post_id: "p4", status: "error" },
        { post_id: "p5", status: "pending" },
      ],
    };
    const s = coverageSummary(m);
    assert.deepEqual(s, { total: 5, ok: 2, partial: 1, error: 1, pending: 1, not_applicable: 0, closed: false });
  });
});

describe("extractPostRefFromBackupFile — tolerância de shape", () => {
  it("shape plano (data/beehiiv-cache/posts/*.json)", () => {
    const ref = extractPostRefFromBackupFile({ id: "post_1", title: "T", stats: {} });
    assert.deepEqual(ref, { id: "post_1", title: "T" });
  });

  it("shape aninhado (data/beehiiv-backup/{date}/posts/*.json — resposta REST crua)", () => {
    const ref = extractPostRefFromBackupFile({ data: { id: "post_2", title: "T2" } });
    assert.deepEqual(ref, { id: "post_2", title: "T2" });
  });

  it("shape plano sem title — ok, title fica undefined", () => {
    const ref = extractPostRefFromBackupFile({ id: "post_3" });
    assert.deepEqual(ref, { id: "post_3", title: undefined });
  });

  it("sem id reconhecível em nenhum dos 2 shapes → null", () => {
    assert.equal(extractPostRefFromBackupFile({ foo: "bar" }), null);
    assert.equal(extractPostRefFromBackupFile({ data: { foo: "bar" } }), null);
  });

  it("input não-objeto → null", () => {
    assert.equal(extractPostRefFromBackupFile(null), null);
    assert.equal(extractPostRefFromBackupFile(undefined), null);
    assert.equal(extractPostRefFromBackupFile("string"), null);
    assert.equal(extractPostRefFromBackupFile(42), null);
  });
});

describe("not_applicable — post nunca enviado (#6465)", () => {
  it("isNeverSentPost: draft e publish_date nulo (nos 2 shapes) → true", () => {
    assert.equal(isNeverSentPost({ data: { id: "p", status: "draft", publish_date: null } }), true);
    assert.equal(isNeverSentPost({ id: "p", status: "draft" }), true);
    assert.equal(isNeverSentPost({ id: "p", status: "confirmed", publish_date: null }), true);
  });

  it("isNeverSentPost: post publicado → false; shape sem o campo → false", () => {
    assert.equal(isNeverSentPost({ data: { id: "p", status: "confirmed", publish_date: 1787944034 } }), false);
    assert.equal(isNeverSentPost({ id: "p", title: "T" }), false);
    assert.equal(isNeverSentPost(null), false);
  });

  it("extractPostRefFromBackupFile marca neverSent só quando verdadeiro", () => {
    assert.deepEqual(extractPostRefFromBackupFile({ id: "p1", title: "T", status: "draft" }), {
      id: "p1",
      title: "T",
      neverSent: true,
    });
    assert.deepEqual(extractPostRefFromBackupFile({ id: "p2", title: "T" }), { id: "p2", title: "T" });
  });

  it("mergeManifestPosts: post nunca enviado entra not_applicable e sai de pendingEntries", () => {
    const m = mergeManifestPosts(
      { generated_at: "t0", posts: [] },
      [{ id: "draft1", title: "Rascunho", neverSent: true }, { id: "sent1", title: "Enviado" }],
      "t1",
    );
    const draft = m.posts.find((p) => p.post_id === "draft1");
    assert.equal(draft?.status, "not_applicable");
    assert.equal(draft?.error, NEVER_SENT_REASON);
    assert.deepEqual(pendingEntries(m).map((p) => p.post_id), ["sent1"]);
  });

  it("mergeManifestPosts: rebaixa pending→not_applicable, mas NUNCA rebaixa ok", () => {
    const before: EngagementManifest = {
      generated_at: "t0",
      posts: [
        { post_id: "a", status: "pending" },
        { post_id: "b", status: "ok", count: 10 },
      ],
    };
    const after = mergeManifestPosts(before, [{ id: "a", neverSent: true }, { id: "b", neverSent: true }], "t1");
    assert.equal(after.posts.find((p) => p.post_id === "a")?.status, "not_applicable");
    assert.equal(after.posts.find((p) => p.post_id === "b")?.status, "ok");
  });

  it("coverageSummary: ok + not_applicable == total fecha o gap", () => {
    const s = coverageSummary({
      generated_at: "t",
      posts: [
        { post_id: "a", status: "ok" },
        { post_id: "b", status: "not_applicable" },
      ],
    });
    assert.equal(s.not_applicable, 1);
    assert.equal(s.closed, true);
  });

  it("coverageSummary: not_applicable NÃO mascara partial/error pendente", () => {
    const s = coverageSummary({
      generated_at: "t",
      posts: [
        { post_id: "a", status: "ok" },
        { post_id: "b", status: "not_applicable" },
        { post_id: "c", status: "partial" },
      ],
    });
    assert.equal(s.closed, false);
  });
});

describe("reconcileManifestWithDisk — auditoria contra o disco (#7197)", () => {
  it("ok com 0 linhas reais em disco → rebaixa pra pending (reproduz os 7 posts count:0 do #7197)", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_fabricado", status: "ok", count: 0 }],
    };
    const { manifest: reconciled, downgraded } = reconcileManifestWithDisk(manifest, new Map([["post_fabricado", 0]]));
    const entry = reconciled.posts[0];
    assert.equal(entry.status, "pending");
    assert.equal(entry.count, 0);
    assert.match(entry.error ?? "", /#7197/);
    assert.deepEqual(downgraded, [{ post_id: "post_fabricado", from: "ok", to: "pending", reason: entry.error }]);
  });

  it("ok com manifest.count divergindo das linhas reais → rebaixa pra partial e corrige count (reproduz os 16 posts do #7197 — '7 páginas, 10 registros')", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_incompleto", status: "ok", count: 700, pages_fetched: 7, total_pages: 7 }],
    };
    const { manifest: reconciled, downgraded } = reconcileManifestWithDisk(manifest, new Map([["post_incompleto", 10]]));
    const entry = reconciled.posts[0];
    assert.equal(entry.status, "partial");
    assert.equal(entry.count, 10, "count é corrigido pro valor real do disco");
    assert.equal(entry.pages_fetched, 7, "pagination metadata preservada — só status/count mudam");
    assert.equal(downgraded.length, 1);
    assert.equal(downgraded[0].to, "partial");
  });

  it("ok com manifest.count batendo com o disco → intocado, nenhum rebaixamento", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_integro", status: "ok", count: 312 }],
    };
    const { manifest: reconciled, downgraded } = reconcileManifestWithDisk(manifest, new Map([["post_integro", 312]]));
    assert.deepEqual(reconciled.posts[0], manifest.posts[0]);
    assert.deepEqual(downgraded, []);
  });

  it("post_id ausente do mapa de contagens reais é tratado como 0 (arquivo nunca existiu) → pending", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_sem_arquivo", status: "ok", count: 5 }],
    };
    const { manifest: reconciled, downgraded } = reconcileManifestWithDisk(manifest, new Map());
    assert.equal(reconciled.posts[0].status, "pending");
    assert.equal(downgraded.length, 1);
  });

  it("nunca mexe em pending/partial/error/not_applicable — só ok é candidato", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [
        { post_id: "a", status: "pending" },
        { post_id: "b", status: "partial", count: 3 },
        { post_id: "c", status: "error" },
        { post_id: "d", status: "not_applicable" },
      ],
    };
    // Contagens reais deliberadamente diferentes — não deveria importar, pois nenhuma é `ok`.
    const actual = new Map([["a", 0], ["b", 999], ["c", 1], ["d", 1]]);
    const { manifest: reconciled, downgraded } = reconcileManifestWithDisk(manifest, actual);
    assert.deepEqual(reconciled.posts, manifest.posts);
    assert.deepEqual(downgraded, []);
  });

  it("mistura: alguns ok batem, alguns não — só os divergentes aparecem em downgraded", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [
        { post_id: "p1", status: "ok", count: 10 },
        { post_id: "p2", status: "ok", count: 0 },
        { post_id: "p3", status: "ok", count: 50 },
      ],
    };
    const actual = new Map([["p1", 10], ["p2", 0], ["p3", 12]]);
    const { downgraded } = reconcileManifestWithDisk(manifest, actual);
    assert.deepEqual(downgraded.map((d) => d.post_id).sort(), ["p2", "p3"]);
  });
});

describe("validateEngagementLine — guard de shape por linha (#7417)", () => {
  const good = {
    subscriber_id: "0987bafd-e2db-49dd-b63d-3bbd5d8f6f6b",
    email: "orobobraga@gmail.com",
    status: "opened",
    timestamp: "2026-03-18T07:14:36Z",
  };

  it("registro completo e válido passa", () => {
    assert.deepEqual(validateEngagementLine(good), { ok: true });
  });

  it("os 4 status da MCP são aceitos (medido no acervo real: delivered/opened/clicked/unsubscribed)", () => {
    for (const s of ENGAGEMENT_EVENT_STATUSES) {
      assert.deepEqual(validateEngagementLine({ ...good, status: s }), { ok: true });
    }
  });

  it("subscriber_id de placeholder do #7417 (`sub1`) é rejeitado", () => {
    const v = validateEngagementLine({ ...good, subscriber_id: "sub1" });
    assert.equal(v.ok, false);
    assert.ok(v.error.includes("subscriber_id"));
  });

  it("subscriber_id que não é UUID real é rejeitado", () => {
    assert.equal(validateEngagementLine({ ...good, subscriber_id: "not-a-uuid" }).ok, false);
  });

  it("email inválido é rejeitado", () => {
    assert.equal(validateEngagementLine({ ...good, email: "sub1" }).ok, false);
    assert.equal(validateEngagementLine({ ...good, email: "a@b" }).ok, false);
  });

  it("status desconhecido é rejeitado", () => {
    assert.equal(validateEngagementLine({ ...good, status: "bounced" }).ok, false);
  });

  it("timestamp não-ISO é rejeitado", () => {
    assert.equal(validateEngagementLine({ ...good, timestamp: "sub1" }).ok, false);
    assert.equal(validateEngagementLine({ ...good, timestamp: "2026-03-18" }).ok, false);
  });

  it("linha que não é objeto (null, array, primitivo) é rejeitada", () => {
    assert.equal(validateEngagementLine(null).ok, false);
    assert.equal(validateEngagementLine([]).ok, false);
    assert.equal(validateEngagementLine("sub1").ok, false);
  });

  it("campo ausente também é rejeitado", () => {
    const { email, ...noEmail } = good as Record<string, unknown>;
    assert.equal(validateEngagementLine(noEmail).ok, false);
  });
});

describe("reconcileShapeViolations — a 4ª checagem do #7417", () => {
  const goodLine = {
    subscriber_id: "0987bafd-e2db-49dd-b63d-3bbd5d8f6f6b",
    email: "orobobraga@gmail.com",
    status: "delivered",
    timestamp: "2026-03-18T07:14:36Z",
  };

  it("post ok com todas as linhas válidas não é rebaixado", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_clean", status: "ok", count: 2 }],
    };
    const reports = new Map<string, LineShapeReport>([
      ["post_clean", { total: 2, violations: validateEngagementLines([goodLine, goodLine]) }],
    ]);
    const { manifest: reconciled, downgraded } = reconcileShapeViolations(manifest, reports);
    assert.equal(downgraded.length, 0);
    assert.equal(reconciled.posts[0].status, "ok");
  });

  it("reproduz o #7417: 100 linhas placeholder → todas as linhas inválidas → pending (redrenar do zero)", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_077f565f", status: "ok", count: 100 }],
    };
    const placeholders = Array.from({ length: 100 }, (_, i) => ({ subscriber_id: `sub${i + 1}` }));
    const reports = new Map<string, LineShapeReport>([
      ["post_077f565f", { total: 100, violations: validateEngagementLines(placeholders) }],
    ]);
    const { manifest: reconciled, downgraded } = reconcileShapeViolations(manifest, reports);
    assert.equal(downgraded.length, 1);
    assert.equal(downgraded[0].to, "pending");
    assert.equal(reconciled.posts[0].status, "pending");
    assert.equal(reconciled.posts[0].count, 0);
  });

  it("contaminação (algumas linhas boas, algumas ruins) → partial", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_mixed", status: "ok", count: 3 }],
    };
    const reports = new Map<string, LineShapeReport>([
      [
        "post_mixed",
        {
          total: 3,
          violations: validateEngagementLines([
            goodLine,
            { subscriber_id: "sub1" },
            goodLine,
          ]),
        },
      ],
    ]);
    const { manifest: reconciled, downgraded } = reconcileShapeViolations(manifest, reports);
    assert.equal(downgraded.length, 1);
    assert.equal(downgraded[0].to, "partial");
    assert.equal(reconciled.posts[0].status, "partial");
  });

  it("post sem relatório (arquivo ausente) não é rebaixado pelo shape — já foi pending pela contagem", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_ghost", status: "ok", count: 40 }],
    };
    const { downgraded } = reconcileShapeViolations(manifest, new Map());
    assert.equal(downgraded.length, 0);
  });

  it("nunca mexe em pending/partial/error/not_applicable — só ok é candidato", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [
        { post_id: "p", status: "pending" },
        { post_id: "pa", status: "partial", count: 1 },
        { post_id: "e", status: "error" },
        { post_id: "na", status: "not_applicable" },
        { post_id: "ok", status: "ok", count: 1 },
      ],
    };
    const reports = new Map<string, LineShapeReport>([
      ["ok", { total: 1, violations: validateEngagementLines([{ subscriber_id: "sub1" }]) }],
    ]);
    const { manifest: reconciled, downgraded } = reconcileShapeViolations(manifest, reports);
    assert.equal(downgraded.length, 1);
    assert.equal(downgraded[0].post_id, "ok");
    const byId = Object.fromEntries(reconciled.posts.map((e) => [e.post_id, e.status]));
    assert.equal(byId.p, "pending");
    assert.equal(byId.pa, "partial");
    assert.equal(byId.e, "error");
    assert.equal(byId.na, "not_applicable");
  });
});

describe("reconcileManifestWithDisk — âncora externa `recipients` (#7197)", () => {
  it("o modo de falha CENTRAL do #7197: manifest e disco concordam, e mesmo assim o post está pela metade", () => {
    // Este é o caso que as checagens 1 e 2 não pegam por construção: o drenador
    // é honesto sobre o que gravou (312 = 312), ele só parou na página 1 porque
    // a resposta da MCP não traz `total_pages`. Sem a âncora externa, este post
    // passa como `ok` — foi o que aconteceu com 191 dos 255 posts do acervo.
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_truncado", status: "ok", count: 312, pages_fetched: 1, total_pages: 1 }],
    };
    const { manifest: reconciled, downgraded } = reconcileManifestWithDisk(
      manifest,
      new Map([["post_truncado", 312]]),
      new Map([["post_truncado", 1284]]),
    );
    assert.equal(reconciled.posts[0].status, "partial");
    assert.match(reconciled.posts[0].error ?? "", /1284/);
    assert.equal(downgraded.length, 1);
    assert.equal(downgraded[0].to, "partial");
  });

  it("drenagem completa (linhas ≥ recipients) continua ok", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "p", status: "ok", count: 1284 }],
    };
    const { manifest: reconciled, downgraded } = reconcileManifestWithDisk(
      manifest,
      new Map([["p", 1284]]),
      new Map([["p", 1284]]),
    );
    assert.deepEqual(reconciled.posts[0], manifest.posts[0]);
    assert.deepEqual(downgraded, []);
  });

  it("linhas ACIMA de recipients não rebaixa — a âncora é piso, não igualdade", () => {
    // `recipients` é o alcance do envio; o acervo pode ter linhas a mais
    // (reenvio, assinante que entrou depois). Só o DÉFICIT é sinal de truncagem.
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "p", status: "ok", count: 1300 }],
    };
    const { downgraded } = reconcileManifestWithDisk(manifest, new Map([["p", 1300]]), new Map([["p", 1284]]));
    assert.deepEqual(downgraded, []);
  });

  it("recipients AUSENTE pro post não rebaixa — falha de infra nunca vira veredito sobre o dado", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "p", status: "ok", count: 312 }],
    };
    const { downgraded } = reconcileManifestWithDisk(manifest, new Map([["p", 312]]), new Map());
    assert.deepEqual(downgraded, [], "post sem `recipients` conhecido fica como está");
  });

  it("mapa de recipients omitido = comportamento pré-#7197, sem quebrar chamador antigo", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "p", status: "ok", count: 312 }],
    };
    const { downgraded } = reconcileManifestWithDisk(manifest, new Map([["p", 312]]));
    assert.deepEqual(downgraded, []);
  });

  it("checagem 1 (fabricado) tem precedência sobre a âncora: 0 linhas vira pending, não partial", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "p", status: "ok", count: 0 }],
    };
    const { downgraded } = reconcileManifestWithDisk(manifest, new Map([["p", 0]]), new Map([["p", 1284]]));
    assert.equal(downgraded[0].to, "pending", "arquivo vazio é 'nunca drenado', não 'drenado pela metade'");
  });
});

describe("reconcileManifestWithDisk — âncora `delivered` tem precedência sobre `recipients` (#7268)", () => {
  it("linhas == delivered (< recipients por bounce) NÃO rebaixa — bounce nunca gera evento de engagement", () => {
    // Medido ao vivo (#7268, post_d66366ed): recipients=643, delivered=641.
    // A MCP só devolve eventos de mensagem ENTREGUE — usar `recipients` como
    // âncora tornava esta checagem inatingível pra todo post com bounce.
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "p", status: "ok", count: 641 }],
    };
    const { downgraded } = reconcileManifestWithDisk(
      manifest,
      new Map([["p", 641]]),
      new Map([["p", 643]]),
      new Map([["p", 641]]),
    );
    assert.deepEqual(downgraded, [], "delivered é o teto real e alcançável, não recipients");
  });

  it("linhas < delivered ainda rebaixa — delivered não é um passe livre, só corrige o teto", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "p", status: "ok", count: 500 }],
    };
    const { downgraded } = reconcileManifestWithDisk(
      manifest,
      new Map([["p", 500]]),
      new Map([["p", 643]]),
      new Map([["p", 641]]),
    );
    assert.equal(downgraded.length, 1);
    assert.equal(downgraded[0].to, "partial");
    assert.match(downgraded[0].reason, /delivered/);
  });

  it("delivered AUSENTE cai pra recipients — comportamento pré-#7268 preservado", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "p", status: "ok", count: 500 }],
    };
    const { downgraded } = reconcileManifestWithDisk(
      manifest,
      new Map([["p", 500]]),
      new Map([["p", 643]]),
      new Map(),
    );
    assert.equal(downgraded.length, 1);
    assert.match(downgraded[0].reason, /recipients/);
  });

  it("deliveredByPost omitido = comportamento pré-#7268, sem quebrar chamador antigo (3 args)", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "p", status: "ok", count: 641 }],
    };
    const { downgraded } = reconcileManifestWithDisk(manifest, new Map([["p", 641]]), new Map([["p", 643]]));
    assert.equal(downgraded.length, 1, "sem deliveredByPost, recipients=643 ainda rebaixa 641");
  });
});

describe("reconcileManifestWithDisk — flag `confirmed_empty` (#7418)", () => {
  it("ok com 0 linhas em disco + confirmed_empty: true → NÃO rebaixa (o vazio foi confirmado de propósito, #7197)", () => {
    // Reproduz os 6 posts confirmados vazios do #7268 (post_0dbd15c0, etc.):
    // sem o flag, a checagem 1 rebaixa pra pending e eles piscam ok→pending a
    // cada auditoria, forçando reprocessamento (~90-160k tokens por lote de 8).
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_0dbd15c0", status: "ok", count: 0, confirmed_empty: true }],
    };
    const { manifest: reconciled, downgraded } = reconcileManifestWithDisk(
      manifest,
      new Map([["post_0dbd15c0", 0]]),
    );
    assert.equal(downgraded.length, 0, "não rebaixa um post confirmado vazio de propósito");
    assert.equal(reconciled.posts[0].status, "ok");
    assert.equal(reconciled.posts[0].confirmed_empty, true, "flag preservada");
  });

  it("ok com 0 linhas em disco SEM confirmed_empty → rebaixa pra pending (comportamento de #7197 intacto)", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_fabricado", status: "ok", count: 0 }],
    };
    const { manifest: reconciled, downgraded } = reconcileManifestWithDisk(
      manifest,
      new Map([["post_fabricado", 0]]),
    );
    assert.equal(downgraded.length, 1);
    assert.equal(downgraded[0].to, "pending");
    assert.equal(reconciled.posts[0].status, "pending");
  });

  it("confirmed_empty não salva um post que TEM dados reais em disco (o flag só vale quando a checagem 1 encontraria 0 linhas)", () => {
    // O post foi re-drenado depois de confirmado vazio: o JSONL não está mais
    // vazio, então o flag não deve impedir a checagem 2 (count divergente).
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_redrenado", status: "ok", count: 100, confirmed_empty: true }],
    };
    const { manifest: reconciled, downgraded } = reconcileManifestWithDisk(
      manifest,
      new Map([["post_redrenado", 5]]),
    );
    assert.equal(downgraded.length, 1);
    assert.equal(downgraded[0].to, "partial");
    assert.equal(reconciled.posts[0].status, "partial");
    assert.equal(reconciled.posts[0].count, 5, "count corrigido pro valor real do disco");
  });

  it("confirmed_empty em post sem arquivo em disco (contagem ausente = 0) também é respeitado", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_ghost", status: "ok", count: 0, confirmed_empty: true }],
    };
    const { downgraded } = reconcileManifestWithDisk(manifest, new Map());
    assert.deepEqual(downgraded, []);
  });

  it("nunca rebaixa pending/partial/error/not_applicable — só ok é candidato (o flag não muda isso)", () => {
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [
        { post_id: "p", status: "pending" },
        { post_id: "pa", status: "partial", count: 1, confirmed_empty: true },
        { post_id: "e", status: "error", confirmed_empty: true },
        { post_id: "na", status: "not_applicable", confirmed_empty: true },
      ],
    };
    const { manifest: reconciled, downgraded } = reconcileManifestWithDisk(manifest, new Map());
    assert.deepEqual(reconciled.posts, manifest.posts);
    assert.deepEqual(downgraded, []);
  });
});
