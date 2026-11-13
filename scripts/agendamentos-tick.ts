#!/usr/bin/env node
/**
 * scripts/agendamentos-tick.ts (#12774)
 *
 * Consumidor do banco de agendamentos (`data/agendamentos/banco.json`), rodado
 * de hora em hora no `300` pela task `Diaria-Agendamentos-Tick`
 * (`scripts/lib/scheduled-tasks.ts`). Lógica pura em
 * `scripts/lib/diaria/agendamentos.ts`.
 *
 * O que faz:
 *   - lista os itens `pronto` já no horário (o que um publicador automático
 *     pegaria) e os futuros;
 *   - item em aberto passado `alvo + 60 min`, ou item `falhou`, vira achado:
 *     issue de alarme via `notifyEditor` (`acao`), fingerprint do conjunto;
 *     a issue de um conjunto anterior fecha sozinha quando o conjunto muda ou
 *     zera (`closeSupersededAlarmIssues`, padrão do `on-hold-vencimento-alarm`).
 *
 * O que NÃO faz (premissa da #12774): publicar. Nenhum publicador está ligado
 * ao banco ainda, e um publicador só entra aqui quando grava o resultado
 * RELIDO da plataforma (#573), nunca o 2xx da mutação. Até lá o item vencido
 * vira alarme e o dono indicado no item publica. Antes da avaliação, o tick
 * executa a verificação de `agendamentos.ts verificar`: grava `publicado`
 * somente após todos os destinos confirmarem na plataforma, usando a revisão
 * otimista do banco (o servidor é escritor do banco desde o #12774; corrida
 * com uma sessão relê e repete, e a gravação recusada não pula o alarme,
 * #12970). `--dry-run` também verifica, não grava, e avalia o mesmo banco que
 * a execução real (com os confirmados em memória). Destinos sem leitor
 * continuam `agendado`; falhas de leitura preservam o alarme e saem com
 * código 2 (sucesso para o systemd, `successExitCodes: [2]`).
 *
 * Item `agendado` vencido com o envio registrado no corte em todos os
 * destinos sem leitor (`published`/`scheduled`) e relido no ar nos destinos
 * com leitor NÃO vira achado (#12825, decisão do editor, opção a): sem isso
 * todo vertical 2 enviado certo alarmava, porque destino sem leitor deixa o
 * item `agendado` para sempre. Falta de registro, `send_unknown` ou leitura
 * que não confirma (inclusive erro de credencial/rede) mantêm o alarme. Para
 * isso o tick relê a plataforma (só leitura, só os `agendado` vencidos).
 *
 * Uso:
 *   npx tsx scripts/agendamentos-tick.ts            # avalia e alarma
 *   npx tsx scripts/agendamentos-tick.ts --dry-run  # avalia e imprime, sem issue/e-mail
 *   npx tsx scripts/agendamentos-tick.ts --to email@x
 *
 * Exit 0 = avaliação (e alarme, se houver) ok; 1 = banco ilegível, gravação
 * recusada depois da nova tentativa (o alarme já foi avaliado) ou alarme não
 * registrado; 2 = alguma releitura da plataforma falhou.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCliAction, getArg, hasFlag, isMainModule, type CliSpec } from "./lib/cli-args.ts";
import { closeSupersededAlarmIssues } from "./lib/alarm-issues.ts";
import { notifyEditor } from "./lib/editor-notify.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { logEvent } from "./lib/run-log.ts";
import {
  agendamentosAlarmFingerprint,
  agendamentosPath,
  buildAgendamentosAlarm,
  type AgendamentosBanco,
} from "./lib/diaria/agendamentos.ts";
import { avaliarAgendamentosComEnvio, leitoresPadrao, leituraSemAlarme, type EnvioRegistradoItem } from "./lib/diaria/agendamentos-verificar.ts";
import { linhasVerificacao, verificarEMarcarBanco, type CliIo } from "./agendamentos.ts";
import type { LeitorDestino } from "./lib/diaria/agendamentos-verificar.ts";
import { defaultYouTubeUploadDeps } from "./lib/diaria/youtube-upload.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[agendamentos-tick]";
export const AGENDAMENTOS_ALARM_CHECK = "agendamentos-vencidos";

export const CLI_SPEC: CliSpec = {
  script: "scripts/agendamentos-tick.ts",
  booleans: ["dry-run"],
  values: ["to"],
};

function closeSuperseded(fingerprint: string | null): void {
  const res = closeSupersededAlarmIssues(AGENDAMENTOS_ALARM_CHECK, fingerprint, ROOT);
  if (!res.listed) {
    console.warn(`${LOG_PREFIX} não foi possível listar issues de alarme abertas — fechamento automático adiado.`);
    return;
  }
  for (const n of res.closed) console.log(`${LOG_PREFIX} issue #${n} fechada (conjunto de achados mudou).`);
  for (const n of res.failed) console.error(`${LOG_PREFIX} falha ao fechar #${n} — retry na próxima execução.`);
}

/** #12875: um aviso por execução, incluindo o motivo que impediu a dispensa. */
export function avisarLeituraIndisponivel(envios: readonly EnvioRegistradoItem[], warn: (message: string) => void = console.warn): void {
  const motivos = new Set<string>();
  for (const envio of envios) {
    if (envio.semAlarme) continue;
    for (const leitura of envio.leituras) {
      if (leitura.status === "erro" || leitura.status === "sem-registro" ||
          (leitura.destino === "youtube_shorts" && leitura.status === "sem-leitor")) {
        motivos.add(`${envio.item.id}: ${leitura.motivo}`);
      }
    }
  }
  if (motivos.size) {
    warn(`${LOG_PREFIX} leitor do YouTube ou registro do corte indisponível, dispensa não aplicada — alarme preservado. ${[...motivos].join("; ")}`);
  }
}

/**
 * Verifica sem publicar/agendar e devolve o banco que o alarme avalia: o
 * gravado, ou (dry-run, gravação recusada) o mesmo banco em memória, com os
 * confirmados em `publicado`. Assim o dry-run alarma o mesmo que a execução
 * real (#12970). Banco ilegível lança (`avaliação interrompida`).
 *
 * #12970: a corrida com uma sessão que grava o banco no meio do tick (revisão
 * mudou) nunca pula o alarme. `verificarEMarcarBanco` relê e repete a
 * gravação; se ainda assim não grava, o alarme é avaliado com o banco em
 * memória e o código sai 1 (a unit fica `failed`: gravação que nunca sai
 * precisa aparecer).
 *
 * Código: 0 ok; 1 gravação recusada (avaliou mesmo assim); 2 alguma releitura
 * da plataforma falhou (alarme preservado; `successExitCodes: [2]` na task).
 */
export async function verificarBancoDoTick(
  io: CliIo,
  dryRun: boolean,
  leitores: Readonly<Record<string, LeitorDestino>>,
  deps: { save?: (path: string, banco: AgendamentosBanco) => AgendamentosBanco } = {},
): Promise<{ banco: AgendamentosBanco; code: 0 | 1 | 2 }> {
  let r;
  try {
    r = await verificarEMarcarBanco(agendamentosPath(io.root), { root: io.root, now: io.now, leitores }, { dryRun, err: io.err, save: deps.save });
  } catch (e) {
    throw new Error(`verificação do banco falhou; avaliação interrompida: ${(e as Error).message}`);
  }
  for (const line of linhasVerificacao(r, dryRun)) io.out(line);
  if (r.erroGravacao) {
    io.err(`${LOG_PREFIX} gravação do banco recusada depois de reler e repetir (${r.erroGravacao}); o alarme avalia o banco em memória (#12970)`);
    return { banco: r.banco, code: 1 };
  }
  return { banco: r.banco, code: r.comErro ? 2 : 0 };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cliExit = applyCliAction(argv, CLI_SPEC);
  if (cliExit !== null) {
    process.exitCode = cliExit;
    return;
  }
  loadProjectEnv(ROOT);
  const dryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const now = new Date();

  const leitores = leitoresPadrao({ deps: defaultYouTubeUploadDeps, env: process.env });
  let banco;
  try {
    const verificado = await verificarBancoDoTick(
      { root: ROOT, now, out: console.log, err: console.error }, dryRun, leitores,
    );
    banco = verificado.banco;
    if (verificado.code !== 0) process.exitCode = verificado.code;
  } catch (e) {
    // Banco ilegível não é "nada agendado": sair 1 deixa a unit `failed`,
    // que o `systemd-failed-units-alarm` já transforma em achado.
    console.error(`${LOG_PREFIX} banco ilegível — não avalia: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // #12825: `agendado` vencido com o envio registrado em todos os destinos sem
  // leitor (e relido no ar nos que têm) não vira achado. Relê só os vencidos.
  const { avaliacao: ev, envios } = await avaliarAgendamentosComEnvio(banco, {
    root: ROOT,
    now,
    leitores,
  });
  avisarLeituraIndisponivel(envios);
  console.log(
    `${LOG_PREFIX} itens=${banco.itens.length} futuros=${ev.futuros.length} no-horário(pronto)=${ev.aPublicar.length} achados=${ev.achados.length} agendado-com-envio-registrado=${ev.semAlarme.length}`,
  );
  for (const it of ev.semAlarme) {
    console.log(`${LOG_PREFIX} sem alarme: ${it.id} agendado, envio registrado em todos os destinos — falta só a marcação à mão (#12825).`);
  }
  for (const e of envios.filter((x) => !x.semAlarme)) {
    const pend = e.leituras.filter((l) => !leituraSemAlarme(l));
    console.log(`${LOG_PREFIX} alarma ${e.item.id}: ${pend.map((l) => `${l.destino}=${l.status}`).join(", ") || "destinos sem leitura"}.`);
  }
  for (const it of ev.aPublicar) {
    console.log(`${LOG_PREFIX} no horário: ${it.id} → ${it.destinos.join(",")} (dono: ${it.dono}) — sem publicador ligado, não publica (#573).`);
  }

  if (ev.achados.length === 0) {
    if (dryRun) console.log(`${LOG_PREFIX} --dry-run: nenhum achado; fecharia issues abertas deste alarme — gh NÃO chamado.`);
    else closeSuperseded(null);
    return;
  }

  const { subject, body } = buildAgendamentosAlarm(ev.achados);
  if (dryRun) {
    console.log(`${LOG_PREFIX} --dry-run: registraria alarme:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    return;
  }

  logEvent(
    {
      edition: null,
      stage: null,
      agent: "agendamentos-tick",
      level: "warn",
      message: `agendamentos-tick: ${ev.achados.length} achado(s)`,
      details: { ids: ev.achados.map((a) => `${a.item.id}:${a.tipo}`) },
    },
    ROOT,
  );

  const fingerprint = agendamentosAlarmFingerprint(ev.achados);
  const res = await notifyEditor(
    { check: AGENDAMENTOS_ALARM_CHECK, fingerprint, severity: "acao", subject, body, priority: "P2", labels: ["bug"],
      // Roda de hora em hora: sob `email_policy: "legacy"` não reenvia o mesmo conjunto a cada hora.
      legacyResendIntent: "dedupe-new-occurrences-only" },
    { cwd: ROOT, emailTo: toOverride },
  );
  if (res.issue?.action === "failed") {
    console.error(`${LOG_PREFIX} issue não criada/reusada: ${res.issue.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${LOG_PREFIX} alarme registrado (issue #${res.issue?.issueNumber ?? "?"}, ${res.issue?.action ?? "?"}).`);
  closeSuperseded(fingerprint);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro fatal:`, e);
    process.exitCode = 1;
  });
}
