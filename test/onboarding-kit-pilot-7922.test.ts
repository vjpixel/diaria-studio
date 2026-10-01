/**
 * test/onboarding-kit-pilot-7922.test.ts (#7922 — piloto supervisionado)
 *
 * Trava os guards do MODO PILOTO de `scripts/onboarding-kit-transport-run.ts`
 * (`scripts/lib/onboarding-kit-pilot.ts` + `runPilotPlan`): recusa do store
 * real, allowlist, tag vazia/maior/estranha/id divergente, releitura do
 * broadcast antes E depois do PATCH que agenda (2xx não é prova, #6582;
 * PATCH pode zerar campo omitido, #8208), leitura falha nunca agenda,
 * status ≠ scheduled é falha, persistência do lote no `finally`. Rede 100%
 * injetada — nenhum teste aqui toca a API do Kit.
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
  assertPilotCancelable,
  checkPilotTagMembers,
  verifyPilotBroadcastFilter,
  runPilotLot,
  approvePilotEmail3Lot,
  buildPilotLotTagName,
  redactEmails,
  PILOT_MAX_RECIPIENTS,
  type PilotKitDeps,
  type PilotLotOptions,
} from "../scripts/lib/onboarding-kit-pilot.ts";
import { buildTagFilter, type CreateBroadcastInput } from "../scripts/lib/kit-broadcasts.ts";
import { emptyStore, readStore, writeStore } from "../scripts/lib/onboarding-store.ts";
import type { OnboardingKitLot } from "../scripts/lib/onboarding-kit-transport.ts";
import {
  claimLot,
  persistLotUpdate,
  seedPilotStoreOnDisk,
  runPilotPlan,
  isWriteBlockedByKillSwitch,
  readPendingBroadcastSidecar,
  type PilotPlanDeps,
} from "../scripts/onboarding-kit-transport-run.ts";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_STORE_PATH = resolve(__ROOT, "data/onboarding/store.json");
const EDITOR = "editor@example.com";
const TAG_ID = 77;

function fingerprint(p: string): string | null {
  if (!existsSync(p)) return null;
  return `${statSync(p).size}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
}

function pilotLot(over: Partial<OnboardingKitLot> = {}): OnboardingKitLot {
  const lotId = over.lot_id ?? "email1-2026-09-30-01";
  return {
    lot_id: lotId,
    kind: "email1",
    tag_name: buildPilotLotTagName(lotId),
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

type FilterMode = "echo" | "absent" | "throw" | unknown;

interface FakeOpts {
  preexistingTagId?: number | null;
  /** Resoluções sucessivas de findTagIdByName depois do createTag (a última repete). */
  tagResolutions?: (number | null)[];
  /** Releituras sucessivas da lista de membros (a última repete). */
  memberReads?: string[][];
  preFilter?: FilterMode;
  postFilter?: FilterMode;
  updateStatus?: string;
  postStatus?: string;
  deleteThrows?: boolean;
  /** PATCH lança: "applied" = o Kit aplicou mesmo assim; "not_applied" = não aplicou. */
  updateThrows?: "applied" | "not_applied";
}

function fakeDeps(o: FakeOpts = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const warnings: string[] = [];
  const createdTags = new Set<string>();
  let resIdx = 0;
  let readIdx = 0;
  let patched = false;
  const reads = o.memberReads ?? [[EDITOR]];
  const resolutions = o.tagResolutions ?? [TAG_ID];
  const filterFor = (mode: FilterMode) => {
    if (mode === undefined || mode === "echo") return { subscriber_filter: buildTagFilter(TAG_ID) };
    if (mode === "absent") return {};
    if (mode === "throw") throw new Error("Kit API /broadcasts/900 -> 500: erro pra editor@example.com");
    return { subscriber_filter: mode };
  };
  const deps: PilotKitDeps = {
    async findTagIdByName(name) {
      calls.push({ name: "findTagIdByName", args: [name] });
      if (!createdTags.has(name)) return o.preexistingTagId ?? null;
      const r = resolutions[Math.min(resIdx, resolutions.length - 1)];
      resIdx++;
      return r;
    },
    async createTag(name) {
      calls.push({ name: "createTag", args: [name] });
      createdTags.add(name);
      return { id: TAG_ID };
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
      return { id: 900, status: "draft", send_at: null };
    },
    async getBroadcast(id) {
      calls.push({ name: "getBroadcast", args: [id] });
      if (!patched) return { status: "draft", send_at: null, ...filterFor(o.preFilter) };
      return { status: o.postStatus ?? o.updateStatus ?? "scheduled", send_at: "2026-09-30T20:05:00.000Z", ...filterFor(o.postFilter) };
    },
    async updateBroadcast(id, patch) {
      calls.push({ name: "updateBroadcast", args: [id, patch] });
      if (o.updateThrows === "applied") {
        patched = true;
        throw new Error("timeout");
      }
      if (o.updateThrows === "not_applied") throw new Error("ECONNRESET");
      patched = true;
      return { status: o.updateStatus ?? "scheduled", send_at: patch.send_at };
    },
    async deleteBroadcast(id) {
      calls.push({ name: "deleteBroadcast", args: [id] });
      if (o.deleteThrows) throw new Error("Kit API -> 500");
    },
    async sleep() {
      calls.push({ name: "sleep", args: [] });
    },
    warn(msg) {
      warnings.push(msg);
    },
  };
  const called = (n: string) => calls.filter((c) => c.name === n);
  return { deps, calls, called, warnings };
}

const baseOpts: PilotLotOptions = {
  recipients: [EDITOR],
  kitIdBySubscription: { [`pilot:${EDITOR}`]: 555 },
  subject: "Assunto",
  content: "<p>corpo</p>",
  sendAtFn: () => "2026-09-30T20:00:00.000Z",
  allowUnechoedFilter: false,
  tagCheckAttempts: 3,
  tagCheckDelayMs: 0,
};

describe("piloto — argumentos, store isolado e kill switch (#7922)", () => {
  it("parsePilotRecipients: normaliza/dedupe e recusa vazio, malformado e acima do teto", () => {
    assert.deepEqual(parsePilotRecipients(" Editor@Example.com, editor@example.com "), [EDITOR]);
    assert.throws(() => parsePilotRecipients(undefined), /--pilot-recipients/);
    assert.throws(() => parsePilotRecipients("  "), /--pilot-recipients/);
    assert.throws(() => parsePilotRecipients("nao-e-email"), /malformado/);
    const many = Array.from({ length: PILOT_MAX_RECIPIENTS + 1 }, (_, i) => `t${i}@example.com`).join(",");
    assert.throws(() => parsePilotRecipients(many), /no máximo/);
  });

  it("assertPilotStoreIsolated: recusa --store ausente e o store REAL (relativo/caixa diferente); aceita isolado", () => {
    assert.throws(() => assertPilotStoreIsolated(undefined, [REAL_STORE_PATH]), /--store/);
    assert.throws(() => assertPilotStoreIsolated(REAL_STORE_PATH, [REAL_STORE_PATH]), /store REAL/);
    const rel = "data/onboarding/store.json";
    assert.throws(() => assertPilotStoreIsolated(rel, [resolve(rel)]), /store REAL/);
    if (process.platform === "win32") {
      assert.throws(() => assertPilotStoreIsolated(REAL_STORE_PATH.toUpperCase(), [REAL_STORE_PATH]), /store REAL/);
    }
    const iso = join(tmpdir(), "pilot-store.json");
    assert.equal(assertPilotStoreIsolated(iso, [REAL_STORE_PATH]), resolve(iso));
  });

  it("kill switch: escrita sem --pilot continua bloqueada com o switch off; --pilot passa", () => {
    assert.equal(isWriteBlockedByKillSwitch(true, false, false), true);
    assert.equal(isWriteBlockedByKillSwitch(true, undefined, false), true);
    assert.equal(isWriteBlockedByKillSwitch(true, true, false), false);
    assert.equal(isWriteBlockedByKillSwitch(false, false, false), false);
    assert.equal(isWriteBlockedByKillSwitch(true, false, true), false);
  });

  it("seedPilotStore: recusa store com entry fora da allowlist (cópia do real); semeia idempotente", () => {
    const foreign = emptyStore();
    seedPilotStore(foreign, ["outro@example.com"], "2026-09-30T00:00:00Z");
    assert.throws(() => seedPilotStore(foreign, [EDITOR], "2026-09-30T00:00:00Z"), /fora de --pilot-recipients/);

    const s = emptyStore();
    assert.equal(seedPilotStore(s, [EDITOR], "2026-09-30T00:00:00Z"), 1);
    assert.equal(seedPilotStore(s, [EDITOR], "2026-09-30T00:00:00Z"), 0);
    assert.equal(s.entries[`pilot:${EDITOR}`].seeded_by, undefined, "seeded_by excluiria da seleção");
    for (const kind of ["email1", "email2", "email3"] as const) {
      assert.equal(selectPilotEntriesForKind(s, kind, [EDITOR]).length, 1);
    }
    s.kit_transport = { lots: { x: pilotLot({ broadcast_id: 1, status: "scheduled" }) } };
    assert.equal(selectPilotEntriesForKind(s, "email1", [EDITOR]).length, 0);
    assert.equal(selectPilotEntriesForKind(s, "email2", [EDITOR]).length, 1);
  });

  it("claimLot(tagNameFor): tag com prefixo de piloto no store isolado", () => {
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertPilotCancelable: recusa lote sem prefixo de piloto ou com destinatário fora da allowlist", () => {
    assert.throws(() => assertPilotCancelable(pilotLot({ tag_name: "onboarding-email1-2026-09-30-01" }), [EDITOR]), /não é lote do piloto/);
    assert.throws(() => assertPilotCancelable(pilotLot({ recipient_emails: ["x@example.com"] }), [EDITOR]), /fora de --pilot-recipients/);
    assert.doesNotThrow(() => assertPilotCancelable(pilotLot(), [EDITOR]));
  });

  it("redactEmails: tira e-mail de mensagem de erro (summary vai pra issue)", () => {
    assert.equal(redactEmails("Kit API -> 422: subscriber Foo.Bar+x@mail.example.com.br inválido"), "Kit API -> 422: subscriber <email> inválido");
  });
});

describe("piloto — guards de tag (#7922, #6126)", () => {
  it("assertLotRecipientsInAllowlist: destinatário fora da allowlist aborta", () => {
    assert.throws(() => assertLotRecipientsInAllowlist([EDITOR, "x@example.com"], [EDITOR]), /fora de --pilot-recipients/);
    assert.throws(() => assertLotRecipientsInAllowlist([], [EDITOR]), /sem destinatários/);
  });

  it("runPilotLot: destinatário fora da allowlist aborta ANTES de qualquer chamada ao Kit", async () => {
    const { deps, calls } = fakeDeps();
    const lot = pilotLot({ recipient_emails: [EDITOR, "intruso@example.com"], recipient_subscription_ids: [`pilot:${EDITOR}`, "pilot:intruso"] });
    await assert.rejects(runPilotLot(deps, lot, baseOpts), /fora de --pilot-recipients/);
    assert.equal(calls.length, 0);
  });

  it("runPilotLot: lote sem prefixo de piloto aborta antes de qualquer chamada", async () => {
    const { deps, calls } = fakeDeps();
    await assert.rejects(runPilotLot(deps, pilotLot({ tag_name: "onboarding-email1-x" }), baseOpts), /não é lote do piloto/);
    assert.equal(calls.length, 0);
  });

  it("checkPilotTagMembers: vazia é retentável; maior/estranho nunca", () => {
    assert.deepEqual(checkPilotTagMembers("t", [EDITOR], [EDITOR], [EDITOR]), { ok: true });
    const empty = checkPilotTagMembers("t", [], [EDITOR], [EDITOR]);
    assert.equal(!empty.ok && empty.retryable, true);
    const stranger = checkPilotTagMembers("t", [EDITOR, "x@example.com"], [EDITOR], [EDITOR]);
    assert.equal(!stranger.ok && stranger.retryable, false);
  });

  it("tag VAZIA em todas as releituras aborta sem criar broadcast", async () => {
    const { deps, called } = fakeDeps({ memberReads: [[]] });
    await assert.rejects(runPilotLot(deps, pilotLot(), baseOpts), /VAZIA/);
    assert.equal(called("listTagMemberEmails").length, 3);
    assert.equal(called("createBroadcast").length, 0);
  });

  it("tag MAIOR que o lote aborta na 1ª releitura, sem retry e sem broadcast", async () => {
    const { deps, called } = fakeDeps({ memberReads: [[EDITOR, "base@example.com"]] });
    await assert.rejects(runPilotLot(deps, pilotLot(), baseOpts), /fora do lote\/allowlist/);
    assert.equal(called("listTagMemberEmails").length, 1);
    assert.equal(called("createBroadcast").length, 0);
  });

  it("tag pré-existente (lote novo) aborta antes de criar/taguear", async () => {
    const { deps, called } = fakeDeps({ preexistingTagId: 12 });
    await assert.rejects(runPilotLot(deps, pilotLot(), baseOpts), /já existe no Kit/);
    assert.equal(called("createTag").length, 0);
    assert.equal(called("tagSubscriber").length, 0);
  });

  it("busca por nome que ainda não vê a tag nova (propagação ~90s) RETENTA em vez de abortar", async () => {
    const { deps, called } = fakeDeps({ tagResolutions: [null, null, TAG_ID] });
    const res = await runPilotLot(deps, pilotLot(), baseOpts);
    assert.equal(res.status, "scheduled");
    assert.equal(called("sleep").length, 2);
  });

  it("busca por nome que resolve pra OUTRO id aborta na hora (risco #6126)", async () => {
    const { deps, called } = fakeDeps({ tagResolutions: [999] });
    await assert.rejects(runPilotLot(deps, pilotLot(), baseOpts), /OUTRO id/);
    assert.equal(called("createBroadcast").length, 0);
  });

  it("busca por nome que NUNCA vê a tag (todas as tentativas) aborta sem broadcast", async () => {
    const { deps, called } = fakeDeps({ tagResolutions: [null] });
    await assert.rejects(runPilotLot(deps, pilotLot(), baseOpts), /propagação/);
    assert.equal(called("createBroadcast").length, 0);
  });

  it("propagação de membros (vazia → completa) passa após retry", async () => {
    const { deps } = fakeDeps({ memberReads: [[], [EDITOR]] });
    assert.equal((await runPilotLot(deps, pilotLot(), baseOpts)).status, "scheduled");
  });
});

describe("piloto — releitura do broadcast antes e depois do PATCH (#6582, #8208)", () => {
  it("email1: nasce rascunho, relê, PATCH reenvia subscriber_filter junto com send_at, relê de novo", async () => {
    const { deps, calls } = fakeDeps();
    const lot = pilotLot();
    let sendAtCalls = 0;
    const res = await runPilotLot(deps, lot, { ...baseOpts, sendAtFn: () => (sendAtCalls++, "2026-09-30T20:00:00.000Z") });
    const create = calls.find((c) => c.name === "createBroadcast")!.args[0] as CreateBroadcastInput;
    assert.equal(create.send_at, null);
    assert.equal(create.public, false);
    const patch = calls.find((c) => c.name === "updateBroadcast")!.args[1] as { send_at: string; subscriber_filter: unknown };
    assert.deepEqual(patch.subscriber_filter, buildTagFilter(TAG_ID), "PATCH reenvia o filtro (#8208)");
    const order = calls.map((c) => c.name);
    const firstRead = order.indexOf("getBroadcast");
    const patchIdx = order.indexOf("updateBroadcast");
    assert.ok(firstRead < patchIdx && order.lastIndexOf("getBroadcast") > patchIdx, "relê antes e depois do PATCH");
    assert.equal(sendAtCalls, 1, "sendAt calculado uma vez, no momento do PATCH");
    assert.equal(res.status, "scheduled");
    assert.equal(res.filter_verification, "verified");
    assert.deepEqual(res.filter_echoed, buildTagFilter(TAG_ID));
    assert.equal(lot.status, "scheduled");
  });

  it("filtro zerado/divergente DEPOIS do PATCH apaga o broadcast na hora e aborta", async () => {
    const { deps, called } = fakeDeps({ postFilter: [] });
    const lot = pilotLot();
    await assert.rejects(runPilotLot(deps, lot, baseOpts), /após o PATCH.*DIVERGENTE/);
    assert.equal(called("deleteBroadcast").length, 1);
    assert.equal(lot.status, "cancelled");
  });

  it("releitura que FALHA depois do PATCH apaga o broadcast (audiência desconhecida)", async () => {
    const { deps, called } = fakeDeps({ postFilter: "throw" });
    await assert.rejects(runPilotLot(deps, pilotLot(), { ...baseOpts, allowUnechoedFilter: true }), /falhou/);
    assert.equal(called("deleteBroadcast").length, 1);
  });

  it("filtro divergente ANTES do PATCH apaga o rascunho e nunca agenda", async () => {
    const { deps, called } = fakeDeps({ preFilter: [{ all: [{ type: "tag", ids: [TAG_ID, 5] }] }] });
    const lot = pilotLot();
    await assert.rejects(runPilotLot(deps, lot, baseOpts), /DIVERGENTE/);
    assert.equal(called("deleteBroadcast").length, 1);
    assert.equal(called("updateBroadcast").length, 0);
    assert.equal(lot.broadcast_id, 900, "registro do broadcast preservado pro store");
  });

  it("falha ao apagar rascunho divergente manda apagar no painel", async () => {
    const { deps } = fakeDeps({ preFilter: [], deleteThrows: true });
    await assert.rejects(runPilotLot(deps, pilotLot(), baseOpts), /APAGUE NO PAINEL DO KIT/);
  });

  it("releitura que LANÇA vira read_failed e NUNCA agenda — nem com --pilot-allow-unechoed-filter", async () => {
    const { deps, called } = fakeDeps({ preFilter: "throw" });
    const lot = pilotLot();
    await assert.rejects(runPilotLot(deps, lot, { ...baseOpts, allowUnechoedFilter: true }), /nunca agendo sem ler o filtro/);
    assert.equal(called("updateBroadcast").length, 0);
    assert.equal(lot.status, "created");
  });

  it("filtro NÃO ecoado: mantém rascunho e aborta; com a flag agenda e AVISA", async () => {
    const a = fakeDeps({ preFilter: "absent" });
    const lot = pilotLot();
    await assert.rejects(runPilotLot(a.deps, lot, baseOpts), /NÃO confirmada/);
    assert.equal(a.called("updateBroadcast").length, 0);
    assert.equal(lot.status, "created");

    const b = fakeDeps({ preFilter: "absent", postFilter: "absent" });
    const res = await runPilotLot(b.deps, pilotLot(), { ...baseOpts, allowUnechoedFilter: true });
    assert.equal(res.status, "scheduled");
    assert.equal(res.filter_verification, "not_echoed");
    assert.ok(b.warnings.length >= 1, "agendar sem eco gera aviso");
  });

  it("PATCH que não deixa o broadcast scheduled é FALHA (não exit 0 sem nada agendado)", async () => {
    const { deps } = fakeDeps({ updateStatus: "draft" });
    const lot = pilotLot();
    await assert.rejects(runPilotLot(deps, lot, baseOpts), /não deixou o broadcast agendado/);
    assert.equal(lot.status, "created");
  });

  it("PATCH que LANÇA mas foi aplicado (saiu de draft) → relê, apaga e aborta", async () => {
    const { deps, called } = fakeDeps({ updateThrows: "applied" });
    const lot = pilotLot();
    await assert.rejects(runPilotLot(deps, lot, baseOpts), /PATCH de agendamento lançou .* estado incerto/);
    assert.ok(called("getBroadcast").length >= 2, "releitura pós-PATCH não é pulada");
    assert.equal(called("deleteBroadcast").length, 1);
    assert.equal(lot.status, "cancelled");
  });

  it("PATCH que LANÇA e a releitura também falha → apaga e aborta", async () => {
    const { deps, called } = fakeDeps({ updateThrows: "applied", postFilter: "throw" });
    await assert.rejects(runPilotLot(deps, pilotLot(), baseOpts), /não pôde ser relido/);
    assert.equal(called("deleteBroadcast").length, 1);
  });

  it("PATCH que LANÇA sem ter sido aplicado (segue draft) → relança, sem apagar", async () => {
    const { deps, called } = fakeDeps({ updateThrows: "not_applied" });
    const lot = pilotLot();
    await assert.rejects(runPilotLot(deps, lot, baseOpts), /segue RASCUNHO, nada agendado/);
    assert.equal(called("deleteBroadcast").length, 0);
    assert.equal(lot.status, "created");
  });

  it("verifyPilotBroadcastFilter: comparação estrutural de tag_ids", () => {
    const want = buildTagFilter(5);
    assert.equal(verifyPilotBroadcastFilter([{ all: [{ ids: ["5"], type: "tag" }], any: [] }], want).status, "verified");
    assert.equal(verifyPilotBroadcastFilter([{ all: [{ type: "tag", ids: [5, 6] }] }], want).status, "divergent");
    assert.equal(verifyPilotBroadcastFilter([], want).status, "divergent");
    assert.equal(verifyPilotBroadcastFilter([{ all: [{ type: "segment", ids: [5] }] }], want).status, "divergent");
    assert.equal(verifyPilotBroadcastFilter(undefined, want).status, "not_echoed");
  });

  it("email3: fica rascunho, nunca chama updateBroadcast", async () => {
    const { deps, called } = fakeDeps();
    const lot = pilotLot({ kind: "email3", lot_id: "email3-2026-09-30-01" });
    const res = await runPilotLot(deps, lot, baseOpts);
    assert.equal(res.status, "created");
    assert.equal(called("updateBroadcast").length, 0);
  });

  it("approvePilotEmail3Lot: tag que cresceu bloqueia; sem prefixo bloqueia; ok agenda com filtro + releitura pós-PATCH", async () => {
    const base = { kind: "email3" as const, lot_id: "email3-2026-09-30-01", tag_id: TAG_ID, broadcast_id: 900, status: "created" as const };
    const now = () => Date.parse("2026-09-30T12:00:00Z");
    const opts = { recipients: [EDITOR], sendAtFn: () => "2026-10-01T13:00:00Z", allowUnechoedFilter: false, now };

    const tooSoon = fakeDeps({ preexistingTagId: TAG_ID });
    await assert.rejects(
      approvePilotEmail3Lot(tooSoon.deps, pilotLot(base), { ...opts, sendAtFn: () => "2026-09-30T12:04:00Z" }),
      /agora \+ 5 min/,
    );
    await assert.rejects(approvePilotEmail3Lot(tooSoon.deps, pilotLot(base), { ...opts, sendAtFn: () => "amanhã" }), /ISO válido/);
    assert.equal(tooSoon.calls.length, 0, "recusa antes de qualquer chamada ao Kit");

    const grown = fakeDeps({ preexistingTagId: TAG_ID, memberReads: [[EDITOR, "x@example.com"]] });
    await assert.rejects(approvePilotEmail3Lot(grown.deps, pilotLot(base), opts), /fora do lote/);
    assert.equal(grown.called("updateBroadcast").length, 0);

    const noPrefix = fakeDeps({ preexistingTagId: TAG_ID });
    await assert.rejects(approvePilotEmail3Lot(noPrefix.deps, pilotLot({ ...base, tag_name: "onboarding-email3-x" }), opts), /não é lote do piloto/);

    const zeroed = fakeDeps({ preexistingTagId: TAG_ID, postFilter: [] });
    await assert.rejects(approvePilotEmail3Lot(zeroed.deps, pilotLot(base), opts), /após o PATCH/);
    assert.equal(zeroed.called("deleteBroadcast").length, 1);

    const ok = fakeDeps({ preexistingTagId: TAG_ID });
    const res = await approvePilotEmail3Lot(ok.deps, pilotLot(base), opts);
    assert.equal(res.status, "scheduled");
    const patch = ok.calls.find((c) => c.name === "updateBroadcast")!.args[1] as { subscriber_filter: unknown };
    assert.deepEqual(patch.subscriber_filter, buildTagFilter(TAG_ID));
  });
});

describe("piloto — runPilotPlan (#7922)", () => {
  function planDeps(kit: PilotKitDeps, over: Partial<PilotPlanDeps> = {}): PilotPlanDeps {
    return {
      kit,
      fetchSubscription: async () => ({ status: "active", resolvedKitId: 555 }),
      loadSnippet: (n) => ({ numero: n, assunto: `Assunto ${n}`, previewText: null, body: "<p>corpo</p>", hasPendingMarker: false }),
      claimLot,
      persistLotUpdate,
      now: () => Date.parse("2026-09-30T15:00:00Z"),
      ...over,
    };
  }

  function withStore(fn: (storePath: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "diaria-7922-plan-"));
    return fn(join(dir, "store.json")).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  it("dry-run não grava store e não chama escrita no Kit", () =>
    withStore(async (storePath) => {
      const { deps, called } = fakeDeps();
      const r = await runPilotPlan({ send: false, allowUnechoedFilter: false, storePath, store: emptyStore(), recipients: [EDITOR] }, planDeps(deps));
      assert.equal(existsSync(storePath), false, "dry-run nunca grava o store");
      assert.equal(r.summary.mode, "PILOT-dry-run");
      assert.equal(r.summary.lots.length, 3);
      assert.equal(called("createTag").length + called("createBroadcast").length, 0);
      assert.equal(r.failed, false);
    }));

  it("--send: 3 lotes, email1/2 agendados, email3 rascunho, summary sem e-mail", () =>
    withStore(async (storePath) => {
      const { deps } = fakeDeps();
      // Cada lote precisa da sua tag: a fake devolve sempre TAG_ID — suficiente pro fluxo.
      const r = await runPilotPlan({ send: true, allowUnechoedFilter: false, storePath, store: emptyStore(), recipients: [EDITOR] }, planDeps(deps));
      assert.equal(r.failed, false, JSON.stringify(r.summary));
      assert.deepEqual(r.summary.lots.map((l) => l.status), ["scheduled", "scheduled", "created"]);
      assert.equal(JSON.stringify(r.summary).includes("@"), false, "summary sem PII");
    }));

  it("falha num lote: exit 1 (failed), erro redigido, e o lote é persistido mesmo assim (finally)", () =>
    withStore(async (storePath) => {
      const { deps } = fakeDeps({ postFilter: [], deleteThrows: true });
      const r = await runPilotPlan({ send: true, allowUnechoedFilter: false, storePath, store: emptyStore(), recipients: [EDITOR] }, planDeps(deps));
      assert.equal(r.failed, true);
      const lots = readStore(storePath).store.kit_transport!.lots;
      const email1 = Object.values(lots).find((l) => l.kind === "email1")!;
      assert.equal(email1.broadcast_id, 900, "broadcast_id persistido apesar do erro");
      assert.match(email1.last_error ?? "", /APAGUE NO PAINEL/);
      assert.equal(JSON.stringify(r.summary).includes("@"), false, "erro com e-mail é redigido no summary");
    }));

  it("persistLotUpdate que lança no finally: não engole o erro original, avisa com broadcast_id e marca failed", () =>
    withStore(async (storePath) => {
      const { deps, warnings } = fakeDeps({ preFilter: "throw" });
      const r = await runPilotPlan(
        { send: true, allowUnechoedFilter: false, storePath, store: emptyStore(), recipients: [EDITOR] },
        planDeps(deps, { persistLotUpdate: () => { throw new Error("disco cheio"); } }),
      );
      assert.equal(r.failed, true);
      assert.ok(r.summary.lots.some((l) => typeof l.error === "string" && /nunca agendo/.test(l.error as string)), "erro original preservado");
      assert.ok(warnings.some((w) => /FALHA ao persistir lote .*broadcast_id=900/.test(w)));
    }));

  it("persistência falha após agendar → sidecar registra o broadcast e a próxima rodada NÃO recria o lote", () =>
    withStore(async (storePath) => {
      const first = fakeDeps();
      const r1 = await runPilotPlan(
        { send: true, allowUnechoedFilter: false, storePath, store: emptyStore(), recipients: [EDITOR] },
        planDeps(first.deps, { persistLotUpdate: () => { throw new Error("disco cheio"); } }),
      );
      assert.equal(r1.failed, true);
      const sidecar = readPendingBroadcastSidecar(storePath);
      assert.deepEqual(sidecar.map((s) => [s.kind, s.broadcast_id]), [["email1", 900], ["email2", 900], ["email3", 900]]);
      assert.ok(first.warnings.every((w) => /pending-broadcasts/.test(w)));

      const second = fakeDeps();
      const r2 = await runPilotPlan({ send: true, allowUnechoedFilter: false, storePath, store: emptyStore(), recipients: [EDITOR] }, planDeps(second.deps));
      assert.equal(second.called("createBroadcast").length, 0, "nenhum broadcast recriado");
      assert.ok(r2.summary.lots.every((l) => String(l.skipped).startsWith("reuse")));
    }));

  it("blocked_concurrent de lote com last_error recente conta como falha", () =>
    withStore(async (storePath) => {
      seedPilotStoreOnDisk(storePath, [EDITOR]);
      const { store } = readStore(storePath);
      store.kit_transport = {
        lots: {
          "email1-2026-09-30-01": pilotLot({ created_at: new Date(Date.parse("2026-09-30T14:59:00Z")).toISOString(), last_error: "falhou" }),
        },
      };
      writeStore(store, storePath);
      const { deps } = fakeDeps();
      const r = await runPilotPlan({ send: true, allowUnechoedFilter: false, storePath, store, recipients: [EDITOR] }, planDeps(deps));
      assert.equal(r.failed, true);
      const email1 = r.summary.lots.find((l) => l.kind === "email1")!;
      assert.equal(email1.failed, true);
    }));
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
