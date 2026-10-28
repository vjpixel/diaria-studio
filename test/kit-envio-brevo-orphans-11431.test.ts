/**
 * #11431 — órfãos da tag `envio-brevo` (no Kit, fora do store da Brevo
 * diária) com o Passo 3c desligado. Antes deste fix, nenhum código os via:
 * ficavam sem edição nenhuma, indefinidamente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideEnvioBrevoOrphan,
  findEnvioBrevoOrphans,
  runEnvioBrevoOrphanSweep,
  type BrevoOrphanContact,
  type EnvioBrevoOrphanCandidate,
  type EnvioBrevoOrphanDeps,
} from "../scripts/sync-kit-envio-brevo-orphans.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionDeps, runBrevoDiaria, type ExecFn } from "../scripts/brevo-diaria-run.ts";
import { decideKitFrio } from "../scripts/lib/kit-frio.ts";
import type { BrevoDiariaStore, BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";

const LIST_ID = 7;
const TAG_ID = 42;
const NOW = Date.parse("2026-10-28T12:00:00Z");

const cfgOff = { brevo_diaria: { api_key_env: "X", list_id: LIST_ID, kit_sem_abertura: { enabled: false } } };
const cfgOn = { brevo_diaria: { api_key_env: "X", list_id: LIST_ID, kit_sem_abertura: { enabled: true } } };

function contact(email: string, origin = "kit-sem-abertura:1"): BrevoDiariaContact {
  return {
    email,
    beehiiv_subscription_id: origin,
    status: "in_brevo",
    opens_count: 0,
    sends_count: 0,
    last_open_rate: null,
    added_at: "2026-10-01T00:00:00Z",
    last_evaluated_at: null,
  };
}

const sub = (id: number, email: string, tags: string[] = ["envio-brevo"]): EnvioBrevoOrphanCandidate => ({ id, email, tagNames: tags });

function makeDeps(over: Partial<EnvioBrevoOrphanDeps> & { brevo?: Record<string, BrevoOrphanContact | Error> } = {}) {
  const untagged: number[] = [];
  const writes: BrevoDiariaStore[] = [];
  const logLines: string[] = [];
  const store: BrevoDiariaStore = { contacts: [contact("no-store-nao@x.com")] };
  const deps: EnvioBrevoOrphanDeps = {
    nowMs: NOW,
    log: () => {},
    readStore: () => store,
    writeStore: (s) => {
      writes.push(s);
    },
    listKitActive: async () => [],
    readBrevoContact: async (email) => {
      const v = over.brevo?.[email];
      if (v instanceof Error) throw v;
      return v ?? { exists: false, blacklisted: false, listIds: [] };
    },
    findEnvioBrevoTagId: async () => TAG_ID,
    untagKit: async (_tag, id) => {
      untagged.push(id);
    },
    appendLog: (l) => {
      logLines.push(l);
    },
    ...over,
  };
  return { deps, untagged, writes, logLines };
}

describe("decideEnvioBrevoOrphan (#11431)", () => {
  it("na lista e não blacklisted ⇒ recebe pela Brevo, só falta o store", () => {
    assert.equal(decideEnvioBrevoOrphan({ exists: true, blacklisted: false, listIds: [LIST_ID] }, LIST_ID), "reconcile_store");
  });
  it("fora da lista, blacklisted ou inexistente ⇒ volta ao Kit", () => {
    assert.equal(decideEnvioBrevoOrphan({ exists: true, blacklisted: false, listIds: [99] }, LIST_ID), "return_to_kit");
    assert.equal(decideEnvioBrevoOrphan({ exists: true, blacklisted: true, listIds: [LIST_ID] }, LIST_ID), "return_to_kit");
    assert.equal(decideEnvioBrevoOrphan({ exists: false, blacklisted: false, listIds: [] }, LIST_ID), "return_to_kit");
  });
});

describe("findEnvioBrevoOrphans (#11431)", () => {
  it("só quem tem a tag e não está no store (qualquer status, e-mail normalizado)", () => {
    const store: BrevoDiariaStore = { contacts: [contact("in@x.com"), { ...contact("conv@x.com"), status: "converted_to_kit" }] };
    const actives = [sub(1, "IN@x.com"), sub(2, "conv@x.com"), sub(3, "orfao@x.com"), sub(4, "semtag@x.com", [])];
    assert.deepEqual(findEnvioBrevoOrphans(actives, store).map((a) => a.id), [3]);
  });
});

describe("runEnvioBrevoOrphanSweep (#11431)", () => {
  it("cenário da issue: 3c desligado, órfão fora da lista Brevo ⇒ tag removida, volta à diária do Kit", async () => {
    const { deps, untagged, writes, logLines } = makeDeps({
      listKitActive: async () => [sub(10, "orfao@x.com")],
      brevo: { "orfao@x.com": { exists: true, blacklisted: false, listIds: [] } },
    });
    const r = await runEnvioBrevoOrphanSweep(cfgOff, { push: true }, deps);
    assert.equal(r.code, 0);
    assert.equal(r.orphans, 1);
    assert.equal(r.returnedToKit, 1);
    assert.deepEqual(untagged, [10]);
    assert.equal(writes.length, 0, "não grava store pra quem volta ao Kit");
    assert.match(logLines[0]!, /orphan_returned_to_kit/);
  });

  it("órfão ainda na lista Brevo ⇒ grava a entrada que faltava (kit-sem-abertura:id), sem tocar no Kit", async () => {
    const { deps, untagged, writes } = makeDeps({
      listKitActive: async () => [sub(11, "nabrevo@x.com")],
      brevo: { "nabrevo@x.com": { exists: true, blacklisted: false, listIds: [LIST_ID] } },
    });
    const r = await runEnvioBrevoOrphanSweep(cfgOff, { push: true }, deps);
    assert.equal(r.reconciledInStore, 1);
    assert.deepEqual(untagged, []);
    const written = writes.at(-1)!.contacts.find((c) => c.email === "nabrevo@x.com");
    assert.equal(written?.beehiiv_subscription_id, "kit-sem-abertura:11");
    assert.equal(written?.status, "in_brevo");
    assert.equal(writes.at(-1)!.contacts.length, 2, "preserva o store existente");
  });

  it("dry-run classifica e conta, sem escrever nada", async () => {
    const { deps, untagged, writes, logLines } = makeDeps({
      listKitActive: async () => [sub(1, "a@x.com"), sub(2, "b@x.com")],
      brevo: { "b@x.com": { exists: true, blacklisted: false, listIds: [LIST_ID] } },
    });
    const r = await runEnvioBrevoOrphanSweep(cfgOff, { push: false }, deps);
    assert.equal(r.dryRun, true);
    assert.equal(r.returnedToKit, 1);
    assert.equal(r.reconciledInStore, 1);
    assert.deepEqual(untagged, []);
    assert.deepEqual(writes, []);
    assert.deepEqual(logLines, []);
  });

  it("3c ligado ⇒ não faz nada (o 3c reconcilia do jeito dele)", async () => {
    let listed = false;
    const { deps } = makeDeps({
      listKitActive: async () => {
        listed = true;
        return [sub(1, "a@x.com")];
      },
    });
    const r = await runEnvioBrevoOrphanSweep(cfgOn, { push: true }, deps);
    assert.equal(r.code, 0);
    assert.equal(r.coveredBy3c, true);
    assert.equal(listed, false);
  });

  it("store ausente ou vazio ⇒ exit 2, ninguém tocado (todo portador pareceria órfão)", async () => {
    for (const readStore of [() => null, () => ({ contacts: [] })]) {
      const { deps, untagged, writes } = makeDeps({ readStore, listKitActive: async () => [sub(1, "a@x.com")] });
      const r = await runEnvioBrevoOrphanSweep(cfgOff, { push: true }, deps);
      assert.equal(r.code, 2);
      assert.deepEqual(untagged, []);
      assert.deepEqual(writes, []);
    }
  });

  it("leitura da Brevo ou remoção da tag falha ⇒ conta falha (exit 1), os demais seguem", async () => {
    const { deps, untagged } = makeDeps({
      listKitActive: async () => [sub(1, "erro@x.com"), sub(2, "ok@x.com"), sub(3, "untagfail@x.com")],
      brevo: { "erro@x.com": new Error("HTTP 500") },
      untagKit: async (_t, id) => {
        if (id === 3) throw new Error("releitura ainda mostra a tag");
        untagged.push(id);
      },
    });
    const r = await runEnvioBrevoOrphanSweep(cfgOff, { push: true }, deps);
    assert.equal(r.code, 1);
    assert.equal(r.failed, 2);
    assert.equal(r.returnedToKit, 1);
    assert.deepEqual(untagged, [2]);
  });

  it("tag envio-brevo não achada no Kit ⇒ exit 2", async () => {
    const { deps } = makeDeps({ listKitActive: async () => [sub(1, "a@x.com")], findEnvioBrevoTagId: async () => null });
    const r = await runEnvioBrevoOrphanSweep(cfgOff, { push: true }, deps);
    assert.equal(r.code, 2);
  });

  it("depois do reparo, o sync-kit-frio deixa de pular a pessoa pela tag", async () => {
    // Pré-condição do bug: com envio-brevo, o frio sempre pula (`tag_envio_brevo`).
    const ctx = {
      nowMs: NOW,
      lastSignal: new Map<string, number>(),
      silentStreaks: new Map<string, number>(),
      diariaRecords: [],
      diariaDeliveries: new Map<string, number[]>(),
      seedEmails: new Set<string>(),
    };
    const before = decideKitFrio({ id: 1, email: "o@x.com", created_at: "2026-01-01T00:00:00Z", tagNames: ["envio-brevo"] }, ctx);
    assert.deepEqual(before, { action: "skip", reason: "tag_envio_brevo" });
    const after = decideKitFrio({ id: 1, email: "o@x.com", created_at: "2026-01-01T00:00:00Z", tagNames: [] }, ctx);
    assert.deepEqual(after, { action: "skip", reason: "registro_nao_cobre_a_janela" });
  });
});

describe("brevo-diaria-run — Passo 3e (#11431)", () => {
  function run(argv: string[], sweep: boolean | undefined) {
    const calls: string[] = [];
    const exec: ExecFn = (s) => {
      calls.push(s);
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = runBrevoDiaria(argv, {
      rootDir: "/f",
      exec,
      kitFrioEnabled: () => true,
      ...(sweep === undefined ? {} : { envioBrevoOrphanSweepEnabled: () => sweep }),
    });
    return { calls, result };
  }
  const SCRIPT = "scripts/sync-kit-envio-brevo-orphans.ts";

  it("ligado ⇒ roda no preflight (dry-run) e no apply (--push), antes do 3d", () => {
    const pre = run([], true);
    assert.ok(pre.calls.includes(SCRIPT));
    assert.deepEqual(pre.result.steps.find((s) => s.script === SCRIPT)!.args, []);
    const apply = run(["--apply"], true);
    assert.deepEqual(apply.result.steps.find((s) => s.script === SCRIPT)!.args, ["--push"]);
    assert.ok(apply.calls.indexOf(SCRIPT) < apply.calls.indexOf("scripts/sync-kit-frio.ts"));
  });

  it("ausente/false ⇒ não invocado", () => {
    for (const v of [undefined, false]) {
      assert.ok(!run([], v).calls.includes(SCRIPT));
      assert.ok(!run(["--apply"], v).calls.includes(SCRIPT));
    }
  });

  it("produção: 3e ligado exatamente quando o 3c está desligado", () => {
    for (const ksa of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), "orphans-11431-"));
      try {
        writeFileSync(join(dir, "platform.config.json"), JSON.stringify({ brevo_diaria: { kit_sem_abertura: { enabled: ksa } } }));
        assert.equal(productionDeps(dir).envioBrevoOrphanSweepEnabled!(), !ksa);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("falha do 3e é fail-soft (aviso, o resto segue)", () => {
    const calls: string[] = [];
    const exec: ExecFn = (s) => {
      calls.push(s);
      return s === SCRIPT ? { code: 2, stdout: "", stderr: "store ausente" } : { code: 0, stdout: "", stderr: "" };
    };
    const r = runBrevoDiaria(["--apply"], { rootDir: "/f", exec, envioBrevoOrphanSweepEnabled: () => true, kitFrioEnabled: () => true });
    assert.equal(r.code, 0);
    assert.ok(calls.includes("scripts/sync-kit-frio.ts"));
    assert.ok(r.warnings.some((w) => /Passo 3e/.test(w)));
  });
});
