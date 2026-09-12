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
 * metadado de lista, não por-contato; um audit mais preciso cruzaria
 * `group-campaigns.json`/status ao vivo por grupo, fora de escopo deste
 * fix).
 *
 * Uso:
 *   npx tsx scripts/clarice-unblock-orphaned-selections.ts --cycle 2608-09 [--apply]
 *   (default: dry-run — lista os órfãos encontrados, não escreve)
 *
 * Concorrência: adquire o MESMO lock cycle-wide de `clarice-envio-lock.ts`
 * (usado por `clarice-envio-run.ts`/`clarice-envio-guard.ts`) antes de tocar
 * `sent-or-queued.json` sob `--apply` — evita rodar durante uma rampa
 * automática em curso pro mesmo ciclo (mesmo risco de lost-update do #4765
 * que a docstring de `unblockOrphanedSentOrQueuedEmails` já nomeava; agora
 * um mecanismo, não só um comentário). `--dry-run` não adquire lock (só
 * leitura).
 *
 * Stdout: JSON com `{ orphansFound, apply, emails }`. Stderr: progresso.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { clariceSegmentsDir, CLARICE_BASE, REPO_ROOT } from "./lib/clarice-paths.ts";
import { acquireEnvioLock, releaseEnvioLock, LockHeldError } from "./lib/clarice-envio-lock.ts";
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

export async function main(argv: string[] = process.argv.slice(2)) {
  const cycle = getArg(argv, "cycle");
  if (!cycle) {
    console.error("[clarice-unblock-orphaned-selections] --cycle {conteúdo}-{envio} é obrigatório.");
    process.exit(1);
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
  const orphans = findOrphanedSentOrQueuedEmails(sentOrQueued, currentlyReferenced);

  console.log(JSON.stringify({ cycle, orphansFound: orphans.length, apply, emails: orphans }, null, 2));

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
