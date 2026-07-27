/**
 * #4063: scripts/postmaster-spam-entry.ts — registro manual do spamRate
 * diário do Google Postmaster Tools (painel, sem API disponível hoje) que o
 * breaker de spam da Rampa consome com precedência sobre `complaints` da
 * Brevo (ver resolveSpamSignal em workers/brevo-dashboard/src/thresholds.ts).
 *
 * Cobre só `buildPostmasterSpamEntry` (parte pura/testável, sem I/O de KV).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPostmasterSpamEntry, POSTMASTER_SPAM_KV_KEY } from "../scripts/postmaster-spam-entry.ts";

const NOW = new Date("2026-07-27T09:00:00.000Z");

test("buildPostmasterSpamEntry — monta a entrada a partir de --rate/--date", () => {
  const entry = buildPostmasterSpamEntry("1.02", "2026-07-27", NOW);
  assert.deepEqual(entry, {
    date: "2026-07-27",
    spamRatePct: 1.02,
    recordedAt: NOW.toISOString(),
  });
});

test("buildPostmasterSpamEntry — --date omitido usa a data local de hoje (não UTC)", () => {
  const entry = buildPostmasterSpamEntry("0.5", "", NOW);
  // `date` deve ser preenchida (não vazia) mesmo sem --date explícito.
  assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(entry.spamRatePct, 0.5);
});

test("buildPostmasterSpamEntry — --rate vazio/não-numérico lança erro explícito", () => {
  assert.throws(() => buildPostmasterSpamEntry("", "2026-07-27", NOW), /inválido/);
  assert.throws(() => buildPostmasterSpamEntry("abc", "2026-07-27", NOW), /inválido/);
  assert.throws(() => buildPostmasterSpamEntry("NaN", "2026-07-27", NOW), /inválido/);
});

test("buildPostmasterSpamEntry — --rate fora da faixa 0-100 lança erro explícito", () => {
  assert.throws(() => buildPostmasterSpamEntry("-1", "2026-07-27", NOW), /faixa/);
  assert.throws(() => buildPostmasterSpamEntry("101", "2026-07-27", NOW), /faixa/);
});

test("buildPostmasterSpamEntry — recordedAt é sempre `now` (ISO), independente de --date", () => {
  const entry = buildPostmasterSpamEntry("2", "2020-01-01", NOW);
  assert.equal(entry.recordedAt, NOW.toISOString());
  assert.equal(entry.date, "2020-01-01");
});

test("POSTMASTER_SPAM_KV_KEY — chave KV estável esperada pelo worker (ver workers/brevo-dashboard/src/types.ts)", () => {
  assert.equal(POSTMASTER_SPAM_KV_KEY, "postmaster:spam");
});
