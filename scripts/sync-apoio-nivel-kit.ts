#!/usr/bin/env node
/**
 * scripts/sync-apoio-nivel-kit.ts (#6049 — migração Beehiiv → Kit, #461)
 *
 * Espelho de `scripts/sync-apoio-nivel-beehiiv.ts` (#4436) pro Kit: sincroniza
 * o nível de recompensa de apoio (Amigo/Apoiador/Mantenedor/Patrono) do CRM
 * apoia.se pro custom field `apoio_nivel` no Kit — o mesmo campo que os 6
 * segmentos `Apoio — {Amigo,Apoiador,Mantenedor,Patrono,Todos,Nenhum}`
 * (`scripts/lib/apoio-segments-canonical-kit.ts`, #6049 achado 260824)
 * condicionam.
 *
 * ## O que é REUSADO da Beehiiv, e por quê
 *
 * Toda a lógica PURA de negócio (carência de 1 mês, guard de blast radius de
 * 30%, fail-closed em leitura parcial, diff desejado×atual, formatação de
 * log) já existe em `sync-apoio-nivel-beehiiv.ts` e é plataforma-agnóstica —
 * opera sobre um shape genérico `{subscriptionId, email, apoioNivel}`
 * (`BeehiivSubscriptionSnapshot`, nome histórico mas sem nada específico da
 * Beehiiv na forma), não sobre nada específico da API Beehiiv:
 *
 *   - `computeDesiredApoioLevels`/`maxLevel`/`previousMonthKey` — carência.
 *   - `diffApoioTags` — diff desejado×atual (casamento por e-mail).
 *   - `shouldBlockRemovals`/`evaluateBlastRadiusGuard` — os dois guards.
 *   - `logDiff`/`logBlastRadiusGuard` — formatação do relatório dry-run/push.
 *
 * Este arquivo reusa tudo isso via import direto — SÓ reimplementa a camada
 * de I/O específica do Kit (`fetchCurrentKitState`, `applyApoioTagEntryKit`),
 * mesma divisão pura/I/O do arquivo original.
 *
 * ## O que é DIFERENTE da Beehiiv
 *
 * - **Leitura do estado atual não é paginada por página numerada** — o Kit
 *   usa cursor (`after`/`end_cursor`), já encapsulado em
 *   `listAllKitSubscribers` (#6091). Sem filtro server-side por `state`
 *   (nenhum consumidor Kit deste repo usou esse parâmetro ainda, e inventar
 *   um não-verificado é pior que filtrar client-side) — filtra `state ===
 *   "active"` depois de ler tudo, mesmo padrão de `sync-beehiiv-subscribers
 *   -kit.ts`.
 * - **Escrita é `PATCH /subscribers/{id}` com `fields`**, não `PUT
 *   .../by_email/{email}` com `custom_fields` — `updateSubscriberFields`/
 *   `getSubscriberById` em `scripts/lib/kit-subscribers.ts` (#6049). Remoção
 *   de nível usa `fields: {apoio_nivel: ""}` (string vazia) — o Kit não tem
 *   um `delete: true` equivalente ao da Beehiiv. **CONFIRMADO AO VIVO em
 *   02/09/2026** (#6925, 1º `--push` real deste script): 2 remoções + 1
 *   adição, 3 aplicadas / 0 falhas, verificadas por leitura independente na
 *   API do Kit (os 2 removidos ficaram com `apoio_nivel: ""`, o 3º com
 *   `apoiador`). Até então isto era "não confirmado ao vivo".
 *   **Gotcha medida na mesma rodada:** o dry-run imediatamente após o
 *   `--push` ainda mostra o MESMO diff (atraso de propagação do Kit) —
 *   minutos depois converge. Quem reconferir na hora vai achar que não
 *   pegou e tende a reaplicar; a leitura autoritativa é a API do Kit, não
 *   o dry-run imediato.
 * - **Sem `subscriptionId` distinto do subscriber ID** — o Kit não separa
 *   "assinante" de "assinatura" como a Beehiiv; `subscriptionId` no diff
 *   reusado carrega o `id` numérico do subscriber Kit (como string, pra
 *   caber no shape reusado).
 *
 * ## Guard de publicação / gate consistente com o resto da migração
 *
 * Este é um script STANDALONE, novo, nunca invocado por `/diaria-edicao` nem
 * por nenhuma skill do pipeline — mesmo padrão de `sync-beehiiv-subscribers
 * -kit.ts` (#6091) e `sync-apoio-nivel-brevo.ts` (#4572): existir no repo não
 * muda nenhum comportamento de produção, só fica disponível pro editor rodar
 * manualmente quando o cutover real (#463/#464) acontecer. Dry-run por
 * padrão (só `--push` grava). `sync-apoio-nivel-beehiiv.ts` continua sendo o
 * script que RODA de verdade até o cutover — nenhum caminho automático
 * decide entre os dois.
 *
 * **ATUALIZAÇÃO 02/09/2026 (#6925):** o `--push` real JÁ RODOU uma vez, com
 * autorização explícita do editor numa sessão `/diaria-develop` — 3
 * mutações aplicadas e verificadas. O parágrafo abaixo descreve o estado da
 * unidade de ORIGEM (#6049), preservado como registro histórico.
 *
 * IMPORTANTE (escopo desta unidade, #6049): `--push` NUNCA foi executado
 * contra o Kit real nesta sessão (guard de publicação do overnight/develop).
 * Validado só via leitura de código + testes com fixtures (nenhuma chamada
 * de rede real nos testes).
 *
 * Uso:
 *   npx tsx scripts/sync-apoio-nivel-kit.ts [--push] [--allow-partial] [--force-blast-radius]
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import { listAllKitSubscribers, updateSubscriberFields, getSubscriberById } from "./lib/kit-subscribers.ts";
import { KIT_APOIO_NIVEL_FIELD_KEY } from "./lib/apoio-segments-canonical-kit.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { readApoiaSeEnv, defaultCacheDir, competenceMonth } from "./lib/apoia-se.ts";
import { runApoioReconciliationCycle } from "./lib/apoio-reconciliation-cycle.ts";
import {
  buildApoiosData,
  readPastMonthSnapshots,
  type MonthSnapshot,
} from "./studio-ui/studio-apoios.ts";
import {
  computeDesiredApoioLevels,
  diffApoioTags,
  shouldBlockRemovals,
  isPreviousMonthSnapshotMissing,
  previousMonthKey,
  evaluateBlastRadiusGuard,
  logDiff,
  logBlastRadiusGuard,
  type ApoioTagDiffEntry,
  type BeehiivSubscriptionSnapshot as ApoioLevelSnapshot,
} from "./sync-apoio-nivel-beehiiv.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LOG_PREFIX = "[sync-apoio-nivel-kit]";

/** Reexportado pra quem quiser referenciar o mesmo shape genérico sem
 *  importar do arquivo Beehiiv diretamente. */
export type { ApoioLevelSnapshot };

// ── estado ATUAL (I/O — leitura via Kit) ────────────────────────────────

/** Pure: extrai o valor do custom field `apoio_nivel` de um `fields` cru do
 *  Kit. `""` quando ausente/malformado — mesma semântica de
 *  `extractApoioNivelValue` na Beehiiv. */
export function extractApoioNivelValueKit(fields: Record<string, string> | undefined): string {
  if (!fields || typeof fields !== "object") return "";
  const v = fields[KIT_APOIO_NIVEL_FIELD_KEY];
  return typeof v === "string" ? v : "";
}

/**
 * I/O: lista todos os assinantes Kit (`listAllKitSubscribers`, #6091 —
 * cursor, sem filtro server-side por `state`) e converte pro shape genérico
 * reusado da Beehiiv, filtrando só `state === "active"` (client-side, mesmo
 * padrão de `sync-beehiiv-subscribers-kit.ts`).
 */
export async function fetchCurrentKitState(config?: KitConfig): Promise<ApoioLevelSnapshot[]> {
  const subs = await listAllKitSubscribers(config);
  return subs
    .filter((s) => s.state === "active")
    .map((s) => ({
      subscriptionId: String(s.id),
      email: s.email_address.trim().toLowerCase(),
      apoioNivel: extractApoioNivelValueKit(s.fields),
    }));
}

// ── aplicação (I/O — escrita + verificação por releitura) ──────────────────

/**
 * Aplica UMA entrada de diff via `PATCH /subscribers/{id}` e verifica por
 * RELEITURA (`GET /subscribers/{id}`) — mesma disciplina de
 * `applyApoioTagEntry` na Beehiiv (nunca confia só no status 2xx). Lança se
 * a releitura não confirmar o valor esperado.
 */
export async function applyApoioTagEntryKit(
  entry: ApoioTagDiffEntry,
  config?: KitConfig,
): Promise<void> {
  const id = Number(entry.subscriptionId);
  if (!Number.isFinite(id)) {
    throw new Error(`subscriptionId inválido pra ${entry.email}: "${entry.subscriptionId}" não é um ID Kit numérico`);
  }
  const expectedValue = entry.toLevel ?? "";

  await updateSubscriberFields(id, { [KIT_APOIO_NIVEL_FIELD_KEY]: expectedValue }, config);

  const verify = await getSubscriberById(id, config);
  const actualValue = extractApoioNivelValueKit(verify.fields);
  if (actualValue !== expectedValue) {
    throw new Error(
      `releitura pós-escrita NÃO confere pra ${entry.email} (subscriber ${id}): esperado ` +
        `"${expectedValue}", encontrado "${actualValue}" — mutação NÃO confirmada.`,
    );
  }
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  loadProjectEnv(ROOT);

  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) {
    process.stderr.write(`${LOG_PREFIX} ${kitConfigResult.reason}\n`);
    process.exit(1);
  }
  const kitConfig = kitConfigResult.config;

  // Mesma sequência de reconciliação de promessas pendentes (Gmail → apoia.se)
  // que `sync-apoio-nivel-beehiiv.ts` roda — reusa `runApoioReconciliationCycle`
  // (#4503/#4506), plataforma-agnóstica (não toca Beehiiv nem Kit, só o CRM
  // apoia.se + o store local de promessas).
  const cycle = await runApoioReconciliationCycle(ROOT);
  if (cycle.drainSkipped) {
    process.stderr.write(
      `${LOG_PREFIX} aviso: drain de promessas (Gmail) pulado (${cycle.drainSkipReason ?? "erro desconhecido"}) — ` +
        "reconciliação segue só com promessas já no store.\n",
    );
  }
  if (cycle.promessasDrained > 0) {
    process.stderr.write(`${LOG_PREFIX} ${cycle.promessasDrained} promessa(s) nova(s) drenada(s) do Gmail.\n`);
  }
  if (cycle.notificationsImported > 0) {
    process.stderr.write(
      `${LOG_PREFIX} ${cycle.notificationsImported} notificação(ões) de pagamento confirmado importada(s) como contato novo.\n`,
    );
  }
  if (cycle.promoted.length > 0) {
    process.stderr.write(
      `${LOG_PREFIX} ${cycle.promoted.length} promessa(s) confirmada(s) como pagamento — ` +
        `promovida(s) a contato: ${cycle.promoted.map((p) => `${p.name} <${p.email}>`).join(", ")}\n`,
    );
  }
  if (cycle.remainingPending.length > 0) {
    process.stderr.write(
      `${LOG_PREFIX} ${cycle.remainingPending.length} promessa(s) ainda pendente(s) (sem confirmação de pagamento).\n`,
    );
  }
  if (cycle.stale.length > 0) {
    process.stderr.write(
      `${LOG_PREFIX} aviso: ${cycle.stale.length} promessa(s) pendente(s) há mais de 90 dias sem confirmar — ver avisos acima.\n`,
    );
  }
  if (cycle.warning) {
    process.stderr.write(`${LOG_PREFIX} aviso: ${cycle.warning}\n`);
  }
  if (cycle.authError) {
    process.stderr.write(
      `${LOG_PREFIX} ERRO FATAL: chave apoia.se rejeitada durante a reconciliação de promessas pendentes ` +
        `(${cycle.authError}) — verifique APOIA_SE_API_KEY/APOIA_SE_API_SECRET. Sync abortado antes de tocar o Kit.\n`,
    );
    process.exit(1);
  }

  const data = await buildApoiosData(ROOT);
  if (data.error) {
    process.stderr.write(`${LOG_PREFIX} aviso: buildApoiosData reportou erro (dados podem estar incompletos): ${data.error}\n`);
  }

  const now = new Date();
  const currentMonth = competenceMonth(now);
  let pastSnapshots: MonthSnapshot[] = [];
  try {
    const env = readApoiaSeEnv();
    pastSnapshots = readPastMonthSnapshots(defaultCacheDir(env.campaign), currentMonth);
  } catch (e) {
    process.stderr.write(
      `${LOG_PREFIX} aviso: não foi possível ler snapshots de meses anteriores (carência de 1 mês ` +
        `desativada nesta rodada, comportamento cai pro mês corrente só): ${(e as Error).message}\n`,
    );
  }

  const desired = computeDesiredApoioLevels(data.contacts, pastSnapshots, currentMonth);

  process.stderr.write(`${LOG_PREFIX} buscando estado atual no Kit…\n`);
  const current = await fetchCurrentKitState(kitConfig);
  process.stderr.write(`${LOG_PREFIX} ${current.length} assinante(s) ativo(s) no Kit.\n`);

  const diff = diffApoioTags(desired, current);
  const allowPartial = hasFlag(argv, "allow-partial");
  const previousMonthSnapshotMissing = isPreviousMonthSnapshotMissing(pastSnapshots, currentMonth);
  if (previousMonthSnapshotMissing) {
    process.stderr.write(
      `${LOG_PREFIX} ⚠ snapshot de ${previousMonthKey(currentMonth)} AUSENTE — carência de 1 mês inaplicável ` +
        `nesta rodada; remoções BLOQUEADAS por segurança (#7195). Use --allow-partial pra forçar.\n`,
    );
  }
  const removalsBlockedByPartialData = shouldBlockRemovals(data.error, diff, allowPartial, {
    previousMonthSnapshotMissing,
  });
  const forceBlastRadius = hasFlag(argv, "force-blast-radius");
  const blastGuard = evaluateBlastRadiusGuard(diff.toRemove.length, current, forceBlastRadius);

  logDiff(diff, removalsBlockedByPartialData);
  logBlastRadiusGuard(blastGuard);

  if (!hasFlag(argv, "push")) {
    process.stderr.write(`${LOG_PREFIX} dry-run (default) — NENHUMA mutação aplicada. Use --push para gravar.\n`);
    return;
  }

  if (blastGuard.blocked) {
    process.stderr.write(
      `${LOG_PREFIX} RECUSANDO o --push inteiro (guard de blast radius acima) — nenhuma mutação foi ` +
        "aplicada, nem adições nem remoções. Confira se é uma virada de mês/instabilidade da apoia.se " +
        "antes de usar --force-blast-radius (decisão consciente do editor, sempre logada).\n",
    );
    process.exit(1);
  }

  if (removalsBlockedByPartialData && diff.toRemove.length > 0) {
    process.stderr.write(
      `${LOG_PREFIX} RECUSANDO aplicar as remoções acima (dados parciais/sem_dados) — ` +
        "uma falha de rede não pode virar remoção em massa de recompensa. Re-tente, ou use " +
        "--allow-partial pra prosseguir mesmo assim (decisão consciente do editor, sempre logada).\n",
    );
  }

  const toApplyNow = [...diff.toApply, ...(removalsBlockedByPartialData ? [] : diff.toRemove)];
  process.stderr.write(`${LOG_PREFIX} --push: aplicando ${toApplyNow.length} mutação(ões)…\n`);

  let applied = 0;
  let failed = 0;
  for (const entry of toApplyNow) {
    try {
      await applyApoioTagEntryKit(entry, kitConfig);
      applied++;
    } catch (e) {
      failed++;
      process.stderr.write(`${LOG_PREFIX} FALHA em ${entry.email}: ${(e as Error).message}\n`);
    }
  }

  process.stderr.write(`${LOG_PREFIX} push concluído: ${applied} aplicada(s), ${failed} falha(s).\n`);
  if (failed > 0) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${LOG_PREFIX} erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
