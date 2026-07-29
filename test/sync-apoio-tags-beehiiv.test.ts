/**
 * test/sync-apoio-tags-beehiiv.test.ts (#4273 parte 2)
 *
 * Testa as funções PURAS de `scripts/sync-apoio-tags-beehiiv.ts`:
 * `computeDesiredApoioLevels` (contatos → nível desejado) e `diffApoioTags`
 * (desejado × estado atual da Beehiiv → entra/sai/muda de faixa) +
 * `shouldBlockRemovals` (guard fail-closed). Nenhum teste bate na API real —
 * `current` é sempre uma fixture `BeehiivSubscriptionSnapshot[]` construída à
 * mão, nunca vem de `fetchCurrentBeehiivState`.
 *
 * Casos obrigatórios (#4273, corpo da issue):
 *   1. Contato com múltiplos e-mails.
 *   2. Contato "sem_dados" (não pode gerar remoção).
 *   3. Mudança de faixa (troca de valor, nunca acumula duas).
 *   4. Assinante taggeado que parou de apoiar (perde o valor).
 *   5. Apoiador que não é assinante da Beehiiv (ignorado/reportado, sem erro).
 *
 * Também testa `applyApoioTagEntry` (achado #2 do review da PR #4307) — a
 * função de escrita+releitura, com `fetchImpl` mockado (nunca rede real). É o
 * mecanismo de segurança central do módulo (a lição documentada no cabeçalho
 * do arquivo: nunca confiar só no status code, sempre reler — exatamente a
 * armadilha que a issue #4273 documentou pra `tags`), então precisa de
 * cobertura direta, não só inferida via `diffApoioTags`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeDesiredApoioLevels,
  diffApoioTags,
  extractApoioNivelValue,
  shouldBlockRemovals,
  applyApoioTagEntry,
  type ApoioTagDiffEntry,
  type BeehiivSubscriptionSnapshot,
} from "../scripts/sync-apoio-tags-beehiiv.ts";
import type { ContactWithStatus } from "../scripts/studio-ui/studio-apoios.ts";

function contact(
  id: string,
  emails: string[],
  status: ContactWithStatus["status"],
): ContactWithStatus {
  return {
    id,
    name: id,
    emails,
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status,
    openRate: null,
    vinculo: null,
  };
}

function sub(subscriptionId: string, email: string, apoioNivel = ""): BeehiivSubscriptionSnapshot {
  return { subscriptionId, email, apoioNivel };
}

describe("computeDesiredApoioLevels (#4273)", () => {
  it("apoiando + monthlyValue → nível derivado de computeRewardGroup", () => {
    const result = computeDesiredApoioLevels([
      contact("c1", ["mantenedor@x.com"], { label: "apoiando", monthlyValue: 30, matchedEmail: "mantenedor@x.com" }),
    ]);
    assert.equal(result[0].level, "mantenedor");
    assert.equal(result[0].unresolved, false);
  });

  it("nao_apoia → level null, unresolved false (removal candidate, não desconhecido)", () => {
    const result = computeDesiredApoioLevels([contact("c1", ["x@x.com"], { label: "nao_apoia" })]);
    assert.equal(result[0].level, null);
    assert.equal(result[0].unresolved, false);
  });

  it("apoiou_e_parou → level null, unresolved false", () => {
    const result = computeDesiredApoioLevels([
      contact("c1", ["x@x.com"], { label: "apoiou_e_parou", lastPaidMonth: "2026-05", matchedEmail: "x@x.com" }),
    ]);
    assert.equal(result[0].level, null);
    assert.equal(result[0].unresolved, false);
  });

  it("sem_dados → level null, unresolved TRUE (desconhecido, não 'sem apoio')", () => {
    const result = computeDesiredApoioLevels([contact("c1", ["x@x.com"], { label: "sem_dados" })]);
    assert.equal(result[0].level, null);
    assert.equal(result[0].unresolved, true);
  });

  it("emails normalizados (lowercase/trim/dedup)", () => {
    const result = computeDesiredApoioLevels([
      contact("c1", [" Foo@X.com ", "foo@x.com", "bar@X.COM"], { label: "nao_apoia" }),
    ]);
    assert.deepEqual(result[0].emails, ["foo@x.com", "bar@x.com"]);
  });
});

describe("diffApoioTags — caso 1: contato com múltiplos e-mails (#4273)", () => {
  it("gera 1 entrada de diff por e-mail casado na Beehiiv", () => {
    const desired = computeDesiredApoioLevels([
      contact("c1", ["principal@x.com", "secundario@x.com"], {
        label: "apoiando",
        monthlyValue: 15,
        matchedEmail: "principal@x.com",
      }),
    ]);
    const current: BeehiivSubscriptionSnapshot[] = [
      sub("sub-1", "principal@x.com", ""),
      sub("sub-2", "secundario@x.com", ""),
    ];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.toApply.length, 2);
    assert.deepEqual(
      diff.toApply.map((e) => e.email).sort(),
      ["principal@x.com", "secundario@x.com"],
    );
    for (const e of diff.toApply) assert.equal(e.toLevel, "apoiador");
  });

  it("só o e-mail que TEM subscription Beehiiv gera diff — o outro fica de fora, sem erro", () => {
    const desired = computeDesiredApoioLevels([
      contact("c1", ["principal@x.com", "naobeehiiv@x.com"], {
        label: "apoiando",
        monthlyValue: 15,
        matchedEmail: "principal@x.com",
      }),
    ]);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "principal@x.com", "")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.toApply.length, 1);
    assert.equal(diff.toApply[0].email, "principal@x.com");
    assert.equal(diff.notBeehiivSubscriber.length, 0); // pelo menos 1 email casou — não conta como "não assinante"
  });
});

describe("diffApoioTags — caso 2: contato sem_dados nunca gera remoção (#4273)", () => {
  it("contato sem_dados TAGGEADO na Beehiiv → nenhuma ação, vai pra skippedUnresolved", () => {
    const desired = computeDesiredApoioLevels([contact("c1", ["semdados@x.com"], { label: "sem_dados" })]);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "semdados@x.com", "apoiador")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.toRemove.length, 0);
    assert.equal(diff.toApply.length, 0);
    assert.equal(diff.skippedUnresolved.length, 1);
    assert.equal(diff.skippedUnresolved[0].contactId, "c1");
  });

  it("shouldBlockRemovals: true quando há sem_dados, mesmo sem allowPartial", () => {
    const desired = computeDesiredApoioLevels([
      contact("ok", ["ok@x.com"], { label: "nao_apoia" }),
      contact("semdados", ["semdados@x.com"], { label: "sem_dados" }),
    ]);
    const current: BeehiivSubscriptionSnapshot[] = [
      sub("sub-1", "ok@x.com", "apoiador"),
      sub("sub-2", "semdados@x.com", "mantenedor"),
    ];
    const diff = diffApoioTags(desired, current);
    assert.equal(shouldBlockRemovals(null, diff, false), true);
    assert.equal(shouldBlockRemovals(null, diff, true), false); // --allow-partial força
  });

  it("shouldBlockRemovals: true quando data.error setado, mesmo sem sem_dados algum", () => {
    const desired = computeDesiredApoioLevels([contact("c1", ["x@x.com"], { label: "nao_apoia" })]);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "x@x.com", "amigo")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.skippedUnresolved.length, 0);
    assert.equal(shouldBlockRemovals("apoia.se: 401", diff, false), true);
  });

  it("shouldBlockRemovals: false quando tudo resolvido e sem erro", () => {
    const desired = computeDesiredApoioLevels([contact("c1", ["x@x.com"], { label: "nao_apoia" })]);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "x@x.com", "amigo")];
    const diff = diffApoioTags(desired, current);
    assert.equal(shouldBlockRemovals(null, diff, false), false);
  });
});

describe("diffApoioTags — caso 3: mudança de faixa (troca, nunca acumula) (#4273)", () => {
  it("apoiador → mantenedor: 1 entrada toApply com from/to corretos, nunca 2 valores simultâneos", () => {
    const desired = computeDesiredApoioLevels([
      contact("c1", ["sobe@x.com"], { label: "apoiando", monthlyValue: 30, matchedEmail: "sobe@x.com" }),
    ]);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "sobe@x.com", "apoiador")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.toApply.length, 1);
    assert.equal(diff.toApply[0].fromLevel, "apoiador");
    assert.equal(diff.toApply[0].toLevel, "mantenedor");
    assert.equal(diff.toRemove.length, 0);
    assert.equal(diff.unchanged.length, 0);
  });

  it("mesma faixa (sem mudança) → unchanged, nenhuma ação", () => {
    const desired = computeDesiredApoioLevels([
      contact("c1", ["estavel@x.com"], { label: "apoiando", monthlyValue: 12, matchedEmail: "estavel@x.com" }),
    ]);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "estavel@x.com", "apoiador")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.toApply.length, 0);
    assert.equal(diff.toRemove.length, 0);
    assert.equal(diff.unchanged.length, 1);
  });

  it("idempotência: rodar o diff 2x sobre o MESMO estado atual produz o mesmo resultado", () => {
    const desired = computeDesiredApoioLevels([
      contact("c1", ["x@x.com"], { label: "apoiando", monthlyValue: 60, matchedEmail: "x@x.com" }),
    ]);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "x@x.com", "")];
    const diff1 = diffApoioTags(desired, current);
    const diff2 = diffApoioTags(desired, current);
    assert.deepEqual(diff1.toApply, diff2.toApply);
    // Simula o estado PÓS-push (convergido) — 2ª rodada não reaplica nada.
    const converged: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "x@x.com", "patrono")];
    const diff3 = diffApoioTags(desired, converged);
    assert.equal(diff3.toApply.length, 0);
    assert.equal(diff3.toRemove.length, 0);
    assert.equal(diff3.unchanged.length, 1);
  });
});

describe("diffApoioTags — caso 4: assinante taggeado que parou de apoiar (#4273)", () => {
  it("tinha valor 'patrono', agora nao_apoia → toRemove", () => {
    const desired = computeDesiredApoioLevels([contact("c1", ["parou@x.com"], { label: "nao_apoia" })]);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "parou@x.com", "patrono")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.toRemove.length, 1);
    assert.equal(diff.toRemove[0].fromLevel, "patrono");
    assert.equal(diff.toRemove[0].toLevel, null);
    assert.equal(diff.toApply.length, 0);
  });

  it("apoiou_e_parou (histórico) também gera toRemove se ainda tem valor na Beehiiv", () => {
    const desired = computeDesiredApoioLevels([
      contact("c1", ["exapoiador@x.com"], { label: "apoiou_e_parou", lastPaidMonth: "2026-03", matchedEmail: "exapoiador@x.com" }),
    ]);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "exapoiador@x.com", "amigo")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.toRemove.length, 1);
    assert.equal(diff.toRemove[0].fromLevel, "amigo");
  });

  it("já sem valor + não apoia → unchanged (nada a remover)", () => {
    const desired = computeDesiredApoioLevels([contact("c1", ["semvalor@x.com"], { label: "nao_apoia" })]);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "semvalor@x.com", "")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.toRemove.length, 0);
    assert.equal(diff.unchanged.length, 1);
  });
});

describe("diffApoioTags — caso 5: apoiador que não é assinante da Beehiiv (#4273)", () => {
  it("nenhum e-mail do contato casa com nenhuma subscription → notBeehiivSubscriber, sem erro", () => {
    const desired = computeDesiredApoioLevels([
      contact("c1", ["naotemconta@x.com"], { label: "apoiando", monthlyValue: 20, matchedEmail: "naotemconta@x.com" }),
    ]);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "outrapessoa@x.com", "")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.notBeehiivSubscriber.length, 1);
    assert.equal(diff.notBeehiivSubscriber[0].contactId, "c1");
    assert.equal(diff.toApply.length, 0);
    assert.equal(diff.toRemove.length, 0);
  });

  it("estado da Beehiiv vazio (nenhum assinante) → todos os desejados caem em notBeehiivSubscriber", () => {
    const desired = computeDesiredApoioLevels([
      contact("c1", ["a@x.com"], { label: "apoiando", monthlyValue: 20, matchedEmail: "a@x.com" }),
      contact("c2", ["b@x.com"], { label: "nao_apoia" }),
    ]);
    const diff = diffApoioTags(desired, []);
    assert.equal(diff.notBeehiivSubscriber.length, 2);
    assert.equal(diff.toApply.length, 0);
    assert.equal(diff.toRemove.length, 0);
  });
});

describe("extractApoioNivelValue", () => {
  it("array ausente → ''", () => {
    assert.equal(extractApoioNivelValue(undefined), "");
  });

  it("campo apoio_nivel presente → valor", () => {
    assert.equal(
      extractApoioNivelValue([{ name: "apoio_nivel", value: "mantenedor" }, { name: "nps", value: 9 }]),
      "mantenedor",
    );
  });

  it("campo apoio_nivel ausente entre outros custom fields → ''", () => {
    assert.equal(extractApoioNivelValue([{ name: "setor", value: "tech" }]), "");
  });

  it("valor não-string (defensivo) → '' (nunca lança)", () => {
    assert.equal(extractApoioNivelValue([{ name: "apoio_nivel", value: 123 }]), "");
  });
});

describe("diffApoioTags — mistura completa (regressão de composição)", () => {
  it("cenário combinado: add, remove, change, sem_dados e não-assinante no mesmo diff", () => {
    const desired = computeDesiredApoioLevels([
      contact("novo", ["novo@x.com"], { label: "apoiando", monthlyValue: 8, matchedEmail: "novo@x.com" }), // amigo, novo
      contact("parou", ["parou@x.com"], { label: "nao_apoia" }), // tinha valor, perde
      contact("sobe", ["sobe@x.com"], { label: "apoiando", monthlyValue: 60, matchedEmail: "sobe@x.com" }), // troca
      contact("semdados", ["semdados@x.com"], { label: "sem_dados" }), // skip
      contact("naobeehiiv", ["naobeehiiv@x.com"], { label: "apoiando", monthlyValue: 20, matchedEmail: "naobeehiiv@x.com" }), // sem subscription
    ]);
    const current: BeehiivSubscriptionSnapshot[] = [
      sub("s-novo", "novo@x.com", ""),
      sub("s-parou", "parou@x.com", "apoiador"),
      sub("s-sobe", "sobe@x.com", "apoiador"),
      sub("s-semdados", "semdados@x.com", "amigo"),
    ];
    const diff = diffApoioTags(desired, current);

    assert.equal(diff.toApply.length, 2); // novo (amigo) + sobe (mantenedor→patrono)
    assert.equal(diff.toRemove.length, 1); // parou
    assert.equal(diff.skippedUnresolved.length, 1); // semdados
    assert.equal(diff.notBeehiivSubscriber.length, 1); // naobeehiiv

    const novoEntry = diff.toApply.find((e) => e.email === "novo@x.com");
    assert.equal(novoEntry?.toLevel, "amigo");
    const sobeEntry = diff.toApply.find((e) => e.email === "sobe@x.com");
    assert.equal(sobeEntry?.fromLevel, "apoiador");
    assert.equal(sobeEntry?.toLevel, "patrono");
  });
});

// ── applyApoioTagEntry (escrita + releitura, I/O mockado, #4307 achado 2) ──

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Mock sequencial de `typeof fetch`: a N-ésima chamada recebe a N-ésima
 * resposta da lista (a última se a lista acabar). Grava todas as chamadas
 * (`calls`) pra assert de método/body — nunca faz rede real. */
function mockFetchSeq(responses: Array<{ status: number; body?: unknown }>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method, body });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: () => null },
      text: async () => (r.body !== undefined ? JSON.stringify(r.body) : ""),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function diffEntry(overrides: Partial<ApoioTagDiffEntry>): ApoioTagDiffEntry {
  return {
    contactId: "c1",
    contactName: "Fulano",
    email: "fulano@x.com",
    subscriptionId: "sub-1",
    fromLevel: null,
    toLevel: "amigo",
    ...overrides,
  };
}

function subscriptionBody(email: string, customFields: Array<{ name: string; value: unknown }>) {
  return { data: { id: "sub-1", email, status: "active", custom_fields: customFields } };
}

describe("applyApoioTagEntry (#4307 achado 2 — write+reread nunca testado)", () => {
  it("(a) PUT ok + GET confirma o valor esperado → resolve limpo", async () => {
    const entry = diffEntry({ email: "confirma@x.com", toLevel: "mantenedor" });
    const { fetchImpl, calls } = mockFetchSeq([
      { status: 200, body: { data: { id: "sub-1" } } },
      { status: 200, body: subscriptionBody("confirma@x.com", [{ name: "apoio_nivel", value: "mantenedor" }]) },
    ]);
    await assert.doesNotReject(applyApoioTagEntry(entry, "pub-1", "key", fetchImpl));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "PUT");
    assert.equal(calls[1].method, "GET");
  });

  it("(a.1) body do PUT — add/troca usa {name, value} (nunca delete)", async () => {
    const entry = diffEntry({ email: "add@x.com", fromLevel: null, toLevel: "amigo" });
    const { fetchImpl, calls } = mockFetchSeq([
      { status: 200, body: {} },
      { status: 200, body: subscriptionBody("add@x.com", [{ name: "apoio_nivel", value: "amigo" }]) },
    ]);
    await applyApoioTagEntry(entry, "pub-1", "key", fetchImpl);
    assert.deepEqual(calls[0].body, { custom_fields: [{ name: "apoio_nivel", value: "amigo" }] });
  });

  it("(e) remoção (toLevel null) — body usa {name, delete:true}, releitura confirma ausência", async () => {
    const entry = diffEntry({ email: "parou@x.com", fromLevel: "patrono", toLevel: null });
    const { fetchImpl, calls } = mockFetchSeq([
      { status: 200, body: {} },
      { status: 200, body: subscriptionBody("parou@x.com", []) },
    ]);
    await assert.doesNotReject(applyApoioTagEntry(entry, "pub-1", "key", fetchImpl));
    assert.deepEqual(calls[0].body, { custom_fields: [{ name: "apoio_nivel", delete: true }] });
  });

  it("(b) PUT retorna não-ok → lança erro com email e nível alvo na mensagem", async () => {
    const entry = diffEntry({ email: "putfalha@x.com", toLevel: "apoiador" });
    const { fetchImpl } = mockFetchSeq([{ status: 500 }]);
    await assert.rejects(applyApoioTagEntry(entry, "pub-1", "key", fetchImpl), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /putfalha@x\.com/);
      assert.match(err.message, /apoiador/);
      return true;
    });
  });

  it("(c) GET pós-escrita falha → lança erro DISTINTO (releitura, não PUT)", async () => {
    const entry = diffEntry({ email: "getfalha@x.com", toLevel: "mantenedor" });
    const { fetchImpl } = mockFetchSeq([
      { status: 200, body: {} }, // PUT ok
      { status: 500 }, // GET falha
    ]);
    await assert.rejects(applyApoioTagEntry(entry, "pub-1", "key", fetchImpl), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /releitura pós-escrita falhou/);
      return true;
    });
  });

  it("(d) GET ok mas valor relido ≠ esperado → lança erro com valor esperado E valor real", async () => {
    // Cenário exato documentado pela issue #4273 pra `tags`: PUT responde 200
    // mas a mutação não pegou — a releitura devolve o valor ANTIGO.
    const entry = diffEntry({ email: "diverge@x.com", fromLevel: "apoiador", toLevel: "patrono" });
    const { fetchImpl } = mockFetchSeq([
      { status: 200, body: {} },
      { status: 200, body: subscriptionBody("diverge@x.com", [{ name: "apoio_nivel", value: "apoiador" }]) },
    ]);
    await assert.rejects(applyApoioTagEntry(entry, "pub-1", "key", fetchImpl), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /"patrono"/); // esperado
      assert.match(err.message, /"apoiador"/); // encontrado
      assert.match(err.message, /NÃO confere/);
      return true;
    });
  });

  it("(d.1) remoção esperada mas releitura ainda mostra valor antigo → lança erro", async () => {
    const entry = diffEntry({ email: "removeFalha@x.com", fromLevel: "amigo", toLevel: null });
    const { fetchImpl } = mockFetchSeq([
      { status: 200, body: {} },
      { status: 200, body: subscriptionBody("removeFalha@x.com", [{ name: "apoio_nivel", value: "amigo" }]) },
    ]);
    await assert.rejects(applyApoioTagEntry(entry, "pub-1", "key", fetchImpl), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /NÃO confere/);
      return true;
    });
  });
});
