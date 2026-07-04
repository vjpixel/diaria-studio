#!/usr/bin/env node
/**
 * clarice-build-edition-sends.ts (#2775 — cutover store-driven da rampa diária)
 *
 * Monta os envios diários de um ciclo de rampa (warm-up morno->frio) a partir
 * do STORE único (#2647, `clarice-segment.ts`) + de um plano de envio EXTERNO
 * (`{ciclo}/send-plan.json` — datas/volumes/blocos, editável pelo operador).
 *
 * Substitui o modelo legado (`SENDS` hardcoded do ciclo 2605-06 + 6 CSVs de
 * tier nomeados à mão) por:
 *   1. `loadStoreRows(db)` → `segmentFromStore` → `priorityQueue` (fila única
 *      ordenada: re-envio engajado → 1º envio por tier → re-envio decaído).
 *   2. `loadSendPlan(cycleDir)` — plano de blocos/dias/volumes do ciclo.
 *   3. Fatia a fila CONSECUTIVAMENTE por bloco (rampa: bloco 1 = topo/mais
 *      quente da fila, blocos seguintes drenam trechos progressivamente mais
 *      frios) — usando o plano INTEIRO como cursor, mesmo quando só um
 *      subconjunto de blocos é escrito nesta invocação (`--blocks`), pra evitar
 *      duplo-envio entre blocos processados em invocações separadas.
 *   4. DENTRO de cada bloco, estratifica (`stratify`, streaming largest-
 *      remainder) as linhas entre os dias do bloco, proporcional ao volume de
 *      cada dia — mesma composição em todo dia do bloco, neutralizando o teste
 *      de dia-da-semana (a diferença morno->frio fica só entre blocos).
 *
 * Shape de output preservado (blast radius mínimo nos consumidores
 * downstream): `d{NN}-{date}.csv` (email,NOME,TIER,IS_SEED) + `sends-summary.json`
 * (agora com `block` no lugar de `week`, e `date`/`scheduledAt`/`volume` por
 * dia — ver `scripts/lib/send-plan.ts`).
 *
 * Uso:
 *   npx tsx scripts/clarice-build-edition-sends.ts --cycle 2605-06 [--blocks 1,2,3] [--dry-run] [--db path] [--cohort junho]
 *   (Requer {ciclo}/send-plan.json — ver scripts/send-plan.example.json.)
 *   --cohort X   OPCIONAL (#2817) — restringe a fila de prioridade a uma safra
 *                mensal antes de segmentar (mesmo `resolveCohortArg` do
 *                clarice-build-waves-store.ts). Sem a flag, roda sobre a base
 *                inteira (comportamento pré-#2817, sem mudança). O cohort
 *                RESOLVIDO é gravado top-level em `sends-summary.json`
 *                (`SendsSummary.cohort`) na 1ª invocação do ciclo e VALIDADO
 *                em toda invocação seguinte (#2851, `assertCohortConsistent`)
 *                — invocações mistas do mesmo ciclo (ex: bloco 1 com
 *                `--cohort junho`, bloco 2 sem `--cohort`) fatiam filas
 *                DIFERENTES pelo mesmo offset numérico (overlap/pulo
 *                silencioso); divergência aborta cedo com erro claro.
 *
 * Inputs:
 *   data/clarice-subscribers/clarice-users.db      store único (#2647)
 *   data/clarice-subscribers/{ciclo}/send-plan.json  plano de envio (blocos/dias/volumes)
 *
 * Outputs (em data/clarice-subscribers/{ciclo}/sends/):
 *   d01-10jun.csv … dNN-*.csv   (colunas: email,NOME,TIER,IS_SEED)
 *   sends-summary.json
 *
 * Guard anti-duplo-envio POR CICLO (#2883): o cursor posicional do item 3 é
 * robusto a invocações PARCIAIS do MESMO snapshot da fila, mas não a drift do
 * store ENTRE invocações (sync do Brevo, novos contatos) — a fila reordena e
 * o offset passa a apontar pra gente diferente. Antes de fatiar, a fila é
 * filtrada pra excluir quem já foi escrito num CSV de wave ANTERIOR deste
 * ciclo (dedup por CONTEÚDO do próprio output, não por posição — ver
 * `collectPriorCycleEmails`/`excludeAlreadySentEmails`). Garante que a UNIÃO
 * das waves de um ciclo é disjunta por email, independente de quando/quantas
 * vezes o store mudou entre invocações.
 */

import { readdirSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { clariceCycleDir, ensureDir, requireCycleArg } from "./lib/clarice-paths.ts";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import { segmentFromStore, priorityQueue, resolveCohortArg, type StoreRow } from "./lib/clarice-segment.ts";
import {
  loadSendPlan,
  allBlocks,
  planByBlock,
  parseBlocksArg,
  sendsSummaryPath,
  type SendPlanEntry,
  type SendsSummaryEntry,
} from "./lib/send-plan.ts";
import { getArg, hasFlag } from "./lib/cli-args.ts";
import { CLARICE_SEED_EMAIL } from "./lib/clarice-seed.ts";

loadProjectEnv();

type Row = Record<string, string>;

// ---------------------------------------------------------------------------
// Pure: apportionment por maior-resto (ints somando `total`, proporcionais a fracs)
// ---------------------------------------------------------------------------

export function apportion(total: number, fracs: number[]): number[] {
  if (total <= 0) return fracs.map(() => 0);
  const raw = fracs.map((f) => f * total);
  const out = raw.map(Math.floor);
  let rem = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ frac: r - Math.floor(r), i }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < rem; k++) out[order[k % order.length].i]++;
  return out;
}

// ---------------------------------------------------------------------------
// Pure: estratificação determinística de `rows` (em ordem de prioridade) em K
// baldes de capacidades `caps` (sum(caps) === rows.length), espalhando cada
// balde uniformemente pela faixa (streaming largest-remainder / Bresenham).
// Garante que cada dia carregue toda a faixa do bloco, não um trecho contíguo.
// ---------------------------------------------------------------------------

export function stratify<T>(rows: T[], caps: number[]): T[][] {
  const k = caps.length;
  const out: T[][] = caps.map(() => []);
  const N = rows.length;
  if (N === 0) return out;
  const credit = new Array<number>(k).fill(0);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < k; i++) credit[i] += caps[i] / N;
    let best = -1;
    let bc = -Infinity;
    for (let i = 0; i < k; i++) {
      if (out[i].length < caps[i] && credit[i] > bc) {
        bc = credit[i];
        best = i;
      }
    }
    out[best].push(rows[j]);
    credit[best] -= 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// StoreRow -> CSV row
// ---------------------------------------------------------------------------

const pad = (t: number): string => `T${String(t).padStart(2, "0")}`;

/**
 * Normaliza uma `StoreRow` pro output: email + NOME + TIER + IS_SEED.
 *
 * TIER deriva do tier numérico do store (`T01`..`T10`; vazio se nulo — leads
 * sem proveniência Stripe). Análogo ao `pad()` de `clarice-build-waves-store.ts`
 * (#2656) — mesma convenção de rótulo entre os dois builders store-driven.
 *
 * IS_SEED: marca `true` se a row for o endereço de monitoramento do editor
 * (`CLARICE_SEED_EMAIL`) e ele aparecer NATURALMENTE na fila (é assinante
 * elegível de verdade) — não força injeção de uma row extra por dia (isso
 * multiplicaria o seed por N dias; ver decisão documentada no PR #2775).
 */
export function outRow(r: StoreRow, name: string): Row {
  const isSeed = r.email.trim().toLowerCase() === CLARICE_SEED_EMAIL.toLowerCase();
  return {
    email: r.email,
    NOME: name,
    TIER: r.tier != null ? pad(r.tier) : "",
    IS_SEED: isSeed ? "true" : "",
  };
}

// ---------------------------------------------------------------------------
// Montagem por bloco (pura sobre a fila + o plano)
// ---------------------------------------------------------------------------

export interface BuiltDay {
  n: number;
  date: string;
  day: string;
  block: number;
  scheduledAt: string;
  volume: number;
  rows: Row[];
}

/**
 * Fatia `queue` (já ordenada por prioridade) consecutivamente por bloco
 * (rampa) e estratifica dentro de cada bloco pelos dias do plano.
 *
 * `queue` deve conter PELO MENOS a soma de volumes de `plan` — cada bloco
 * consome o próximo trecho da fila em ordem, então blocos requisitados fora
 * de ordem ainda avançam o cursor corretamente (mesma fila, mesmo offset
 * acumulado) desde que `plan` inclua TODOS os blocos que devem compartilhar
 * o mesmo cursor nesta chamada.
 *
 * #2915: desde o #2883, `queue` já vem DEDUPLICADA (exclui quem já foi
 * escrito em waves anteriores do ciclo — ver `excludeAlreadySentEmails`) —
 * ela não é mais o universo estável e completo que a docstring original
 * assumia. Por isso o CALLER (main()) passa aqui só os blocos EM ESCOPO
 * desta invocação (`plan.filter(p => blocks.includes(p.block))`), nunca o
 * plano inteiro do ciclo: blocos já processados em invocações anteriores NÃO
 * devem consumir nenhum item da fila deduplicada — os contatos já foram
 * atribuídos (e removidos da fila) nessa invocação anterior. Se um bloco fora
 * de escopo ainda fosse incluído aqui, seu "fatiar" consumiria do TOPO da
 * fila deduplicada (os contatos remanescentes de MAIOR prioridade) só pra
 * descartar o resultado — exatamente o bug que queimava o topo da fila e
 * pulava quem deveria ser priorizado (#2915).
 *
 * @param nameByEmail primeiro nome por email (personalização; "" se ausente)
 */
export function buildSends(
  queue: StoreRow[],
  plan: SendPlanEntry[],
  nameByEmail: Map<string, string>,
): BuiltDay[] {
  const blocks = planByBlock(plan);
  const totalNeeded = blocks.reduce((a, b) => a + b.total, 0);
  if (queue.length < totalNeeded) {
    throw new Error(
      `fila de prioridade insuficiente: blocos em escopo precisam de ${totalNeeded} contatos elegíveis, fila (após dedup) tem ${queue.length}.`,
    );
  }

  const out: BuiltDay[] = [];
  let offset = 0;
  for (const bp of blocks) {
    const blockSlice = queue.slice(offset, offset + bp.total);
    offset += bp.total;

    const dayVols = bp.sends.map((s) => s.volume);
    const fracs = dayVols.map((v) => v / bp.total);
    const caps = apportion(bp.total, fracs);
    const perDay = stratify<StoreRow>(blockSlice, caps);

    bp.sends.forEach((s, di) => {
      const rows = perDay[di].map((r) => outRow(r, nameByEmail.get(r.email) ?? ""));
      out.push({ n: s.n, date: s.date, day: s.day, block: s.block, scheduledAt: s.scheduledAt, volume: s.volume, rows });
    });
  }
  return out;
}

/** 1º nome p/ personalização (ex: "Azevedo, Ana" → "Azevedo"). */
function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/[\s,]+/)[0] || "";
}

/**
 * Merge cirúrgico (#495) entre a recomputação FRESCA (`freshSends`) e o
 * `sends-summary.json` pré-existente: dias cujo bloco está FORA de
 * `blocksInScope` nesta invocação preservam a entrada já gravada
 * anteriormente (com `listId` injetado por `clarice-import-sends`, se
 * houver) — não sobrescrevem com números frescos de um CSV que não foi
 * re-escrito agora.
 *
 * Sem isso, uma invocação parcial (ex: `--blocks 2,3` rodada depois de o
 * store ter mudado) reescreveria a entrada do bloco-célula com uma composição
 * que não bate mais com o CSV real já importado/agendado (drift silencioso).
 *
 * #2915: desde que `buildSends` passou a receber só o plano EM ESCOPO (ver
 * docstring de `buildSends`), `freshSends` também só cobre os blocos desta
 * invocação — não é mais garantido que todo `n` do ciclo apareça em
 * `freshSends`. Por isso o merge agora é uma UNIÃO por `n`: parte de
 * `prevSends` como base (preserva blocos já processados que não foram
 * recomputados agora) e sobrepõe `freshSends` — em escopo sempre vence
 * (fresco), fora de escopo só vence se não houver entrada prévia (1ª vez que
 * aquele bloco aparece, ex: fresh cobre um bloco novo além do pedido).
 *
 * Pura + exportada pra testabilidade (#633, #2775, #2915).
 */
export function mergeSummaryAcrossBlocks(
  freshSends: SendsSummaryEntry[],
  prevSends: SendsSummaryEntry[] | undefined,
  blocksInScope: number[],
): SendsSummaryEntry[] {
  const prevByN = new Map((prevSends ?? []).map((s) => [s.n, s]));
  const result = new Map<number, SendsSummaryEntry>(prevByN);
  for (const s of freshSends) {
    if (blocksInScope.includes(s.block) || !prevByN.has(s.n)) {
      result.set(s.n, s);
    }
  }
  return [...result.values()].sort((a, b) => a.n - b.n);
}

// ---------------------------------------------------------------------------
// Guard anti-duplo-envio POR CICLO (#2883) — dedup por CONTEÚDO, não posição
// ---------------------------------------------------------------------------
//
// `buildSends` fatia a fila CONSECUTIVAMENTE usando o plano inteiro como
// cursor posicional (ver docstring acima). Isso é robusto a invocações
// PARCIAIS (`--blocks`) do MESMO snapshot da fila, mas NÃO a invocações
// separadas no tempo: o build re-lê o store fresco a cada chamada, e se o
// store mudar entre a wave 1 e a wave 2 (sync do Brevo bump `sends_count`/
// `priority_points`, ou novos contatos importados), a fila reordena e o
// cursor posicional passa a apontar pra contatos DIFERENTES — overlap
// (duplo-envio) ou pulo silencioso.
//
// Fix: antes de fatiar, remover da fila qualquer contato cujo email já foi
// escrito num CSV de uma invocação ANTERIOR deste MESMO ciclo — dedup por
// CONTEÚDO do próprio output do ciclo, não por posição/offset. Mais robusto
// que checar `last_sent_at >= cycle_start` no store: os CSVs já existem no
// instante do build da wave seguinte, independente de o Brevo ter
// sincronizado o envio de volta (sends_count/last_sent_at podem levar
// horas/dias — a checagem por CSV não depende disso). `last_sent_at` fica
// como complemento OPCIONAL não implementado aqui (pegaria envios feitos
// fora do build, ex: reenvio manual) — não é o mecanismo primário.

/**
 * Nomes de arquivo (`d{NN}-{date}.csv`) que esta invocação vai (re)escrever —
 * derivado puramente do `plan` + `blocks` em escopo, sem depender da fila (não
 * precisa ter rodado `buildSends` ainda). Usado por `collectPriorCycleEmails`
 * pra não tratar o próprio output desta invocação como "wave anterior" (senão
 * reconstruir o MESMO bloco se auto-excluiria da fila).
 */
export function scopedSendFileNames(plan: SendPlanEntry[], blocks: number[]): Set<string> {
  return new Set(
    plan
      .filter((p) => blocks.includes(p.block))
      .map((p) => `d${String(p.n).padStart(2, "0")}-${p.date}.csv`),
  );
}

/**
 * Coleta os emails já escritos nos CSVs (`d{NN}-*.csv`) de invocações
 * ANTERIORES deste ciclo, ignorando os arquivos em `scopeFiles` (serão
 * regenerados NESTA invocação). Retorna vazio se `sendsDir` ainda não existe
 * (1ª invocação do ciclo — nada com que deduplicar). Emails normalizados
 * (trim + lowercase) pra comparação robusta a variação de caixa.
 *
 * Pura o suficiente pra testar com um `sendsDir` de tmpdir (não depende do
 * store/db) — exportada pra testabilidade (#633, #2883).
 */
export function collectPriorCycleEmails(sendsDir: string, scopeFiles: Set<string>): Set<string> {
  const emails = new Set<string>();
  if (!existsSync(sendsDir)) return emails;
  for (const f of readdirSync(sendsDir)) {
    if (!/^d\d{2}-.*\.csv$/.test(f) || scopeFiles.has(f)) continue;
    const parsed = Papa.parse<Row>(readFileSync(resolve(sendsDir, f), "utf8"), {
      header: true,
      skipEmptyLines: true,
    });
    for (const row of parsed.data) {
      if (row.email) emails.add(row.email.trim().toLowerCase());
    }
  }
  return emails;
}

/**
 * Filtra `queue` removendo linhas cujo email já foi designado numa wave
 * ANTERIOR do mesmo ciclo (`priorEmails`, ver `collectPriorCycleEmails`).
 * Preserva a ordem relativa dos remanescentes (a rampa/estratificação
 * downstream depende de `queue` já vir ordenada por prioridade). Pura.
 */
export function excludeAlreadySentEmails(queue: StoreRow[], priorEmails: Set<string>): StoreRow[] {
  if (priorEmails.size === 0) return queue;
  return queue.filter((r) => !priorEmails.has(r.email.trim().toLowerCase()));
}

// ---------------------------------------------------------------------------
// Guard de coerência de --cohort entre invocações do mesmo ciclo (#2851)
// ---------------------------------------------------------------------------

/**
 * Valida que o `--cohort` resolvido nesta invocação é coerente com o cohort
 * já gravado (top-level, `SendsSummary.cohort`) por invocações ANTERIORES do
 * MESMO ciclo. Pura + exportada pra testabilidade (#633).
 *
 * Por quê: a fila de prioridade é fatiada CONSECUTIVAMENTE por bloco usando o
 * plano inteiro como cursor (`buildSends`). `--cohort` muda o universo
 * (WHERE cohort = ? no SELECT) — logo muda composição/ordem/tamanho da fila.
 * Invocações mistas do mesmo ciclo (ex: bloco 1 com `--cohort junho`, bloco 2
 * sem `--cohort`) fatiariam o MESMO offset numérico de filas DIFERENTES →
 * overlap (envio duplicado) ou pulo, sem erro — o único guard pré-#2851 era
 * agregado (`queue.length < totalNeeded`), cego a identidade.
 *
 * @param hasPrevSummary `true` se `sends-summary.json` já existe pra este
 *                        ciclo (invocação NÃO é a 1ª). `false` = 1ª invocação
 *                        do ciclo — nada foi gravado ainda, qualquer
 *                        `resolvedCohort` é aceito sem checagem (nada com que
 *                        divergir). Distinguir de `prevCohort === undefined`
 *                        é o que resolve a ambiguidade "nunca rodou" vs
 *                        "rodou mas é legado sem o campo".
 * @param prevCohort     `SendsSummary.cohort` do `sends-summary.json` já
 *                        existente (só relevante quando `hasPrevSummary`):
 *                        - `undefined` → summary LEGADO (gravado antes do
 *                          #2851, campo nunca existiu).
 *                        - `null`      → campo gravado explicitamente como
 *                          "sem cohort" (invocação anterior pós-#2851 rodou
 *                          sem `--cohort`, base inteira).
 *                        - string      → campo gravado com uma safra
 *                          específica ('YYYY-MM').
 * @param resolvedCohort cohort desta invocação (`resolveCohortArg(...)`, ou
 *                        `null` se `--cohort` foi omitido).
 * @throws se houver divergência — mesmo padrão de mensagem clara da validação
 *         de `--cycle` (`requireCycleArg`/`isValidCycle`).
 *
 * ASSIMETRIA do caso legado (documentada — #2851): summary EXISTENTE sem o
 * campo (`hasPrevSummary && prevCohort === undefined`) não é o mesmo que "sem
 * cohort gravado explicitamente" (`null`). Sem o campo, não há garantia de
 * que os blocos já gravados rodaram sem filtro — mas essa é a única leitura
 * possível de um summary anterior ao #2851 (o filtro `--cohort` já existia
 * via #2817, porém sem ser persistido). Por isso:
 *   - legado (`undefined`) + invocação atual SEM `--cohort` (`null`) → OK,
 *     grava `null` e segue (retrocompat — nenhuma mudança de comportamento
 *     observável, pois nunca houve filtro).
 *   - legado (`undefined`) + invocação atual COM `--cohort` (string) → ABORTA.
 *     Presume-se (na ausência de qualquer registro) que os blocos já gravados
 *     rodaram SEM filtro (universo = base inteira) — aplicar `--cohort` agora
 *     fatiaria a partir de uma fila logicamente diferente da já processada,
 *     o mesmo risco de overlap/pulo que este guard existe pra prevenir.
 */
export function assertCohortConsistent(
  hasPrevSummary: boolean,
  prevCohort: string | null | undefined,
  resolvedCohort: string | null,
): void {
  if (!hasPrevSummary) return; // 1ª invocação do ciclo — nada gravado ainda, nada com que divergir.
  if (prevCohort === undefined) {
    if (resolvedCohort !== null) {
      throw new Error(
        `--cohort '${resolvedCohort}' divergente do ciclo já em andamento: o sends-summary.json existente é LEGADO ` +
          `(gravado antes do #2851, sem o campo 'cohort') — presume-se que os blocos já gravados rodaram SEM filtro de ` +
          `safra (universo = base inteira). Aplicar --cohort agora fatiaria a partir de uma fila diferente da já ` +
          `processada (overlap/pulo silencioso entre blocos). Regenere o ciclo do zero com --cohort desde a 1ª ` +
          `invocação, ou omita --cohort para manter consistência com os blocos já gravados.`,
      );
    }
    return; // legado + sem --cohort agora: grava o campo (null) e segue — retrocompat.
  }
  if (prevCohort !== resolvedCohort) {
    throw new Error(
      `--cohort divergente do ciclo já em andamento: sends-summary.json existente foi gravado com ` +
        `cohort=${JSON.stringify(prevCohort)}, esta invocação resolveu cohort=${JSON.stringify(resolvedCohort)}. ` +
        `Invocações do mesmo ciclo devem usar o MESMO --cohort (ou nenhum) — misturar filtros fatia filas ` +
        `diferentes pelo mesmo offset numérico e causa overlap/pulo silencioso entre blocos. Regenere o ciclo do ` +
        `zero (apague sends-summary.json e os CSVs) se quiser trocar de cohort. ` +
        `NOTA (#2857): se cohort=${JSON.stringify(prevCohort)} parece a MESMA safra que ${JSON.stringify(resolvedCohort)} ` +
        `só que sem o prefixo 'leads-' (ex: '2026-06' vs 'leads-2026-06'), essa divergência é ESPERADA uma única vez ` +
        `num ciclo cujos blocos anteriores rodaram antes da migração de taxonomia de cohorts (#2857 fase A, que trocou ` +
        `a coluna 'cohort' de safra crua pra slug nomeado) — o remédio ainda é regenerar o ciclo do zero, não ignorar o guard.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cycle = requireCycleArg(argv);
  const dryRun = hasFlag(argv, "dry-run");
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;

  const cycleDir = clariceCycleDir(cycle);
  const plan = loadSendPlan(cycleDir);
  const validBlocks = allBlocks(plan);
  const blocks = parseBlocksArg(argv, validBlocks);

  // #2817: --cohort restringe a fila de prioridade a uma safra mensal, aplicado
  // como WHERE no carregamento — a segmentação/estratificação downstream
  // (segmentFromStore/priorityQueue/buildSends) fica intocada.
  const cohortArg = getArg(argv, "cohort");
  const cohort = cohortArg ? resolveCohortArg(cohortArg) : null;

  // #2851: valida coerência de --cohort ANTES de tocar no store (fail-fast) —
  // ver assertCohortConsistent. summaryPath resolvido aqui e reaproveitado no
  // merge final (evita 2 leituras redundantes do mesmo arquivo pequeno).
  const summaryPath = sendsSummaryPath(cycleDir);
  let hasPrevSummary = false;
  let prevCohort: string | null | undefined;
  if (existsSync(summaryPath)) {
    try {
      const prev: { cohort?: string | null } = JSON.parse(readFileSync(summaryPath, "utf8"));
      prevCohort = prev.cohort;
      hasPrevSummary = true;
    } catch {
      // corrompido — tratado adiante (sobrescreve do zero, mesmo comportamento
      // do bloco de merge final); não é motivo pra bloquear o guard de cohort —
      // trata como se não houvesse summary prévio (hasPrevSummary fica false).
    }
  }
  assertCohortConsistent(hasPrevSummary, prevCohort, cohort);

  const db = openClariceDb(dbPath);
  let storeRows: (StoreRow & { name?: string | null })[];
  try {
    storeRows = db
      .prepare(
        `SELECT email, name, tier, cohort, priority_points, send_eligible, ineligible_reason, sends_count
           FROM clarice_users${cohort ? " WHERE cohort = ?" : ""}`,
      )
      .all(...(cohort ? [cohort] : [])) as unknown as (StoreRow & { name?: string | null })[];
  } finally {
    db.close();
  }

  if (cohort) {
    console.error(`🎯 filtro --cohort aplicado: cohort='${cohort}' (${storeRows.length} linha(s) no universo)`);
  }

  if (storeRows.length === 0) {
    throw new Error(
      cohort
        ? `0 contatos com cohort='${cohort}' — verifique se o store já foi rebuildado após o import da safra.`
        : "store vazio — rode clarice-build-db.ts + clarice-sync-brevo.ts antes.",
    );
  }

  const nameByEmail = new Map(storeRows.map((r) => [r.email, firstName(r.name)]));
  const seg = segmentFromStore(storeRows);
  const queue = priorityQueue(seg);

  console.error(
    `Fila de prioridade: ${queue.length} elegíveis (re-envio=${seg.reSend.length} 1º-envio=${seg.firstSend.length} excluídos=${seg.excluded.length})`,
  );

  // #2883: guard anti-duplo-envio POR CICLO — exclui da fila quem já foi
  // designado numa wave anterior deste ciclo (dedup por CONTEÚDO dos CSVs já
  // escritos, não pelo cursor posicional — robusto a drift do store entre
  // invocações). scopeFiles = arquivos que ESTA invocação vai (re)escrever,
  // pra não tratar o próprio output desta invocação como "wave anterior".
  const scopeFiles = scopedSendFileNames(plan, blocks);
  // ensureDir aqui (antes do dedup) é seguro: collectPriorCycleEmails trata um
  // sendsDir recém-criado/vazio como "sem waves anteriores".
  const sendsDir = ensureDir(resolve(cycleDir, "sends"));
  const priorEmails = collectPriorCycleEmails(sendsDir, scopeFiles);
  if (priorEmails.size > 0) {
    console.error(
      `🔒 dedup por ciclo (#2883): ${priorEmails.size} email(s) já enviados em wave(s) anterior(es) deste ciclo — excluídos da fila.`,
    );
  }
  const dedupedQueue = excludeAlreadySentEmails(queue, priorEmails);

  // #2915: só os blocos EM ESCOPO desta invocação entram no cursor de
  // buildSends — a fila já deduplicada (acima) não deve ser consumida por
  // blocos já processados em invocações anteriores (ver docstring de
  // buildSends). scopedPlan preserva a ordem/composição de `plan` (planByBlock
  // reordena por bloco ascendente internamente).
  const scopedPlan = plan.filter((p) => blocks.includes(p.block));
  const built = buildSends(dedupedQueue, scopedPlan, nameByEmail);
  const summary: { cycle: string; total: number; sends: SendsSummaryEntry[] } = {
    cycle,
    total: 0,
    sends: [],
  };

  for (const day of built) {
    const file = `d${String(day.n).padStart(2, "0")}-${day.date}.csv`;
    const comp: Record<string, number> = {};
    for (const r of day.rows) comp[r.TIER || "(sem tier)"] = (comp[r.TIER || "(sem tier)"] ?? 0) + 1;

    const entry: SendsSummaryEntry = {
      n: day.n,
      date: day.date,
      day: day.day,
      block: day.block,
      volume: day.volume,
      scheduledAt: day.scheduledAt,
      file,
      planned: day.volume,
      actual: day.rows.length,
      comp,
    };
    summary.sends.push(entry);
    summary.total += day.rows.length;

    console.error(
      `  ${file}  dia=${day.day} bloco=${day.block} plan=${day.volume} real=${day.rows.length}  ${JSON.stringify(comp)}${
        blocks.includes(day.block) ? "" : "  (fora de --blocks — não escrito)"
      }`,
    );

    if (!dryRun && blocks.includes(day.block)) {
      writeFileAtomic(
        resolve(sendsDir, file),
        Papa.unparse({ fields: ["email", "NOME", "TIER", "IS_SEED"], data: day.rows }),
      );
    }
  }

  if (!dryRun) {
    // Limpa CSVs de dias stale (ex: plano encolheu) que não constam mais do plano atual.
    const keep = new Set(built.filter((d) => blocks.includes(d.block)).map((d) => `d${String(d.n).padStart(2, "0")}-${d.date}.csv`));
    for (const f of readdirSync(sendsDir)) {
      if (/^d\d{2}-.*\.csv$/.test(f) && !keep.has(f)) {
        // Só remove arquivos de dias DENTRO dos blocos pedidos nesta invocação —
        // não mexe em CSVs de blocos que não fazem parte de `--blocks` (podem
        // ter sido escritos por uma invocação anterior e ainda ser válidos).
        const match = f.match(/^d(\d{2})-/);
        const n = match ? Number(match[1]) : null;
        const dayPlan = n != null ? built.find((d) => d.n === n) : undefined;
        if (dayPlan && blocks.includes(dayPlan.block)) {
          unlinkSync(resolve(sendsDir, f));
          console.error(`🧹 removido stale: ${f}`);
        }
      }
    }

    // Merge cirúrgico (#495) com sends-summary.json pré-existente — ver
    // mergeSummaryAcrossBlocks. Blocos fora de `--blocks` preservam a entrada já
    // gravada (com `listId`, se já importado); só os blocos pedidos são frescos.
    // (summaryPath já resolvido acima, reaproveitado do guard de --cohort.)
    let finalSends = summary.sends;
    if (existsSync(summaryPath)) {
      try {
        const prev: { sends?: SendsSummaryEntry[] } = JSON.parse(readFileSync(summaryPath, "utf8"));
        finalSends = mergeSummaryAcrossBlocks(summary.sends, prev.sends, blocks);
      } catch (e) {
        console.error(`⚠️  sends-summary.json existente corrompido (JSON inválido) — sobrescrevendo do zero: ${String(e)}`);
      }
    }
    const finalTotal = finalSends.reduce((a, s) => a + s.actual, 0);
    // #2851: cohort RESOLVIDO gravado top-level — guard de invocações futuras
    // (assertCohortConsistent) valida contra este campo.
    writeFileAtomic(summaryPath, JSON.stringify({ cycle, cohort, total: finalTotal, sends: finalSends }, null, 2));
    console.error(`\nTotal (blocos ${blocks.join(",")} desta invocação): ${summary.total}  ·  Total (ciclo inteiro, sends-summary.json): ${finalTotal}`);
  } else {
    console.error(`\nTotal (blocos ${blocks.join(",")} desta invocação): ${summary.total}`);
  }
  console.error(dryRun ? "(dry-run: nada escrito)" : `Escrito em ${sendsDir} (blocos: ${blocks.join(",")})`);
}

// CLI guard (#tests importam helpers sem disparar main)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("clarice-build-edition-sends.ts")) {
  main().catch((e) => {
    console.error(String(e?.stack || e));
    process.exit(1);
  });
}
