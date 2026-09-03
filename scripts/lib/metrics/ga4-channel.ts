/**
 * scripts/lib/metrics/ga4-channel.ts (#7184, fatia 12 do épico #7172)
 *
 * Classificação de sessões GA4 nas mesmas 5 classes de aquisição de F1
 * (`scripts/lib/metrics/acquisition-class.ts`) + allowlist de `hostName` —
 * o núcleo puro que F12 usa para calcular `sessoes-dia`,
 * `sessoes-por-classe-dia` e `conversao-visita-cadastro`.
 *
 * ## Por que uma tabela NOVA, não reuso de `classifyAcquisition`
 *
 * `classifyAcquisition` casa `utm_source`/`utm_medium` como o PROJETO os
 * escreve (`clarice`, `diaria-apex`, `google-ads`). O GA4 normaliza para o
 * SEU PRÓPRIO vocabulário de `sessionSource`/`sessionMedium`
 * (`google`/`cpc`, `facebook`/`paid_social`, `linkedin`/`referral`) — dois
 * espaços de nomes diferentes, casamento por igualdade de string sempre
 * falharia. `GA4_SOURCE_MEDIUM_CLASSE_TABLE` é a tabela de equivalência
 * explícita e versionada entre o vocabulário GA4 e as 5 classes de F1.
 *
 * ## Allowlist de `hostName`
 *
 * A propriedade GA4 516813959 cobre o Vigil.ia.br inteiro (Workers de
 * curadoria: `eia.`, `livros.`, `cursos.`, `arquivo.`, `especial.`,
 * `poll.diaria.workers.dev`, hosts de terceiro). O denominador de
 * `conversao-visita-cadastro` e `sessoes-dia` é só o que serve o cadastro da
 * diária: `diar.ia.br` + `diaria.beehiiv.com` (enquanto existir). Aplicada
 * NA LEITURA (`Ga4RunReportRequest`/`buildRunReportBody` não têm
 * `dimensionFilter`) — host fora da allowlist nunca é somado em silêncio,
 * sai como linha própria "host não classificado" (`unclassifiedHosts`).
 *
 * Módulo PURO — sem I/O, sem rede. @see scripts/ga4-sync.ts (coleta).
 */

import type { AcquisitionClass } from "./acquisition-class.ts";

// ---------------------------------------------------------------------------
// Allowlist de hostName
// ---------------------------------------------------------------------------

/**
 * Hosts que servem o formulário de cadastro da diária — só estes entram no
 * denominador de `conversao-visita-cadastro`/`sessoes-dia`. Versionada e
 * explícita (#7184): estender só quando um host novo passar a servir
 * cadastro de verdade, nunca por "parece relacionado".
 */
export const GA4_HOSTNAME_ALLOWLIST: readonly string[] = ["diar.ia.br", "diaria.beehiiv.com"];

// ---------------------------------------------------------------------------
// Tabela de equivalência sessionSource/sessionMedium → classe de F1
// ---------------------------------------------------------------------------

/**
 * Uma regra da tabela: casa por `medium` (aplica a qualquer `source`) e/ou
 * por `source` exato — normalizados (lowercase/trim, mesmo tratamento de
 * `normalizeKey`, mas este módulo não importa `attribution-keys.ts` para não
 * arrastar `dotenv` — ver docstring de `acquisition-class.ts`). Primeira
 * regra que casa vence, mesma disciplina de `classifyAcquisition`.
 */
interface Ga4ClasseRule {
  /** `sessionMedium` normalizado exigido, se declarado. */
  medium?: string;
  /** `sessionSource` normalizado exigido, se declarado. */
  source?: string;
  /** `sessionSource` deve começar com este prefixo, se declarado (ex: "linkedin"). */
  sourcePrefix?: string;
  classe: AcquisitionClass;
}

/**
 * Regras explícitas, primeira que casa vence. Calibrada contra o probe de
 * 14d citado na issue #7184: `clarice/email` → iniciativa,
 * `newsletter/email` e `sendinblue/email` → tráfego do canal próprio da
 * diária, não aquisição nova (`indeterminado`) — exceto `sendinblue`, que já
 * tem classe própria em F1 (`reativacao`, o mesmo `utm_source` que
 * `activateSubscription`/`promoteBeehiivSubscription` escrevem). `google/cpc`,
 * `bing/cpc`, `microsoft/cpc` e `facebook|instagram/paid_social` cobrem os 3
 * braços de `PREFLIGHT_UTM_ARMS`. `linkedin/*` é sempre `organico` (mesma
 * regra da armadilha 1 de `acquisition-class.ts` — nenhuma campanha paga
 * rodou ainda).
 */
export const GA4_SOURCE_MEDIUM_CLASSE_TABLE: readonly Ga4ClasseRule[] = [
  // pago — leilão (cpc) ou social pago.
  { medium: "cpc", classe: "pago" },
  { medium: "paid_social", classe: "pago" },
  { medium: "ppc", classe: "pago" },

  // reativacao — mesmo utm_source que F1 já trata como reativação.
  { source: "sendinblue", classe: "reativacao" },
  { source: "brevo-diaria", classe: "reativacao" },

  // iniciativa — canais editoriais próprios/parceiros nomeados.
  { source: "clarice", classe: "iniciativa" },
  { source: "sparkloop-upscribe", classe: "iniciativa" },
  { source: "sparkloop", classe: "iniciativa" },

  // indeterminado — tráfego do próprio canal de e-mail da diária (quem já é
  // assinante lendo online), nunca contado como aquisição nova.
  { source: "newsletter", medium: "email", classe: "indeterminado" },
  { source: "beehiiv", medium: "email", classe: "indeterminado" },

  // organico — LinkedIn sempre orgânico enquanto não houver gasto real
  // (mesma armadilha 1 de acquisition-class.ts).
  { sourcePrefix: "linkedin", classe: "organico" },
  { medium: "organic", classe: "organico" },
  { medium: "social", classe: "organico" },
  { medium: "referral", classe: "organico" },

  // indeterminado — direto/sem sinal de origem.
  { source: "(direct)", medium: "(none)", classe: "indeterminado" },
];

function normalize(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Classifica UMA linha de sessão GA4 (sessionSource/sessionMedium) numa das
 * 5 classes de F1. Nunca lança — combinação não mapeada cai em
 * `indeterminado` (mesmo default de `classifyAcquisition` para
 * direct/sem-sinal), nunca em `organico` por omissão.
 *
 * @pure
 */
export function classifyGa4Channel(row: { sessionSource?: string | null; sessionMedium?: string | null }): AcquisitionClass {
  const source = normalize(row.sessionSource);
  const medium = normalize(row.sessionMedium);
  for (const rule of GA4_SOURCE_MEDIUM_CLASSE_TABLE) {
    if (rule.source !== undefined && rule.source !== source) continue;
    if (rule.medium !== undefined && rule.medium !== medium) continue;
    if (rule.sourcePrefix !== undefined && !source.startsWith(rule.sourcePrefix)) continue;
    return rule.classe;
  }
  return "indeterminado";
}

// ---------------------------------------------------------------------------
// Allowlist de hostName — aplicada na leitura
// ---------------------------------------------------------------------------

/** Forma mínima de uma linha do relatório fino (`Ga4FlatRow` já achatado). */
export interface Ga4ChannelRow {
  date?: string;
  sessionSource?: string;
  sessionMedium?: string;
  sessionCampaignName?: string;
  hostName?: string;
  sessions?: string;
}

export interface Ga4HostFilterResult {
  /** Linhas cujo hostName está na allowlist — únicas elegíveis pro denominador. */
  included: Ga4ChannelRow[];
  /** Sessões por host FORA da allowlist — nunca somadas ao denominador,
   *  sempre visíveis como "host não classificado" (nunca descartadas em
   *  silêncio). Chave = hostName, valor = soma de `sessions`. */
  unclassifiedHosts: Record<string, number>;
}

/**
 * Separa linhas do relatório fino por `hostName` na allowlist. Linha sem
 * `hostName` (nunca deveria acontecer, dimensão sempre presente na resposta
 * GA4) é tratada como host vazio, portanto fora da allowlist.
 *
 * @pure
 */
export function filterByHostAllowlist(
  rows: readonly Ga4ChannelRow[],
  allowlist: readonly string[] = GA4_HOSTNAME_ALLOWLIST,
): Ga4HostFilterResult {
  const allowed = new Set(allowlist);
  const included: Ga4ChannelRow[] = [];
  const unclassifiedHosts: Record<string, number> = {};
  for (const row of rows) {
    const host = row.hostName ?? "";
    if (allowed.has(host)) {
      included.push(row);
      continue;
    }
    const sessions = Number(row.sessions ?? 0) || 0;
    unclassifiedHosts[host] = (unclassifiedHosts[host] ?? 0) + sessions;
  }
  return { included, unclassifiedHosts };
}

// ---------------------------------------------------------------------------
// Agregação por classe
// ---------------------------------------------------------------------------

/**
 * Soma `sessions` por classe (5 classes de F1) sobre linhas JÁ filtradas
 * pela allowlist (`filterByHostAllowlist().included`). Não filtra por dia —
 * o CHAMADOR decide a janela ao montar `rows`.
 *
 * @pure
 */
export function aggregateGa4SessionsByClasse(rows: readonly Ga4ChannelRow[]): Record<AcquisitionClass, number> {
  const porClasse: Record<AcquisitionClass, number> = {
    pago: 0,
    reativacao: 0,
    iniciativa: 0,
    organico: 0,
    indeterminado: 0,
  };
  for (const row of rows) {
    const classe = classifyGa4Channel(row);
    porClasse[classe] += Number(row.sessions ?? 0) || 0;
  }
  return porClasse;
}

// ---------------------------------------------------------------------------
// Reconciliação sessões × cadastros — sem-par nunca vira 0%/Infinity
// ---------------------------------------------------------------------------

export type ConversaoStatus = "ok" | "sem-par (só GA4)" | "sem-par (só cadastro)";

export interface ConversaoClasseRow {
  classe: AcquisitionClass;
  sessoes: number;
  cadastros: number;
  /** `null` sempre que `status !== "ok"` — nunca 0%, nunca Infinity. */
  conversao: number | null;
  status: ConversaoStatus;
}

/**
 * Cruza sessões por classe (GA4, denominador) com cadastros por classe
 * (F4/`cadastros-dia` decomposto por `classe`, numerador) — mesmo formato de
 * saída de `FactorRow`/`computeFactor` em `aquisicao-reconcile.ts`, que já
 * resolveu este cruzamento para painel×coorte (reusar o desenho, não
 * reinventar). Classe com sessão e SEM cadastro (ex: tráfego de
 * `tagassistant.google.com`, majoritário) → `"sem-par (só GA4)"`. Classe com
 * cadastro e SEM sessão → `"sem-par (só cadastro)"`. As duas SEM presença →
 * omitida (nada a reconciliar).
 *
 * @pure
 */
export function computeConversaoPorClasse(
  sessoesPorClasse: Record<AcquisitionClass, number>,
  cadastrosPorClasse: Record<AcquisitionClass, number>,
): ConversaoClasseRow[] {
  const classes = new Set<AcquisitionClass>([
    ...(Object.keys(sessoesPorClasse) as AcquisitionClass[]),
    ...(Object.keys(cadastrosPorClasse) as AcquisitionClass[]),
  ]);
  const rows: ConversaoClasseRow[] = [];
  for (const classe of classes) {
    const sessoes = sessoesPorClasse[classe] ?? 0;
    const cadastros = cadastrosPorClasse[classe] ?? 0;
    if (sessoes === 0 && cadastros === 0) continue;
    if (sessoes === 0) {
      rows.push({ classe, sessoes, cadastros, conversao: null, status: "sem-par (só cadastro)" });
      continue;
    }
    if (cadastros === 0) {
      rows.push({ classe, sessoes, cadastros, conversao: null, status: "sem-par (só GA4)" });
      continue;
    }
    rows.push({ classe, sessoes, cadastros, conversao: cadastros / sessoes, status: "ok" });
  }
  return rows;
}
