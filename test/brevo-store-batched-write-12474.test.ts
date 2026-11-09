/**
 * #12474 — o OneDrive do 300 revertia `brevo-diaria/contacts.json` quando um
 * script em lote (`restore-kit-sem-abertura-frio.ts`,
 * `restore-brevo-semanal-suppressed.ts`) gravava o store a cada contato: o
 * cliente subia o arquivo enquanto o script já o reescrevia, acusava
 * `Online file integrity failure`, salvava o local como `-safeBackup-N` e
 * baixava por cima a versão intermediária. Exit 0, contato revertido em
 * silêncio.
 *
 * Trava: (1) os dois scripts gravam o store em lote (uma vez no fim para
 * lotes pequenos), sem perder nenhuma alteração; (2) falha no meio do lote
 * não descarta o que já mudou; (3) `writeStore` é atômico (tmp + rename,
 * sem sobra de tmp).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STORE_BATCH_FLUSH_EVERY,
  createBatchedStoreWriter,
  findContact,
  readStore,
  writeStore,
  type BrevoDiariaContact,
  type BrevoDiariaStore,
} from "../scripts/lib/brevo-diaria-store.ts";
import { parseKitFrio } from "../scripts/lib/kit-frio.ts";
import { parseBrevoDiariaSemanal } from "../scripts/lib/brevo-diaria-semanal.ts";
import { runKitSemAberturaRestore, type KitRestoreDeps } from "../scripts/restore-kit-sem-abertura-frio.ts";
import { runRestoreSemanal, type RestoreDeps } from "../scripts/restore-brevo-semanal-suppressed.ts";

function contact(email: string, origin: string, over: Partial<BrevoDiariaContact> = {}): BrevoDiariaContact {
  return {
    email,
    beehiiv_subscription_id: origin,
    status: "in_brevo",
    opens_count: 0,
    sends_count: 0,
    last_open_rate: null,
    added_at: "2026-10-10T00:00:00.000Z",
    last_evaluated_at: null,
    ...over,
  };
}

const frioOn = parseKitFrio({
  frio: { enabled: true, semanal_enabled: true, segmento_exclui_frio_confirmado: true },
  diaria_exclusion_segment: { enabled: true, segment_id: 599796 },
});

describe("createBatchedStoreWriter (#12474)", () => {
  it("grava só a cada `every` alterações e o resto no flush", () => {
    const writes: number[] = [];
    const w = createBatchedStoreWriter((s) => void writes.push(s.contacts.length), 3);
    for (let i = 1; i <= 7; i++) w.mark({ contacts: Array.from({ length: i }, (_, j) => contact(`c${j}@x.com`, "kit:1")) });
    assert.deepEqual(writes, [3, 6]);
    assert.equal(w.pending(), 1);
    w.flush();
    assert.deepEqual(writes, [3, 6, 7]);
    w.flush(); // nada pendente: não grava de novo
    assert.deepEqual(writes, [3, 6, 7]);
  });
  it("flush sem alteração nenhuma não grava (dry-run nunca toca o store)", () => {
    let writes = 0;
    createBatchedStoreWriter(() => void writes++).flush();
    assert.equal(writes, 0);
  });
  it("every inválido é erro", () => {
    assert.throws(() => createBatchedStoreWriter(() => {}, 0));
    assert.throws(() => createBatchedStoreWriter(() => {}, 1.5));
  });
  it("o lote padrão é bem maior que 1 (gravar por contato era o bug)", () => {
    assert.ok(STORE_BATCH_FLUSH_EVERY >= 10);
  });
});

describe("restore-kit-sem-abertura-frio grava o store em lote (#12474)", () => {
  function deps(storeRef: { store: BrevoDiariaStore; writes: number }, over: Partial<KitRestoreDeps> = {}): KitRestoreDeps {
    return {
      log: () => {},
      getKit: async () => ({ state: "active", tagNames: ["envio-brevo"] }),
      findTagId: async (n) => (n === "frio" ? 900 : 555),
      tag: async () => {},
      untag: async () => {},
      unlinkBrevo: async () => {},
      readStore: () => storeRef.store,
      writeStore: (s) => {
        storeRef.store = s;
        storeRef.writes++;
      },
      writePanelList: () => {},
      appendLog: () => {},
      nowIso: () => "2026-11-08T21:24:00Z",
      ...over,
    };
  }
  it("REGRESSÃO: 3 contatos convertidos ⇒ 1 gravação só, com os 3 convertidos", async () => {
    const ref = {
      store: { contacts: [contact("a@x.com", "kit-sem-abertura:1"), contact("b@x.com", "kit-sem-abertura:2"), contact("c@x.com", "kit-sem-abertura:3")] },
      writes: 0,
    };
    const r = await runKitSemAberturaRestore(
      [
        { email: "a@x.com", kitSubscriberId: 1, source: "in_brevo" },
        { email: "b@x.com", kitSubscriberId: 2, source: "in_brevo" },
        { email: "c@x.com", kitSubscriberId: 3, source: "in_brevo" },
      ],
      { apply: true, frio: frioOn },
      deps(ref),
    );
    assert.equal(r.code, 0);
    assert.equal(ref.writes, 1);
    for (const e of ["a@x.com", "b@x.com", "c@x.com"]) assert.equal(findContact(ref.store, e)!.resolution_reason, "kit_sem_abertura_frio");
  });
  it("falha num contato do meio não perde a conversão dos outros", async () => {
    const ref = { store: { contacts: [contact("a@x.com", "kit-sem-abertura:1"), contact("b@x.com", "kit-sem-abertura:2"), contact("c@x.com", "kit-sem-abertura:3")] }, writes: 0 };
    const r = await runKitSemAberturaRestore(
      [
        { email: "a@x.com", kitSubscriberId: 1, source: "in_brevo" },
        { email: "b@x.com", kitSubscriberId: 2, source: "in_brevo" },
        { email: "c@x.com", kitSubscriberId: 3, source: "in_brevo" },
      ],
      { apply: true, frio: frioOn },
      deps(ref, {
        unlinkBrevo: async (e) => {
          if (e === "b@x.com") throw new Error("HTTP 500");
        },
      }),
    );
    assert.equal(r.code, 1);
    assert.equal(ref.writes, 1);
    assert.equal(findContact(ref.store, "a@x.com")!.resolution_reason, "kit_sem_abertura_frio");
    assert.equal(findContact(ref.store, "b@x.com")!.status, "in_brevo");
    assert.equal(findContact(ref.store, "c@x.com")!.resolution_reason, "kit_sem_abertura_frio");
  });
  it("exceção fora do try por contato ainda grava o que já mudou (finally)", async () => {
    const ref = { store: { contacts: [contact("a@x.com", "kit-sem-abertura:1"), contact("b@x.com", "kit-sem-abertura:2")] }, writes: 0 };
    await assert.rejects(
      runKitSemAberturaRestore(
        [
          { email: "a@x.com", kitSubscriberId: 1, source: "in_brevo" },
          { email: "b@x.com", kitSubscriberId: 2, source: "in_brevo" },
        ],
        { apply: true, frio: frioOn },
        deps(ref, {
          getKit: async (id) => {
            if (id === 2) return { state: "active", tagNames: null as unknown as string[] }; // tagNames.includes estoura fora do try
            return { state: "active", tagNames: ["envio-brevo"] };
          },
        }),
      ),
    );
    assert.equal(ref.writes, 1);
    assert.equal(findContact(ref.store, "a@x.com")!.resolution_reason, "kit_sem_abertura_frio");
  });
  it("dry-run não grava o store", async () => {
    const ref = { store: { contacts: [contact("a@x.com", "kit-sem-abertura:1")] }, writes: 0 };
    await runKitSemAberturaRestore([{ email: "a@x.com", kitSubscriberId: 1, source: "in_brevo" }], { apply: false, frio: frioOn }, deps(ref));
    assert.equal(ref.writes, 0);
  });
});

describe("restore-brevo-semanal-suppressed grava o store em lote (#12474)", () => {
  const on = parseBrevoDiariaSemanal({ enabled: true, desde: "2026-11-02" });
  const sup = (email: string): BrevoDiariaContact =>
    contact(email, `kit:${email}`, { status: "suppressed", resolution_reason: "score_threshold", opens_count: 1 });
  function deps(storeRef: { store: BrevoDiariaStore; writes: number }, over: Partial<RestoreDeps> = {}): RestoreDeps {
    return {
      log: () => {},
      readStore: () => storeRef.store,
      writeStore: (s) => {
        storeRef.store = s;
        storeRef.writes++;
      },
      getBrevoContact: async () => ({ status: 200, body: { statistics: { opened: [{ campaignId: 1 }] }, emailBlacklisted: false, listIds: [7] } }),
      putBrevoContact: async () => {},
      kitStateByEmail: async () => "inactive",
      appendLog: () => {},
      nowIso: () => "2026-11-08T21:24:00Z",
      ...over,
    };
  }
  it("REGRESSÃO: 3 devolvidos à semanal ⇒ 1 gravação só, com os 3 devolvidos", async () => {
    const ref = { store: { contacts: [sup("a@x.com"), sup("b@x.com"), sup("c@x.com")] }, writes: 0 };
    const r = await runRestoreSemanal({ apply: true, listId: 7, semanal: on }, deps(ref));
    assert.equal(r.restored, 3);
    assert.equal(ref.writes, 1);
    for (const e of ["a@x.com", "b@x.com", "c@x.com"]) assert.equal(findContact(ref.store, e)!.resolution_reason, "restored_to_semanal");
  });
  it("lote maior que STORE_BATCH_FLUSH_EVERY grava em blocos e não perde nenhum", async () => {
    const n = STORE_BATCH_FLUSH_EVERY * 2 + 3;
    const emails = Array.from({ length: n }, (_, i) => `p${i}@x.com`);
    const ref = { store: { contacts: emails.map(sup) }, writes: 0 };
    const r = await runRestoreSemanal({ apply: true, listId: 7, semanal: on }, deps(ref));
    assert.equal(r.restored, n);
    assert.equal(ref.writes, 3);
    assert.ok(ref.store.contacts.every((c) => c.resolution_reason === "restored_to_semanal"));
  });
});

describe("writeStore atômico (#12474)", () => {
  it("sobrescreve o store sem deixar tmp no diretório", () => {
    const dir = mkdtempSync(join(tmpdir(), "brevo-store-12474-"));
    const path = join(dir, "contacts.json");
    writeFileSync(path, JSON.stringify({ contacts: [contact("velho@x.com", "kit:1")] }));
    writeStore({ contacts: [contact("novo@x.com", "kit:2")] }, path);
    assert.deepEqual(readdirSync(dir), ["contacts.json"]);
    assert.equal(readStore(path).contacts[0].email, "novo@x.com");
    assert.ok(readFileSync(path, "utf8").endsWith("\n"));
  });
  it("cria o diretório pai quando falta", () => {
    const dir = mkdtempSync(join(tmpdir(), "brevo-store-12474-"));
    const path = join(dir, "sub", "contacts.json");
    writeStore({ contacts: [] }, path);
    assert.deepEqual(readStore(path), { contacts: [] });
  });
});
