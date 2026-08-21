/**
 * build-origem-map.ts (#5235 Parte 2)
 *
 * `promoteBeehiivSubscription`/`activateSubscription` (via clique ou score,
 * ver `scripts/evaluate-brevo-diaria.ts` e `workers/reativar/src/index.ts`)
 * fazem DELETE+CREATE na subscription Beehiiv pra reativar um contato
 * Pending — e o CREATE novo sobrescreve `utm_source`/`utm_medium`/
 * `utm_campaign`/`referring_site` com os valores do próprio evento de
 * reativação (`BREVO_DIARIA_REATIVAR_CLIQUE_UTM`/`BREVO_DIARIA_PROMOCAO_SCORE_UTM`,
 * ambos `utm_source: "brevo-diaria"` — ver `scripts/lib/shared/utm-registry.ts`),
 * perdendo a origem de aquisição ORIGINAL do contato. #5231 (fechada
 * 17/08/2026) é o conserto IN-BAND da causa raiz — os dois call sites já
 * gravam a origem pré-overwrite no custom field `origem_original`
 * (`ORIGEM_ORIGINAL_FIELD_NAME`, `lib/shared/beehiiv-origem-original.ts`)
 * antes do CREATE. Este script lê esse campo quando presente (#5842) e só
 * cai pra reconstrução OFFLINE via arqueologia de snapshot quando ausente —
 * nunca chama a API Beehiiv, nenhuma escrita.
 *
 * Cruzando os snapshots semanais em `data/beehiiv-backup/` (task
 * `Diaria-Beehiiv-Backup`, #5229), a origem pré-overwrite é recuperável pra
 * quem foi capturado num backup ANTES da promoção: cada snapshot é uma
 * fotografia do `utm_source` daquele momento, então o snapshot mais antigo
 * em que um contato aparece com origem NÃO-promocional é a melhor
 * aproximação disponível da origem real de cadastro — mas só entra em jogo
 * quando o custom field `origem_original` não resolve o caso (passivo
 * histórico promovido antes da #5231, ou gate ainda desligado numa das duas
 * pontas — score/`helios` ou clique/Worker `reativar`).
 *
 * ## Precedência
 *
 * Pra cada email visto em qualquer snapshot:
 *   0. Se a aparição MAIS RECENTE traz um custom field `origem_original`
 *      bem formado (`extractOrigemOriginalField`) → PRECEDÊNCIA sobre tudo
 *      abaixo, mesmo que o `utm_source` dessa mesma aparição já seja
 *      promocional → `original: true` + `origem_original_field: true`.
 *   1. Senão, se a aparição MAIS RECENTE do email já tem origem
 *      não-promocional (no `utm_source` cru, sem passar pelo custom field)
 *      → nunca foi sobrescrito (ou o snapshot mais novo já é anterior a uma
 *      promoção futura) → `original: true`, usa os dados dessa aparição.
 *   2. Senão (aparição mais recente É promocional e sem custom field) →
 *      varre do snapshot mais ANTIGO pro mais novo e usa a PRIMEIRA
 *      aparição não-promocional → `recuperado: true`.
 *   3. Se NENHUMA aparição em NENHUM snapshot disponível é não-promocional
 *      → sem recuperação (o contato só foi capturado por um backup depois
 *      de já ter sido promovido) — fica de fora do mapa `origem`, mas entra
 *      em `unrecovered_emails` no relatório de cobertura.
 *
 * `original`/`recuperado` nunca coexistem no mesmo registro e todo registro
 * do mapa tem exatamente um dos dois — nunca misturado sem sinalizar qual é
 * qual (requisito explícito da issue original, #5235). `origem_original_field`
 * é um marcador adicional, só presente junto com `original: true`, pra
 * distinguir "nunca sobrescrito" (passo 1) de "origem preservada in-band
 * antes do overwrite" (passo 0) — ambos são a origem verdadeira, a
 * distinção é só de proveniência/observabilidade.
 *
 * ## CLI
 *
 *   npx tsx scripts/build-origem-map.ts [--root data/beehiiv-backup] [--out data/aquisicao/origem-original.json]
 *
 * Escreve `origem-original.json` (mapa `email → origem` + metadados de
 * cobertura) — leitura local apenas, nunca chama a API Beehiiv (guard de
 * publicação do overnight/develop).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, getStringArg } from "./lib/cli-args.ts";
import {
  listSnapshotDates,
  readSnapshotSubscribers,
  type BeehiivBackupSubscriber,
} from "./lib/beehiiv-backup-snapshots.ts";
import {
  BREVO_DIARIA_REATIVAR_CLIQUE_UTM,
  BREVO_DIARIA_PROMOCAO_SCORE_UTM,
} from "./lib/shared/utm-registry.ts";
import { ORIGEM_ORIGINAL_FIELD_NAME } from "./lib/shared/beehiiv-origem-original.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BACKUP_ROOT = resolve(ROOT, "data/beehiiv-backup");
export const DEFAULT_OUT_PATH = resolve(ROOT, "data/aquisicao/origem-original.json");

/** As duas vias de reativação (clique e score, #4530) compartilham
 *  `utm_source: "brevo-diaria"` de propósito (mesmo canal Pending) — ambas
 *  contam como "sobrescrito por promoção" pra fins deste mapa. Derivado do
 *  registry em vez de um literal solto — se um novo emissor de reativação
 *  nascer com `source` diferente, este set precisa crescer junto (o
 *  registry é a fonte única de verdade de UTM, ver `utm-registry.ts`). */
export const PROMOTIONAL_UTM_SOURCES: readonly string[] = Array.from(
  new Set([BREVO_DIARIA_REATIVAR_CLIQUE_UTM.source, BREVO_DIARIA_PROMOCAO_SCORE_UTM.source]),
);

export function isPromotionalUtmSource(
  source: string,
  promotionalSources: readonly string[] = PROMOTIONAL_UTM_SOURCES,
): boolean {
  return promotionalSources.includes(source);
}

// ---------------------------------------------------------------------------
// Núcleo puro — recebe snapshots já carregados, sem I/O
// ---------------------------------------------------------------------------

export interface SnapshotInput {
  /** `YYYY-MM-DD` */
  date: string;
  records: BeehiivBackupSubscriber[];
}

export interface OrigemEntry {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  referring_site: string;
  created: number;
  /** Snapshot de onde este registro veio — nunca "hoje"/live, sempre a data
   *  do backup usado. */
  snapshot_date: string;
  /** Presente (e `true`) quando a origem NUNCA foi sobrescrita — mutuamente
   *  exclusivo com `recuperado`. */
  original?: true;
  /** Presente (e `true`) quando a origem foi reconstruída de um snapshot
   *  anterior à promoção — mutuamente exclusivo com `original`. */
  recuperado?: true;
  /** Presente (e `true`) quando a origem veio do custom field
   *  `origem_original` (#5231/#5842) em vez de arqueologia de snapshot —
   *  sempre coexiste com `original: true` (é a origem verdadeira, gravada
   *  in-band no momento da promoção), nunca com `recuperado`. Campo extra
   *  só pra rastreabilidade/observabilidade — não muda a semântica de
   *  `original`/`recuperado`. */
  origem_original_field?: true;
}

export interface OrigemMapCoverage {
  snapshots_used: string[];
  promotional_utm_sources: string[];
  emails_seen_total: number;
  original_count: number;
  recovered_count: number;
  unrecovered_count: number;
  /** Subconjunto de `original_count` resolvido via custom field
   *  `origem_original` (#5842) em vez de "latest não-promocional" —
   *  observabilidade de quanto do teste 2608 já está protegido in-band. */
  origem_original_field_count: number;
}

export interface OrigemMapResult {
  coverage: OrigemMapCoverage;
  origem: Record<string, OrigemEntry>;
  /** Emails sem recuperação possível — presentes em algum snapshot, mas SÓ
   *  com origem promocional em todas as aparições observadas. Lista
   *  separada (não entra em `origem`) pra manter o invariante "todo
   *  registro de `origem` tem `original` OU `recuperado`". */
  unrecoveredEmails: string[];
}

/**
 * Extrai e desserializa o custom field `origem_original` (#5231) de um
 * registro de snapshot, se presente e bem formado. Formato de valor é o
 * JSON compacto de `formatOrigemOriginalValue` (`lib/shared/beehiiv-origem-original.ts`)
 * — chaves em ordem estável, subconjunto de `utm_source`/`utm_medium`/
 * `utm_campaign`/`referring_site`/`created`.
 *
 * Fail-soft, mesma disciplina de `extractSubscriptionOrigin`: `custom_fields`
 * ausente, campo não encontrado, valor não-string, JSON malformado, ou
 * `utm_source` ausente/vazio no payload decodificado → `null`, o caller cai
 * pro fallback de arqueologia de snapshot. `utm_source` é o único campo
 * exigido (mesmo mínimo de utilidade do `origem` reconstruído por
 * arqueologia — sem ele não há origem pra atribuir).
 */
export function extractOrigemOriginalField(
  record: BeehiivBackupSubscriber,
): Pick<OrigemEntry, "utm_source" | "utm_medium" | "utm_campaign" | "referring_site" | "created"> | null {
  const customFields = record.custom_fields;
  if (!Array.isArray(customFields)) return null;
  const entry = customFields.find((f) => f && f.name === ORIGEM_ORIGINAL_FIELD_NAME);
  if (!entry || typeof entry.value !== "string" || !entry.value) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.utm_source !== "string" || !p.utm_source) return null;

  return {
    utm_source: p.utm_source,
    utm_medium: typeof p.utm_medium === "string" ? p.utm_medium : "",
    utm_campaign: typeof p.utm_campaign === "string" ? p.utm_campaign : "",
    referring_site: typeof p.referring_site === "string" ? p.referring_site : "",
    created: typeof p.created === "number" && Number.isFinite(p.created) ? p.created : record.created,
  };
}

function toOrigemFields(rec: BeehiivBackupSubscriber, snapshotDate: string) {
  return {
    utm_source: rec.utm_source,
    utm_medium: rec.utm_medium,
    utm_campaign: rec.utm_campaign,
    referring_site: rec.referring_site,
    created: rec.created,
    snapshot_date: snapshotDate,
  };
}

/** Pure: monta o mapa de origem a partir de snapshots já em memória.
 *  `snapshots` não precisa vir pré-ordenado — é ordenado ascendente aqui por
 *  `date` antes de processar (defensivo: a precedência do passo 2 depende
 *  disso). */
export function buildOrigemMap(
  snapshots: SnapshotInput[],
  opts: { promotionalSources?: readonly string[] } = {},
): OrigemMapResult {
  const promotional = opts.promotionalSources ?? PROMOTIONAL_UTM_SOURCES;
  const sorted = [...snapshots].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // email → aparições em ordem ascendente de data
  const history = new Map<string, { date: string; record: BeehiivBackupSubscriber }[]>();
  for (const snap of sorted) {
    for (const record of snap.records) {
      const list = history.get(record.email);
      if (list) list.push({ date: snap.date, record });
      else history.set(record.email, [{ date: snap.date, record }]);
    }
  }

  const origem: Record<string, OrigemEntry> = {};
  const unrecoveredEmails: string[] = [];
  let originalCount = 0;
  let recoveredCount = 0;
  let origemOriginalFieldCount = 0;

  for (const [email, appearances] of history) {
    const latest = appearances[appearances.length - 1];

    // #5842: origem_original (custom field gravado in-band pelas duas vias
    // de promoção, #5231) tem PRECEDÊNCIA sobre a arqueologia de snapshot —
    // é a origem verdadeira mesmo quando o utm_source da aparição mais
    // recente já é promocional (`brevo-diaria`). Arqueologia só entra
    // quando o campo está ausente (passivo histórico, promovido antes da
    // #5231, ou gate ainda desligado numa das duas pontas).
    const fromField = extractOrigemOriginalField(latest.record);
    if (fromField) {
      origem[email] = { ...fromField, snapshot_date: latest.date, original: true, origem_original_field: true };
      originalCount++;
      origemOriginalFieldCount++;
      continue;
    }

    if (!isPromotionalUtmSource(latest.record.utm_source, promotional)) {
      origem[email] = { ...toOrigemFields(latest.record, latest.date), original: true };
      originalCount++;
      continue;
    }
    const earliestNonPromotional = appearances.find(
      (a) => !isPromotionalUtmSource(a.record.utm_source, promotional),
    );
    if (earliestNonPromotional) {
      origem[email] = {
        ...toOrigemFields(earliestNonPromotional.record, earliestNonPromotional.date),
        recuperado: true,
      };
      recoveredCount++;
    } else {
      unrecoveredEmails.push(email);
    }
  }

  return {
    coverage: {
      snapshots_used: sorted.map((s) => s.date),
      promotional_utm_sources: [...promotional],
      emails_seen_total: history.size,
      original_count: originalCount,
      recovered_count: recoveredCount,
      unrecovered_count: unrecoveredEmails.length,
      origem_original_field_count: origemOriginalFieldCount,
    },
    origem,
    unrecoveredEmails,
  };
}

// ---------------------------------------------------------------------------
// CLI — lê snapshots de disco, escreve o mapa
// ---------------------------------------------------------------------------

export interface BuildOrigemMapCliArgs {
  root: string;
  out: string;
}

export function parseBuildOrigemMapArgs(argv: string[]): BuildOrigemMapCliArgs {
  return {
    root: getStringArg(argv, "root") ?? DEFAULT_BACKUP_ROOT,
    out: getStringArg(argv, "out") ?? DEFAULT_OUT_PATH,
  };
}

export function loadSnapshots(root: string): SnapshotInput[] {
  return listSnapshotDates(root).map((date) => ({ date, records: readSnapshotSubscribers(root, date) }));
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseBuildOrigemMapArgs(argv);
  const snapshots = loadSnapshots(args.root);
  if (snapshots.length === 0) {
    console.error(`[build-origem-map] nenhum snapshot encontrado em ${args.root}`);
    process.exitCode = 1;
    return;
  }

  const result = buildOrigemMap(snapshots);

  const outDir = dirname(args.out);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(
    args.out,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        snapshot_root: args.root,
        ...result.coverage,
        unrecovered_emails: result.unrecoveredEmails,
        origem: result.origem,
      },
      null,
      2,
    ),
  );

  console.error(
    `[build-origem-map] snapshots=${result.coverage.snapshots_used.join(",")} ` +
      `emails=${result.coverage.emails_seen_total} original=${result.coverage.original_count} ` +
      `(origem_original_field=${result.coverage.origem_original_field_count}) ` +
      `recuperado=${result.coverage.recovered_count} sem_recuperacao=${result.coverage.unrecovered_count} ` +
      `→ ${args.out}`,
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
