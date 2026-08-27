/**
 * subscribe-redirect-drift-check.ts (#6365)
 *
 * Lógica PURA (sem I/O) do smoke-test que verifica se a superfície pública
 * de cadastro do apex (`diar.ia.br/subscribe`, um 302 pra
 * `https://diar-ia-br.kit.com/` — `workers/site/public/_redirects`,
 * #6359/#6363) ainda serve um formulário de cadastro de verdade. Mesmo
 * molde de `scripts/lib/hub-drift-check.ts`/`scripts/lib/worker-drift-check.ts`:
 * uma função de decisão testável (`evaluateSubscribeDrift`) que recebe o
 * resultado do fetch já resolvido (nunca faz a chamada de rede em si), mais
 * fingerprint + estado de idempotência pro alarme por e-mail. O script
 * `scripts/subscribe-redirect-drift-check.ts` é quem faz o I/O (bate os
 * GETs) e usa este módulo pra decidir SE/O-QUE alarmar.
 *
 * ─── Contexto (#6365, achado do fleet review da PR #6363) ──────────────────
 *
 * O destino do redirect (`https://diar-ia-br.kit.com/`, o perfil hospedado
 * padrão da conta Kit — não há landing page própria publicada, ver
 * comentário de `workers/site/public/_redirects`) foi verificado ao vivo
 * UMA vez em 26/08/2026. Nada re-verificava isso depois. Se o Kit renomear
 * o slug, despublicar o perfil, mudar o esquema de URL, ou a conta lapsar,
 * `/subscribe` vira um 302 pra uma página morta — e TODAS as camadas
 * reportam sucesso: a Cloudflare serve o redirect, o Worker faz o que
 * mandaram, e a página de erro do Kit tipicamente responde 200 com corpo de
 * erro. Sem log, sem alerta, nenhum código de status errado em lugar
 * nenhum. Depois do cutover do #467, `/subscribe` é a ÚNICA porta de
 * cadastro pelo site — o sinal de quebra seria o crescimento estagnar,
 * dias ou semanas depois.
 *
 * `test/site-worker-routes-6359.test.ts` garante que a REGRA existe e
 * aponta pra `kit.com` com um código 3xx — guard de regressão de arquivo,
 * válido, mas passa para sempre, inclusive no dia em que o destino morrer
 * (ou se alguém errar o slug pra `diar-ia-br-typo.kit.com`, que ainda casa
 * `/kit\.com/`). Esta checagem responde a pergunta que aquele teste não
 * pode responder — "o destino publicado hoje ainda serve o que promete?"
 *
 * ─── Por que "broken" cobre HTTP não-200 E body sem os marcadores ──────────
 *
 * Só status não basta — uma página de erro genérica da Kit tipicamente
 * responde 200 com corpo de erro (documentado na issue). Por isso todo
 * alvo declara `expectedMarkers`: substrings que só aparecem quando a
 * página REAL de cadastro está sendo servida (campo de e-mail + botão
 * "Subscribe" — confirmado ao vivo via curl com UA de navegador em
 * 26/08/2026, ver `KIT_SUBSCRIBE_EXPECTED_MARKERS`). Falta de qualquer um
 * dos marcadores conta como `broken`, igual a um status != 200.
 *
 * ─── Escopo estendido: também audita o que o Worker `diaria-site` SERVE
 * (não só o que o `_redirects` diz) ──────────────────────────────────────
 *
 * A issue #6365 pede considerar (item 4 do checklist) fechar o laço entre
 * "config committada parece certa" e "a Cloudflare serve o que a gente
 * quis" — mesma classe de achado do Finding 3 do fleet review da PR #6363
 * (`deploy-site.yml` roda `wrangler deploy` sem smoke-test pós-deploy).
 * `DEFAULT_TARGETS` cobre isso incluindo, além do destino Kit, `GET /` e
 * `GET /p/{slug}` (amostra) no host `workers.dev` do Worker (pré-cutover,
 * `WORKER_DEV_HOST` de `scripts/lib/apex-cutover.ts` — mesmo host que o
 * guard de pré-condição do `--cutover` já usa, então após o cutover o
 * mesmo Worker seguirá respondendo lá independente do apex). Os 2 targets
 * do Worker reusam `EXPECTED_ROOT_MARKER`/`SAMPLE_ARCHIVE_SLUG` já
 * definidos em `apex-cutover.ts` — fonte única, não duplicada aqui.
 *
 * ─── Idempotência: RE-ARMA quando o drift muda de shape ou desaparece ──────
 *
 * Mesmo padrão de `hub-drift-check.ts`/`apoios-diff-alarm.ts`/
 * `worker-drift-check.ts`: o fingerprint inclui o key + status + detalhe
 * (http status, marcador ausente, ou mensagem de erro) de cada alvo
 * problemático — o mesmo drift persistindo não gera e-mail novo a cada
 * execução; um alvo adicional quebrando muda o fingerprint; o drift sendo
 * resolvido "re-arma" o cursor; o mesmo alvo quebrando de novo depois
 * alarma de novo mesmo partindo de um cursor re-armado.
 */

// ─── Alvos checados (identidade + marcador esperado) ───────────────────────

export interface DriftTarget {
  /** Identificador estável — usado no fingerprint e como chave de issue. */
  key: string;
  /** Rótulo humano, usado no e-mail. */
  label: string;
  /** URL completa checada. */
  url: string;
  /**
   * Substrings que TODAS precisam estar presentes no corpo pra o alvo contar
   * como `ok` — status 200 sozinho não basta (página de erro pode vir 200,
   * ver docstring do módulo).
   */
  expectedMarkers: readonly string[];
  /** Descrição curta do que os marcadores provam, pro texto do e-mail. */
  markerDescription: string;
}

/** Destino do redirect `/subscribe` — perfil hospedado padrão da conta Kit
 * (`workers/site/public/_redirects`). Não confundir com `WORKER_DEV_HOST`
 * (host `workers.dev` do Worker `diaria-site`, importado abaixo de
 * `scripts/lib/apex-cutover.ts`) — são hosts DIFERENTES: este é de
 * terceiro (Kit), aquele é o nosso próprio Worker. */
export const KIT_SUBSCRIBE_URL = "https://diar-ia-br.kit.com/";

/**
 * Marcadores confirmados ao vivo (curl com `BROWSER_USER_AGENT`, sem UA a
 * Cloudflare devolve challenge — ver memória "curl sem UA recebe challenge")
 * em 26/08/2026: campo de e-mail (`type="email"`) + botão de submit
 * (`>Subscribe<`). Escolhidos por serem específicos o bastante pra não
 * aparecerem numa página de erro genérica, mas sem depender de classe CSS/
 * estrutura de markup que o Kit pode trocar em qualquer redesign cosmético.
 */
export const KIT_SUBSCRIBE_EXPECTED_MARKERS = ['type="email"', ">Subscribe<"] as const;

export function buildDefaultTargets(input: {
  workerDevHost: string;
  expectedRootMarker: string;
  sampleArchiveSlug: string;
}): DriftTarget[] {
  const { workerDevHost, expectedRootMarker, sampleArchiveSlug } = input;
  return [
    {
      key: "kit-subscribe",
      label: "Destino do redirect /subscribe (perfil hospedado Kit)",
      url: KIT_SUBSCRIBE_URL,
      expectedMarkers: KIT_SUBSCRIBE_EXPECTED_MARKERS,
      markerDescription: "campo de e-mail + botão \"Subscribe\"",
    },
    {
      key: "worker-root",
      label: "Worker diaria-site — / (home própria)",
      url: `https://${workerDevHost}/`,
      expectedMarkers: [expectedRootMarker],
      markerDescription: `marcador da home (${expectedRootMarker})`,
    },
    {
      key: "worker-sample-page",
      label: "Worker diaria-site — /p/{slug} (amostra do acervo)",
      url: `https://${workerDevHost}/p/${sampleArchiveSlug}`,
      expectedMarkers: [`href="https://diar.ia.br/p/${sampleArchiveSlug}"`],
      markerDescription: "canonical apontando pro apex",
    },
  ];
}

// ─── Avaliação de drift por alvo (pura) ────────────────────────────────────

export type SubscribeDriftStatus =
  /** GET respondeu 200 e o corpo contém todos os `expectedMarkers`. */
  | "ok"
  /** GET respondeu status != 200, OU respondeu 200 mas o corpo não contém
   * algum marcador esperado (página de erro/placeholder servida com 200). */
  | "broken"
  /** A chamada de rede em si falhou (timeout, DNS, conexão recusada). */
  | "error";

export interface DriftCheckInput extends DriftTarget {
  /** Status HTTP da resposta, ou `null` se a chamada de rede falhou. */
  httpStatus: number | null;
  /** Mensagem de erro da chamada de rede, se houve falha. */
  fetchError: string | null;
  /** Corpo da resposta, ou `null` se erro de rede/corpo ilegível. */
  body: string | null;
}

export interface DriftCheckResult {
  key: string;
  label: string;
  url: string;
  status: SubscribeDriftStatus;
  httpStatus: number | null;
  fetchError: string | null;
  message: string;
}

/** Pura — decide o status de UM alvo, a partir do resultado do fetch já
 * resolvido (nenhuma chamada de rede aqui). */
export function evaluateSubscribeDrift(input: DriftCheckInput): DriftCheckResult {
  const { key, label, url, httpStatus, fetchError, body, expectedMarkers, markerDescription } = input;

  if (fetchError) {
    return { key, label, url, status: "error", httpStatus: null, fetchError, message: `falha ao consultar ${url}: ${fetchError}` };
  }

  if (httpStatus !== 200) {
    return {
      key,
      label,
      url,
      status: "broken",
      httpStatus,
      fetchError: null,
      message: `${url} respondeu ${httpStatus} (esperava 200)`,
    };
  }

  const missing = expectedMarkers.filter((marker) => !body || !body.includes(marker));
  if (missing.length > 0) {
    return {
      key,
      label,
      url,
      status: "broken",
      httpStatus,
      fetchError: null,
      message:
        `${url} respondeu 200 mas o corpo não contém ${missing.length === expectedMarkers.length ? "nenhum" : "todos os"} ` +
        `marcador(es) esperado(s) (${markerDescription}) — página de erro/placeholder servida com 200?`,
    };
  }

  return { key, label, url, status: "ok", httpStatus, fetchError: null, message: `${url} respondeu 200 com ${markerDescription} presente(s)` };
}

/** Pura — mapeia `evaluateSubscribeDrift` sobre uma lista de alvos. */
export function evaluateAllSubscribeDrift(inputs: readonly DriftCheckInput[]): DriftCheckResult[] {
  return inputs.map(evaluateSubscribeDrift);
}

// ─── Idempotência do alarme (fingerprint + estado) ─────────────────────────

/** Pura — "broken"/"error" contam como pendência que justifica e-mail. */
export function hasPendingSubscribeDrift(results: readonly DriftCheckResult[]): boolean {
  return results.some((r) => r.status === "broken" || r.status === "error");
}

/** Pura — fingerprint estável de UM alvo (mesmo padrão de
 * `hubDriftFindingKey`) — usado tanto no fingerprint do conjunto quanto como
 * chave de `AlarmFinding`/`issueRefs`. */
export function subscribeDriftFindingKey(
  r: Pick<DriftCheckResult, "key" | "status" | "httpStatus" | "fetchError">,
): string {
  return `${r.key}:${r.status}:${r.httpStatus ?? "-"}:${r.fetchError ?? "-"}`;
}

/** Pura — fingerprint estável (determinístico, independente da ordem de
 * chegada) do conjunto de alvos com drift pendente. */
export function computeSubscribeDriftFingerprint(results: readonly DriftCheckResult[]): string {
  const pending = results.filter((r) => r.status === "broken" || r.status === "error");
  const keys = pending.map((r) => subscribeDriftFindingKey(r)).sort();
  return keys.join("|");
}

export interface SubscribeDriftAlarmState {
  /** Fingerprint do drift já alarmado (ou `null` — "re-armado"). */
  lastAlarmedFingerprint: string | null;
  /** ISO — só pra REPORTAR, não participa da idempotência. */
  lastCheckedAt: string | null;
}

export function emptySubscribeDriftAlarmState(): SubscribeDriftAlarmState {
  return { lastAlarmedFingerprint: null, lastCheckedAt: null };
}

/** Pura — avança o cursor. `fingerprint: null` quando não há drift pendente
 * nesta checagem (re-arma pra próxima ocorrência). */
export function advanceSubscribeDriftState(fingerprint: string | null, now: Date): SubscribeDriftAlarmState {
  return { lastAlarmedFingerprint: fingerprint, lastCheckedAt: now.toISOString() };
}

/** Pura — `true` quando há drift pendente E o fingerprint é diferente do
 * último já alarmado. */
export function shouldAlarmSubscribeDrift(
  state: SubscribeDriftAlarmState,
  results: readonly DriftCheckResult[],
): boolean {
  if (!hasPendingSubscribeDrift(results)) return false;
  return computeSubscribeDriftFingerprint(results) !== state.lastAlarmedFingerprint;
}

// ─── Corpo do e-mail de alarme (puro) ──────────────────────────────────────

/** Pura — monta assunto + corpo do e-mail de alarme (texto puro, mesmo
 * padrão de `buildHubDriftAlarmEmail`). Lista só os alvos `broken`/`error`.
 * `issueRefs` (opcional) — mapa `subscribeDriftFindingKey -> {issueNumber,
 * url, action, error}` de `scripts/lib/alarm-issues.ts`. `undefined`
 * (dry-run, ou wiring ainda não chamado) omite a citação sem quebrar nada. */
export function buildSubscribeDriftAlarmEmail(
  results: readonly DriftCheckResult[],
  now: Date = new Date(),
  issueRefs?: ReadonlyMap<string, { issueNumber: number | null; url: string | null; action: string; error?: string }>,
): { subject: string; body: string } {
  const broken = results.filter((r) => r.status === "broken" || r.status === "error");

  const subject = `[diar.ia.br] ${broken.length} alvo(s) de cadastro do apex fora do ar (/subscribe)`;

  const lines: string[] = [
    "O smoke-test da superfície de cadastro do apex (diar.ia.br/subscribe e",
    "o Worker diaria-site que a serve) encontrou alvo(s) que não estão",
    "respondendo o que deveriam.",
    "",
    "Isto é DIFERENTE de test/site-worker-routes-6359.test.ts (que só checa",
    "se a REGRA de redirect existe e aponta pra kit.com, no código committed)",
    "— este alarme pergunta se o destino publicado hoje ainda serve o que",
    "promete, incluindo o caso do status vir 200 mas o corpo ser uma página",
    "de erro/placeholder (ver #6365).",
    "",
    `Alvo(s) com problema (${broken.length}):`,
  ];

  for (const r of broken) {
    const detail = r.status === "error" ? `erro de rede: ${r.fetchError}` : r.message;
    lines.push(`  - ${r.label} (${r.key}): ${detail}`);
    lines.push(`    URL: ${r.url}`);
    const ref = issueRefs?.get(subscribeDriftFindingKey(r));
    if (ref) {
      lines.push(ref.action === "failed" ? `    Issue: falha ao criar/reusar (${ref.error})` : `    Issue: #${ref.issueNumber} (${ref.url})`);
    }
  }

  lines.push(
    "",
    "Se o alvo quebrado for \"kit-subscribe\": o slug/perfil hospedado do Kit",
    "pode ter mudado, sido despublicado, ou a conta lapsou — confira",
    "https://app.kit.com e, se o destino mudou, atualize",
    "workers/site/public/_redirects (única fonte da URL).",
    "Se for \"worker-root\"/\"worker-sample-page\": confira se o deploy do",
    "Worker diaria-site (workers/site) está com o commit mais recente.",
    "",
    `(alarme automático — checagem rodou em ${now.toISOString()})`,
  );

  return { subject, body: lines.join("\n") };
}
