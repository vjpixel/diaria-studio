#!/usr/bin/env node
/**
 * clarice-build-segment.ts (#2885) — grupos de envio NOMEADOS derivados do
 * store, fim do CSV hand-made como unidade de gestão.
 *
 * O store único (#2647) é a fonte única da verdade; um grupo de envio é um
 * PREDICADO sobre ele, re-derivado FRESCO a cada invocação — nunca um
 * snapshot congelado. Complementa `clarice-build-waves-store.ts` (a RAMPA —
 * fila engajado→1º envio→decaído, corte por `--budget`, pra crescer
 * alcance): este script cobre grupos por OBJETIVO (retenção, re-ativação,
 * 1º-envio-seguro), NÃO substitui a rampa.
 *
 * Grupos nomeados (predicados versionados/testados em
 * `scripts/lib/clarice-segment.ts`, ao lado de `segmentFromStore` — ver
 * `NAMED_GROUPS`):
 *   - `engajados`   (retenção)  = send_eligible=1 AND sends_count>0 AND
 *                     priority_points>0, ordem priority_points DESC.
 *                     Exclui internos (#2809).
 *   - `reativacao`              = send_eligible=1 AND sends_count>0 AND
 *                     opens_count=0, ordem last_sent_at DESC (não-abridores
 *                     mais recentes primeiro). Exclui internos (#2809).
 *   - `ramp-warm`   (1º envio seguro) = send_eligible=1 AND sends_count=0 AND
 *                     mv_bucket='verified', ordem cohortSendRank (morno→frio).
 *                     NÃO exclui internos (não pedido pela #2885 — este grupo
 *                     é sobre segurança de 1º contato, não retenção/reativação).
 *
 * SEGURANÇA: só ESCREVE CSV+manifest LOCAIS — não envia nada. O envio segue
 * gated no import (`clarice-import-waves.ts --group {group}`, #2916 —
 * dry-run por padrão) + schedule (manual). `--dry-run` aqui só imprime o
 * plano sem escrever.
 *
 * Uso:
 *   npx tsx scripts/clarice-build-segment.ts --group engajados --cycle 2606-07 [--budget N] [--min-score N] [--dry-run]
 *   --group X    OBRIGATÓRIO — um dos grupos nomeados (ver NAMED_GROUPS em clarice-segment.ts).
 *   --cycle X    OBRIGATÓRIO — {conteúdo}-{envio} (destino dos artefatos, ver clarice-paths.ts).
 *   --budget N   OPCIONAL (>0) — teto do grupo; pega o TOPO da ordem (pós-sort).
 *                Sem a flag, o grupo inteiro é escrito.
 *   --min-score N / --score N   OPCIONAL (#2973 — "score" é o termo do editor
 *                pro dia a dia, alias puro de `priority_points`; NÃO reintroduz
 *                o `score`/`OPEN_PROBABILITY` legado removido em #2647, que
 *                segue morto). Exclui contatos com `priority_points < N` ANTES
 *                do sort/budget do grupo. `--score` é apenas um atalho pro
 *                mesmo valor de `--min-score` (o editor pode usar qualquer um
 *                dos dois nomes); se ambos forem passados, `--min-score` vence.
 *                Sem a flag, nenhum corte por score é aplicado (comportamento
 *                inalterado).
 *   --dry-run    só conta/imprime o plano, nada escrito.
 *
 * Outputs (em data/clarice-subscribers/{conteúdo}-{envio}/segments/):
 *   {group}.csv              (colunas: email,NOME — compatível com clarice-import-waves)
 *   {group}-manifest.json    ([{ key, file, desc, count }], mesmo shape de waves-manifest.json)
 *   sent-or-queued.json      (#3227 — ÚNICO por ciclo, não por grupo; ver guard abaixo. Não
 *                             escrito em --dry-run.)
 *
 * #2916: `clarice-import-waves.ts` (que só lia `waves/waves-manifest.json` da
 * rampa) foi generalizado com a flag `--group {group}` — quando informada, lê
 * `segments/{group}-manifest.json` (este script) em vez de `waves/`. Sem essa
 * flag no import, o output deste script fica órfão (ninguém consome) — SEMPRE
 * passar `--group` no import de um grupo nomeado:
 *   npx tsx scripts/clarice-import-waves.ts --cycle 2606-07 --group engajados --label "Retenção Jun/2026"            # dry-run
 *   npx tsx scripts/clarice-import-waves.ts --cycle 2606-07 --group engajados --label "Retenção Jun/2026" --execute  # cria + importa
 *
 * Guard anti-duplo-envio POR CICLO (#2883, generalizado em #3227): o
 * mecanismo original (`collectPriorCycleEmails`/`excludeAlreadySentEmails` em
 * `clarice-build-edition-sends.ts`) é acoplado à convenção de arquivo da
 * RAMPA (`d{NN}-{date}.csv` dentro de `{ciclo}/sends/`) e ao cursor posicional
 * do plano de blocos — não se aplica limpo aqui (diretório diferente,
 * convenção de nome diferente, sem plano de blocos). Este script tem o seu
 * PRÓPRIO guard, equivalente em espírito mas de mecanismo mais simples:
 * `sent-or-queued.json`, um arquivo ÚNICO por ciclo (não por grupo — ver
 * `sentOrQueuedFilePath`) em `{ciclo}/segments/`, que acumula os emails
 * SELECIONADOS por CADA invocação `--group` bem-sucedida (independente de já
 * ter sido importado no Brevo). Toda invocação, automaticamente (sem flag —
 * #3227, decisão do editor: "sem flag manual, mais seguro contra
 * esquecimento"):
 *   1. LÊ o arquivo (se existir) e exclui do universo quem já está lá, ANTES
 *      de `buildSegmentArtifact` (`loadSentOrQueuedEmails` + `excludeSentOrQueued`).
 *   2. Após escrita bem-sucedida (não-dry-run), ACRESCENTA os emails
 *      recém-selecionados (`appendSentOrQueuedEmails`).
 * CICLO-WIDE por design (não por-grupo): rodar `engajados` e depois
 * `ramp-warm` no mesmo ciclo também deduplica entre os dois — um contato
 * pode aparecer em ambos os predicados (ex: sai de `ramp-warm` após o 1º
 * envio) e a mesma pessoa não deveria ser re-selecionada só porque o GRUPO
 * mudou. `--dry-run` só LÊ (pra refletir no preview), nunca ESCREVE (mesma
 * convenção do resto do script: dry-run não muta estado).
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import {
  NAMED_GROUPS,
  isNamedGroupKey,
  type NamedGroupKey,
  type StoreRow,
} from "./lib/clarice-segment.ts";
import { clariceSegmentsDir, ensureDir, requireCycleArg } from "./lib/clarice-paths.ts";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";

export interface SegmentRow extends StoreRow {
  name: string | null;
}

export interface SegmentManifestEntry {
  key: string;
  file: string;
  desc: string;
  count: number;
}

/** 1º nome p/ personalização (ex: "Azevedo, Ana" → "Azevedo"). Mesma convenção
 *  de `clarice-build-waves-store.ts`/`clarice-build-edition-sends.ts`. */
function firstName(name: string | null): string {
  return (name ?? "").trim().split(/[\s,]+/)[0] || "";
}

/**
 * Monta o CSV + manifest do grupo (puro: retorna os artefatos, não escreve).
 * `budget > 0` corta o TOPO da fila já filtrada+ordenada por `NAMED_GROUPS[group].segment`
 * (não uma fatia arbitrária — o corte acontece DEPOIS do sort).
 */
export function buildSegmentArtifact(
  rows: SegmentRow[],
  group: NamedGroupKey,
  budget: number,
  minScore = 0,
): { csv: string; manifestEntry: SegmentManifestEntry; selected: SegmentRow[] } {
  const def = NAMED_GROUPS[group];
  const nameByEmail = new Map(rows.map((r) => [r.email, firstName(r.name)]));
  // #2973: "score" = alias do editor pra `priority_points` (NÃO o score/
  // OPEN_PROBABILITY legado morto em #2647). Corte ANTES do sort/budget do
  // predicado do grupo — quem não bate o piso nunca entra na ordenação.
  const scoped = minScore > 0 ? rows.filter((r) => (r.priority_points ?? 0) >= minScore) : rows;
  // `def.segment` filtra+ordena preservando a IDENTIDADE dos objetos de `rows`
  // (não clona) — o cast de volta pra SegmentRow[] é seguro porque cada
  // elemento retornado É um dos objetos de `rows` (que já são SegmentRow).
  const ordered = def.segment(scoped) as SegmentRow[];
  const selected = budget > 0 ? ordered.slice(0, budget) : ordered;

  const csvRows = selected.map((r) => ({ email: r.email, NOME: nameByEmail.get(r.email) ?? "" }));
  const file = `${group}.csv`;
  const csv = Papa.unparse({ fields: ["email", "NOME"], data: csvRows });
  const manifestEntry: SegmentManifestEntry = { key: group, file, desc: def.label, count: selected.length };

  return { csv, manifestEntry, selected };
}

// ---------------------------------------------------------------------------
// Guard anti-duplo-envio POR CICLO (#3227) — sent-or-queued.json
// ---------------------------------------------------------------------------
//
// Arquivo ÚNICO por ciclo (irmão dos `{group}.csv`/`{group}-manifest.json`,
// mesmo diretório `clariceSegmentsDir(cycle)`), CICLO-WIDE: qualquer grupo
// nomeado que já selecionou um email neste ciclo aparece aqui, não importa
// QUAL grupo — ver docstring do topo do arquivo pro raciocínio completo.

export interface SentOrQueuedHistoryEntry {
  group: NamedGroupKey;
  /** Quantidade de emails NOVOS adicionados por esta entrada (não cumulativo). */
  count: number;
  /** ISO timestamp da invocação que gravou esta entrada. */
  at: string;
}

export interface SentOrQueuedFile {
  cycle: string;
  /** Emails normalizados (trim + lowercase), únicos, ordem alfabética (determinístico). */
  emails: string[];
  /** Uma entrada por invocação bem-sucedida (não-dry-run) que gravou artefato. */
  history: SentOrQueuedHistoryEntry[];
}

/** Caminho do arquivo de tracking cycle-wide (`{ciclo}/segments/sent-or-queued.json`). */
export function sentOrQueuedFilePath(segmentsDir: string): string {
  return resolve(segmentsDir, "sent-or-queued.json");
}

/**
 * Lê `sent-or-queued.json` de `segmentsDir` e devolve o Set de emails já
 * rastreados (normalizados trim+lowercase, mesmo padrão de
 * `collectPriorCycleEmails`/`excludeAlreadySentEmails` em
 * `clarice-build-edition-sends.ts`). Tolerante: arquivo ausente, JSON
 * corrompido, ou shape inesperado (`emails` não é array) → Set vazio (nunca
 * lança) — dado ruim aqui vira "nada rastreado ainda", não derruba o build.
 * Só LEITURA — seguro chamar mesmo em `--dry-run` (não cria o diretório nem
 * o arquivo).
 */
export function loadSentOrQueuedEmails(segmentsDir: string): Set<string> {
  const file = sentOrQueuedFilePath(segmentsDir);
  if (!existsSync(file)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SentOrQueuedFile>;
    if (!Array.isArray(parsed.emails)) return new Set();
    return new Set(parsed.emails.map((e) => String(e).trim().toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * Filtra `rows` removendo quem já está em `sentOrQueued` (comparação
 * normalizada trim+lowercase). Preserva a ordem relativa dos remanescentes.
 * Pura — mesmo padrão de `excludeAlreadySentEmails`.
 */
export function excludeSentOrQueued<T extends { email: string }>(
  rows: T[],
  sentOrQueued: ReadonlySet<string>,
): T[] {
  if (sentOrQueued.size === 0) return rows;
  return rows.filter((r) => !sentOrQueued.has(r.email.trim().toLowerCase()));
}

/**
 * Acrescenta `newEmails` ao `sent-or-queued.json` de `segmentsDir` (união com
 * o que já existe — nunca remove), registra uma entrada de `history`, e
 * escreve de volta. Cria `segmentsDir` se faltar (mesmo padrão de
 * `ensureDir` usado pelo resto do script). Chamar SOMENTE após escrita
 * bem-sucedida (não-dry-run) — `main()` é responsável por não chamar esta
 * função em `--dry-run`.
 */
export function appendSentOrQueuedEmails(
  segmentsDir: string,
  cycle: string,
  group: NamedGroupKey,
  newEmails: string[],
): void {
  ensureDir(segmentsDir);
  const file = sentOrQueuedFilePath(segmentsDir);
  let existingEmails: string[] = [];
  let history: SentOrQueuedHistoryEntry[] = [];
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SentOrQueuedFile>;
      if (Array.isArray(parsed.emails)) existingEmails = parsed.emails.map((e) => String(e));
      if (Array.isArray(parsed.history)) history = parsed.history;
    } catch {
      // JSON corrompido — recomeça do zero em vez de travar o build (mesma
      // postura tolerante de loadSentOrQueuedEmails).
    }
  }
  const emailSet = new Set(existingEmails.map((e) => e.trim().toLowerCase()));
  const normalizedNew = newEmails.map((e) => e.trim().toLowerCase());
  for (const e of normalizedNew) emailSet.add(e);

  const merged: SentOrQueuedFile = {
    cycle,
    emails: [...emailSet].sort(),
    history: [...history, { group, count: normalizedNew.length, at: new Date().toISOString() }],
  };
  writeFileSync(file, JSON.stringify(merged, null, 2), "utf8");
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const cycle = requireCycleArg(argv);
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;

  const groupArg = getArg(argv, "group");
  if (!groupArg || !isNamedGroupKey(groupArg)) {
    console.error(
      `❌ --group é obrigatório — um dos grupos nomeados: ${Object.keys(NAMED_GROUPS).join(", ")}. ` +
        `Ex: --group engajados.`,
    );
    process.exit(1);
  }
  const group: NamedGroupKey = groupArg;

  // --budget é OPCIONAL (diferente de clarice-build-waves-store.ts, onde é
  // obrigatório): sem a flag, o grupo inteiro (já filtrado pelo predicado) é
  // escrito — o predicado JÁ é o corte de blast-radius (ex: `reativacao` só
  // pega quem nunca abriu, não a base inteira).
  const budgetArg = getArg(argv, "budget");
  let budget = 0;
  if (budgetArg) {
    const n = Number(budgetArg);
    if (!Number.isFinite(n) || n <= 0) {
      console.error("❌ --budget precisa ser um número > 0 (omita a flag pra não ter teto).");
      process.exit(1);
    }
    budget = n;
  }

  // #2973: --min-score / --score são ALIASES do mesmo corte (score := priority_points,
  // vocabulário do editor no dia a dia — não o score/OPEN_PROBABILITY legado morto em #2647).
  // --min-score vence se ambos forem passados.
  const minScoreArg = getArg(argv, "min-score") || getArg(argv, "score");
  let minScore = 0;
  if (minScoreArg) {
    const n = Number(minScoreArg);
    if (!Number.isFinite(n)) {
      console.error("❌ --min-score/--score precisa ser um número (omita a flag pra não ter piso).");
      process.exit(1);
    }
    minScore = n;
  }

  const dryRun = hasFlag(argv, "dry-run");

  const db = openClariceDb(dbPath);
  const rows = db
    .prepare(
      `SELECT email, name, tier, cohort, priority_points, send_eligible, ineligible_reason, sends_count,
              opens_count, last_sent_at, mv_bucket
         FROM clarice_users`,
    )
    .all() as unknown as SegmentRow[];
  db.close();

  if (rows.length === 0) {
    console.error("❌ store vazio — rode clarice-build-db.ts + clarice-sync-brevo.ts antes.");
    process.exit(1);
  }

  // #3227: guard anti-duplo-envio POR CICLO — exclui do universo quem já foi
  // SELECIONADO por qualquer grupo nomeado (não só este `group`) neste mesmo
  // ciclo, ANTES do predicado/sort/budget de buildSegmentArtifact. Automático
  // (sem flag), inclusive em --dry-run (só LEITURA aqui — nunca escreve).
  const segDir = clariceSegmentsDir(cycle);
  const sentOrQueued = loadSentOrQueuedEmails(segDir);
  const universe = excludeSentOrQueued(rows, sentOrQueued);
  const alreadyTracked = rows.length - universe.length;
  if (alreadyTracked > 0) {
    console.error(
      `🔒 dedup por ciclo (#3227): ${alreadyTracked} contato(s) já selecionado(s) por outra invocação de grupo nomeado neste ciclo — excluído(s) do universo.`,
    );
  }

  const { csv, manifestEntry, selected } = buildSegmentArtifact(universe, group, budget, minScore);

  const summary = {
    cycle,
    group,
    label: NAMED_GROUPS[group].label,
    source: "store-driven, grupo nomeado (#2885)",
    budget: budget || undefined,
    min_score: minScore || undefined,
    universe_total: rows.length,
    already_sent_or_queued: alreadyTracked || undefined,
    selected: manifestEntry.count,
  };

  if (manifestEntry.count === 0) {
    console.error(
      `❌ 0 contato(s) no grupo '${group}' — verifique o predicado (send_eligible/histórico/mv_bucket) contra o store, ou se todo o universo elegível já foi selecionado por outra invocação deste ciclo (${alreadyTracked} excluído(s) via sent-or-queued.json). Nada escrito.`,
    );
    process.exit(1);
  }

  if (!dryRun) {
    const dir = segDir;
    ensureDir(dir);
    writeFileSync(resolve(dir, manifestEntry.file), csv, "utf8");
    writeFileSync(
      resolve(dir, `${group}-manifest.json`),
      JSON.stringify([manifestEntry], null, 2),
      "utf8",
    );
    appendSentOrQueuedEmails(dir, cycle, group, selected.map((r) => r.email));
    console.error(`✅ ${manifestEntry.count} contato(s) do grupo '${group}' em ${resolve(dir, manifestEntry.file)}`);
  } else {
    console.error(`ℹ️  dry-run — nada escrito. ${manifestEntry.count} contato(s) no grupo '${group}'.`);
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}
