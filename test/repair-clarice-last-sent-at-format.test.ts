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

// #8043 review — day/month dentro de 1-31/1-12 isoladamente não garante uma
// data de CALENDÁRIO real (30 de fevereiro, 31 de abril). round-trip via
// Date.UTC pega isso.
test("repairAmbiguousDmyDate: dia/mês individualmente válidos mas data de calendário impossível → null (#8043)", () => {
  assert.equal(repairAmbiguousDmyDate("30-02-2026 00:00:00"), null, "30 de fevereiro não existe");
  assert.equal(repairAmbiguousDmyDate("31-04-2026 00:00:00"), null, "abril tem 30 dias");
  assert.equal(repairAmbiguousDmyDate("29-02-2027 00:00:00"), null, "2027 não é bissexto");
});

test("repairAmbiguousDmyDate: 29 de fevereiro em ano bissexto é aceito", () => {
  assert.equal(repairAmbiguousDmyDate("29-02-2028 12:00:00"), "2028-02-29T12:00:00.000Z");
});

test("repairAmbiguousDmyDate: formato que não bate exatamente (ISO já correto, texto solto, etc.) → null", () => {
  assert.equal(repairAmbiguousDmyDate("2026-09-03T06:11:16.000Z"), null, "já é ISO — não é o formato ambíguo alvo deste reparo");
  assert.equal(repairAmbiguousDmyDate("N/A"), null);
  assert.equal(repairAmbiguousDmyDate(""), null);
});

test("findLastSentAtRepairs: identifica reparos aplicáveis, ignora as já corretas e as nulas, sinaliza as não-reparáveis à parte (#8043)", () => {
  const rows = [
    { email: "a@x.com", last_sent_at: "03-09-2026 06:11:16" }, // corrompido, DD-MM válido → reparável
    { email: "b@x.com", last_sent_at: "2026-08-21T12:02:26.200Z" }, // já ISO — ignorado
    { email: "c@x.com", last_sent_at: null }, // nunca enviado — ignorado
    { email: "d@x.com", last_sent_at: "lixo-ilegivel" }, // fora do padrão ISO E fora do DD-MM — não reparável, mas sinalizado
  ];
  const { repairs, unrepairable } = findLastSentAtRepairs(rows);
  assert.equal(repairs.length, 1);
  assert.deepEqual(repairs[0], { email: "a@x.com", before: "03-09-2026 06:11:16", after: "2026-09-03T06:11:16.000Z" });
  assert.deepEqual(unrepairable, [{ email: "d@x.com", value: "lixo-ilegivel" }], "#8043: linha corrompida-mas-não-reparável nunca fica invisível");
});

test("findLastSentAtRepairs: lista vazia → nenhum reparo, nenhum não-reparável, não lança", () => {
  assert.deepEqual(findLastSentAtRepairs([]), { repairs: [], unrepairable: [] });
});
