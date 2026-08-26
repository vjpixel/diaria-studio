// test/dmarc-report.test.ts (#6189)
//
// Cobre o miolo puro de scripts/lib/dmarc-report.ts contra fixtures XML
// reais (test/fixtures/dmarc/*.xml, formato RFC 7489 Apêndice C) e contra
// ZIP/gzip construídos em memória (byte-a-byte válidos, mesmo layout que
// qualquer ferramenta de zip padrão produz) — não há dependência externa de
// zip neste repo, então o teste do unwrap tem que provar a implementação à
// mão em vez de comparar contra uma lib de terceiro.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, gzipSync } from "node:zlib";
import {
  detectAttachmentKind,
  extractFirstZipEntry,
  unwrapDmarcAttachment,
  parseDmarcXml,
  aggregateDmarcReports,
  renderDmarcSummaryText,
} from "../scripts/lib/dmarc-report.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = resolve(ROOT, "test", "fixtures", "dmarc");

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), "utf8");
}

// ─── Construção de ZIP mínimo válido (stored + deflate) pra teste do unwrap ──

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

/** Monta um ZIP de 1 entry válido (local header + data + central directory +
 * EOCD) — `method` 0 = stored, 8 = deflate. */
function buildZip(fileName: string, content: Buffer, method: 0 | 8): Buffer {
  const data = method === 8 ? deflateRawSync(content) : content;
  const crc = crc32(content);
  const nameBuf = Buffer.from(fileName, "utf8");

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(method, 8);
  localHeader.writeUInt16LE(0, 10); // mod time
  localHeader.writeUInt16LE(0, 12); // mod date
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(data.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28); // extra length

  const localEntry = Buffer.concat([localHeader, nameBuf, data]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4); // version made by
  centralHeader.writeUInt16LE(20, 6); // version needed
  centralHeader.writeUInt16LE(0, 8); // flags
  centralHeader.writeUInt16LE(method, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(data.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt16LE(0, 30); // extra length
  centralHeader.writeUInt16LE(0, 32); // comment length
  centralHeader.writeUInt16LE(0, 34); // disk number
  centralHeader.writeUInt16LE(0, 36); // internal attrs
  centralHeader.writeUInt32LE(0, 38); // external attrs
  centralHeader.writeUInt32LE(0, 42); // local header offset

  const centralEntry = Buffer.concat([centralHeader, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(centralEntry.length, 12);
  eocd.writeUInt32LE(localEntry.length, 16); // central dir offset = right after local entry

  return Buffer.concat([localEntry, centralEntry, eocd]);
}

// ─── detectAttachmentKind ────────────────────────────────────────────────────

test("detectAttachmentKind reconhece zip/gzip/xml pela assinatura de bytes", () => {
  assert.equal(detectAttachmentKind(Buffer.from([0x50, 0x4b, 0x03, 0x04])), "zip");
  assert.equal(detectAttachmentKind(Buffer.from([0x1f, 0x8b, 0x08, 0x00])), "gzip");
  assert.equal(detectAttachmentKind(Buffer.from("<?xml version")), "xml");
  assert.equal(detectAttachmentKind(Buffer.alloc(0)), "xml");
});

// ─── unwrapDmarcAttachment ───────────────────────────────────────────────────

test("unwrapDmarcAttachment desempacota ZIP stored", () => {
  const xml = readFixture("google-multi-record.xml");
  const zip = buildZip("report.xml", Buffer.from(xml, "utf8"), 0);
  assert.equal(unwrapDmarcAttachment(zip), xml);
});

test("unwrapDmarcAttachment desempacota ZIP deflate", () => {
  const xml = readFixture("google-multi-record.xml");
  const zip = buildZip("report.xml", Buffer.from(xml, "utf8"), 8);
  assert.equal(unwrapDmarcAttachment(zip), xml);
});

test("unwrapDmarcAttachment desempacota gzip puro (.xml.gz)", () => {
  const xml = readFixture("yahoo-single-record-day2.xml");
  const gz = gzipSync(Buffer.from(xml, "utf8"));
  assert.equal(unwrapDmarcAttachment(gz), xml);
});

test("unwrapDmarcAttachment passa XML cru direto", () => {
  const xml = readFixture("google-multi-record.xml");
  assert.equal(unwrapDmarcAttachment(Buffer.from(xml, "utf8")), xml);
});

test("extractFirstZipEntry lança em ZIP corrompido (EOCD ausente)", () => {
  assert.throws(() => extractFirstZipEntry(Buffer.from("nao e um zip")), /EOCD/);
});

test("extractFirstZipEntry lança em ZIP com método de compressão não suportado", () => {
  const xml = readFixture("google-multi-record.xml");
  const zip = buildZip("report.xml", Buffer.from(xml, "utf8"), 8);
  // extractFirstZipEntry lê o método de compressão do header de CENTRAL
  // DIRECTORY (não do local header) — corrompe o campo lá (offset +10 a
  // partir da assinatura 0x02014b50) pra um valor inválido (99), simulando
  // um relatório truncado/adulterado sem produzir um XML parcial silencioso.
  const corrupted = Buffer.from(zip);
  const centralDirOffset = corrupted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(centralDirOffset >= 0, "fixture de teste: central directory não encontrado");
  corrupted.writeUInt16LE(99, centralDirOffset + 10);
  assert.throws(() => extractFirstZipEntry(corrupted), /não suportado/);
});

// ─── parseDmarcXml ────────────────────────────────────────────────────────────

test("parseDmarcXml lê metadata + policy_published", () => {
  const report = parseDmarcXml(readFixture("google-multi-record.xml"));
  assert.equal(report.orgName, "google.com");
  assert.equal(report.domain, "news.diar.ia.br");
  assert.equal(report.policyP, "none");
  assert.equal(report.dateRangeBegin, 1756166400);
  assert.equal(report.dateRangeEnd, 1756252799);
});

test("parseDmarcXml lê TODOS os <record> (múltiplos por relatório), não só o 1º", () => {
  const report = parseDmarcXml(readFixture("google-multi-record.xml"));
  assert.equal(report.records.length, 3);
});

test("parseDmarcXml usa <count> como volume — nunca 1-por-record", () => {
  const report = parseDmarcXml(readFixture("google-multi-record.xml"));
  const counts = report.records.map((r) => r.count);
  assert.deepEqual(counts, [42, 5, 1]);
});

test("parseDmarcXml distingue passou-bruto de alinhado (o record 2 passa SPF/DKIM bruto mas NÃO alinha)", () => {
  const report = parseDmarcXml(readFixture("google-multi-record.xml"));
  const [aligned, rawPassButNotAligned, fullyFailed] = report.records;

  assert.equal(aligned.spfRawPass, true);
  assert.equal(aligned.dkimRawPass, true);
  assert.equal(aligned.dmarcAligned, true);

  // auth_results aponta domínio "unrelated-forwarder.example", não
  // news.diar.ia.br — passou a checagem BRUTA (result=pass), mas
  // policy_evaluated diz fail porque não alinha com header_from.
  assert.equal(rawPassButNotAligned.spfRawPass, true);
  assert.equal(rawPassButNotAligned.dkimRawPass, true);
  assert.equal(rawPassButNotAligned.dmarcAligned, false);

  assert.equal(fullyFailed.spfRawPass, false);
  assert.equal(fullyFailed.dkimRawPass, false);
  assert.equal(fullyFailed.dmarcAligned, false);
});

test("parseDmarcXml lança em XML sem <feedback>", () => {
  assert.throws(() => parseDmarcXml("<not-dmarc><foo/></not-dmarc>"), /feedback/);
});

test("parseDmarcXml lança em XML sem <policy_published><domain>", () => {
  const xml = `<feedback><report_metadata><org_name>x</org_name><report_id>1</report_id></report_metadata></feedback>`;
  assert.throws(() => parseDmarcXml(xml), /domain/);
});

// ─── aggregateDmarcReports ────────────────────────────────────────────────────

test("aggregateDmarcReports soma volume/pct corretamente e agrupa por domínio", () => {
  const r1 = parseDmarcXml(readFixture("google-multi-record.xml"));
  const r2 = parseDmarcXml(readFixture("yahoo-single-record-day2.xml"));
  const [summary] = aggregateDmarcReports([r1, r2]);

  assert.equal(summary.domain, "news.diar.ia.br");
  assert.equal(summary.reportCount, 2);
  // total = 42 + 5 + 1 (google) + 17 (yahoo) = 65
  assert.equal(summary.totalMessages, 65);
  // alinhado = 42 (google r1) + 17 (yahoo) = 59
  assert.equal(summary.alignedMessages, 59);
  // spf bruto passou = 42 + 5 (google r1,r2) + 17 (yahoo) = 64
  assert.equal(summary.spfRawPassMessages, 64);
  assert.equal(summary.dkimRawPassMessages, 64);
  assert.equal(summary.alignedPct, Math.round((59 / 65) * 1000) / 10);
});

test("aggregateDmarcReports une a janela (min begin, max end) entre relatórios do mesmo domínio", () => {
  const r1 = parseDmarcXml(readFixture("google-multi-record.xml"));
  const r2 = parseDmarcXml(readFixture("yahoo-single-record-day2.xml"));
  const [summary] = aggregateDmarcReports([r1, r2]);
  assert.equal(summary.windowBegin, 1756166400);
  assert.equal(summary.windowEnd, 1756339199);
});

test("aggregateDmarcReports lista IPs não-alinhados ordenados por volume decrescente", () => {
  const r1 = parseDmarcXml(readFixture("google-multi-record.xml"));
  const [summary] = aggregateDmarcReports([r1]);
  assert.deepEqual(
    summary.failedAlignmentSources.map((f) => f.sourceIp),
    ["198.51.100.7", "203.0.113.55"],
  );
  assert.equal(summary.failedAlignmentSources[0].count, 5);
  assert.deepEqual(summary.failedAlignmentSources[0].reportedBy, ["google.com"]);
});

test("aggregateDmarcReports agrupa domínios distintos em summaries separadas", () => {
  const r1 = parseDmarcXml(readFixture("google-multi-record.xml"));
  const r2 = { ...parseDmarcXml(readFixture("yahoo-single-record-day2.xml")), domain: "reativa.diar.ia.br" };
  const summaries = aggregateDmarcReports([r1, r2]);
  assert.equal(summaries.length, 2);
  assert.deepEqual(
    summaries.map((s) => s.domain),
    ["news.diar.ia.br", "reativa.diar.ia.br"],
  );
});

test("aggregateDmarcReports com lista vazia retorna array vazio", () => {
  assert.deepEqual(aggregateDmarcReports([]), []);
});

// ─── renderDmarcSummaryText ────────────────────────────────────────────────────

test("renderDmarcSummaryText nomeia explicitamente ALINHADO, distinto de 'passou SPF'", () => {
  const r1 = parseDmarcXml(readFixture("google-multi-record.xml"));
  const text = renderDmarcSummaryText(aggregateDmarcReports([r1]));
  assert.match(text, /ALINHADO/);
  assert.match(text, /SPF passou \(bruto\)/);
  assert.match(text, /198\.51\.100\.7/);
});

test("renderDmarcSummaryText com lista vazia não lança", () => {
  assert.equal(renderDmarcSummaryText([]), "Nenhum relatório DMARC no período.");
});
