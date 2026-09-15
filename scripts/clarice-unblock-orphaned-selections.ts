#!/usr/bin/env node
/**
 * scripts/clarice-unblock-orphaned-selections.ts (#8038)
 *
 * Acha e desbloqueia contatos presos em `sent-or-queued.json` (guard
 * cycle-wide anti-duplo-envio, `clarice-build-segment.ts` #3227) que foram
 * SELECIONADOS pra alguma onda mas nunca aparecem em nenhum CSV de onda
 * vivo do ciclo — indício de que a seleção original nunca virou onda real
 * (build abandonado, superseded pela fila `daily` do #7406, ou perda por
 * concorrência do #4765). Ver `findOrphanedSentOrQueuedEmails` em
 * `clarice-build-segment.ts` pra semântica completa da detecção.
 *
 * ⚠️ Detecção é POR ARQUIVO LOCAL (CSV atual no disco), não por status real
 * na Brevo — um `--group`/`--daily` que roda de novo SOBRESCREVE o CSV do
 * grupo (`writeFileSync` sem guarda de idempotência), então um email cuja
 * seleção original já tenha sido importada pra Brevo mas cujo arquivo local
 * foi depois sobrescrito por um rebuild pode ser classificado aqui como
 * "órfão" mesmo tendo uma campanha real associada (achado do review do
 * #8043/#8043). **Isto não é um risco de envio duplicado**: tanto
 * `excludeCommittedToQueuedCampaigns` (grupos nomeados) quanto
 * `buildDailySendQueue`/`dailyQueuedListIds`/`dailyCommittedListIds`
 * (`--daily`) consultam a Brevo AO VIVO — por `brevo_list_ids` do contato,
 * não por `sent-or-queued.json` nem por CSV local — antes de qualquer nova
 * seleção real escrever/importar algo. Desbloquear aqui só reabre
 * ELEGIBILIDADE pra entrar na PRÓXIMA rodada de seleção; se o contato ainda
 * estiver de fato numa lista Brevo comprometida (agendada/enviada), essa
 * checagem ao vivo o exclui de novo, independente deste script. O gap real
 * (que este achado documenta, não resolve) é só DIAGNÓSTICO: não dá pra
 * distinguir aqui "nunca importado" de "importado, arquivo local
 * sobrescrito depois" sem um sinal mais forte (`{group}-lists.json` só tem
 * metadado de lista, não por-contato).
 *
 * `--check-suspended` (#8117) FECHA esse gap: cruza `group-campaigns.json`
 * (que carrega `campaignId` por `key`) contra o status AO VIVO na Brevo
 * (`GET /v3/emailCampaigns?status=suspended`, paginado, 1 chamada — família
 * com quota apertada, 100 req/hora/conta, CLAUDE.md). Achado ao vivo que
 * motivou (#8113, edição 260914): o editor suspendeu de propósito 3
 * campanhas (`d3-qui03-A/B/C`) em 03/09 — sem nota, sem log local — e os 85
 * contatos delas ficaram presos em `sent-or-queued.json` por 11 dias, "já
 * reivindicados" pra uma campanha que nunca disparou (`sent: 0` na Brevo).
 * A detecção por CSV (acima) não pega este caso: o CSV da onda `d3-qui03-*`
 * continua no disco, intacto — o problema não é o artefato local sumir, é a
 * campanha que ele alimentou ter sido abortada DEPOIS de importada.
 * Idempotente por construção: uma vez desbloqueado, o email sai de
 * `sent-or-queued.json` e a checagem seguinte não o encontra mais lá — não
 * precisa de um registro à parte de "campanha já reconciliada".
 *
 * Uso:
 *   npx tsx scripts/clarice-unblock-orphaned-selections.ts --cycle 2608-09 [--apply] [--check-suspended]
 *   (default: dry-run — lista os órfãos encontrados, não escreve)
 *
 * `--check-suspended` requer `BREVO_CLARICE_API_KEY` — sem ela, ABORTA (não
 * degrada silenciosamente pra "nenhum suspenso encontrado", que seria pior
 * que não checar). Sem a flag, comportamento inalterado (só o gap de CSV).
 *
 * Concorrência: adquire o MESMO lock cycle-wide de `clarice-envio-lock.ts`
 * (usado por `clarice-envio-run.ts`/`clarice-envio-guard.ts`) antes de tocar
 * `sent-or-queued.json` sob `--apply` — evita rodar durante uma rampa
 * automática em curso pro mesmo ciclo (mesmo risco de lost-update do #4765
 * que a docstring de `unblockOrphanedSentOrQueuedEmails` já nomeava; agora
 * um mecanismo, não só um comentário). `--dry-run` não adquire lock (só
 * leitura).
 *
 * Stdout: JSON com `{ orphansFound, suspendedCampaignsFound, apply, emails }`.
 * Stderr: progresso.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { clariceSegmentsDir, CLARICE_BASE, REPO_ROOT } from "./lib/clarice-paths.ts";
import { acquireEnvioLock, releaseEnvioLock, LockHeldError } from "./lib/clarice-envio-lock.ts";
import { fetchCampaignsByStatus } from "./lib/brevo-client.ts";
import { computeExpectedEnvioCycle } from "./lib/clarice-envio-cycle.ts";
import type { CampaignEntry } from "./clarice-schedule-group.ts";
import {
  loadSentOrQueuedEmails,
  findOrphanedSentOrQueuedEmails,
  unblockOrphanedSentOrQueuedEmails,
} from "./clarice-build-segment.ts";

/** Lê o 1º campo (coluna `email`) de todo `*.csv` em `segmentsDir` — inclui
 *  `daily.csv`/`novos.csv`/`engajados.csv`/`ramp-warm.csv` e os
 *  `d{N}-*-{A,B,C}.csv` das ondas diárias. Todo artefato de seleção vivo do
 *  ciclo, sem exceção — é este universo que decide "ainda em alguma onda". */
export function collectCurrentlyReferencedEmails(segmentsDir: string): Set<string> {
  const out = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(segmentsDir).filter((f) => f.endsWith(".csv"));
  } catch {
    return out; // diretório ausente (ciclo sem builds ainda) — universo vazio.
  }
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(resolve(segmentsDir, f), "utf8");
    } catch {
      continue; // arquivo ilegível não derruba o resto da varredura.
    }
    // Papa.parse (não split(",") ingênuo) — mesma lib já usada por
    // `clarice-build-segment.ts` pra ESCREVER estes CSVs (`Papa.unparse`);
    // usar o par certo pra LER protege contra um campo `email` que um
    // writer futuro venha a quotar/escapar, mesmo que hoje nenhum precise.
    const parsed = Papa.parse<Record<string, string>>(content, { header: true, skipEmptyLines: true });
    for (const row of parsed.data) {
      const email = row.email?.trim();
      if (email) out.add(email.toLowerCase());
    }
  }
  return out;
}

/** Lê a coluna `email` de UM CSV de onda (`{key}.csv` em `segmentsDir`) —
 *  mesmo parser (Papa.parse) de `collectCurrentlyReferencedEmails`, fatorado
 *  pra reuso pontual (#8117: ler só o CSV do grupo suspenso, não o ciclo
 *  inteiro). Tolerante: arquivo ausente/ilegível → `[]`, nunca lança —
 *  mesma postura fail-soft do resto deste script. */
export function readGroupCsvEmails(segmentsDir: string, key: string): string[] {
  const path = resolve(segmentsDir, `${key}.csv`);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const parsed = Papa.parse<Record<string, string>>(content, { header: true, skipEmptyLines: true });
  const out: string[] = [];
  for (const row of parsed.data) {
    const email = row.email?.trim();
    if (email) out.push(email.toLowerCase());
  }
  return out;
}

/** Lê `group-campaigns.json` de `segmentsDir` — mesmo shape que
 *  `clarice-schedule-group.ts` escreve (array de `CampaignEntry`).
 *  Tolerante: ausente/corrompido → `[]` (nunca lança — mesma postura das
 *  demais leituras deste script; um `--check-suspended` sem nenhuma
 *  campanha ainda criada não deveria abortar, só não achar nada). */
export function loadGroupCampaigns(segmentsDir: string): CampaignEntry[] {
  const path = resolve(segmentsDir, "group-campaigns.json");
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Pura (#8117): cruza `groupCampaigns` (entradas `{key, campaignId}` de
 * `group-campaigns.json`) contra `liveSuspendedCampaignIds` (Set de
 * `campaignId` que a Brevo reporta `status=suspended` AGORA) e devolve, por
 * campanha suspensa, os emails do CSV daquele `key` — via `readGroupCsvEmails`
 * injetado (não I/O direto aqui, mesmo padrão testável do resto do arquivo).
 * Uma campanha suspensa cujo CSV não existe mais (ou está vazio) não quebra
 * nada — `emails: []` só não contribui pro total a desbloquear.
 */
export function findSuspendedCampaignEmails(
  groupCampaigns: ReadonlyArray<Pick<CampaignEntry, "key" | "campaignId">>,
  liveSuspendedCampaignIds: ReadonlySet<number>,
  readGroupCsvEmailsFn: (key: string) => string[],
): { key: string; campaignId: number; emails: string[] }[] {
  const out: { key: string; campaignId: number; emails: string[] }[] = [];
  for (const entry of groupCampaigns) {
    if (!liveSuspendedCampaignIds.has(entry.campaignId)) continue;
    out.push({ key: entry.key, campaignId: entry.campaignId, emails: readGroupCsvEmailsFn(entry.key) });
  }
  return out;
}

export async function main(argv: string[] = process.argv.slice(2)) {
  // #8117: --cycle vira OPCIONAL — default computeExpectedEnvioCycle(now),
  // mesmo resolvedor que clarice-envio-run.ts já usa pra achar "o ciclo de
  // hoje" sem hardcode de data. Necessário pra registrar a task diária
  // (Diaria-Clarice-Unblock-Suspended) sem precisar de argumento dinâmico no
  // registry declarativo (scheduled-tasks.ts só aceita `args: string[]`
  // estáticos). Passar --cycle explícito continua funcionando igual (uso
  // manual/ad-hoc, ou auditar um ciclo passado).
  const cycleArg = getArg(argv, "cycle");
  const cycle = cycleArg || computeExpectedEnvioCycle(new Date());
  if (!cycleArg) {
    console.error(`[clarice-unblock-orphaned-selections] --cycle não informado — usando o ciclo de hoje: ${cycle}.`);
  }
  const apply = hasFlag(argv, "apply");
  const baseDir = getArg(argv, "base-dir") || CLARICE_BASE;
  const segDir = clariceSegmentsDir(cycle, baseDir);
  // #8043 review: override só de teste — `lockPathForCycle` deriva o caminho
  // do lock de `{rootDir}/data/clarice-subscribers/{cycle}/`; sem isto, um
  // teste de integração do lock escreveria um `.envio-run.lock` de verdade
  // sob o `data/` real do repo (produção). Omitido → REPO_ROOT (produção).
  const lockRootDir = getArg(argv, "lock-root-dir") || REPO_ROOT;

  const sentOrQueued = loadSentOrQueuedEmails(segDir);
  const currentlyReferenced = collectCurrentlyReferencedEmails(segDir);
  const csvOrphans = findOrphanedSentOrQueuedEmails(sentOrQueued, currentlyReferenced);

  // #8117: --check-suspended cruza group-campaigns.json contra status AO
  // VIVO na Brevo — fecha o gap que a detecção por CSV (acima) documentava
  // como fora de escopo (#8038): campanha suspensa DEPOIS de importada,
  // cujo CSV original continua intacto no disco.
  const checkSuspended = hasFlag(argv, "check-suspended");
  let suspendedFound: { key: string; campaignId: number; emails: string[] }[] = [];
  if (checkSuspended) {
    const apiKey = process.env.BREVO_CLARICE_API_KEY;
    if (!apiKey) {
      console.error(
        "[clarice-unblock-orphaned-selections] ❌ --check-suspended requer BREVO_CLARICE_API_KEY — " +
          "abortando (não degrada silenciosamente pra 'nenhum suspenso encontrado', que seria pior que não checar).",
      );
      process.exit(1);
    }
    const groupCampaigns = loadGroupCampaigns(segDir);
    const liveSuspended = await fetchCampaignsByStatus(apiKey, "suspended");
    const liveSuspendedIds = new Set(liveSuspended.map((c) => c.id).filter((id): id is number => typeof id === "number"));
    suspendedFound = findSuspendedCampaignEmails(groupCampaigns, liveSuspendedIds, (key) => readGroupCsvEmails(segDir, key));
    const withEmails = suspendedFound.filter((c) => c.emails.length > 0);
    if (withEmails.length > 0) {
      console.error(
        `[clarice-unblock-orphaned-selections] ⚠️  ${withEmails.length} campanha(s) suspensa(s) na Brevo encontrada(s) ` +
          `neste ciclo: ${withEmails.map((c) => `${c.key} (#${c.campaignId}, ${c.emails.length} contato(s))`).join(", ")}.`,
      );
    }
  }
  const suspendedEmails = suspendedFound.flatMap((c) => c.emails).filter((e) => sentOrQueued.has(e));
  const orphans = [...new Set([...csvOrphans, ...suspendedEmails])].sort();

  console.log(
    JSON.stringify(
      {
        cycle,
        orphansFound: csvOrphans.length,
        suspendedCampaignsFound: suspendedFound.filter((c) => c.emails.length > 0).length,
        suspendedEmailsFound: suspendedEmails.length,
        totalToUnblock: orphans.length,
        apply,
        emails: orphans,
      },
      null,
      2,
    ),
  );

  if (orphans.length === 0) {
    console.error("[clarice-unblock-orphaned-selections] nenhum órfão encontrado.");
    return;
  }
  if (!apply) {
    console.error(`[clarice-unblock-orphaned-selections] --dry-run: ${orphans.length} órfão(s) encontrado(s), nada escrito. Rode com --apply pra desbloquear.`);
    return;
  }

  let lockPath: string;
  try {
    lockPath = acquireEnvioLock(lockRootDir, cycle, "unblock-orphaned-selections", new Date());
  } catch (e) {
    if (e instanceof LockHeldError) {
      console.error(`[clarice-unblock-orphaned-selections] ❌ ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  try {
    const removed = unblockOrphanedSentOrQueuedEmails(segDir, cycle, orphans);
    console.error(`[clarice-unblock-orphaned-selections] ${removed} email(s) desbloqueado(s) — voltam a ser elegíveis na próxima montagem de fila.`);
  } finally {
    releaseEnvioLock(lockPath);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
