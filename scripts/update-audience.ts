/**
 * Regera `context/audience-profile.md` combinando duas fontes:
 *
 *   1. **CTR comportamental** (primário) — `data/link-ctr-table.csv`
 *      Gerado por `build-link-ctr.ts`. Mostra o que a audiência realmente clica.
 *
 *   2. **Survey declarativo** (secundário) — `data/audience-raw.json`
 *      Gerado via Beehiiv MCP (/diaria-atualiza-audiencia). Mostra quem são
 *      e o que dizem preferir.
 *
 * Subscriber count respeita `publishing.newsletter.subscriber_backend`
 * (#8145): backend "kit" lê `getKitActiveSummary` do store unificado local
 * (`data/diaria-subscribers/diaria-subscribers.db`, síncrono, sem chamada
 * de rede); backend "beehiiv" (default) continua lendo
 * `data/beehiiv-cache/publication.json` como sempre fez. O CTR comportamental
 * (Seção 1) segue vindo da Beehiiv independente do backend de contagem —
 * as duas perguntas ("quantos assinantes existem" vs "o que clicam") não
 * são colapsadas numa fonte só.
 *
 * Qualquer fonte pode estar ausente — o script gera o que conseguir.
 *
 * Uso:
 *   npx tsx scripts/update-audience.ts                    # usa fontes cached
 *   npx tsx scripts/update-audience.ts audience-raw.json  # força survey file
 *
 * Roda automaticamente no Stage 0 (após build-link-ctr.ts) e manualmente
 * via /diaria-atualiza-audiencia (quando há survey nova).
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import Papa from "papaparse";
import { editionsRoot } from "./lib/edition-paths.ts";
// isAprofundeAnchor foi movido pra lib/ctr-utils.ts pra quebrar ciclo ESM com
// analyze-h4.ts. Importado para uso interno + re-exportado para manter
// compatibilidade com testes e importadores externos.
import { isAprofundeAnchor, isNonEditorialHost } from "./lib/ctr-utils.ts";
import { isMainModule } from "./lib/cli-args.ts";
import {
  DEFAULT_DB_PATH,
  openDiariaSubscribersDbSafe,
  getKitActiveSummary,
} from "./lib/diaria-subscribers-db.ts";
import {
  resolveNewsletterSubscriberBackend,
  type NewsletterSubscriberBackend,
} from "./lib/shared/newsletter-subscriber-source.ts";
export { isAprofundeAnchor, isNonEditorialHost };
import {
  loadCtrRowsH4,
  loadHistoryEditions,
  computeNewH4Entries,
  appendHistory,
  loadHistory,
  computeH4Trend,
  formatH4Trend,
} from "./analyze-h4.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "context/audience-profile.md");
const HISTORY_DIR = resolve(ROOT, "docs/audience-history"); // #1846: movido de context/ (snapshots históricos não precisam de cache de prompt)
const CTR_CSV = resolve(ROOT, "data/link-ctr-table.csv");
const SURVEY_JSON = resolve(ROOT, "data/audience-raw.json");
const PUB_JSON = resolve(ROOT, "data/beehiiv-cache/publication.json");
const H4_HISTORY = resolve(ROOT, "data/scorer-ctr-history.jsonl");

// ─── Survey helpers ────────────────────────────────────────────────────────────

type BeehiivResponse = {
  id: string;
  status?: string;
  answers: { question_id: string; question_prompt: string; answer: string }[];
};

function countAnswers(responses: BeehiivResponse[], questionMatcher: RegExp) {
  const counts = new Map<string, number>();
  let total = 0;
  for (const r of responses) {
    for (const a of r.answers) {
      if (!questionMatcher.test(a.question_prompt)) continue;
      if (!a.answer) continue;
      counts.set(a.answer, (counts.get(a.answer) || 0) + 1);
      total += 1;
    }
  }
  return [...counts.entries()]
    .map(([label, n]) => ({ label, weight: total ? +(n / total).toFixed(3) : 0, count: n }))
    .sort((a, b) => b.weight - a.weight);
}

// ─── CTR helpers ───────────────────────────────────────────────────────────────

export interface CtrAgg {
  count: number;
  clicks: number;
  opens: number;
}

/**
 * Pure: exponential decay weight com time constant de DECAY_TIME_CONSTANT_DAYS.
 * `weight = exp(-days / T)` onde T=90 → weight cai pra 1/e (~0.37) em 90d;
 * half-life equivalente é ~62d (T × ln(2)). Rows mais recentes pesam mais.
 *
 * Combina audience drift (audiência cresceu 4× ao longo de 2025-2026) +
 * format drift (Aprofunde→Título em mar/2026).
 *
 * Validação empírica em #1564: T entre 45-180 dá rankings quase idênticos
 * → escolha 90 como sweet spot estável.
 */
export const DECAY_TIME_CONSTANT_DAYS = 90;
/** Alias deprecated — mantido para compat. Renomear pra DECAY_TIME_CONSTANT_DAYS. */
export const DECAY_HALF_LIFE_DAYS = DECAY_TIME_CONSTANT_DAYS;

export function decayWeight(rowDate: string, today: Date = new Date()): number {
  const d = new Date(rowDate);
  if (isNaN(d.getTime())) return 1; // fallback: peso 1 se data inválida
  const days = Math.max(0, (today.getTime() - d.getTime()) / 86400000);
  return Math.exp(-days / DECAY_TIME_CONSTANT_DAYS);
}

// ─── Encolhimento empírico-Bayes + bandas (#4840) ───────────────────────────
//
// Auditoria retrospectiva 260810 (#4840): um ranking de 17 categorias
// ordenadas por CTR bruto com 2 casas decimais implica precisão que os dados
// não sustentam — só 6/17 sobrevivem a Benjamini-Hochberg FDR 5%, o IC95 do
// POSTO cobre ~metade das 17 posições, e fora da amostra (151 edições) a
// tabela sem encolhimento não prevê melhor que a média global. O encolhimento
// (não o decay, já validado em #1564/#1619) é o que produz poder preditivo
// medido: Δdeviance −75,7 [−147,7; −15,1] fora da amostra (k≈850, ótimo
// achatado entre 700-1000).

/**
 * Constante de encolhimento (#4840), em unidade de "aberturas de prior" —
 * mesma unidade do denominador `opens`. Curva de deviance fora da amostra é
 * achatada entre k=700 e k=1000; 850 é o centro dessa faixa (medição da
 * auditoria retrospectiva 260810, ligada à issue de origem #4840).
 *
 * Risco documentado na própria issue: k foi varrido nas mesmas edições em que
 * o ganho foi medido (hiperparâmetro in-sample) — validação aninhada que
 * reverta o ganho fora da varredura invalidaria esta escolha. Reusado também
 * pra encolher CTR por domínio (seção "CTR por fonte"): a issue mediu k=200
 * como levemente melhor ali, mas k=850 também bate a taxa bruta por margem
 * ampla (−117,5 [−203; −49] de deviance) — optamos por 1 constante única em
 * vez de 2 hiperparâmetros afinados in-sample separadamente.
 */
export const CTR_SHRINKAGE_K = 850;

/** Limiar padrão (~95%) do teste-z aproximado usado por `classifyCtrBand`. */
export const CTR_BAND_Z_THRESHOLD = 1.96;

export interface ShrunkCtr {
  /** Taxa encolhida, em fração 0..1 (não em %). */
  rate: number;
  /** Erro padrão aproximado da estimativa encolhida (mesma unidade fracionária). */
  se: number;
  /** `opens` (aberturas, já com decay #1564 aplicado — mesma unidade que os aggregates de `parseCtrFromCsv`) da linha — nunca omitir ao publicar. */
  n: number;
}

/**
 * Pure: encolhimento empírico-Bayes (aproximação beta-binomial) de uma taxa
 * observada rumo à média global, puxando proporcionalmente a `k` "aberturas
 * de prior" — quanto menor `opens` em relação a `k`, mais a estimativa é
 * puxada pra `globalRate`. `opens=0` retorna a própria `globalRate` (sem
 * dado, sem informação pra desviar). `k=0` retorna a taxa observada crua
 * (degenera pro comportamento pré-#4840 — útil em teste).
 *
 * O erro padrão usa o denominador efetivo `opens + k` — aproximação padrão
 * de posterior beta-binomial suficiente pra decidir banda (não um IC
 * bayesiano exato nem um p-valor publicável).
 */
export function shrinkCtr(
  clicks: number,
  opens: number,
  globalRate: number,
  k: number = CTR_SHRINKAGE_K,
): ShrunkCtr {
  const effectiveN = opens + k;
  const rate = effectiveN > 0 ? (clicks + k * globalRate) / effectiveN : globalRate;
  const se = effectiveN > 0 ? Math.sqrt(Math.max(rate * (1 - rate), 0) / effectiveN) : 0;
  return { rate, se, n: opens };
}

export type CtrBand = "acima" | "sem_sinal" | "abaixo";

/**
 * Pure: classifica uma taxa encolhida em banda relativa à média global via
 * teste-z aproximado (`zThreshold` ≈ 1.96 → ~95%). Com `n` baixo, `opens+k`
 * fica dominado por `k`, o encolhimento puxa `rate` perto de `globalRate` E
 * `se` fica relativamente grande (denominador efetivo ainda pequeno frente à
 * variância) — as duas forças colaboram pra colapsar a banda em "sem_sinal"
 * quando o dado não sustenta afirmar direção. Com `n` alto, o encolhimento
 * quase não move `rate` (comportamento ~idêntico ao CTR bruto) e `se` fica
 * pequeno, então uma diferença real cruza o limiar normalmente.
 */
export function classifyCtrBand(
  shrunk: ShrunkCtr,
  globalRate: number,
  zThreshold: number = CTR_BAND_Z_THRESHOLD,
): CtrBand {
  if (shrunk.se <= 0) return "sem_sinal";
  const z = (shrunk.rate - globalRate) / shrunk.se;
  if (z > zThreshold) return "acima";
  if (z < -zThreshold) return "abaixo";
  return "sem_sinal";
}

/**
 * Pure: formata a linha `- **Categoria** — CTR X.X% (encolhida) | N links |
 * M aberturas` que `context/audience-profile.md` publica por categoria de
 * CTR (Seção 1) — extraído da montagem de `lines` em `main()` pra ser a
 * ÚNICA fonte da forma exata dessa linha (#8149: `buildAudienceSummary` em
 * `build-diaria-dashboard-data.ts` faz o parse dela via regex, e um teste
 * que gera a linha por AQUI, em vez de copiar o formato à mão num fixture,
 * não pode divergir do que o gerador real emite).
 */
export function formatCtrCategoryLine(cat: string, agg: CtrAgg, shrunk: ShrunkCtr): string {
  return `- **${cat}** — CTR ${(shrunk.rate * 100).toFixed(1)}% (encolhida) | ${agg.count} links | ${Math.round(agg.opens)} aberturas`;
}

export interface CtrParseResult {
  byCategory: Map<string, CtrAgg>;
  byCatOrigin: Map<string, CtrAgg>;
  byOrigin: Map<string, CtrAgg>;
  byDomain: Map<string, CtrAgg>;
  totalLinks: number;
  totalEditions: number;
  filteredAprofunde: number;
  filteredNonEditorial: number;
}

/**
 * Pure: agrega o CTR table (string CSV) por categoria/origem/domínio, aplicando
 * o filtro Aprofunde (#1564) e o exponential decay.
 *
 * Usa papaparse (header) e lê campos por NOME — NÃO faz split posicional. Isso
 * corrige o bug do #1567 audit (finding A): o anchor era lido em `parts[3]`
 * (front-anchored) num `split(",")` ingênuo, mas vírgulas em post_title/
 * section_title deslocam esse índice. Resultado: ~14% das rows Aprofunde (35 de
 * 255 no CTR table real) vazavam pro profile do scorer, reinflando o CTR de
 * categorias com o regime antigo que o filtro existe pra excluir. Ler `rec.anchor`
 * por nome elimina a fragilidade posicional (mesma técnica do build-link-ctr e
 * analyze-scorer-impact).
 */
export function parseCtrFromCsv(csv: string, today: Date = new Date()): CtrParseResult | null {
  const { data } = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  if (data.length === 0) return null;

  const byCategory = new Map<string, CtrAgg>();
  const byCatOrigin = new Map<string, CtrAgg>();
  const byOrigin = new Map<string, CtrAgg>();
  const byDomain = new Map<string, CtrAgg>();
  const dates = new Set<string>();
  let filteredAprofunde = 0;
  let filteredNonEditorial = 0;

  const num = (s: string | undefined): number => {
    const v = parseFloat(s ?? "");
    return Number.isFinite(v) ? v : 0;
  };

  for (const rec of data) {
    const anchor = (rec.anchor ?? "").trim();
    const domain = (rec.domain ?? "").trim();

    // #1564: skip Aprofunde rows (regime antigo de destaque)
    if (isAprofundeAnchor(anchor)) {
      filteredAprofunde++;
      continue;
    }

    // #4839: skip rows de hosts não-editoriais (rodapé social, crédito de
    // imagem do "É IA?", afiliado, links de casa, apoio) — nunca passam pelo
    // pipeline editorial, mas inflavam/desinflavam CTR de categorias por
    // ruído (18-22% do CSV na auditoria retrospectiva 260810).
    if (isNonEditorialHost(domain)) {
      filteredNonEditorial++;
      continue;
    }

    const date = (rec.date ?? "").trim();
    const origin = (rec.origin ?? "").trim();
    const category = (rec.category ?? "").trim();
    const uniqueOpens = num(rec.unique_opens);
    const uniqueVerifiedClicks = num(rec.unique_verified_clicks);

    if (date) dates.add(date);

    // #1564: exponential decay (90d time constant) — rows mais recentes pesam mais
    const w = decayWeight(date, today);

    const add = (map: Map<string, CtrAgg>, key: string) => {
      const existing = map.get(key) ?? { count: 0, clicks: 0, opens: 0 };
      existing.count++;
      existing.clicks += uniqueVerifiedClicks * w;
      existing.opens += uniqueOpens * w;
      map.set(key, existing);
    };

    add(byCategory, category);
    add(byCatOrigin, `${category}|${origin}`);
    add(byOrigin, origin);
    if (domain && domain.includes(".")) add(byDomain, domain);
  }

  return {
    byCategory,
    byCatOrigin,
    byOrigin,
    byDomain,
    totalLinks: data.length - filteredAprofunde - filteredNonEditorial,
    totalEditions: dates.size,
    filteredAprofunde,
    filteredNonEditorial,
  };
}

function parseCtr(ctrCsvPath: string = CTR_CSV): CtrParseResult | null {
  if (!existsSync(ctrCsvPath)) return null;
  return parseCtrFromCsv(readFileSync(ctrCsvPath, "utf8"));
}

// ─── Archive guard (#4366) ─────────────────────────────────────────────────────
//
// Detecta arquivar um snapshot idêntico ao mais recente já arquivado — sinal de
// que uma rodada anterior arquivou o profile antigo mas falhou/crashou ANTES de
// escrever conteúdo novo em `context/audience-profile.md` (a regeneração daquela
// rodada nunca aconteceu, silenciosamente). Não é um hard-fail: o script sempre
// prossegue (o próprio 07-30 do incidente real acabou tendo sucesso), só loga
// warning pra não passar despercebido de novo.

const HISTORY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

/** Nome do arquivo de histórico mais recente em `historyDir`, excluindo `excludeFilename` (tipicamente o de hoje). Ordena lexicograficamente — seguro porque o nome é sempre YYYY-MM-DD. */
export function findLatestHistoryFile(historyDir: string, excludeFilename?: string): string | null {
  if (!existsSync(historyDir)) return null;
  const files = readdirSync(historyDir)
    .filter((f) => HISTORY_FILE_RE.test(f) && f !== excludeFilename)
    .sort();
  return files.length > 0 ? files[files.length - 1] : null;
}

/** Pure: mensagem de warning se `currentContent` (prestes a ser arquivado como `todayFile`) for byte-a-byte idêntico ao conteúdo do arquivo de histórico mais recente já existente (`latestFile`/`latestContent`). Retorna `null` quando não há duplicata (ou não há histórico anterior pra comparar). */
export function detectDuplicateArchiveWarning(
  currentContent: string,
  todayFile: string,
  latestFile: string | null,
  latestContent: string | null,
): string | null {
  if (!latestFile || latestContent === null) return null;
  if (currentContent !== latestContent) return null;
  return `[update-audience] AVISO: snapshot a ser arquivado (${todayFile}) é idêntico ao mais recente já arquivado (${latestFile}) — possível regeneração que falhou silenciosamente numa rodada anterior (ver #4366). Investigar data/run-log.jsonl em torno dessas datas.`;
}

/**
 * Pure: monta os argv extras (sem o binário/script) pra `scripts/log-event.ts`
 * registrar o warning de archive duplicado no run-log estruturado — mesmo
 * padrão usado por `check-humanizer-social.ts`/`finalize-stage1.ts`
 * (child_process fire-and-forget). Persistir em `data/run-log.jsonl` (em vez
 * de só `console.warn`) torna o warning consultável depois via `/diaria-log`,
 * mesmo que ninguém tenha visto o stdout da sessão que rodou o Stage 0 na
 * hora (achado do self-review do #4366: um warning só em stdout corre o
 * mesmo risco de passar despercebido que motivou a issue).
 */
export function buildDuplicateArchiveLogArgs(todayFile: string, latestFile: string): string[] {
  return [
    "--stage", "0",
    "--agent", "update-audience",
    "--level", "warn",
    "--message",
    `snapshot arquivado (${todayFile}) é idêntico ao mais recente já arquivado (${latestFile}) — possível regeneração que falhou silenciosamente numa rodada anterior (#4366)`,
    "--details",
    JSON.stringify({ today_file: todayFile, latest_file: latestFile, issue: "#4366" }),
  ];
}

/**
 * Dispara `scripts/log-event.ts` via child_process (fire-and-forget, nunca
 * lança — logging não pode mascarar/bloquear a regeneração do profile).
 * `spawnFn` é injetável pra teste (captura a chamada sem spawnar processo real).
 */
export function logDuplicateArchiveWarning(
  todayFile: string,
  latestFile: string,
  spawnFn: typeof spawnSync = spawnSync,
): void {
  try {
    spawnFn(
      process.execPath,
      ["--import", "tsx", resolve(ROOT, "scripts/log-event.ts"), ...buildDuplicateArchiveLogArgs(todayFile, latestFile)],
      { cwd: ROOT, stdio: "ignore", encoding: "utf8" },
    );
  } catch {
    // fire-and-forget: falha de logging nunca pode mascarar/bloquear o script principal.
  }
}

/**
 * Decide e dispara o guard completo (console.warn + log-event) a partir da
 * comparação de conteúdo. Consolidado numa função só pra ser testável de
 * ponta a ponta: cenário de duplicata dispara os 2 canais, caminho feliz não
 * dispara nenhum. `spawnFn`/`warnFn` injetáveis pra teste.
 */
export function handleArchiveGuard(
  currentContent: string,
  todayFile: string,
  latestFile: string | null,
  latestContent: string | null,
  spawnFn: typeof spawnSync = spawnSync,
  warnFn: (message: string) => void = console.warn,
): void {
  const warning = detectDuplicateArchiveWarning(currentContent, todayFile, latestFile, latestContent);
  if (!warning) return;
  warnFn(warning);
  // latestFile é garantidamente não-null aqui (detectDuplicateArchiveWarning só
  // retorna warning quando latestFile existe).
  logDuplicateArchiveWarning(todayFile, latestFile as string, spawnFn);
}

// ─── Log de leitura mal-sucedida de cache (#8150) ───────────────────────────
//
// Mesmo canal duplo (console.warn + log-event, #4366) aplicado ao risco
// estrutural do #8150: os `catch { /* ignore */ }` em torno de PUB_JSON e
// SURVEY_JSON escondiam qualquer erro de leitura/parse (JSON malformado,
// arquivo truncado por escrita concorrente, mudança de schema) atrás de um
// valor default (`0`/`[]`) indistinguível de "arquivo ausente"/"vazio
// legítimo". `existsSync` já é checado antes de entrar no `try` — chegar
// aqui significa que o arquivo EXISTE mas não pôde ser lido/parseado.

/** Pure: monta os argv extras pra `scripts/log-event.ts` — mesmo formato de `buildDuplicateArchiveLogArgs` acima, aplicado ao erro de leitura de um cache específico. */
export function buildFileReadWarningLogArgs(sourceLabel: string, filePath: string, error: unknown): string[] {
  return [
    "--stage", "0",
    "--agent", "update-audience",
    "--level", "warn",
    "--message",
    `${sourceLabel} (${filePath}) existe mas não pôde ser lido/parseado — tratado como ausente (ver #8150)`,
    "--details",
    JSON.stringify({ file: filePath, error: error instanceof Error ? error.message : String(error), issue: "#8150" }),
  ];
}

/** Mesmo padrão fire-and-forget de `logDuplicateArchiveWarning` — logging nunca pode mascarar/bloquear a regeneração do profile. */
export function logFileReadWarning(
  sourceLabel: string,
  filePath: string,
  error: unknown,
  spawnFn: typeof spawnSync = spawnSync,
  warnFn: (message: string) => void = console.warn,
): void {
  warnFn(
    `[update-audience] AVISO: ${sourceLabel} (${filePath}) existe mas não pôde ser lido — ${error instanceof Error ? error.message : String(error)} (ver #8150)`,
  );
  try {
    spawnFn(
      process.execPath,
      ["--import", "tsx", resolve(ROOT, "scripts/log-event.ts"), ...buildFileReadWarningLogArgs(sourceLabel, filePath, error)],
      { cwd: ROOT, stdio: "ignore", encoding: "utf8" },
    );
  } catch {
    // fire-and-forget: falha de logging nunca pode mascarar/bloquear o script principal.
  }
}

// ─── Subscriber count por backend (#8145) ───────────────────────────────────

/**
 * Piso de plausibilidade (#8322) pra contagem "kit ativo" lida de
 * `getKitActiveSummary`. A base real está na casa das centenas há meses
 * (ver `docs/audience-history/`) — um `COUNT(*)` retornando algo entre 1 e
 * este piso-1 nunca foi uma leitura genuína da base, e sim sinal de uma
 * leitura em trânsito/parcial da fonte (achado #8322: `docs/audience-
 * history/2026-09-15.md` e `2026-09-16.md` gravaram `**subscribers
 * ativos:** 1`, um valor implausível frente aos vizinhos de ~890 — a causa
 * exata da leitura parcial não foi isolada, mas o valor em si nunca deveria
 * ter sido aceito como contagem real). Não é piso EDITORIAL (a base pode
 * legitimamente cair, um dia, abaixo disto) — é piso de SANIDADE: `0` já
 * tem tratamento dedicado ("ainda não ingerido", cai pro fallback Beehiiv
 * em silêncio, comportamento pré-existente e mantido); qualquer valor entre
 * 1 e este piso é tratado como NÃO RESOLVIDO, nunca aceito nem escondido.
 */
export const MIN_PLAUSIBLE_KIT_ACTIVE_COUNT = 10;

/** Pure: mensagem explicada de contagem "kit ativo" implausível (#8322) —
 *  usada tanto no `warnFn`/log-event quanto no texto gravado no snapshot. */
export function buildImplausibleKitCountWarning(rawCount: number, dbPath: string): string {
  return (
    `contagem Kit ativa implausível (${rawCount}, abaixo do piso de plausibilidade ` +
    `${MIN_PLAUSIBLE_KIT_ACTIVE_COUNT}) lida de ${dbPath} — tratando como NÃO RESOLVIDA ` +
    `em vez de aceitar como valor real (#8322).`
  );
}

/** Pure: monta os argv extras pra `scripts/log-event.ts` registrar o warning
 *  de contagem implausível (#8322) — mesmo padrão de `buildDuplicateArchiveLogArgs`. */
export function buildImplausibleKitCountLogArgs(rawCount: number, dbPath: string): string[] {
  return [
    "--stage", "0",
    "--agent", "update-audience",
    "--level", "warn",
    "--message",
    `contagem Kit ativa implausível (${rawCount}) lida de ${dbPath} — tratada como não resolvida, nunca aceita como valor real (#8322)`,
    "--details",
    JSON.stringify({ raw_count: rawCount, db_path: dbPath, floor: MIN_PLAUSIBLE_KIT_ACTIVE_COUNT, issue: "#8322" }),
  ];
}

/**
 * Dispara `warnFn` (console.warn por padrão) + `scripts/log-event.ts`
 * fire-and-forget (nunca lança) pro warning de contagem "kit ativo"
 * implausível — canal duplo dedicado (#8322), separado de
 * `logFileReadWarning` (#8150, que cobre falha de LEITURA, não valor lido
 * com sucesso porém implausível — reusar aquele produziria a mensagem
 * contraditória "existe mas não pôde ser lido" para um valor que FOI lido).
 */
export function logImplausibleKitCountWarning(
  rawCount: number,
  dbPath: string,
  spawnFn: typeof spawnSync = spawnSync,
  warnFn: (message: string) => void = console.warn,
): void {
  warnFn(`[update-audience] AVISO: ${buildImplausibleKitCountWarning(rawCount, dbPath)}`);
  try {
    spawnFn(
      process.execPath,
      ["--import", "tsx", resolve(ROOT, "scripts/log-event.ts"), ...buildImplausibleKitCountLogArgs(rawCount, dbPath)],
      { cwd: ROOT, stdio: "ignore", encoding: "utf8" },
    );
  } catch {
    // fire-and-forget: falha de logging nunca pode mascarar/bloquear o script principal.
  }
}

export interface ResolvedSubscriberCount {
  /** Melhor contagem disponível — pode vir do fallback Beehiiv (ou `0`)
   *  quando `warning` está presente, já que a leitura primária (Kit) foi
   *  descartada por implausível. */
  count: number;
  /** #8322 — presente quando a contagem PRIMÁRIA (Kit) devolveu um valor
   *  implausível (>0, abaixo de `MIN_PLAUSIBLE_KIT_ACTIVE_COUNT`). `main()`
   *  grava este texto EXPLICITAMENTE no snapshot no lugar do número cru —
   *  nunca aceita o valor implausível, nunca omite o campo em silêncio
   *  (critério de aceite da #8322). */
  warning?: string;
}

/**
 * Resolve a contagem de assinantes ativos respeitando
 * `publishing.newsletter.subscriber_backend` — mesmo precedente de leitura
 * condicional que `count-subscriptions-by-utm.ts`
 * (`fetchAndAggregateKit`/`fetchAndAggregate`) já usa pro eixo SUBSCRIBER.
 *
 * Backend `"kit"`: lê `getKitActiveSummary` do store unificado LOCAL
 * (`data/diaria-subscribers/diaria-subscribers.db`) — síncrono, sem
 * chamada de rede, mesmo padrão fail-soft de `resolveCrossPlatformDeps`
 * em `check-metrics-health.ts` (abre, lê, fecha em `finally`, nunca lança).
 * Se o store está indisponível (sessão sem `data/`, ingestão ainda não
 * rodou) ou devolve `count === 0` — indistinguível de "ainda não ingerido"
 * — cai pro cache Beehiiv abaixo como fallback: um número desatualizado
 * com fonte errada ainda é melhor que nenhum número, e o backend "kit" só
 * existe quando a base REAL migrou pra lá (#7386/#7388). Um `count` entre 1
 * e `MIN_PLAUSIBLE_KIT_ACTIVE_COUNT` (exclusive) é tratado diferente: nunca
 * "ainda não ingerido" (#8322) — dispara `warnFn`/log-event e devolve
 * `warning` preenchido, mesmo caindo pro mesmo fallback Beehiiv por baixo.
 *
 * Backend `"beehiiv"` (default): lê `pub.stats?.active_subscriptions` de
 * `PUB_JSON`, como sempre fez. Erro de leitura/parse passa por
 * `logFileReadWarning` (#8150) em vez de sumir num `catch` mudo.
 *
 * NUNCA lança — qualquer falha degrada pra `{ count: 0 }`.
 */
export function resolveSubscriberCount(opts: {
  backend: NewsletterSubscriberBackend;
  pubJsonPath: string;
  dbPath?: string;
  existsFn?: (p: string) => boolean;
  readFileFn?: (p: string) => string;
  openDbFn?: (path: string) => ReturnType<typeof openDiariaSubscribersDbSafe>;
  getKitActiveSummaryFn?: typeof getKitActiveSummary;
  spawnFn?: typeof spawnSync;
  warnFn?: (message: string) => void;
}): ResolvedSubscriberCount {
  const {
    backend,
    pubJsonPath,
    dbPath = DEFAULT_DB_PATH,
    existsFn = existsSync,
    readFileFn = (p: string) => readFileSync(p, "utf8"),
    openDbFn = openDiariaSubscribersDbSafe,
    getKitActiveSummaryFn = getKitActiveSummary,
    spawnFn,
    warnFn,
  } = opts;

  const readBeehiivFallback = (): number => {
    if (!existsFn(pubJsonPath)) return 0;
    try {
      const pub = JSON.parse(readFileFn(pubJsonPath));
      return pub.stats?.active_subscriptions ?? 0;
    } catch (error) {
      logFileReadWarning("cache de assinantes Beehiiv", pubJsonPath, error, spawnFn, warnFn);
      return 0;
    }
  };

  if (backend === "kit") {
    const db = openDbFn(dbPath);
    if (db) {
      try {
        const summary = getKitActiveSummaryFn(db);
        if (summary.count >= MIN_PLAUSIBLE_KIT_ACTIVE_COUNT) return { count: summary.count };
        if (summary.count > 0) {
          // #8322: valor implausível (>0, abaixo do piso) — nunca aceito
          // como contagem real, nunca confundido com "0, ainda não
          // ingerido". Avisa alto e cai pro fallback, mas marca `warning`
          // pra main() gravar isso explicitamente no snapshot.
          const warning = buildImplausibleKitCountWarning(summary.count, dbPath);
          logImplausibleKitCountWarning(summary.count, dbPath, spawnFn, warnFn);
          return { count: readBeehiivFallback(), warning };
        }
        // summary.count === 0: comportamento pré-existente, mantido —
        // "ainda não ingerido", cai pro fallback Beehiiv sem warning.
      } catch (error) {
        logFileReadWarning("Kit active summary query", dbPath, error, spawnFn, warnFn);
      } finally {
        db.close();
      }
    }
    // Store indisponível/vazio/query falhou — cai pro cache Beehiiv abaixo.
  }

  return { count: readBeehiivFallback() };
}

/** Pluralização simples pt-BR do substantivo emprestado "subscriber(s)" (#8150 item 3). */
function pluralizeSubscribers(n: number): string {
  return n === 1 ? "subscriber" : "subscribers";
}

// ─── Main ──────────────────────────────────────────────────────────────────────

export interface UpdateAudienceDeps {
  outPath?: string;
  historyDir?: string;
  ctrCsvPath?: string;
  surveyJsonPath?: string;
  pubJsonPath?: string;
  h4HistoryPath?: string;
  editionsDir?: string;
  /** Override do arg de linha de comando (`process.argv[2]`) — path de um survey JSON alternativo. `null` explícito = "sem override, usar `surveyJsonPath` se existir". */
  surveyPathArg?: string | null;
  /** Data "hoje" — injetável pra determinismo em teste. Default: data real. */
  today?: Date;
  subscriberBackend?: NewsletterSubscriberBackend;
  dbPath?: string;
  openDbFn?: (path: string) => ReturnType<typeof openDiariaSubscribersDbSafe>;
  getKitActiveSummaryFn?: typeof getKitActiveSummary;
  /** Injetável pra teste — evita spawnar `log-event.ts` de verdade (escreveria em `data/run-log.jsonl` real). Default: `spawnSync`. */
  spawnFn?: typeof spawnSync;
  warnFn?: (message: string) => void;
}

export interface UpdateAudienceResult {
  ok: boolean;
  reason?: string;
  outPath?: string;
  subscribers?: number;
  /** #8322 — presente quando a contagem "kit ativo" primária foi descartada
   *  por implausível; o mesmo texto que foi gravado no snapshot. */
  subscriberWarning?: string;
  sources?: string[];
}

/**
 * Núcleo do script — exportado pra teste real de `main()` exercer o
 * documento gerado de ponta a ponta (#8151), sem depender de `process.exit`
 * nem de `process.argv`. Todos os paths/deps são injetáveis com default
 * pros paths reais do repo (mesmo comportamento de antes quando chamado
 * sem argumentos pela CLI). NUNCA lança — falhas viram `{ ok: false,
 * reason }`, e é o chamador CLI (guard `isMainModule` no fim do arquivo)
 * quem decide o exit code a partir disso.
 */
export function main(deps: UpdateAudienceDeps = {}): UpdateAudienceResult {
  const {
    outPath = OUT,
    historyDir = HISTORY_DIR,
    ctrCsvPath = CTR_CSV,
    surveyJsonPath = SURVEY_JSON,
    pubJsonPath = PUB_JSON,
    h4HistoryPath = H4_HISTORY,
    editionsDir = resolve(ROOT, editionsRoot()),
    surveyPathArg = null,
    today: todayDate = new Date(),
    subscriberBackend = resolveNewsletterSubscriberBackend(),
    dbPath = DEFAULT_DB_PATH,
    openDbFn = openDiariaSubscribersDbSafe,
    getKitActiveSummaryFn = getKitActiveSummary,
    spawnFn = spawnSync,
    warnFn = console.warn,
  } = deps;

  const today = todayDate.toISOString().slice(0, 10);

  // Subscriber count (#8145 — respeita subscriber_backend; #8322 — nunca
  // aceita uma contagem "kit ativo" implausível em silêncio)
  const subscriberResolution = resolveSubscriberCount({
    backend: subscriberBackend,
    pubJsonPath,
    dbPath,
    openDbFn,
    getKitActiveSummaryFn,
    spawnFn,
    warnFn,
  });
  const subscribers = subscriberResolution.count;
  const subscriberWarning = subscriberResolution.warning;

  // CTR data (primary)
  const ctr = parseCtr(ctrCsvPath);

  // Survey data (secondary)
  const surveyPath = surveyPathArg ?? (existsSync(surveyJsonPath) ? surveyJsonPath : null);
  let surveyResponses: BeehiivResponse[] = [];
  if (surveyPath && existsSync(surveyPath)) {
    try {
      const all: BeehiivResponse[] = JSON.parse(readFileSync(surveyPath, "utf8"));
      surveyResponses = all.filter((r) => !r.status || r.status === "active");
    } catch (error) {
      logFileReadWarning("survey JSON", surveyPath, error, spawnFn, warnFn);
    }
  }

  if (!ctr && surveyResponses.length === 0) {
    return { ok: false, reason: "Nenhuma fonte disponível (CTR CSV ou survey JSON). Nada a gerar." };
  }

  const lines: string[] = [
    "# Perfil de Audiência — diar.ia.br",
    "",
    `**updated_at:** ${today}`,
    // #8322: `subscriberWarning` presente vence sobre o número — nunca grava
    // o valor implausível, nunca omite o campo em silêncio nesse caso (a
    // omissão silenciosa quando `subscribers === 0` SEM warning continua
    // válida — "ainda não ingerido", comportamento pré-existente do #8150).
    ...(subscriberWarning
      ? [`**subscribers ativos:** indisponível — ${subscriberWarning}`]
      : subscribers > 0
        ? [`**subscribers ativos:** ${subscribers}`]
        : []),
    ...(surveyResponses.length > 0 ? [`**respondentes survey:** ${surveyResponses.length}`] : []),
    ...(ctr
      ? [
          `**links analisados:** ${ctr.totalLinks} (${ctr.totalEditions} edições, 7+ dias de idade)`,
          `**filtros aplicados (#1564):** ${ctr.filteredAprofunde} rows com anchor "Aprofunde" excluídas (regime pré-mar/2026); **(#4839):** ${ctr.filteredNonEditorial} rows de hosts não-editoriais excluídas (rodapé LinkedIn, crédito de imagem Wikimedia/Wikidata, afiliado Amazon, links de casa, apoia.se); exponential decay com time constant ${DECAY_TIME_CONSTANT_DAYS}d aplicado (half-life ~${Math.round(DECAY_TIME_CONSTANT_DAYS * Math.log(2))}d)`,
        ]
      : []),
  ];

  // ─── Section 1: CTR (primary) ─────────────────────────────────────────────

  if (ctr) {
    // Compute overall average CTR
    const totalClicks = [...ctr.byCategory.values()].reduce((s, a) => s + a.clicks, 0);
    const totalOpens = [...ctr.byCategory.values()].reduce((s, a) => s + a.opens, 0);
    const globalRate = totalOpens > 0 ? totalClicks / totalOpens : 0; // fração 0..1
    const avgCtr = globalRate * 100;

    lines.push(
      "",
      "## 1. Engajamento real (CTR por categoria)",
      "",
      subscriberWarning
        // #8322: mesmo critério do header acima — contagem implausível nunca
        // vira "N subscribers" na prosa, mesmo quando o fallback Beehiiv
        // deu um `subscribers` > 0 pra usar em outro lugar.
        ? `Fonte primária: comportamento observado em ${ctr.totalEditions} edições (contagem de subscribers indisponível — ${subscriberWarning}).`
        : subscribers > 0
          ? `Fonte primária: comportamento de ${subscribers} ${pluralizeSubscribers(subscribers)} em ${ctr.totalEditions} edições.`
          // #8150: mesmo tratamento da linha 627 acima (omitir/sinalizar quando a
          // contagem é 0) — nunca o placeholder "N" solto em prosa.
          : `Fonte primária: comportamento observado em ${ctr.totalEditions} edições (contagem de subscribers indisponível).`,
      `CTR médio geral: ${avgCtr.toFixed(2)}%`,
      "",
      `**Método (#4840):** cada categoria abaixo tem CTR encolhido empírico-Bayes rumo à média geral (k=${CTR_SHRINKAGE_K} "aberturas de prior" — quanto menor o n da categoria, mais a estimativa é puxada pra média). Categorias são agrupadas em 3 bandas em vez de ordenadas por posição — um ranking de posição não é sustentado pelo n típico destas categorias (validação: split cronológico com Spearman ≈0,06 fora da amostra, IC95 do posto cobrindo boa parte das 17 posições). O n (links + aberturas) de cada categoria é sempre publicado, mesmo quando ela cai em "sem sinal".`,
      "",
    );

    // #4840: encolhimento empírico-Bayes + 3 bandas em vez de ranking por posição.
    const catRows = [...ctr.byCategory.entries()].map(([cat, agg]) => {
      const shrunk = shrinkCtr(agg.clicks, agg.opens, globalRate);
      return { cat, agg, shrunk, band: classifyCtrBand(shrunk, globalRate) };
    });

    const BAND_ORDER: CtrBand[] = ["acima", "sem_sinal", "abaixo"];
    const BAND_LABEL: Record<CtrBand, string> = {
      acima: "Acima da média (IC95 exclui a média — sinal)",
      sem_sinal: "Sem sinal (não distinguível da média no IC95)",
      abaixo: "Abaixo da média (IC95 exclui a média — sinal)",
    };

    for (const band of BAND_ORDER) {
      const rows = catRows
        .filter((r) => r.band === band)
        .sort((a, b) => a.cat.localeCompare(b.cat, "pt-BR")); // alfabético — nunca por CTR (evita implicar ranking)
      if (rows.length === 0) continue;
      lines.push(`**${BAND_LABEL[band]}:**`, "");
      for (const { cat, agg, shrunk } of rows) {
        lines.push(formatCtrCategoryLine(cat, agg, shrunk));
      }
      lines.push("");
    }

    // By category + origin (top performers) — #4880: encolhido igual
    // byCategory/byDomain (#4840). O n aqui é tipicamente MENOR que o de
    // byCategory (interseção categoria×origem), então o problema estatístico
    // que motivou o #4840 é ainda mais grave sem encolhimento.
    lines.push(
      "",
      "### Destaques por categoria + origem",
      "",
      `Top 10 combinações com maior CTR encolhido (mínimo 5 links, k=${CTR_SHRINKAGE_K}):`,
      "",
    );

    const catOrEntries = [...ctr.byCatOrigin.entries()]
      .filter(([, a]) => a.count >= 5)
      .map(([key, agg]) => ({ key, agg, shrunk: shrinkCtr(agg.clicks, agg.opens, globalRate) }))
      .sort((a, b) => b.shrunk.rate - a.shrunk.rate)
      .slice(0, 10);

    for (const { key, agg, shrunk } of catOrEntries) {
      const [cat, origin] = key.split("|");
      lines.push(`- **${cat} ${origin}** — CTR ${(shrunk.rate * 100).toFixed(2)}% (encolhida) | ${agg.count} links`);
    }

    // By origin — #4880: mesmo encolhimento (empírico-Bayes, mesma k/globalRate)
    lines.push("", "### Engajamento por origem", "");

    const originEntries = [...ctr.byOrigin.entries()]
      .map(([origin, agg]) => ({ origin, agg, shrunk: shrinkCtr(agg.clicks, agg.opens, globalRate) }))
      .sort((a, b) => b.shrunk.rate - a.shrunk.rate);

    for (const { origin, agg, shrunk } of originEntries) {
      const pctLinks = ((agg.count / ctr.totalLinks) * 100).toFixed(1);
      lines.push(`- **${origin}** — CTR ${(shrunk.rate * 100).toFixed(2)}% (encolhida) | ${agg.count} links (${pctLinks}% do total)`);
    }

    // #1564: derivar annotation BR vs INT da data atual em vez de hardcoded.
    // Pre-mudança assumia BR > INT (era verdade no regime antigo); pós-mudança
    // o ranking pode ter virado. Annotation derivada evita stale claim.
    // #4880: usa a mesma taxa encolhida da lista acima (era CTR bruto antes),
    // pra não afirmar uma diferença BR×INT que o encolhimento já descartou.
    const brCtr = (() => {
      const a = ctr.byOrigin.get("BR");
      return a && a.opens > 0 ? shrinkCtr(a.clicks, a.opens, globalRate).rate * 100 : 0;
    })();
    const intCtr = (() => {
      const a = ctr.byOrigin.get("INT");
      return a && a.opens > 0 ? shrinkCtr(a.clicks, a.opens, globalRate).rate * 100 : 0;
    })();
    const originHint = (() => {
      if (brCtr === 0 || intCtr === 0) return "Sem dados suficientes pra comparar BR vs INT.";
      const ratio = brCtr / intCtr;
      if (ratio >= 1.15) return `Conteúdo BR tem CTR ${Math.round((ratio - 1) * 100)}% maior — priorizar quando disponível em qualidade equivalente.`;
      if (ratio <= 0.85) return `Conteúdo INT tem CTR ${Math.round((1 / ratio - 1) * 100)}% maior — não há prêmio automático por origem BR; avaliar caso a caso.`;
      return "BR e INT têm CTR comparável — origem não é fator decisivo, focar em relevância editorial.";
    })();
    lines.push(
      "",
      `> **Como usar:** só a banda "acima" deve receber bônus de score; "sem sinal" não deve mover pontuação em nenhuma direção; "abaixo" é candidata a leve penalidade. Nenhuma banda deve ser lida como ranking fino entre categorias vizinhas — o encolhimento existe justamente pra não afirmar diferença que o n não sustenta.`,
      `> ${originHint}`,
    );

    // By domain (source quality) — #4840: mantida (não removida), mas
    // também encolhida (mesma k, mesma globalRate). A lista antiga de
    // "fontes com CTR 0.00%" foi removida: era artefato de cold-start (poucos
    // cliques observados) que o encolhimento já resolve — domínio com pouco
    // histórico agora aparece perto da média, não em 0.00% isolado.
    const MIN_LINKS_DOMAIN = 3;
    const domainEntries = [...ctr.byDomain.entries()]
      .filter(([, a]) => a.count >= MIN_LINKS_DOMAIN)
      .map(([dom, a]) => {
        const shrunk = shrinkCtr(a.clicks, a.opens, globalRate);
        return { dom, ...a, ctr: shrunk.rate * 100 };
      })
      .sort((a, b) => b.ctr - a.ctr);

    if (domainEntries.length > 0) {
      lines.push(
        "",
        `### CTR por fonte (mínimo 3 links, encolhido k=${CTR_SHRINKAGE_K})`,
        "",
        "Top 15 fontes com maior engajamento (CTR encolhido rumo à média geral):",
        "",
      );

      for (const e of domainEntries.slice(0, 15)) {
        lines.push(`- **${e.dom}** — CTR ${e.ctr.toFixed(1)}% (encolhida) | ${e.count} links | ${Math.round(e.opens)} aberturas`);
      }

      lines.push(
        "",
        "> **Como usar:** fontes com CTR encolhido acima da média indicam conteúdo que a audiência valoriza.",
        "> Fontes com poucos links (perto do mínimo de 3) aparecem puxadas pra média — isso é esperado (encolhimento), não indica baixa qualidade por si só.",
      );
    }
  }

  // ─── Section 2: Survey (secondary) ────────────────────────────────────────

  if (surveyResponses.length > 0) {
    const contentTypes = countAnswers(surveyResponses, /se[çc][õo]es|tipos? de conte[úu]do/i);
    const sectors = countAnswers(surveyResponses, /setor de atua[çc][ãa]o da organiza/i);
    const areas = countAnswers(surveyResponses, /principal [áa]rea de atua[çc][ãa]o/i);
    const aiLevel = countAnswers(surveyResponses, /n[íi]vel de conhecimento em ia/i);

    lines.push(
      "",
      "## 2. Preferências declaradas (survey)",
      "",
      `Fonte secundária: ${surveyResponses.length} respondentes. Usar para calibrar tom e vocabulário, não para priorizar temas.`,
      "",
      "### Conteúdo preferido",
      "",
      ...contentTypes.map((e) => `- **${e.label}** — weight ${e.weight} (${e.count} respostas)`),
      "",
      "### Nível de conhecimento em IA",
      "",
      ...aiLevel.map((e) => `- **${e.label}** — weight ${e.weight} (${e.count} respostas)`),
      "",
      "> **Como usar:** maioria é uso casual/consciente. Evitar jargão técnico sem explicação.",
      "",
      "## 3. Quem são (demographics)",
      "",
      "### Setores",
      "",
      ...sectors.map((e) => `- **${e.label}** — weight ${e.weight} (${e.count} respostas)`),
      "",
      "### Áreas de atuação",
      "",
      ...areas.map((e) => `- **${e.label}** — weight ${e.weight} (${e.count} respostas)`),
    );
  }

  lines.push(
    "",
    "---",
    "",
    "_Regerado por `scripts/update-audience.ts` a partir de CTR (`data/link-ctr-table.csv`) e survey (`data/audience-raw.json`)._",
  );

  // Archive existing — feito aqui (logo antes do write final), não no topo do
  // main(): #4366 achou que arquivar cedo demais (antes de `lines` estar
  // pronto) deixa uma janela onde uma exceção na montagem do conteúdo novo
  // arquiva o profile antigo mas nunca sobrescreve `context/audience-profile.md`
  // — a regeneração falha silenciosamente e o próximo run re-arquiva o mesmo
  // conteúdo stale sob uma data de calendário diferente. Fazer o archive só
  // quando `lines` já está montado (a exceção, se houver, acontece antes e
  // propaga sem arquivar nada) fecha essa janela pro caso comum (erro de
  // montagem de conteúdo); não protege contra falha no meio do próprio I/O de
  // arquivo, que é um risco residual aceito (mesma classe de qualquer script).
  // Archive: feito aqui com o CONTEÚDO PRÉ-sobrescrita (currentContent lido
  // ANTES do writeFileSync abaixo) — é esse arquivamento pré-sobrescrita que
  // o teste de I/O do #8151 item 3 afirma (rodar main() 2x num tmpdir e
  // checar que o snapshot recebe o conteúdo da 1ª rodada, não da 2ª).
  if (existsSync(outPath)) {
    mkdirSync(historyDir, { recursive: true });
    const currentContent = readFileSync(outPath, "utf8");
    const todayFile = `${today}.md`;
    const latestFile = findLatestHistoryFile(historyDir, todayFile);
    const latestContent = latestFile ? readFileSync(resolve(historyDir, latestFile), "utf8") : null;
    handleArchiveGuard(currentContent, todayFile, latestFile, latestContent, spawnFn, warnFn);
    copyFileSync(outPath, resolve(historyDir, todayFile));
  }

  writeFileSync(outPath, lines.join("\n"), "utf8");

  const sources: string[] = [];
  if (ctr) sources.push(`CTR (${ctr.totalLinks} links)`);
  if (surveyResponses.length > 0) sources.push(`survey (${surveyResponses.length} respondentes)`);
  console.log(`Wrote audience profile [${sources.join(" + ")}] → ${outPath}`);

  // ─── H4: scorer×CTR — computa edições recém-maduras + surfacing semanal (#1619) ─
  // Defensivo: se CTR CSV ausente, pula silenciosamente (aviso já emitido por loadCtrRowsH4).
  const h4CtrRows = loadCtrRowsH4(ctrCsvPath);
  if (h4CtrRows.length > 0) {
    const alreadyComputed = loadHistoryEditions(h4HistoryPath);
    const newEntries = computeNewH4Entries(h4CtrRows, editionsDir, alreadyComputed);
    if (newEntries.length > 0) {
      appendHistory(h4HistoryPath, newEntries);
      console.log(`[H4] +${newEntries.length} edição(ões) nova(s) gravada(s) em data/scorer-ctr-history.jsonl`);
    }
    const allH4Entries = loadHistory(h4HistoryPath);
    const trend = computeH4Trend(allH4Entries);
    console.log(formatH4Trend(trend));
  }

  return { ok: true, outPath, subscribers, subscriberWarning, sources };
}

// Run main() apenas quando invocado como CLI direto.
// Sem este guard, qualquer test que importe deste arquivo dispara main() →
// `process.exit(1)` quando CTR CSV ausente (CI não tem `data/`).
if (isMainModule(import.meta.url)) {
  const result = main({ surveyPathArg: process.argv[2] ?? null });
  if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
  }
}
