/**
 * test/onboarding-welcome-refresh-dono-10677.test.ts (#10677)
 *
 * O fix P2 da PR #10607 tirou do refresh do executor Kit as escadas cujo
 * próximo passo é da Brevo. O lado Brevo (`onboarding-welcome-run.ts`) não
 * tinha o filtro simétrico: consultava `GET /subscribers/{id}` + `/stats` no
 * Kit pra TODAS as entradas, inclusive as do transporte Kit, e descartava o
 * resultado depois (`kit_transport_ativo` / `ownsEmail3` falso) — gastando o
 * balde de rate limit que o passo `kit` seguinte precisa.
 *
 * Molde de `test/onboarding-email3-id-legado-7670.test.ts`: subprocesso real
 * contra mock HTTP local do Kit, registrando as rotas batidas.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { refreshOwnerFor } from "../scripts/lib/onboarding-state.ts";
import type { OnboardingEntry } from "../scripts/lib/onboarding-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "onboarding-welcome-run.ts");

const BREVO_KIT_ID = 5100000001;
const KIT_KIT_ID = 5100000002;
const NOVO_KIT_ID = 5100000003;

function spawnScript(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((res, rej) => {
    const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, ...args], { env, timeout: 30_000 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", rej);
    child.on("close", (status) => res({ status, stdout, stderr }));
  });
}

function startMockKit(): Promise<{ server: Server; url: string; paths: () => string[] }> {
  const paths: string[] = [];
  return new Promise((res) => {
    const server = createServer((req, rsp) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      paths.push(parsed.pathname + parsed.search);
      rsp.setHeader("content-type", "application/json");
      if (parsed.pathname === "/subscribers") {
        rsp.writeHead(200);
        rsp.end(
          JSON.stringify({
            subscribers: [],
            pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
          }),
        );
        return;
      }
      const m = /^\/subscribers\/(\d+)(\/stats)?$/.exec(parsed.pathname);
      if (m) {
        rsp.writeHead(200);
        if (m[2]) rsp.end(JSON.stringify({ subscriber: { stats: { total_unique_opens: 1 } } }));
        else
          rsp.end(
            JSON.stringify({
              subscriber: { id: Number(m[1]), email_address: `${m[1]}@example.com`, state: "active", created_at: "2026-10-01T12:00:00Z", fields: {} },
            }),
          );
        return;
      }
      rsp.writeHead(404);
      rsp.end(JSON.stringify({ error: `rota inesperada ${parsed.pathname}` }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ server, url: `http://127.0.0.1:${port}`, paths: () => paths });
    });
  });
}

function env(kitUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KIT_API_URL: kitUrl,
    KIT_API_KEY: "test-kit-key-10677",
    BEEHIIV_API_KEY: "",
    BEEHIIV_PUBLICATION_ID: "",
    BREVO_DIARIA_API_KEY: "test-brevo-key-10677",
  };
}

function entry(id: number, over: Partial<OnboardingEntry> = {}): OnboardingEntry {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    subscription_id: String(id),
    email: `${id}@example.com`,
    status_detectado: "active",
    created_at: nowSec - 20 * 86_400, // D+20: vencido no e-mail 2 e no e-mail 3
    detected_at: new Date((nowSec - 20 * 86_400) * 1000).toISOString(),
    email1_sent_at: new Date((nowSec - 20 * 86_400) * 1000).toISOString(),
    email1_brevo_id: null,
    email2_sent_at: null,
    email2_brevo_id: null,
    email3_state: "pending",
    email3_campaign_id: null,
    email3_decided_at: null,
    kit_subscriber_id: id,
    ...over,
  } as OnboardingEntry;
}

function fixture(dir: string, kitTransportEnabled: boolean) {
  const nowSec = Math.floor(Date.now() / 1000);
  const configPath = resolve(dir, "platform.config.json");
  const storePath = resolve(dir, "store.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      onboarding: {
        enabled: true,
        snippets_dir: resolve(dir, "snippets"), // inexistente: nenhum envio é planejado
        store_path: storePath,
        email3_days: 10,
        sender_email: "oi@example.com",
        sender_name: "teste",
        kit_transport: { enabled: kitTransportEnabled },
      },
      publishing: { newsletter: { subscriber_backend: "kit" } },
    }),
  );
  writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      last_detection_cursor: nowSec - 60,
      last_detection_backend: "kit",
      d10_brevo_list_id: null,
      entries: {
        [String(BREVO_KIT_ID)]: entry(BREVO_KIT_ID, { email1_transport: "brevo" }),
        [String(KIT_KIT_ID)]: entry(KIT_KIT_ID, { email1_transport: "kit" }),
        // Cadastro novo sem confirmação: o próximo passo (e-mail 1) é do Kit.
        [String(NOVO_KIT_ID)]: entry(NOVO_KIT_ID, {
          status_detectado: "inactive",
          email1_sent_at: null,
          created_at: nowSec - 86_400,
          detected_at: new Date((nowSec - 86_400) * 1000).toISOString(),
        }),
      },
    }),
  );
  return { configPath, storePath };
}

const hit = (paths: string[], id: number) => paths.some((p) => p === `/subscribers/${id}` || p === `/subscribers/${id}/stats`);

describe("onboarding-welcome-run: refresh só das entradas da Brevo (#10677)", () => {
  it("REGRESSÃO: com o transporte Kit ligado, entrada do Kit não gera GET no Kit", async () => {
    const { server, url, paths } = await startMockKit();
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-10677-"));
    try {
      const { configPath, storePath } = fixture(dir, true);
      const r = await spawnScript(["--config", configPath, "--store", storePath], env(url));
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(hit(paths(), BREVO_KIT_ID), `a entrada da Brevo continua sendo refrescada — rotas: ${JSON.stringify(paths())}`);
      assert.ok(!hit(paths(), KIT_KIT_ID), `entrada com email1_transport=kit não pode ser consultada — rotas: ${JSON.stringify(paths())}`);
      assert.ok(!hit(paths(), NOVO_KIT_ID), `cadastro novo (e-mail 1 do Kit) não pode ser consultado — rotas: ${JSON.stringify(paths())}`);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("com o transporte Kit desligado (rollback), a Brevo é dona de tudo e refresca todas", async () => {
    const { server, url, paths } = await startMockKit();
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-10677-"));
    try {
      const { configPath, storePath } = fixture(dir, false);
      const r = await spawnScript(["--config", configPath, "--store", storePath], env(url));
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      for (const id of [BREVO_KIT_ID, KIT_KIT_ID, NOVO_KIT_ID]) {
        assert.ok(hit(paths(), id), `id ${id} devia ser refrescado com o switch desligado — rotas: ${JSON.stringify(paths())}`);
      }
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("refreshOwnerFor (#10677)", () => {
  it("segue o dono do e-mail 1 antes da escada começar e o do e-mail 3 depois", () => {
    const base = entry(1);
    assert.equal(refreshOwnerFor({ ...base, email1_sent_at: null }, true), "kit");
    assert.equal(refreshOwnerFor({ ...base, email1_sent_at: null, seeded_by: "x" } as OnboardingEntry, true), "brevo");
    assert.equal(refreshOwnerFor({ ...base, email1_transport: "kit" } as OnboardingEntry, true), "kit");
    assert.equal(refreshOwnerFor(base, true), "brevo");
    assert.equal(refreshOwnerFor({ ...base, email1_sent_at: null }, false), "brevo");
  });
});
