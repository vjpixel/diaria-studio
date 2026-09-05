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
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  fetchReports,
  alarmFindingsFor,
  DEFAULT_GMAIL_QUERY,
  buildAlignedPctHistoryEntries,
  appendAlignedPctHistory,
} from "../scripts/dmarc-drain.ts";
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

// ─── alignedPct history (#7334, #6690) ──────────────────────────────────────

test("buildAlignedPctHistoryEntries produz 1 entrada por domínio com os campos da série", async () => {
  const xml = readFixture("google-multi-record.xml");
  const { reports } = await fetchReports("q", async () => [{ buf: Buffer.from(xml, "utf8"), filename: "x.xml", messageId: "m1" }]);
  const summaries = aggregateDmarcReports(reports);
  const recordedAt = "2026-09-05T12:00:00.000Z";

  const entries = buildAlignedPctHistoryEntries(summaries, recordedAt);
  assert.equal(entries.length, summaries.length);
  for (const [i, entry] of entries.entries()) {
    const s = summaries[i];
    assert.equal(entry.recordedAt, recordedAt);
    assert.equal(entry.domain, s.domain);
    assert.equal(entry.reportCount, s.reportCount);
    assert.equal(entry.windowBegin, s.windowBegin);
    assert.equal(entry.windowEnd, s.windowEnd);
    assert.equal(entry.totalMessages, s.totalMessages);
    assert.equal(entry.alignedMessages, s.alignedMessages);
    assert.equal(entry.alignedPct, s.alignedPct);
  }
});

test("buildAlignedPctHistoryEntries com summaries vazio retorna array vazio", () => {
  assert.deepEqual(buildAlignedPctHistoryEntries([], "2026-09-05T12:00:00.000Z"), []);
});

test("appendAlignedPctHistory acrescenta 1 linha JSONL por entrada, preservando execuções anteriores", () => {
  const dir = mkdtempSync(join(tmpdir(), "dmarc-aligned-pct-"));
  const path = join(dir, "sub", "dmarc-aligned-pct.jsonl"); // dir intermediário ausente de propósito — cobre o mkdirSync
  try {
    const run1 = buildAlignedPctHistoryEntries(
      [{ domain: "news.diar.ia.br", reportCount: 1, windowBegin: 100, windowEnd: 200, totalMessages: 10, spfRawPassMessages: 10, dkimRawPassMessages: 10, alignedMessages: 9, spfRawPassPct: 100, dkimRawPassPct: 100, alignedPct: 90, failedAlignmentSources: [] }],
      "2026-09-01T00:00:00.000Z",
    );
    const run2 = buildAlignedPctHistoryEntries(
      [{ domain: "news.diar.ia.br", reportCount: 1, windowBegin: 300, windowEnd: 400, totalMessages: 20, spfRawPassMessages: 20, dkimRawPassMessages: 20, alignedMessages: 20, spfRawPassPct: 100, dkimRawPassPct: 100, alignedPct: 100, failedAlignmentSources: [] }],
      "2026-09-02T00:00:00.000Z",
    );

    appendAlignedPctHistory(run1, path);
    appendAlignedPctHistory(run2, path);

    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.equal(parsed[0].recordedAt, "2026-09-01T00:00:00.000Z");
    assert.equal(parsed[0].alignedPct, 90);
    assert.equal(parsed[1].recordedAt, "2026-09-02T00:00:00.000Z");
    assert.equal(parsed[1].alignedPct, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendAlignedPctHistory com entries vazio não cria/toca o arquivo", () => {
  const dir = mkdtempSync(join(tmpdir(), "dmarc-aligned-pct-"));
  const path = join(dir, "dmarc-aligned-pct.jsonl");
  try {
    appendAlignedPctHistory([], path);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #6229 — o remetente do Google na query não tinha NENHUM teste, e foi assim
// que uma regressão passou: o commit `cbf58581` trocou
// `noreply-dmarc-support@google.com` (medido ao vivo, 1 resultado na caixa)
// por `dmarcreport@google.com` (0 resultados), e nada acusou — o relatório
// continuava sendo encontrado pela cláusula `subject:`, por outro caminho.
test("query default mantém o remetente do Google MEDIDO ao vivo", () => {
  assert.match(
    DEFAULT_GMAIL_QUERY,
    /from:noreply-dmarc-support@google\.com/,
    "remetente medido na caixa real (1 resultado em 120d) — não remover sem repetir a medição",
  );
});

test("query default não depende só de `subject:` pra achar relatório do Google", () => {
  // O modo de falha do cbf58581 não foi a busca parar de funcionar — foi ela
  // passar a depender inteiramente de uma cláusula que casa por acaso. Se um
  // dia o assunto mudar de formato, ou chegar relatório de domínio fora da
  // lista, sem `from:` correto não se acha nada.
  const semSubject = DEFAULT_GMAIL_QUERY.replace(/subject:"[^"]*"( OR )?/g, "");
  assert.match(semSubject, /from:noreply-dmarc-support@google\.com/);
});
