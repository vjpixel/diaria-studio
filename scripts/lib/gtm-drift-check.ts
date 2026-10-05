/**
 * scripts/lib/gtm-drift-check.ts (#8585)
 *
 * Lógica PURA (sem I/O) do drift-check do container GTM PUBLICADO
 * (`GTM-TC8C65ZN`) contra o que este repo espera que ele carregue pro
 * evento `CompleteRegistration` do Meta Pixel — e, desde #9612, contra o
 * escopo da tag Meta `PageView` (eixo `meta-pageview-scope`, ver a seção
 * dedicada mais abaixo).
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
  /**
   * #9612 — URLs públicas das páginas que carregam o pixel Meta INLINE
   * (`fbq('track','PageView')` no HTML) E o container GTM ao mesmo tempo
   * (hoje `diar.ia.br/evento/agente-ia/{a,b,c,d}/`, #9590). Nessas páginas
   * nenhuma tag Meta PageView do container pode disparar, senão o PageView
   * conta 2x. `undefined` → o eixo `meta-pageview-scope` não roda
   * (compatibilidade com quem só quer os eixos do CompleteRegistration);
   * lista VAZIA → o eixo roda e devolve `not-found` (o scanner do script
   * fino não achou página nenhuma, sinal de que algo mudou no repo).
   */
  inlinePixelPageUrls?: readonly string[];
}

export type GtmCheckStatus = "match" | "mismatch" | "not-found";

export type GtmCheckAxis =
  | "pixel-id"
  | "event-name"
  | "value"
  | "currency"
  | "event-id-field"
  | "meta-pageview-scope";

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

  if (expected.inlinePixelPageUrls !== undefined) {
    results.push(evaluateMetaPageViewScope(gtmJsText, expected.inlinePixelPageUrls));
  }

  return results;
}

// ─── #9612: escopo da tag Meta PageView do container ────────────────────────
//
// As páginas `diar.ia.br/evento/agente-ia/*` carregam o pixel Meta inline E o
// container GTM (#9590). Hoje a tag Meta PageView do container só dispara em
// `cursos|livros.diar.ia.br`, então o PageView sai uma vez só. Se alguém
// ampliar o gatilho dessa tag pra "All Pages" no painel do GTM, a página do
// evento passa a contar PageView 2x e nada no repo percebe. Este eixo simula,
// a partir do `resource.tags/predicates/rules` do `gtm.js` publicado, se
// alguma tag Meta PageView dispararia nessas URLs nos eventos de carregamento
// de página.
//
// Diferente dos outros eixos (regex sobre o texto), aqui é parse estrutural do
// objeto `resource` — a pergunta é sobre GATILHO, que só existe na relação
// regra → predicado → macro. Qualquer coisa que o simulador não entenda
// (macro que não é URL/evento, função de predicado desconhecida, `resource`
// que não parseia) vira valor DESCONHECIDO, e desconhecido nunca vira
// `mismatch`: no pior caso o eixo sai `not-found`, mesma disciplina do resto
// do módulo.

/** Eventos de carregamento de página que o GTM empurra sozinho em toda página
 * (Consent Init, Initialization, Page View/"All Pages", DOM Ready, Window
 * Loaded). Gatilho de evento custom (`signedUp`) não entra: a página do
 * evento não o empurra. */
export const GTM_PAGE_LOAD_EVENTS = ["gtm.init_consent", "gtm.init", "gtm.js", "gtm.dom", "gtm.load"] as const;

type Tri = true | false | null; // null = desconhecido

export interface GtmResource {
  macros: Record<string, unknown>[];
  tags: Record<string, unknown>[];
  predicates: Record<string, unknown>[];
  rules: unknown[][];
}

/**
 * Extrai e parseia o objeto `"resource": {...}` do `gtm.js` (o `var data =
 * {...}` do container é JSON válido). Casamento de chaves ciente de string,
 * pra não se perder em `{`/`}` dentro de regex de predicado. Devolve `null`
 * em qualquer falha — NUNCA lança. @pure
 */
export function extractGtmResource(gtmJsText: string): GtmResource | null {
  const keyIdx = gtmJsText.search(/"resource"\s*:\s*\{/);
  if (keyIdx < 0) return null;
  const start = gtmJsText.indexOf("{", keyIdx);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < gtmJsText.length; i++) {
    const ch = gtmJsText[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(gtmJsText.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  if (!Array.isArray(r.tags) || !Array.isArray(r.predicates) || !Array.isArray(r.rules)) return null;
  return {
    macros: Array.isArray(r.macros) ? (r.macros as Record<string, unknown>[]) : [],
    tags: r.tags as Record<string, unknown>[],
    predicates: r.predicates as Record<string, unknown>[],
    rules: r.rules as unknown[][],
  };
}

const INLINE_FBQ_PAGEVIEW_RE = /fbq\(\s*['"]track['"]\s*,\s*['"]PageView['"]/;

/** A tag manda PageView pra Meta? Template oficial/community (`vtp_standardEventName`
 * = "PageView") ou Custom HTML com `fbq('track','PageView')`. @pure */
export function isMetaPageViewTag(tag: Record<string, unknown>): boolean {
  if (tag.vtp_standardEventName === "PageView") return true;
  if (tag.function === "__html" && typeof tag.vtp_html === "string") return INLINE_FBQ_PAGEVIEW_RE.test(tag.vtp_html);
  return false;
}

/** Tag Meta de qualquer evento (pra distinguir "container sem tag Meta
 * nenhuma" — provável mudança de formato — de "tem tag Meta, nenhuma é
 * PageView"). @pure */
function isAnyMetaTag(tag: Record<string, unknown>): boolean {
  if (typeof tag.vtp_pixelId === "string") return true;
  return tag.function === "__html" && typeof tag.vtp_html === "string" && /fbq\(/.test(tag.vtp_html);
}

/** Resolve uma referência `["macro", N]` (ou literal) pro valor que ela teria
 * na URL/evento simulados. Só entende Event (`__e`) e as variáveis de URL
 * (`__u`, sem fonte custom); o resto é desconhecido (`null`). @pure */
function resolveGtmArg(arg: unknown, resource: GtmResource, url: URL, event: string): string | null {
  if (typeof arg === "string") return arg;
  if (typeof arg === "number" || typeof arg === "boolean") return String(arg);
  if (!Array.isArray(arg) || arg[0] !== "macro" || typeof arg[1] !== "number") return null;
  const macro = resource.macros[arg[1]];
  if (!macro || typeof macro !== "object") return null;
  if (macro.function === "__e") return event;
  if (macro.function !== "__u") return null;
  if (macro.vtp_customUrlSource !== undefined) return null;
  const component = typeof macro.vtp_component === "string" ? macro.vtp_component : "URL";
  switch (component) {
    case "URL":
      return url.href;
    case "HOST": {
      const host = url.hostname;
      return macro.vtp_stripWww === true ? host.replace(/^www\./, "") : host;
    }
    case "PATH":
      return url.pathname;
    case "PROTOCOL":
      return url.protocol.replace(/:$/, "");
    case "QUERY":
      return url.search.replace(/^\?/, "");
    case "FRAGMENT":
      return url.hash.replace(/^#/, "");
    default:
      return null;
  }
}

/** Avalia um predicado compilado (`_eq`, `_re`, `_cn`, `_sw`, `_ew`) —
 * `null` quando a função ou um argumento não é resolvível. Respeita
 * `ignore_case` e `negate`. @pure */
function evaluateGtmPredicate(pred: Record<string, unknown>, resource: GtmResource, url: URL, event: string): Tri {
  const a0 = resolveGtmArg(pred.arg0, resource, url, event);
  const a1 = resolveGtmArg(pred.arg1, resource, url, event);
  if (a0 === null || a1 === null) return null;
  const ic = pred.ignore_case === true;
  const l = ic ? a0.toLowerCase() : a0;
  const r = ic ? a1.toLowerCase() : a1;
  let out: boolean;
  switch (pred.function) {
    case "_eq":
      out = l === r;
      break;
    case "_cn":
      out = l.includes(r);
      break;
    case "_sw":
      out = l.startsWith(r);
      break;
    case "_ew":
      out = l.endsWith(r);
      break;
    case "_re":
      try {
        out = new RegExp(a1, ic ? "i" : "").test(a0);
      } catch {
        return null;
      }
      break;
    default:
      return null;
  }
  return pred.negate === true ? !out : out;
}

function triAnd(values: Tri[]): Tri {
  if (values.some((v) => v === false)) return false;
  return values.some((v) => v === null) ? null : true;
}

function triOr(values: Tri[]): Tri {
  if (values.some((v) => v === true)) return true;
  return values.some((v) => v === null) ? null : false;
}

/** Regra compilada: `[["if",p...],["unless",p...],["add",t...],["block",t...]]`.
 * Verdadeira quando todos os `if` batem e nenhum `unless` bate. @pure */
function evaluateGtmRule(rule: unknown[], resource: GtmResource, url: URL, event: string): Tri {
  const evalPreds = (idxs: unknown[]): Tri[] =>
    idxs.map((i) => {
      const pred = typeof i === "number" ? resource.predicates[i] : undefined;
      return pred && typeof pred === "object" ? evaluateGtmPredicate(pred, resource, url, event) : null;
    });
  const ifs: Tri[] = [];
  const unlesses: Tri[] = [];
  for (const clause of rule) {
    if (!Array.isArray(clause)) continue;
    if (clause[0] === "if") ifs.push(...evalPreds(clause.slice(1)));
    else if (clause[0] === "unless") unlesses.push(...evalPreds(clause.slice(1)));
  }
  const anyUnless = triOr(unlesses);
  const notBlocked: Tri = anyUnless === null ? null : !anyUnless;
  return triAnd([...ifs, notBlocked]);
}

function ruleTagIndices(rule: unknown[], kind: "add" | "block"): number[] {
  const out: number[] = [];
  for (const clause of rule) {
    if (Array.isArray(clause) && clause[0] === kind) {
      for (const i of clause.slice(1)) if (typeof i === "number") out.push(i);
    }
  }
  return out;
}

/** A tag de índice `tagIdx` dispara nessa URL/evento? `true` só quando uma
 * regra que a adiciona é verdadeira E nenhuma regra de bloqueio é
 * verdadeira ou desconhecida. @pure */
export function gtmTagFires(resource: GtmResource, tagIdx: number, url: URL, event: string): Tri {
  const adds: Tri[] = [];
  const blocks: Tri[] = [];
  for (const rule of resource.rules) {
    if (!Array.isArray(rule)) continue;
    if (ruleTagIndices(rule, "add").includes(tagIdx)) adds.push(evaluateGtmRule(rule, resource, url, event));
    if (ruleTagIndices(rule, "block").includes(tagIdx)) blocks.push(evaluateGtmRule(rule, resource, url, event));
  }
  const added = triOr(adds);
  const blocked = triOr(blocks);
  if (added === false || blocked === true) return false;
  if (added === true && blocked === false) return true;
  return null;
}

function describeTag(tag: Record<string, unknown>, idx: number): string {
  const id = typeof tag.tag_id === "number" ? `tag_id ${tag.tag_id}` : `índice ${idx}`;
  return `${String(tag.function)} (${id})`;
}

/**
 * Eixo `meta-pageview-scope` (#9612): nenhuma tag Meta PageView do container
 * pode disparar nas páginas que já têm o pixel inline. `mismatch` só quando
 * o disparo é CERTO (todos os predicados resolvidos); qualquer desconhecido
 * vira `not-found`. Mensagem determinística (ordenada) porque vira
 * fingerprint do alarme. @pure
 */
export function evaluateMetaPageViewScope(gtmJsText: string, pageUrls: readonly string[]): GtmCheckResult {
  const check: GtmCheckAxis = "meta-pageview-scope";
  if (pageUrls.length === 0) {
    return {
      check,
      status: "not-found",
      message: "nenhuma página com pixel Meta inline + GTM foi encontrada no repo — eixo PageView não pôde ser checado",
    };
  }
  const resource = extractGtmResource(gtmJsText);
  if (!resource) {
    return {
      check,
      status: "not-found",
      message: "objeto resource (tags/predicates/rules) não encontrado ou não parseável no gtm.js — eixo PageView não pôde ser checado",
    };
  }
  if (!resource.tags.some((t) => t && typeof t === "object" && isAnyMetaTag(t))) {
    return {
      check,
      status: "not-found",
      message: "nenhuma tag Meta encontrada no container — provável mudança de formato de compilação, eixo PageView não pôde ser checado",
    };
  }
  const urls: URL[] = [];
  for (const u of pageUrls) {
    try {
      urls.push(new URL(u));
    } catch {
      return { check, status: "not-found", message: `URL de página inválida na lista de pixel inline: ${u}` };
    }
  }

  const firing = new Set<string>();
  const unknown = new Set<string>();
  resource.tags.forEach((tag, idx) => {
    if (!tag || typeof tag !== "object" || !isMetaPageViewTag(tag)) return;
    for (const url of urls) {
      for (const event of GTM_PAGE_LOAD_EVENTS) {
        const fires = gtmTagFires(resource, idx, url, event);
        const key = `${describeTag(tag, idx)} em ${url.pathname} (${event})`;
        if (fires === true) firing.add(key);
        else if (fires === null) unknown.add(key);
      }
    }
  });

  if (firing.size > 0) {
    return {
      check,
      status: "mismatch",
      message:
        `tag Meta PageView do container dispara em página que já tem o pixel inline — PageView contado 2x: ` +
        [...firing].sort().join("; "),
    };
  }
  if (unknown.size > 0) {
    return {
      check,
      status: "not-found",
      message:
        `gatilho de tag Meta PageView não pôde ser resolvido (macro/predicado fora do que o simulador entende): ` +
        [...unknown].sort().join("; "),
    };
  }
  return {
    check,
    status: "match",
    message: `nenhuma tag Meta PageView do container dispara nas ${urls.length} página(s) com pixel inline`,
  };
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
    "CompleteRegistration do Meta Pixel e pro escopo da tag Meta PageView",
    "(que não pode disparar nas páginas com pixel inline, #9612).",
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
    "Refs #8585 (task) / #8578 (achado original) / #8572 (onde a lacuna custou tempo de diagnóstico) / #9612 (eixo meta-pageview-scope).",
    "A correção é conferir/ajustar a tag do Meta Pixel no painel do GTM",
    "(https://tagmanager.google.com) — este alarme só detecta, não publica",
    "nada no GTM.",
  );
  return { subject, body: lines.join("\n") };
}
