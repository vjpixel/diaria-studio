/**
 * clarice-recency.ts (#4719)
 *
 * Filtro de RECÊNCIA de envio: exclui contatos que já receberam e-mail dentro
 * de uma janela recente (`last_sent_at`), independente de terem sido
 * SELECIONADOS por um grupo nomeado neste ciclo.
 *
 * Por que isto é diferente do dedup por ciclo (`sent-or-queued.json`, #3227,
 * `clarice-build-segment.ts`): aquele guard responde "esta pessoa já foi
 * ESCOLHIDA por algum `--group` neste ciclo?" — e só enxerga quem passou por
 * `buildSegmentArtifact`. Toda via de envio que não passa por ali (seeds do
 * editor injetados no import, listas montadas à mão, campanhas ad-hoc) é
 * invisível pro dedup por ciclo mas continua tocando `last_sent_at` no store
 * (via o sync da Brevo). A pergunta do editor — "recebeu e-mail nosso nos
 * últimos N dias?" — só este módulo responde.
 *
 * Ocorrido ao vivo em 06/08/2026 (onda `d7-sex07`, ciclo 2607-08): o build de
 * `engajados` com `--budget 817` devolveu 817 contatos com
 * `already_sent_or_queued: 28088`, e mesmo assim 15 dos 817 tinham
 * `last_sent_at >= 2026-08-01` — filtrados à mão antes de importar.
 *
 * `EDITOR_SEED_EMAILS` NUNCA passam por este filtro, não por exceção
 * especial aqui, mas por CONSTRUÇÃO: a linha do editor só é injetada no CSV
 * no momento do IMPORT (`ensureEditorCopyRow`, `clarice-import-waves.ts`),
 * depois desta seleção — o universo que `clarice-build-segment.ts` filtra
 * nunca inclui essa linha em primeiro lugar.
 */

/** Formato aceito por `--not-sent-within` (ex: "30d"). */
const WITHIN_DAYS_RE = /^(\d+)d$/;
/** Formato aceito por `--not-sent-since` (ex: "2026-08-01"). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve `--not-sent-within Nd` OU `--not-sent-since YYYY-MM-DD` pro cutoff
 * ISO (limite INFERIOR inclusive de exclusão: `last_sent_at >= cutoff` é
 * excluído). Os dois são mutuamente exclusivos — passar os dois lança (evita
 * ambiguidade sobre qual vence, mesma disciplina de `parseHoldArg`/
 * `getStringArg`: nunca resolver silenciosamente pro "menos surpreendente").
 *
 * `null`/`undefined` nos dois → `null` (flag genuinamente ausente, filtro
 * desligado — comportamento pré-#4719 inalterado).
 *
 * `now` é injetado (não `Date.now()` implícito) — `--not-sent-within` é
 * relativo, e um cutoff relativo calculado sem `now` explícito não é
 * testável de forma determinística.
 */
export function resolveNotSentCutoff(
  withinArg: string | null | undefined,
  sinceArg: string | null | undefined,
  now: Date,
): string | null {
  if (withinArg && sinceArg) {
    throw new Error(
      "--not-sent-within e --not-sent-since são mutuamente exclusivos — use só um dos dois.",
    );
  }
  if (sinceArg) {
    const m = ISO_DATE_RE.exec(sinceArg);
    if (!m) {
      throw new Error(`--not-sent-since inválido: "${sinceArg}" — esperado YYYY-MM-DD.`);
    }
    const iso = `${sinceArg}T00:00:00.000Z`;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) {
      throw new Error(`--not-sent-since inválido: "${sinceArg}" — esperado YYYY-MM-DD.`);
    }
    // Fleet review (#4719): round-trip — pega "2026-02-31" → "2026-03-03" (o
    // Date "conserta" datas inexistentes em silêncio ao invés de rejeitar).
    // Mesmo padrão já usado em `scheduledAtForDate` (clarice-wave-plan.ts) —
    // esta issue toca o mesmo fluxo de montagem de onda que já corrigiu essa
    // classe de bug uma vez; não deixar o mesmo footgun voltar aqui.
    const back = new Date(ms).toISOString().slice(0, 10);
    if (back !== sinceArg) {
      throw new Error(`--not-sent-since é uma data inexistente no calendário: "${sinceArg}".`);
    }
    return new Date(iso).toISOString();
  }
  if (withinArg) {
    const m = WITHIN_DAYS_RE.exec(withinArg.trim());
    if (!m) {
      throw new Error(`--not-sent-within inválido: "${withinArg}" — esperado o formato "Nd" (ex: "30d").`);
    }
    const days = Number(m[1]);
    if (!(days > 0)) {
      throw new Error(`--not-sent-within precisa ser > 0 dias: "${withinArg}".`);
    }
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  }
  return null;
}

/**
 * Filtra `rows` removendo quem tem `last_sent_at >= cutoffIso` (recebeu
 * dentro da janela — excluído). `last_sent_at` ausente/inválido NUNCA é
 * excluído (fail-safe pro lado que não perde contato por engano — "nunca
 * recebeu" ou "dado ruim" não é "recebeu recentemente"). Pura — mesmo padrão
 * de `excludeSentOrQueued`/`applyHolds`.
 */
export function excludeSentSince<T extends { last_sent_at?: string | null }>(
  rows: T[],
  cutoffIso: string,
): T[] {
  const cutoffMs = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoffMs)) return rows.slice();
  return rows.filter((r) => {
    if (!r.last_sent_at) return true;
    const ms = Date.parse(r.last_sent_at);
    return !Number.isFinite(ms) || ms < cutoffMs;
  });
}
