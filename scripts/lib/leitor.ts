/**
 * leitor.ts (#5235 Parte 1)
 *
 * Definição canônica de `leitor-v1` — a unidade da camada de dados de
 * aquisição (ver CLAUDE.md, "teto de CAC revogado... a unidade é LEITOR").
 *
 * ## A armadilha do `click_rate` — NUNCA usar
 *
 * `stats.click_rate` da API Beehiiv é `total_unique_clicked ÷
 * total_unique_opened` — CLICK-TO-OPEN, não CTR sobre entregas. Tem abertura
 * no denominador, que é exatamente a contaminação de MPP (Mail Privacy
 * Protection — pixel de abertura dispara sem o leitor ter aberto de fato)
 * que a definição de leitor quer escapar. Confirmado no dado bruto do
 * mídia kit (Apêndice A):
 *
 *   total_received 238 · total_unique_opened 217 · total_unique_clicked 171
 *   click_rate 78.8  →  171/217 = 78,8%   (e não 171/238 = 71,8%)
 *
 * Usar `click_rate` como CTR infla ~7× e reintroduz o viés de abertura que a
 * definição por CLIQUE (em vez de abertura) existe pra evitar. **Toda
 * função deste arquivo calcula CTR manualmente**: `total_unique_clicked ÷
 * total_received`. `BeehiivSubscriberStatsShape` abaixo nem expõe
 * `click_rate` no tipo que `leitorInputFromBeehiivSubscriber` aceita —
 * quem for chamar a função com o objeto bruto da API pode ter o campo no
 * runtime, mas a função nunca lê essa chave (ver
 * `test/leitor.test.ts` — teste explícito de não-uso).
 *
 * ## Por que abertura não serve como unidade
 *
 * Medido no snapshot de 260814: 242 assinantes ativos clicam mas têm
 * abertura abaixo de 40% — provavelmente bloqueiam imagem, então o pixel de
 * abertura não dispara e o clique sim. Definição por abertura erra nos dois
 * sentidos: infla por MPP (falso positivo) e descarta engajamento
 * comprovado por clique real (falso negativo).
 *
 * ## Os cortes (`LEITOR_V1_THRESHOLDS`)
 *
 * `leitor-v1` = `status === "active"` AND `totalReceived >= 20` AND
 * `(totalUniqueClicked / totalReceived) * 100 >= 2`.
 *
 * - **Piso de 20 recebidas** (não 5): mediana da base é 110 edições
 *   recebidas. Com piso baixo, quem recebeu 5 e clicou 1 vez marca 20% de
 *   CTR e entraria como leitor — o corte passaria a premiar quem chegou há
 *   pouco, não quem lê de fato.
 * - **Corte em 2% de CTR**: ~1,5× a mediana individual medida (1,35%),
 *   N=182 de 443 ativos com ≥20 recebidas. Testado contra coortes reais
 *   (Google Ads → 56 leitores, boost → 17, mesmo nº de ativos) — discrimina
 *   bem.
 *
 * Detalhe completo, tabela de distribuição do CTR e regra de versionamento
 * (`leitor-v2` nunca sobrescreve `v1` retroativamente): `docs/definicao-leitor.md`.
 *
 * ## CLI
 *
 *   npx tsx scripts/lib/leitor.ts [--ctr-min 2] [--received-min 20] [--snapshot YYYY-MM-DD]
 *
 * Lê o snapshot mais recente de `data/beehiiv-backup/` (ou o `--snapshot`
 * pedido) e imprime a contagem de leitores-v1 sob os limiares dados. Leitura
 * local apenas — nunca chama a API Beehiiv (guard de publicação do
 * overnight/develop).
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, getStringArg } from "./cli-args.ts";
import {
  latestSnapshotDate,
  readSnapshotSubscribers,
  type BeehiivBackupSubscriber,
} from "./beehiiv-backup-snapshots.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_BACKUP_ROOT = resolve(ROOT, "data/beehiiv-backup");

// ---------------------------------------------------------------------------
// Predicado puro
// ---------------------------------------------------------------------------

export interface LeitorThresholds {
  /** CTR mínimo em pontos percentuais (2 = 2%). */
  ctrMinPct: number;
  /** Mínimo de edições recebidas pra elegibilidade. */
  receivedMin: number;
}

export const LEITOR_V1_THRESHOLDS: LeitorThresholds = {
  ctrMinPct: 2,
  receivedMin: 20,
};

/** Input mínimo e explícito — deliberadamente NÃO inclui `click_rate`. */
export interface LeitorInput {
  status: string;
  totalReceived: number;
  totalUniqueClicked: number;
}

/** CTR real = cliques únicos ÷ recebidas. NUNCA `click_rate` (ver docstring
 *  do módulo). `totalReceived <= 0` retorna 0 em vez de `NaN`/`Infinity` —
 *  contato sem envio não tem CTR definido, e "não leitor" é a resposta
 *  segura (não passa no piso `receivedMin` de qualquer forma, mas mantém
 *  esta função utilizável isoladamente sem produzir `NaN`). */
export function computeCtrPct(totalUniqueClicked: number, totalReceived: number): number {
  if (!Number.isFinite(totalReceived) || totalReceived <= 0) return 0;
  if (!Number.isFinite(totalUniqueClicked) || totalUniqueClicked < 0) return 0;
  return (totalUniqueClicked / totalReceived) * 100;
}

/** Predicado puro leitor-v1. `thresholds` como parâmetro (não hardcoded) —
 *  permite reavaliar corte sem editar a função (e sem que `leitor-v2` mude o
 *  comportamento de quem já chama com o default). */
export function isLeitorV1(
  input: LeitorInput,
  thresholds: LeitorThresholds = LEITOR_V1_THRESHOLDS,
): boolean {
  if (input.status !== "active") return false;
  if (input.totalReceived < thresholds.receivedMin) return false;
  return computeCtrPct(input.totalUniqueClicked, input.totalReceived) >= thresholds.ctrMinPct;
}

// ---------------------------------------------------------------------------
// Extração do dado bruto da Beehiiv — narrow de propósito
// ---------------------------------------------------------------------------

/** Subconjunto do subscriber bruto necessário pra `LeitorInput`. Aceita o
 *  objeto real da API/backup (que TEM `stats.click_rate` em runtime) mas o
 *  tipo desta interface não declara esse campo — reforça no nível de tipo
 *  que a extração abaixo não deveria tocá-lo (o teste de não-uso em
 *  `test/leitor.test.ts` é quem trava isso de fato, já que TS não impede
 *  acesso a uma chave presente no objeto real mas ausente do tipo estreito
 *  quando o objeto é `any`/`as`-cast). */
export interface BeehiivSubscriberStatsShape {
  status: string;
  stats?: {
    total_received?: number;
    total_unique_clicked?: number;
  } | null;
}

export function leitorInputFromBeehiivSubscriber(sub: BeehiivSubscriberStatsShape): LeitorInput {
  return {
    status: sub.status,
    totalReceived: sub.stats?.total_received ?? 0,
    totalUniqueClicked: sub.stats?.total_unique_clicked ?? 0,
  };
}

// ---------------------------------------------------------------------------
// CLI — resumo sobre um snapshot local
// ---------------------------------------------------------------------------

export interface LeitorCliArgs {
  thresholds: LeitorThresholds;
  snapshotDate: string | null;
  backupRoot: string;
}

function parsePositiveNumber(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`--${flag} deve ser um número ≥ 0, recebido "${raw}".`);
  }
  return n;
}

export function parseLeitorArgs(argv: string[]): LeitorCliArgs {
  return {
    thresholds: {
      ctrMinPct: parsePositiveNumber(getStringArg(argv, "ctr-min"), LEITOR_V1_THRESHOLDS.ctrMinPct, "ctr-min"),
      receivedMin: parsePositiveNumber(
        getStringArg(argv, "received-min"),
        LEITOR_V1_THRESHOLDS.receivedMin,
        "received-min",
      ),
    },
    snapshotDate: getStringArg(argv, "snapshot") ?? null,
    backupRoot: getStringArg(argv, "root") ?? DEFAULT_BACKUP_ROOT,
  };
}

export interface LeitorSummary {
  snapshot_date: string;
  thresholds: LeitorThresholds;
  total_subscribers: number;
  total_active: number;
  leitores_v1: number;
}

/** Pure sobre a lista já carregada — testável sem tocar disco. */
export function summarizeLeitores(
  subscribers: BeehiivBackupSubscriber[],
  thresholds: LeitorThresholds,
  snapshotDate: string,
): LeitorSummary {
  let totalActive = 0;
  let leitores = 0;
  for (const sub of subscribers) {
    if (sub.status === "active") totalActive++;
    if (isLeitorV1(leitorInputFromBeehiivSubscriber(sub), thresholds)) leitores++;
  }
  return {
    snapshot_date: snapshotDate,
    thresholds,
    total_subscribers: subscribers.length,
    total_active: totalActive,
    leitores_v1: leitores,
  };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseLeitorArgs(argv);
  const date = args.snapshotDate ?? latestSnapshotDate(args.backupRoot);
  if (!date) {
    console.error(`[leitor] nenhum snapshot encontrado em ${args.backupRoot}`);
    process.exitCode = 1;
    return;
  }
  const subscribers = readSnapshotSubscribers(args.backupRoot, date);
  if (subscribers.length === 0) {
    console.error(`[leitor] snapshot ${date} não tem subscribers.jsonl legível em ${args.backupRoot}`);
    process.exitCode = 1;
    return;
  }
  const summary = summarizeLeitores(subscribers, args.thresholds, date);
  console.log(JSON.stringify(summary, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}
