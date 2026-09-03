#!/usr/bin/env node
/**
 * scripts/dmarc-drain.ts (#6189, extraída da #6111)
 *
 * Busca os relatórios agregados DMARC (`rua=`) recebidos por e-mail,
 * desempacota (base64 → ZIP/gzip → XML — miolo em `scripts/lib/dmarc-report.ts`)
 * e agrega um resumo legível por domínio: volume, % SPF bruto, % DKIM bruto,
 * % ALINHADO (a métrica que decide se o DMARC passa), e os IPs de origem que
 * falharam alinhamento.
 *
 * **Por que existe:** cada relatório é 1 anexo por dia por domínio, ilegível
 * à mão. A decisão de subir `_dmarc.news.diar.ia.br` de `p=none` pra
 * `quarantine`/`reject` (#6111, gated até 2026-09-15) depende de 2-4 semanas
 * de relatório limpo ACUMULADO — sem este script, ninguém lê o `rua=` que
 * chega, e a decisão de enforcement fica sem dado nenhum pra sustentar.
 *
 * **Busca no Gmail (mesmo conector do `inbox-drain.ts`):** os relatórios
 * chegam na caixa da conta autenticada (mesmo refresh token OAuth de
 * `google-auth.ts`/`gFetch` usado por `inbox-drain.ts`/`sync-apoio-nivel-beehiiv.ts`).
 * `fetchDmarcAttachments` é o único ponto de I/O de rede — busca threads via
 * `gmailQuery` (default: assunto padrão de relatório DMARC OU remetente
 * `noreply-dmarc-support@google.com`), percorre os `parts` de cada mensagem
 * recursivamente à procura de anexos (mimeType zip/gzip/octet-stream, ou
 * `filename` terminando em `.zip`/`.xml.gz`/`.xml`) e baixa o conteúdo via
 * `GET messages/{id}/attachments/{attachmentId}`.
 *
 * `fetchReports` é a costura injetável (recebe `fetchAttachmentsImpl`) —
 * testável offline substituindo por uma fake que devolve bytes de fixture,
 * sem tocar o Gmail real (ver `test/dmarc-drain.test.ts`).
 *
 * **Domínio `reativa.diar.ia.br` deliberadamente fora do escopo por
 * enquanto (#6189 "Ressalva medida"):** o `rua=` desse domínio aponta pra
 * `rua@dmarc.brevo.com` — os relatórios vão pra Brevo, não pra nós. Nada
 * aqui filtra por domínio explicitamente (o agregador processa qualquer
 * `policy_published.domain` que aparecer nos relatórios encontrados), mas a
 * QUERY default busca só pelo padrão de assunto/remetente de relatórios de
 * `news.` — se `reativa.` algum dia mandar `rua=` pra esta caixa, o
 * `rua=` dele precisa incluir nosso endereço primeiro (decisão do editor,
 * fora do escopo desta unidade).
 *
 * Uso:
 *   npx tsx scripts/dmarc-drain.ts [--query "..."] [--dry-run] [--to email@x.com]
 *
 *   --query    override da Gmail search query (default: platform.config.json
 *              → dmarc.gmailQuery, ou o default hardcoded abaixo).
 *   --dry-run  busca, desempacota, agrega e IMPRIME o resumo, mas NÃO
 *              escreve output em disco nem manda e-mail de alarme.
 *   --to       override do destinatário do alarme (default: resolveEditorEmail).
 *
 * Output: `data/dmarc-reports/{YYYYMMDD}-summary.json` (summaries completas)
 * — histórico append-only por data de execução (não sobrescreve rodadas
 * anteriores, então a "janela de 2-4 semanas" da #6111 é reconstituível
 * concatenando os arquivos).
 *
 * Alarme: se qualquer domínio tiver volume NÃO-alinhado > 0, avisa o editor
 * (mesmo padrão `alarm-issues.ts` dos outros alarmes do repo — issue com
 * fingerprint por domínio, auto-fecha depois de 2 execuções limpas).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { gFetch } from "./google-auth.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { parseGmailThreadsList } from "./lib/schemas/gmail.ts";
import {
  unwrapDmarcAttachment,
  parseDmarcXml,
  aggregateDmarcReports,
  renderDmarcSummaryText,
  type DmarcAggregateReport,
  type DmarcDomainSummary,
} from "./lib/dmarc-report.ts";
import {
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  saveAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GMAIL_API = "https://www.googleapis.com/gmail/v1/users/me";
const OUTPUT_DIR = resolve(ROOT, "data", "dmarc-reports");
// DMARC query corrigida (overnight 260826): remetente real = noreply-dmarc-support@google.com (corrigido de dmarc-noreply@google.com)
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "dmarc-reports", "alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[dmarc-drain]";

/** Cobre os principais provedores que emitem relatório DMARC pra este
 * domínio (Google, Yahoo, Microsoft/Outlook — vistos com mais frequência)
 * mais o padrão genérico de assunto "Report Domain: X". `newer_than:35d`
 *
 * **Remetente do Google — MEDIDO, não suposto (#6229, 26/08/2026).** Busca
 * direta na caixa real, janela de 120 dias:
 *
 * | endereço                            | resultados |
 * |-------------------------------------|------------|
 * | `noreply-dmarc-support@google.com`  | 1 (o relatório real) |
 * | `dmarcreport@google.com`            | 0 |
 *
 * Os dois ficam na query porque uma cláusula `OR` a mais não custa nada e o
 * Google já usou remetentes diferentes ao longo do tempo — mas o primeiro é
 * o que de fato entrega hoje. Não remover `noreply-dmarc-support` sem antes
 * repetir a medição. Uma tentativa de substituir um pelo outro (branch
 * `fix/6229-dmarc-query`, não mergeada) faria a busca depender inteiramente
 * da cláusula `subject:` sem que nada acusasse — o relatório continuaria
 * sendo encontrado, por outro caminho, e a query só falharia quando chegasse
 * relatório de domínio fora da lista de assuntos.
 * cobre com folga a janela de 2-4 semanas que a decisão de enforcement da
 * #6111 precisa acumular, sem crescer sem limite a cada execução. */
export const DEFAULT_GMAIL_QUERY =
  'newer_than:35d (subject:"Report Domain: news.diar.ia.br" OR subject:"Report domain: news.diar.ia.br" OR subject:"Report Domain: diar.ia.br" OR subject:"Report domain: diar.ia.br" OR from:noreply-dmarc-support@google.com OR from:dmarcreport@google.com OR from:dmarcreport@microsoft.com OR from:dmarchelp@yahoo-inc.com) has:attachment';

/** #5339: 2 execuções limpas consecutivas antes de fechar a issue de alarme
 * automaticamente — mesmo valor dos demais alarmes diários deste repo. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

interface PlatformConfig {
  dmarc?: { gmailQuery?: string };
}

function resolveGmailQuery(override?: string): string {
  if (override) return override;
  try {
    if (existsSync(PLATFORM_CONFIG_PATH)) {
      const cfg = JSON.parse(readFileSync(PLATFORM_CONFIG_PATH, "utf8")) as PlatformConfig;
      if (cfg.dmarc?.gmailQuery) return cfg.dmarc.gmailQuery;
    }
  } catch {
    // config ilegível -> segue com default, não bloqueia o drain
  }
  return DEFAULT_GMAIL_QUERY;
}

// ─── Gmail: busca + download de anexos (único ponto de I/O de rede) ────────

interface DmarcAttachment {
  buf: Buffer;
  filename: string;
  messageId: string;
}

async function gmailRequest<T>(path: string): Promise<T> {
  const res = await gFetch(`${GMAIL_API}/${path}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API error (${res.status}) at ${path}: ${body}`);
  }
  return res.json() as Promise<T>;
}

function decodeBase64Url(str: string): Buffer {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

/** Nomes/tipos que indicam um anexo de relatório DMARC — zip, gzip, ou XML
 * cru (ver `unwrapDmarcAttachment` em dmarc-report.ts pra detecção real de
 * formato por byte; este filtro só decide QUAIS parts baixar). */
function looksLikeDmarcAttachment(filename: string | undefined, mimeType: string): boolean {
  const name = (filename ?? "").toLowerCase();
  if (name.endsWith(".zip") || name.endsWith(".gz") || name.endsWith(".xml")) return true;
  return ["application/zip", "application/x-zip-compressed", "application/gzip", "application/x-gzip"].includes(mimeType.toLowerCase());
}

interface RawPart {
  mimeType: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: RawPart[];
}

function collectAttachmentParts(part: RawPart, out: RawPart[]): void {
  if (part.body?.attachmentId && looksLikeDmarcAttachment(part.filename, part.mimeType)) {
    out.push(part);
  }
  for (const child of part.parts ?? []) collectAttachmentParts(child, out);
}

/**
 * Busca no Gmail e baixa os bytes crus de todo anexo que parece relatório
 * DMARC, dentro da query dada. Único ponto de I/O de rede do módulo —
 * `fetchReports` recebe isso como dependência injetável.
 */
export async function fetchDmarcAttachments(query: string): Promise<DmarcAttachment[]> {
  const params = new URLSearchParams({ q: query, maxResults: "100" });
  const raw = await gmailRequest<unknown>(`threads?${params}`);
  const list = parseGmailThreadsList(raw);
  const threadIds = (list.threads ?? []).map((t) => t.id);

  const attachments: DmarcAttachment[] = [];
  for (const threadId of threadIds) {
    const thread = await gmailRequest<{ messages?: Array<{ id: string; payload: RawPart }> }>(`threads/${threadId}?format=full`);
    for (const msg of thread.messages ?? []) {
      const parts: RawPart[] = [];
      collectAttachmentParts(msg.payload, parts);
      for (const part of parts) {
        const attachmentId = part.body?.attachmentId;
        if (!attachmentId) continue;
        const att = await gmailRequest<{ data?: string }>(`messages/${msg.id}/attachments/${attachmentId}`);
        if (!att.data) continue;
        attachments.push({ buf: decodeBase64Url(att.data), filename: part.filename ?? "(sem nome)", messageId: msg.id });
      }
    }
  }
  return attachments;
}

export interface FetchReportsResult {
  reports: DmarcAggregateReport[];
  /** Anexos encontrados que falharam ao desempacotar/parsear — nunca
   * derrubam o drain inteiro, mas ficam auditáveis (ex: ZIP corrompido,
   * relatório de formato inesperado). */
  errors: Array<{ filename: string; messageId: string; error: string }>;
}

/**
 * Busca + desempacota + parseia TODOS os relatórios encontrados pela query.
 * `fetchAttachmentsImpl` é a costura de teste — o caminho real é
 * `fetchDmarcAttachments` (Gmail); um teste passa uma fake que devolve bytes
 * de fixture. Nunca lança por causa de UM anexo malformado — acumula em
 * `errors` e segue com os demais (fail-soft por item, fail-loud só se a
 * BUSCA em si falhar, que é responsabilidade do caller tratar).
 */
export async function fetchReports(
  query: string,
  fetchAttachmentsImpl: (query: string) => Promise<DmarcAttachment[]> = fetchDmarcAttachments,
): Promise<FetchReportsResult> {
  const attachments = await fetchAttachmentsImpl(query);
  const reports: DmarcAggregateReport[] = [];
  const errors: FetchReportsResult["errors"] = [];
  for (const att of attachments) {
    try {
      const xml = unwrapDmarcAttachment(att.buf);
      reports.push(parseDmarcXml(xml));
    } catch (e) {
      errors.push({ filename: att.filename, messageId: att.messageId, error: (e as Error).message });
    }
  }
  return { reports, errors };
}

// ─── Alarme: volume não-autenticado ─────────────────────────────────────────

/** Condição de alarme por domínio: qualquer volume NÃO-alinhado (issue
 * #6189, item 4 — "alarmar se aparecer volume não-autenticado"). Pura. */
export function alarmFindingsFor(summaries: DmarcDomainSummary[]): AlarmFinding[] {
  const findings: AlarmFinding[] = [];
  for (const s of summaries) {
    const unalignedCount = s.totalMessages - s.alignedMessages;
    if (unalignedCount <= 0) continue;
    const topIps = s.failedAlignmentSources
      .slice(0, 5)
      .map((f) => `${f.sourceIp} (${f.count})`)
      .join(", ");
    findings.push({
      check: "dmarc-drain",
      fingerprint: s.domain,
      family: "estado",
      title: `DMARC: volume não-alinhado em ${s.domain}`,
      body:
        `${unalignedCount} mensagem(ns) de ${s.totalMessages} não alinharam DMARC para **${s.domain}** ` +
        `(${s.alignedPct}% alinhado no período ${new Date(s.windowBegin * 1000).toISOString().slice(0, 10)}..${new Date(s.windowEnd * 1000).toISOString().slice(0, 10)}).\n\n` +
        `IPs de origem com falha de alinhamento: ${topIps || "(nenhum IP individual, ver resumo completo)"}.\n\n` +
        `Ver \`data/dmarc-reports/\` para o resumo completo desta execução. Contexto: #6111, #6189.`,
      labels: ["bug", "P2", "diaria"],
    });
  }
  return findings;
}

// ─── Estado (alarm-issues) ───────────────────────────────────────────────────
// saveAlarmIssuesState: consolidado em scripts/lib/alarm-issues.ts (#7124) —
// importado acima. loadAlarmIssuesState continua LOCAL: diverge do padrão
// comum ao logar o parse error via console.error, não só um catch
// silencioso; não forçado para o helper genérico pra não perder o
// diagnóstico.

function loadAlarmIssuesState(): AlarmIssuesState {
  if (!existsSync(ALARM_ISSUES_STATE_PATH)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(ALARM_ISSUES_STATE_PATH, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch (e) {
    console.error(`${LOG_PREFIX} estado de alarm-issues corrompido/ilegível — resetando pra vazio: ${(e as Error).message}`);
    return emptyAlarmIssuesState();
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv();
  const isDryRun = hasFlag(process.argv, "dry-run");
  const queryOverride = getArg(process.argv, "query");
  const toOverride = getArg(process.argv, "to");
  const query = resolveGmailQuery(queryOverride);

  console.log(`${LOG_PREFIX} query: ${query}`);

  let result: FetchReportsResult;
  try {
    result = await fetchReports(query);
  } catch (e) {
    console.error(`${LOG_PREFIX} falha ao buscar/baixar relatórios no Gmail: ${(e as Error).message}`);
    process.exit(1);
    return;
  }

  console.log(`${LOG_PREFIX} ${result.reports.length} relatório(s) desempacotado(s), ${result.errors.length} erro(s) de parsing`);
  for (const err of result.errors) {
    console.error(`${LOG_PREFIX}   erro: msg=${err.messageId} anexo="${err.filename}": ${err.error}`);
  }

  const summaries = aggregateDmarcReports(result.reports);
  console.log(renderDmarcSummaryText(summaries));

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: não escrevendo output nem alarmando.`);
    return;
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const outPath = resolve(OUTPUT_DIR, `${stamp}-summary.json`);
  writeFileAtomic(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), query, summaries, parseErrors: result.errors }, null, 2) + "\n");
  console.log(`${LOG_PREFIX} resumo salvo em ${outPath}`);

  const findings = alarmFindingsFor(summaries);
  const alarmState = loadAlarmIssuesState();
  const { nextState, findingOutcomes } = applyAlarmReconciliation(findings, alarmState, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
  });
  saveAlarmIssuesState(nextState, ALARM_ISSUES_STATE_PATH);

  for (const outcome of findingOutcomes) {
    if (outcome.action === "failed") {
      console.error(`${LOG_PREFIX} issue não criada/reusada pra ${outcome.fingerprint}: ${outcome.error}`);
    } else {
      console.log(`${LOG_PREFIX} issue #${outcome.issueNumber} (${outcome.action}) pra ${outcome.fingerprint}: ${outcome.url}`);
    }
  }

  const opened = findingOutcomes.filter((r) => r.action === "created" || r.action === "reopened");
  if (opened.length > 0) {
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    const subject = `[diar.ia.br] DMARC: volume não-autenticado em ${opened.length} domínio(s)`;
    const body = `${renderDmarcSummaryText(summaries)}\n\nIssues: ${opened.map((r) => r.url).join(", ")}`;
    try {
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado para ${to}`);
    } catch (e) {
      console.error(`${LOG_PREFIX} falha ao enviar e-mail de alarme (issue já registrada, e-mail é best-effort): ${(e as Error).message}`);
    }
  } else {
    console.log(`${LOG_PREFIX} sem achado novo pra alarmar.`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
