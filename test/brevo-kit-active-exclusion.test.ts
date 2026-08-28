/**
 * test/brevo-kit-active-exclusion.test.ts (#6485)
 *
 * Regressão do guard: contato ativo no Kit não entra no payload da campanha
 * Brevo (é removido da lista antes do dispatch); `EDITOR_SEED_EMAILS`
 * continua na lista mesmo sendo ativo nas duas pontas (sonda proposital).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeKitActiveExclusions,
  appendKitExclusionLog,
  applyKitActiveExclusionGuard,
  DEFAULT_KIT_EXCLUSION_LOG_PATH,
  type KitActiveExclusionDeps,
  type KitExclusionLogEntry,
} from "../scripts/lib/brevo-kit-active-exclusion.ts";
import {
  applyConvertedToKit,
  upsertIngested,
  findContact,
  type BrevoDiariaStore,
} from "../scripts/lib/brevo-diaria-store.ts";
import { EDITOR_SEED_EMAILS } from "../scripts/lib/editor-copy.ts";

describe("computeKitActiveExclusions (#6485)", () => {
  it("exclui e-mail presente na lista Brevo E ativo no Kit", () => {
    const excluded = computeKitActiveExclusions({
      brevoListEmails: ["sumaya.lima@gmail.com", "outro@example.com"],
      kitActiveEmails: ["sumaya.lima@gmail.com"],
      seedEmails: [],
    });
    assert.deepEqual(excluded, ["sumaya.lima@gmail.com"]);
  });

  it("case-insensitive — capitalização diferente entre os dois backends ainda casa", () => {
    const excluded = computeKitActiveExclusions({
      brevoListEmails: ["Sumaya.Lima@Gmail.com"],
      kitActiveEmails: ["sumaya.lima@gmail.com"],
      seedEmails: [],
    });
    assert.deepEqual(excluded, ["sumaya.lima@gmail.com"]);
  });

  it("NÃO exclui quem está só no Kit (não está na lista Brevo)", () => {
    const excluded = computeKitActiveExclusions({
      brevoListEmails: ["outro@example.com"],
      kitActiveEmails: ["sumaya.lima@gmail.com"],
      seedEmails: [],
    });
    assert.deepEqual(excluded, []);
  });

  it("NÃO exclui quem está só na Brevo (não é ativo no Kit)", () => {
    const excluded = computeKitActiveExclusions({
      brevoListEmails: ["sumaya.lima@gmail.com"],
      kitActiveEmails: [],
      seedEmails: [],
    });
    assert.deepEqual(excluded, []);
  });

  it("EDITOR_SEED_EMAILS NUNCA são excluídos, mesmo ativos nas duas pontas (default seedEmails)", () => {
    const seed = EDITOR_SEED_EMAILS[0];
    const excluded = computeKitActiveExclusions({
      brevoListEmails: [seed, "sumaya.lima@gmail.com"],
      kitActiveEmails: [seed, "sumaya.lima@gmail.com"],
    });
    assert.deepEqual(excluded, ["sumaya.lima@gmail.com"]);
    assert.ok(!excluded.includes(seed.toLowerCase()));
  });

  it("seed explícito (case diferente) também é isento", () => {
    const excluded = computeKitActiveExclusions({
      brevoListEmails: ["Editor@Example.com", "real@example.com"],
      kitActiveEmails: ["editor@example.com", "real@example.com"],
      seedEmails: ["editor@example.com"],
    });
    assert.deepEqual(excluded, ["real@example.com"]);
  });

  it("lista vazia de qualquer lado → nenhuma exclusão", () => {
    assert.deepEqual(
      computeKitActiveExclusions({ brevoListEmails: [], kitActiveEmails: ["x@example.com"], seedEmails: [] }),
      [],
    );
    assert.deepEqual(
      computeKitActiveExclusions({ brevoListEmails: ["x@example.com"], kitActiveEmails: [], seedEmails: [] }),
      [],
    );
  });
});

describe("applyConvertedToKit (brevo-diaria-store.ts, #6485)", () => {
  it("marca contato in_brevo como converted_to_kit com resolution_reason correto", () => {
    let store: BrevoDiariaStore = { contacts: [] };
    store = upsertIngested(store, { email: "sumaya.lima@gmail.com", beehiiv_subscription_id: "sub-1" });
    const now = "2026-08-28T12:00:00.000Z";
    store = applyConvertedToKit(store, "sumaya.lima@gmail.com", now);
    const contact = findContact(store, "sumaya.lima@gmail.com");
    assert.equal(contact?.status, "converted_to_kit");
    assert.equal(contact?.converted_to_kit_at, now);
    assert.equal(contact?.resolution_reason, "converted_to_kit");
  });

  it("é noop pra contato já resolvido (nunca regride status terminal)", () => {
    let store: BrevoDiariaStore = { contacts: [] };
    store = upsertIngested(store, { email: "x@example.com", beehiiv_subscription_id: "sub-2" });
    store = applyConvertedToKit(store, "x@example.com", "2026-08-28T00:00:00.000Z");
    const before = findContact(store, "x@example.com");
    store = applyConvertedToKit(store, "x@example.com", "2026-08-29T00:00:00.000Z");
    const after = findContact(store, "x@example.com");
    assert.deepEqual(after, before);
  });

  it("é noop pra e-mail ausente do store", () => {
    const store: BrevoDiariaStore = { contacts: [] };
    const result = applyConvertedToKit(store, "ausente@example.com");
    assert.deepEqual(result, store);
  });
});

describe("appendKitExclusionLog (#6485)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("grava jsonl append-only e cria o diretório pai", () => {
    dir = mkdtempSync(join(tmpdir(), "kit-exclusion-log-"));
    const logPath = join(dir, "nested", "kit-exclusion-log.jsonl");
    const entry: KitExclusionLogEntry = {
      email: "sumaya.lima@gmail.com",
      excluded_at: "2026-08-28T12:00:00.000Z",
      brevo_list_id: 7,
      origem: "kit-active-exclusion",
    };
    appendKitExclusionLog(entry, logPath);
    appendKitExclusionLog({ ...entry, email: "eduardo.britto@wero.com.br" }, logPath);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), entry);
  });

  it("DEFAULT_KIT_EXCLUSION_LOG_PATH aponta pra data/brevo-diaria/", () => {
    assert.match(DEFAULT_KIT_EXCLUSION_LOG_PATH, /data[/\\]brevo-diaria[/\\]kit-exclusion-log\.jsonl$/);
  });
});

describe("applyKitActiveExclusionGuard (I/O mockado, #6485)", () => {
  function buildDeps(overrides: Partial<KitActiveExclusionDeps> = {}): {
    deps: KitActiveExclusionDeps;
    calls: { removed: string[][]; loggedEmails: string[]; writtenStores: BrevoDiariaStore[] };
  } {
    const calls = { removed: [] as string[][], loggedEmails: [] as string[], writtenStores: [] as BrevoDiariaStore[] };
    let store: BrevoDiariaStore = { contacts: [] };
    store = upsertIngested(store, { email: "sumaya.lima@gmail.com", beehiiv_subscription_id: "sub-1" });
    store = upsertIngested(store, { email: "eduardo.britto@wero.com.br", beehiiv_subscription_id: "sub-2" });
    const deps: KitActiveExclusionDeps = {
      fetchBrevoListEmails: async () => [
        "sumaya.lima@gmail.com",
        "eduardo.britto@wero.com.br",
        "keep@example.com",
        ...EDITOR_SEED_EMAILS,
      ],
      fetchKitActiveEmails: async () => ["sumaya.lima@gmail.com", "eduardo.britto@wero.com.br", ...EDITOR_SEED_EMAILS],
      removeFromBrevoList: async (_apiKey, _listId, emails) => {
        calls.removed.push(emails);
        return { contacts: { success: emails, failure: [] } };
      },
      readStore: () => store,
      writeStore: (s) => {
        store = s;
        calls.writtenStores.push(s);
      },
      appendLog: (entry) => calls.loggedEmails.push(entry.email),
      now: () => "2026-08-28T12:00:00.000Z",
      ...overrides,
    };
    return { deps, calls };
  }

  it("remove contatos ativos no Kit da lista Brevo, exceto seeds", async () => {
    const { deps, calls } = buildDeps();
    const result = await applyKitActiveExclusionGuard(
      { brevoApiKey: "key", brevoListId: 7 },
      deps,
    );
    assert.deepEqual(result.excluded, ["eduardo.britto@wero.com.br", "sumaya.lima@gmail.com"]);
    assert.deepEqual(result.removedFromList, ["eduardo.britto@wero.com.br", "sumaya.lima@gmail.com"]);
    assert.equal(calls.removed.length, 1);
    assert.deepEqual(calls.removed[0].sort(), ["eduardo.britto@wero.com.br", "sumaya.lima@gmail.com"]);
    // seeds nunca aparecem na chamada de remoção
    for (const seed of EDITOR_SEED_EMAILS) {
      assert.ok(!calls.removed[0].includes(seed.toLowerCase()));
    }
  });

  it("marca converted_to_kit no store só pros e-mails confirmados removidos", async () => {
    const { deps, calls } = buildDeps();
    await applyKitActiveExclusionGuard({ brevoApiKey: "key", brevoListId: 7 }, deps);
    const finalStore = calls.writtenStores.at(-1)!;
    assert.equal(findContact(finalStore, "sumaya.lima@gmail.com")?.status, "converted_to_kit");
    assert.equal(findContact(finalStore, "eduardo.britto@wero.com.br")?.status, "converted_to_kit");
    assert.deepEqual(calls.loggedEmails.sort(), ["eduardo.britto@wero.com.br", "sumaya.lima@gmail.com"]);
  });

  it("seed do editor continua entrando — nunca é removido nem logado", async () => {
    const { deps, calls } = buildDeps();
    await applyKitActiveExclusionGuard({ brevoApiKey: "key", brevoListId: 7 }, deps);
    for (const seed of EDITOR_SEED_EMAILS) {
      assert.ok(!calls.loggedEmails.includes(seed.toLowerCase()));
    }
  });

  it("no-op completo (sem chamar remove/log/write) quando não há interseção", async () => {
    const { deps, calls } = buildDeps({
      fetchBrevoListEmails: async () => ["keep@example.com", ...EDITOR_SEED_EMAILS],
      fetchKitActiveEmails: async () => ["outro-kit@example.com"],
    });
    const result = await applyKitActiveExclusionGuard({ brevoApiKey: "key", brevoListId: 7 }, deps);
    assert.deepEqual(result, { excluded: [], removedFromList: [], failedToRemove: [] });
    assert.equal(calls.removed.length, 0);
    assert.equal(calls.loggedEmails.length, 0);
  });

  it("não marca converted_to_kit pra quem a Brevo recusou remover (failure)", async () => {
    const { deps, calls } = buildDeps({
      removeFromBrevoList: async (_apiKey, _listId, emails) => ({
        contacts: { success: ["sumaya.lima@gmail.com"], failure: emails.filter((e) => e !== "sumaya.lima@gmail.com") },
      }),
    });
    const result = await applyKitActiveExclusionGuard({ brevoApiKey: "key", brevoListId: 7 }, deps);
    assert.deepEqual(result.failedToRemove, ["eduardo.britto@wero.com.br"]);
    const finalStore = calls.writtenStores.at(-1)!;
    assert.equal(findContact(finalStore, "sumaya.lima@gmail.com")?.status, "converted_to_kit");
    assert.notEqual(findContact(finalStore, "eduardo.britto@wero.com.br")?.status, "converted_to_kit");
    assert.deepEqual(calls.loggedEmails, ["sumaya.lima@gmail.com"]);
  });
});
