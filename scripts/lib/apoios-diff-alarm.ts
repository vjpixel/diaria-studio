/**
 * apoios-diff-alarm.ts (#4485 item 2)
 *
 * Lógica PURA (sem I/O) do alarme diário de diff pendente do sync de
 * `apoio_nivel` — mesmo molde de `scripts/lib/cursos-error-alarm.ts` /
 * `scripts/lib/clarice-guardrail-alarm.ts`: calcula um fingerprint estável
 * do diff atual, compara contra o último alarme já disparado (idempotência —
 * nunca realarma o MESMO diff 2x enquanto o editor não age), monta o corpo
 * do e-mail. O script `scripts/apoios-diff-alarm.ts` é quem faz o I/O (roda
 * o MESMO cálculo de diff do dry-run de `sync-apoio-nivel-beehiiv.ts`, envia
 * e-mail via Gmail) e usa este módulo pra decidir SE/O-QUE alarmar.
 *
 * Contexto (#4485 item 2, corpo da issue): `/diaria-apoios-sync` é invocação
 * manual — sem nenhuma automação, `apoio_nivel` só fica correto enquanto
 * alguém lembrar de rodar. Opção (a) da issue (recomendada): task agendada
 * que roda só o DRY-RUN e alarma quando há diff, sem `--push` automático — o
 * push continua com gate humano (desenho atual preservado).
 *
 * ─── Idempotência: RE-ARMA quando o diff desaparece ────────────────────────
 *
 * Diferente do cursor de contadores CUMULATIVOS de `cursos-error-alarm.ts`
 * (que só cresce), um diff de sync pode aparecer, ser resolvido (editor
 * rodou `--push`) e reaparecer depois com o MESMO shape (raro, mas possível —
 * alguém cancela e re-assina no mesmo nível). Por isso o cursor
 * (`lastAlarmedFingerprint`) é resetado pro caller sempre que
 * `hasPendingDiff() === false` (diff limpo) — a próxima vez que aquele MESMO
 * diff reaparecer, alarma de novo. Enquanto o diff persistir (editor ainda
 * não agiu), o mesmo fingerprint não gera um novo e-mail a cada rodada diária
 * — só quando o CONTEÚDO do diff muda (alguém novo entrou, outro saiu) ou
 * depois de ele ter sido resolvido e reaparecer.
 */

export interface DiffAlarmEntrySummary {
  email: string;
  contactName: string;
  fromLevel: string | null;
  toLevel: string | null;
}

export interface DiffAlarmInput {
  toApply: DiffAlarmEntrySummary[];
  toRemove: DiffAlarmEntrySummary[];
}

/** Pure: há diff pendente que exigiria uma ação de `--push`? Ignora
 * `skippedUnresolved`/`notBeehiivSubscriber` de propósito — nenhum dos dois
 * é resolvido por um `--push` (são "sem dado" / "sem vínculo"), então não
 * contam como "trabalho pendente" pra este alarme. */
export function hasPendingDiff(input: DiffAlarmInput): boolean {
  return input.toApply.length > 0 || input.toRemove.length > 0;
}

/** Pure: fingerprint estável (determinístico, independente da ordem de
 * chegada) do diff pendente — usado pra idempotência. */
export function computeDiffFingerprint(input: DiffAlarmInput): string {
  const key = (prefix: "+" | "-", e: DiffAlarmEntrySummary): string =>
    `${prefix}${e.email}:${e.fromLevel ?? "-"}>${e.toLevel ?? "-"}`;
  const applyKeys = input.toApply.map((e) => key("+", e)).sort();
  const removeKeys = input.toRemove.map((e) => key("-", e)).sort();
  return [...applyKeys, ...removeKeys].join("|");
}

export interface ApoiosDiffAlarmState {
  /** Fingerprint do diff já alarmado (ou `null` — sem diff pendente
   * conhecido, "re-armado"). */
  lastAlarmedFingerprint: string | null;
  /** ISO — só pra REPORTAR ("desde X"), não participa da idempotência. */
  lastCheckedAt: string | null;
}

export function emptyApoiosDiffAlarmState(): ApoiosDiffAlarmState {
  return { lastAlarmedFingerprint: null, lastCheckedAt: null };
}

/** Pura: avança o cursor — `fingerprint: null` quando o diff está limpo
 * nesta checagem (re-arma pra próxima ocorrência). */
export function advanceState(fingerprint: string | null, now: Date): ApoiosDiffAlarmState {
  return { lastAlarmedFingerprint: fingerprint, lastCheckedAt: now.toISOString() };
}

/**
 * Pure: `true` quando há diff pendente E o fingerprint é diferente do último
 * já alarmado (diff novo, diff mudou de shape, ou diff reapareceu depois de
 * ter sido resolvido — ver docstring do módulo).
 */
export function shouldAlarm(state: ApoiosDiffAlarmState, input: DiffAlarmInput): boolean {
  if (!hasPendingDiff(input)) return false;
  return computeDiffFingerprint(input) !== state.lastAlarmedFingerprint;
}

/** Pure: monta assunto + corpo do e-mail de alarme — texto puro (mesmo
 * padrão de `scripts/lib/gmail-send.ts`, sem HTML). */
export function buildApoiosDiffAlarmEmail(input: DiffAlarmInput): { subject: string; body: string } {
  const subject = `[diar.ia.br] apoio_nivel: ${input.toApply.length} adição(ões)/troca(s), ${input.toRemove.length} remoção(ões) pendente(s)`;

  const lines: string[] = [
    "O dry-run diário de /diaria-apoios-sync encontrou diff pendente entre",
    "apoia.se e o custom field apoio_nivel na Beehiiv.",
    "",
  ];

  if (input.toApply.length > 0) {
    lines.push(`Adições/trocas de nível (${input.toApply.length}):`);
    for (const e of input.toApply) {
      lines.push(`  + ${e.email} (${e.contactName}): ${e.fromLevel ?? "(nenhum)"} -> ${e.toLevel}`);
    }
    lines.push("");
  }

  if (input.toRemove.length > 0) {
    lines.push(`Remoções (${input.toRemove.length}):`);
    for (const e of input.toRemove) {
      lines.push(`  - ${e.email} (${e.contactName}): ${e.fromLevel} -> (nenhum)`);
    }
    lines.push("");
  }

  lines.push(
    "Rode /diaria-apoios-sync (revisa o diff + Passo 1 de drift check antes) ou",
    "npx tsx scripts/sync-apoio-nivel-beehiiv.ts --push pra aplicar.",
    "",
    "Este alarme NUNCA aplica --push sozinho — só avisa que há diff pendente.",
  );

  return { subject, body: lines.join("\n") };
}
