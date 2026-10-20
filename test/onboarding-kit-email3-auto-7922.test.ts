/**
 * test/onboarding-kit-email3-auto-7922.test.ts
 *
 * Decisão do editor de 20/10/2026 na #7922: o e-mail 3 do onboarding (D+10,
 * pedido de apoio) sai AUTOMÁTICO no transporte Kit. Antes, o
 * `buildOnboardingBroadcastInput` forçava `send_at: null` pro `email3` e o
 * lote ficava rascunho até alguém rodar `--approve-email3-lot`; desde o
 * flip, o lote de e-mail 3 é agendado e confirmado pela mesma releitura dos
 * e-mails 1/2. O que NÃO muda: elegibilidade (abriu ≥1 edição até D+10),
 * exclusão de `seeded_by`, e o guard cruzado com a Brevo (#8966/#9151).
 *
 * Cobre:
 *   - payload: `email3` mantém o `send_at` do caller;
 *   - executor real em subprocesso (mock HTTP do Kit, store/config/snippets
 *     temporários): lote de e-mail 3 nasce com `send_at` preenchido, é
 *     confirmado `scheduled` e a entry vira `campaign_created`;
 *   - releitura sem `send_at` → broadcast apagado, lote cancelado, entry
 *     volta a `pending` (não fica presa num "campaign_created" sem e-mail);
 *   - lote `schedule_failed` desfaz a marcação da entry;
 *   - `reconcileOpenLots` relê lote de e-mail 3 `created` (unverified);
 *   - guard cruzado: lote Kit de e-mail 3 agendado tira a entry do rascunho
 *     Brevo; `seeded_by` segue fora da seleção Kit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyKitLotToEntries,
  buildOnboardingBroadcastInput,
  selectEligibleKitRecipients,
  type OnboardingKitLot,
} from "../scripts/lib/onboarding-kit-transport.ts";
import { reconcileOpenLots } from "../scripts/onboarding-kit-transport-run.ts";
import { buildRunPlan, filterBrevoPlanForKitCutover } from "../scripts/lib/onboarding-state.ts";
import type { OnboardingEntry, OnboardingStore } from "../scripts/lib/onboarding-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "onboarding-kit-transport-run.ts");

const NOW_MS = Date.now();
const iso = (daysAgo: number) => new Date(NOW_MS - daysAgo * 86_400_000).toISOString();
const sec = (daysAgo: number) => Math.floor((NOW_MS - daysAgo * 86_400_000) / 1000);

/** Entrada da escada Kit com e-mail 1/2 enviados e D+10 vencido. */
function d10Entry(id: string, over: Record<string, unknown> = {}) {
  return {
    subscription_id: id,
    kit_subscriber_id: Number(id),
    email: `d${id}@example.com`,
    status_detectado: "active",
    created_at: sec(12),
    detected_at: iso(12),
    email1_sent_at: iso(11),
    email1_brevo_id: null,
    email1_transport: "kit",
    email2_sent_at: iso(8),
    email2_brevo_id: null,
    email3_state: "pending",
    email3_campaign_id: null,
    email3_decided_at: null,
    ...over,
  };
}

function email3Lot(over: Partial<OnboardingKitLot> = {}): OnboardingKitLot {
  return {
    lot_id: "email3-2026-10-20-01",
    kind: "email3",
    tag_name: "onboarding-email3-2026-10-20-01",
    tag_id: 777,
    broadcast_id: 4242,
    recipient_subscription_ids: ["601"],
    recipient_emails: ["d601@example.com"],
    status: "scheduled",
    created_at: iso(0),
    send_at: iso(-0.001),
    last_reconciled_at: null,
    last_error: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Mock HTTP do Kit — só as rotas que o executor toca neste cenário.
// ---------------------------------------------------------------------------

interface MockOpts {
  /** Releitura `GET /broadcasts/{id}` devolve rascunho sem `send_at`. */
  rereadNoSendAt?: boolean;
}

function startMockKit(opts: MockOpts = {}): Promise<{ server: Server; url: string; hits: string[]; created: { send_at: string | null }[] }> {
  const hits: string[] = [];
  const created: { send_at: string | null }[] = [];
  const broadcasts = new Map<number, { send_at: string | null }>();
  let nextId = 4242;
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const p = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        hits.push(`${req.method} ${p}`);
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        const pagination = { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 };
        let m: RegExpMatchArray | null;
        if (req.method === "GET" && (m = p.match(/^\/subscribers\/(\d+)\/stats$/))) {
          return send(200, { subscriber: { id: Number(m[1]), stats: { opened: 2 } } });
        }
        if (req.method === "GET" && (m = p.match(/^\/subscribers\/(\d+)$/))) {
          return send(200, { subscriber: { id: Number(m[1]), email_address: "x@example.com", state: "active", created_at: "2026-09-01T00:00:00Z" } });
        }
        if (req.method === "GET" && p === "/account") return send(200, { account: { id: 111, name: "mock", plan_type: "creator" } });
        if (req.method === "GET" && p === "/subscribers") return send(200, { subscribers: [], pagination });
        if (req.method === "GET" && p === "/tags") return send(200, { tags: [], pagination });
        if (req.method === "POST" && p === "/tags") {
          return send(201, { tag: { id: 777, name: JSON.parse(raw || "{}").name, created_at: "2026-10-20T00:00:00Z" } });
        }
        if (req.method === "POST" && /^\/tags\/\d+\/subscribers\/\d+$/.test(p)) return send(201, { subscriber: {} });
        if (req.method === "POST" && p === "/broadcasts") {
          const body = JSON.parse(raw || "{}") as { send_at?: string | null };
          const id = nextId++;
          created.push({ send_at: body.send_at ?? null });
          broadcasts.set(id, { send_at: body.send_at ?? null });
          return send(201, { broadcast: { id, status: body.send_at ? "scheduled" : "draft", send_at: body.send_at ?? null, public: false, subject: "s" } });
        }
        if ((m = p.match(/^\/broadcasts\/(\d+)$/))) {
          const id = Number(m[1]);
          const b = broadcasts.get(id);
          if (req.method === "GET") {
            if (!b) return send(404, { errors: ["Not Found"] });
            const drop = opts.rereadNoSendAt === true;
            return send(200, {
              broadcast: { id, status: drop ? "draft" : "scheduled", send_at: drop ? null : b.send_at, public: false, subject: "s" },
            });
          }
          if (req.method === "DELETE") {
            broadcasts.delete(id);
            res.writeHead(204);
            return res.end();
          }
        }
        send(404, { error: `unexpected ${req.method} ${p}` });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolvePromise({ server, url: `http://127.0.0.1:${port}`, hits, created });
    });
  });
}

function runExecutor(args: string[], kitUrl: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env, KIT_API_KEY: "fixture_fake_kit_key_do_not_use", KIT_API_URL: kitUrl },
      timeout: 60_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function setup(entries: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "kit-email3-auto-"));
  const configPath = join(dir, "platform.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      publishing: { newsletter: { subscriber_backend: "kit" } },
      onboarding: { kit_transport: { enabled: true } },
    }),
  );
  const storePath = join(dir, "store.json");
  writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      last_detection_cursor: sec(0),
      last_detection_backend: "kit",
      d10_brevo_list_id: null,
      entries,
      kit_transport: { lots: {} },
    }),
  );
  const snippetsDir = join(dir, "snippets");
  mkdirSync(snippetsDir, { recursive: true });
  for (const n of [1, 2, 3]) {
    writeFileSync(join(snippetsDir, `onboarding-${n}.md`), `<!-- assunto: "assunto ${n}" preview_text: "preview ${n}" -->\nCorpo ${n}.\n`);
  }
  const args = ["--send", "--config", configPath, "--store", storePath, "--snippets-dir", snippetsDir];
  const readStore = () => JSON.parse(readFileSync(storePath, "utf8"));
  return { dir, args, readStore };
}

async function withMock<T>(opts: MockOpts, fn: (m: { url: string; hits: string[]; created: { send_at: string | null }[] }) => Promise<T>): Promise<T> {
  const { server, ...rest } = await startMockKit(opts);
  try {
    return await fn(rest);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("#7922 (20/10/2026) — e-mail 3 automático no transporte Kit", () => {
  it("buildOnboardingBroadcastInput mantém o send_at do caller também no email3 (public:false segue fixo)", () => {
    const input = buildOnboardingBroadcastInput({
      kind: "email3",
      subject: "s",
      content: "c",
      tagId: 777,
      sendAt: "2026-10-21T12:00:00.000Z",
    });
    assert.equal(input.send_at, "2026-10-21T12:00:00.000Z");
    assert.equal(input.public, false);
  });

  it("--send: lote de e-mail 3 nasce com send_at, é confirmado scheduled e a entry vira campaign_created", async () => {
    const t = setup({ "601": d10Entry("601") });
    try {
      await withMock({}, async ({ url, hits, created }) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        assert.equal(created.length, 1, "um broadcast (o lote de e-mail 3)");
        assert.ok(created[0].send_at, "o POST do lote de e-mail 3 leva send_at preenchido (não é mais rascunho)");
        assert.ok(hits.some((h) => h.startsWith("GET /broadcasts/")), "agendamento confirmado pela releitura");
        const store = t.readStore();
        const lots = Object.values(store.kit_transport.lots as Record<string, OnboardingKitLot>);
        assert.equal(lots.length, 1);
        assert.equal(lots[0].kind, "email3");
        assert.equal(lots[0].status, "scheduled");
        assert.ok(lots[0].send_at);
        assert.equal(store.kit_transport.last_send_run.lots_created, 1);
        assert.equal(store.entries["601"].email3_state, "campaign_created");
        assert.equal(store.entries["601"].email3_kit_lot_id, lots[0].lot_id);
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("--send: releitura sem send_at → broadcast apagado, lote cancelado, entry volta a pending (não fica presa)", async () => {
    const t = setup({ "601": d10Entry("601") });
    try {
      await withMock({ rereadNoSendAt: true }, async ({ url, hits }) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        assert.ok(hits.some((h) => h.startsWith("DELETE /broadcasts/")));
        const store = t.readStore();
        const lot = Object.values(store.kit_transport.lots as Record<string, OnboardingKitLot>)[0]!;
        assert.equal(lot.status, "cancelled");
        assert.equal(store.kit_transport.last_send_run.lots_failed, 1);
        assert.equal(store.entries["601"].email3_state, "pending");
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("--send: entry com seeded_by fica fora do lote de e-mail 3", async () => {
    const t = setup({ "601": d10Entry("601", { seeded_by: "#7675" }) });
    try {
      await withMock({}, async ({ url, created }) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        assert.equal(created.length, 0, "seed nunca entra num lote automático");
        assert.equal(t.readStore().entries["601"].email3_state, "pending");
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("lote de e-mail 3 schedule_failed desfaz a marcação campaign_created da entry", () => {
    const entries = {
      "601": d10Entry("601", { email3_state: "campaign_created", email3_decided_at: iso(0), email3_kit_lot_id: "email3-2026-10-20-01" }),
    } as unknown as Record<string, OnboardingEntry>;
    const touched = applyKitLotToEntries(entries, email3Lot({ status: "created", schedule_failed: true }), iso(0));
    assert.equal(touched, 1);
    assert.equal(entries["601"].email3_state, "pending");
    assert.equal(entries["601"].email3_kit_lot_id, undefined);
  });

  it("reconcileOpenLots relê lote de e-mail 3 created (agendamento não confirmado) e confirma pelo send_at ecoado", async () => {
    const lot = email3Lot({ status: "created", send_at: null });
    const store = {
      version: 1,
      last_detection_cursor: sec(0),
      entries: { "601": d10Entry("601", { email3_state: "campaign_created", email3_kit_lot_id: lot.lot_id }) },
      kit_transport: { lots: { [lot.lot_id]: lot } },
    } as unknown as OnboardingStore;
    const sendAt = new Date(NOW_MS + 60_000).toISOString();
    let deleted = 0;
    const { results, stillUnverified } = await reconcileOpenLots(
      { storePath: "/nao-usado-sem-persist", store, persist: false },
      {
        getBroadcast: async () => ({ status: "scheduled", send_at: sendAt }),
        deleteBroadcast: async () => {
          deleted++;
        },
      },
    );
    assert.equal(stillUnverified, 0);
    assert.equal(deleted, 0);
    assert.equal(results[0]?.recovered, "scheduled");
    assert.equal(store.kit_transport!.lots[lot.lot_id].status, "scheduled");
  });

  it("guard cruzado (#9151): lote Kit de e-mail 3 agendado tira a entry do rascunho Brevo", () => {
    const entry = d10Entry("601") as unknown as OnboardingEntry;
    const plan = buildRunPlan({
      entries: [entry],
      statsById: { "601": { total_unique_opened: 2, total_clicked: 0 } },
      nowSec: sec(0),
      email2Days: 3,
      email3Days: 10,
      email3GraceDays: 10,
      snippets: Object.fromEntries(
        ([1, 2, 3] as const).map((n) => [n, { numero: n, assunto: `a${n}`, previewText: "p", body: "<p>c</p>", hasPendingMarker: false }]),
      ) as never,
    });
    assert.deepEqual(plan.actions.map((a) => a.kind), ["email3_campaign"], "pré-condição: e-mail 3 devido");
    const brevo = filterBrevoPlanForKitCutover(plan, true, [email3Lot()]);
    assert.deepEqual(brevo.actions, [], "Brevo não cria o e-mail 3 de quem já está num lote Kit agendado");
    assert.equal(brevo.skips.find((s) => s.etapa === "email3")?.motivo, "kit_lot_existente");
  });

  it("seeded_by segue excluído da seleção Kit (selectEligibleKitRecipients)", () => {
    const { eligible, excluded } = selectEligibleKitRecipients([
      { subscription_id: "601", email: "d601@example.com", kit_subscriber_id: 601, kit_state: "active", seeded_by: "#7665" },
    ]);
    assert.equal(eligible.length, 0);
    assert.equal(excluded.length, 1);
  });
});
