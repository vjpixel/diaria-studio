/**
 * test/studio-apoios-page.test.ts (#3602) — contrato HTTP do CRM de apoios:
 * `GET /apoios` faz rewrite pro shell estático (`public/apoios.html`),
 * `GET /api/apoios` serve o snapshot fail-soft de `studio-apoios.ts`, e
 * `PUT /api/apoios/contacts/:id` (editar contato) faz CRUD real sobre um
 * `contacts.jsonl` de teste — nunca sobre `data/` real, sempre um tmpdir
 * isolado.
 *
 * As 3 env vars da apoia.se são deliberadamente limpas em `before`/restauradas
 * em `after` — garante que `GET /api/apoios` cai no caminho fail-soft
 * "credenciais ausentes" (sem nenhuma tentativa de rede real), mesmo que a
 * máquina rodando o teste tenha `.env.local` com credenciais válidas
 * carregado em outro ponto do processo de teste.
 *
 * A página em si (fetch + forms + `<dialog>`) roda no browser sem harness de
 * DOM neste projeto — mesmo precedente de `studio-edicao-page.test.ts` /
 * `studio-triagem-page.test.ts`.
 *
 * #3844 (decisão do editor 260721): a rota `POST /api/apoios/contacts/:id/outreach`
 * e o dialog de outreach na página foram removidos — os testes
 * correspondentes saíram junto.
 *
 * #3862 (decisão do editor 260722): a rota `POST /api/apoios/contacts`
 * (cadastro manual) foi removida junto com o form — contato passa a existir
 * só via `createContact` (Gmail/apoia.se, in-process) ou, nos testes deste
 * arquivo, seed direto via `createContact`+`saveContacts` (sem HTTP).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";
import { openRateCachePath, createContact, saveContacts } from "../scripts/studio-ui/studio-apoios.ts";

const ENV_KEYS = ["APOIA_SE_API_KEY", "APOIA_SE_API_SECRET", "APOIA_SE_CAMPAIGN"] as const;

describe("GET /apoios + /api/apoios + CRUD (#3602)", () => {
  let root: string;
  let server: StudioServer;
  const savedEnv: Record<string, string | undefined> = {};

  before(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    root = mkdtempSync(join(tmpdir(), "studio-apoios-page-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({
      port: 0,
      rootDir: root,
      pollIntervalMs: 30,
      // #3859: sem isto, POST /api/apoios/refresh cai no drain real de Gmail
      // (google-auth.ts lê data/.credentials.json por path fixo, não por
      // `rootDir`) — bateria na conta real da máquina rodando o teste.
      apoiosGmailDrain: async () => ({ notifications: [], most_recent_iso: null, skipped: true, reason: "mock de teste" }),
    });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    }
  });

  it("serve o shell apoios.html", async () => {
    const res = await fetch(new URL("/apoios", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.ok(body.includes("apoios.js"));
    assert.ok(body.includes("contacts-list"));
  });

  it("regressão (#3844): a página não expõe mais nenhum recurso de outreach/follow-up", async () => {
    const res = await fetch(new URL("/apoios", server.url));
    const body = await res.text();
    assert.ok(!body.includes("outreach"), "nenhuma referência a outreach deve sobrar no HTML");
    assert.ok(!body.includes("follow-up"), "nenhuma referência a follow-up deve sobrar no HTML");
  });

  it("regressão (#3862): o form manual 'Adicionar contato' foi removido do shell", async () => {
    const res = await fetch(new URL("/apoios", server.url));
    const body = await res.text();
    // Cadastro manual saiu — contatos passam a vir do e-mail/apoia.se (#3859).
    assert.ok(!body.includes("add-contact-form"), "o form de adicionar contato não deve existir");
    assert.ok(!body.includes('id="new-name"'), "campo new-name não deve existir");
    assert.ok(!body.includes('id="new-emails"'), "campo new-emails não deve existir");
    assert.ok(!body.includes("Adicionar contato"), "o texto 'Adicionar contato' não deve sobrar");
    // O form de EDIÇÃO permanece (mutação diferente do cadastro manual).
    assert.ok(body.includes("edit-contact-form"), "o form de editar contato deve permanecer");
  });

  it("aceita /apoios/ com trailing slash", async () => {
    const res = await fetch(new URL("/apoios/", server.url));
    assert.equal(res.status, 200);
  });

  it("(#3874) banners de erro têm role=alert; lista de contatos tem contêiner de estado vazio", async () => {
    const res = await fetch(new URL("/apoios", server.url));
    const body = await res.text();
    assert.ok(body.includes('id="apoios-error" class="panel alert-banner" role="alert"'));
    assert.ok(body.includes('id="edit-contact-error" class="alert-banner" role="alert"'));
    assert.ok(body.includes('id="contacts-empty"'));
  });

  it("GET /apoios.js e /apoios.css são servidos normalmente (static-serve)", async () => {
    const js = await fetch(new URL("/apoios.js", server.url));
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    const css = await fetch(new URL("/apoios.css", server.url));
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /css/);
  });

  it("GET /api/apoios sem contatos nem credenciais — 200 fail-soft com error preenchido", async () => {
    const res = await fetch(new URL("/api/apoios", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.contacts, []);
    assert.equal(body.campaign.totalContacts, 0);
    assert.equal("pendingFollowups" in body, false); // #3844: removido
    assert.match(body.error ?? "", /APOIA_SE_API_KEY/);
  });

  it("GET /api/apoios traz 'rewardGroups' com as 4 chaves de nível, vazias sem contatos (#3844 parte 2)", async () => {
    const res = await fetch(new URL("/api/apoios", server.url));
    const body = await res.json();
    assert.deepEqual(body.rewardGroups, { amigo: [], apoiador: [], mantenedor: [], patrono: [] });
  });

  it("serve a página apoios.html com a seção de visão por grupo (#3844 parte 2)", async () => {
    const res = await fetch(new URL("/apoios", server.url));
    const body = await res.text();
    assert.ok(body.includes('id="reward-groups"'), "a seção reward-groups deve existir no shell");
  });

  it("regressão (botões unificados 260723): um só 'Atualizar', que dispara o fluxo completo com estado de carregando", async () => {
    const html = await (await fetch(new URL("/apoios", server.url))).text();
    // O botão antigo "Atualizar status" saiu — o refresh-btn assumiu o POST.
    assert.ok(!html.includes("refresh-status-btn"), "o botão 'Atualizar status' não deve existir no shell");
    assert.ok(html.includes('id="refresh-btn"'), "o botão 'Atualizar' deve permanecer");

    const js = await (await fetch(new URL("/apoios.js", server.url))).text();
    // O clique do refresh-btn deve acionar o fluxo completo (POST /api/apoios/refresh),
    // nunca só o GET — era a confusão original: "Atualizar" parecia buscar
    // e-mails novos mas só relia o snapshot.
    assert.match(js, /refreshBtn\.addEventListener\("click", \(\) => refreshApoios\(\)\)/);
    assert.ok(js.includes('fetch("/api/apoios/refresh", { method: "POST" })'), "refreshApoios deve chamar o POST");
    assert.ok(!js.includes("refreshStatusBtn"), "nenhuma referência ao botão antigo deve sobrar no JS");
    // Feedback de progresso: botão desabilitado + rótulo trocado enquanto roda.
    assert.ok(js.includes('el.refreshBtn.textContent = "Atualizando…"'), "o botão deve indicar progresso");
    assert.ok(js.includes("el.refreshBtn.disabled = true"), "o botão deve desabilitar durante a operação");
  });

  it("regressão (#3862): POST /api/apoios/contacts não existe mais (rota removida, cai no guard de método genérico)", async () => {
    const res = await fetch(new URL("/api/apoios/contacts", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Fulano", emails: ["fulano@x.com"] }),
    });
    // Sem match específico pra essa rota, POST cai no guard genérico
    // read-only (405) — mesmo caminho de #3844 (outreach) acima.
    assert.equal(res.status, 405);
  });

  let createdId = "";

  it("seed: grava contato direto no jsonl (cadastro manual saiu no #3862 — contato só vem de createContact, Gmail/apoia.se ou fixture de teste)", () => {
    const contact = createContact({ name: "Fulano", emails: ["fulano@x.com"] });
    saveContacts(root, [contact]);
    createdId = contact.id;
  });

  it("GET /api/apoios reflete o contato recém-criado sem o campo 'circle' (#3611)", async () => {
    const res = await fetch(new URL("/api/apoios", server.url));
    const body = await res.json();
    assert.equal(body.contacts.length, 1);
    assert.equal(body.contacts[0].id, createdId);
    assert.equal(body.contacts[0].status.label, "sem_dados");
    assert.equal(body.contacts[0].openRate, null); // sem cache de open-rate ainda (#3612)
    assert.equal(body.campaign.totalContacts, 1);
    assert.equal("circle" in body.contacts[0], false);
  });

  it("GET /api/apoios reflete o cache de taxa de abertura Beehiiv quando presente (#3612, fixture mockada — nunca o arquivo real de data/)", async () => {
    mkdirSync(join(root, "data", "apoia-se"), { recursive: true });
    writeFileSync(
      openRateCachePath(root),
      JSON.stringify({
        "fulano@x.com": {
          subscriptionId: "sub-fulano",
          totalDelivered: 12,
          totalUniqueOpened: 9,
          openRatePct: 75,
          clickRatePct: 20,
          fetchedAt: "2026-07-16T00:00:00.000Z",
        },
      }),
    );
    const res = await fetch(new URL("/api/apoios", server.url));
    const body = await res.json();
    const contact = body.contacts.find((c: { id: string }) => c.id === createdId);
    assert.equal(contact.openRate.subscriptionId, "sub-fulano");
    assert.equal(contact.openRate.openRatePct, 75);
  });

  it("PUT /api/apoios/contacts/:id atualiza o contato", async () => {
    const res = await fetch(new URL(`/api/apoios/contacts/${createdId}`, server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "nota via API" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.contact.notes, "nota via API");
  });

  it("PUT em id inexistente -> 404", async () => {
    const res = await fetch(new URL("/api/apoios/contacts/does-not-exist", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "x" }),
    });
    assert.equal(res.status, 404);
  });

  it("regressão (#3844): POST /api/apoios/contacts/:id/outreach não existe mais (rota removida, cai no guard de método genérico)", async () => {
    const res = await fetch(new URL(`/api/apoios/contacts/${createdId}/outreach`, server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-07-16", channel: "email", followupPending: true }),
    });
    // Sem match específico pra essa rota, POST cai no guard genérico
    // read-only (405) — mesmo caminho de qualquer POST não-allowlistado.
    assert.equal(res.status, 405);
  });

  it("regressão (#3844): GET /api/apoios/contacts/:id/outreach não existe mais (404 de API desconhecida)", async () => {
    const res = await fetch(new URL(`/api/apoios/contacts/${createdId}/outreach`, server.url));
    assert.equal(res.status, 404);
  });

  it("GET /api/apoios final não expõe mais 'pendingFollowups' nem 'totalContacted' (#3844)", async () => {
    const res = await fetch(new URL("/api/apoios", server.url));
    const body = await res.json();
    assert.equal("pendingFollowups" in body, false);
    assert.equal("totalContacted" in body.campaign, false);
  });

  it("GET em rota de mutação (método errado) cai no guard de método padrão", async () => {
    const res = await fetch(new URL("/api/apoios/contacts", server.url), { method: "GET" });
    assert.equal(res.status, 404); // não casa nenhuma rota GET conhecida -> 404 de API desconhecida
  });

  // ── #3859 metade 2: POST /api/apoios/refresh (botão "Atualizar status") ──

  it("POST /api/apoios/refresh — 200 fail-soft (credenciais ausentes nesta suíte), mesmo shape de GET /api/apoios", async () => {
    const res = await fetch(new URL("/api/apoios/refresh", server.url), { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.error ?? "", /APOIA_SE_API_KEY/);
    assert.equal(body.contacts.length, 1); // reflete o contato já criado nos testes anteriores
    assert.equal(body.contacts[0].id, createdId);
  });

  it("GET /api/apoios/refresh (método errado) não casa nenhuma rota GET conhecida -> 404 (mesmo padrão de /api/apoios/contacts)", async () => {
    const res = await fetch(new URL("/api/apoios/refresh", server.url));
    assert.equal(res.status, 404);
  });
});
