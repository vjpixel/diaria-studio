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
import { startMockKitOnboarding, type MockKitOnboardingOpts } from "./_helpers/mock-kit-onboarding.ts";
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
import { buildRunPlan, filterBrevoPlanForKitCutover, filterKitPlanForBrevoInFlight, ownerTransportFor, stripForeignEmail3Delta } from "../scripts/lib/onboarding-state.ts";
import { persistStoreDelta } from "../scripts/lib/onboarding-store.ts";
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

type MockOpts = MockKitOnboardingOpts;
const emailForKitId = (id: number) => `d${id}@example.com`;

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

async function withMock<T>(opts: MockOpts, fn: (m: { url: string; hits: string[]; createdSendAt: (string | null)[] }) => Promise<T>): Promise<T> {
  const { server, ...rest } = await startMockKitOnboarding({ emailForKitId, ...opts });
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

  it("--send: lote de e-mail 3 é AGENDADO (PATCH com send_at depois de conferir a audiência), confirmado scheduled, e a entry vira campaign_created", async () => {
    const t = setup({ "601": d10Entry("601") });
    try {
      await withMock({}, async ({ url, hits, createdSendAt }) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        assert.equal(createdSendAt.length, 1, "um broadcast (o lote de e-mail 3)");
        assert.ok(hits.some((h) => h.startsWith("PATCH /broadcasts/")), "o e-mail 3 é agendado (não fica rascunho)");
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

  it("--send: PATCH que não agenda → broadcast apagado, lote cancelado, entry volta a pending (não fica presa)", async () => {
    const t = setup({ "601": d10Entry("601") });
    try {
      await withMock({ patchNoSchedule: "always" }, async ({ url, hits }) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 1, `stdout: ${r.stdout} stderr: ${r.stderr}`);
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
      await withMock({}, async ({ url, createdSendAt }) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        assert.equal(createdSendAt.length, 0, "seed nunca entra num lote automático");
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

  it("lote contraditório {completed|scheduled, schedule_failed:true} NUNCA reabre o e-mail 3 (seria envio em dobro)", () => {
    for (const status of ["completed", "scheduled"] as const) {
      const entries = {
        "601": d10Entry("601", { email3_state: "campaign_created", email3_decided_at: iso(0), email3_kit_lot_id: "email3-2026-10-20-01" }),
      } as unknown as Record<string, OnboardingEntry>;
      applyKitLotToEntries(entries, email3Lot({ status, schedule_failed: true }), iso(0));
      assert.equal(entries["601"].email3_state, "campaign_created", status);
      assert.equal(entries["601"].email3_kit_lot_id, "email3-2026-10-20-01", status);
    }
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

  it("guard cruzado (#9151): lote Kit de e-mail 3 agendado tira a entry do rascunho Brevo, mesmo com o switch desligado", () => {
    const plan = d10Plan([d10Entry("601") as unknown as OnboardingEntry]);
    assert.deepEqual(plan.actions.map((a) => a.kind), ["email3_campaign"], "pré-condição: e-mail 3 devido");
    for (const enabled of [true, false]) {
      const brevo = filterBrevoPlanForKitCutover(plan, enabled, [email3Lot()]);
      assert.deepEqual(brevo.actions, [], "Brevo não cria o e-mail 3 de quem já está num lote Kit agendado");
      assert.equal(brevo.skips.find((s) => s.etapa === "email3")?.motivo, "kit_lot_existente");
    }
  });
});

/** Plano com o e-mail 3 devido (D+10, ≥1 abertura) pra cada entry. */
function d10Plan(entries: OnboardingEntry[]) {
  return buildRunPlan({
    entries,
    statsById: Object.fromEntries(entries.map((e) => [e.subscription_id, { total_unique_opened: 2, total_clicked: 0 }])),
    nowSec: sec(0),
    email2Days: 3,
    email3Days: 10,
    email3GraceDays: 10,
    snippets: Object.fromEntries(
      ([1, 2, 3] as const).map((n) => [n, { numero: n, assunto: `a${n}`, previewText: "p", body: "<p>c</p>", hasPendingMarker: false }]),
    ) as never,
  });
}

const email3Ids = (p: ReturnType<typeof d10Plan>) =>
  p.actions.flatMap((a) => (a.kind === "email3_campaign" ? a.entries.map((e) => e.subscription_id) : []));

describe("#7922 (20/10/2026) — dono do e-mail 3 = transporte do e-mail 1 da mesma entrada", () => {
  it("email1_transport kit + D+10 elegível → plano Brevo vazio pra ela, plano Kit com o e-mail 3", () => {
    const plan = d10Plan([d10Entry("601", { email1_transport: "kit" }) as unknown as OnboardingEntry]);
    const brevo = filterBrevoPlanForKitCutover(plan, true, []);
    assert.deepEqual(email3Ids(brevo), []);
    assert.equal(brevo.skips.find((s) => s.etapa === "email3")?.motivo, "kit_transport_ativo");
    const kit = filterKitPlanForBrevoInFlight(plan, true, []);
    assert.deepEqual(email3Ids(kit), ["601"]);
  });

  it("email1_transport brevo + D+10 elegível → plano Kit vazio pra ela, plano Brevo com o e-mail 3", () => {
    const plan = d10Plan([d10Entry("602", { email1_transport: "brevo", email1_brevo_id: "m-1" }) as unknown as OnboardingEntry]);
    const kit = filterKitPlanForBrevoInFlight(plan, true, []);
    assert.deepEqual(email3Ids(kit), []);
    assert.equal(kit.skips.find((s) => s.etapa === "email3")?.motivo, "escada_iniciada_na_brevo");
    assert.deepEqual(email3Ids(filterBrevoPlanForKitCutover(plan, true, [])), ["602"]);
  });

  it("seed e e-mail 1 legado sem proveniência continuam brevo", () => {
    const seed = d10Entry("603", { email1_transport: undefined, seeded_by: "#7675" }) as unknown as OnboardingEntry;
    const legado = d10Entry("604", { email1_transport: undefined }) as unknown as OnboardingEntry;
    assert.equal(ownerTransportFor(seed, "email3", true), "brevo");
    assert.equal(ownerTransportFor(legado, "email3", true), "brevo");
    const plan = d10Plan([seed, legado]);
    assert.deepEqual(email3Ids(filterBrevoPlanForKitCutover(plan, true, [])), ["603", "604"]);
    assert.deepEqual(email3Ids(filterKitPlanForBrevoInFlight(plan, true, [])), []);
  });

  it("cohort misto é dividido entre os dois transportes, sem sobreposição", () => {
    const plan = d10Plan([
      d10Entry("601", { email1_transport: "kit" }) as unknown as OnboardingEntry,
      d10Entry("602", { email1_transport: "brevo" }) as unknown as OnboardingEntry,
    ]);
    assert.deepEqual(email3Ids(filterKitPlanForBrevoInFlight(plan, true, [])), ["601"]);
    assert.deepEqual(email3Ids(filterBrevoPlanForKitCutover(plan, true, [])), ["602"]);
  });

  it("switch desligado (rollback): Brevo é dona do e-mail 3 de todos, Kit não planeja nenhum", () => {
    const plan = d10Plan([d10Entry("601", { email1_transport: "kit" }) as unknown as OnboardingEntry]);
    assert.equal(ownerTransportFor(d10Entry("601", { email1_transport: "kit" }) as unknown as OnboardingEntry, "email3", false), "brevo");
    assert.deepEqual(email3Ids(filterBrevoPlanForKitCutover(plan, false, [])), ["601"]);
    assert.deepEqual(email3Ids(filterKitPlanForBrevoInFlight(plan, false, [])), []);
  });

  it("seeded_by segue excluído da seleção Kit (selectEligibleKitRecipients)", () => {
    const { eligible, excluded } = selectEligibleKitRecipients([
      { subscription_id: "601", email: "d601@example.com", kit_subscriber_id: 601, kit_state: "active", seeded_by: "#7665" },
    ]);
    assert.equal(eligible.length, 0);
    assert.equal(excluded.length, 1);
  });
});

describe("#7922 (fleet review da PR #10607, item C) — só o dono decide e grava o estado do e-mail 3", () => {
  it("buildRunPlan com ownsEmail3=false não avalia nem grava skipped_* (a Brevo não toca entrada do Kit)", () => {
    const entry = d10Entry("601") as unknown as OnboardingEntry;
    const plan = buildRunPlan({
      entries: [entry],
      statsById: { "601": { total_unique_opened: 0, total_clicked: 0 } },
      nowSec: sec(0),
      email2Days: 3,
      email3Days: 10,
      email3GraceDays: 10,
      snippets: Object.fromEntries(
        ([1, 2, 3] as const).map((n) => [n, { numero: n, assunto: `a${n}`, previewText: "p", body: "<p>c</p>", hasPendingMarker: false }]),
      ) as never,
      ownsEmail3: () => false,
    });
    assert.equal(entry.email3_state, "pending", "sem abertura, mas a decisão é do dono (Kit), não da Brevo");
    assert.deepEqual(plan.actions, []);
  });

  it("stripForeignEmail3Delta: a rodada Brevo nunca sobrescreve campaign_created do Kit nem grava skipped_* de entrada do Kit", () => {
    const baseline = { entries: { "601": d10Entry("601", { email1_transport: "kit" }), "602": d10Entry("602", { email1_transport: "brevo" }) } } as unknown as { entries: Record<string, OnboardingEntry> };
    const updated = JSON.parse(JSON.stringify(baseline)) as typeof baseline;
    updated.entries["601"].email3_state = "skipped_no_open";
    updated.entries["601"].email3_decided_at = iso(0);
    updated.entries["602"].email3_state = "skipped_no_open";
    const n = stripForeignEmail3Delta(baseline, updated, (e) => ownerTransportFor(e, "email3", true) !== "brevo");
    assert.equal(n, 1);
    assert.equal(updated.entries["601"].email3_state, "pending", "delta do e-mail 3 de entrada Kit revertido");
    assert.equal(updated.entries["601"].email3_decided_at, null);
    assert.equal(updated.entries["602"].email3_state, "skipped_no_open", "entrada da Brevo segue com a decisão da Brevo");

    // Persistência real: o Kit gravou campaign_created no disco durante a rodada Brevo.
    const dir = mkdtempSync(join(tmpdir(), "kit-email3-strip-"));
    try {
      const storePath = join(dir, "store.json");
      const disk = { version: 1, entries: JSON.parse(JSON.stringify(baseline.entries)), kit_transport: { lots: {} } };
      disk.entries["601"].email3_state = "campaign_created";
      disk.entries["601"].email3_kit_lot_id = "email3-x-01";
      writeFileSync(storePath, JSON.stringify(disk));
      const upd2 = JSON.parse(JSON.stringify(baseline)) as typeof baseline;
      upd2.entries["601"].email3_state = "skipped_no_open";
      stripForeignEmail3Delta(baseline, upd2, (e) => ownerTransportFor(e, "email3", true) !== "brevo");
      persistStoreDelta(storePath, baseline as never, upd2 as never);
      const after = JSON.parse(readFileSync(storePath, "utf8"));
      assert.equal(after.entries["601"].email3_state, "campaign_created");
      assert.equal(after.entries["601"].email3_kit_lot_id, "email3-x-01");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("executor Kit grava a decisão terminal (skipped_no_open) das entradas dele — sem isso ficariam pending pra sempre", async () => {
    const t = setup({ "601": d10Entry("601") });
    try {
      await withMock({ opened: 0 }, async ({ url, createdSendAt }) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        assert.equal(createdSendAt.length, 0);
        assert.equal(t.readStore().entries["601"].email3_state, "skipped_no_open");
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});

describe("#7922 (fleet review da PR #10607, item G1) — partição: cada entrada cai em exatamente um dos dois planos", () => {
  const transports = ["kit", "brevo", undefined] as const;
  const seeds = [undefined, "#7675"] as const;
  for (const enabled of [true, false]) {
    for (const tr of transports) {
      for (const seed of seeds) {
        it(`switch ${enabled ? "on" : "off"} × email1_transport=${tr ?? "undefined"} × seeded_by=${seed ?? "—"}`, () => {
          const mk = () => d10Entry("601", { email1_transport: tr, ...(seed ? { seeded_by: seed } : {}) }) as unknown as OnboardingEntry;
          const owner = ownerTransportFor(mk(), "email3", enabled);
          const stats = { "601": { total_unique_opened: 2, total_clicked: 0 } };
          const snippets = Object.fromEntries(
            ([1, 2, 3] as const).map((n) => [n, { numero: n, assunto: `a${n}`, previewText: "p", body: "<p>c</p>", hasPendingMarker: false }]),
          ) as never;
          const base = { statsById: stats, nowSec: sec(0), email2Days: 3, email3Days: 10, email3GraceDays: 10, snippets };
          const brevo = filterBrevoPlanForKitCutover(
            buildRunPlan({ ...base, entries: [mk()], ownsEmail3: (e) => ownerTransportFor(e, "email3", enabled) === "brevo" }),
            enabled,
            [],
          );
          const kit = filterKitPlanForBrevoInFlight(
            buildRunPlan({ ...base, entries: [mk()], ownsEmail3: (e) => ownerTransportFor(e, "email3", enabled) === "kit" }),
            enabled,
            [],
          );
          const inBrevo = email3Ids(brevo).length;
          const inKit = email3Ids(kit).length;
          assert.equal(inBrevo + inKit, 1, `brevo=${inBrevo} kit=${inKit}`);
          assert.equal(inKit, owner === "kit" ? 1 : 0);
          if (!enabled) assert.equal(inKit, 0, "switch desligado: Kit não planeja nada");
          // Sem proveniência gravada: seed e legado são da Brevo. Com proveniência,
          // ela manda (a semeadura grava "brevo", #9015).
          if (tr === undefined || !enabled) assert.equal(owner, "brevo", "seed/legado sem proveniência (ou switch off) são da Brevo");
        });
      }
    }
  }
});

describe("#7922 (fleet review da PR #10607, item G2/G3) — executor real", () => {
  it("rollback: --send com kit_transport.enabled=false e entrada Kit em D+10 → nenhum broadcast (exit 2; com --skip-if-disabled, exit 0)", async () => {
    const t = setup({ "601": d10Entry("601", { email1_transport: "kit" }) });
    try {
      const cfgPath = t.args[t.args.indexOf("--config") + 1];
      writeFileSync(cfgPath, JSON.stringify({ publishing: { newsletter: { subscriber_backend: "kit" } }, onboarding: { kit_transport: { enabled: false } } }));
      await withMock({}, async ({ url, hits, createdSendAt }) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        const r2 = await runExecutor([...t.args, "--skip-if-disabled"], url);
        assert.equal(r2.status, 0, `stdout: ${r2.stdout} stderr: ${r2.stderr}`);
        assert.match(r2.stdout, /rollback/);
        assert.equal(createdSendAt.length, 0);
        assert.equal(hits.length, 0, "nenhuma chamada ao Kit");
        assert.equal(t.readStore().entries["601"].email3_state, "pending");
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("schedule_failed pelo caminho real: PATCH não agenda + DELETE 500 → lote schedule_failed, entry volta a pending e é replanejada na rodada seguinte", async () => {
    const t = setup({ "601": d10Entry("601") });
    try {
      const opts: MockOpts = { patchNoSchedule: "firstBroadcast", deleteHttpStatus: 500 };
      await withMock(opts, async ({ url, createdSendAt }) => {
        const r = await runExecutor(t.args, url);
        assert.equal(r.status, 1, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        const s1 = t.readStore();
        const lot = Object.values(s1.kit_transport.lots as Record<string, OnboardingKitLot>)[0]!;
        assert.equal(lot.status, "created");
        assert.equal(lot.schedule_failed, true);
        assert.equal(s1.entries["601"].email3_state, "pending", "entrada não fica presa em campaign_created");

        opts.deleteHttpStatus = undefined;
        const r2 = await runExecutor(t.args, url);
        assert.equal(r2.status, 0, `stdout: ${r2.stdout} stderr: ${r2.stderr}`);
        assert.equal(createdSendAt.length, 2, "replanejada num lote novo");
        const s2 = t.readStore();
        const lots = Object.values(s2.kit_transport.lots as Record<string, OnboardingKitLot>);
        assert.ok(lots.some((l) => l.status === "scheduled"));
        assert.equal(s2.entries["601"].email3_state, "campaign_created");
      });
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});

