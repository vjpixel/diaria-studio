/**
 * test/sync-pending-to-brevo-4266.test.ts (#4266, fila de tamanho fixo +
 * backfill adicionados no #4476 item 5)
 *
 * Triagem Pending(Beehiiv)→Brevo. Cobre: paginação/reconciliação da leitura
 * Beehiiv, diff puro (dedup pelo store, nunca pela Beehiiv), a ingestão real
 * (mock de fetch — nunca rede real), e a seleção da fila de tamanho fixo com
 * backfill priorizado por score de origem (#4476 item 5).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchPendingBeehiivSubscriptions,
  computeContactsToIngest,
  ingestContactToBrevo,
  computeAvailableSlots,
  computeCurrentActiveCount,
  selectContactsForBackfill,
  loadOriginScores,
  loadMvVerifiedEmails,
  assertMvGuardAcknowledged,
  type BeehiivPendingSubscription,
  type PendingToIngestEntry,
} from "../scripts/sync-pending-to-brevo.ts";
import type { BrevoDiariaStore, BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchPendingBeehiivSubscriptions — paginação (#4266)", () => {
  it("agrega várias páginas até total_results", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string | URL) => {
      calls++;
      // #4266 review: "per_page=100" contém "page=1" como substring — usar o
      // query param real (não string.includes ingênuo) pra não confundir
      // page=1 com per_page=100&page=2 etc.
      const pageParam = new URL(String(url)).searchParams.get("page");
      if (pageParam === "1") {
        return jsonRes(200, {
          data: [
            { id: "sub_1", email: "a@b.com" },
            { id: "sub_2", email: "b@b.com" },
          ],
          total_results: 3,
          limit: 2,
        });
      }
      return jsonRes(200, { data: [{ id: "sub_3", email: "C@B.com" }], total_results: 3, limit: 2 });
    }) as typeof fetch;

    const out = await fetchPendingBeehiivSubscriptions("pub_1", "key", fetchImpl);
    assert.equal(out.length, 3);
    assert.equal(out[2].email, "c@b.com", "email normalizado (lowercase)");
    assert.equal(calls, 2);
  });

  it("página truncada (total_results maior que o coletado) → lança (nunca ingestão incompleta silenciosa)", async () => {
    const fetchImpl = (async () => jsonRes(200, { data: [{ id: "sub_1", email: "a@b.com" }], total_results: 5, limit: 1 })) as typeof fetch;
    // hasMorePages vai continuar pedindo (gotLength >= limit), mas simulando
    // uma resposta vazia na 2ª página sem bater o total:
    let page = 0;
    const truncating = (async () => {
      page++;
      if (page === 1) return jsonRes(200, { data: [{ id: "sub_1", email: "a@b.com" }], total_results: 5, limit: 1 });
      return jsonRes(200, { data: [], total_results: 5, limit: 1 });
    }) as typeof fetch;
    await assert.rejects(() => fetchPendingBeehiivSubscriptions("pub_1", "key", truncating), /terminou cedo/);
    void fetchImpl;
  });

  it("!ok em qualquer página → lança (fail loud)", async () => {
    const fetchImpl = (async () => jsonRes(500, { message: "boom" })) as typeof fetch;
    await assert.rejects(() => fetchPendingBeehiivSubscriptions("pub_1", "key", fetchImpl), /Beehiiv API 500/);
  });
});

describe("computeContactsToIngest — dedup pelo store, nunca pela Beehiiv (#4266)", () => {
  it("contato Pending ausente do store → entra na lista de ingestão", () => {
    const pending: BeehiivPendingSubscription[] = [{ id: "sub_1", email: "a@b.com" }];
    const store: BrevoDiariaStore = { contacts: [] };
    const out = computeContactsToIngest(pending, store);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { email: "a@b.com", beehiiv_subscription_id: "sub_1" });
  });

  it("contato já no store (qualquer status) → NUNCA re-ingerido", () => {
    const pending: BeehiivPendingSubscription[] = [
      { id: "sub_1", email: "a@b.com" },
      { id: "sub_2", email: "b@b.com" },
      { id: "sub_3", email: "c@b.com" },
    ];
    const store: BrevoDiariaStore = {
      contacts: [
        { email: "a@b.com", beehiiv_subscription_id: "sub_1", status: "in_brevo", opens_count: 0, sends_count: 0, last_open_rate: null, added_at: "x", last_evaluated_at: null },
        { email: "b@b.com", beehiiv_subscription_id: "sub_2", status: "promoted_beehiiv", opens_count: 3, sends_count: 3, last_open_rate: 1, added_at: "x", last_evaluated_at: "y", promoted_at: "z" },
      ],
    };
    const out = computeContactsToIngest(pending, store);
    assert.equal(out.length, 1);
    assert.equal(out[0].email, "c@b.com");
  });

  it("dedup interno da própria página Pending (mesmo email 2x na resposta)", () => {
    const pending: BeehiivPendingSubscription[] = [
      { id: "sub_1", email: "a@b.com" },
      { id: "sub_1b", email: "a@b.com" },
    ];
    const out = computeContactsToIngest(pending, { contacts: [] });
    assert.equal(out.length, 1);
  });

  it("com verifiedEmails: filtra pra só quem passou no MillionVerifier (#4476 item 8)", () => {
    const pending: BeehiivPendingSubscription[] = [
      { id: "sub_1", email: "verificado@b.com" },
      { id: "sub_2", email: "rejeitado@b.com" },
      { id: "sub_3", email: "nunca-verificado@b.com" },
    ];
    const verified = new Set(["verificado@b.com"]);
    const out = computeContactsToIngest(pending, { contacts: [] }, verified);
    assert.equal(out.length, 1);
    assert.equal(out[0].email, "verificado@b.com");
  });

  it("verifiedEmails null (default) → sem filtro de MV, comportamento antigo preservado", () => {
    const pending: BeehiivPendingSubscription[] = [{ id: "sub_1", email: "a@b.com" }];
    const out = computeContactsToIngest(pending, { contacts: [] }, null);
    assert.equal(out.length, 1);
  });
});

describe("loadMvVerifiedEmails — leitura fail-soft do CSV de verify-pending-emails-mv.ts (#4476 item 8)", () => {
  it("arquivo ausente → null (nunca lança), loga aviso", () => {
    const logs: string[] = [];
    const result = loadMvVerifiedEmails(resolve(process.cwd(), "data/pending-reativacao/__nao-existe__.csv"), (m) => logs.push(m));
    assert.equal(result, null);
    assert.ok(logs.some((l) => l.includes("não encontrado")));
  });

  it("CSV real de 1 coluna só (formato de mv-verified.csv) → parseia certo, não cai no fallback (achado ao vivo 260802: auto-detect de delimitador falha sem vírgula nenhuma no arquivo)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "mv-verified-test-"));
    try {
      const path = resolve(dir, "mv-verified.csv");
      // Mesmo formato exato que Papa.unparse produz pra 1 coluna (CRLF nas
      // primeiras linhas, LF na última — reproduz o arquivo real que causou
      // "Unable to auto-detect delimiting character" sem delimiter:"," explícito).
      writeFileSync(path, "email\r\nfoo@bar.com\r\nbaz@qux.com\n");
      const logs: string[] = [];
      const result = loadMvVerifiedEmails(path, (m) => logs.push(m));
      assert.deepEqual(result, new Set(["foo@bar.com", "baz@qux.com"]));
      assert.equal(logs.length, 0, "não deve logar aviso de falha de parse");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CSV EXISTE mas está malformado (aspas não fechadas) → null igual 'arquivo ausente' (achado #4494: guard e filtro precisam concordar nesse caso)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "mv-verified-test-"));
    try {
      const path = resolve(dir, "mv-verified.csv");
      writeFileSync(path, 'email\nfoo@bar.com\n"unterminated');
      const logs: string[] = [];
      const result = loadMvVerifiedEmails(path, (m) => logs.push(m));
      assert.equal(result, null, "corpo malformado nunca vira 'sem filtro silencioso' sem log");
      assert.ok(logs.some((l) => l.includes("falha ao parsear")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ingestContactToBrevo — cria + verifica por releitura (#4266)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("sucesso: POST cria, GET confirma listIds inclui o list_id", async () => {
    let posted: unknown;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") {
        posted = JSON.parse(init.body as string);
        return jsonRes(201, {});
      }
      return jsonRes(200, { email: "a@b.com", listIds: [7] });
    }) as typeof fetch;
    try {
      await ingestContactToBrevo("key", 7, "a@b.com");
      assert.deepEqual(posted, { email: "a@b.com", listIds: [7], updateEnabled: true });
    } finally {
      restore();
    }
  });

  it("releitura sem o list_id esperado → lança (mutação não confirmada)", async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonRes(201, {});
      return jsonRes(200, { email: "a@b.com", listIds: [999] });
    }) as typeof fetch;
    try {
      await assert.rejects(() => ingestContactToBrevo("key", 7, "a@b.com"), /NÃO confere/);
    } finally {
      restore();
    }
  });

  it("releitura com status != 200 → lança", async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonRes(201, {});
      return jsonRes(404, {});
    }) as typeof fetch;
    try {
      await assert.rejects(() => ingestContactToBrevo("key", 7, "a@b.com"), /releitura pós-criação falhou/);
    } finally {
      restore();
    }
  });
});

describe("assertMvGuardAcknowledged — guard por COBERTURA, não por 'arquivo existe' (#4494 review: achado convergente de 4 agentes, provado ao vivo contra o repo real)", () => {
  it("sem --i-know-this-skips-mv e coverage null (nenhuma verificação disponível) → lança erro explícito nomeando a issue e a flag", () => {
    assert.throws(() => assertMvGuardAcknowledged([], null), /verify-pending-emails-mv\.ts.*--i-know-this-skips-mv/s);
  });

  it("sem a flag mesmo com --push presente → ainda lança (a flag exata é o que importa, não --push)", () => {
    assert.throws(() => assertMvGuardAcknowledged(["--push"], null), /--i-know-this-skips-mv/);
  });

  it("com --i-know-this-skips-mv → não lança, mesmo com coverage null", () => {
    assert.doesNotThrow(() => assertMvGuardAcknowledged(["--push", "--i-know-this-skips-mv"], null));
  });

  it("cobertura COMPLETA (processedCount >= poolSize > 0) → não lança, MESMO sem a flag", () => {
    assert.doesNotThrow(() => assertMvGuardAcknowledged(["--push"], { processedCount: 626, poolSize: 626 }));
  });

  it("cobertura PARCIAL (ex: 2 de 626 — achado ao vivo #4494) → ainda lança, mesmo com o arquivo existindo/parseando bem", () => {
    assert.throws(
      () => assertMvGuardAcknowledged(["--push"], { processedCount: 2, poolSize: 626 }),
      /incompleta.*2 de 626/,
    );
  });

  it("processedCount > poolSize (não deveria acontecer, mas não quebra) → passa (>= é inclusivo)", () => {
    assert.doesNotThrow(() => assertMvGuardAcknowledged(["--push"], { processedCount: 627, poolSize: 626 }));
  });

  it("poolSize 0 (pool vazio/ilegível) → NUNCA passa sozinho, mesmo com processedCount 0 (evita '0 >= 0' degenerado)", () => {
    assert.throws(() => assertMvGuardAcknowledged(["--push"], { processedCount: 0, poolSize: 0 }));
  });
});

describe("computeAvailableSlots — fila de tamanho fixo (#4476 item 5)", () => {
  it("fila vazia, cap 300 → 300 slots livres", () => {
    assert.equal(computeAvailableSlots(0, 300), 300);
  });

  it("fila cheia (300/300) → 0 slots livres", () => {
    assert.equal(computeAvailableSlots(300, 300), 0);
  });

  it("fila parcialmente ocupada → cap - ocupados", () => {
    assert.equal(computeAvailableSlots(280, 300), 20);
  });

  it("população acima do cap (ex: cap reduzido depois do fato) → 0, nunca negativo", () => {
    assert.equal(computeAvailableSlots(310, 300), 0);
  });
});

describe("computeCurrentActiveCount — exclui EDITOR_SEED_EMAILS do numerador (#4631)", () => {
  function contact(email: string, status: BrevoDiariaContact["status"]): BrevoDiariaContact {
    return {
      email,
      beehiiv_subscription_id: "sub-" + email,
      status,
      opens_count: 0,
      sends_count: 0,
      last_open_rate: null,
      added_at: "2026-08-01T00:00:00.000Z",
      last_evaluated_at: null,
    };
  }

  it("store real (seeds nunca ingeridos, achado de findOrphanContacts/#4579) → conta só os in_brevo reais", () => {
    const contacts = [
      contact("a@x.com", "in_brevo"),
      contact("b@x.com", "in_brevo"),
      contact("c@x.com", "promoted_beehiiv"),
    ];
    assert.equal(computeCurrentActiveCount(contacts), 2);
  });

  it("defesa em profundidade: se um EDITOR_SEED_EMAILS acabar in_brevo no store (não deveria, mas não deve contar 2x contra o cap)", () => {
    const contacts = [
      contact("a@x.com", "in_brevo"),
      contact("vjpixel@gmail.com", "in_brevo"), // EDITOR_COPY_EMAIL, 1º da lista EDITOR_SEED_EMAILS
      contact("pixel@memelab.com.br", "in_brevo"), // outro seed
    ];
    assert.equal(computeCurrentActiveCount(contacts), 1);
  });

  it("dedup case-insensitive contra a lista de seeds (normaliza email)", () => {
    const contacts = [contact("VJPixel@Gmail.com", "in_brevo")];
    assert.equal(computeCurrentActiveCount(contacts), 0);
  });

  it("seedEmails explícito (compat/teste sem depender de EDITOR_SEED_EMAILS) → só exclui os passados", () => {
    const contacts = [contact("custom-seed@x.com", "in_brevo"), contact("a@x.com", "in_brevo")];
    assert.equal(computeCurrentActiveCount(contacts, ["custom-seed@x.com"]), 1);
  });
});

describe("selectContactsForBackfill — priorização por score de origem (#4476 item 5)", () => {
  const candidates: PendingToIngestEntry[] = [
    { email: "low@b.com", beehiiv_subscription_id: "s1" },
    { email: "high@b.com", beehiiv_subscription_id: "s2" },
    { email: "mid@b.com", beehiiv_subscription_id: "s3" },
  ];

  it("0 slots livres → seleção vazia (fila cheia, sem backfill)", () => {
    const scores = new Map([["low@b.com", 10], ["high@b.com", 90], ["mid@b.com", 50]]);
    assert.deepEqual(selectContactsForBackfill(candidates, 0, scores), []);
  });

  it("com scoreByEmail → ordena DESCENDENTE e corta em availableSlots", () => {
    const scores = new Map([["low@b.com", 10], ["high@b.com", 90], ["mid@b.com", 50]]);
    const out = selectContactsForBackfill(candidates, 2, scores);
    assert.deepEqual(out.map((c) => c.email), ["high@b.com", "mid@b.com"], "os 2 melhores scores, na ordem certa");
  });

  it("availableSlots >= candidatos → devolve todos, ordenados", () => {
    const scores = new Map([["low@b.com", 10], ["high@b.com", 90], ["mid@b.com", 50]]);
    const out = selectContactsForBackfill(candidates, 100, scores);
    assert.deepEqual(out.map((c) => c.email), ["high@b.com", "mid@b.com", "low@b.com"]);
  });

  it("scoreByEmail null (arquivo ainda não gerado) → fallback FIFO (ordem original), só corta em availableSlots", () => {
    const out = selectContactsForBackfill(candidates, 2, null);
    assert.deepEqual(out.map((c) => c.email), ["low@b.com", "high@b.com"], "ordem original preservada, sem priorização");
  });

  it("candidato sem score individual (ausente do CSV) ordena por ÚLTIMO, nunca à frente de quem tem score", () => {
    const scores = new Map([["high@b.com", 90]]); // low@b.com e mid@b.com sem score
    const out = selectContactsForBackfill(candidates, 3, scores);
    assert.equal(out[0].email, "high@b.com", "único com score vai primeiro");
    // os 2 sem score entram depois, em qualquer ordem relativa entre si — o
    // que importa é nenhum deles vir ANTES do candidato pontuado.
    assert.deepEqual(new Set(out.slice(1).map((c) => c.email)), new Set(["low@b.com", "mid@b.com"]));
  });
});

describe("loadOriginScores — leitura fail-soft do CSV de score-pending-origin.ts (#4476 item 5)", () => {
  it("arquivo ausente → null (nunca lança), loga aviso", () => {
    const logs: string[] = [];
    const result = loadOriginScores(resolve(tmpdir(), "nao-existe-4476-" + Date.now() + ".csv"), (m) => logs.push(m));
    assert.equal(result, null);
    assert.ok(logs.some((l) => l.includes("não encontrado")));
  });

  it("CSV bem-formado → Map email→score", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "origin-scores-"));
    try {
      const path = resolve(dir, "scores.csv");
      writeFileSync(path, "email,origin,score\na@b.com,x,87\nb@b.com,y,17.5\n", "utf8");
      const result = loadOriginScores(path);
      assert.ok(result);
      assert.equal(result!.get("a@b.com"), 87);
      assert.equal(result!.get("b@b.com"), 17.5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("email normalizado (lowercase/trim) na leitura", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "origin-scores-"));
    try {
      const path = resolve(dir, "scores.csv");
      writeFileSync(path, "email,origin,score\n  Foo@Bar.COM  ,x,50\n", "utf8");
      const result = loadOriginScores(path);
      assert.equal(result!.get("foo@bar.com"), 50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("linha com score não-numérico → ignorada (não quebra as demais)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "origin-scores-"));
    try {
      const path = resolve(dir, "scores.csv");
      writeFileSync(path, "email,origin,score\na@b.com,x,abc\nb@b.com,y,10\n", "utf8");
      const result = loadOriginScores(path);
      assert.equal(result!.has("a@b.com"), false);
      assert.equal(result!.get("b@b.com"), 10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sync-pending-to-brevo.ts exit semantics (#4651, mesma classe do #4638/#1401)", () => {
  // Regressão: process.exit(1) chamado DEPOIS de um await fetch
  // (fetchPendingBeehiivSubscriptions + ingestContactToBrevo no loop de
  // --push) derruba o processo no Windows com UV_HANDLE_CLOSING enquanto o
  // fetch agent ainda tem sockets keep-alive abertos. Fix: process.exitCode
  // (sem `return` adicional — já era a última instrução de main()) e o mesmo
  // no catch handler do isMainModule(). Os guards pré-await (--push sem MV,
  // config ausente, list_id ausente, API key ausente pro --push) ficam como
  // process.exit(2) de propósito — nenhum fetch rodou ainda nesses pontos.
  const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "sync-pending-to-brevo.ts");

  function readMainAndCatchBodies(): { mainBody: string; catchBody: string } {
    const source = readFileSync(SCRIPT, "utf8");
    const sourceNoComments = source.replace(/\/\/.*$/gm, "");
    const mainMatch = sourceNoComments.match(/async function main\([^)]*\)[^{]*\{[\s\S]*?\n\}\n\nif \(isMainModule/);
    assert.ok(mainMatch, "main() não encontrada em sync-pending-to-brevo.ts");
    const catchMatch = sourceNoComments.match(/if \(isMainModule\(import\.meta\.url\)\) \{[\s\S]*?\n\}\n?$/);
    assert.ok(catchMatch, "bloco isMainModule() não encontrado em sync-pending-to-brevo.ts");
    return { mainBody: mainMatch[0], catchBody: catchMatch[0] };
  }

  it("branch pós-await (exit 1, resumo do --push) usa process.exitCode, não process.exit (#4651)", () => {
    const { mainBody } = readMainAndCatchBodies();
    assert.equal(
      /process\.exit\(1\)/.test(mainBody),
      false,
      "process.exit(1) não deveria mais existir em main() — usar process.exitCode (#4651 Windows crash)",
    );
    assert.match(mainBody, /process\.exitCode = 1/, "process.exitCode = 1 deveria existir no branch pós-await");
  });

  it("guards pré-await (exit 2 — MV, config, list_id, API key) continuam com process.exit — sem risco libuv (#4651)", () => {
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
