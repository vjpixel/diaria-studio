#!/usr/bin/env node
/**
 * scripts/renumber-edition.ts (#12616)
 *
 * Troca o AAMMDD de uma edição (ex.: atraso de publicação empurra 261109 pra
 * 261110). Antes disto a troca era à mão, em ~8 passos fáceis de esquecer.
 *
 *   npx tsx scripts/renumber-edition.ts --from 261109 --to 261110              # dry-run: mostra o plano
 *   npx tsx scripts/renumber-edition.ts --from 261109 --to 261110 --apply      # parte local + lista dos passos remotos
 *   npx tsx scripts/renumber-edition.ts --from 261109 --to 261110 --apply --run-remote   # e roda os remotos
 *   npx tsx scripts/renumber-edition.ts --from 261109 --to 261110 --apply --unschedule   # desagenda antes (#12688)
 *
 * ## Parte local (`--apply`)
 *
 * Miolo em `scripts/lib/renumber-edition.ts`: ID trocado com borda numérica
 * (sem pegar `20261109_*.mp4`), `img-{de}-…` preservado (objeto já no R2),
 * `06-public-images.json` movido pra `_internal/_forensic/`, arquivos e pastas
 * renomeados (`.srt`, `.mp4` da edição), pasta movida pra `editionDir(para)`.
 * Destino existente ⇒ recusa (exit 2). Relatório em
 * `{pasta nova}/_internal/renumber-edition.json`.
 *
 * Stores globais de `data/` com o ID (#12691): `intentional-errors.jsonl`,
 * `eia-used.json`, `exploration-quota.json` — só o campo da edição muda, e
 * entrada já existente do ID novo (ou store ilegível) recusa com exit 2. O
 * dry-run e o `--apply` terminam com a lista do que fica fora (pasta do vídeo
 * no Drive, cache local do vídeo, outras sessões, histórico) e avisam se há
 * `edition-lock` vivo na pasta.
 *
 * ## Passos remotos
 *
 * Re-upload das imagens (newsletter + social), `close-poll.ts`, atualização do
 * broadcast do Kit já existente, republicação da página do site e
 * re-sincronização da semanal de frio já agendada — só os que o estado local
 * mostra que já tinham sido publicados. Sem `--run-remote` o CLI só imprime os
 * comandos, na ordem: esses passos mexem em envio e página públicos (critério
 * 1 do "Perguntar é exceção"), então rodar é escolha explícita de quem chama.
 * Com `--run-remote` roda em sequência, para no primeiro que falhar e grava o
 * estado de cada um no relatório; rodar de novo (mesmo `--from`/`--to`)
 * retoma do passo que falhou.
 *
 * ## Edição já agendada (#12662)
 *
 * O horário de envio fica em ISO no estado (`scheduled_at`), e a troca de ID
 * não o move: o PATCH do Kit repõe o `send_at` antigo e os posts na fila do
 * Worker disparam no dia e com o texto antigos. Com broadcast do Kit ou post
 * social `scheduled`, o CLI lista cada um com o comando de reagendamento, e
 * `--run-remote` é RECUSADO (exit 2, nada escrito) até quem chama reagendar e
 * repetir com `--ack-scheduled`.
 *
 * ## Desagendar antes da troca (#12688)
 *
 * `--apply --unschedule` desfaz o agendamento ANTES da parte local: apaga da
 * fila do Worker os posts `scheduled` com `worker_queue_key` (Instagram,
 * Threads, LinkedIn) e tira o `send_at` do broadcast do Kit (relido). O
 * estado local passa a `deleted`/`draft`, e a Etapa 5/6 na pasta nova
 * reagenda com o dia e o texto novos (a semanal de frio acompanha o
 * principal desagendado no passo `kit-semanal-frio`). Buffer (X) e Brevo
 * seguem manuais e continuam no aviso acima. Item que falhou ⇒ exit 1, nada
 * renumerado; 404 no Worker (post pode ter disparado) mantém o aviso e a
 * exigência de `--ack-scheduled`.
 *
 * Exit: 0 ok; 1 passo remoto falhou, desagendamento falhou ou erro na parte
 * local; 2 argumento ou precondição (destino existe, origem ausente, agendado
 * sem `--ack-scheduled`).
 */
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { editionDir } from "./lib/edition-paths.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { deleteFromWorkerQueue } from "./lib/worker-queue-client.ts";
import { updateBroadcast } from "./lib/kit-broadcasts.ts";
import { getBroadcast } from "./lib/kit-client.ts";
import {
  buildRemoteSteps,
  detectScheduledSends,
  globalStoresRefusal,
  leftOutItems,
  liveEditionLock,
  mergeStepStates,
  scanGlobalStores,
  planRenumber,
  readRenumberReport,
  renumberLocal,
  scanLocal,
  writeRenumberReport,
  unscheduleSends,
  type RemoteStep,
  type RemoteStepState,
  type UnscheduleDeps,
} from "./lib/renumber-edition.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface RenumberCliDeps {
  root: string;
  log: (msg: string) => void;
  nowIso: () => string;
  /** Roda `npx tsx {argv}` com cwd na raiz; devolve o exit code. */
  runStep: (argv: string[], cwd: string) => number;
}

export interface RenumberCliOptions {
  from: string;
  to: string;
  apply: boolean;
  runRemote: boolean;
  /** #12662 — quem chama já reagendou (ou vai reagendar) o que estava agendado. */
  ackScheduled?: boolean;
}

export function formatStep(s: RemoteStep): string {
  return `npx tsx ${s.argv.map((a) => (/[\s"'$`]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
}

/**
 * #12688 — `--unschedule`: desagenda Kit + fila do Worker antes da troca.
 * Devolve 0 pra seguir com a renumeração; 1 se algum item falhou (nada
 * renumerado); o código do `planRenumber` se a precondição falhar.
 */
export async function runUnschedule(
  opts: { from: string; to: string },
  deps: { root: string; log: (msg: string) => void; unschedule: UnscheduleDeps },
): Promise<number> {
  const plan = planRenumber(deps.root, opts.from, opts.to);
  if (!plan.ok) {
    deps.log(`ERRO: ${plan.reason}`);
    return plan.code;
  }
  // #12691 — a troca seria recusada depois: não desagendar nada à toa.
  const refusal = plan.resume ? null : globalStoresRefusal(scanGlobalStores(deps.root, opts.from, opts.to), opts.to);
  if (refusal) {
    deps.log(`ERRO: ${refusal}`);
    return 2;
  }
  const outcomes = await unscheduleSends(plan.resume ? plan.toDir : plan.fromDir, deps.unschedule);
  if (outcomes.length === 0) deps.log("--unschedule: nada agendado.");
  for (const o of outcomes) deps.log(`--unschedule [${o.result}] ${o.what}: ${o.detail}`);
  if (outcomes.some((o) => o.result === "failed")) {
    deps.log("ERRO: desagendamento incompleto — nada renumerado. Corrigir e repetir o mesmo comando (o que já saiu não é refeito).");
    return 1;
  }
  return 0;
}

export function runRenumberEdition(opts: RenumberCliOptions, deps: RenumberCliDeps): number {
  const { root, log } = deps;
  const plan = planRenumber(root, opts.from, opts.to);
  if (!plan.ok) {
    log(`ERRO: ${plan.reason}`);
    return plan.code;
  }
  const newDirRel = editionDir(opts.to);

  // #12691 — trava viva de outra sessão: a pasta some debaixo dela.
  const lock = liveEditionLock(plan.resume ? plan.toDir : plan.fromDir, Date.parse(deps.nowIso()));
  if (lock) {
    log(
      `ATENÇÃO: edition-lock vivo (sessão ${lock.session_id}, host ${lock.host || "?"}, Stage ${lock.stage}, heartbeat ${lock.heartbeat_at}). ` +
        `A trava vai junto pra ${newDirRel}; se não é esta sessão, a outra perde o diretório — encerrá-la antes.`,
    );
  }

  // #12691 — stores globais de data/: conflito ou store ilegível recusa antes de tudo.
  const globalChanges = plan.resume ? [] : scanGlobalStores(root, opts.from, opts.to);
  const globalRefusal = globalStoresRefusal(globalChanges, opts.to);
  if (globalRefusal) {
    log(`ERRO: ${globalRefusal}`);
    return 2;
  }
  const printLeftOut = (prefix: string) => {
    log(`${prefix}fica fora (à mão, depois da troca):`);
    for (const item of leftOutItems(opts.from, opts.to)) log(`  - ${item}`);
  };

  // #12662 — envio/post já agendado sai no dia antigo: nenhum passo o move.
  const scheduled = detectScheduledSends(plan.resume ? plan.toDir : plan.fromDir, newDirRel);
  if (scheduled.length > 0) {
    log(`ATENÇÃO: ${scheduled.length} envio(s)/post(s) já AGENDADO(S) com o horário de ${opts.from} — a renumeração não move o horário:`);
    for (const s of scheduled) log(`  ${s.what} @ ${s.scheduled_at ?? "?"} → reagendar: ${s.reschedule}`);
    if (opts.runRemote && !opts.ackScheduled) {
      log("ERRO: --run-remote recusado: reagende os itens acima e repita com --ack-scheduled (ou rode --apply sem --run-remote e siga os passos à mão).");
      return 2;
    }
  }

  if (!opts.apply) {
    if (plan.resume) {
      log(`[dry-run] parte local já feita (${relative(root, plan.toDir)} tem o relatório de ${opts.from} → ${opts.to}).`);
    } else {
      const scan = scanLocal(plan.fromDir, opts.from, opts.to);
      log(`[dry-run] moveria ${relative(root, plan.fromDir)} → ${newDirRel}.`);
      log(`[dry-run] reescreveria ${scan.rewritten.length} arquivo(s) (${scan.rewritten.reduce((n, f) => n + f.count, 0)} troca(s)); ${scan.preserved} img-${opts.from}-… preservado(s).`);
      for (const r of scan.renames) log(`[dry-run] renomearia ${r.from} → ${r.to}`);
      if (scan.publicImages) log(`[dry-run] moveria 06-public-images.json pra _internal/_forensic/06-public-images.${opts.from}.json.`);
      for (const g of globalChanges) log(`[dry-run] reescreveria ${g.path}: ${g.count} entrada(s) de ${opts.from} → ${opts.to}.`);
    }
    // Na dry-run de execução nova o estado vive na pasta de origem.
    const stateRoot = plan.resume ? newDirRel : relative(root, plan.fromDir);
    const steps = buildRemoteSteps(root, stateRoot, opts.to).map((s) => ({
      ...s,
      argv: s.argv.map((a) => (a === stateRoot ? newDirRel : a)),
    }));
    log("[dry-run] passos remotos depois do --apply:");
    for (const s of steps) log(`  ${formatStep(s)}   # ${s.why}`);
    printLeftOut("[dry-run] ");
    return 0;
  }

  let report = plan.resume ? readRenumberReport(plan.toDir) : null;
  if (!plan.resume) {
    try {
      report = renumberLocal(root, opts.from, opts.to, deps.nowIso());
    } catch (e) {
      log(`ERRO na parte local: ${(e as Error).message}`);
      return 1;
    }
    log(
      `${report.from_dir} → ${report.to_dir}: ${report.rewritten_files.length} arquivo(s) reescrito(s), ` +
        `${report.renamed_paths.length} renomeado(s), ${report.preserved_img_refs} img-${opts.from}-… preservado(s).`,
    );
    for (const g of report.global_stores ?? []) log(`${g.path}: ${g.count} entrada(s) de ${opts.from} → ${opts.to}.`);
    printLeftOut("");
  } else {
    log(`retomando: parte local já feita em ${newDirRel}.`);
  }
  if (!report) {
    log("ERRO: relatório da renumeração ilegível.");
    return 1;
  }

  const steps = buildRemoteSteps(root, newDirRel, opts.to);
  const states: RemoteStepState[] = mergeStepStates(steps, report.remote_steps ?? []);
  report = { ...report, remote_steps: states };
  writeRenumberReport(plan.toDir, report);

  if (!opts.runRemote) {
    log("passos remotos (rodar na ordem, ou repetir com --run-remote):");
    for (const s of steps) {
      const st = states.find((x) => x.id === s.id)!;
      log(`  [${st.status}] ${formatStep(s)}   # ${s.why}`);
    }
    return 0;
  }

  for (const s of steps) {
    const st = states.find((x) => x.id === s.id)!;
    if (st.status === "done") {
      log(`[done] ${s.id} — já concluído numa rodada anterior.`);
      continue;
    }
    log(`[run] ${formatStep(s)}`);
    const code = deps.runStep(s.argv, root);
    st.at = deps.nowIso();
    st.exit_code = code;
    st.status = code === 0 ? "done" : "failed";
    writeRenumberReport(plan.toDir, report);
    if (code !== 0) {
      log(`ERRO: ${s.id} saiu ${code} — parado aqui. Corrigir e rodar de novo o mesmo comando retoma deste passo.`);
      return 1;
    }
  }
  log(`renumeração ${opts.from} → ${opts.to} concluída (relatório em ${newDirRel}/_internal/renumber-edition.json).`);
  return 0;
}

/** Chamadas reais do `--unschedule`. Só o CLI as usa; os testes injetam fakes. */
function productionUnscheduleDeps(): UnscheduleDeps {
  return {
    nowIso: () => new Date().toISOString(),
    deleteWorkerEntry: async (key) => {
      const url = process.env.DIARIA_LINKEDIN_CRON_URL ?? "";
      const token = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
      if (!url || !token) throw new Error("DIARIA_LINKEDIN_CRON_URL/DIARIA_LINKEDIN_CRON_TOKEN ausentes no env");
      return deleteFromWorkerQueue(url, token, key, "renumber-edition");
    },
    unscheduleKit: async (id) => {
      const before = await getBroadcast(id);
      if (before.status === "completed" || before.status === "sending") {
        return { ok: false, message: `já ${before.status} no Kit — não dá pra desagendar` };
      }
      await updateBroadcast(id, { send_at: null });
      const after = await getBroadcast(id);
      if (after.send_at != null) return { ok: false, message: `releitura ainda mostra send_at=${after.send_at}` };
      return { ok: true, message: "send_at: null confirmado por releitura" };
    },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const log = (msg: string) => process.stderr.write(`[renumber-edition] ${msg}\n`);
  let from: string | undefined;
  let to: string | undefined;
  try {
    from = getStringArg(argv, "from");
    to = getStringArg(argv, "to");
  } catch (e) {
    log(`ERRO: ${(e as Error).message}`);
    process.exitCode = 2;
    return;
  }
  if (!from || !to) {
    log("uso: npx tsx scripts/renumber-edition.ts --from AAMMDD --to AAMMDD [--apply] [--unschedule] [--run-remote] [--ack-scheduled]");
    process.exitCode = 2;
    return;
  }
  if (hasFlag(argv, "run-remote") && !hasFlag(argv, "apply")) {
    log("ERRO: --run-remote exige --apply.");
    process.exitCode = 2;
    return;
  }
  if (hasFlag(argv, "unschedule")) {
    if (!hasFlag(argv, "apply")) {
      log("ERRO: --unschedule exige --apply.");
      process.exitCode = 2;
      return;
    }
    loadProjectEnv(ROOT);
    const code = await runUnschedule({ from, to }, { root: ROOT, log, unschedule: productionUnscheduleDeps() });
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
  }
  process.exitCode = runRenumberEdition(
    { from, to, apply: hasFlag(argv, "apply"), runRemote: hasFlag(argv, "run-remote"), ackScheduled: hasFlag(argv, "ack-scheduled") },
    {
      root: ROOT,
      log,
      nowIso: () => new Date().toISOString(),
      runStep: (stepArgv, cwd) => spawnSync("npx", ["tsx", ...stepArgv], { cwd, stdio: "inherit" }).status ?? 1,
    },
  );
}

if (isMainModule(import.meta.url)) void main();
