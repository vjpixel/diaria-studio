/**
 * test/clarice-sync-opens-catchup-4688.test.ts (#4688)
 *
 * REGRESSÃO: abrir um e-mail NÃO toca `modifiedAt` do contato na Brevo — só
 * clique/outras mutações tocam. Isso fazia `clarice-sync-brevo.ts
 * --incremental` (que enumera contatos via `modifiedSince`) nunca revisitar
 * quem só abre sem clicar, e `opens_count` degradava continuamente (medido
 * ao vivo em 260806: ~32% de subcontagem agregada antes de um full resync
 * manual).
 *
 * O fix varre os destinatários das campanhas ENVIADAS numa janela recente
 * via `exportRecipients` (`Total Opens` por destinatário — independe de
 * `modifiedAt` do contato) e re-busca cada opener individualmente. Este
 * arquivo trava:
 *   1. `collectOpenedEmails` — extração pura dos openers de N caches de
 *      campanha (union, sem duplicar).
 *   2. `runOpensCatchup` — orquestração com client/fetchContact/upsert FAKES
 *      (sem rede real): filtra por janela, agrega openers, re-busca e
 *      upserta; fail-soft por campanha e por contato.
 *   3. REGRESSÃO fim-a-fim via `main() --incremental`: um contato com
 *      `brevo_modified_at` ANTIGO (fora da janela de `modifiedSince`, então
 *      INVISÍVEL pro listing padrão) tem `opens_count` atualizado só porque
 *      apareceu como opener no export de uma campanha recente — a prova
 *      direta de que o mecanismo do bug (opens dependendo de `modifiedAt`)
 *      não volta a acontecer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  collectOpenedEmails,
  runOpensCatchup,
  DEFAULT_OPENS_CATCHUP_WINDOW_DAYS,
  main,
  type OpensCatchupDeps,
} from "../scripts/clarice-sync-brevo.ts";
import type { CampaignCache, SentCampaignRef, CampaignExportClient } from "../scripts/clarice-engagement-cohorts-v2.ts";
import { openClariceDb, recomputeDerived } from "../scripts/lib/clarice-db.ts";

// ─── collectOpenedEmails (pura) ──────────────────────────────────────────

test("collectOpenedEmails: extrai só quem tem opened=true; union sem duplicar entre campanhas", () => {
  const caches: CampaignCache[] = [
    {
      campaignId: 1,
      campaignName: "A",
      exportedAt: "2026-08-01T00:00:00.000Z",
      recipients: {
        "a@x.com": { delivered: true, opened: true, bounced: false, unsubscribed: false },
        "b@x.com": { delivered: true, opened: false, bounced: false, unsubscribed: false },
      },
    },
    {
      campaignId: 2,
      campaignName: "B",
      exportedAt: "2026-08-02T00:00:00.000Z",
      recipients: {
        "a@x.com": { delivered: true, opened: true, bounced: false, unsubscribed: false }, // mesmo opener, 2ª campanha
        "c@x.com": { delivered: true, opened: true, bounced: false, unsubscribed: false },
      },
    },
  ];
  const emails = collectOpenedEmails(caches);
  assert.deepEqual([...emails].sort(), ["a@x.com", "c@x.com"]);
});

test("collectOpenedEmails: sem caches ou sem nenhum opened → conjunto vazio", () => {
  assert.equal(collectOpenedEmails([]).size, 0);
  assert.equal(
    collectOpenedEmails([
      {
        campaignId: 1,
        campaignName: "A",
        exportedAt: "2026-08-01T00:00:00.000Z",
        recipients: { "a@x.com": { delivered: true, opened: false, bounced: false, unsubscribed: false } },
      },
    ]).size,
    0,
  );
});

// ─── runOpensCatchup (client/fetchContact/upsert fakes — sem rede) ───────

function fakeCampaign(id: number, ageDays: number): SentCampaignRef {
  return {
    id,
    name: `Campanha ${id}`,
    sentDate: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
  };
}

function makeFakeClient(
  campaigns: SentCampaignRef[],
  recipientsByCampaign: Record<number, Array<{ email: string; opened: boolean }>>,
  opts: { failExportFor?: Set<number> } = {},
): CampaignExportClient {
  // #4722 item 5: era `Pick<CampaignExportClient, "listSentCampaigns" | ...>`
  // com as 4 props que CampaignExportClient JÁ TEM inteiro — o Pick não
  // restringia nada, cleanup cosmético sem mudança de comportamento.
  return {
    async listSentCampaigns() {
      return campaigns;
    },
    async exportRecipients(campaignId) {
      if (opts.failExportFor?.has(campaignId)) throw new Error(`export falhou pra campanha ${campaignId}`);
      return { processId: `p-${campaignId}` };
    },
    async pollProcess(processId) {
      const id = Number(String(processId).replace("p-", ""));
      return { status: "completed", exportUrl: `fake://export/${id}` };
    },
    async downloadCsv(url) {
      const id = Number(url.replace("fake://export/", ""));
      const rows = recipientsByCampaign[id] ?? [];
      const header = "Email_ID,Delivered_Date,Total Opens";
      const lines = rows.map(
        (r) => `${r.email},2026-08-01 10:00:00,${r.opened ? 1 : 0}`,
      );
      return [header, ...lines].join("\n");
    },
  };
}

test("runOpensCatchup: só considera campanhas DENTRO da janela; agrega openers; re-busca e upserta cada um", async () => {
  const recent = fakeCampaign(1, 2); // 2 dias atrás — dentro da janela default (30d)
  const old = fakeCampaign(2, 400); // muito antiga — fora da janela
  const campaigns = [recent, old];
  const client = makeFakeClient(campaigns, {
    1: [
      { email: "a@x.com", opened: true },
      { email: "b@x.com", opened: false },
    ],
    2: [{ email: "z@x.com", opened: true }], // não deveria nem ser exportada (fora da janela)
  });

  const fetched: string[] = [];
  const upserted: string[] = [];
  const deps: OpensCatchupDeps = {
    client,
    fetchContact: async (identifier) => {
      fetched.push(identifier);
      return { email: identifier, statistics: { opened: [{ eventTime: "2026-08-05T00:00:00.000Z" }] } };
    },
    upsert: (cols) => {
      upserted.push(cols.email);
    },
    cacheDir: mkdtempSync(resolve(tmpdir(), "opens-catchup-cache-")),
  };

  const result = await runOpensCatchup(deps);

  assert.equal(result.campaignsConsidered, 2);
  assert.equal(result.campaignsInWindow, 1, "a campanha de 400 dias atrás fica fora da janela default");
  assert.equal(result.campaignsFailed, 0);
  assert.equal(result.openersFound, 1, "só a@x.com abriu na campanha dentro da janela");
  assert.deepEqual(fetched, ["a@x.com"]);
  assert.deepEqual(upserted, ["a@x.com"]);
  assert.equal(result.contactsUpdated, 1);
  assert.equal(result.contactsFailed, 0);
});

test("runOpensCatchup: falha no export de UMA campanha não aborta as demais (fail-soft)", async (t) => {
  const c1 = fakeCampaign(1, 1);
  const c2 = fakeCampaign(2, 1);
  const client = makeFakeClient(
    [c1, c2],
    { 1: [], 2: [{ email: "ok@x.com", opened: true }] },
    { failExportFor: new Set([1]) },
  );
  const deps: OpensCatchupDeps = {
    client,
    fetchContact: async (identifier) => ({ email: identifier, statistics: {} }),
    upsert: () => {},
    cacheDir: mkdtempSync(resolve(tmpdir(), "opens-catchup-cache-")),
  };
  // #4721 follow-up (achado 2, pr-test-analyzer): trava que a falha REALMENTE
  // é logada (não só contada) — um catch{} silencioso reintroduzido passaria
  // por todos os asserts de contador abaixo sem ser detectado.
  const errorMock = t.mock.method(console, "error");
  const result = await runOpensCatchup(deps);
  assert.equal(result.campaignsFailed, 1);
  assert.equal(result.campaignsInWindow, 2);
  assert.equal(result.openersFound, 1, "campanha 2 processada normalmente apesar da falha na 1");
  const logged = errorMock.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(
    logged.some((msg) => msg.includes("1") && msg.includes("Campanha 1") && msg.includes("export falhou pra campanha 1")),
    `esperava log com id/nome da campanha + mensagem do erro, recebi: ${JSON.stringify(logged)}`,
  );
});

test("runOpensCatchup: contato que some entre o export e a re-busca (404 → body vazio) conta como falha, não trava o resto", async () => {
  const c1 = fakeCampaign(1, 1);
  const client = makeFakeClient([c1], {
    1: [
      { email: "sumiu@x.com", opened: true },
      { email: "existe@x.com", opened: true },
    ],
  });
  const deps: OpensCatchupDeps = {
    client,
    fetchContact: async (identifier) => (identifier === "sumiu@x.com" ? {} : { email: identifier }),
    upsert: () => {},
    cacheDir: mkdtempSync(resolve(tmpdir(), "opens-catchup-cache-")),
  };
  const result = await runOpensCatchup(deps);
  assert.equal(result.openersFound, 2);
  assert.equal(result.contactsUpdated, 1);
  assert.equal(result.contactsFailed, 1);
});

test("DEFAULT_OPENS_CATCHUP_WINDOW_DAYS: valor positivo razoável (não 0, não negativo)", () => {
  assert.ok(DEFAULT_OPENS_CATCHUP_WINDOW_DAYS > 0);
});

// ─── #4722 item 2: --limit também restringe o catch-up ───────────────────

test("runOpensCatchup: deps.limit trunca quantos openers são re-buscados/upsertados, mas openersFound reporta o total REAL", async () => {
  const c1 = fakeCampaign(1, 1);
  const client = makeFakeClient([c1], {
    1: [
      { email: "a@x.com", opened: true },
      { email: "b@x.com", opened: true },
      { email: "c@x.com", opened: true },
    ],
  });
  const fetched: string[] = [];
  const deps: OpensCatchupDeps = {
    client,
    fetchContact: async (identifier) => {
      fetched.push(identifier);
      return { email: identifier };
    },
    upsert: () => {},
    cacheDir: mkdtempSync(resolve(tmpdir(), "opens-catchup-cache-")),
    limit: 2,
  };
  const result = await runOpensCatchup(deps);
  assert.equal(result.openersFound, 3, "openersFound continua contando o total real (pré-limite)");
  assert.equal(fetched.length, 2, "só 2 openers foram de fato re-buscados (limit=2)");
  assert.equal(result.contactsUpdated, 2);
});

test("runOpensCatchup: sem deps.limit (undefined/0) processa TODOS os openers — comportamento anterior preservado", async () => {
  const c1 = fakeCampaign(1, 1);
  const client = makeFakeClient([c1], {
    1: [
      { email: "a@x.com", opened: true },
      { email: "b@x.com", opened: true },
    ],
  });
  const deps: OpensCatchupDeps = {
    client,
    fetchContact: async (identifier) => ({ email: identifier }),
    upsert: () => {},
    cacheDir: mkdtempSync(resolve(tmpdir(), "opens-catchup-cache-")),
    limit: 0,
  };
  const result = await runOpensCatchup(deps);
  assert.equal(result.contactsUpdated, 2, "limit=0 é 'sem limite' (mesma semântica do --limit do loop principal)");
});

// ─── #4722 item 3: batching/transação nas escritas do catch-up ───────────

test("runOpensCatchup: escritas passam por deps.transaction em vez de deps.upsert isolado por contato", async () => {
  const c1 = fakeCampaign(1, 1);
  const client = makeFakeClient([c1], {
    1: [
      { email: "a@x.com", opened: true },
      { email: "b@x.com", opened: true },
      { email: "c@x.com", opened: true },
    ],
  });
  const txCalls: number[] = []; // tamanho do batch em cada chamada de transaction
  const upserted: string[] = [];
  const deps: OpensCatchupDeps = {
    client,
    fetchContact: async (identifier) => ({ email: identifier }),
    upsert: (cols) => {
      upserted.push(cols.email);
    },
    cacheDir: mkdtempSync(resolve(tmpdir(), "opens-catchup-cache-")),
    batchSize: 2, // força >1 flush pra 3 openers (2 + 1)
    transaction: (fn) => {
      const before = upserted.length;
      fn();
      txCalls.push(upserted.length - before);
    },
  };
  const result = await runOpensCatchup(deps);
  assert.equal(result.contactsUpdated, 3);
  assert.equal(upserted.length, 3, "todos os 3 contatos foram upsertados (via transaction, batelado)");
  assert.deepEqual([...upserted].sort(), ["a@x.com", "b@x.com", "c@x.com"]);
  assert.ok(txCalls.length >= 2, "batchSize=2 força pelo menos 2 chamadas de transaction pra 3 openers");
  assert.equal(
    txCalls.reduce((a, b) => a + b, 0),
    3,
    "a soma dos batches passados por transaction cobre todos os contatos",
  );
});

test("runOpensCatchup: sem deps.transaction, upsert ainda roda (fallback chama fn() direto, sem BEGIN/COMMIT real)", async () => {
  const c1 = fakeCampaign(1, 1);
  const client = makeFakeClient([c1], { 1: [{ email: "a@x.com", opened: true }] });
  const upserted: string[] = [];
  const deps: OpensCatchupDeps = {
    client,
    fetchContact: async (identifier) => ({ email: identifier }),
    upsert: (cols) => {
      upserted.push(cols.email);
    },
    cacheDir: mkdtempSync(resolve(tmpdir(), "opens-catchup-cache-")),
  };
  const result = await runOpensCatchup(deps);
  assert.equal(result.contactsUpdated, 1);
  assert.deepEqual(upserted, ["a@x.com"], "fallback sem deps.transaction ainda persiste (compat com testes/fakes antigos)");
});

test("REGRESSÃO (achado de self-review, #4722 item 3): flush() intermediário que falha NÃO é misatribuído ao e-mail que disparou o flush — desfaz contactsUpdated do batch inteiro e soma em contactsFailed, nunca 1", async () => {
  // 5 openers, batchSize=2 → flushes intermediários em 2/4, mais o flush final
  // drenando o resto (1). O 2º flush intermediário (contatos c,d) FALHA na
  // escrita (transaction lança) — antes do fix, isso seria capturado pelo
  // catch por-contato de QUALQUER UM dos 5 e-mails (o que por acaso disparou
  // aquele flush específico), incrementando contactsFailed em só 1 e deixando
  // contactsUpdated com +2 fantasmas (c e d nunca foram persistidos de verdade).
  const c1 = fakeCampaign(1, 1);
  const client = makeFakeClient([c1], {
    1: [
      { email: "a@x.com", opened: true },
      { email: "b@x.com", opened: true },
      { email: "c@x.com", opened: true },
      { email: "d@x.com", opened: true },
      { email: "e@x.com", opened: true },
    ],
  });
  const upserted: string[] = [];
  let txCallCount = 0;
  const deps: OpensCatchupDeps = {
    client,
    fetchContact: async (identifier) => ({ email: identifier }),
    upsert: (cols) => {
      upserted.push(cols.email);
    },
    cacheDir: mkdtempSync(resolve(tmpdir(), "opens-catchup-cache-")),
    batchSize: 2,
    transaction: (fn) => {
      txCallCount += 1;
      if (txCallCount === 2) throw new Error("simulated write failure (batch 2)");
      fn();
    },
  };
  const result = await runOpensCatchup(deps);
  // 5 openers processados; 1 batch de 2 falhou na escrita → 2 nunca persistidos.
  assert.equal(result.contactsUpdated, 3, "só os 3 contatos cujo batch teve sucesso contam como atualizados");
  assert.equal(result.contactsFailed, 2, "o batch inteiro que falhou (2 contatos) conta como falha, não 1");
  assert.equal(upserted.length, 3, "o batch que falhou nunca chegou a chamar upsert de verdade dentro dele (fn() não executa se transaction lança antes)");
});

// ─── REGRESSÃO fim-a-fim (#4688): main() --incremental, fetch mockado ────

test("REGRESSÃO (#4688): opener com brevo_modified_at ANTIGO (fora do modifiedSince) tem opens_count atualizado via catch-up de campanha — não fica invisível pro incremental", async (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), "sync-brevo-4688-"));
  const dbPath = resolve(dir, "store.db");
  // #4717 follow-up (achado 1): cache do catch-up isolado num tmpdir próprio
  // — sem `--cache-dir`, main() cairia no default de PRODUÇÃO
  // (OPENS_CATCHUP_CACHE_DIR, dentro de data/clarice-subscribers/), escrevendo
  // fora do tmpdir isolado em qualquer máquina com o junction `data/` presente.
  const cacheDir = mkdtempSync(resolve(tmpdir(), "sync-brevo-4688-cache-"));

  // Setup: 2 contatos. `a@x.com` foi modificado recentemente (entra no
  // modifiedSince do listing normal). `b@x.com` só abriu uma campanha, sem
  // clicar — brevo_modified_at ANTIGO, fora da janela do listing incremental
  // — é exatamente o contato que o bug #4688 deixava pra trás.
  const setupDb = openClariceDb(dbPath);
  setupDb
    .prepare(
      `INSERT INTO clarice_users (email, tier, sends_count, opens_count, brevo_modified_at)
       VALUES ('a@x.com', 2, 1, 0, '2026-08-06T00:00:00.000Z')`,
    )
    .run();
  setupDb
    .prepare(
      `INSERT INTO clarice_users (email, tier, sends_count, opens_count, brevo_modified_at)
       VALUES ('b@x.com', 2, 1, 0, '2026-01-01T00:00:00.000Z')`,
    )
    .run();
  recomputeDerived(setupDb);
  setupDb.close();

  const recentSentDate = new Date(Date.now() - 2 * 86_400_000).toISOString(); // 2 dias atrás — dentro da janela default

  const origFetch = globalThis.fetch;
  const origApiKey = process.env.BREVO_CLARICE_API_KEY;
  process.env.BREVO_CLARICE_API_KEY = "test-key-4688";

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    // Fase 1 do sync principal — listing por modifiedSince: NINGUÉM foi
    // modificado (simula exatamente o cenário do bug: b@x.com nunca aparece aqui).
    if (u.includes("/contacts?")) {
      return new Response(JSON.stringify({ contacts: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // Catch-up — lista de campanhas enviadas: 1 campanha recente.
    if (u.includes("/emailCampaigns?status=sent")) {
      return new Response(
        JSON.stringify({ campaigns: [{ id: 99, name: "Clarice News", sentDate: recentSentDate }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // Catch-up — dispara o export da campanha 99.
    if (u.includes("/emailCampaigns/99/exportRecipients")) {
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({ processId: 555 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // Catch-up — poll do processo de export: completo já na 1ª chamada.
    if (u.includes("/processes/555")) {
      return new Response(
        JSON.stringify({ status: "completed", export_url: "https://export.example.com/99.csv" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // Catch-up — download do CSV assinado (fetch cru, fora do domínio da Brevo).
    if (u.includes("export.example.com")) {
      return new Response(
        ["Email_ID,Delivered_Date,Total Opens", "b@x.com,2026-08-04 10:00:00,1"].join("\n"),
        { status: 200 },
      );
    }
    // Catch-up — re-busca individual do opener encontrado no export.
    if (u.includes("/contacts/b%40x.com")) {
      return new Response(
        JSON.stringify({
          email: "b@x.com",
          emailBlacklisted: false,
          listIds: [],
          // Propositalmente ANTIGO — a prova de que opens_count não depende
          // de modifiedAt estar fresco pra ser sincronizado via catch-up.
          modifiedAt: "2026-01-01T00:00:00.000Z",
          statistics: {
            opened: [{ eventTime: "2026-08-04T10:00:00.000Z" }],
            clicked: [],
            messagesSent: [{ eventTime: "2026-08-01T09:00:00.000Z" }],
            hardBounces: [],
            softBounces: [],
            complaints: [],
            unsubscriptions: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`fetch inesperado no mock: ${u}`);
  }) as unknown as typeof globalThis.fetch;

  t.after(() => {
    globalThis.fetch = origFetch;
    if (origApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = origApiKey;
  });

  await main(["--db", dbPath, "--incremental", "--cache-dir", cacheDir]);

  const finalDb = openClariceDb(dbPath);
  const a = finalDb
    .prepare("SELECT opens_count FROM clarice_users WHERE email = 'a@x.com'")
    .get() as { opens_count: number };
  const b = finalDb
    .prepare("SELECT opens_count, brevo_modified_at FROM clarice_users WHERE email = 'b@x.com'")
    .get() as { opens_count: number; brevo_modified_at: string };
  finalDb.close();

  assert.equal(a.opens_count, 0, "a@x.com não tinha abertura em nenhuma campanha — inalterado");
  assert.equal(
    b.opens_count,
    1,
    "b@x.com: opens_count sincronizado via catch-up de campanha, apesar de INVISÍVEL pro listing por modifiedSince",
  );
});

test("REGRESSÃO (#4688): --no-catch-opens desliga o catch-up — opener fora do modifiedSince continua com opens_count defasado", async (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), "sync-brevo-4688-off-"));
  const dbPath = resolve(dir, "store.db");
  // #4717 follow-up (achado 1): --cache-dir isolado por defesa em profundidade
  // — este teste roda com --no-catch-opens (nunca alcança runOpensCatchup),
  // mas isolar aqui também evita que uma futura remoção da flag volte a
  // escrever no diretório de produção sem ninguém notar.
  const cacheDir = mkdtempSync(resolve(tmpdir(), "sync-brevo-4688-off-cache-"));

  const setupDb = openClariceDb(dbPath);
  setupDb
    .prepare(
      `INSERT INTO clarice_users (email, tier, sends_count, opens_count, brevo_modified_at)
       VALUES ('b@x.com', 2, 1, 0, '2026-08-06T00:00:00.000Z')`,
    )
    .run();
  recomputeDerived(setupDb);
  setupDb.close();

  const origFetch = globalThis.fetch;
  const origApiKey = process.env.BREVO_CLARICE_API_KEY;
  process.env.BREVO_CLARICE_API_KEY = "test-key-4688-off";

  // Só a listing precisa responder — com --no-catch-opens nenhuma chamada de
  // campanha deveria acontecer; qualquer uma que aconteça derruba o teste
  // (mock lança em URL inesperada).
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/contacts?")) {
      return new Response(JSON.stringify({ contacts: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`fetch inesperado no mock (catch-up deveria estar desligado): ${u}`);
  }) as unknown as typeof globalThis.fetch;

  t.after(() => {
    globalThis.fetch = origFetch;
    if (origApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = origApiKey;
  });

  await main(["--db", dbPath, "--incremental", "--no-catch-opens", "--cache-dir", cacheDir]);

  const finalDb = openClariceDb(dbPath);
  const b = finalDb
    .prepare("SELECT opens_count FROM clarice_users WHERE email = 'b@x.com'")
    .get() as { opens_count: number };
  finalDb.close();
  assert.equal(b.opens_count, 0, "sem catch-up, opens_count não é tocado (só o listing, que não achou ninguém)");
  assert.equal(existsSync(dbPath), true);
});

// ─── #4717 follow-up (achado 3): try/catch MAIS EXTERNO de main() ────────
//
// A garantia fail-soft central que o docstring do #4688 promete ("uma falha
// no catch-up nunca reprova o sync principal já persistido") só era testada
// nos NÍVEIS internos de runOpensCatchup (fail-soft por campanha/por
// contato). O catch de main() que envolve a CHAMADA INTEIRA a runOpensCatchup
// nunca tinha sido exercitado — este teste força listSentCampaigns a lançar
// ANTES de retornar (fora de qualquer try interno de runOpensCatchup), prova
// que main() não propaga, e que `opens_catchup.error` aparece no summary.

test("REGRESSÃO (#4717): falha TOTAL do catch-up (listSentCampaigns rejeita) não derruba main() — sync principal persiste, opens_catchup.error aparece no summary", async (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), "sync-brevo-4717-outer-"));
  const dbPath = resolve(dir, "store.db");
  const cacheDir = mkdtempSync(resolve(tmpdir(), "sync-brevo-4717-outer-cache-"));

  const setupDb = openClariceDb(dbPath);
  setupDb
    .prepare(
      `INSERT INTO clarice_users (email, tier, sends_count, opens_count, brevo_modified_at)
       VALUES ('a@x.com', 2, 1, 0, '2026-08-06T00:00:00.000Z')`,
    )
    .run();
  recomputeDerived(setupDb);
  setupDb.close();

  const origFetch = globalThis.fetch;
  const origApiKey = process.env.BREVO_CLARICE_API_KEY;
  const origLog = console.log;
  process.env.BREVO_CLARICE_API_KEY = "test-key-4717-outer";
  const logged: string[] = [];
  console.log = (msg: unknown) => {
    logged.push(String(msg));
  };

  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    // Sync principal — listing por modifiedSince: responde normalmente,
    // ninguém modificado (o ponto do teste é isolar a falha no catch-up).
    if (u.includes("/contacts?")) {
      return new Response(JSON.stringify({ contacts: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // Catch-up — listSentCampaigns: 403 → brevoGet lança IMEDIATAMENTE (sem
    // retry, ver lib/brevo-client.ts "outro 4xx → throw"), ANTES de
    // runOpensCatchup sequer entrar no loop de campanhas — logo fora de
    // qualquer try/catch INTERNO de runOpensCatchup. Só o catch mais externo
    // de main() pode capturar isto.
    if (u.includes("/emailCampaigns?status=sent")) {
      return new Response("forbidden", { status: 403 });
    }
    throw new Error(`fetch inesperado no mock: ${u}`);
  }) as unknown as typeof globalThis.fetch;

  t.after(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    if (origApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = origApiKey;
  });

  // A garantia central: main() não rejeita/lança mesmo com falha TOTAL do
  // catch-up — se propagasse, este await lançaria e o teste falharia aqui.
  await main(["--db", dbPath, "--incremental", "--cache-dir", cacheDir]);

  const finalDb = openClariceDb(dbPath);
  const a = finalDb
    .prepare("SELECT opens_count FROM clarice_users WHERE email = 'a@x.com'")
    .get() as { opens_count: number };
  const total = finalDb.prepare("SELECT COUNT(*) AS n FROM clarice_users").get() as { n: number };
  finalDb.close();

  assert.equal(total.n, 1, "sync principal já persistido continua íntegro — falha do catch-up não corrompeu o store");
  assert.equal(a.opens_count, 0, "contato pré-existente inalterado (nem regrediu, nem foi tocado por engano)");

  const summaryLine = logged.find((l) => l.includes("opens_catchup"));
  assert.ok(summaryLine, "summary JSON (stdout) deve conter a chave opens_catchup");
  const summary = JSON.parse(summaryLine!);
  assert.equal(summary.brevo_synced, true, "sync principal reporta sucesso mesmo com catch-up falho");
  assert.ok(summary.opens_catchup, "opens_catchup não deve ser null quando o catch-up rodou (mesmo falhando)");
  // #4722 item 1: união discriminada — falha total é { ok: false, error },
  // sem contadores fingidos (antes era OpensCatchupResult & { error? } com
  // campaignsConsidered/contactsUpdated zerados junto do error).
  assert.equal(summary.opens_catchup.ok, false, "falha total → ok:false (#4722)");
  assert.ok(
    typeof summary.opens_catchup.error === "string" && summary.opens_catchup.error.length > 0,
    "opens_catchup.error deve carregar a mensagem da falha total — não pode ficar mudo",
  );
  assert.equal(summary.opens_catchup.result, undefined, "ok:false não carrega result (#4722)");
});

// ─── #4722 item 1: união discriminada no summary JSON (caminho de sucesso) ─

test("REGRESSÃO (#4722 item 1): catch-up bem-sucedido reporta opens_catchup: { ok: true, result } no summary", async (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), "sync-brevo-4722-ok-"));
  const dbPath = resolve(dir, "store.db");
  const cacheDir = mkdtempSync(resolve(tmpdir(), "sync-brevo-4722-ok-cache-"));

  const setupDb = openClariceDb(dbPath);
  setupDb
    .prepare(
      `INSERT INTO clarice_users (email, tier, sends_count, opens_count, brevo_modified_at)
       VALUES ('b@x.com', 2, 1, 0, '2026-01-01T00:00:00.000Z')`,
    )
    .run();
  recomputeDerived(setupDb);
  setupDb.close();

  const recentSentDate = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const origFetch = globalThis.fetch;
  const origApiKey = process.env.BREVO_CLARICE_API_KEY;
  const origLog = console.log;
  process.env.BREVO_CLARICE_API_KEY = "test-key-4722-ok";
  const logged: string[] = [];
  console.log = (msg: unknown) => {
    logged.push(String(msg));
  };

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/contacts?")) {
      return new Response(JSON.stringify({ contacts: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/emailCampaigns?status=sent")) {
      return new Response(
        JSON.stringify({ campaigns: [{ id: 99, name: "Clarice News", sentDate: recentSentDate }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("/emailCampaigns/99/exportRecipients")) {
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({ processId: 555 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/processes/555")) {
      return new Response(
        JSON.stringify({ status: "completed", export_url: "https://export.example.com/99.csv" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("export.example.com")) {
      return new Response(
        ["Email_ID,Delivered_Date,Total Opens", "b@x.com,2026-08-04 10:00:00,1"].join("\n"),
        { status: 200 },
      );
    }
    if (u.includes("/contacts/b%40x.com")) {
      return new Response(
        JSON.stringify({
          email: "b@x.com",
          emailBlacklisted: false,
          listIds: [],
          modifiedAt: "2026-01-01T00:00:00.000Z",
          statistics: {
            opened: [{ eventTime: "2026-08-04T10:00:00.000Z" }],
            clicked: [],
            messagesSent: [{ eventTime: "2026-08-01T09:00:00.000Z" }],
            hardBounces: [],
            softBounces: [],
            complaints: [],
            unsubscriptions: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`fetch inesperado no mock: ${u}`);
  }) as unknown as typeof globalThis.fetch;

  t.after(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    if (origApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = origApiKey;
  });

  await main(["--db", dbPath, "--incremental", "--cache-dir", cacheDir]);

  const summaryLine = logged.find((l) => l.includes("opens_catchup"));
  assert.ok(summaryLine, "summary JSON deve conter a chave opens_catchup");
  const summary = JSON.parse(summaryLine!);
  assert.equal(summary.opens_catchup.ok, true, "catch-up bem-sucedido → ok:true (#4722)");
  assert.equal(summary.opens_catchup.error, undefined, "ok:true não carrega error (#4722)");
  assert.ok(summary.opens_catchup.result, "ok:true carrega result completo (#4722)");
  assert.equal(summary.opens_catchup.result.contactsUpdated, 1);
  assert.equal(summary.opens_catchup.result.openersFound, 1);
});
