/**
 * monthly-paths.ts (#1962)
 *
 * Resolução de caminhos do digest mensal, namespaceada por **ciclo**
 * no formato `{conteúdo}-{envio}` (ex: `2605-06` = digest de maio
 * enviado em junho). Análogo ao `clarice-paths.ts` do #1961 para o
 * lado de contatos.
 *
 * Por que `{conteúdo}-{envio}`: o digest mensal é batizado pelo mês
 * do CONTEÚDO ("Diar.ia Mensal 2605"), mas o envio ocorre no mês
 * SEGUINTE. Carregar os dois no nome da pasta elimina a ambiguidade
 * que antes confundia na virada do mês ("esse 2605/ é de maio ou junho?").
 *
 * Estrutura nova:
 *   data/monthly/
 *     {conteúdo}-{envio}/   (ex: 2605-06/)
 *       raw-posts/
 *       prioritized.md
 *       draft.md
 *       _internal/
 *       ...
 *
 * Compat: se a pasta nova `{conteúdo}-{envio}/` não existe mas a pasta
 * legada `{YYMM}/` existe, `monthlyDir()` usa a legada com um `console.warn`
 * (transição suave; escrita sempre usa o formato novo).
 *
 * Worker KV key: `m{YYMM}-{MM}` (ex: `m2605-06`). Retrocompat de leitura:
 * tentar key nova, fallback `m{YYMM}` — lógica implementada **no Worker** (#2046,
 * `workers/draft/src/index.ts` `legacyKeyFromNew`). Callers NÃO precisam fazer
 * fallback — o Worker KV aceita qualquer string ≤512 bytes, hífens são válidos.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, parseArgs } from "../cli-args.ts";
import {
  isValidCycle,
  clariceCycleDir,
  cycleHasClariceActivity,
  listClariceCycleDirs,
} from "../clarice-paths.ts";

// scripts/lib/mensal/ → raiz do repo são 3 níveis acima (mensal → lib → scripts).
// (#2747 desceu este arquivo de scripts/lib/ pra scripts/lib/mensal/ e o `../..`
// original — correto na origem — passou a apontar pra scripts/; corrigido aqui.)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Raiz dos digests mensais (`data/monthly/`). */
export const MONTHLY_BASE = resolve(REPO_ROOT, "data/monthly");

// ── Validação do ciclo ─────────────────────────────────────────────────────

/**
 * Pure: valida o rótulo de ciclo `{conteúdo}-{envio}` = `YYMM-MM`
 * (ex: `2605-06`).
 *
 * #2048 item 8: alias direto de `isValidCycle` de `clarice-paths.ts` (#1961) —
 * as duas funções tinham implementação idêntica. Ao importar do mesmo helper,
 * a semântica é garantidamente consistente se a regra do ciclo mudar.
 */
export const isValidMonthlyCycle = isValidCycle;

/**
 * Pure: valida o formato legado `YYMM` (ex: `2605`).
 * Útil para a compat path e para scripts que ainda recebem o argumento
 * posicional antigo.
 */
export function isValidYymm(s: string | undefined | null): s is string {
  if (!s || !/^\d{4}$/.test(s)) return false;
  const month = Number(s.slice(2, 4));
  return month >= 1 && month <= 12;
}

/**
 * Deriva o ciclo `{YYMM}-{MM+1}` a partir do formato legado `YYMM`.
 * Ex: `"2605"` → `"2605-06"`, `"2612"` → `"2612-01"`.
 *
 * Nome correto: `yymmToCycle` (dois y). O nome antigo `yyymmToCycle` (três y, typo)
 * foi removido em #2048 item 1 — todos os callers e testes foram atualizados.
 */
export function yymmToCycle(yymm: string): string {
  const contentMonth = Number(yymm.slice(2, 4));
  const sendMonth = (contentMonth % 12) + 1;
  return `${yymm}-${String(sendMonth).padStart(2, "0")}`;
}


/**
 * Extrai o `YYMM` (mês do conteúdo) a partir do rótulo de ciclo.
 * Ex: `"2605-06"` → `"2605"`.
 */
export function cycleToYymm(cycle: string): string {
  return cycle.slice(0, 4);
}

// ── Resolução de diretório ─────────────────────────────────────────────────

/**
 * Retorna o path do diretório do digest mensalpara um dado identificador.
 *
 * Aceita:
 *   - ciclo `{conteúdo}-{envio}` (ex: `2605-06`) — formato NOVO (preferido)
 *   - legado `YYMM` (ex: `2605`) — deriva o ciclo `{YYMM}-{MM+1}` com warning
 *
 * **Fallback de leitura:** se o diretório no formato novo não existe mas o
 * legado `{YYMM}` existe, usa o legado com `console.warn` (transição suave).
 * Escrita sempre usa o formato novo — callers que criam o diretório devem
 * chamar `ensureMonthlyDir` que já escreve no novo formato.
 *
 * @param identifier ciclo `2605-06` ou legado `2605`
 * @param opts.allowLegacyFallback default true — usa pasta legada se nova ausente
 */
export function monthlyDir(
  identifier: string,
  opts: { allowLegacyFallback?: boolean } = {},
): string {
  const allowFallback = opts.allowLegacyFallback !== false;

  // Normaliza para ciclo
  let cycle: string;
  if (isValidMonthlyCycle(identifier)) {
    cycle = identifier;
  } else if (isValidYymm(identifier)) {
    cycle = yymmToCycle(identifier);
    console.warn(
      `[monthly-paths] warn: "${identifier}" é formato legado YYMM — ` +
      `derive automaticamente como ciclo "${cycle}". ` +
      `Use --cycle ${cycle} para suprimir este aviso.`,
    );
  } else {
    throw new Error(
      `identificador de ciclo mensal inválido: "${identifier}" ` +
      `(esperado {conteúdo}-{envio} ex: 2605-06, ou legado YYMM ex: 2605)`,
    );
  }

  const newDir = resolve(MONTHLY_BASE, cycle);

  // Fallback de leitura para pasta legada
  if (allowFallback && !existsSync(newDir)) {
    const yymm = cycleToYymm(cycle);
    const legacyDir = resolve(MONTHLY_BASE, yymm);
    if (existsSync(legacyDir)) {
      console.warn(
        `[monthly-paths] warn: pasta "${cycle}" ausente, usando legada "${yymm}". ` +
        `Rode scripts/migrate-monthly-cycle-dirs.ts para migrar.`,
      );
      return legacyDir;
    }
  }

  return newDir;
}

/**
 * Cria o diretório do ciclo (formato novo, recursivo) e devolve o path.
 * Sempre escreve no formato novo — sem fallback legado.
 */
export function ensureMonthlyDir(cycle: string): string {
  if (!isValidMonthlyCycle(cycle)) {
    throw new Error(
      `ciclo inválido: "${cycle}" (esperado {conteúdo}-{envio} ex: 2605-06)`,
    );
  }
  const dir = resolve(MONTHLY_BASE, cycle);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Key do Worker KV ───────────────────────────────────────────────────────

/**
 * Key do Worker KV para o preview/draft mensal no formato NOVO.
 * Ex: `"2605-06"` → `"m2605-06"`.
 *
 * Hífens são válidos em keys KV do Cloudflare (qualquer string ≤512 bytes).
 * Não colide com diárias (AAMMDD, sem prefixo m) nem com o formato legado
 * `m{YYMM}` (4 dígitos após o m vs `{YYMM}-{MM}` com hífen).
 */
export function monthlyWorkerKey(cycle: string): string {
  if (!isValidMonthlyCycle(cycle)) {
    throw new Error(`ciclo inválido para workerKey: "${cycle}"`);
  }
  return `m${cycle}`;
}

/**
 * Key legada do Worker KV (`m{YYMM}`). Usado para retrocompat de leitura:
 * o caller tenta a key nova primeiro, depois esta como fallback.
 */
export function monthlyWorkerKeyLegacy(yymm: string): string {
  return `m${yymm}`;
}

// ── Parsing de argumentos CLI ──────────────────────────────────────────────

/**
 * Pure (testável): parseia `--cycle {ciclo}` do argv.
 *
 * Aceita o ciclo no formato novo `{YYMM}-{MM}` (ex: `2605-06`) OU o formato
 * legado `YYMM` (ex: `2605`), derivando o ciclo com warning.
 *
 * Retorna `""` se ausente/inválido (caller valida e pode abortar).
 */
export function parseMonthlyCycleArg(argv: string[]): string {
  // Tentar --cycle primeiro (novo)
  const cycleVal = getArg(argv, "cycle");
  if (isValidMonthlyCycle(cycleVal)) return cycleVal;

  // Compat: --cycle com YYMM legado (ex: --cycle 2605 → 2605-06 + warn)
  if (isValidYymm(cycleVal)) {
    const derived = yymmToCycle(cycleVal);
    console.warn(
      `[monthly-paths] warn: --cycle "${cycleVal}" é YYMM legado — ` +
      `derivando ciclo "${derived}". Use --cycle ${derived} para suprimir.`,
    );
    return derived;
  }

  // Compat: argumento posicional YYMM (ex: collect-monthly.ts 2605)
  // Detectado por: nenhum --cycle, mas tem positional[0] com formato YYMM
  // Usa parseArgs para não capturar valores de outras flags (ex: --list-id 2605).
  const pos = parseArgs(argv).positional.find((a) => isValidYymm(a));
  if (pos) {
    const derived = yymmToCycle(pos);
    console.warn(
      `[monthly-paths] warn: argumento posicional "${pos}" é YYMM legado — ` +
      `derivando ciclo "${derived}". Use --cycle ${derived} para suprimir.`,
    );
    return derived;
  }

  return "";
}

/**
 * Extrai `--cycle {ciclo}` do argv. OBRIGATÓRIO: aborta (exit 1) se
 * ausente/inválido. Use no `main()` dos scripts mensais.
 */
export function requireMonthlyCycleArg(argv: string[]): string {
  const v = parseMonthlyCycleArg(argv);
  if (!v) {
    console.error(
      "--cycle {conteúdo}-{envio} é obrigatório (ex: --cycle 2605-06).\n" +
      "Compat: --cycle 2605 (YYMM legado) deriva automaticamente como 2605-06.",
    );
    process.exit(1);
  }
  return v;
}

// ── resolveLatestMonthlyCycle (#4347 Etapa 3a) ─────────────────────────────
//
// A skill `/diaria-clarice-novos` redistribui a edição mensal MAIS RECENTE
// pra quem chegou depois — precisa achar, sem input do editor, qual ciclo
// está pronto pra reenvio: HTML renderizado (com merge tag de descadastro),
// gabarito É IA? gravado, e assunto conhecido (D3: se o ciclo corrente não
// estiver pronto, cai no anterior — nunca aborta por causa disso).

/** Marker do gabarito É IA? — mesmo path que `checkEiaGuard` (clarice-schedule-sends.ts) usa. */
function eiaMarkerPath(cycle: string): string {
  return resolve(monthlyDir(cycle, { allowLegacyFallback: false }), "_internal", ".close-poll-clarice.json");
}

function previewHtmlPath(cycle: string): string {
  return resolve(monthlyDir(cycle, { allowLegacyFallback: false }), "_internal", "cloudflare-preview.html");
}

/**
 * `cloudflare-preview.html` existe, não está vazio, e contém o merge tag de
 * descadastro (`{{ unsubscribe }}`) — mesmo critério de "HTML pronto pra
 * envio" que `clarice-schedule-group.ts`/`clarice-schedule-sends.ts` exigem
 * antes de qualquer `--create`.
 */
export function hasReadyPreviewHtml(cycle: string): boolean {
  const p = previewHtmlPath(cycle);
  if (!existsSync(p)) return false;
  try {
    const html = readFileSync(p, "utf8");
    return html.trim().length > 0 && html.includes("{{ unsubscribe }}");
  } catch {
    return false;
  }
}

/** Gabarito É IA? gravado pro ciclo (mesmo marker de `checkEiaGuard`). */
export function hasEiaGabarito(cycle: string): boolean {
  return existsSync(eiaMarkerPath(cycle));
}

/**
 * Resolve o assunto vencedor A/B/C já usado nos envios canônicos do ciclo —
 * lê `{ciclo}/sends/cells/campaigns-summary.json` (escrito por
 * `clarice-schedule-sends.ts --create`, ver `CampaignEntry.subject`) e
 * devolve o assunto mais frequente entre as entradas (as campanhas de um
 * mesmo ciclo compartilham o mesmo assunto vencedor, salvo blocos-célula
 * A/B/C ainda não resolvidos). `undefined` se o arquivo não existir, estiver
 * vazio, ou nenhuma entrada tiver `subject`.
 */
export function resolveSubjectFromCampaignsSummary(cycle: string): string | undefined {
  try {
    const path = resolve(clariceCycleDir(cycle), "sends", "cells", "campaigns-summary.json");
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Array<{ subject?: string }>;
    if (!Array.isArray(parsed)) return undefined;
    const counts = new Map<string, number>();
    for (const c of parsed) {
      const s = (c.subject ?? "").trim();
      if (!s) continue;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    let best: string | undefined;
    let bestCount = 0;
    for (const [s, n] of counts) {
      if (n > bestCount) {
        best = s;
        bestCount = n;
      }
    }
    return best;
  } catch {
    return undefined;
  }
}

export interface MonthlyCycleReadiness {
  cycle: string;
  ready: boolean;
  hasPreview: boolean;
  hasEiaGabarito: boolean;
  subject: string | undefined;
  reasons: string[];
}

/** Dependências injetáveis (teste sem tocar disco real). Produção usa `resolveLatestMonthlyCycleDeps()`. */
export interface ResolveLatestMonthlyCycleDeps {
  /** Lista TODOS os ciclos candidatos (qualquer ordem — a função ordena desc). */
  listCandidateCycles: () => string[];
  hasPreviewWithUnsubscribe: (cycle: string) => boolean;
  hasEiaGabarito: (cycle: string) => boolean;
  resolveSubject: (cycle: string) => string | undefined;
}

export type ResolveLatestMonthlyCycleResult =
  | { cycle: string; subject: string; fallback: boolean; checked: MonthlyCycleReadiness[] }
  | { cycle: null; subject: null; fallback: false; checked: MonthlyCycleReadiness[] };

/**
 * Núcleo PURO (#4347 Etapa 3a) — testável sem disco real via `deps`
 * injetadas. Percorre os ciclos candidatos do MAIOR pro MENOR (string sort
 * desc — `{YYMM}-{MM}` ordena corretamente como string, mesmo padrão de
 * `cohortSendRank`) e devolve o PRIMEIRO que satisfizer as 3 condições
 * (preview pronto + gabarito É IA? + assunto conhecido). `subjectOverride`
 * (equivalente a `--subject` explícito na CLI) vence a resolução automática
 * via `campaigns-summary.json` quando informado.
 *
 * D3 (decisão do editor, #4347): se o ciclo mais recente não estiver pronto,
 * cai no ANTERIOR — nunca aborta por causa disso. `fallback: true` sinaliza
 * que o ciclo escolhido NÃO é o mais recente da lista (pro caller registrar
 * no relatório da rodada, "por quê" escolheu esse ciclo).
 */
export function resolveLatestMonthlyCycle(
  deps: ResolveLatestMonthlyCycleDeps,
  subjectOverride?: string,
): ResolveLatestMonthlyCycleResult {
  const cycles = [...new Set(deps.listCandidateCycles())]
    .filter((c) => isValidMonthlyCycle(c))
    .sort()
    .reverse(); // desc — mais recente primeiro

  const checked: MonthlyCycleReadiness[] = [];
  for (let i = 0; i < cycles.length; i++) {
    const cycle = cycles[i];
    const hasPreview = deps.hasPreviewWithUnsubscribe(cycle);
    const hasEia = deps.hasEiaGabarito(cycle);
    const subject = (subjectOverride && subjectOverride.trim()) || deps.resolveSubject(cycle);
    const reasons: string[] = [];
    if (!hasPreview) reasons.push("cloudflare-preview.html ausente/vazio/sem {{ unsubscribe }}");
    if (!hasEia) reasons.push("gabarito É IA? não gravado");
    if (!subject) reasons.push("assunto desconhecido (sem --subject nem campanha prévia em campaigns-summary.json)");
    const ready = hasPreview && hasEia && !!subject;
    checked.push({ cycle, ready, hasPreview, hasEiaGabarito: hasEia, subject, reasons });
    if (ready) {
      return { cycle, subject: subject as string, fallback: i > 0, checked };
    }
  }
  return { cycle: null, subject: null, fallback: false, checked };
}

/** Dependências de PRODUÇÃO (disco real) — lista `data/monthly/*` como candidatos. */
export function resolveLatestMonthlyCycleDeps(): ResolveLatestMonthlyCycleDeps {
  return {
    listCandidateCycles: () => {
      if (!existsSync(MONTHLY_BASE)) return [];
      return readdirSync(MONTHLY_BASE).filter((d) => {
        try {
          return statSync(resolve(MONTHLY_BASE, d)).isDirectory();
        } catch {
          return false;
        }
      });
    },
    hasPreviewWithUnsubscribe: hasReadyPreviewHtml,
    hasEiaGabarito: hasEiaGabarito,
    resolveSubject: resolveSubjectFromCampaignsSummary,
  };
}

/** Atalho de produção — `resolveLatestMonthlyCycle` com as deps reais do disco. */
export function resolveLatestMonthlyCycleFromDisk(subjectOverride?: string): ResolveLatestMonthlyCycleResult {
  return resolveLatestMonthlyCycle(resolveLatestMonthlyCycleDeps(), subjectOverride);
}

// ── Guard de atividade real do ciclo (#4621) ───────────────────────────────
//
// Achado ao vivo 260804: `resolveLatestMonthlyCycle` caiu (D3, fallback
// legítimo por design) do ciclo corrente `2607-08` pro ciclo `2605-06` — o
// digest de JUNHO, ~2 meses desatualizado — porque `2607-08` não tinha
// entrada em `campaigns-summary.json` (os envios reais daquele ciclo foram
// montados via `clarice-build-segment.ts --group`/`clarice-schedule-group.ts
// --group`, que nunca escrevem nesse arquivo, ver clarice-paths.ts). O
// fallback em si (D3) segue correto quando o ciclo mais recente genuinamente
// não está pronto — o problema é fallback **silencioso** demais pra trás
// quando existe evidência independente (atividade real em
// data/clarice-subscribers/) de que um ciclo mais recente já está em uso.
//
// Defesa em profundidade (#4621, combinação dos itens 2+3 do achado):
//   1. `mostRecentActiveClariceCycle` — sinal independente de "ciclo em uso",
//      via presença de arquivos em data/clarice-subscribers/{cycle}/.
//   2. `evaluateClariceActivityGuard` — compara o fallback escolhido contra
//      esse sinal: diverge (nota auditável sempre) e, se a distância for
//      MAIOR que 1 ciclo mensal, BLOQUEIA (exige --subject explícito) em vez
//      de aceitar silenciosamente.

/**
 * Distância em MESES entre dois ciclos, pelo mês de CONTEÚDO (`{YYMM}` — os
 * 4 primeiros dígitos do rótulo). Ex: `cycleMonthDistance("2605-06",
 * "2607-08")` → 2 (maio → julho). Pure. Assume-se ciclo válido (`isValidCycle`)
 * — caller é responsável por filtrar antes.
 */
export function cycleMonthDistance(cycleA: string, cycleB: string): number {
  const ordinal = (c: string): number => {
    const yymm = cycleToYymm(c);
    const yy = Number(yymm.slice(0, 2));
    const mm = Number(yymm.slice(2, 4));
    return yy * 12 + mm;
  };
  return Math.abs(ordinal(cycleA) - ordinal(cycleB));
}

/** Dependências injetáveis do sinal de atividade Clarice (teste sem tocar disco real). */
export interface ClariceActivityDeps {
  /** Lista TODOS os ciclos com pasta em data/clarice-subscribers/ (qualquer ordem). */
  listCyclesWithClariceDir: () => string[];
  /** Ciclo tem QUALQUER arquivo dentro da pasta (não só criada vazia). */
  cycleHasActivity: (cycle: string) => boolean;
}

/** Deps de PRODUÇÃO (disco real) do sinal de atividade Clarice. */
export function clariceActivityDepsFromDisk(): ClariceActivityDeps {
  return {
    listCyclesWithClariceDir: listClariceCycleDirs,
    cycleHasActivity: (c) => cycleHasClariceActivity(c),
  };
}

/**
 * Ciclo MAIS RECENTE (string sort desc — mesmo critério de
 * `resolveLatestMonthlyCycle`) com atividade real registrada em
 * `data/clarice-subscribers/`. `undefined` se nenhum ciclo tiver atividade.
 */
export function mostRecentActiveClariceCycle(deps: ClariceActivityDeps): string | undefined {
  const active = [...new Set(deps.listCyclesWithClariceDir())]
    .filter((c) => isValidMonthlyCycle(c) && deps.cycleHasActivity(c))
    .sort()
    .reverse();
  return active[0];
}

/** Resultado do guard — sempre computável, mesmo quando nada diverge/bloqueia. */
export interface ActivityGuardResult {
  /** Ciclo mais recente com atividade real (undefined = sem sinal, ou fallback=false — guard não avalia). */
  activeCycle: string | undefined;
  /** `activeCycle` definido e diferente do ciclo resolvido. */
  diverges: boolean;
  /** Distância em meses entre o ciclo resolvido e `activeCycle` (undefined se `activeCycle` indefinido). */
  distance: number | undefined;
  /** `diverges` + distância > 1 ciclo + sem `--subject` explícito — caller deve abortar. */
  blocked: boolean;
  /** Mensagem pronta pra log/alarme quando `diverges` — rastro auditável mesmo sem bloquear (#4621 item 3). */
  note: string | undefined;
}

/**
 * Guard de atividade real (#4621) — só avalia quando `fallback` é `true`
 * (é literalmente "o fallback escolhido" que está sendo auditado; se o
 * ciclo resolvido já é o mais recente candidato, não há nada de suspeito
 * pra checar aqui). Quando `fallback` diverge do ciclo mais recente com
 * atividade em `data/clarice-subscribers/` por MAIS de 1 ciclo mensal,
 * `blocked: true` — o caller deve abortar exigindo `--subject` explícito
 * em vez de aceitar o fallback silenciosamente (item 2). `hasExplicitSubject`
 * destrava o bloqueio (o editor já confirmou conscientemente), mas a `note`
 * de divergência é sempre computada quando `diverges`, pra deixar rastro
 * auditável mesmo nesse caso e no caso "diverge só 1 ciclo, fallback
 * legítimo" (item 3).
 */
export function evaluateClariceActivityGuard(
  resolvedCycle: string,
  fallback: boolean,
  hasExplicitSubject: boolean,
  activityDeps: ClariceActivityDeps,
): ActivityGuardResult {
  if (!fallback) {
    return { activeCycle: undefined, diverges: false, distance: undefined, blocked: false, note: undefined };
  }
  const activeCycle = mostRecentActiveClariceCycle(activityDeps);
  if (!activeCycle) {
    return { activeCycle: undefined, diverges: false, distance: undefined, blocked: false, note: undefined };
  }
  const distance = cycleMonthDistance(resolvedCycle, activeCycle);
  const diverges = activeCycle !== resolvedCycle;
  const blocked = diverges && distance > 1 && !hasExplicitSubject;
  const note = diverges
    ? `ciclo resolvido por fallback (${resolvedCycle}) diverge do ciclo mais recente com atividade real em ` +
      `data/clarice-subscribers/ (${activeCycle}); distância ${distance} ${distance === 1 ? "mês" : "meses"}`
    : undefined;
  return { activeCycle, diverges, distance, blocked, note };
}
