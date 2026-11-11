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
 * vira alarme e o dono indicado no item publica. O tick também nunca grava no
 * banco: o arquivo vem pelo OneDrive, e uma escrita daqui disputaria a das
 * sessões que registram os itens. A releitura que marca `publicado` é o
 * `npx tsx scripts/agendamentos.ts verificar`, rodado pela sessão do dono
 * (`scripts/lib/diaria/agendamentos-verificar.ts`; só o YouTube tem leitor).
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
 * Exit 0 = avaliação (e alarme, se houver) ok; 1 = banco ilegível ou alarme
 * não registrado.
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
  loadAgendamentos,
} from "./lib/diaria/agendamentos.ts";
import { avaliarAgendamentosComEnvio, leitoresPadrao, leituraSemAlarme } from "./lib/diaria/agendamentos-verificar.ts";
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

  let banco;
  try {
    banco = loadAgendamentos(agendamentosPath(ROOT));
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
    leitores: leitoresPadrao({ deps: defaultYouTubeUploadDeps, env: process.env }),
  });
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
