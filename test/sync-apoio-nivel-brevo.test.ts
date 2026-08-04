/**
 * test/sync-apoio-nivel-brevo.test.ts (#4572)
 *
 * Testa as funções PURAS de `scripts/sync-apoio-nivel-brevo.ts` — paridade
 * Brevo de `test/sync-apoio-nivel-beehiiv.test.ts` (#4273/#4436), adaptada ao
 * modelo de estado atual daqui (membresia de LISTA Brevo, não custom field
 * por assinatura): `diffApoioBrevo` (desejado × membresia atual → adiciona/
 * troca/remove), `evaluateBrevoBlastRadiusGuard` (guard de magnitude de
 * remoções, mesmo limiar 30% do #4436) e as funções de I/O
 * (`fetchCurrentBrevoApoiadoresState`, `applyBrevoApoioAddEntry`,
 * `applyBrevoApoioRemoveEntry`) com `globalThis.fetch` mockado — nenhum teste
 * bate na API real.
 *
 * `computeDesiredApoioLevels` (a fonte de "quem é apoiador") já tem cobertura
 * própria e completa em `test/sync-apoio-nivel-beehiiv.test.ts` (carência de
 * 1 mês, sem_dados, múltiplos e-mails) — não duplicada aqui, já que este
 * arquivo importa a MESMA função sem reimplementá-la (ver docstring do
 * módulo). Os testes abaixo focam no que é NOVO/diferente pra Brevo:
 * a diferença de modelo de estado atual (lista vs. custom field) e a
 * possibilidade de criar contatos novos (a Beehiiv só marca assinantes já
 * existentes).
 *
 * Casos obrigatórios (mirror do #4273/#4436, adaptado):
 *   1. Contato-alvo (Mantenedor/Patrono) com múltiplos e-mails, nenhum ainda
 *      membro da lista → toApply pros dois.
 *   2. Contato "sem_dados" → nenhuma ação, mesmo já sendo membro.
 *   3. Troca de faixa entre os dois níveis-alvo (Mantenedor↔Patrono) → 1
 *      entrada toApply, nunca acumula.
 *   4. Membro atual cujo nível caiu abaixo do alvo (Amigo/Apoiador/null) →
 *      toRemove.
 *   5. Contato-alvo que NUNCA foi contato Brevo (não é membro de nada) →
 *      ainda assim toApply (diferença deliberada do espelho Beehiiv).
 *   6. Membro atual sem NENHUM contato apoia.se correspondente →
 *      untrackedMembers, nunca removido automaticamente.
 *   7. Guard de blast radius: limiar exato (30%) não bloqueia, acima bloqueia,
 *      --force-blast-radius sempre libera.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  diffApoioBrevo,
  isTargetLevel,
  evaluateBrevoBlastRadiusGuard,
  fetchCurrentBrevoApoiadoresState,
  applyBrevoApoioAddEntry,
  applyBrevoApoioRemoveEntry,
  APOIO_NIVEL_ATTR_NAME,
  type BrevoApoiadorMember,
} from "../scripts/sync-apoio-nivel-brevo.ts";
import { computeDesiredApoioLevels } from "../scripts/sync-apoio-nivel-beehiiv.ts";
import type { ContactWithStatus } from "../scripts/studio-ui/studio-apoios.ts";

const NO_HISTORY_MONTH = "2026-08";

function contact(id: string, emails: string[], status: ContactWithStatus["status"]): ContactWithStatus {
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

function member(email: string, apoioNivel = ""): BrevoApoiadorMember {
  return { email, apoioNivel };
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Resposta sem corpo — a Brevo real devolve 204 sem body pro PUT de
 * `/contacts/{id}` (mesmo padrão de `evaluate-brevo-diaria.ts`); o
 * construtor de `Response` proíbe corpo em status 204/205/304. */
function emptyRes(status: number): Response {
  return new Response(null, { status });
}

describe("isTargetLevel (#4572)", () => {
  it("mantenedor/patrono são alvo", () => {
    assert.equal(isTargetLevel("mantenedor"), true);
    assert.equal(isTargetLevel("patrono"), true);
  });
  it("amigo/apoiador/null não são alvo", () => {
    assert.equal(isTargetLevel("amigo"), false);
    assert.equal(isTargetLevel("apoiador"), false);
    assert.equal(isTargetLevel(null), false);
  });
});

describe("diffApoioBrevo — caso 1: contato-alvo com múltiplos e-mails, nenhum ainda membro (#4572)", () => {
  it("gera 1 entrada toApply por e-mail conhecido, mesmo sem nenhum ser contato Brevo ainda", () => {
    const desired = computeDesiredApoioLevels(
      [
        contact("c1", ["principal@x.com", "secundario@x.com"], {
          label: "apoiando",
          monthlyValue: 30,
          matchedEmail: "principal@x.com",
        }),
      ],
      [],
      NO_HISTORY_MONTH,
    );
    const diff = diffApoioBrevo(desired, []);
    assert.equal(diff.toApply.length, 2);
    assert.deepEqual(
      diff.toApply.map((e) => e.email).sort(),
      ["principal@x.com", "secundario@x.com"],
    );
    for (const e of diff.toApply) {
      assert.equal(e.toLevel, "mantenedor");
      assert.equal(e.fromLevel, null);
    }
    assert.equal(diff.toRemove.length, 0);
    assert.equal(diff.unchanged.length, 0);
  });
});

describe("diffApoioBrevo — caso 2: sem_dados nunca gera ação, mesmo já membro (#4572)", () => {
  it("contato sem_dados, e-mail já na lista com nível setado → skippedUnresolved, nenhuma ação", () => {
    const desired = computeDesiredApoioLevels([contact("c1", ["semdados@x.com"], { label: "sem_dados" })], [], NO_HISTORY_MONTH);
    const current = [member("semdados@x.com", "mantenedor")];
    const diff = diffApoioBrevo(desired, current);
    assert.equal(diff.toApply.length, 0);
    assert.equal(diff.toRemove.length, 0);
    assert.equal(diff.unchanged.length, 0);
    assert.equal(diff.skippedUnresolved.length, 1);
    assert.equal(diff.skippedUnresolved[0].contactId, "c1");
  });
});

describe("diffApoioBrevo — caso 3: troca de faixa entre os dois níveis-alvo (#4572)", () => {
  it("mantenedor → patrono: 1 entrada toApply com from/to corretos, nunca 2 valores simultâneos", () => {
    const desired = computeDesiredApoioLevels(
      [contact("c1", ["sobe@x.com"], { label: "apoiando", monthlyValue: 60, matchedEmail: "sobe@x.com" })],
      [],
      NO_HISTORY_MONTH,
    );
    const current = [member("sobe@x.com", "mantenedor")];
    const diff = diffApoioBrevo(desired, current);
    assert.equal(diff.toApply.length, 1);
    assert.equal(diff.toApply[0].fromLevel, "mantenedor");
    assert.equal(diff.toApply[0].toLevel, "patrono");
    assert.equal(diff.toRemove.length, 0);
    assert.equal(diff.unchanged.length, 0);
  });

  it("mesma faixa-alvo (sem mudança) → unchanged, nenhuma ação", () => {
    const desired = computeDesiredApoioLevels(
      [contact("c1", ["estavel@x.com"], { label: "apoiando", monthlyValue: 60, matchedEmail: "estavel@x.com" })],
      [],
      NO_HISTORY_MONTH,
    );
    const current = [member("estavel@x.com", "patrono")];
    const diff = diffApoioBrevo(desired, current);
    assert.equal(diff.toApply.length, 0);
    assert.equal(diff.toRemove.length, 0);
    assert.equal(diff.unchanged.length, 1);
  });
});

describe("diffApoioBrevo — caso 4: membro atual cujo nível caiu abaixo do alvo (#4572)", () => {
  it("mantenedor → apoiador (abaixo do alvo): remove da lista", () => {
    const desired = computeDesiredApoioLevels(
      [contact("c1", ["desce@x.com"], { label: "apoiando", monthlyValue: 15, matchedEmail: "desce@x.com" })],
      [],
      NO_HISTORY_MONTH,
    );
    const current = [member("desce@x.com", "mantenedor")];
    const diff = diffApoioBrevo(desired, current);
    assert.equal(diff.toApply.length, 0);
    assert.equal(diff.toRemove.length, 1);
    assert.equal(diff.toRemove[0].email, "desce@x.com");
    assert.equal(diff.toRemove[0].fromLevel, "mantenedor");
  });

  it("mantenedor → nao_apoia (parou de apoiar, sem carência disponível): remove da lista", () => {
    const desired = computeDesiredApoioLevels(
      [contact("c1", ["parou@x.com"], { label: "nao_apoia" })],
      [],
      NO_HISTORY_MONTH,
    );
    const current = [member("parou@x.com", "patrono")];
    const diff = diffApoioBrevo(desired, current);
    assert.equal(diff.toRemove.length, 1);
    assert.equal(diff.toRemove[0].fromLevel, "patrono");
  });

  it("nunca foi membro e não é alvo → nenhuma ação (nunca criado, correto)", () => {
    const desired = computeDesiredApoioLevels([contact("c1", ["nunca@x.com"], { label: "nao_apoia" })], [], NO_HISTORY_MONTH);
    const diff = diffApoioBrevo(desired, []);
    assert.equal(diff.toApply.length, 0);
    assert.equal(diff.toRemove.length, 0);
    assert.equal(diff.unchanged.length, 0);
  });
});

describe("diffApoioBrevo — caso 5: contato-alvo nunca foi contato Brevo (diferença deliberada do espelho Beehiiv)", () => {
  it("cria mesmo sem nenhum e-mail já ser contato Brevo (aqui a lista é própria/dedicada)", () => {
    const desired = computeDesiredApoioLevels(
      [contact("c1", ["novo@x.com"], { label: "apoiando", monthlyValue: 60, matchedEmail: "novo@x.com" })],
      [],
      NO_HISTORY_MONTH,
    );
    const diff = diffApoioBrevo(desired, []);
    assert.equal(diff.toApply.length, 1);
    assert.equal(diff.toApply[0].email, "novo@x.com");
    assert.equal(diff.toApply[0].toLevel, "patrono");
  });
});

describe("diffApoioBrevo — caso 6: membro atual sem contato apoia.se correspondente (#4572)", () => {
  it("vai pra untrackedMembers, nunca removido automaticamente", () => {
    const desired = computeDesiredApoioLevels(
      [contact("c1", ["conhecido@x.com"], { label: "apoiando", monthlyValue: 60, matchedEmail: "conhecido@x.com" })],
      [],
      NO_HISTORY_MONTH,
    );
    const current = [member("conhecido@x.com", "patrono"), member("orfao@x.com", "mantenedor")];
    const diff = diffApoioBrevo(desired, current);
    assert.equal(diff.toRemove.length, 0);
    assert.deepEqual(diff.untrackedMembers, ["orfao@x.com"]);
  });
});

describe("evaluateBrevoBlastRadiusGuard — limiar 30% (#4436, paridade #4572)", () => {
  it("no limiar EXATO (30%) não bloqueia", () => {
    const result = evaluateBrevoBlastRadiusGuard(3, 10, false);
    assert.equal(result.ratio, 0.3);
    assert.equal(result.blocked, false);
  });

  it("acima do limiar bloqueia", () => {
    const result = evaluateBrevoBlastRadiusGuard(4, 10, false);
    assert.ok(result.ratio > 0.3);
    assert.equal(result.blocked, true);
  });

  it("--force-blast-radius sempre libera, mesmo muito acima do limiar", () => {
    const result = evaluateBrevoBlastRadiusGuard(9, 10, true);
    assert.equal(result.blocked, false);
  });

  it("currentMemberCount 0 → ratio 0 (nunca divide por zero)", () => {
    const result = evaluateBrevoBlastRadiusGuard(0, 0, false);
    assert.equal(result.ratio, 0);
    assert.equal(result.blocked, false);
  });
});

describe("fetchCurrentBrevoApoiadoresState — paginação + leitura do atributo (#4572)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("página única (< limit) → não pagina de novo", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonRes(200, {
        contacts: [
          { email: "a@x.com", attributes: { [APOIO_NIVEL_ATTR_NAME]: "mantenedor" } },
          { email: "B@X.com ".trim(), attributes: {} },
        ],
      });
    }) as typeof fetch;
    try {
      const out = await fetchCurrentBrevoApoiadoresState("key", 42);
      assert.equal(calls, 1);
      assert.deepEqual(out, [
        { email: "a@x.com", apoioNivel: "mantenedor" },
        { email: "b@x.com", apoioNivel: "" },
      ]);
    } finally {
      restore();
    }
  });

  it("página cheia (=== limit) → busca a próxima página até vir incompleta", async () => {
    let calls = 0;
    globalThis.fetch = (async (url: string | URL) => {
      calls++;
      const u = String(url);
      if (u.includes("offset=0")) {
        const page = Array.from({ length: 50 }, (_, i) => ({ email: `p1-${i}@x.com`, attributes: {} }));
        return jsonRes(200, { contacts: page });
      }
      return jsonRes(200, { contacts: [{ email: "ultimo@x.com", attributes: {} }] });
    }) as typeof fetch;
    try {
      const out = await fetchCurrentBrevoApoiadoresState("key", 42);
      assert.equal(calls, 2);
      assert.equal(out.length, 51);
    } finally {
      restore();
    }
  });

  it("status != 200 em qualquer página → lança (fail loud, nunca lista truncada silenciosa)", async () => {
    // 404 (não 500/429): brevoGet devolve {status,body} sem retry pra 404 —
    // usar 5xx/429 aqui disparia o backoff real de brevoGet (até 13s de
    // espera de verdade, `_sleep` não é injetável através desta função) sem
    // testar nada além do que já é coberto por test/brevo-get-retry.test.ts.
    globalThis.fetch = (async () => jsonRes(404, { message: "not found" })) as typeof fetch;
    try {
      await assert.rejects(() => fetchCurrentBrevoApoiadoresState("key", 42), /Brevo API 404/);
    } finally {
      restore();
    }
  });
});

describe("applyBrevoApoioAddEntry — cria/atualiza + verifica por releitura (#4572)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("sucesso: POST upsert com listIds+attributes, GET confirma os dois", async () => {
    let posted: unknown;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted = JSON.parse(init.body as string);
        return jsonRes(201, {});
      }
      return jsonRes(200, { email: "a@x.com", listIds: [42], attributes: { [APOIO_NIVEL_ATTR_NAME]: "patrono" } });
    }) as typeof fetch;
    try {
      await applyBrevoApoioAddEntry({ contactId: "c1", contactName: "C1", email: "a@x.com", fromLevel: null, toLevel: "patrono" }, 42, "key");
      assert.deepEqual(posted, {
        email: "a@x.com",
        listIds: [42],
        attributes: { [APOIO_NIVEL_ATTR_NAME]: "patrono" },
        updateEnabled: true,
      });
    } finally {
      restore();
    }
  });

  it("releitura sem o list_id esperado → lança (mutação não confirmada)", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonRes(201, {});
      return jsonRes(200, { email: "a@x.com", listIds: [999], attributes: { [APOIO_NIVEL_ATTR_NAME]: "patrono" } });
    }) as typeof fetch;
    try {
      await assert.rejects(
        () => applyBrevoApoioAddEntry({ contactId: "c1", contactName: "C1", email: "a@x.com", fromLevel: null, toLevel: "patrono" }, 42, "key"),
        /NÃO confere/,
      );
    } finally {
      restore();
    }
  });

  it("releitura com atributo divergente → lança (mutação não confirmada)", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonRes(201, {});
      return jsonRes(200, { email: "a@x.com", listIds: [42], attributes: { [APOIO_NIVEL_ATTR_NAME]: "mantenedor" } });
    }) as typeof fetch;
    try {
      await assert.rejects(
        () => applyBrevoApoioAddEntry({ contactId: "c1", contactName: "C1", email: "a@x.com", fromLevel: null, toLevel: "patrono" }, 42, "key"),
        /NÃO confere/,
      );
    } finally {
      restore();
    }
  });

  it("releitura com status != 200 → lança", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonRes(201, {});
      return jsonRes(404, {});
    }) as typeof fetch;
    try {
      await assert.rejects(
        () => applyBrevoApoioAddEntry({ contactId: "c1", contactName: "C1", email: "a@x.com", fromLevel: null, toLevel: "patrono" }, 42, "key"),
        /releitura pós-escrita falhou/,
      );
    } finally {
      restore();
    }
  });
});

describe("applyBrevoApoioRemoveEntry — desvincula da lista + verifica por releitura (#4572)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("sucesso: PUT unlinkListIds, GET confirma ausência do list_id", async () => {
    let putBody: unknown;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(init.body as string);
        return emptyRes(204);
      }
      return jsonRes(200, { email: "a@x.com", listIds: [] });
    }) as typeof fetch;
    try {
      await applyBrevoApoioRemoveEntry({ contactId: "c1", contactName: "C1", email: "a@x.com", fromLevel: "mantenedor" }, 42, "key");
      assert.deepEqual(putBody, { unlinkListIds: [42] });
    } finally {
      restore();
    }
  });

  it("releitura ainda mostra o list_id → lança (mutação não confirmada)", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return emptyRes(204);
      return jsonRes(200, { email: "a@x.com", listIds: [42] });
    }) as typeof fetch;
    try {
      await assert.rejects(
        () => applyBrevoApoioRemoveEntry({ contactId: "c1", contactName: "C1", email: "a@x.com", fromLevel: "mantenedor" }, 42, "key"),
        /NÃO confere/,
      );
    } finally {
      restore();
    }
  });

  it("releitura com status != 200 → lança", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return emptyRes(204);
      return jsonRes(404, {});
    }) as typeof fetch;
    try {
      await assert.rejects(
        () => applyBrevoApoioRemoveEntry({ contactId: "c1", contactName: "C1", email: "a@x.com", fromLevel: "mantenedor" }, 42, "key"),
        /releitura pós-remoção falhou/,
      );
    } finally {
      restore();
    }
  });
});
