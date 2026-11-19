import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPersistentQuotaProviders } from "../scripts/lib/geo-citation-monitor.ts";

const q = (date: string, provider: string, ok = false, errorKind = "quota") =>
  ({ date, provider, error: ok ? undefined : "x", errorKind: ok ? undefined : errorKind }) as never;

test("provider 100% quota por 2 rodadas seguidas dispara (#13634)", () => {
  const recs = [q("2026-11-08", "openai"), q("2026-11-08", "openai"), q("2026-11-15", "openai"), q("2026-11-15", "google", true)];
  assert.deepEqual(detectPersistentQuotaProviders(recs), ["openai"]);
});

test("1 rodada só não dispara", () => {
  assert.deepEqual(detectPersistentQuotaProviders([q("2026-11-15", "openai")]), []);
});

test("rodada com resposta válida quebra a sequência", () => {
  const recs = [q("2026-11-08", "openai"), q("2026-11-08", "openai", true), q("2026-11-15", "openai")];
  assert.deepEqual(detectPersistentQuotaProviders(recs), []);
});

test("erro de outra causa não conta como cota", () => {
  const recs = [q("2026-11-08", "openai", false, "network"), q("2026-11-15", "openai")];
  assert.deepEqual(detectPersistentQuotaProviders(recs), []);
});

test("rodada antiga boa seguida de 2 de cota dispara", () => {
  const recs = [q("2026-10-18", "openai", true), q("2026-11-08", "openai"), q("2026-11-15", "openai")];
  assert.deepEqual(detectPersistentQuotaProviders(recs), ["openai"]);
});
