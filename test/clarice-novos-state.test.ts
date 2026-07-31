/**
 * test/clarice-novos-state.test.ts (#4347 Etapa 4)
 *
 * Estado da skill `/diaria-clarice-novos`: skip de test email por SHA-256
 * idêntico (D12) e resolução de --key idempotente por dia.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  readNovosState,
  writeNovosState,
  novosStatePath,
  sha256Hex,
  shouldSendTest,
  resolveNovosKey,
  type NovosState,
} from "../scripts/lib/clarice-novos-state.ts";

// ---------------------------------------------------------------------------
// readNovosState / writeNovosState
// ---------------------------------------------------------------------------

test("readNovosState: arquivo ausente -> null (1ª rodada)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "novos-state-empty-"));
  assert.equal(readNovosState(dir), null);
});

test("readNovosState: JSON corrompido -> null (tolerante, nunca lança)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "novos-state-corrupt-"));
  writeFileSync(novosStatePath(dir), "{ não é json", "utf8");
  assert.equal(readNovosState(dir), null);
});

test("writeNovosState + readNovosState: round-trip preserva os campos", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "novos-state-roundtrip-"));
  const state: NovosState = {
    lastRunAt: "2026-07-30T10:00:00.000Z",
    lastHtmlSha256: "abc123",
    lastCycle: "2606-07",
    lastListId: 42,
    lastCampaignId: 99,
    sentCount: 37,
  };
  writeNovosState(state, dir);
  assert.ok(existsSync(novosStatePath(dir)));
  assert.deepEqual(readNovosState(dir), state);
});

// ---------------------------------------------------------------------------
// shouldSendTest (D12)
// ---------------------------------------------------------------------------

test("shouldSendTest: state ausente (1ª rodada) -> sempre manda test email", () => {
  assert.equal(shouldSendTest("sha-novo", null), true);
});

test("shouldSendTest: SHA IDÊNTICO ao da última rodada -> pula (D12)", () => {
  const state: NovosState = { lastRunAt: "x", lastHtmlSha256: "sha-igual", lastCycle: null, lastListId: null, lastCampaignId: null, sentCount: 0 };
  assert.equal(shouldSendTest("sha-igual", state), false);
});

test("shouldSendTest: SHA DIFERENTE -> manda de novo", () => {
  const state: NovosState = { lastRunAt: "x", lastHtmlSha256: "sha-antigo", lastCycle: null, lastListId: null, lastCampaignId: null, sentCount: 0 };
  assert.equal(shouldSendTest("sha-novo", state), true);
});

test("shouldSendTest: state existe mas SEM lastHtmlSha256 (versão antiga) -> fail-safe, manda", () => {
  const state: NovosState = { lastRunAt: "x", lastHtmlSha256: null, lastCycle: null, lastListId: null, lastCampaignId: null, sentCount: 0 };
  assert.equal(shouldSendTest("sha-qualquer", state), true);
});

test("sha256Hex: determinístico, muda com o conteúdo", () => {
  const a = sha256Hex("<html>A</html>");
  const b = sha256Hex("<html>A</html>");
  const c = sha256Hex("<html>B</html>");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64); // hex de 32 bytes
});

// ---------------------------------------------------------------------------
// resolveNovosKey — idempotência por dia
// ---------------------------------------------------------------------------

test("resolveNovosKey: 1ª rodada do dia -> novos-{AAMMDD} sem sufixo", () => {
  assert.equal(resolveNovosKey([], "260730"), "novos-260730");
});

test("resolveNovosKey: key base já existe -> sufixo -2", () => {
  assert.equal(resolveNovosKey(["novos-260730"], "260730"), "novos-260730-2");
});

test("resolveNovosKey: -2 também já existe -> avança pra -3", () => {
  assert.equal(resolveNovosKey(["novos-260730", "novos-260730-2"], "260730"), "novos-260730-3");
});

test("resolveNovosKey: não colide com key de outro dia", () => {
  assert.equal(resolveNovosKey(["novos-260729"], "260730"), "novos-260730");
});
