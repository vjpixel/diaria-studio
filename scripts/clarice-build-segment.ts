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
 *   npx tsx scripts/clarice-build-segment.ts --group engajados --cycle 2606-07 [--budget N] [--dry-run]
 *   --group X    OBRIGATÓRIO — um dos grupos nomeados (ver NAMED_GROUPS em clarice-segment.ts).
 *   --cycle X    OBRIGATÓRIO — {conteúdo}-{envio} (destino dos artefatos, ver clarice-paths.ts).
 *   --budget N   OPCIONAL (>0) — teto do grupo; pega o TOPO da ordem (pós-sort).
 *                Sem a flag, o grupo inteiro é escrito.
 *   --dry-run    só conta/imprime o plano, nada escrito.
 *
 * Outputs (em data/clarice-subscribers/{conteúdo}-{envio}/segments/):
 *   {group}.csv              (colunas: email,NOME — compatível com clarice-import-waves)
 *   {group}-manifest.json    ([{ key, file, desc, count }], mesmo shape de waves-manifest.json)
 *
 * #2916: `clarice-import-waves.ts` (que só lia `waves/waves-manifest.json` da
 * rampa) foi generalizado com a flag `--group {group}` — quando informada, lê
 * `segments/{group}-manifest.json` (este script) em vez de `waves/`. Sem essa
 * flag no import, o output deste script fica órfão (ninguém consome) — SEMPRE
 * passar `--group` no import de um grupo nomeado:
 *   npx tsx scripts/clarice-import-waves.ts --cycle 2606-07 --group engajados --label "Retenção Jun/2026"            # dry-run
 *   npx tsx scripts/clarice-import-waves.ts --cycle 2606-07 --group engajados --label "Retenção Jun/2026" --execute  # cria + importa
 *
 * Guard anti-duplo-envio POR CICLO (#2883): o mecanismo existente
 * (`collectPriorCycleEmails`/`excludeAlreadySentEmails` em
 * `clarice-build-edition-sends.ts`) é acoplado à convenção de arquivo da
 * RAMPA (`d{NN}-{date}.csv` dentro de `{ciclo}/sends/`) e ao cursor posicional
 * do plano de blocos — não se aplica limpo aqui (diretório diferente,
 * convenção de nome diferente, sem plano de blocos). NÃO foi replicado neste
 * script (fora de escopo da #2885, ver PR) — segue como FOLLOW-UP: grupos por
 * objetivo hoje podem se sobrepor entre invocações do mesmo ciclo (ex: rodar
 * `engajados` duas vezes no mesmo ciclo não exclui quem já foi escrito na
 * 1ª). Generalizar o guard (ex: um `sendsDir`/glob configurável) fica pra uma
 * issue própria quando o editor operar múltiplos grupos no mesmo ciclo.
 */

import { writeFileSync } from "node:fs";
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
import { getArg, hasFlag } from "./lib/cli-args.ts";

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
): { csv: string; manifestEntry: SegmentManifestEntry; selected: SegmentRow[] } {
  const def = NAMED_GROUPS[group];
  const nameByEmail = new Map(rows.map((r) => [r.email, firstName(r.name)]));
  // `def.segment` filtra+ordena preservando a IDENTIDADE dos objetos de `rows`
  // (não clona) — o cast de volta pra SegmentRow[] é seguro porque cada
  // elemento retornado É um dos objetos de `rows` (que já são SegmentRow).
  const ordered = def.segment(rows) as SegmentRow[];
  const selected = budget > 0 ? ordered.slice(0, budget) : ordered;

  const csvRows = selected.map((r) => ({ email: r.email, NOME: nameByEmail.get(r.email) ?? "" }));
  const file = `${group}.csv`;
  const csv = Papa.unparse({ fields: ["email", "NOME"], data: csvRows });
  const manifestEntry: SegmentManifestEntry = { key: group, file, desc: def.label, count: selected.length };

  return { csv, manifestEntry, selected };
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

  const { csv, manifestEntry } = buildSegmentArtifact(rows, group, budget);

  const summary = {
    cycle,
    group,
    label: NAMED_GROUPS[group].label,
    source: "store-driven, grupo nomeado (#2885)",
    budget: budget || undefined,
    universe_total: rows.length,
    selected: manifestEntry.count,
  };

  if (manifestEntry.count === 0) {
    console.error(
      `❌ 0 contato(s) no grupo '${group}' — verifique o predicado (send_eligible/histórico/mv_bucket) contra o store. Nada escrito.`,
    );
    process.exit(1);
  }

  if (!dryRun) {
    const dir = clariceSegmentsDir(cycle);
    ensureDir(dir);
    writeFileSync(resolve(dir, manifestEntry.file), csv, "utf8");
    writeFileSync(
      resolve(dir, `${group}-manifest.json`),
      JSON.stringify([manifestEntry], null, 2),
      "utf8",
    );
    console.error(`✅ ${manifestEntry.count} contato(s) do grupo '${group}' em ${resolve(dir, manifestEntry.file)}`);
  } else {
    console.error(`ℹ️  dry-run — nada escrito. ${manifestEntry.count} contato(s) no grupo '${group}'.`);
  }
  console.log(JSON.stringify(summary, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
