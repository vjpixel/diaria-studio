/**
 * clarice-paths.ts (#1961)
 *
 * Resolução de caminhos do programa Clarice/Brevo, namespaceada por **ciclo de
 * envio** no formato `{conteúdo}-{envio}` (ex: `2604-05` = digest de abril
 * enviado em maio; `2605-06` = maio enviado em junho).
 *
 * Por que `{conteúdo}-{envio}` e não só o mês: o nome da campanha na Brevo usa o
 * mês do **conteúdo** (digest de abril → "Diar.ia Mensal 2604"), mas o envio
 * acontece no mês **seguinte**. Carregar os dois no nome da pasta elimina a
 * ambiguidade ("2604 ou 2605?") que confundia na virada do mês. (#1961)
 *
 * Estrutura:
 *
 *   data/clarice-subscribers/
 *     stripe-customers-*.csv            ← inputs-base (root, não por-ciclo)
 *     stripe-export-excluded.csv         ← idem
 *     stripe-export-t01-assinantes-ativos.csv … t10-leads-caudao.csv  ← base segmentada (merge, root)
 *     {conteúdo}-{envio}/               ← artefatos POR-CICLO (ex: 2605-06/)
 *       mv-export-t02-ex-assinantes-verified.csv / -rejected.csv / -unknown.csv  (saída do MV)
 *       mv-export-maio-verified.csv / …            (cohort maio, se houver)
 *       .mv-cache-*.json
 *       waves/   (nome = wX + ferramenta que segmentou + tier)
 *         w1-brevo-export-t1-openers.csv · w2-brevo-export-t1-non-openers.csv
 *         w3-mv-export-t2.csv · w4-mv-export-t2.csv · w5-mv-export-maio.csv (opcional)
 *         waves-summary.json
 *
 * O `--cycle {conteúdo}-{envio}` é OBRIGATÓRIO nos scripts por-ciclo (como
 * "data da edição é sempre explícita") — sem default, pra não rotular/ler o
 * ciclo errado perto da virada do mês.
 */
import { existsSync, mkdirSync, readdirSync, statSync, type Dirent } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg } from "./cli-args.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Raiz da base Clarice (junction → OneDrive). Inputs-base + tiers moram aqui. */
export const CLARICE_BASE = resolve(REPO_ROOT, "data/clarice-subscribers");

/**
 * Pure: valida o rótulo de ciclo `{conteúdo}-{envio}` = `YYMM-MM` (ex: 2605-06).
 *
 * Não basta a FORMA (`\d{4}-\d{2}`): valida também a semântica, senão typos como
 * `2605-13`/`2605-00` (mês impossível) ou `2605-07` (pulando o envio) passariam —
 * e é justamente o mislabel de mês que o `{conteúdo}-{envio}` existe pra prevenir.
 *   - mês do conteúdo e mês do envio ∈ 01..12;
 *   - envio = conteúdo + 1 (rollover dez→jan), a invariante do programa
 *     ("o digest de abril sai em maio").
 */
export function isValidCycle(c: string | undefined | null): c is string {
  if (!c || !/^\d{4}-\d{2}$/.test(c)) return false;
  const contentMonth = Number(c.slice(2, 4)); // MM do {YYMM}
  const sendMonth = Number(c.slice(5, 7));
  if (contentMonth < 1 || contentMonth > 12) return false;
  if (sendMonth < 1 || sendMonth > 12) return false;
  return sendMonth === (contentMonth % 12) + 1;
}

/**
 * Primeiro instante (00:00 UTC) do mês de ENVIO do ciclo, em ISO (#4765).
 * Base do cutoff automático de recência que `clarice-build-segment.ts` aplica
 * por padrão (sem flag): o guard cycle-wide `sent-or-queued.json` só enxerga
 * quem foi SELECIONADO por uma invocação `--group` neste processo — este
 * cutoff cobre a MESMA janela de tempo (o ciclo corrente) contra o dado real
 * do store (`last_sent_at`), pegando quem recebeu por qualquer via, mesmo se
 * `sent-or-queued.json` não tiver rastro dele (achado #4765: 52 de 1.963
 * contatos escaparam do dedup padrão numa onda porque a invocação anterior
 * que os selecionou não deixou esse rastro).
 *
 * Rollover dez→jan: `isValidCycle` já garante `sendMonth === (contentMonth%12)+1`,
 * então o único caso em que o ano de ENVIO avança é `contentMonth=12,
 * sendMonth=1` — tratado abaixo via `sendMonth < contentMonth`.
 */
export function cycleSendMonthStartIso(cycle: string): string {
  if (!isValidCycle(cycle)) {
    throw new Error(
      `ciclo inválido: ${cycle} (esperado {conteúdo}-{envio} com envio = conteúdo+1, ex: 2605-06)`,
    );
  }
  const contentYear2 = Number(cycle.slice(0, 2));
  const contentMonth = Number(cycle.slice(2, 4));
  const sendMonth = Number(cycle.slice(5, 7));
  const sendYear2 = sendMonth < contentMonth ? contentYear2 + 1 : contentYear2;
  return new Date(Date.UTC(2000 + sendYear2, sendMonth - 1, 1)).toISOString();
}

/**
 * Diretório do ciclo (`…/clarice-subscribers/{conteúdo}-{envio}`). Pure (path join).
 *
 * @param baseDir Opcional, default = `CLARICE_BASE` (raiz REAL, junction pro
 *                OneDrive). Aceito pra permitir testes de `main()` apontarem
 *                a escrita pra um tmpdir isolado em vez do disco real de
 *                produção — mesmo padrão de `checkNoHtmlInMonthlyDriveSync(baseDir?)`
 *                em `scripts/check-invariants.ts` (#4207, generaliza o
 *                workaround pontual `--segments-dir` do #4176).
 */
export function clariceCycleDir(cycle: string, baseDir?: string): string {
  if (!isValidCycle(cycle)) {
    throw new Error(
      `ciclo inválido: ${cycle} (esperado {conteúdo}-{envio} com envio = conteúdo+1, ex: 2605-06)`,
    );
  }
  return resolve(baseDir ?? CLARICE_BASE, cycle);
}

/** Diretório de waves do ciclo (`…/{conteúdo}-{envio}/waves`). `baseDir` — ver `clariceCycleDir` (#4207). */
export function clariceWavesDir(cycle: string, baseDir?: string): string {
  return resolve(clariceCycleDir(cycle, baseDir), "waves");
}

/**
 * Diretório de grupos de envio NOMEADOS do ciclo (`…/{conteúdo}-{envio}/segments`,
 * #2885 — `scripts/clarice-build-segment.ts`). Irmão de `waves/`: a rampa
 * (crescer alcance) mora em `waves/`, os grupos por objetivo (retenção,
 * re-ativação, 1º-envio-seguro) moram aqui — não se misturam nem colidem em
 * nome de arquivo. `baseDir` — ver `clariceCycleDir` (#4207).
 */
export function clariceSegmentsDir(cycle: string, baseDir?: string): string {
  return resolve(clariceCycleDir(cycle, baseDir), "segments");
}

/**
 * Diretório dos 3 envios RAMP-WARM (cold, 1º envio) agendados fim-a-fim por
 * `scripts/clarice-schedule-ramp.ts` (#3593). Irmão de `waves/`/`segments/`:
 * deliberadamente SEPARADO de `waves/` (órfão desde o #4759 — usava a rampa
 * store-driven, `clarice-build-waves-store.ts`, aposentada; formato era
 * `waves-manifest.json`/`w*-store.csv`) e de
 * `segments/` (grupos nomeados de `clarice-build-segment.ts`, incluindo o
 * `ramp-warm` de 1 lista só) — os 3 CSVs disjuntos (ter/sex/dom) deste script
 * teriam o MESMO nome de arquivo (`ramp-warm.csv`) que o grupo nomeado
 * homônimo se compartilhassem `segments/`, colidindo/sobrescrevendo caso os
 * dois fluxos rodem no mesmo ciclo. `baseDir` — ver `clariceCycleDir` (#4207).
 */
export function clariceRampDir(cycle: string, baseDir?: string): string {
  return resolve(clariceCycleDir(cycle, baseDir), "ramp");
}

/** Caminho de um arquivo de input-base (root, não por-ciclo): stripe, excluded, tiers. */
export function clariceBaseFile(name: string): string {
  return resolve(CLARICE_BASE, name);
}

/** Cria o diretório (recursivo) se faltar e devolve o próprio path. */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Sinal de atividade real do ciclo (#4621) ────────────────────────────────
//
// `campaigns-summary.json` (consultado por `resolveSubjectFromCampaignsSummary`
// em monthly-paths.ts) só é escrito pelo pipeline canônico multi-bloco
// (clarice-build-edition-sends.ts → clarice-split-cells.ts → clarice-schedule-sends.ts --create).
// Os envios ad-hoc por grupo nomeado (clarice-build-segment.ts --group +
// clarice-schedule-group.ts --group, ex: reativacao/novos) NUNCA escrevem
// nesse arquivo — mas escrevem artefatos (segments/*.csv,
// segments/sent-or-queued.json, segments/group-campaigns.json, waves/*)
// dentro de `clariceCycleDir(cycle)`. Essa presença é o sinal barato de
// "esse ciclo teve envio de verdade recentemente", usado como guard
// independente pra detectar quando `resolve-cycle` caiu num fallback
// silenciosamente desatualizado.

/**
 * Fs ops injetáveis pra teste (default = reais do `node:fs`). Permite
 * simular falha de IO (EBUSY/EPERM/EACCES do OneDrive, p.ex.) sem depender
 * de condição de corrida real no disco — ver `cycleHasClariceActivity`/
 * `listClariceCycleDirs` (#4621 follow-up: fail-open silencioso em erro de
 * IO era indistinguível de "genuinamente sem atividade").
 */
export interface ClariceCycleFsOps {
  existsSync: typeof existsSync;
  readdirSync: typeof readdirSync;
  statSync: typeof statSync;
}

const DEFAULT_FS_OPS: ClariceCycleFsOps = { existsSync, readdirSync, statSync };

/** Callback default de `onError`: imprime no stderr — nunca some em silêncio. */
function warnToStderr(msg: string): void {
  console.error(`⚠️  ${msg}`);
}

/**
 * O diretório do ciclo (`data/clarice-subscribers/{cycle}/`) existe e contém
 * pelo menos 1 arquivo (recursivo) — sinal de atividade real de envio, não
 * só a pasta criada vazia. Pure/IO: lê disco, nunca lança (retorna `false`
 * em qualquer erro, mesma disciplina de `hasReadyPreviewHtml`).
 *
 * `false` tem 2 causas bem diferentes: (a) o diretório genuinamente não tem
 * arquivo (`existsSync` já filtrou "não existe" antes do try); (b) a leitura
 * falhou por erro de IO inesperado (lock do OneDrive, permissão). (b) é
 * silenciosamente indistinguível de (a) pro caller — por isso chama
 * `onError` (default: warning no stderr) ANTES de retornar `false`, e aceita
 * `onError` injetável pra quem precisa acumular o erro (ver
 * `ClariceActivityDeps.ioErrors` em monthly-paths.ts, #4621 follow-up).
 */
export function cycleHasClariceActivity(
  cycle: string,
  baseDir?: string,
  onError: (msg: string) => void = warnToStderr,
  fsOps: ClariceCycleFsOps = DEFAULT_FS_OPS,
): boolean {
  if (!isValidCycle(cycle)) return false;
  const dir = clariceCycleDir(cycle, baseDir);
  if (!fsOps.existsSync(dir)) return false;
  try {
    const entries = fsOps.readdirSync(dir, { recursive: true, withFileTypes: true }) as Dirent[];
    return entries.some((e) => e.isFile());
  } catch (err) {
    onError(
      `cycleHasClariceActivity: falha ao ler ${dir} (${err instanceof Error ? err.message : String(err)}) — ` +
        `tratando como "sem atividade" pra ESTE ciclo (fail-closed), mas o sinal de #4621 pode estar cego aqui.`,
    );
    return false;
  }
}

/**
 * Lista os subdiretórios de `data/clarice-subscribers/` (ou `baseDir`) cujo
 * nome é um ciclo `{conteúdo}-{envio}` válido — candidatos a "ciclo com
 * atividade" antes do filtro `cycleHasClariceActivity`. `[]` se a base não
 * existir (nunca lança).
 *
 * Mesma disciplina de `cycleHasClariceActivity`: `[]` por erro de IO
 * (distinto de "base ausente", já filtrado por `existsSync` antes do try)
 * chama `onError` antes de retornar, pra não ficar indistinguível de "base
 * genuinamente sem ciclos" (#4621 follow-up).
 */
export function listClariceCycleDirs(
  baseDir?: string,
  onError: (msg: string) => void = warnToStderr,
  fsOps: ClariceCycleFsOps = DEFAULT_FS_OPS,
): string[] {
  const base = baseDir ?? CLARICE_BASE;
  if (!fsOps.existsSync(base)) return [];
  try {
    return fsOps.readdirSync(base).filter((d) => {
      if (!isValidCycle(d as string)) return false;
      try {
        return fsOps.statSync(resolve(base, d as string)).isDirectory();
      } catch {
        return false;
      }
    }) as string[];
  } catch (err) {
    onError(
      `listClariceCycleDirs: falha ao listar ${base} (${err instanceof Error ? err.message : String(err)}) — ` +
        `tratando como "nenhum ciclo" (fail-closed), mas o sinal de #4621 pode estar cego aqui.`,
    );
    return [];
  }
}

/** Pure (testável): parseia `--cycle`; "" quando ausente/inválido (caller valida).
 *  Usa o `getArg` compartilhado (trata `--cycle` no fim / seguido de outra flag). */
export function parseCycleArg(argv: string[]): string {
  const v = getArg(argv, "cycle");
  return isValidCycle(v) ? v : "";
}

/**
 * Extrai `--cycle {conteúdo}-{envio}` do argv. OBRIGATÓRIO: aborta o processo
 * (exit 1) com mensagem clara se ausente/inválido. Use no `main()` dos scripts.
 */
export function requireCycleArg(argv: string[]): string {
  const v = parseCycleArg(argv);
  if (!v) {
    console.error("--cycle {conteúdo}-{envio} é obrigatório (ex: --cycle 2605-06).");
    process.exit(1);
  }
  return v;
}
