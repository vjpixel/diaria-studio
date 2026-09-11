/**
 * utm-canonical.ts (#7998)
 *
 * `subscription.utm_source` no store de assinantes
 * (`data/diaria-subscribers/diaria-subscribers.db`,
 * `scripts/lib/diaria-subscribers-db.ts`) tem 46 valores distintos que
 * misturam pelo menos quatro coisas diferentes: canal canônico (`meta-ads`,
 * `google-ads`, `clarice`, `diaria-apex`), o literal `direct` gravado como
 * se fosse fonte, hostname de referrer vazando pra `utm_source` (herança da
 * importação Beehiiv: `android.googlequicksearchbox`, domínios
 * `*.beehiiv.com`, `sparkloop-upscribe`) e vazio de verdade. O mesmo canal
 * também aparece partido em várias chaves (`linkedin`/`linkedin.com`/
 * `linkedin.android`/`linkedin-pessoal`).
 *
 * Este módulo é a normalização PURA: mapeia um `utm_source` cru pra uma
 * classe explícita + (quando aplicável) o canal canônico ou o host vazado.
 * Não escreve nada — não recalcula nem reescreve o store; quem consome
 * decide o que fazer com o resultado (ex: um relatório que agrupa por
 * `canal`, ou uma futura coluna derivada).
 *
 * Precedente direto: `scripts/lib/shared/channel-key-specs.ts` (usado pelo
 * CAC, que parte de `spend.csv`) já resolve o mesmo tipo de ambiguidade —
 * `google.com` é tratado como `ambigua: true` lá porque também é usado por
 * busca orgânica, então só conta como pago dentro de uma janela declarada.
 * Aqui reusamos o MESMO raciocínio (não o código: o CAC decide "isto é
 * gasto pago?", este módulo decide "que classe é este valor cru?") — `google.com`
 * nunca vira canal aqui, sempre `"ambiguo"`.
 *
 * **Fronteira `lib/shared/` (#2747):** zero I/O, zero dependência de
 * `lib/diaria/`/`lib/mensal/`. @pure em todo o módulo.
 */

/**
 * Classe explícita de um `utm_source` cru:
 * - `"canal"` — canal canônico reconhecido (`canal` populado).
 * - `"direct"` — literal `"direct"` gravado pela plataforma de origem.
 * - `"vazio"` — null/undefined/string vazia (nenhum parâmetro chegou).
 * - `"referrer"` — hostname (ou identificador de app) de referrer vazando
 *   pra `utm_source` — não é um canal que o projeto emite (`host` populado).
 * - `"ambiguo"` — valor que É um hostname de canal pago conhecido mas
 *   TAMBÉM é usado por tráfego orgânico (hoje só `google.com`, mesmo
 *   raciocínio de `channel-key-specs.ts`) — não pode ser contado como canal
 *   nem descartado como referrer puro sem uma janela/contexto adicional.
 * - `"desconhecido"` — não bate em nenhuma das classes acima (nem canal
 *   conhecido, nem `direct`/vazio, nem formato de hostname). Fallback
 *   seguro: nunca força um valor novo/inesperado pra dentro de `"referrer"`
 *   ou `"canal"` só para não deixar a classe vazia.
 */
export type UtmSourceClass = "canal" | "direct" | "vazio" | "referrer" | "ambiguo" | "desconhecido";

export interface UtmCanonicalResult {
  /** Valor cru original, sem normalização (preservado pra auditoria/log). */
  raw: string | null;
  classe: UtmSourceClass;
  /** Canal canônico — populado só quando `classe === "canal"`. */
  canal: string | null;
  /** Hostname/identificador vazado — populado quando `classe` é `"referrer"` ou `"ambiguo"`. */
  host: string | null;
}

/**
 * Alias exato (após lowercase+trim) → canal canônico. Fecha os grupos hoje
 * partidos em várias chaves (achado da #7998): 6 variantes de LinkedIn, 3 de
 * Instagram, 2 de Clarice colapsam num único canal cada.
 *
 * Nomes de canal usam o MESMO vocabulário que o resto do projeto já emite
 * (`clarice`, `diaria-apex` — ver `scripts/lib/shared/utm-registry.ts` — e
 * `meta-ads`/`google-ads`/`microsoft-ads`, convenção do teste 2608 em
 * `channel-key-specs.ts`), exceto onde o projeto não tem uma convenção
 * própria ainda (`linkedin`, `instagram`) — aí o alias resolve para a forma
 * mais curta/comum entre as variantes observadas.
 */
const CANONICAL_CHANNEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "meta-ads": "meta-ads",
  "google-ads": "google-ads",
  "microsoft-ads": "microsoft-ads",
  "clarice": "clarice",
  "clarice-email": "clarice",
  "diaria-apex": "diaria-apex",
  "linkedin": "linkedin",
  "linkedin.com": "linkedin",
  "linkedin.android": "linkedin",
  "linkedin-pessoal": "linkedin",
  "l.linkedin.com": "linkedin",
  "www.linkedin.com": "linkedin",
  "instagram-diaria": "instagram",
  "instagram.com": "instagram",
  "instagram-pessoal": "instagram",
});

/**
 * Valores ambíguos — hostname de canal pago que TAMBÉM é usado por tráfego
 * orgânico. Mesma lista/raciocínio de `channel-key-specs.ts` (lá, sub-canal
 * "Search" do Google Ads, `ambigua: true`). Aqui a resposta nunca vira
 * `"canal"` nem `"referrer"` puro — é a classe própria `"ambiguo"`, que
 * força quem consome a decidir (com janela, com contexto adicional) antes
 * de contar como canal pago.
 */
const AMBIGUOUS_HOSTS: ReadonlySet<string> = new Set(["google.com"]);

/**
 * Valores que SÃO referrer vazado mas não têm formato de hostname (sem
 * ponto) — precisam de allowlist explícita em vez do heurístico de formato
 * abaixo. `sparkloop-upscribe` é o caso citado na #7998 (herança da
 * importação Beehiiv, recommendation network — não é canal que o projeto
 * emite).
 */
const KNOWN_NON_HOST_REFERRERS: ReadonlySet<string> = new Set(["sparkloop-upscribe"]);

/**
 * Heurística de "parece hostname": 2+ rótulos separados por ponto, último
 * rótulo só-letras com 2+ caracteres (TLD-like). Cobre `android.
 * googlequicksearchbox` (app Android com nome em formato de domínio
 * reverso), `www.alquimiaoperativa.news`, qualquer subdomínio
 * `*.beehiiv.com` — sem precisar cadastrar cada domínio de veículo/app
 * individualmente, que cresceria sem fim.
 *
 * @pure
 */
function looksLikeReferrerHost(value: string): boolean {
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(value);
}

/**
 * Classifica um `utm_source` cru. Nunca lança — qualquer valor cai em
 * alguma classe, inclusive `"desconhecido"` como rede de segurança.
 *
 * @pure
 */
export function canonicalizeUtmSource(rawInput: string | null | undefined): UtmCanonicalResult {
  const raw = rawInput ?? null;
  const normalized = (raw ?? "").trim().toLowerCase();

  if (normalized === "") {
    return { raw, classe: "vazio", canal: null, host: null };
  }

  if (normalized === "direct") {
    return { raw, classe: "direct", canal: null, host: null };
  }

  if (Object.prototype.hasOwnProperty.call(CANONICAL_CHANNEL_ALIASES, normalized)) {
    return { raw, classe: "canal", canal: CANONICAL_CHANNEL_ALIASES[normalized], host: null };
  }

  if (AMBIGUOUS_HOSTS.has(normalized)) {
    return { raw, classe: "ambiguo", canal: null, host: normalized };
  }

  if (KNOWN_NON_HOST_REFERRERS.has(normalized) || looksLikeReferrerHost(normalized)) {
    return { raw, classe: "referrer", canal: null, host: normalized };
  }

  return { raw, classe: "desconhecido", canal: null, host: null };
}

/**
 * Agrupa uma lista de `utm_source` crus por classe canônica — conveniência
 * para relatórios (ex: "quantos são `direct`? quantos `vazio`? quantos
 * `referrer` distintos?"). Não decide nada sobre a #4469 (regra `direct ≥
 * 25%`) — só entrega os buckets já separados pra quem for computar essa
 * regra decidir explicitamente se `direct` e `vazio` somam ou não.
 *
 * @pure
 */
export function summarizeUtmCanonical(rawValues: ReadonlyArray<string | null | undefined>): Record<UtmSourceClass, UtmCanonicalResult[]> {
  const buckets: Record<UtmSourceClass, UtmCanonicalResult[]> = {
    canal: [],
    direct: [],
    vazio: [],
    referrer: [],
    ambiguo: [],
    desconhecido: [],
  };
  for (const raw of rawValues) {
    const result = canonicalizeUtmSource(raw);
    buckets[result.classe].push(result);
  }
  return buckets;
}
