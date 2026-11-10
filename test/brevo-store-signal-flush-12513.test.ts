/**
 * #12513 — os restores em lote (`restore-brevo-semanal-suppressed.ts`,
 * `restore-kit-sem-abertura-frio.ts`) gravam o store a cada 50 contatos +
 * `flush()` no `finally` (#12474). O Node encerrado por SIGINT/SIGTERM não
 * roda `finally`: Ctrl-C depois de 30 contatos deixava 30 alterações já
 * feitas na Brevo/Kit fora do store.
 *
 * Trava: (1) `flushStoreOnSignal` grava o pendente e sai com 130/143, com
 * processo real recebendo o sinal; (2) os dois scripts instalam o handler
 * durante o lote e o removem no fim; (3) o handler instalado pelo script grava
 * as alterações pendentes do lote em curso.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  STORE_FLUSH_SIGNALS,
  createBatchedStoreWriter,
  findContact,
  flushStoreOnSignal,
  type BrevoDiariaContact,
  type BrevoDiariaStore,
  type SignalProcess,
} from "../scripts/lib/brevo-diaria-store.ts";
import { parseBrevoDiariaSemanal } from "../scripts/lib/brevo-diaria-semanal.ts";
import { parseKitFrio } from "../scripts/lib/kit-frio.ts";
import { runRestoreSemanal, type RestoreDeps } from "../scripts/restore-brevo-semanal-suppressed.ts";
import { runKitSemAberturaRestore, type KitRestoreDeps } from "../scripts/restore-kit-sem-abertura-frio.ts";

const REPO = resolve(import.meta.dirname, "..");

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

function fakeProc(): SignalProcess & { handlers: Map<string, Array<() => void>>; exits: number[] } {
  const handlers = new Map<string, Array<() => void>>();
  const exits: number[] = [];
  return {
    handlers,
    exits,
    on(sig, h) {
      handlers.set(sig, [...(handlers.get(sig) ?? []), h]);
    },
    off(sig, h) {
      handlers.set(sig, (handlers.get(sig) ?? []).filter((x) => x !== h));
    },
    exit(code) {
      exits.push(code);
    },
  };
}

describe("flushStoreOnSignal (#12513)", () => {
  it("SIGINT grava o pendente e sai 130; SIGTERM sai 143", () => {
    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      const writes: number[] = [];
      const w = createBatchedStoreWriter((s) => void writes.push(s.contacts.length), 50);
      w.mark({ contacts: [contact("a@x.com", "k:1")] });
      w.mark({ contacts: [contact("a@x.com", "k:1"), contact("b@x.com", "k:2")] });
      const p = fakeProc();
      flushStoreOnSignal(w, p);
      p.handlers.get(sig)![0]();
      assert.deepEqual(writes, [2], sig);
      assert.deepEqual(p.exits, [code], sig);
    }
    assert.deepEqual(STORE_FLUSH_SIGNALS, { SIGINT: 130, SIGTERM: 143 });
  });
  it("o disposer remove os dois handlers", () => {
    const p = fakeProc();
    const dispose = flushStoreOnSignal({ flush: () => {} }, p);
    assert.equal(p.handlers.get("SIGINT")!.length, 1);
    assert.equal(p.handlers.get("SIGTERM")!.length, 1);
    dispose();
    assert.equal(p.handlers.get("SIGINT")!.length, 0);
    assert.equal(p.handlers.get("SIGTERM")!.length, 0);
  });
  it("flush que lança ainda sai com o código do sinal (e avisa)", () => {
    const p = fakeProc();
    const errs: string[] = [];
    flushStoreOnSignal({ flush: () => { throw new Error("EACCES"); } }, p, (m) => void errs.push(m));
    p.handlers.get("SIGTERM")![0]();
    assert.deepEqual(p.exits, [143]);
    assert.match(errs[0], /SIGTERM.*EACCES/);
  });
});

describe("REGRESSÃO #12513: processo real recebendo o sinal grava o store", () => {
  const dir = mkdtempSync(join(tmpdir(), "signal-flush-12513-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  // `.mts`: fora do repo não há package.json `type: module`, e o top-level await precisa de ESM.
  const fixture = join(dir, "fixture.mts");
  writeFileSync(
    fixture,
    [
      `import { createBatchedStoreWriter, flushStoreOnSignal, writeStore } from ${JSON.stringify(join(REPO, "scripts/lib/brevo-diaria-store.ts"))};`,
      `const out = process.argv[2];`,
      `const w = createBatchedStoreWriter((s) => writeStore(s, out), 50);`,
      `const contacts = [];`,
      `for (let i = 0; i < 30; i++) {`,
      `  contacts.push({ email: "c" + i + "@x.com", beehiiv_subscription_id: "k", status: "in_brevo", opens_count: 0, sends_count: 0, last_open_rate: null, added_at: "x", last_evaluated_at: null });`,
      `  w.mark({ contacts: [...contacts] });`,
      `}`,
      `flushStoreOnSignal(w);`,
      `try {`,
      `  process.stdout.write("ready\\n");`,
      `  await new Promise((r) => setTimeout(r, 30_000));`,
      `} finally {`,
      `  w.flush();`,
      `}`,
    ].join("\n"),
  );
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    it(`${sig} no meio do lote (30 pendentes, lote de 50) ⇒ store com os 30, exit ${code}`, async () => {
      const out = join(dir, `store-${sig}.json`);
      const child = spawn(process.execPath, ["--import", "tsx", fixture, out], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`fixture não ficou pronta: ${stderr}`)), 20_000);
        child.once("exit", (c) => {
          clearTimeout(t);
          rej(new Error(`fixture saiu (${c}) antes de ficar pronta: ${stderr}`));
        });
        child.stdout.on("data", (d) => {
          if (String(d).includes("ready")) {
            clearTimeout(t);
            res();
          }
        });
      });
      child.kill(sig);
      const exit = await new Promise<number | null>((res) => child.on("exit", (c) => res(c)));
      assert.equal(exit, code, stderr);
      const stored = JSON.parse(readFileSync(out, "utf8")) as BrevoDiariaStore;
      assert.equal(stored.contacts.length, 30);
    });
  }
});

describe("os restores instalam o handler durante o lote e o removem no fim (#12513)", () => {
  function withStubbedExit<T>(fn: (exits: number[]) => Promise<T>): Promise<T> {
    const exits: number[] = [];
    const orig = process.exit;
    process.exit = ((c?: number) => void exits.push(c ?? 0)) as never;
    return fn(exits).finally(() => {
      process.exit = orig;
    });
  }
  /** Chama o handler de SIGINT que o script instalou (o novo, além dos que já existiam). */
  function fireNewSigint(before: Function[]): void {
    const added = process.listeners("SIGINT").filter((l) => !before.includes(l));
    assert.equal(added.length, 1, "o script instala exatamente um handler de SIGINT");
    (added[0] as () => void)();
  }

  it("restore-brevo-semanal-suppressed: SIGINT no 3º contato grava os 2 já devolvidos", async () => {
    const on = parseBrevoDiariaSemanal({ enabled: true, desde: "2026-11-02" });
    const sup = (e: string) => contact(e, `kit:${e}`, { status: "suppressed", resolution_reason: "score_threshold", opens_count: 1 });
    const ref = { store: { contacts: [sup("a@x.com"), sup("b@x.com"), sup("c@x.com")] } as BrevoDiariaStore, writes: 0 };
    const beforeInt = process.listeners("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    let puts = 0;
    let signalled = false;
    let inner: unknown = null;
    await withStubbedExit(async (exits) => {
      const deps: RestoreDeps = {
        log: () => {},
        readStore: () => ref.store,
        writeStore: (s) => {
          ref.store = s;
          ref.writes++;
        },
        getBrevoContact: async () => ({ status: 200, body: { statistics: { opened: [{ campaignId: 1 }] }, emailBlacklisted: false, listIds: [7] } }),
        putBrevoContact: async () => {
          puts++;
          if (puts === 3 && !signalled) {
            signalled = true;
            // O script engole exceção por contato: o assert falho vai para `inner`.
            try {
            assert.equal(process.listenerCount("SIGTERM"), beforeTerm + 1);
            fireNewSigint(beforeInt);
            assert.deepEqual(exits, [130]);
            assert.equal(ref.writes, 1, "o handler gravou o pendente");
            assert.equal(findContact(ref.store, "a@x.com")!.resolution_reason, "restored_to_semanal");
            assert.equal(findContact(ref.store, "b@x.com")!.resolution_reason, "restored_to_semanal");
            assert.equal(findContact(ref.store, "c@x.com")!.status, "suppressed");
            } catch (e) {
              inner = e;
            }
          }
        },
        kitStateByEmail: async () => "inactive",
        appendLog: () => {},
        nowIso: () => "2026-11-09T00:00:00Z",
      };
      await runRestoreSemanal({ apply: true, listId: 7, semanal: on }, deps);
    });
    assert.ok(signalled);
    if (inner) throw inner;
    assert.equal(process.listeners("SIGINT").length, beforeInt.length, "handler de SIGINT removido no fim");
    assert.equal(process.listenerCount("SIGTERM"), beforeTerm, "handler de SIGTERM removido no fim");
  });

  it("restore-kit-sem-abertura-frio: SIGINT no 3º contato grava os 2 já convertidos", async () => {
    const frioOn = parseKitFrio({
      frio: { enabled: true, semanal_enabled: true, segmento_exclui_frio_confirmado: true },
      diaria_exclusion_segment: { enabled: true, segment_id: 599796 },
    });
    const ref = {
      store: { contacts: [contact("a@x.com", "kit-sem-abertura:1"), contact("b@x.com", "kit-sem-abertura:2"), contact("c@x.com", "kit-sem-abertura:3")] } as BrevoDiariaStore,
      writes: 0,
    };
    const beforeInt = process.listeners("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    let unlinks = 0;
    let signalled = false;
    let inner: unknown = null;
    await withStubbedExit(async (exits) => {
      const deps: KitRestoreDeps = {
        log: () => {},
        getKit: async () => ({ state: "active", tagNames: ["envio-brevo"] }),
        findTagId: async (n) => (n === "frio" ? 900 : 555),
        tag: async () => {},
        untag: async () => {},
        unlinkBrevo: async () => {
          unlinks++;
          if (unlinks === 3 && !signalled) {
            signalled = true;
            // O script engole exceção por contato: o assert falho vai para `inner`.
            try {
            assert.equal(process.listenerCount("SIGTERM"), beforeTerm + 1);
            fireNewSigint(beforeInt);
            assert.deepEqual(exits, [130]);
            assert.equal(ref.writes, 1, "o handler gravou o pendente");
            assert.equal(findContact(ref.store, "a@x.com")!.resolution_reason, "kit_sem_abertura_frio");
            assert.equal(findContact(ref.store, "b@x.com")!.resolution_reason, "kit_sem_abertura_frio");
            assert.equal(findContact(ref.store, "c@x.com")!.status, "in_brevo");
            } catch (e) {
              inner = e;
            }
          }
        },
        readStore: () => ref.store,
        writeStore: (s) => {
          ref.store = s;
          ref.writes++;
        },
        writePanelList: () => {},
        appendLog: () => {},
        nowIso: () => "2026-11-09T00:00:00Z",
      };
      await runKitSemAberturaRestore(
        [
          { email: "a@x.com", kitSubscriberId: 1, source: "in_brevo" },
          { email: "b@x.com", kitSubscriberId: 2, source: "in_brevo" },
          { email: "c@x.com", kitSubscriberId: 3, source: "in_brevo" },
        ],
        { apply: true, frio: frioOn },
        deps,
      );
    });
    assert.ok(signalled);
    if (inner) throw inner;
    assert.equal(process.listeners("SIGINT").length, beforeInt.length, "handler de SIGINT removido no fim");
    assert.equal(process.listenerCount("SIGTERM"), beforeTerm, "handler de SIGTERM removido no fim");
  });
});
