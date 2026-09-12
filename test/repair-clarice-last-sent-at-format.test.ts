import { test } from "node:test";
import assert from "node:assert/strict";
import { repairAmbiguousDmyDate, findLastSentAtRepairs } from "../scripts/repair-clarice-last-sent-at-format.ts";

// #8033 — reparo dos registros que entraram com last_sent_at no formato
// ambíguo DD-MM-AAAA antes do fix de ingestão existir.

test("repairAmbiguousDmyDate: converte DD-MM-AAAA HH:MM:SS pra ISO UTC", () => {
  assert.equal(repairAmbiguousDmyDate("03-09-2026 06:11:16"), "2026-09-03T06:11:16.000Z");
  assert.equal(repairAmbiguousDmyDate("31-12-2025 23:59:59"), "2025-12-31T23:59:59.000Z");
});

test("repairAmbiguousDmyDate: mês/dia fora de faixa → null (não inventa data)", () => {
  assert.equal(repairAmbiguousDmyDate("32-13-2026 00:00:00"), null);
  assert.equal(repairAmbiguousDmyDate("00-00-2026 00:00:00"), null);
});

test("repairAmbiguousDmyDate: formato que não bate exatamente (ISO já correto, texto solto, etc.) → null", () => {
  assert.equal(repairAmbiguousDmyDate("2026-09-03T06:11:16.000Z"), null, "já é ISO — não é o formato ambíguo alvo deste reparo");
  assert.equal(repairAmbiguousDmyDate("N/A"), null);
  assert.equal(repairAmbiguousDmyDate(""), null);
});

test("findLastSentAtRepairs: identifica só as linhas fora do padrão ISO-like, ignora as já corretas e as nulas", () => {
  const rows = [
    { email: "a@x.com", last_sent_at: "03-09-2026 06:11:16" }, // corrompido → reparável
    { email: "b@x.com", last_sent_at: "2026-08-21T12:02:26.200Z" }, // já ISO — ignorado
    { email: "c@x.com", last_sent_at: null }, // nunca enviado — ignorado
    { email: "d@x.com", last_sent_at: "lixo-ilegivel" }, // fora do padrão ISO mas também não bate DD-MM — não reparável, fica de fora
  ];
  const findings = findLastSentAtRepairs(rows);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], { email: "a@x.com", before: "03-09-2026 06:11:16", after: "2026-09-03T06:11:16.000Z" });
});

test("findLastSentAtRepairs: lista vazia → nenhum reparo, não lança", () => {
  assert.deepEqual(findLastSentAtRepairs([]), []);
});
