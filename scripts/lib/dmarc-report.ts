/**
 * scripts/lib/dmarc-report.ts (#6189)
 *
 * Miolo PURO (sem I/O de rede) que desempacota e agrega relatórios
 * agregados DMARC (RFC 7489 Apêndice C — `feedback` XML). Cada relatório
 * chega como anexo de e-mail em um destes 3 formatos, na ordem de
 * frequência observada entre provedores:
 *
 *   - ZIP contendo 1 arquivo `.xml` (Google, a maioria dos provedores)
 *   - `.xml.gz` (gzip puro, sem container ZIP — alguns provedores menores)
 *   - `.xml` cru (raro, mas alguns relays não comprimem)
 *
 * `unwrapDmarcAttachment` detecta o formato pela assinatura de bytes (magic
 * number) — nunca pela extensão do nome do arquivo, que é metadado do
 * remetente e não confiável.
 *
 * ─── ZIP: por que um parser à mão em vez de uma dependência ────────────────
 *
 * DMARC ZIPs têm sempre 1 único entry (o XML do relatório) — não há motivo
 * pra puxar uma lib de ZIP genérica (múltiplos entries, streaming, ZIP64)
 * pra um caso de uso deste tamanho. `extractFirstZipEntry` lê o End Of
 * Central Directory (EOCD) do fim do buffer, segue pro primeiro header de
 * Central Directory, resolve o offset do Local File Header correspondente e
 * descomprime (`stored` ou `deflate` — os 2 métodos que qualquer ferramenta
 * de zip padrão usa; outros métodos são um erro explícito, não um fallback
 * silencioso). **Limitação deliberada:** só o PRIMEIRO entry é lido — um
 * ZIP DMARC com mais de 1 XML dentro (nunca observado, fora do RFC) teria os
 * demais ignorados sem aviso.
 *
 * ─── Alinhamento ≠ "passou SPF/DKIM" ────────────────────────────────────────
 *
 * `auth_results.spf`/`auth_results.dkim` são o resultado BRUTO da checagem
 * — pode passar mesmo com o domínio do envelope/assinatura diferente do
 * `header_from` (ex: forward, terceiro autorizado só no SPF do domínio
 * intermediário). `policy_evaluated.spf`/`policy_evaluated.dkim` já
 * incorporam a checagem de ALINHAMENTO (RFC 7489 §3.1) — é isso que decide
 * se a mensagem PASSA no DMARC como um todo. `dmarcAligned` (por row) é
 * `policy_evaluated.dkim === "pass" || policy_evaluated.spf === "pass"`
 * (DMARC passa se QUALQUER UM dos dois alinhar — não precisa dos dois).
 * `spfRawPass`/`dkimRawPass` (por row) refletem só `auth_results`, pra
 * distinguir explicitamente as duas métricas no agregado — nunca reportar
 * "% que passou SPF" quando o dado é na verdade "% alinhado" (issue #6189).
 */

import { XMLParser } from "fast-xml-parser";
import { inflateRawSync, gunzipSync } from "node:zlib";

// ─── Detecção de formato + desempacotamento ─────────────────────────────────

export type DmarcAttachmentKind = "zip" | "gzip" | "xml";

/** Detecta o formato pela assinatura de bytes (magic number) — nunca pelo
 * nome/extensão do arquivo, que é metadado do remetente. */
export function detectAttachmentKind(buf: Buffer): DmarcAttachmentKind {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
    return "zip";
  }
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return "gzip";
  }
  return "xml";
}

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIR_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
/** EOCD tem tamanho fixo mínimo 22 bytes (sem comment) — busca de trás pra
 * frente a partir daí, já que o comment (raro em anexos automatizados) pode
 * empurrar a assinatura mais cedo no buffer. */
const ZIP_EOCD_MIN_SIZE = 22;

function findZipEocdOffset(buf: Buffer): number {
  for (let i = buf.length - ZIP_EOCD_MIN_SIZE; i >= 0; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIGNATURE) return i;
  }
  throw new Error("ZIP inválido: End Of Central Directory (EOCD) não encontrado");
}

/** Extrai e descomprime o PRIMEIRO entry de um ZIP (ver limitação na
 * docstring do módulo). Suporta método `stored` (0) e `deflate` (8) — os
 * únicos usados por ferramentas de zip padrão. */
export function extractFirstZipEntry(buf: Buffer): Buffer {
  const eocdOffset = findZipEocdOffset(buf);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  const cdSig = buf.readUInt32LE(centralDirOffset);
  if (cdSig !== ZIP_CENTRAL_DIR_SIGNATURE) {
    throw new Error("ZIP inválido: header de Central Directory ausente no offset esperado");
  }
  const compressionMethod = buf.readUInt16LE(centralDirOffset + 10);
  const compressedSize = buf.readUInt32LE(centralDirOffset + 20);
  const localHeaderOffset = buf.readUInt32LE(centralDirOffset + 42);

  const lhSig = buf.readUInt32LE(localHeaderOffset);
  if (lhSig !== ZIP_LOCAL_FILE_SIGNATURE) {
    throw new Error("ZIP inválido: Local File Header ausente no offset esperado");
  }
  const lhFileNameLength = buf.readUInt16LE(localHeaderOffset + 26);
  const lhExtraLength = buf.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + lhFileNameLength + lhExtraLength;
  const compressedData = buf.subarray(dataStart, dataStart + compressedSize);

  if (compressionMethod === 0) return Buffer.from(compressedData);
  if (compressionMethod === 8) return inflateRawSync(compressedData);
  throw new Error(`ZIP: método de compressão não suportado (${compressionMethod}) — só stored(0)/deflate(8)`);
}

/** Ponto de entrada único: bytes crus do anexo -> texto XML do relatório. */
export function unwrapDmarcAttachment(buf: Buffer): string {
  const kind = detectAttachmentKind(buf);
  if (kind === "zip") return extractFirstZipEntry(buf).toString("utf8");
  if (kind === "gzip") return gunzipSync(buf).toString("utf8");
  return buf.toString("utf8");
}

// ─── Parsing do XML ──────────────────────────────────────────────────────────

/** `record`/`auth_results.dkim`/`auth_results.spf` sempre viram array,
 * mesmo com 1 único elemento — RFC 7489 permite múltiplos `record` por
 * relatório e múltiplas assinaturas DKIM por record; sem isso o
 * fast-xml-parser colapsa 1-elemento pra objeto solto e o código de
 * agregação teria 2 formatos pra tratar.
 *
 * O match é por CAMINHO completo (`jPath`), não por nome de tag isolado —
 * `dkim`/`spf` também aparecem como filhos de `policy_evaluated` (resultado
 * ALINHADO, sempre um único texto `pass`/`fail`, nunca lista) e forçar
 * array ali quebraria a leitura desses campos. */
const FORCE_ARRAY_PATHS = new Set(["feedback.record", "feedback.record.auth_results.dkim", "feedback.record.auth_results.spf"]);

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  parseTagValue: false,
  jPath: true, // isArray recebe jPath como string (não Matcher) — ver assert abaixo
  isArray: (_tagName, jPath) => FORCE_ARRAY_PATHS.has(jPath as string),
});

export interface DmarcRecordRow {
  sourceIp: string;
  count: number;
  disposition: string;
  /** Resultado bruto de `auth_results` — pode passar sem alinhar. */
  spfRawPass: boolean;
  dkimRawPass: boolean;
  /** Resultado de `policy_evaluated` — já incorpora alinhamento (RFC 7489 §3.1). */
  spfAligned: boolean;
  dkimAligned: boolean;
  /** DMARC passa se QUALQUER UM dos dois mecanismos alinhar. */
  dmarcAligned: boolean;
}

export interface DmarcAggregateReport {
  orgName: string;
  reportId: string;
  /** Domínio de `policy_published.domain` — o domínio que o relatório cobre,
   * não necessariamente o `header_from` de cada mensagem individual. */
  domain: string;
  policyP: string;
  /** epoch segundos (RFC 7489 — `date_range` já vem em unix time). */
  dateRangeBegin: number;
  dateRangeEnd: number;
  records: DmarcRecordRow[];
}

function textOf(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  return "";
}

function numberOf(val: unknown): number {
  const n = Number(textOf(val));
  return Number.isFinite(n) ? n : 0;
}

/** Um relatório real pode ter 1+ assinaturas DKIM (`auth_results.dkim` é
 * array) — considera "raw pass" se QUALQUER assinatura passou. Mesmo padrão
 * pro SPF (embora SPF normalmente tenha só 1 entry). */
function anyResultPasses(entries: unknown): boolean {
  const arr = Array.isArray(entries) ? entries : entries != null ? [entries] : [];
  return arr.some((e) => textOf((e as Record<string, unknown>)?.result).toLowerCase() === "pass");
}

/**
 * Parseia o XML de um relatório agregado DMARC (RFC 7489 Apêndice C).
 * Lança se a estrutura mínima esperada (`feedback.report_metadata`,
 * `feedback.policy_published.domain`) estiver ausente — um XML que não é um
 * relatório DMARC não deve produzir um relatório vazio silenciosamente.
 */
export function parseDmarcXml(xml: string): DmarcAggregateReport {
  const doc = xmlParser.parse(xml) as Record<string, unknown>;
  const feedback = doc?.feedback as Record<string, unknown> | undefined;
  if (!feedback) throw new Error("XML DMARC inválido: elemento raiz <feedback> ausente");

  const metadata = feedback.report_metadata as Record<string, unknown> | undefined;
  if (!metadata) throw new Error("XML DMARC inválido: <report_metadata> ausente");
  const policyPublished = feedback.policy_published as Record<string, unknown> | undefined;
  if (!policyPublished || !textOf(policyPublished.domain)) {
    throw new Error("XML DMARC inválido: <policy_published><domain> ausente");
  }

  const dateRange = metadata.date_range as Record<string, unknown> | undefined;

  const rawRecords = Array.isArray(feedback.record) ? feedback.record : feedback.record != null ? [feedback.record] : [];

  const records: DmarcRecordRow[] = rawRecords.map((r) => {
    const rec = r as Record<string, unknown>;
    const row = rec.row as Record<string, unknown> | undefined;
    const policyEvaluated = row?.policy_evaluated as Record<string, unknown> | undefined;
    const authResults = rec.auth_results as Record<string, unknown> | undefined;

    const spfAligned = textOf(policyEvaluated?.spf).toLowerCase() === "pass";
    const dkimAligned = textOf(policyEvaluated?.dkim).toLowerCase() === "pass";

    return {
      sourceIp: textOf(row?.source_ip),
      count: numberOf(row?.count) || 1,
      disposition: textOf(policyEvaluated?.disposition) || "none",
      spfRawPass: anyResultPasses(authResults?.spf),
      dkimRawPass: anyResultPasses(authResults?.dkim),
      spfAligned,
      dkimAligned,
      dmarcAligned: spfAligned || dkimAligned,
    };
  });

  return {
    orgName: textOf(metadata.org_name),
    reportId: textOf(metadata.report_id),
    domain: textOf(policyPublished.domain),
    policyP: textOf(policyPublished.p),
    dateRangeBegin: numberOf(dateRange?.begin),
    dateRangeEnd: numberOf(dateRange?.end),
    records,
  };
}

// ─── Agregação ────────────────────────────────────────────────────────────

export interface DmarcSourceIpFailure {
  sourceIp: string;
  count: number;
  /** Nome(s) de organização que reportaram esta falha (útil pra correlação —
   * ex: "google.com", "yahoo.com"). */
  reportedBy: string[];
}

export interface DmarcDomainSummary {
  domain: string;
  reportCount: number;
  /** epoch segundos — janela coberta pela UNIÃO dos relatórios agregados. */
  windowBegin: number;
  windowEnd: number;
  /** Soma de `<count>` de todos os records — é a unidade real de volume;
   * NUNCA contar 1 por `<record>` (um único record tipicamente representa
   * dezenas/centenas de mensagens do mesmo IP de origem no mesmo dia,
   * expressas em `<count>`). */
  totalMessages: number;
  spfRawPassMessages: number;
  dkimRawPassMessages: number;
  alignedMessages: number;
  spfRawPassPct: number;
  dkimRawPassPct: number;
  alignedPct: number;
  /** IPs de origem com pelo menos 1 mensagem NÃO alinhada — ordenado por
   * volume de falha decrescente (onde spoof/config errada aparece). */
  failedAlignmentSources: DmarcSourceIpFailure[];
}

/** Agrega N relatórios já parseados (tipicamente vários dias/domínios) num
 * resumo por domínio. Pura — não decide quais relatórios entram (isso é do
 * caller, ex: filtro por janela de tempo). */
export function aggregateDmarcReports(reports: DmarcAggregateReport[]): DmarcDomainSummary[] {
  const byDomain = new Map<string, DmarcAggregateReport[]>();
  for (const r of reports) {
    const list = byDomain.get(r.domain) ?? [];
    list.push(r);
    byDomain.set(r.domain, list);
  }

  const summaries: DmarcDomainSummary[] = [];
  for (const [domain, domainReports] of byDomain) {
    let totalMessages = 0;
    let spfRawPassMessages = 0;
    let dkimRawPassMessages = 0;
    let alignedMessages = 0;
    let windowBegin = Infinity;
    let windowEnd = -Infinity;
    const failuresByIp = new Map<string, { count: number; reportedBy: Set<string> }>();

    for (const report of domainReports) {
      if (report.dateRangeBegin > 0) windowBegin = Math.min(windowBegin, report.dateRangeBegin);
      if (report.dateRangeEnd > 0) windowEnd = Math.max(windowEnd, report.dateRangeEnd);

      for (const row of report.records) {
        totalMessages += row.count;
        if (row.spfRawPass) spfRawPassMessages += row.count;
        if (row.dkimRawPass) dkimRawPassMessages += row.count;
        if (row.dmarcAligned) {
          alignedMessages += row.count;
        } else {
          const entry = failuresByIp.get(row.sourceIp) ?? { count: 0, reportedBy: new Set<string>() };
          entry.count += row.count;
          if (report.orgName) entry.reportedBy.add(report.orgName);
          failuresByIp.set(row.sourceIp, entry);
        }
      }
    }

    const pct = (n: number) => (totalMessages > 0 ? Math.round((n / totalMessages) * 1000) / 10 : 0);

    const failedAlignmentSources = Array.from(failuresByIp.entries())
      .map(([sourceIp, v]) => ({ sourceIp, count: v.count, reportedBy: Array.from(v.reportedBy).sort() }))
      .sort((a, b) => b.count - a.count);

    summaries.push({
      domain,
      reportCount: domainReports.length,
      windowBegin: Number.isFinite(windowBegin) ? windowBegin : 0,
      windowEnd: Number.isFinite(windowEnd) ? windowEnd : 0,
      totalMessages,
      spfRawPassMessages,
      dkimRawPassMessages,
      alignedMessages,
      spfRawPassPct: pct(spfRawPassMessages),
      dkimRawPassPct: pct(dkimRawPassMessages),
      alignedPct: pct(alignedMessages),
      failedAlignmentSources,
    });
  }

  return summaries.sort((a, b) => a.domain.localeCompare(b.domain));
}

/** Renderiza o agregado como texto legível (usado no e-mail de alarme e no
 * stdout do CLI). Pura — sem I/O. */
export function renderDmarcSummaryText(summaries: DmarcDomainSummary[]): string {
  if (summaries.length === 0) return "Nenhum relatório DMARC no período.";
  const lines: string[] = [];
  for (const s of summaries) {
    const begin = s.windowBegin > 0 ? new Date(s.windowBegin * 1000).toISOString().slice(0, 10) : "?";
    const end = s.windowEnd > 0 ? new Date(s.windowEnd * 1000).toISOString().slice(0, 10) : "?";
    lines.push(`${s.domain} (${s.reportCount} relatório(s), ${begin}..${end})`);
    lines.push(`  volume total: ${s.totalMessages}`);
    lines.push(`  SPF passou (bruto): ${s.spfRawPassMessages} (${s.spfRawPassPct}%)`);
    lines.push(`  DKIM passou (bruto): ${s.dkimRawPassMessages} (${s.dkimRawPassPct}%)`);
    lines.push(`  ALINHADO (o que importa pro DMARC): ${s.alignedMessages} (${s.alignedPct}%)`);
    if (s.failedAlignmentSources.length > 0) {
      lines.push(`  IPs não-alinhados (top ${Math.min(5, s.failedAlignmentSources.length)}):`);
      for (const f of s.failedAlignmentSources.slice(0, 5)) {
        lines.push(`    ${f.sourceIp}: ${f.count} msg(s)${f.reportedBy.length ? ` [${f.reportedBy.join(", ")}]` : ""}`);
      }
    } else {
      lines.push(`  IPs não-alinhados: nenhum`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
