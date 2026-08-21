/**
 * cac-report.ts (#5236 Parte 2)
 *
 * Relatório de custo por leitor por canal — a peça que fecha a camada de
 * dados de aquisição (#5235 definiu `leitor-v1` + mapa de origem
 * recuperada; este script cruza os dois com `data/aquisicao/spend.csv` e
 * ranqueia).
 *
 * **Só leitura local — nunca chama a API Beehiiv/Google Ads/LinkedIn ao
 * vivo** (guard de publicação do overnight/develop). Toda a computação real
 * mora em `scripts/lib/cac.ts` (puro, testável sem I/O); este arquivo só
 * carrega os 3 insumos do disco, chama `buildCacReport`, formata e registra.
 *
 * ## Insumos
 *
 * 1. Snapshot mais recente de `data/beehiiv-backup/{YYYY-MM-DD}/subscribers.jsonl`
 *    (task `Diaria-Beehiiv-Backup`, #5229) — `--snapshot` pra outra data.
 * 2. `data/aquisicao/origem-original.json` (opcional — `scripts/build-origem-map.ts`,
 *    #5235). Sem ele, o relatório roda com o `utm_source` CRU do snapshot
 *    (aviso explícito no output, nunca silencioso) — cadastros reativados
 *    via `brevo-diaria` (#4530) vão aparecer como esse canal em vez da
 *    origem original.
 * 3. `data/aquisicao/spend.csv` (#5236 Parte 1) — `--spend` pra outro path;
 *    `npx tsx scripts/seed-spend-csv.ts` cria o seed inicial se ausente.
 *
 * ## Uso
 *
 *   npx tsx scripts/cac-report.ts
 *   npx tsx scripts/cac-report.ts --json
 *   npx tsx scripts/cac-report.ts --snapshot 2026-08-14 --no-register
 *
 * Exit codes: 0 = sucesso; 1 = insumo obrigatório ausente/ilegível (spend.csv
 * ou snapshot).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, hasFlag, getStringArg } from "./lib/cli-args.ts";
import {
  latestSnapshotDate,
  listSnapshotDates,
  readSnapshotSubscribers,
  type BeehiivBackupSubscriber,
} from "./lib/beehiiv-backup-snapshots.ts";
import { readSpendCsv, type SpendRow, type SpendRowError } from "./lib/aquisicao-spend.ts";
import {
  buildCacReport,
  filterInternalAndTestSubscribers,
  applyOrigemOverride,
  buildNormalizedOrigemIndex,
  computeMonthBudgetUsage,
  MONTHLY_BUDGET_FLOOR_BRL,
  CHANNEL_GROUP_KEYS,
  type CacReport,
  type CacRow,
  type OrigemEntryFields,
} from "./lib/cac.ts";
import {
  parseSinceToEpochSeconds,
  parseUntilToEpochSecondsExclusive,
  resolveWindowGuardError,
  type CohortWindow,
} from "./cohort-engagement.ts";
import { registerReport, reportId } from "./studio-ui/studio-reports.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BACKUP_ROOT = resolve(ROOT, "data", "beehiiv-backup");
export const DEFAULT_SPEND_CSV_PATH = resolve(ROOT, "data", "aquisicao", "spend.csv");
export const DEFAULT_ORIGEM_MAP_PATH = resolve(ROOT, "data", "aquisicao", "origem-original.json");

// ---------------------------------------------------------------------------
// Carregamento de insumos (I/O — não testado como pure, ver cac.test.ts pro
// núcleo puro e studio-ads.test.ts pra fixture-based end-to-end)
// ---------------------------------------------------------------------------

interface OrigemMapFile {
  origem?: Record<string, OrigemEntryFields>;
}

export function loadOrigemIndex(path: string): { index: Map<string, OrigemEntryFields>; applied: boolean } {
  if (!existsSync(path)) {
    console.error(
      `[cac-report] aviso: mapa de origem ausente (${path}) — usando utm_source cru do snapshot. ` +
        `Rode "npx tsx scripts/build-origem-map.ts" pra reconstruir a origem recuperada (#5235).`,
    );
    return { index: new Map(), applied: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as OrigemMapFile;
    return { index: buildNormalizedOrigemIndex(parsed.origem ?? {}), applied: true };
  } catch (e) {
    console.error(`[cac-report] aviso: falha ao ler mapa de origem (${path}): ${(e as Error).message} — usando utm_source cru.`);
    return { index: new Map(), applied: false };
  }
}

export function loadPreparedSubscribers(
  root: string,
  date: string,
  origemIndex: Map<string, OrigemEntryFields>,
): { subs: BeehiivBackupSubscriber[]; internalFiltered: number } {
  const raw = readSnapshotSubscribers(root, date);
  const overridden = applyOrigemOverride(raw, origemIndex);
  const { kept, removedCount } = filterInternalAndTestSubscribers(overridden);
  return { subs: kept, internalFiltered: removedCount };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CacReportCliArgs {
  backupRoot: string;
  spendPath: string;
  origemPath: string;
  snapshotDate: string | null;
  json: boolean;
  register: boolean;
  /** `--desde AAAA-MM-DD` cru, como passado — `null` = sem borda inferior (#5495). */
  desde: string | null;
  /** `--ate AAAA-MM-DD` cru, como passado (INCLUSIVO — o dia inteiro entra) — `null` = sem borda superior. */
  ate: string | null;
  /** `--strict` (#5860): quando `true`, gasto não atribuído (`report.unattributedSpend`
   *  não-vazio) vira exit code 1 em vez do default 0 — acionável no momento
   *  em que acontece (cron/task agendada falha visivelmente), não só um
   *  aviso em stderr de uma execução antiga que ninguém vai reler. Default
   *  `false` pra não quebrar callers/tasks existentes que já toleram gasto
   *  não atribuído como aviso — opt-in deliberado (a issue permite as duas
   *  formas: exit code sempre diferente de 0, OU uma flag que force isso). */
  strict: boolean;
}

export function parseCacReportArgs(argv: string[]): CacReportCliArgs {
  return {
    backupRoot: getStringArg(argv, "root") ?? DEFAULT_BACKUP_ROOT,
    spendPath: getStringArg(argv, "spend") ?? DEFAULT_SPEND_CSV_PATH,
    origemPath: getStringArg(argv, "origem") ?? DEFAULT_ORIGEM_MAP_PATH,
    snapshotDate: getStringArg(argv, "snapshot") ?? null,
    json: hasFlag(argv, "json"),
    register: !hasFlag(argv, "no-register"),
    desde: getStringArg(argv, "desde") ?? null,
    ate: getStringArg(argv, "ate") ?? null,
    strict: hasFlag(argv, "strict"),
  };
}

/** Resolve `--desde`/`--ate` crus (strings AAAA-MM-DD) numa `CohortWindow`
 *  epoch, reusando os parsers/guard de `cohort-engagement.ts` (#5495 —
 *  "reusar filterWindow, nunca reimplementar" vale igual pro parsing da
 *  janela). Lança com a mesma mensagem de erro do CLI de `cohort-engagement.ts`
 *  se o formato for inválido ou `--desde` vier depois de `--ate`. `null`
 *  quando nenhuma das duas flags foi passada (sem janela). */
export function resolveCacReportWindow(args: Pick<CacReportCliArgs, "desde" | "ate">): CohortWindow | null {
  if (args.desde == null && args.ate == null) return null;
  const since = args.desde != null ? parseSinceToEpochSeconds(args.desde) : null;
  const untilExclusive = args.ate != null ? parseUntilToEpochSecondsExclusive(args.ate) : null;
  const guardError = resolveWindowGuardError({ since, untilExclusive }, { since: args.desde, until: args.ate });
  if (guardError) throw new Error(`[cac-report] ${guardError}`);
  return { since, untilExclusive };
}

function fmtPct(frac: number | null): string {
  if (frac == null) return "—";
  return `${(frac * 100).toFixed(1)}%`;
}

function fmtBrl(n: number | null): string {
  if (n == null) return "—";
  return `R$ ${n.toFixed(2).replace(".", ",")}`;
}

function amostraQualifier(row: Extract<CacRow, { kind: "measured" }>): string {
  if (row.amostraVazia) return "⚠ vazia";
  if (row.amostraPequena) return "⚠ pequena";
  if (row.amostraInstavel) return "⚠ instável";
  return "";
}

/** Metadados de procedência opcionais (#5495 — "o relatório precisa ser
 *  auto-suficiente quando copiado pra fora do arquivo"). Sempre opcionais:
 *  chamadores existentes (testes, callers antigos) continuam funcionando sem
 *  passar nada — as linhas correspondentes só aparecem quando informadas. */
export interface CacReportProvenance {
  /** ISO — momento em que ESTE relatório foi apurado (não o do snapshot). */
  apuradoEm?: string;
  /** Data do snapshot Beehiiv usado (`YYYY-MM-DD`). */
  snapshotDate?: string;
}

/** @pure */
export function formatCacReportMarkdown(
  report: CacReport,
  budget: ReturnType<typeof computeMonthBudgetUsage>,
  provenance: CacReportProvenance = {},
): string {
  const lines: string[] = [];
  lines.push(`# Custo por leitor por canal`, "");
  if (provenance.apuradoEm) lines.push(`Apurado em: ${provenance.apuradoEm}.`);
  if (provenance.snapshotDate) lines.push(`Snapshot Beehiiv usado: ${provenance.snapshotDate}.`);
  if (report.window) {
    const sinceLabel = report.window.since != null ? new Date(report.window.since * 1000).toISOString().slice(0, 10) : "(sem borda inferior)";
    const untilLabel =
      report.window.untilExclusive != null
        ? new Date(report.window.untilExclusive * 1000 - 86_400_000).toISOString().slice(0, 10)
        : "(sem borda superior)";
    lines.push(`Janela de cadastro aplicada (--desde/--ate): ${sinceLabel} a ${untilLabel} (inclusive).`);
    if (report.excludedMissingCreated > 0) {
      lines.push(`⚠ ${report.excludedMissingCreated} assinante(s) descartado(s) da base por falta de \`created\` sob a janela.`);
    }
  } else {
    lines.push(`Nenhuma janela de cadastro aplicada (--desde/--ate) — números acumulados desde sempre, não recortados por período.`);
  }
  lines.push(`Base (todos os ativos, todos os canais): abertura agregada ${fmtPct(report.base.aberturaAgregada)} (n=${report.base.amostraConsiderada}).`);
  lines.push(`Orçamento do mês ${budget.monthKey}: ${fmtBrl(budget.spentBrl)} de ${fmtBrl(budget.budgetFloorBrl)} (${fmtPct(budget.fractionUsed)}).`);
  if (report.internalFiltered > 0) {
    lines.push(`${report.internalFiltered} conta(s) interna(s)/teste excluída(s) antes de agrupar.`);
  }
  if (!report.originApplied) {
    lines.push(`⚠ mapa de origem recuperada NÃO aplicado — canais reativados via brevo-diaria podem estar mal atribuídos.`);
  }
  if (report.unmappedChannels.length > 0) {
    lines.push(`⚠ canal(is) desconhecido(s) em spend.csv (confira o nome exato): ${report.unmappedChannels.join(", ")}.`);
  }
  if (report.channelsMissingSpend.length > 0) {
    lines.push(
      `⚠ canal(is) com assinantes atribuídos mas SEM linha em spend.csv (ausente do relatório): ${report.channelsMissingSpend.join(", ")}.`,
    );
  }
  lines.push("");

  const rowTableHeader = [
    "| Canal | Sub-canal | Custo/leitor | Leitores | Ativos | Cadastros | Abertura (canal) | vs. base | n | Amostra | Gasto | Mês | Fonte |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];

  const rowToTableLine = (row: CacRow): string => {
    const subcanal = row.spend.subcanal ?? "—";
    if (row.kind === "measured") {
      const versusBase =
        row.aberturaAgregada != null && report.base.aberturaAgregada != null
          ? `${row.aberturaAgregada >= report.base.aberturaAgregada ? "▲" : "▼"} ${fmtPct(Math.abs(row.aberturaAgregada - report.base.aberturaAgregada) as number)}`
          : "—";
      const degradedFlag = row.degradado === true ? " ⚠ degradou" : "";
      return `| ${row.canal} | ${subcanal} | ${fmtBrl(row.custoPorLeitor)} | ${row.leitores} | ${row.ativos} | ${row.cadastros} | ${fmtPct(row.aberturaAgregada)}${degradedFlag} | ${versusBase} | ${row.amostraConsiderada} | ${amostraQualifier(row) || "—"} | ${fmtBrl(row.spend.valor)} | ${row.spend.mes} | ${row.spend.fonte} |`;
    }
    return `| ${row.canal} | ${subcanal} | ${fmtBrl(row.range.custoPorLeitorMin)}–${fmtBrl(row.range.custoPorLeitorMax)} | ${row.range.leitoresMin}–${row.range.leitoresMax} | ${row.range.ativosMin}–${row.range.ativosMax} | — | — | — | — | estimado (não medido) | ${fmtBrl(row.spend.valor)} | ${row.spend.mes} | ${row.spend.fonte} |`;
  };

  // Ranking principal (#5859) — só canais com custo por leitor válido E
  // gasto real (> 0). "Sem dado suficiente" e "Gasto zero" são blocos
  // PRÓPRIOS logo abaixo, nunca misturados/indistinguíveis dentro deste
  // ranking ordenado.
  lines.push(...rowTableHeader);
  if (report.rankedRows.length > 0) {
    for (const row of report.rankedRows) lines.push(rowToTableLine(row));
  } else {
    lines.push("| _nenhum canal ranqueável (todos sem dado ou com gasto zero — ver blocos abaixo)_ | | | | | | | | | | | | |");
  }

  if (report.noDataRows.length > 0) {
    lines.push("");
    lines.push("### Sem dado suficiente");
    lines.push("");
    lines.push("Canal medido, mas sem nenhum leitor no snapshot ainda — não é \"caríssimo\", é \"sem dado\" (#5859).");
    lines.push("");
    lines.push(...rowTableHeader);
    for (const row of report.noDataRows) lines.push(rowToTableLine(row));
  }

  if (report.zeroSpendRows.length > 0) {
    lines.push("");
    lines.push("### Gasto zero");
    lines.push("");
    lines.push(
      "Canal com leitores no snapshot mas gasto registrado R$ 0,00 (ex: linha placeholder antes da campanha rodar) — " +
        "custo zero não é eficiência infinita, então nunca entra no ranking acima (#5859).",
    );
    lines.push("");
    lines.push(...rowTableHeader);
    for (const row of report.zeroSpendRows) lines.push(rowToTableLine(row));
  }

  if (report.unattributedSpend.length > 0) {
    lines.push("");
    lines.push("## Gasto não atribuído");
    lines.push("");
    lines.push(
      "Linha(s) de `spend.csv` cujo canal não bateu com nenhum nome reconhecido — o gasto NUNCA vira uma linha " +
        "`measured`/n=0 fantasma (indistinguível de \"canal medido, zero leitores\"); fica aqui até o nome ser corrigido " +
        "no CSV ou uma spec nova entrar em `CHANNEL_KEY_SPECS` (#5860).",
    );
    lines.push("");
    lines.push("| Canal (como veio em spend.csv) | Gasto | Mês | Fonte |");
    lines.push("|---|---|---|---|");
    for (const entry of report.unattributedSpend) {
      lines.push(`| ${entry.label} | ${fmtBrl(entry.spend.valor)} | ${entry.spend.mes} | ${entry.spend.fonte} |`);
    }
    lines.push("");
    lines.push(`Nomes canônicos disponíveis: ${Object.keys(CHANNEL_GROUP_KEYS).join(", ")}, ou exatamente "Beehiiv Boosts".`);
  }

  // Funil por braço (§5 / §8.8 do protocolo 2608). Tabela separada de propósito:
  // a tabela acima já tem 13 colunas, e o funil responde outra pergunta — não
  // "quanto custou o leitor", mas "onde o cadastro parou".
  const measuredRows = report.rows.filter((r): r is Extract<CacRow, { kind: "measured" }> => r.kind === "measured");
  if (measuredRows.length > 0) {
    lines.push("");
    lines.push("### Funil por canal");
    lines.push("");
    lines.push(
      "Passo 3 da §5. `Pending` é o cadastro que clicou e não confirmou — o mais informativo " +
        "deste teste, e o segmento que o canal `brevo_diaria` mira (§7.3b).",
    );
    lines.push("");
    lines.push("| Canal | Sub-canal | Cadastros | Pending | % pending | Inativos | Invalid | Outros | Ativos | Leitores |");
    lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const row of measuredRows) {
      const pctPending = row.cadastros > 0 ? fmtPct(row.pending / row.cadastros) : "—";
      lines.push(
        `| ${row.canal} | ${row.spend.subcanal ?? "—"} | ${row.cadastros} | ${row.pending} | ${pctPending} | ` +
          `${row.inativos} | ${row.invalid} | ${row.outrosStatus} | ${row.ativos} | ${row.leitores} |`,
      );
    }
  }

  lines.push("");
  lines.push(`Total medido (exclui estimativas): ${fmtBrl(report.totalGastoMedido)}.`);
  const boostRow = report.rows.find((r): r is Extract<CacRow, { kind: "boost-estimate" }> => r.kind === "boost-estimate");
  if (boostRow) lines.push(`${boostRow.canal}: ${boostRow.note}`);

  return lines.join("\n") + "\n";
}

function reportSpendErrorsToLines(errors: SpendRowError[]): string[] {
  return errors.map((e) => `[cac-report] spend.csv linha ${e.line}: ${e.reason}`);
}

/**
 * `rootDir` é onde `data/aquisicao/cac-reports/{id}.md` é escrito e onde o
 * relatório é registrado (`registerReport`) — SEPARADO de `args.backupRoot`
 * (que é só a leitura de snapshots, pode apontar pra qualquer lugar via
 * `--root`). Default `ROOT` (raiz real do projeto); testes injetam um
 * tmpdir aqui pra nunca escrever/registrar contra `data/reports/index.jsonl`
 * de verdade.
 */
export function main(argv: string[] = process.argv.slice(2), rootDir: string = ROOT, now: () => Date = () => new Date()): void {
  const args = parseCacReportArgs(argv);

  let window: CohortWindow | null;
  try {
    window = resolveCacReportWindow(args);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  let spendResult: { rows: SpendRow[]; errors: SpendRowError[] };
  try {
    spendResult = readSpendCsv(args.spendPath);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }
  for (const line of reportSpendErrorsToLines(spendResult.errors)) console.error(line);
  if (spendResult.rows.length === 0) {
    console.error(`[cac-report] spend.csv não tem nenhuma linha válida — nada para reportar.`);
    process.exitCode = 1;
    return;
  }

  const dates = listSnapshotDates(args.backupRoot);
  const snapshotDate = args.snapshotDate ?? latestSnapshotDate(args.backupRoot);
  if (!snapshotDate) {
    console.error(`[cac-report] nenhum snapshot encontrado em ${args.backupRoot}.`);
    process.exitCode = 1;
    return;
  }

  const { index: origemIndex, applied: originApplied } = loadOrigemIndex(args.origemPath);
  const { subs, internalFiltered } = loadPreparedSubscribers(args.backupRoot, snapshotDate, origemIndex);
  if (subs.length === 0) {
    console.error(`[cac-report] snapshot ${snapshotDate} não tem subscribers legíveis em ${args.backupRoot}.`);
    process.exitCode = 1;
    return;
  }

  // Snapshot anterior (pro sinal de degradação) — o segundo mais recente
  // ANTES de `snapshotDate` na lista ordenada ascendente, quando existir.
  const idx = dates.indexOf(snapshotDate);
  const previousDate = idx > 0 ? dates[idx - 1] : null;
  const previousSubs = previousDate
    ? loadPreparedSubscribers(args.backupRoot, previousDate, origemIndex).subs
    : undefined;

  let report: CacReport;
  try {
    report = buildCacReport(spendResult.rows, subs, { previousSubs, originApplied, internalFiltered, window: window ?? undefined });
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }
  const monthKey = snapshotDate.slice(0, 7); // "YYYY-MM-DD" -> "YYYY-MM"
  const budget = computeMonthBudgetUsage(spendResult.rows, monthKey, MONTHLY_BUDGET_FLOOR_BRL);
  const apuradoEm = now().toISOString();
  const provenance = { apuradoEm, snapshotDate };

  if (args.json) {
    console.log(JSON.stringify({ snapshotDate, previousDate, report, budget, apuradoEm }, null, 2));
  } else {
    console.log(formatCacReportMarkdown(report, budget, provenance));
  }

  if (args.register) {
    const markdown = formatCacReportMarkdown(report, budget, provenance);
    const dir = resolve(rootDir, "data", "aquisicao", "cac-reports");
    mkdirSync(dir, { recursive: true });
    // Id inclui a janela quando --desde/--ate foi passado (#5495 — "duas
    // apurações não se sobrescreverem"): sem flags de janela, o id continua
    // igual a sempre (só `snapshotDate`) — comportamento OBSERVÁVEL
    // inalterado pro caso default, coberto pelos testes de regressão já
    // existentes. Com janela, o sufixo garante que rodar o relatório com
    // duas janelas diferentes no mesmo dia produz dois arquivos/registros
    // distintos em vez de um sobrescrever o outro silenciosamente.
    const windowSuffix = args.desde || args.ate ? `--w${args.desde ?? "x"}_${args.ate ?? "x"}` : "";
    const id = `${snapshotDate}${windowSuffix}`;
    const relPath = `data/aquisicao/cac-reports/${id}.md`;
    writeFileSync(resolve(rootDir, relPath), markdown, "utf8");
    const result = registerReport(rootDir, {
      kind: "cac",
      sessionId: id,
      title: `Custo por leitor por canal — snapshot ${snapshotDate}`,
      htmlPath: relPath,
    });
    if (!result.ok) {
      console.error(`[cac-report] aviso: registro do relatório falhou (fail-soft, #3714): ${result.error}`);
    } else {
      console.error(`[cac-report] registrado: ${reportId("cac", id)} → /relatorios/${reportId("cac", id)}`);
    }
  }

  // #5860 item 2: com --strict, gasto não atribuído é acionável NA HORA
  // (exit code diferente de 0) em vez de só um aviso em stderr que ninguém
  // relê depois. Checado por ÚLTIMO — nunca impede o relatório de ser
  // gerado/registrado, só sinaliza a falha pro caller (cron/task agendada)
  // depois que todo o resto já rodou.
  if (args.strict && report.unattributedSpend.length > 0) {
    console.error(
      `[cac-report] --strict: ${report.unattributedSpend.length} linha(s) de gasto não atribuído em spend.csv ` +
        `(${report.unmappedChannels.join(", ")}) — corrija o nome do canal ou cadastre uma spec nova.`,
    );
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
