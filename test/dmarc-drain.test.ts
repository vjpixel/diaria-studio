// test/dmarc-drain.test.ts (#6189)
//
// Cobre a costura injetável de scripts/dmarc-drain.ts — `fetchReports`
// recebe um `fetchAttachmentsImpl` fake (nunca toca o Gmail real em teste)
// e `alarmFindingsFor` (pura, decide se algo dispara alarme). O caminho
// real de rede (`fetchDmarcAttachments`, via `gFetch`/Gmail API) não é
// exercitado aqui — não há credencial OAuth disponível em CI/worktree; ver
// docstring do módulo e o PR body pra essa costura.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { fetchReports, alarmFindingsFor } from "../scripts/dmarc-drain.ts";
import { aggregateDmarcReports } from "../scripts/lib/dmarc-report.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = resolve(ROOT, "test", "fixtures", "dmarc");

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), "utf8");
}

test("fetchReports desempacota+parseia todo anexo devolvido pelo fetchAttachmentsImpl fake", async () => {
  const xml1 = readFixture("google-multi-record.xml");
  const xml2 = readFixture("yahoo-single-record-day2.xml");
  const fake = async () => [
    { buf: gzipSync(Buffer.from(xml1, "utf8")), filename: "google.xml.gz", messageId: "m1" },
    { buf: Buffer.from(xml2, "utf8"), filename: "yahoo.xml", messageId: "m2" },
  ];

  const result = await fetchReports("query irrelevante em teste", fake);
  assert.equal(result.reports.length, 2);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(
    result.reports.map((r) => r.orgName).sort(),
    ["Yahoo", "google.com"],
  );
});

test("fetchReports acumula erro por anexo malformado sem derrubar os demais (fail-soft por item)", async () => {
  const xml1 = readFixture("google-multi-record.xml");
  const fake = async () => [
    { buf: Buffer.from(xml1, "utf8"), filename: "ok.xml", messageId: "m1" },
    { buf: Buffer.from("isto nao e xml dmarc"), filename: "quebrado.xml", messageId: "m2" },
  ];

  const result = await fetchReports("q", fake);
  assert.equal(result.reports.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].messageId, "m2");
  assert.match(result.errors[0].error, /feedback/);
});

test("fetchReports com zero anexos retorna listas vazias, sem lançar", async () => {
  const result = await fetchReports("q", async () => []);
  assert.deepEqual(result.reports, []);
  assert.deepEqual(result.errors, []);
});

// ─── alarmFindingsFor ────────────────────────────────────────────────────────

test("alarmFindingsFor NÃO dispara achado pra domínio 100% alinhado", async () => {
  const xml = readFixture("yahoo-single-record-day2.xml"); // 1 record, totalmente alinhado
  const { reports } = await fetchReports("q", async () => [{ buf: Buffer.from(xml, "utf8"), filename: "x.xml", messageId: "m1" }]);
  const summaries = aggregateDmarcReports(reports);
  assert.deepEqual(alarmFindingsFor(summaries), []);
});

test("alarmFindingsFor dispara 1 achado por domínio com volume não-alinhado > 0", async () => {
  const xml = readFixture("google-multi-record.xml"); // tem 2 records não-alinhados (5 + 1 msgs)
  const { reports } = await fetchReports("q", async () => [{ buf: Buffer.from(xml, "utf8"), filename: "x.xml", messageId: "m1" }]);
  const summaries = aggregateDmarcReports(reports);
  const findings = alarmFindingsFor(summaries);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, "dmarc-drain");
  assert.equal(findings[0].fingerprint, "news.diar.ia.br");
  assert.equal(findings[0].family, "estado");
  assert.match(findings[0].body, /198\.51\.100\.7/);
  assert.match(findings[0].body, /6 mensagem/); // 5 + 1 não alinhadas
});
