/**
 * scripts/lib/gtm-drift-check.ts (#8585)
 *
 * Lógica PURA (sem I/O) do drift-check do container GTM PUBLICADO
 * (`GTM-TC8C65ZN`) contra o que este repo espera que ele carregue pro
 * evento `CompleteRegistration` do Meta Pixel.
 *
 * ─── Por que este check existe (#8578, #8572) ───────────────────────────────
 *
 * `test/meta-capi-8388.test.ts` audita `docs/gtm-signup-container-import-proposal.json`
 * — uma PROPOSTA de import versionada neste repo — contra
 * `META_CAPI_COMPLETE_REGISTRATION_VALUE`/`_CURRENCY`
 * (`scripts/lib/shared/meta-capi.ts`). Isso garante consistência INTERNA do
 * arquivo versionado, mas nunca olha o container que está de fato no ar: o
 * container publicado usa o TEMPLATE OFICIAL do Meta Pixel (`__cvt_5RM3Q`),
 * não a tag Custom HTML que a proposta descreve, e tem campos que a
 * proposta nem modela (`vtp_eventId`, advanced matching) — foi exatamente
 * esse campo ausente da proposta que atrasou o diagnóstico da #8572. Nada
 * no repo detectava essa divergência porque nada comparava contra o
 * `gtm.js` público de verdade.
 *
 * Este módulo fecha essa lacuna sem duplicar o papel do guard existente: o
 * `test/meta-capi-8388.test.ts` continua útil pra consistência interna da
 * proposta; este módulo é o watchdog de RUNTIME que compara contra o
 * container ao vivo — mesma separação de papéis que
 * `hub-drift-check.ts`/`home-meta-check.ts`/`subscribe-redirect-drift-check.ts`
 * já aplicam a outras superfícies publicadas fora do controle direto do
 * repo. O script fino (`scripts/gtm-drift-check.ts`) faz o `fetch` do
 * `gtm.js` público (`GET`, sem credencial, mesmo raciocínio de
 * `home-meta-check.ts`) e delega toda decisão pra cá.
 *
 * ─── Por que a extração é por regex sobre o `gtm.js` minificado, não parse
 * estrutural ────────────────────────────────────────────────────────────────
 *
 * O `gtm.js` público não é JSON — é um blob JS altamente minificado/
 * ofuscado que embute a definição de cada tag/template como literais
 * dentro de arrays/objetos gerados pelo compilador do Tag Manager. Não há
 * schema estável documentado publicamente pra esse formato (é superfície
 * interna do Google, sujeita a mudar sem aviso), e escrever um parser
 * estrutural completo só pra isso seria mais frágil que o problema que
 * resolve. Em vez disso, cada campo é procurado por um marcador textual
 * ESPECÍFICO o bastante pra não casar por acidente (nome do campo `vtp_*`
 * do template oficial, ou o valor esperado entre aspas logo depois dele) —
 * a mesma disciplina de `evaluateHomeMetaDrift`/`evaluateAllSubscribeDrift`,
 * que também procuram marcadores textuais em HTML em vez de fazer parse de
 * DOM completo.
 *
 * **Cada checagem tem 3 desfechos, nunca 2** — `"match"` (achou o campo e o
 * valor bate), `"mismatch"` (achou o campo com valor DIFERENTE do
 * esperado — isto é o drift real que #8585 quer capturar) e `"not-found"`
 * (não achou o marcador do campo). `"not-found"` NUNCA vira `"mismatch"`
 * silenciosamente — o formato do `gtm.js` pode legitimamente mudar (Google
 * recompila o container, muda a ofuscação) sem que o campo tenha
 * realmente sumido, e tratar ausência-de-marcador como drift real
 * produziria falso alarme toda vez que o formato mudasse por razão alheia
 * ao conteúdo. `hasGtmDrift` só considera `"mismatch"` como drift
 * acionável — `"not-found"` fica visível no relatório/e-mail (pra o editor
 * saber que aquele eixo não pôde ser confirmado desta vez) mas nunca abre
 * issue sozinho.
 */

/** Pixel/dataset ID que o container deveria carregar — mesmo valor de
 * `META_CAPI_DEFAULT_DATASET_ID` (`scripts/lib/shared/meta-capi.ts`). */
export interface GtmExpectedConfig {
  pixelId: string;
  /** Nome do evento padrão — `"CompleteRegistration"`. */
  eventName: string;
  /** `META_CAPI_COMPLETE_REGISTRATION_VALUE`, como string (o `gtm.js`
   * carrega valores de template como literais de texto). */
  value: string;
  /** `META_CAPI_COMPLETE_REGISTRATION_CURRENCY`. */
  currency: string;
}

export type GtmCheckStatus = "match" | "mismatch" | "not-found";

export type GtmCheckAxis = "pixel-id" | "event-name" | "value" | "currency" | "event-id-field";

export interface GtmCheckResult {
  check: GtmCheckAxis;
  status: GtmCheckStatus;
  message: string;
}

/** Extrai o valor entre aspas logo após uma chave `vtp_*` (ou qualquer
 * chave literal) no formato `"chave":"valor"` — tolera espaço opcional em
 * volta dos dois-pontos (o `gtm.js` publicado não tem esse espaço, mas
 * fixtures/format futuros podem). Devolve `null` quando a chave não é
 * encontrada. @pure */
export function extractQuotedValueAfterKey(gtmJsText: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`"${escaped}"\\s*:\\s*"([^"]*)"`).exec(gtmJsText);
  return match ? match[1] : null;
}

/**
 * Extrai o valor de uma entrada `objectPropertyList` do template oficial —
 * compilada como um par `map` com chaves `name`/`value`, ex:
 * `["map","name","currency","value","BRL"]`. Aceita as duas ordens
 * possíveis de serialização (`name` antes ou depois do par `value`) e
 * tolera aspas simples ou duplas (o compilador do GTM já foi visto usando
 * as duas, dependendo da versão). Devolve `null` quando o par `name` não é
 * encontrado — NUNCA lança. @pure
 */
export function extractObjectPropertyListValue(gtmJsText: string, propertyName: string): string | null {
  const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    // ["map","name","currency","value","BRL"]
    new RegExp(`["']name["']\\s*,\\s*["']${escaped}["']\\s*,\\s*["']value["']\\s*,\\s*["']([^"']*)["']`),
    // ["map","value","BRL","name","currency"]
    new RegExp(`["']value["']\\s*,\\s*["']([^"']*)["']\\s*,\\s*["']name["']\\s*,\\s*["']${escaped}["']`),
  ];
  for (const re of patterns) {
    const match = re.exec(gtmJsText);
    if (match) return match[1];
  }
  return null;
}

/**
 * Compara o `gtm.js` público (já buscado) contra o que este repo espera
 * pro evento `CompleteRegistration`. Nunca lança — texto vazio/malformado
 * só produz `"not-found"` em todos os eixos, nunca uma exceção. @pure
 */
export function evaluateGtmDrift(gtmJsText: string, expected: GtmExpectedConfig): GtmCheckResult[] {
  const results: GtmCheckResult[] = [];

  // #8613 review, achado alta confiança/P2: extrair o valor REAL de
  // `vtp_pixelId`/`vtp_standardEventName` e comparar (em vez de só checar
  // presença via `.includes`) — senão um pixel ID/evento genuinamente
  // TROCADO no container vira `"not-found"` (não-acionável) em vez de
  // `"mismatch"` (drift real), justo o cenário mais grave que este check
  // deveria pegar (raiz do #8572: campo divergente que ninguém detectava).
  const pixelId = extractQuotedValueAfterKey(gtmJsText, "vtp_pixelId");
  results.push(evaluateScalarField("pixel-id", pixelId, expected.pixelId));

  const eventName = extractQuotedValueAfterKey(gtmJsText, "vtp_standardEventName");
  results.push(evaluateScalarField("event-name", eventName, expected.eventName));

  const value = extractObjectPropertyListValue(gtmJsText, "value");
  results.push(evaluateScalarField("value", value, expected.value));

  const currency = extractObjectPropertyListValue(gtmJsText, "currency");
  results.push(evaluateScalarField("currency", currency, expected.currency));

  const eventIdFieldFound = gtmJsText.includes("vtp_eventId");
  results.push({
    check: "event-id-field",
    status: eventIdFieldFound ? "match" : "not-found",
    message: eventIdFieldFound
      ? "campo vtp_eventId presente — template oficial expõe advanced matching/dedup"
      : "campo vtp_eventId NÃO encontrado — pode indicar que o container voltou a usar a tag Custom HTML (sem dedup pixel×CAPI, #8572) ou mudança de formato de compilação",
  });

  return results;
}

/** Compara `found` (valor real extraído do `gtm.js`, `null` quando o
 * marcador não foi localizado) contra `expected`. Usado tanto por
 * `value`/`currency` (via `extractObjectPropertyListValue`) quanto por
 * `pixel-id`/`event-name` (via `extractQuotedValueAfterKey` sobre
 * `vtp_pixelId`/`vtp_standardEventName`) — os 4 eixos escalares deste
 * módulo, todos capazes de produzir `"mismatch"` genuíno. @pure */
function evaluateScalarField(check: GtmCheckAxis, found: string | null, expected: string): GtmCheckResult {
  const label = check === "pixel-id" ? "pixel/dataset ID" : check === "event-name" ? "evento" : check;
  if (found === null) {
    return {
      check,
      status: "not-found",
      message: `${label} NÃO encontrado no gtm.js — pode ser mudança de container ou de formato de compilação`,
    };
  }
  if (found === expected) {
    return { check, status: "match", message: `${label}=${found} confere com o esperado (${expected})` };
  }
  return {
    check,
    status: "mismatch",
    message: `${label} no gtm.js é "${found}", esperado "${expected}" — divergência real entre o container publicado e o que este repo espera`,
  };
}

/** Drift ACIONÁVEL (abre issue) — só `"mismatch"`, nunca `"not-found"` (ver
 * docstring do módulo pro porquê). @pure */
export function hasGtmDrift(results: readonly GtmCheckResult[]): boolean {
  return results.some((r) => r.status === "mismatch");
}

/** Eixos que não puderam ser confirmados nesta execução — informativo,
 * nunca aciona alarme sozinho. @pure */
export function unresolvedGtmChecks(results: readonly GtmCheckResult[]): GtmCheckResult[] {
  return results.filter((r) => r.status === "not-found");
}

/** Fingerprint estável por achado — `${check}:${message}` (mesma fórmula
 * de `homeMetaFindingIssueKey`/`subscribeDriftFindingKey`) — casa com
 * `AlarmFinding.fingerprint` de `scripts/lib/alarm-issues.ts`. @pure */
export function gtmDriftFindingKey(result: GtmCheckResult): string {
  return `${result.check}:${result.message}`;
}

/** Fingerprint AGREGADO do conjunto de achados `"mismatch"` — usado só pra
 * decidir se o e-mail precisa ser reenviado (mesmo padrão de
 * `computeHomeMetaFingerprint`/`computeSubscribeDriftFingerprint`).
 * Determinístico independente da ordem de entrada (ordena antes de
 * concatenar). @pure */
export function computeGtmDriftFingerprint(results: readonly GtmCheckResult[]): string | null {
  const mismatches = results.filter((r) => r.status === "mismatch").map(gtmDriftFindingKey).sort();
  if (mismatches.length === 0) return null;
  return mismatches.join("|");
}

export interface GtmDriftAlarmState {
  lastAlarmedFingerprint: string | null;
  lastCheckedAt: string | null;
}

export function emptyGtmDriftAlarmState(): GtmDriftAlarmState {
  return { lastAlarmedFingerprint: null, lastCheckedAt: null };
}

export function advanceGtmDriftAlarmState(fingerprint: string | null, now: Date): GtmDriftAlarmState {
  return { lastAlarmedFingerprint: fingerprint, lastCheckedAt: now.toISOString() };
}

/** Monta assunto + corpo do e-mail de alarme — citando a issue de cada
 * achado pendente quando disponível (mesmo padrão de
 * `buildHomeMetaDriftAlarmEmail`/`buildSubscribeDriftAlarmEmail`). @pure */
export function buildGtmDriftAlarmEmail(
  results: readonly GtmCheckResult[],
  gtmUrl: string,
  issueRefs?: ReadonlyMap<string, { issueNumber: number | null; url: string | null }>,
): { subject: string; body: string } {
  const mismatches = results.filter((r) => r.status === "mismatch");
  const unresolved = unresolvedGtmChecks(results);
  const subject = `[diar.ia.br] drift no container GTM: ${mismatches.map((m) => m.check).join(", ")}`;
  const lines: string[] = [
    "Achado automático do smoke-test `Diaria-Gtm-Drift-Check`",
    "(`scripts/gtm-drift-check.ts`) — compara o container GTM publicado",
    "(GTM-TC8C65ZN) contra o que este repo espera pro evento",
    "CompleteRegistration do Meta Pixel.",
    "",
    `Fonte: ${gtmUrl}`,
    "",
    "Divergências encontradas:",
  ];
  for (const m of mismatches) {
    const ref = issueRefs?.get(gtmDriftFindingKey(m));
    const issueSuffix = ref?.issueNumber ? ` (issue #${ref.issueNumber})` : "";
    lines.push(`- [${m.check}] ${m.message}${issueSuffix}`);
  }
  if (unresolved.length > 0) {
    lines.push("", "Eixos não confirmados nesta execução (informativo, não é drift):");
    for (const u of unresolved) {
      lines.push(`- [${u.check}] ${u.message}`);
    }
  }
  lines.push(
    "",
    "Refs #8585 (task) / #8578 (achado original) / #8572 (onde a lacuna custou tempo de diagnóstico).",
    "A correção é conferir/ajustar a tag do Meta Pixel no painel do GTM",
    "(https://tagmanager.google.com) — este alarme só detecta, não publica",
    "nada no GTM.",
  );
  return { subject, body: lines.join("\n") };
}
