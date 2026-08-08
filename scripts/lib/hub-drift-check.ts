/**
 * hub-drift-check.ts (#4750)
 *
 * Lógica PURA (sem I/O) do smoke-test de runtime que compara `HUB_META`
 * (`workers/arquivo/src/hubs/meta.ts`) contra o que o Worker `arquivo`
 * publicado de fato serve em `GET /temas/{slug}` — mesmo molde de
 * `scripts/lib/worker-drift-check.ts`/`scripts/lib/apoios-diff-alarm.ts`: uma
 * função de decisão testável (`evaluateHubDrift`) que recebe o resultado do
 * fetch já resolvido (nunca faz a chamada de rede em si), mais fingerprint +
 * estado de idempotência pro alarme por e-mail. O script
 * `scripts/hub-drift-check.ts` é quem faz o I/O (lê `HUB_META`, bate o GET) e
 * usa este módulo pra decidir SE/O-QUE alarmar.
 *
 * ─── Contexto (#4750, follow-up do fleet review da PR #4749) ───────────────
 *
 * `test/hub-registry-completeness.test.ts` cruza `HUB_LOADERS`/`HUB_REGISTRY`/
 * `HUB_META` — mas é inteiramente TEST-TIME. Nada checa o que está de fato
 * servido pelo Worker publicado; se os registries divergirem por um caminho
 * que não passe pelo CI de PR, o drift chega em produção como um hub
 * servindo 404 sem nenhum log/alarme. Mesma classe de problema da #4723
 * (Worker publicado divergindo de master), aqui aplicada ao caso específico
 * "link interno apontando pra 404" em vez de "código velho no ar".
 *
 * ─── Por que "broken" inclui tanto HTTP não-200 quanto erro de fetch ───────
 *
 * Diferente do `worker-drift-check.ts` (onde uma falha de API é da CONTA
 * INTEIRA — um `deployError` único aplicado a todos os workers da execução,
 * porque é UMA chamada pra todos), aqui cada hub é um GET independente: um
 * erro de rede/timeout NUM hub específico já é, por si só, informação
 * equivalente a um 404 — "este link não está servindo o que devia" — não uma
 * falha de infraestrutura de checagem que precisa de tratamento separado.
 * Por isso não há aqui um mecanismo de "falha sustentada da checagem inteira"
 * análogo a `advanceApiErrorState`/`shouldAlarmApiError` — cada hub decide
 * seu próprio status de forma independente.
 *
 * ─── Idempotência: RE-ARMA quando o drift muda de shape ou desaparece ──────
 *
 * Mesmo padrão de `apoios-diff-alarm.ts`/`worker-drift-check.ts`: o
 * fingerprint inclui o slug + status + detalhe (http status ou mensagem de
 * erro) de cada hub problemático, então:
 *   - o MESMO drift persistindo (nada mudou) não gera um novo e-mail a cada
 *     execução da task;
 *   - um hub adicional quebrando muda o fingerprint — alarma de novo;
 *   - o drift sendo resolvido (deploy corrige o Worker, ou o registry é
 *     corrigido) faz esse hub sair do conjunto "problemático" — o cursor
 *     "re-arma" (`advanceState` grava `null` quando não há mais drift
 *     pendente);
 *   - o MESMO hub voltando a quebrar depois gera um fingerprint novo (novo
 *     detalhe de erro/status) — alarma de novo mesmo partindo de um cursor
 *     "re-armado".
 */

// ─── Avaliação de drift por hub (pura) ─────────────────────────────────────

export type HubDriftStatus =
  /** GET /temas/{slug} respondeu 200 — hub está no ar como o registry promete. */
  | "ok"
  /** GET /temas/{slug} respondeu um status != 200 (404, 500, etc). */
  | "broken"
  /** A chamada de rede em si falhou (timeout, DNS, conexão recusada) — sem
   * resposta HTTP nenhuma pra este hub. Tratado como pendência igual a
   * "broken" (ver docstring do módulo) — não é um erro de infraestrutura de
   * checagem, é sinal de que o link não está servindo o que devia. */
  | "error";

export interface HubCheckInput {
  /** Slug servido em `GET /temas/{slug}` — igual à chave em `HUB_REGISTRY`. */
  slug: string;
  /** Rótulo humano (de `HUB_META`), usado só pro texto do e-mail. */
  label: string;
  /** URL completa checada (`{DIARIA_ARQUIVO_URL}/temas/{slug}`), pro e-mail/log. */
  url: string;
  /** Status HTTP da resposta, ou `null` se a chamada de rede falhou (ver `fetchError`). */
  httpStatus: number | null;
  /** Mensagem de erro da chamada de rede, se houve falha (timeout, DNS, etc). */
  fetchError: string | null;
}

export interface HubDriftResult {
  slug: string;
  label: string;
  url: string;
  status: HubDriftStatus;
  httpStatus: number | null;
  fetchError: string | null;
  /** Mensagem legível — motivo do status. */
  message: string;
}

/** Pura — decide o status de drift de UM hub, a partir do resultado do fetch
 * já resolvido (nenhuma chamada de rede aqui). */
export function evaluateHubDrift(input: HubCheckInput): HubDriftResult {
  const { slug, label, url, httpStatus, fetchError } = input;

  if (fetchError) {
    return {
      slug,
      label,
      url,
      status: "error",
      httpStatus: null,
      fetchError,
      message: `falha ao consultar ${url}: ${fetchError}`,
    };
  }

  if (httpStatus === 200) {
    return { slug, label, url, status: "ok", httpStatus, fetchError: null, message: `${url} respondeu 200` };
  }

  return {
    slug,
    label,
    url,
    status: "broken",
    httpStatus,
    fetchError: null,
    message: `${url} respondeu ${httpStatus} (esperava 200)`,
  };
}

/** Pura — mapeia `evaluateHubDrift` sobre uma lista de hubs. */
export function evaluateAllHubDrift(inputs: readonly HubCheckInput[]): HubDriftResult[] {
  return inputs.map(evaluateHubDrift);
}

// ─── Idempotência do alarme (fingerprint + estado) ─────────────────────────

/** Pura — "broken"/"error" contam como pendência que justifica e-mail. */
export function hasPendingHubDrift(results: readonly HubDriftResult[]): boolean {
  return results.some((r) => r.status === "broken" || r.status === "error");
}

/** Pura — fingerprint estável (determinístico, independente da ordem de
 * chegada) do conjunto de hubs com drift pendente — usado pra idempotência.
 * Inclui status + detalhe (httpStatus ou fetchError) de cada hub pendente:
 * qualquer um dos dois mudando (ex: 404 -> 500) muda o fingerprint e
 * re-alarma. */
export function computeHubDriftFingerprint(results: readonly HubDriftResult[]): string {
  const pending = results.filter((r) => r.status === "broken" || r.status === "error");
  const keys = pending
    .map((r) => `${r.slug}:${r.status}:${r.httpStatus ?? "-"}:${r.fetchError ?? "-"}`)
    .sort();
  return keys.join("|");
}

export interface HubDriftAlarmState {
  /** Fingerprint do drift já alarmado (ou `null` — sem drift pendente conhecido, "re-armado"). */
  lastAlarmedFingerprint: string | null;
  /** ISO — só pra REPORTAR ("desde X"), não participa da idempotência. */
  lastCheckedAt: string | null;
}

export function emptyHubDriftAlarmState(): HubDriftAlarmState {
  return { lastAlarmedFingerprint: null, lastCheckedAt: null };
}

/** Pura — avança o cursor. `fingerprint: null` quando não há drift pendente
 * nesta checagem (re-arma pra próxima ocorrência, mesmo padrão de
 * `apoios-diff-alarm.ts`/`worker-drift-check.ts`). */
export function advanceHubDriftState(fingerprint: string | null, now: Date): HubDriftAlarmState {
  return { lastAlarmedFingerprint: fingerprint, lastCheckedAt: now.toISOString() };
}

/**
 * Pura — `true` quando há drift pendente E o fingerprint é diferente do
 * último já alarmado (drift novo, mudou de shape, ou reapareceu depois de
 * resolvido — ver docstring do módulo).
 */
export function shouldAlarmHubDrift(state: HubDriftAlarmState, results: readonly HubDriftResult[]): boolean {
  if (!hasPendingHubDrift(results)) return false;
  return computeHubDriftFingerprint(results) !== state.lastAlarmedFingerprint;
}

// ─── Corpo do e-mail de alarme (puro) ──────────────────────────────────────

/** Pura — monta assunto + corpo do e-mail de alarme (texto puro, mesmo
 * padrão de `scripts/lib/gmail-send.ts`/`worker-drift-check.ts`, sem HTML).
 * Lista só os hubs com `status` "broken"/"error"; hubs "ok" não aparecem. */
export function buildHubDriftAlarmEmail(
  results: readonly HubDriftResult[],
  now: Date = new Date(),
): { subject: string; body: string } {
  const broken = results.filter((r) => r.status === "broken" || r.status === "error");

  const subject = `[diar.ia.br] ${broken.length} hub(s) temático(s) fora do ar (arquivo.diar.ia.br)`;

  const lines: string[] = [
    "O smoke-test de HUB_META contra o Worker publicado (arquivo.diar.ia.br)",
    "encontrou hub(s) temático(s) que não respondem 200 em GET /temas/{slug}.",
    "Isso significa um link interno (navegação \"Por tema\" do arquivo) apontando",
    "pra um 404/erro, ou o hub inteiro fora do ar.",
    "",
    `Hub(s) com problema (${broken.length}):`,
  ];

  for (const r of broken) {
    const detail = r.status === "error" ? `erro de rede: ${r.fetchError}` : `HTTP ${r.httpStatus} (esperava 200)`;
    lines.push(`  - ${r.label} (slug: ${r.slug}): ${detail}`);
    lines.push(`    URL: ${r.url}`);
  }

  lines.push(
    "",
    "Isto é DIFERENTE de test/hub-registry-completeness.test.ts (que só checa",
    "se HUB_LOADERS/HUB_REGISTRY/HUB_META concordam entre si no código) — este",
    "alarme pergunta se o que está no ar concorda com o que o código diz.",
    "",
    "Verifique se o Worker `arquivo` está deployado com o commit mais recente",
    "(cd workers/arquivo && npx wrangler deploy) e se o slug existe de fato em",
    "workers/arquivo/src/hubs/registry.ts.",
    "",
    `(alarme automático — checagem rodou em ${now.toISOString()})`,
  );

  return { subject, body: lines.join("\n") };
}
