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
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  diffApoioBrevo,
  isTargetLevel,
  evaluateBrevoBlastRadiusGuard,
  fetchCurrentBrevoApoiadoresState,
  applyBrevoApoioAddEntry,
  applyBrevoApoioRemoveEntry,
  applyBrevoApoioDiff,
  ensureContactAttribute,
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
    // #4437 Entrega 2 acrescentou estes 2 campos a `ContactWithStatus` e
    // este fixture ficou pra trás (baseline do typecheck-ratchet). `null` =
    // "não aplicável / nunca consultado" — nada aqui depende deles.
    rewardLevel: null,
    segments: null,
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

describe("evaluateBrevoBlastRadiusGuard — freio removido (#6793 Faixa A, item 8)", () => {
  it("no limiar EXATO (30%) não bloqueia — nunca bloqueou, comportamento preservado", () => {
    const result = evaluateBrevoBlastRadiusGuard(3, 10, false);
    assert.equal(result.ratio, 0.3);
    assert.equal(result.blocked, false);
  });

  it("#6793: acima do limiar histórico (30%) NÃO bloqueia mais — guard desativado", () => {
    const result = evaluateBrevoBlastRadiusGuard(4, 10, false);
    assert.ok(result.ratio > 0.3);
    assert.equal(result.blocked, false);
  });

  it("--force-blast-radius: sem efeito (guard já não bloqueia nada), sempre libera", () => {
    const result = evaluateBrevoBlastRadiusGuard(9, 10, true);
    assert.equal(result.blocked, false);
  });

  it("#6793: mesmo removendo 100% dos membros, não bloqueia", () => {
    const result = evaluateBrevoBlastRadiusGuard(10, 10, false);
    assert.equal(result.ratio, 1);
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

describe("ensureContactAttribute — cria o atributo APOIO_NIVEL quando ausente (#4634)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("atributo ausente: cria via POST /contacts/attributes/normal/APOIO_NIVEL, confirma por releitura", async () => {
    let createCall: unknown;
    let getCalls = 0;
    let created = false;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === undefined || init.method === "GET") {
        assert.equal(url.pathname, "/v3/contacts/attributes");
        getCalls++;
        // Simula estado real da conta: só aparece na listagem DEPOIS do POST
        // de criação — exercita a releitura pós-escrita (#4634 item 2).
        return jsonRes(200, { attributes: created ? [{ name: "APOIO_NIVEL", category: "normal", type: "text" }] : [] });
      }
      if (init.method === "POST") {
        assert.equal(url.pathname, "/v3/contacts/attributes/normal/APOIO_NIVEL");
        createCall = JSON.parse(init.body as string);
        created = true;
        return jsonRes(201, { name: "APOIO_NIVEL" });
      }
      throw new Error(`unexpected fetch: ${init.method} ${url.pathname}`);
    }) as typeof fetch;
    try {
      await ensureContactAttribute("key");
      assert.deepEqual(createCall, { type: "text" });
      assert.equal(getCalls, 2, "deveria reler /contacts/attributes após o POST pra confirmar a criação");
    } finally {
      restore();
    }
  });

  it("atributo já existe: NÃO chama POST (idempotente, evita recriação) e não releitura desnecessária", async () => {
    let postCalled = false;
    let getCalls = 0;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === undefined || init.method === "GET") {
        assert.equal(url.pathname, "/v3/contacts/attributes");
        getCalls++;
        return jsonRes(200, { attributes: [{ name: "APOIO_NIVEL", category: "normal", type: "text" }] });
      }
      if (init.method === "POST") {
        postCalled = true;
        return jsonRes(201, {});
      }
      throw new Error(`unexpected fetch: ${init.method} ${url.pathname}`);
    }) as typeof fetch;
    try {
      await ensureContactAttribute("key");
      assert.equal(postCalled, false, "não deveria recriar um atributo que já existe");
      assert.equal(getCalls, 1, "atributo já existente é confirmado numa única leitura, sem POST nem 2ª GET");
    } finally {
      restore();
    }
  });

  it("GET /contacts/attributes falha (status != 200) → rejeita, nunca trata como lista vazia (#4634 item 3)", async () => {
    globalThis.fetch = (async () => jsonRes(404, { message: "not found" })) as typeof fetch;
    try {
      await assert.rejects(() => ensureContactAttribute("key"), /Brevo API 404 em \/contacts\/attributes/);
    } finally {
      restore();
    }
  });

  it("POST de criação falha (400) → rejeita (#4634 item 4)", async () => {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === undefined || init.method === "GET") {
        assert.equal(url.pathname, "/v3/contacts/attributes");
        return jsonRes(200, { attributes: [] });
      }
      if (init.method === "POST") {
        return jsonRes(400, { message: "invalid attribute name" });
      }
      throw new Error(`unexpected fetch: ${init.method} ${url.pathname}`);
    }) as typeof fetch;
    try {
      await assert.rejects(() => ensureContactAttribute("key"), /Brevo API POST/);
    } finally {
      restore();
    }
  });

  it("POST 2xx mas atributo NÃO aparece na releitura → rejeita (mutação não confirmada)", async () => {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === undefined || init.method === "GET") {
        assert.equal(url.pathname, "/v3/contacts/attributes");
        // Sempre vazio, mesmo depois do POST — simula o mesmo padrão de
        // silêncio já visto na Beehiiv (#4273): 2xx que não persiste nada.
        return jsonRes(200, { attributes: [] });
      }
      if (init.method === "POST") {
        return jsonRes(201, { name: "APOIO_NIVEL" });
      }
      throw new Error(`unexpected fetch: ${init.method} ${url.pathname}`);
    }) as typeof fetch;
    try {
      await assert.rejects(() => ensureContactAttribute("key"), /NÃO confere/);
    } finally {
      restore();
    }
  });
});

describe("applyBrevoApoioDiff — wiring: ensureContactAttribute roda ANTES da 1ª aplicação (#4634)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("com toApply não-vazio: atributo é garantido (GET+POST) ANTES do 1º POST /contacts de aplicação", async () => {
    const callOrder: string[] = [];
    let attributeExists = false;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/v3/contacts/attributes") {
        callOrder.push("GET-attributes");
        return jsonRes(200, {
          attributes: attributeExists ? [{ name: "APOIO_NIVEL", category: "normal", type: "text" }] : [],
        });
      }
      if (method === "POST" && url.pathname === "/v3/contacts/attributes/normal/APOIO_NIVEL") {
        callOrder.push("POST-create-attribute");
        attributeExists = true;
        return jsonRes(201, { name: "APOIO_NIVEL" });
      }
      if (method === "POST" && url.pathname === "/v3/contacts") {
        callOrder.push("POST-apply-contact");
        return jsonRes(201, {});
      }
      if (method === "GET" && url.pathname.startsWith("/v3/contacts/")) {
        // releitura pós-escrita de applyBrevoApoioAddEntry
        return jsonRes(200, { email: "a@x.com", listIds: [42], attributes: { APOIO_NIVEL: "patrono" } });
      }
      throw new Error(`unexpected fetch: ${method} ${url.pathname}`);
    }) as typeof fetch;

    try {
      const result = await applyBrevoApoioDiff(
        [{ contactId: "c1", contactName: "C1", email: "a@x.com", fromLevel: null, toLevel: "patrono" }],
        [],
        42,
        "key",
        () => {},
      );
      assert.equal(result.applied, 1);
      assert.equal(result.failed, 0);
      const attrIdx = callOrder.indexOf("POST-create-attribute");
      const applyIdx = callOrder.indexOf("POST-apply-contact");
      assert.ok(attrIdx !== -1, "deveria ter criado o atributo");
      assert.ok(applyIdx !== -1, "deveria ter aplicado o contato");
      assert.ok(
        attrIdx < applyIdx,
        `criação do atributo (idx ${attrIdx}) deveria vir ANTES da aplicação (idx ${applyIdx}) — ordem real: ${callOrder.join(" -> ")}`,
      );
    } finally {
      restore();
    }
  });

  it("com toApply vazio (só remoções): NUNCA chama o endpoint de atributos", async () => {
    let calledAttrEndpoint = false;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname.includes("/contacts/attributes")) {
        calledAttrEndpoint = true;
      }
      if (method === "PUT" && url.pathname.startsWith("/v3/contacts/")) {
        return emptyRes(204);
      }
      if (method === "GET" && url.pathname.startsWith("/v3/contacts/")) {
        return jsonRes(200, { email: "b@x.com", listIds: [] });
      }
      throw new Error(`unexpected fetch: ${method} ${url.pathname}`);
    }) as typeof fetch;

    try {
      const result = await applyBrevoApoioDiff(
        [],
        [{ contactId: "c2", contactName: "C2", email: "b@x.com", fromLevel: "mantenedor" }],
        42,
        "key",
        () => {},
      );
      assert.equal(result.applied, 1);
      assert.equal(calledAttrEndpoint, false, "sem adições, ensureContactAttribute nunca deveria ser chamado");
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

describe("sync-apoio-nivel-brevo.ts exit semantics (#4651, mesma classe do #4638/#1401)", () => {
  // Regressão: process.exit(1) chamado DEPOIS de um await fetch
  // (runApoioReconciliationCycle, buildApoiosData, fetchCurrentBrevoApoiadoresState
  // e/ou applyBrevoApoioDiff) derruba o processo no Windows com
  // UV_HANDLE_CLOSING enquanto o fetch agent ainda tem sockets keep-alive
  // abertos. Fix: process.exitCode nos branches pós-await (erro de
  // autenticação apoia.se, resumo do --push) e no catch handler do
  // isMainModule(). Os guards pré-await (config ausente, list_id ausente,
  // API key ausente) ficam como process.exit(2) de propósito — nenhum fetch
  // rodou ainda nesses pontos. #6793 "Faixa A" item 8 (30/08/2026): o 3º
  // branch original (guard de blast radius bloqueado) foi REMOVIDO junto
  // com o guard — nunca mais executava (blocked sempre false) — por isso a
  // contagem abaixo caiu de 3 para 2.
  const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "sync-apoio-nivel-brevo.ts");

  function readMainAndCatchBodies(): { mainBody: string; catchBody: string } {
    const source = readFileSync(SCRIPT, "utf8");
    const sourceNoComments = source.replace(/\/\/.*$/gm, "");
    const mainMatch = sourceNoComments.match(/async function main\([^)]*\)[^{]*\{[\s\S]*?\n\}\n\nif \(isMainModule/);
    assert.ok(mainMatch, "main() não encontrada em sync-apoio-nivel-brevo.ts");
    const catchMatch = sourceNoComments.match(/if \(isMainModule\(import\.meta\.url\)\) \{[\s\S]*?\n\}\n?$/);
    assert.ok(catchMatch, "bloco isMainModule() não encontrado em sync-apoio-nivel-brevo.ts");
    return { mainBody: mainMatch[0], catchBody: catchMatch[0] };
  }

  it("#6793: branches pós-await (exit 1 — authError, resumo --push) usam process.exitCode, não process.exit (#4651)", () => {
    const { mainBody } = readMainAndCatchBodies();
    assert.equal(
      /process\.exit\(1\)/.test(mainBody),
      false,
      "process.exit(1) não deveria mais existir em main() — usar process.exitCode (#4651 Windows crash)",
    );
    // 2 ocorrências esperadas desde #6793 (era 3): authError, resumo do
    // --push. O 3º branch (blast radius bloqueado) foi removido — o guard
    // nunca mais bloqueia (item 8).
    const matches = mainBody.match(/process\.exitCode = 1/g) ?? [];
    assert.equal(matches.length, 2, `esperava 2 ocorrências de process.exitCode = 1 (#6793), achei ${matches.length}`);
  });

  it("guards pré-await (exit 2 — config, list_id, API key) continuam com process.exit — sem risco libuv (#4651)", () => {
    const { mainBody } = readMainAndCatchBodies();
    assert.match(
      mainBody,
      /process\.exit\(2\)/,
      "process.exit(2) deveria continuar existindo (guards pré-await, seguros)",
    );
  });

  it("catch handler do isMainModule() usa process.exitCode, não process.exit (#4651)", () => {
    const { catchBody } = readMainAndCatchBodies();
    assert.equal(
      /process\.exit\s*\(/.test(catchBody),
      false,
      "catch de main() não pode chamar process.exit() — usar process.exitCode (#4651 Windows crash)",
    );
    assert.match(catchBody, /process\.exitCode/, "catch de main() deve setar process.exitCode");
  });
});
