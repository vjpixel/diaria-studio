/**
 * test/studio-onboarding-kit-lots-7922.test.ts (#7922, §3 de
 * docs/onboarding-kit-cutover.md — "Painel do Studio (`/assinantes`) mostrando
 * os lotes Kit corretamente para pelo menos 1 ciclo completo em dry-run")
 *
 * Antes deste PR o painel não listava lote Kit nenhum (só o e-mail 3 via
 * `staleDrafts`), não dizia por qual transporte o e-mail 1/2 saiu (o §3 manda
 * conferir `provider: "kit"` depois do flip) e, se um lote/entrada de PILOTO
 * (`onboarding-pilot-*`, `pilot:*`) aparecesse no store, ele entrava no funil
 * de produção misturado.
 *
 * O ciclo é real: o executor `onboarding-kit-transport-run.ts` roda como
 * subprocesso sobre um store temporário (Kit inalcançável — porta 1, sem
 * rede), primeiro em dry-run (não pode gravar NADA) e depois com `--send` e
 * kill switch ligado só no config temporário (grava `last_send_run`, sem
 * criar lote porque o refresh falha → ninguém elegível). O painel é lido
 * depois de cada passo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { OnboardingEntry } from "../scripts/lib/onboarding-store.ts";
import type { OnboardingKitLot } from "../scripts/lib/onboarding-kit-transport.ts";
import { buildOnboardingFunnelData, buildKitLotsView, isPilotKitLot } from "../scripts/studio-ui/studio-onboarding.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_STORE_PATH = resolve(ROOT, "data/onboarding/store.json");

function fingerprintRealStore(): string | null {
  if (!existsSync(REAL_STORE_PATH)) return null;
  return `${statSync(REAL_STORE_PATH).size}:${createHash("sha256").update(readFileSync(REAL_STORE_PATH)).digest("hex")}`;
}

const NOW_MS = Date.now();
const iso = (daysAgo: number) => new Date(NOW_MS - daysAgo * 86_400_000).toISOString();
const sec = (daysAgo: number) => Math.floor((NOW_MS - daysAgo * 86_400_000) / 1000);

function entry(id: string, overrides: Partial<OnboardingEntry> = {}): OnboardingEntry {
  return {
    subscription_id: id,
    email: `${id.replace(/[^a-z0-9]/gi, "")}@example.com`,
    status_detectado: "active",
    created_at: sec(12),
    detected_at: iso(12),
    email1_sent_at: null,
    email1_brevo_id: null,
    email2_sent_at: null,
    email2_brevo_id: null,
    email3_state: "pending",
    email3_campaign_id: null,
    email3_decided_at: null,
    ...overrides,
  };
}

function lot(overrides: Partial<OnboardingKitLot> & Pick<OnboardingKitLot, "lot_id" | "kind">): OnboardingKitLot {
  return {
    tag_name: `onboarding-${overrides.lot_id}`,
    tag_id: 10,
    broadcast_id: 900,
    recipient_subscription_ids: [],
    recipient_emails: [],
    status: "completed",
    created_at: iso(5),
    send_at: iso(5),
    last_reconciled_at: null,
    last_error: null,
    ...overrides,
  };
}

/** Store realista: escada Brevo legada, escada Kit (e-mail 1 + 2 por lote),
 *  e-mail 3 Kit em rascunho, um lote de produção com erro, e resíduo de
 *  piloto (lotes `onboarding-pilot-*` + entry sintética `pilot:*`). */
function realisticStore() {
  const e1Lot = lot({ lot_id: "email1-2026-09-24-01", kind: "email1", recipient_subscription_ids: ["2001"], recipient_emails: ["k1@example.com"], created_at: iso(7) });
  const e2Lot = lot({ lot_id: "email2-2026-09-27-01", kind: "email2", recipient_subscription_ids: ["2001"], recipient_emails: ["k1@example.com"], created_at: iso(4) });
  const e3Lot = lot({
    lot_id: "email3-2026-09-28-01",
    kind: "email3",
    status: "created",
    send_at: null,
    recipient_subscription_ids: ["2002"],
    recipient_emails: ["k2@example.com"],
    created_at: iso(3),
  });
  const failedLot = lot({
    lot_id: "email1-2026-09-30-01",
    kind: "email1",
    status: "pending",
    broadcast_id: null,
    tag_id: null,
    send_at: null,
    recipient_subscription_ids: ["2003"],
    recipient_emails: ["k3@example.com"],
    created_at: iso(1),
    last_error: "Kit API 422 ao taguear k3@example.com",
  });
  const pilotLots = (["email1", "email2", "email3"] as const).map((kind) =>
    lot({
      lot_id: `${kind}-2026-09-30-01p`,
      kind,
      tag_name: `onboarding-pilot-${kind}-2026-09-30-01`,
      recipient_subscription_ids: ["pilot:editor@example.com"],
      recipient_emails: ["editor@example.com"],
      created_at: iso(1),
    }),
  );
  const entries: Record<string, OnboardingEntry> = {
    "1001": entry("1001", { email1_sent_at: iso(11), email1_brevo_id: "brevo-1", email1_transport: "brevo", email2_sent_at: iso(8), email2_brevo_id: "brevo-2" }),
    "2001": entry("2001", { email1_sent_at: iso(7), email1_transport: "kit", email1_kit_lot_id: e1Lot.lot_id, email2_sent_at: iso(4), email2_kit_lot_id: e2Lot.lot_id }),
    "2002": entry("2002", {
      created_at: sec(14),
      detected_at: iso(14),
      email1_sent_at: iso(14),
      email1_transport: "kit",
      email1_kit_lot_id: "email1-2026-09-17-01",
      email2_sent_at: iso(11),
      email2_kit_lot_id: "email2-2026-09-20-01",
      email3_state: "campaign_created",
      email3_kit_lot_id: e3Lot.lot_id,
      email3_decided_at: iso(3),
    }),
    "2003": entry("2003", { created_at: sec(1), detected_at: iso(1) }),
    "pilot:editor@example.com": entry("pilot:editor@example.com", { email: "editor@example.com", email1_sent_at: iso(1), email1_transport: "kit", email1_kit_lot_id: pilotLots[0]!.lot_id }),
  };
  const lots: Record<string, OnboardingKitLot> = {};
  for (const l of [e1Lot, e2Lot, e3Lot, failedLot, ...pilotLots]) lots[l.lot_id] = l;
  return {
    version: 1,
    last_detection_cursor: sec(0),
    last_detection_backend: "kit",
    d10_brevo_list_id: null,
    consecutive_zero_detections: 0,
    last_zero_detection_run_at: iso(0),
    entries,
    kit_transport: { lots },
  };
}

function runExecutor(args: string[], configPath: string, storePath: string, snippetsDir: string) {
  return spawnSync(
    "npx",
    ["tsx", resolve(ROOT, "scripts/onboarding-kit-transport-run.ts"), "--config", configPath, "--store", storePath, "--snippets-dir", snippetsDir, ...args],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, KIT_API_KEY: "fixture_fake_kit_key_do_not_use", KIT_API_URL: "http://127.0.0.1:1" },
      shell: process.platform === "win32",
      timeout: 60_000,
    },
  );
}

function assertPanel(root: string) {
  const data = buildOnboardingFunnelData(root, { apoiadores: [] });
  assert.equal(data.db.available, true);

  // Piloto separado: fora do funil e da lista de produção, identificado à parte.
  assert.equal(data.kitLots.pilotEntriesExcluded, 1);
  assert.equal(data.summary.total, 4, "entry sintética de piloto não entra no funil de produção");
  assert.ok(data.entries.every((e) => !e.subscriptionId.startsWith("pilot:")));
  assert.deepEqual(
    data.kitLots.pilot.map((l) => l.lotId).sort(),
    ["email1-2026-09-30-01p", "email2-2026-09-30-01p", "email3-2026-09-30-01p"],
  );
  assert.ok(data.kitLots.pilot.every((l) => l.pilot && l.tagName.startsWith("onboarding-pilot-")));
  assert.ok(data.kitLots.production.every((l) => !l.pilot));
  assert.deepEqual(
    data.kitLots.production.map((l) => l.lotId),
    ["email1-2026-09-30-01", "email3-2026-09-28-01", "email2-2026-09-27-01", "email1-2026-09-24-01"],
    "produção, mais novo primeiro",
  );

  // Lote com erro: status pendente, erro visível e sem e-mail cru.
  const failed = data.kitLots.production[0]!;
  assert.equal(failed.status, "pending");
  assert.equal(failed.broadcastId, null);
  assert.equal(failed.recipients, 1);
  assert.ok(failed.lastError && failed.lastError.includes("Kit API 422"));
  assert.ok(!failed.lastError!.includes("k3@example.com"), "último erro com e-mail mascarado");

  // Proveniência por etapa (o que o §3 manda conferir depois do flip).
  const byId = new Map(data.entries.map((e) => [e.subscriptionId, e]));
  assert.equal(byId.get("1001")!.email1.provider, "brevo");
  assert.equal(byId.get("2001")!.email1.provider, "kit");
  assert.equal(byId.get("2001")!.email1.kitLotId, "email1-2026-09-24-01");
  assert.equal(byId.get("2001")!.email2.provider, "kit");
  assert.equal(byId.get("2003")!.email1.provider, null);
  assert.deepEqual(data.summary.sentByProvider, { email1: { brevo: 1, kit: 2 }, email2: { brevo: 1, kit: 2 } });

  // E-mail 3 Kit em rascunho, resolvido pelo lote de PRODUÇÃO.
  assert.equal(byId.get("2002")!.email3.stage, "rascunho_criado");
  assert.equal(byId.get("2002")!.email3.provider, "kit");
  return data;
}

describe("#7922 — painel /assinantes mostra os lotes Kit num ciclo do executor", () => {
  it("dry-run não grava nada e o painel mostra produção/piloto separados; --send registra a rodada no painel", () => {
    const realBefore = fingerprintRealStore();
    const root = mkdtempSync(join(tmpdir(), "studio-onboarding-kit-lots-"));
    try {
      mkdirSync(join(root, "data", "onboarding"), { recursive: true });
      const storePath = join(root, "data", "onboarding", "store.json");
      writeFileSync(storePath, JSON.stringify(realisticStore(), null, 2) + "\n");
      const configPath = join(root, "platform.config.json");
      const snippetsDir = join(root, "snippets");
      mkdirSync(snippetsDir, { recursive: true });
      for (const n of [1, 2, 3]) {
        writeFileSync(join(snippetsDir, `onboarding-${n}.md`), `<!-- assunto: "assunto ${n}" preview_text: "preview ${n}" -->\nCorpo ${n}.\n`);
      }

      // 1) Ciclo dry-run — kill switch DESLIGADO, como está em produção hoje.
      writeFileSync(configPath, JSON.stringify({ publishing: { newsletter: { subscriber_backend: "kit" } }, onboarding: { kit_transport: { enabled: false } } }));
      const before = readFileSync(storePath, "utf8");
      const dry = runExecutor([], configPath, storePath, snippetsDir);
      assert.equal(dry.status, 0, `dry-run deveria sair 0. stdout: ${dry.stdout} stderr: ${dry.stderr}`);
      assert.equal(JSON.parse(dry.stdout).mode, "dry-run");
      assert.equal(readFileSync(storePath, "utf8"), before, "dry-run não pode gravar o store (nem last_send_run)");
      const afterDry = assertPanel(root);
      assert.equal(afterDry.kitLots.lastSendRun, null, "sem rodada --send registrada ainda");

      // 2) Rodada --send com o switch ligado SÓ no config temporário: Kit
      //    inalcançável → refresh de TODOS os candidatos falha → ninguém
      //    elegível → nenhum lote criado. A rodada fica registrada e conta
      //    como FALHA de entrega (isFailedKitSendRun) — sem isso um Kit fora
      //    do ar pareceria uma rodada saudável "0 lotes, 0 falhas".
      writeFileSync(configPath, JSON.stringify({ publishing: { newsletter: { subscriber_backend: "kit" } }, onboarding: { kit_transport: { enabled: true } } }));
      const send = runExecutor(["--send"], configPath, storePath, snippetsDir);
      assert.equal(send.status, 0, `--send deveria sair 0. stdout: ${send.stdout} stderr: ${send.stderr}`);
      const summary = JSON.parse(send.stdout);
      assert.equal(summary.mode, "SEND");
      assert.deepEqual({ c: summary.send_run.lots_created, f: summary.send_run.lots_failed }, { c: 0, f: 0 });
      assert.ok(summary.send_run.refresh_candidates > 0, `esperava candidatos a refresh: ${send.stdout}`);
      assert.equal(summary.send_run.refresh_failed, summary.send_run.refresh_candidates);
      const afterSend = assertPanel(root);
      assert.ok(afterSend.kitLots.lastSendRun, "rodada --send aparece no painel");
      assert.equal(afterSend.kitLots.lastSendRun!.lots_created, 0);
      assert.equal(afterSend.kitLots.consecutiveFailedSendRuns, 1, "Kit inalcançável conta como rodada falha");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    assert.equal(fingerprintRealStore(), realBefore, "store real de produção intocado");
  });

  it("isPilotKitLot reconhece pelos dois sinais (tag OU destinatário sintético)", () => {
    const base = lot({ lot_id: "email1-2026-10-01-01", kind: "email1", recipient_subscription_ids: ["1"] });
    assert.equal(isPilotKitLot(base), false);
    assert.equal(isPilotKitLot({ ...base, tag_name: "onboarding-pilot-email1-2026-10-01-01" }), true);
    assert.equal(isPilotKitLot({ ...base, recipient_subscription_ids: ["pilot:x@example.com"] }), true);
    const view = buildKitLotsView([base], 0, undefined);
    assert.equal(view.lastSendRun, null);
    assert.equal(view.consecutiveFailedSendRuns, 0);
  });
});
