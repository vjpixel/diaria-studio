import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCuratedBatch,
  selectCuratedCandidates,
  decideFromMvBucket,
  summarizeSkips,
} from "../scripts/lib/curated-batch-import.ts";
import { resolveBrevoDiariaTarget } from "../scripts/lib/brevo-diaria-target.ts";

describe("parseCuratedBatch (#5841)", () => {
  it("aceita o formato de descadastrados-manuais-2607.json e normaliza o e-mail", () => {
    const { entries, skipped } = parseCuratedBatch([
      { email: "  Fulano@Example.COM ", received: 105, opened: 2, clicked: 0 },
      { email: "outro@example.com", received: 75, opened: 0, clicked: 3 },
    ]);
    assert.equal(skipped.length, 0);
    assert.deepEqual(
      entries.map((e) => e.email),
      ["fulano@example.com", "outro@example.com"],
    );
    assert.equal(entries[0].received, 105);
    assert.equal(entries[1].clicked, 3);
  });

  it("pula linha malformada em vez de derrubar o lote inteiro", () => {
    const { entries, skipped } = parseCuratedBatch([
      { email: "bom@example.com" },
      { email: "sem-arroba" },
      { received: 10 },
      { email: "com espaco@example.com" },
    ]);
    assert.deepEqual(entries.map((e) => e.email), ["bom@example.com"]);
    assert.equal(skipped.length, 3);
    assert.ok(skipped.every((s) => s.reason === "email_invalido"));
  });

  it("marca duplicata dentro do próprio arquivo", () => {
    const { entries, skipped } = parseCuratedBatch([
      { email: "a@example.com" },
      { email: "A@EXAMPLE.COM" },
    ]);
    assert.equal(entries.length, 1);
    assert.deepEqual(skipped, [{ email: "a@example.com", reason: "duplicado_no_arquivo" }]);
  });

  it("JSON que não é array vira skip explícito, nunca crash", () => {
    const { entries, skipped } = parseCuratedBatch({ contatos: [] });
    assert.equal(entries.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(String(skipped[0].detail), /não é um array/);
  });
});

describe("selectCuratedCandidates (#5841)", () => {
  const entry = (email: string, clicked = 0) => ({ email, received: 50, opened: 1, clicked });

  it("dedup pelo store acontece ANTES do cap — contato já tratado não consome slot", () => {
    const { selected, skipped } = selectCuratedCandidates({
      entries: [entry("ja@x.com"), entry("novo1@x.com"), entry("novo2@x.com")],
      storeEmails: ["JA@X.COM"],
      availableSlots: 2,
    });
    assert.deepEqual(selected.map((e) => e.email), ["novo1@x.com", "novo2@x.com"]);
    assert.deepEqual(skipped, [{ email: "ja@x.com", reason: "ja_no_store" }]);
  });

  it("excedente do cap fica como sem_slot_na_fila (elegível na próxima rodada)", () => {
    const { selected, skipped } = selectCuratedCandidates({
      entries: [entry("a@x.com"), entry("b@x.com"), entry("c@x.com")],
      storeEmails: [],
      availableSlots: 1,
    });
    assert.deepEqual(selected.map((e) => e.email), ["a@x.com"]);
    assert.deepEqual(
      skipped.map((s) => s.reason),
      ["sem_slot_na_fila", "sem_slot_na_fila"],
    );
  });

  it("cap zero (ou negativo) não seleciona ninguém", () => {
    for (const slots of [0, -5]) {
      const { selected, skipped } = selectCuratedCandidates({
        entries: [entry("a@x.com")],
        storeEmails: [],
        availableSlots: slots,
      });
      assert.equal(selected.length, 0, `slots=${slots}`);
      assert.equal(skipped.length, 1);
    }
  });
});

describe("decideFromMvBucket (#1297)", () => {
  it("só verified entra; rejected e unknown ficam de fora", () => {
    assert.deepEqual(decideFromMvBucket("verified"), { ingest: true });
    assert.deepEqual(decideFromMvBucket("rejected"), { ingest: false, reason: "mv_rejected" });
    // unknown é conservador de propósito: lote de não-assinantes, bounce custa
    // mais que deixar endereço duvidoso de fora.
    assert.deepEqual(decideFromMvBucket("unknown"), { ingest: false, reason: "mv_unknown" });
  });
});

describe("summarizeSkips", () => {
  it("agrupa por motivo", () => {
    assert.deepEqual(
      summarizeSkips([
        { email: "a", reason: "ja_no_store" },
        { email: "b", reason: "ja_no_store" },
        { email: "c", reason: "mv_rejected" },
      ]),
      { ja_no_store: 2, mv_rejected: 1 },
    );
  });
});

describe("resolveBrevoDiariaTarget (#5843)", () => {
  it("resolve list_id + credencial quando tudo está presente", () => {
    const r = resolveBrevoDiariaTarget({ list_id: 7, api_key_env: "BREVO_X" }, { BREVO_X: "chave" });
    assert.deepEqual(r, { ok: true, listId: 7, apiKey: "chave", apiKeyEnv: "BREVO_X" });
  });

  it("list_id ausente ou inválido NUNCA cai em default — recusa explícita", () => {
    for (const listId of [undefined, 0, -1, "7", 1.5]) {
      const r = resolveBrevoDiariaTarget({ list_id: listId, api_key_env: "BREVO_X" }, { BREVO_X: "chave" });
      assert.equal(r.ok, false, `list_id=${JSON.stringify(listId)} deveria recusar`);
      assert.match(String((r as { reason: string }).reason), /list_id/);
    }
  });

  it("credencial ausente recusa nomeando a variável esperada", () => {
    const r = resolveBrevoDiariaTarget({ list_id: 7, api_key_env: "BREVO_X" }, {});
    assert.equal(r.ok, false);
    assert.match(String((r as { reason: string }).reason), /BREVO_X/);
  });

  it("bloco brevo_diaria ausente recusa", () => {
    const r = resolveBrevoDiariaTarget(undefined, {});
    assert.equal(r.ok, false);
    assert.match(String((r as { reason: string }).reason), /brevo_diaria/);
  });
});
