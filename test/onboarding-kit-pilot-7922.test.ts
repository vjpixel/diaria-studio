/**
 * test/onboarding-kit-pilot-7922.test.ts (#7922 — piloto supervisionado)
 *
 * Trava os guards do MODO PILOTO de `scripts/onboarding-kit-transport-run.ts`
 * (`scripts/lib/onboarding-kit-pilot.ts`): recusa do store real, recusa de
 * destinatário fora da allowlist, aborto em tag vazia/maior/estranha,
 * releitura do broadcast pós-criação (2xx não é prova, #6582) e o
 * rascunho-sempre do e-mail 3. Rede 100% injetada (fakes de `PilotKitDeps`)
 * — nenhum teste aqui toca a API do Kit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePilotRecipients,
  assertPilotStoreIsolated,
  seedPilotStore,
  selectPilotEntriesForKind,
  assertLotRecipientsInAllowlist,
  checkPilotTagMembers,
  verifyPilotBroadcastFilter,
  runPilotLot,
  assertPilotEmail3Approvable,
  buildPilotLotTagName,
  PILOT_MAX_RECIPIENTS,
  type PilotKitDeps,
} from "../scripts/lib/onboarding-kit-pilot.ts";
import { buildTagFilter, type CreateBroadcastInput } from "../scripts/lib/kit-broadcasts.ts";
import { emptyStore, readStore } from "../scripts/lib/onboarding-store.ts";
import type { OnboardingKitLot } from "../scripts/lib/onboarding-kit-transport.ts";
import { claimLot, seedPilotStoreOnDisk } from "../scripts/onboarding-kit-transport-run.ts";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_STORE_PATH = resolve(__ROOT, "data/onboarding/store.json");
const EDITOR = "editor@example.com";

function fingerprint(p: string): string | null {
  if (!existsSync(p)) return null;
  return `${statSync(p).size}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
}

function pilotLot(over: Partial<OnboardingKitLot> = {}): OnboardingKitLot {
  return {
    lot_id: "email1-2026-09-30-01",
    kind: "email1",
    tag_name: buildPilotLotTagName("email1-2026-09-30-01"),
    tag_id: null,
    broadcast_id: null,
    recipient_subscription_ids: [`pilot:${EDITOR}`],
    recipient_emails: [EDITOR],
    status: "pending",
    created_at: new Date().toISOString(),
    send_at: null,
    last_reconciled_at: null,
    last_error: null,
    ...over,
  };
}

interface FakeOpts {
  preexistingTagId?: number | null;
  /** Sequência de releituras da tag; a última se repete. */
  memberReads?: string[][];
  resolvedTagIdAfterCreate?: number | null;
  rereadFilter?: unknown | "echo";
  updateStatus?: string;
}

function fakeDeps(o: FakeOpts = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  let created = false;
  let readIdx = 0;
  const reads = o.memberReads ?? [[EDITOR]];
  let lastInput: CreateBroadcastInput | null = null;
  const deps: PilotKitDeps = {
    async findTagIdByName(name) {
      calls.push({ name: "findTagIdByName", args: [name] });
      if (!created) return o.preexistingTagId ?? null;
      return o.resolvedTagIdAfterCreate === undefined ? 77 : o.resolvedTagIdAfterCreate;
    },
    async createTag(name) {
      calls.push({ name: "createTag", args: [name] });
      created = true;
      return { id: 77 };
    },
    async tagSubscriber(tagId, subId) {
      calls.push({ name: "tagSubscriber", args: [tagId, subId] });
    },
    async listTagMemberEmails(tagId) {
      calls.push({ name: "listTagMemberEmails", args: [tagId] });
      const r = reads[Math.min(readIdx, reads.length - 1)];
      readIdx++;
      return r;
    },
    async createBroadcast(input) {
      calls.push({ name: "createBroadcast", args: [input] });
      lastInput = input;
      return { id: 900, status: "draft", send_at: null };
    },
    async getBroadcast(id) {
      calls.push({ name: "getBroadcast", args: [id] });
      if (o.rereadFilter === undefined || o.rereadFilter === "echo") return { subscriber_filter: lastInput?.subscriber_filter ?? buildTagFilter(77) };
      if (o.rereadFilter === null) return {};
      return { subscriber_filter: o.rereadFilter };
    },
    async updateBroadcast(id, patch) {
      calls.push({ name: "updateBroadcast", args: [id, patch] });
      return { status: o.updateStatus ?? "scheduled", send_at: patch.send_at };
    },
    async deleteBroadcast(id) {
      calls.push({ name: "deleteBroadcast", args: [id] });
    },
    async sleep() {
      calls.push({ name: "sleep", args: [] });
    },
  };
  const called = (n: string) => calls.filter((c) => c.name === n);
  return { deps, calls, called };
}

const baseOpts = {
  recipients: [EDITOR],
  kitIdBySubscription: { [`pilot:${EDITOR}`]: 555 },
  subject: "Assunto",
  content: "<p>corpo</p>",
  sendAt: "2026-09-30T20:00:00.000Z",
  allowUnechoedFilter: false,
  tagCheckAttempts: 3,
  tagCheckDelayMs: 0,
};

describe("piloto — argumentos e store isolado (#7922)", () => {
  it("parsePilotRecipients: normaliza/dedupe e recusa vazio, malformado e acima do teto", () => {
    assert.deepEqual(parsePilotRecipients(" Editor@Example.com, editor@example.com "), [EDITOR]);
    assert.throws(() => parsePilotRecipients(undefined), /--pilot-recipients/);
    assert.throws(() => parsePilotRecipients("  "), /--pilot-recipients/);
    assert.throws(() => parsePilotRecipients("nao-e-email"), /malformado/);
    const many = Array.from({ length: PILOT_MAX_RECIPIENTS + 1 }, (_, i) => `t${i}@example.com`).join(",");
    assert.throws(() => parsePilotRecipients(many), /no máximo/);
  });

  it("assertPilotStoreIsolated: recusa --store ausente e o store REAL; aceita um isolado", () => {
    assert.throws(() => assertPilotStoreIsolated(undefined, [REAL_STORE_PATH]), /--store/);
    assert.throws(() => assertPilotStoreIsolated(REAL_STORE_PATH, [REAL_STORE_PATH]), /store REAL/);
    // Mesmo arquivo por caminho relativo também é recusado.
    const rel = "data/onboarding/store.json";
    assert.throws(() => assertPilotStoreIsolated(rel, [resolve(rel)]), /store REAL/);
    const iso = join(tmpdir(), "pilot-store.json");
    assert.equal(assertPilotStoreIsolated(iso, [REAL_STORE_PATH]), resolve(iso));
  });

  it("seedPilotStore: recusa store com entry fora da allowlist (cópia do real); semeia idempotente", () => {
    const foreign = emptyStore();
    seedPilotStore(foreign, ["outro@example.com"], "2026-09-30T00:00:00Z");
    assert.throws(() => seedPilotStore(foreign, [EDITOR], "2026-09-30T00:00:00Z"), /fora de --pilot-recipients/);

    const s = emptyStore();
    assert.equal(seedPilotStore(s, [EDITOR], "2026-09-30T00:00:00Z"), 1);
    assert.equal(seedPilotStore(s, [EDITOR], "2026-09-30T00:00:00Z"), 0);
    const entry = s.entries[`pilot:${EDITOR}`];
    assert.equal(entry.seeded_by, undefined, "seeded_by excluiria da seleção");
    // Os 3 kinds são planejáveis no mesmo dia (sem cadência).
    for (const kind of ["email1", "email2", "email3"] as const) {
      assert.equal(selectPilotEntriesForKind(s, kind, [EDITOR]).length, 1);
    }
    // Lote confirmado de email1 tira só o email1 da seleção.
    s.kit_transport = { lots: { x: pilotLot({ broadcast_id: 1, status: "scheduled" }) } };
    assert.equal(selectPilotEntriesForKind(s, "email1", [EDITOR]).length, 0);
    assert.equal(selectPilotEntriesForKind(s, "email2", [EDITOR]).length, 1);
  });

  it("seedPilotStoreOnDisk + claimLot(tagNameFor): store isolado em disco, tag com prefixo de piloto", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-7922-pilot-"));
    const storePath = join(dir, "store.json");
    try {
      assert.equal(seedPilotStoreOnDisk(storePath, [EDITOR]), 1);
      const claim = claimLot(
        storePath,
        { lot_id: "email1-2026-09-30-01", kind: "email1", dateIso: "2026-09-30", tag_name: "onboarding-email1-2026-09-30-01", recipient_subscription_ids: [`pilot:${EDITOR}`], recipient_emails: [EDITOR] },
        Date.now(),
        buildPilotLotTagName,
      );
      assert.equal(claim.lot?.tag_name, "onboarding-pilot-email1-2026-09-30-01");
      assert.ok(readStore(storePath).store.kit_transport?.lots["email1-2026-09-30-01"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("piloto — guards de audiência (#7922, #6126, #6582)", () => {
  it("assertLotRecipientsInAllowlist: destinatário fora da allowlist aborta", () => {
    assert.throws(() => assertLotRecipientsInAllowlist([EDITOR, "x@example.com"], [EDITOR]), /fora de --pilot-recipients/);
    assert.throws(() => assertLotRecipientsInAllowlist([], [EDITOR]), /sem destinatários/);
    assert.doesNotThrow(() => assertLotRecipientsInAllowlist([EDITOR], [EDITOR]));
  });

  it("runPilotLot: destinatário fora da allowlist aborta ANTES de qualquer chamada ao Kit", async () => {
    const { deps, calls } = fakeDeps();
    const lot = pilotLot({ recipient_emails: [EDITOR, "intruso@example.com"], recipient_subscription_ids: [`pilot:${EDITOR}`, "pilot:intruso"] });
    await assert.rejects(runPilotLot(deps, lot, baseOpts), /fora de --pilot-recipients/);
    assert.equal(calls.length, 0);
  });

  it("checkPilotTagMembers: vazia é retentável; maior/estranho nunca", () => {
    assert.deepEqual(checkPilotTagMembers("t", [EDITOR], [EDITOR], [EDITOR]), { ok: true });
    const empty = checkPilotTagMembers("t", [], [EDITOR], [EDITOR]);
    assert.equal(empty.ok, false);
    assert.equal(!empty.ok && empty.retryable, true);
    const stranger = checkPilotTagMembers("t", [EDITOR, "x@example.com"], [EDITOR], [EDITOR]);
    assert.equal(!stranger.ok && stranger.retryable, false);
    const dup = checkPilotTagMembers("t", [EDITOR, EDITOR], [EDITOR], [EDITOR]);
    assert.equal(!dup.ok && dup.retryable, false);
  });

  it("runPilotLot: tag VAZIA na releitura (todas as tentativas) aborta sem criar broadcast", async () => {
    const { deps, called } = fakeDeps({ memberReads: [[]] });
    await assert.rejects(runPilotLot(deps, pilotLot(), baseOpts), /VAZIA/);
    assert.equal(called("listTagMemberEmails").length, 3, "retenta só por propagação");
    assert.equal(called("createBroadcast").length, 0);
  });

  it("runPilotLot: tag MAIOR que o lote aborta na 1ª releitura, sem retry e sem broadcast", async () => {
    const { deps, called } = fakeDeps({ memberReads: [[EDITOR, "base@example.com"]] });
    await assert.rejects(runPilotLot(deps, pilotLot(), baseOpts), /fora do lote\/allowlist/);
    assert.equal(called("listTagMemberEmails").length, 1);
    assert.equal(called("createBroadcast").length, 0);
  });

  it("runPilotLot: tag pré-existente aborta antes de criar/taguear", async () => {
    const { deps, called } = fakeDeps({ preexistingTagId: 12 });
    await assert.rejects(runPilotLot(deps, pilotLot(), baseOpts), /já existe no Kit/);
    assert.equal(called("createTag").length, 0);
    assert.equal(called("tagSubscriber").length, 0);
  });

  it("runPilotLot: tag que não resolve pro id do lote aborta (risco #6126)", async () => {
    const { deps, called } = fakeDeps({ resolvedTagIdAfterCreate: null });
    await assert.rejects(runPilotLot(deps, pilotLot(), baseOpts), /não resolve/);
    assert.equal(called("createBroadcast").length, 0);
  });

  it("runPilotLot: propagação (vazia → completa) passa após retry", async () => {
    const { deps } = fakeDeps({ memberReads: [[], [EDITOR]] });
    const res = await runPilotLot(deps, pilotLot(), baseOpts);
    assert.equal(res.status, "scheduled");
  });

  it("runPilotLot (email1): nasce rascunho, relê o filtro e só então agenda", async () => {
    const { deps, calls } = fakeDeps();
    const lot = pilotLot();
    const res = await runPilotLot(deps, lot, baseOpts);
    const create = calls.find((c) => c.name === "createBroadcast")!.args[0] as CreateBroadcastInput;
    assert.equal(create.send_at, null, "piloto cria SEMPRE rascunho");
    assert.equal(create.public, false);
    assert.deepEqual(create.subscriber_filter, buildTagFilter(77));
    const order = calls.map((c) => c.name);
    assert.ok(order.indexOf("getBroadcast") < order.indexOf("updateBroadcast"), "releitura antes de agendar");
    assert.deepEqual(res, { broadcast_id: 900, status: "scheduled", send_at: baseOpts.sendAt, filter_verified: true });
    assert.equal(lot.broadcast_id, 900);
    assert.equal(lot.tag_id, 77);
  });

  it("runPilotLot: filtro relido DIVERGENTE apaga o rascunho e nunca agenda", async () => {
    const { deps, called } = fakeDeps({ rereadFilter: [] });
    const lot = pilotLot();
    await assert.rejects(runPilotLot(deps, lot, baseOpts), /DIVERGENTE/);
    assert.equal(called("deleteBroadcast").length, 1);
    assert.equal(called("updateBroadcast").length, 0);
    assert.equal(lot.status, "cancelled");
    assert.equal(lot.broadcast_id, 900, "registro do broadcast preservado pro store");
  });

  it("runPilotLot: filtro NÃO ecoado mantém rascunho e aborta, salvo --pilot-allow-unechoed-filter", async () => {
    const a = fakeDeps({ rereadFilter: null });
    const lot = pilotLot();
    await assert.rejects(runPilotLot(a.deps, lot, baseOpts), /NÃO confirmada/);
    assert.equal(a.called("updateBroadcast").length, 0);
    assert.equal(a.called("deleteBroadcast").length, 0);
    assert.equal(lot.status, "created");

    const b = fakeDeps({ rereadFilter: null });
    const res = await runPilotLot(b.deps, pilotLot(), { ...baseOpts, allowUnechoedFilter: true });
    assert.equal(res.status, "scheduled");
    assert.equal(res.filter_verified, null);
  });

  it("verifyPilotBroadcastFilter: igual/divergente/ausente", () => {
    assert.deepEqual(verifyPilotBroadcastFilter(buildTagFilter(5), buildTagFilter(5)), { verified: true });
    assert.equal(verifyPilotBroadcastFilter(buildTagFilter(6), buildTagFilter(5)).verified, false);
    assert.equal(verifyPilotBroadcastFilter(undefined, buildTagFilter(5)).verified, null);
  });

  it("runPilotLot (email3): fica rascunho, nunca chama updateBroadcast", async () => {
    const { deps, called } = fakeDeps();
    const lot = pilotLot({ kind: "email3", lot_id: "email3-2026-09-30-01", tag_name: buildPilotLotTagName("email3-2026-09-30-01") });
    const res = await runPilotLot(deps, lot, baseOpts);
    assert.equal(res.status, "created");
    assert.equal(res.send_at, null);
    assert.equal(called("updateBroadcast").length, 0);
  });

  it("assertPilotEmail3Approvable: tag que cresceu desde a criação bloqueia o agendamento", async () => {
    const lot = pilotLot({ kind: "email3", tag_id: 77, broadcast_id: 900, status: "created" });
    const bad = fakeDeps({ preexistingTagId: 77, memberReads: [[EDITOR, "x@example.com"]] });
    await assert.rejects(assertPilotEmail3Approvable(bad.deps, lot, [EDITOR], false), /fora do lote/);
    const ok = fakeDeps({ preexistingTagId: 77 });
    await assert.doesNotReject(assertPilotEmail3Approvable(ok.deps, lot, [EDITOR], false));
  });
});

describe("piloto — CLI recusa o store real antes de qualquer rede (#7922)", () => {
  function run(args: string[]) {
    const env = { ...process.env, KIT_API_KEY: "fixture_fake_kit_key_do_not_use" };
    return spawnSync("npx", ["tsx", resolve(__ROOT, "scripts/onboarding-kit-transport-run.ts"), ...args], {
      cwd: __ROOT,
      encoding: "utf8",
      env,
      shell: process.platform === "win32",
      timeout: 60_000,
    });
  }

  it("--pilot --store <store real> sai 2 e não toca o store", () => {
    const before = fingerprint(REAL_STORE_PATH);
    const r = run(["--pilot", "--pilot-recipients", EDITOR, "--store", REAL_STORE_PATH, "--send"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /store REAL/);
    assert.equal(fingerprint(REAL_STORE_PATH), before);
  });

  it("--pilot sem --store sai 2", () => {
    const r = run(["--pilot", "--pilot-recipients", EDITOR]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--store/);
  });

  it("--pilot-recipients sem --pilot sai 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-7922-pilot-cli-"));
    try {
      writeFileSync(join(dir, "store.json"), JSON.stringify(emptyStore()));
      const r = run(["--pilot-recipients", EDITOR, "--store", join(dir, "store.json")]);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /só valem com --pilot/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
