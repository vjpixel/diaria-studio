/**
 * test/studio-onboarding-server-7917.test.ts (#7917)
 *
 * Integração fina: as rotas `GET /api/onboarding/funnel` e
 * `POST /api/onboarding/funnel/refresh-brevo` respondem de verdade através
 * do dispatcher do studio-server (não só a camada `studio-onboarding.ts`
 * isolada — já coberta por `test/studio-onboarding-7917.test.ts`). Mesmo
 * padrão de setup de `test/studio-server.test.ts`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";
import { writeStore, emptyStore, type OnboardingEntry } from "../scripts/lib/onboarding-store.ts";

describe("studio-server — rotas de onboarding (#7917)", () => {
  let root: string;
  let server: StudioServer;
  let savedApiKey: string | undefined;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-server-onboarding-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    // Nunca bater na Brevo real neste teste — a ausência da key já força o
    // handler pro ramo "snapshot local" (ver handleApiOnboardingFunnelRefresh).
    savedApiKey = process.env.BREVO_DIARIA_API_KEY;
    delete process.env.BREVO_DIARIA_API_KEY;
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    if (savedApiKey != null) process.env.BREVO_DIARIA_API_KEY = savedApiKey;
    rmSync(root, { recursive: true, force: true });
  });

  it("GET /api/onboarding/funnel sem store: 200, db.available false", async () => {
    const res = await fetch(new URL("/api/onboarding/funnel", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.db.available, false);
    assert.deepEqual(body.entries, []);
  });

  it("GET /api/onboarding/funnel com store real: reflete a entrada gravada", async () => {
    const entry: OnboardingEntry = {
      subscription_id: "sub_1",
      email: "leitor@example.com",
      status_detectado: "active",
      created_at: Math.floor(Date.now() / 1000) - 20 * 86_400,
      detected_at: new Date(Date.now() - 20 * 86_400_000).toISOString(),
      email1_sent_at: new Date(Date.now() - 15 * 86_400_000).toISOString(),
      email1_brevo_id: "msg-1",
      email2_sent_at: null,
      email2_brevo_id: null,
      email3_state: "pending",
      email3_campaign_id: null,
      email3_decided_at: null,
    };
    const store = emptyStore();
    store.entries["sub_1"] = entry;
    writeStore(store, resolve(root, "data", "onboarding", "store.json"));

    const res = await fetch(new URL("/api/onboarding/funnel", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.db.available, true);
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0].subscriptionId, "sub_1");
    assert.equal(body.summary.total, 1);
  });

  it("POST /api/onboarding/funnel/refresh-brevo sem BREVO_DIARIA_API_KEY: 200 com aviso, nunca chama rede", async () => {
    const res = await fetch(new URL("/api/onboarding/funnel/refresh-brevo", server.url), { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.refreshWarning, /BREVO_DIARIA_API_KEY ausente/);
    assert.equal(body.liveBrevoChecked, false);
  });

  it("GET /api/onboarding/funnel/refresh-brevo (método errado) não é aceito nesta rota", async () => {
    const res = await fetch(new URL("/api/onboarding/funnel/refresh-brevo", server.url));
    assert.notEqual(res.status, 200);
  });
});
