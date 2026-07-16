/**
 * test/studio-apoios-page.test.ts (#3602) — contrato HTTP do CRM de apoios:
 * `GET /apoios` faz rewrite pro shell estático (`public/apoios.html`),
 * `GET /api/apoios` serve o snapshot fail-soft de `studio-apoios.ts`, e as 3
 * rotas de mutação (`POST /api/apoios/contacts`, `PUT .../:id`,
 * `POST .../:id/outreach`) fazem CRUD real sobre um `contacts.jsonl` de
 * teste — nunca sobre `data/` real, sempre um tmpdir isolado.
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
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";

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
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
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
    assert.ok(body.includes("add-contact-form"));
    assert.ok(body.includes("contacts-list"));
  });

  it("aceita /apoios/ com trailing slash", async () => {
    const res = await fetch(new URL("/apoios/", server.url));
    assert.equal(res.status, 200);
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
    assert.deepEqual(body.pendingFollowups, []);
    assert.match(body.error ?? "", /APOIA_SE_API_KEY/);
  });

  it("POST /api/apoios/contacts com corpo inválido -> 400", async () => {
    const res = await fetch(new URL("/api/apoios/contacts", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", emails: [] }),
    });
    assert.equal(res.status, 400);
  });

  let createdId = "";

  it("POST /api/apoios/contacts cria contato -> 201", async () => {
    const res = await fetch(new URL("/api/apoios/contacts", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Fulano", emails: ["fulano@x.com"], circle: "lista VJs" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.contact.id);
    createdId = body.contact.id;
  });

  it("GET /api/apoios reflete o contato recém-criado", async () => {
    const res = await fetch(new URL("/api/apoios", server.url));
    const body = await res.json();
    assert.equal(body.contacts.length, 1);
    assert.equal(body.contacts[0].id, createdId);
    assert.equal(body.contacts[0].status.label, "sem_dados");
    assert.equal(body.campaign.totalContacts, 1);
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

  it("POST /api/apoios/contacts/:id/outreach registra outreach", async () => {
    const res = await fetch(new URL(`/api/apoios/contacts/${createdId}/outreach`, server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-07-16", channel: "email", followupPending: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.contact.outreach.length, 1);
  });

  it("outreach com corpo inválido (sem channel) -> 400", async () => {
    const res = await fetch(new URL(`/api/apoios/contacts/${createdId}/outreach`, server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-07-16", channel: "" }),
    });
    assert.equal(res.status, 400);
  });

  it("outreach em id inexistente -> 404", async () => {
    const res = await fetch(new URL("/api/apoios/contacts/does-not-exist/outreach", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-07-16", channel: "email" }),
    });
    assert.equal(res.status, 404);
  });

  it("GET /api/apoios final reflete o outreach registrado e o follow-up pendente", async () => {
    const res = await fetch(new URL("/api/apoios", server.url));
    const body = await res.json();
    assert.equal(body.pendingFollowups.length, 1);
    assert.equal(body.pendingFollowups[0].contactId, createdId);
    assert.equal(body.campaign.totalContacted, 1);
  });

  it("GET em rota de mutação (método errado) cai no guard de método padrão", async () => {
    const res = await fetch(new URL("/api/apoios/contacts", server.url), { method: "GET" });
    assert.equal(res.status, 404); // não casa nenhuma rota GET conhecida -> 404 de API desconhecida
  });
});
