/**
 * scripts/lib/ai-fetch-staleness-alarm.ts (#8340)
 *
 * Lógica PURA do alarme de staleness da task diária `Diaria-Ai-Fetch-Report`
 * (`scripts/ai-fetch-report.ts`, `data/ai-fetch/history.jsonl`). Existe
 * porque a #8340 é, ela mesma, um caso de "série que parou de crescer em
 * silêncio" (mesmo modo de falha que o #4754 corrigiu pro monitor de
 * citação GEO — script mergeado, nunca agendado) — registrar a task sem um
 * alarme companheiro reabriria a mesma classe de incidente assim que a task
 * parasse de rodar por qualquer motivo (unit desarmada, credencial
 * Cloudflare expirada, etc). "Guard construído tem que ser ARMADO" (#7137
 * item 27) vale igual pra um guard que ainda nem existia.
 *
 * Mesmo padrão de `beehiiv-backup-staleness-alarm.ts` (#5494) — o mais
 * simples dos alarmes de staleness do repo, sem a reconciliação de issue
 * multi-achado do `geo-citation-staleness-alarm.ts` (que cobre 4 painéis +
 * provider ausente; aqui há 1 série só). `computeStaleness`
 * (`lib/geo-citation-staleness-alarm.ts`) é reusado diretamente — é pura,
 * genérica (`latestRecordTs`, `now`, `thresholdDays`), e já teve o cuidado
 * de tratar `null`/timestamp ilegível como staleness máxima.
 */

export const AI_FETCH_STALENESS_THRESHOLD_DAYS = 3;

export interface AiFetchStalenessAlarmState {
  lastAlarmedFingerprint: string | null;
}

export function emptyAiFetchStalenessAlarmState(): AiFetchStalenessAlarmState {
  return { lastAlarmedFingerprint: null };
}

export interface AiFetchStalenessCheck {
  isStale: boolean;
  /** `null` só quando `latestRecordTs` é `null`/ilegível (nunca rodou / arquivo corrompido). */
  staleDays: number | null;
}

/** Fingerprint estável: isStale + o `ts` mais recente conhecido (não os
 * `staleDays`, que mudam a cada execução mesmo sem nada de novo acontecer —
 * senão o alarme reenviaria todo dia enquanto ficasse stale). */
export function fingerprintFor(check: AiFetchStalenessCheck, latestRecordTs: string | null): string {
  return `${check.isStale}:${latestRecordTs ?? "none"}`;
}

export function shouldAlarm(check: AiFetchStalenessCheck, latestRecordTs: string | null, state: AiFetchStalenessAlarmState): boolean {
  if (!check.isStale) return false;
  return fingerprintFor(check, latestRecordTs) !== state.lastAlarmedFingerprint;
}

export function advanceState(check: AiFetchStalenessCheck, latestRecordTs: string | null): AiFetchStalenessAlarmState {
  return { lastAlarmedFingerprint: check.isStale ? fingerprintFor(check, latestRecordTs) : null };
}

export function buildAiFetchStalenessAlarmEmail(
  latestRecordTs: string | null,
  staleDays: number | null,
): { subject: string; body: string } {
  const dateLabel = latestRecordTs ?? "nenhum registro encontrado";
  const subject = `⚠️ ai-fetch-report: série de recuperação GEO sem registro novo (${dateLabel})`;
  const body = [
    "Alarme automático do Diaria-Ai-Fetch-Staleness-Alarm (#8340).",
    "",
    `Último registro em data/ai-fetch/history.jsonl: ${dateLabel}` +
      (staleDays != null ? ` (${staleDays} dia(s) atrás)` : " (timestamp ausente/ilegível)") +
      `. Limite: ${AI_FETCH_STALENESS_THRESHOLD_DAYS} dia(s).`,
    "",
    "Por que importa: este é o único instrumento do projeto que mede recuperação do lado do " +
      "SERVIDOR (fetch por bot de IA em arquivo.diar.ia.br e no site) — sem ele não dá pra distinguir " +
      '"um bot buscou e não citou" de "nenhum bot jamais buscou". Foi ele que derrubou a explicação de ' +
      "descoberta na decisão de pausar hub novo (#4905). A #8340 nasceu de exatamente este alarme nunca ter " +
      "existido — a task rodou desregistrada por semanas sem que ninguém percebesse.",
    "",
    "Verifique se a task Diaria-Ai-Fetch-Report (diária, ver scripts/lib/scheduled-tasks.ts) segue " +
      "registrada e rodando, e se as credenciais Cloudflare (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_WORKERS_TOKEN, " +
      "CURSOS_KV_NAMESPACE_ID) seguem válidas.",
    "",
    "Rode manualmente: npx tsx scripts/ai-fetch-report.ts --days 2",
    "",
    "Detalhes: scripts/lib/ai-fetch-staleness-alarm.ts.",
  ].join("\n");
  return { subject, body };
}
