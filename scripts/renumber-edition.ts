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
 * reagenda com o dia e o texto novos. A semanal de frio agendada é
 * desagendada antes do principal (#12720), e volta junto com ele na Etapa 6
 * da pasta nova, mesmo que a edição tenha deixado de ser de segunda (#12725).
 * Buffer (X) e Brevo seguem manuais e continuam no aviso acima. Item que
 * falhou ⇒ exit 1, nada renumerado; 404 no Worker (post pode ter disparado)
 * mantém o aviso e a exigência de `--ack-scheduled`. As recusas de
 * `--video-dir` inválido e de `--run-remote` sem `--ack-scheduled` com item
 * manual agendado vêm ANTES de qualquer desagendamento (#12721).
 *
 * Stores globais depois do `mv` (#12719): falha ao mover a pasta deixa os
 * stores intactos (rodar de novo é execução nova); falha num store depois do
 * `mv` fica em `global_stores_pending` no relatório e a retomada termina. A
 * retomada recusa (exit 2, nada escrito no store) se o store pendente ganhou
 * entrada do ID novo ou se as entradas do ID antigo mudaram desde a tentativa
 * anterior (impressão digital no relatório, #12726).
 *
 * Falha no principal depois de a semanal de frio sair da agenda (#12727): o
 * `failed` do principal diz que a semanal ficou `created_unverified` e dá o
 * comando que a reagenda se a troca for abandonada.
 *
 * ## Vídeo (#12713)
 *
 * Origem só com o vídeo (`_internal/video-montagem/` e `diaria-comentada-{de}*`
 * na raiz) e destino já existente — o caso de quando a montagem rodou com o
 * AAMMDD errado: em vez de recusar, move só o vídeo pra edição de destino,
 * com a mesma troca de ID no conteúdo (o `"edition"` do `blocks.json`, que o
 * `build` confere, e os caminhos `YouTube/{de}/{de}_…` em `source.json`,
 * `plan.json`, `audio-tratado.meta.json`) e nos nomes. Recusa se a origem tem
 * qualquer outra coisa ou se o destino já tem vídeo. Sem passo remoto (a
 * edição de destino é outra); relatório em
 * `{destino}/_internal/video-montagem/renumber-video.json`.
 *
 * `--video-dir PASTA` (nos dois modos): a pasta `YouTube/{de}` pelo caminho
 * local (Drive montado). Troca o ID nos nomes (`{de}_audio_tratado-*.wav`,
 * `{de}_titulo_vertical*.png`, `{de} - previa *.mp4`) e no conteúdo dos XMLs
 * (`pathurl`), SRT e JSON, com a mesma borda (o bruto `20261112_*.mp4` fica).
 * A pasta em si não é renomeada — continua na lista "fica fora", junto com o
 * Doc do roteiro e o cache local do vídeo.
 *
 * Exit: 0 ok; 1 passo remoto falhou, desagendamento falhou ou erro na parte
 * local; 2 argumento ou precondição (destino existe, origem ausente, agendado
 * sem `--ack-scheduled`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
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
  completePendingGlobalStores,
  detectScheduledSends,
  GlobalStoreRefusalError,
  pendingGlobalStoresRefusal,
  globalStoresRefusal,
  leftOutItems,
  liveEditionLock,
  mergeStepStates,
  scanGlobalStores,
  planRenumber,
  readRenumberReport,
  renumberLocal,
  scanLocal,
  scanVideoMerge,
  scanVideoOutDir,
  applyVideoOutDir,
  planVideoMerge,
  renumberVideoMerge,
  writeRenumberReport,
  unscheduleSends,
  type RemoteStep,
  type RemoteStepState,
  type UnscheduleDeps,
  type VideoMergePlan,
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
  /** #12713 — pasta local `YouTube/{AAMMDD}` do vídeo (Drive montado): troca nomes e XMLs dentro dela. */
  videoDir?: string;
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
  opts: { from: string; to: string; runRemote?: boolean; ackScheduled?: boolean; videoDir?: string },
  deps: { root: string; log: (msg: string) => void; unschedule: UnscheduleDeps },
): Promise<number> {
  // #12721 — as recusas que o `runRenumberEdition` faria DEPOIS vêm antes de
  // qualquer efeito externo: senão o Kit vira rascunho e os posts saem da fila
  // do Worker, e a troca em seguida recusa com exit 2 (nada renumerado).
  const videoDirError = videoDirRefusal(deps.root, opts.videoDir);
  if (videoDirError) {
    deps.log(`ERRO: ${videoDirError}`);
    return 2;
  }
  const plan = planRenumber(deps.root, opts.from, opts.to);
  if (!plan.ok) {
    // #12713 — origem só de vídeo: nada agendado nela, segue pra mescla.
    if (planVideoMerge(deps.root, opts.from, opts.to).ok) {
      deps.log("--unschedule: origem só tem vídeo, nada a desagendar.");
      return 0;
    }
    deps.log(`ERRO: ${plan.reason}`);
    return plan.code;
  }
  // #12691 — a troca seria recusada depois: não desagendar nada à toa. Na
  // retomada, a recusa dos stores pendentes (#12726).
  const priorReport = plan.resume ? readRenumberReport(plan.toDir) : null;
  const refusal = plan.resume
    ? priorReport
      ? pendingGlobalStoresRefusal(deps.root, priorReport)
      : null
    : globalStoresRefusal(scanGlobalStores(deps.root, opts.from, opts.to), opts.to);
  if (refusal) {
    deps.log(`ERRO: ${refusal}`);
    return 2;
  }
  const stateDir = plan.resume ? plan.toDir : plan.fromDir;
  // #12721 — o que o `--unschedule` não tira da agenda (Brevo, Buffer/X)
  // continua no aviso, e o `--run-remote` seria recusado sem --ack-scheduled.
  if (opts.runRemote && !opts.ackScheduled) {
    const manual = detectScheduledSends(stateDir, editionDir(opts.to)).filter((s) => !s.auto_unschedule);
    if (manual.length > 0) {
      for (const s of manual) deps.log(`  ${s.what} @ ${s.scheduled_at ?? "?"} → ${s.reschedule}`);
      deps.log(
        `ERRO: ${manual.length} item(ns) agendado(s) acima ficam agendados depois do --unschedule (sem caminho automático): ` +
          "--run-remote seria recusado. Nada desagendado. Reagende-os e repita com --ack-scheduled (ou rode sem --run-remote).",
      );
      return 2;
    }
  }
  const outcomes = await unscheduleSends(stateDir, deps.unschedule);
  if (outcomes.length === 0) deps.log("--unschedule: nada agendado.");
  for (const o of outcomes) deps.log(`--unschedule [${o.result}] ${o.what}: ${o.detail}`);
  if (outcomes.some((o) => o.result === "failed")) {
    deps.log("ERRO: desagendamento incompleto — nada renumerado. Corrigir e repetir o mesmo comando (o que já saiu não é refeito).");
    return 1;
  }
  return 0;
}

/**
 * #12713 — `--video-dir`: a pasta `YouTube/{AAMMDD}` do vídeo, pelo caminho
 * local (Drive montado). Dry-run lista; `apply` troca. Devolve `null` se ok,
 * senão o exit code. `done` diz se os arquivos de dentro ficaram resolvidos.
 */
function handleVideoDir(opts: RenumberCliOptions, deps: RenumberCliDeps, apply: boolean): { code: number | null; done: boolean } {
  if (!opts.videoDir) return { code: null, done: false };
  const dir = resolve(deps.root, opts.videoDir);
  const tag = apply ? "" : "[dry-run] ";
  try {
    const scan = apply ? applyVideoOutDir(dir, opts.from, opts.to) : scanVideoOutDir(dir, opts.from, opts.to);
    const trocas = scan.rewritten.reduce((n, f) => n + f.count, 0);
    deps.log(
      apply
        ? `--video-dir ${dir}: ${scan.rewritten.length} arquivo(s) reescrito(s) (${trocas} troca(s)), ${scan.renames.length} renomeado(s).`
        : `${tag}--video-dir ${dir}: reescreveria ${scan.rewritten.length} arquivo(s) (${trocas} troca(s)).`,
    );
    for (const r of scan.renames) deps.log(`${tag}--video-dir ${apply ? "renomeado" : "renomearia"} ${r.from} → ${r.to}`);
    return { code: null, done: apply };
  } catch (e) {
    deps.log(`ERRO no --video-dir: ${(e as Error).message}`);
    return { code: 1, done: false };
  }
}

/** #12713 — a origem só tem o vídeo e o destino já existe: mescla só o vídeo. */
function runVideoMerge(
  opts: RenumberCliOptions,
  deps: RenumberCliDeps,
  vm: Extract<VideoMergePlan, { ok: true }>,
): number {
  const printLeftOut = (prefix: string, videoDirDone: boolean) => {
    deps.log(`${prefix}fica fora (à mão, depois da troca):`);
    for (const item of leftOutItems(opts.from, opts.to, { videoDirDone })) deps.log(`  - ${item}`);
  };
  const toRel = relative(deps.root, vm.toDir);
  if (vm.done) {
    deps.log(`mescla do vídeo ${opts.from} → ${opts.to} já feita (${toRel}/_internal/video-montagem/renumber-video.json).`);
    if (!opts.apply) {
      const v = handleVideoDir(opts, deps, false);
      printLeftOut("[dry-run] ", false);
      return v.code ?? 0;
    }
    const v = handleVideoDir(opts, deps, true);
    printLeftOut("", v.done);
    return v.code ?? 0;
  }
  const lock = liveEditionLock(vm.fromDir, Date.parse(deps.nowIso()));
  if (lock) {
    deps.log(
      `ATENÇÃO: edition-lock vivo em ${relative(deps.root, vm.fromDir)} (sessão ${lock.session_id}, host ${lock.host || "?"}, Stage ${lock.stage}). ` +
        "Se uma montagem está rodando nessa pasta, encerrá-la antes.",
    );
  }
  const note = `origem ${relative(deps.root, vm.fromDir)} só tem vídeo e ${toRel} já existe: mescla só o vídeo (#12713), sem passo remoto (a edição ${opts.to} é outra).`;
  if (!opts.apply) {
    const scan = scanVideoMerge(vm, opts.from, opts.to);
    deps.log(`[dry-run] ${note}`);
    for (const m of scan.moved) deps.log(`[dry-run] moveria ${m.from} → ${toRel}/${m.to}`);
    deps.log(`[dry-run] reescreveria ${scan.rewritten.length} arquivo(s) (${scan.rewritten.reduce((n, f) => n + f.count, 0)} troca(s)).`);
    for (const r of scan.renames) deps.log(`[dry-run] renomearia ${r.from} → ${r.to}`);
    const v = handleVideoDir(opts, deps, false);
    printLeftOut("[dry-run] ", false);
    return v.code ?? 0;
  }
  let report;
  try {
    report = renumberVideoMerge(deps.root, opts.from, opts.to, deps.nowIso());
  } catch (e) {
    deps.log(`ERRO na mescla do vídeo: ${(e as Error).message}`);
    return 1;
  }
  deps.log(note);
  deps.log(
    `${report.from_dir} → ${report.to_dir}: ${report.moved.length} item(ns) movido(s), ${report.rewritten_files.length} arquivo(s) reescrito(s), ` +
      `${report.renamed_paths.length} renomeado(s)${report.removed_from_dir ? `; ${report.from_dir} removida (vazia)` : ""}.`,
  );
  const v = handleVideoDir(opts, deps, true);
  printLeftOut("", v.done);
  return v.code ?? 0;
}

/** `--video-dir` inexistente ou que não é pasta ⇒ motivo da recusa (exit 2); `null` = ok ou ausente. */
export function videoDirRefusal(root: string, videoDir: string | undefined): string | null {
  if (!videoDir) return null;
  const dir = resolve(root, videoDir);
  return existsSync(dir) && statSync(dir).isDirectory() ? null : `--video-dir ${dir} não existe ou não é pasta.`;
}

export function runRenumberEdition(opts: RenumberCliOptions, deps: RenumberCliDeps): number {
  const { root, log } = deps;
  const videoDirError = videoDirRefusal(root, opts.videoDir);
  if (videoDirError) {
    log(`ERRO: ${videoDirError}`);
    return 2;
  }
  const plan = planRenumber(root, opts.from, opts.to);
  if (!plan.ok) {
    // #12713 — destino existente com origem só de vídeo: mescla só o vídeo.
    const vm = planVideoMerge(root, opts.from, opts.to);
    if (vm.ok) return runVideoMerge(opts, deps, vm);
    log(`ERRO: ${plan.reason}`);
    if (vm.reason) log(`ERRO (mescla do vídeo, #12713): ${vm.reason}`);
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
  const printLeftOut = (prefix: string, videoDirDone = false) => {
    log(`${prefix}fica fora (à mão, depois da troca):`);
    for (const item of leftOutItems(opts.from, opts.to, { videoDirDone })) log(`  - ${item}`);
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
      const prior = readRenumberReport(plan.toDir);
      for (const p of prior?.global_stores_pending ?? []) {
        log(`[dry-run] store global pendente da tentativa anterior: ${p} (o --apply termina).`);
      }
      // #12726 — o --apply recusaria a retomada (exit 2): avisar já no dry-run.
      const pendingRefusal = prior ? pendingGlobalStoresRefusal(root, prior) : null;
      if (pendingRefusal) log(`[dry-run] ERRO: o --apply recusaria: ${pendingRefusal}`);
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
    const v = handleVideoDir(opts, deps, false);
    printLeftOut("[dry-run] ");
    return v.code ?? 0;
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
  } else {
    log(`retomando: parte local já feita em ${newDirRel}.`);
    // #12719 — store global que ficou pendente na tentativa anterior.
    if (report && (report.global_stores_pending ?? []).length > 0) {
      try {
        const before = new Set((report.global_stores ?? []).map((g) => g.path));
        report = completePendingGlobalStores(root, plan.toDir, report);
        for (const g of report.global_stores ?? []) {
          if (!before.has(g.path)) log(`${g.path}: ${g.count} entrada(s) de ${opts.from} → ${opts.to} (pendente da tentativa anterior).`);
        }
      } catch (e) {
        log(`ERRO nos stores globais pendentes: ${(e as Error).message}`);
        // #12726 — store mudado desde a tentativa anterior: precondição, não falha transitória.
        return e instanceof GlobalStoreRefusalError ? 2 : 1;
      }
    }
  }
  // #12713 — a pasta do vídeo no Drive montado, depois da parte local (falha
  // aqui não desfaz a troca; rodar de novo retoma e repete só o --video-dir).
  const videoDir = handleVideoDir(opts, deps, true);
  if (!plan.resume) printLeftOut("", videoDir.done);
  if (videoDir.code !== null) return videoDir.code;
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
  let videoDir: string | undefined;
  try {
    from = getStringArg(argv, "from");
    to = getStringArg(argv, "to");
    videoDir = getStringArg(argv, "video-dir");
  } catch (e) {
    log(`ERRO: ${(e as Error).message}`);
    process.exitCode = 2;
    return;
  }
  if (!from || !to) {
    log("uso: npx tsx scripts/renumber-edition.ts --from AAMMDD --to AAMMDD [--apply] [--unschedule] [--run-remote] [--ack-scheduled] [--video-dir PASTA]");
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
    const code = await runUnschedule(
      { from, to, runRemote: hasFlag(argv, "run-remote"), ackScheduled: hasFlag(argv, "ack-scheduled"), videoDir },
      { root: ROOT, log, unschedule: productionUnscheduleDeps() },
    );
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
  }
  process.exitCode = runRenumberEdition(
    { from, to, apply: hasFlag(argv, "apply"), runRemote: hasFlag(argv, "run-remote"), ackScheduled: hasFlag(argv, "ack-scheduled"), videoDir },
    {
      root: ROOT,
      log,
      nowIso: () => new Date().toISOString(),
      runStep: (stepArgv, cwd) => spawnSync("npx", ["tsx", ...stepArgv], { cwd, stdio: "inherit" }).status ?? 1,
    },
  );
}

if (isMainModule(import.meta.url)) void main();
