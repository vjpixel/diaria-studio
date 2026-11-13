/**
 * scripts/lib/diaria/video-publish-authorization-alarm.ts (#12859)
 *
 * A task one-shot do vertical (dono `agent-scheduled-task` no `owners[]`, a
 * que a skill cria para um destino adiado, ex.: Threads ou LinkedIn pessoal
 * sem o timer do 300) roda `publish-shorts.ts --only {destino} --publish`
 * sozinha, no horário. Quando a autorização do plano (#12654) a recusa (plano
 * mudado depois da aprovação, autorização consumida ou invalidada, máquina
 * diferente), o destino não sai, e a recusa ficava só no log da task: ninguém
 * olhando.
 *
 * Aqui a recusa vira alarme pelo mesmo caminho dos alarmes do vídeo (os
 * timers do 300, `shorts-*-timer.ts`): `notifyEditor` (issue de alarme +
 * e-mail conforme a política), uma vez por motivo e edição, com o estado em
 * `_internal/.video-publish-authorization-alarm.json` e as mesmas regras de
 * `shorts-timer-alarm-state.ts` (entregue não repete; e-mail pendente é
 * reenviado). O alarme diz o destino, o campo que mudou e o comando para
 * reaprovar.
 *
 * Só a rodada da task alarma: a rodada interativa (a skill com o editor na
 * conversa) mostra a recusa na hora. "Rodada da task" = algum destino recusado
 * cujo dono aprovado é `agent-scheduled-task` e cujo comando é o desta
 * execução. A recusa continua sendo exit 2 e nada é enviado; o alarme não
 * muda isso, e falha do alarme nunca vira sucesso da rodada.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { notifyEditor, type NotifyEditorDeps } from "../editor-notify.ts";
import { alarmDelivery, alreadyAlarmed, emailPending, nextAlarmState } from "./shorts-timer-alarm-state.ts";
import type { AuthorizationRefusal, AuthorizationRefusalKind } from "./video-publish-authorization.ts";
import { commandMatchesOwner, commandShape, type VideoPlanPart } from "./video-publish-plan.ts";

export const AUTHORIZATION_ALARM_STATE_FILE = "_internal/.video-publish-authorization-alarm.json";
export const AUTHORIZATION_ALARM_CHECK = "video-publish-authorization-task";

/**
 * Puro: os destinos recusados que pertencem a uma task one-shot rodando ESTE
 * comando. Vazio = não é a rodada de uma task (sem alarme).
 */
export function oneShotTaskRefusals(refusals: readonly AuthorizationRefusal[], command: string): AuthorizationRefusal[] {
  return refusals.filter((r) => {
    const owner = r.approved_owner;
    if (!owner || owner.by !== "agent-scheduled-task" || !owner.command?.trim()) return false;
    // #12892: dono cujo comando não é de publisher (o passo guiado diferido, `/diaria-publica-video ... --so vertical`)
    // não identifica rodada nenhuma: o `commandMatchesOwner` sem `fallbackCommand` daria "casa" para qualquer comando.
    if (commandShape(owner.command).script === null) return false;
    return commandMatchesOwner(command, owner, r.destination) === null;
  });
}

const KIND_LABEL: Record<AuthorizationRefusalKind, string> = {
  missing: "sem autorização",
  consumed: "autorização já consumida (uso único)",
  invalidated: "autorização invalidada",
  "unknown-status": "autorização em estado desconhecido",
  "other-host": "autorização gravada em outra máquina",
  "owner-mismatch": "comando diferente do dono aprovado",
  "outside-plan": "destino fora do plano recalculado",
  "plan-changed": "o plano mudou depois da aprovação",
  timing: "instante fora do aprovado",
  unavailable: "registro de autorização indisponível (ilegível, formato inesperado ou lock)",
  "wrong-edition": "edição do comando, do plano e do registro não batem",
};

/** Puro: chave estável do alarme (uma por edição, parte, destinos e motivos). */
export function authorizationAlarmKey(part: VideoPlanPart, refusals: readonly AuthorizationRefusal[]): string {
  const parts = [...refusals].map((r) => `${r.destination}=${r.kind}`).sort();
  return `${part}:${parts.join(",")}`;
}

/** Puro: assunto e corpo do alarme, com os comandos já com a edição. */
export function buildAuthorizationRefusalAlarm(input: {
  aammdd: string;
  part: VideoPlanPart;
  command: string;
  refusals: readonly AuthorizationRefusal[];
}): { subject: string; body: string } {
  const { aammdd, part, command, refusals } = input;
  const dests = refusals.map((r) => r.destination);
  const lines = [
    `Achado automático da task one-shot do ${part} da edição ${aammdd} (#12654, #12859).`,
    "",
    `Comando da task: \`${command}\``,
    "",
    "A autorização do plano recusou a publicação (exit 2). Nada foi enviado nestes destinos:",
  ];
  for (const r of refusals) {
    const changed = r.kind === "plan-changed" ? ` Campo(s) que mudaram: ${r.changed?.length ? r.changed.map((c) => `\`${c}\``).join(", ") : "projeção do destino diferente (sem campo apontável)"}.` : "";
    lines.push(`- \`${r.destination}\`: ${KIND_LABEL[r.kind]}.${changed} Detalhe: ${r.message}`);
  }
  if (refusals.some((r) => r.kind === "unavailable")) {
    lines.push("", "O registro de autorização não pôde ser lido: conferir `_internal/video-publish-authorizations.json` da edição (escrita parcial do sync do Drive, lock preso) antes de reaprovar (#12892).");
  }
  lines.push(
    "",
    "Para reaprovar e publicar:",
    `1. Rodar \`/diaria-publica ${aammdd} --so vertical\`: refaz o dry-run, mostra o plano novo com o \`plan_sha256\` e pede o "pode publicar".`,
    `2. Com o "pode publicar", gravar a autorização: \`npx tsx scripts/video-publish-authorize.ts grant ${aammdd} --part ${part} --plan-sha256 {hash do dry-run} --confirmation "{resposta do editor}"\`${dests.length ? ` (ou com \`--only ${dests.join(",")}\`)` : ""}.`,
    `3. Antes do horário, a skill recria a task (\`video-publish-authorize.ts check-task ${aammdd} --part ${part} --destination {id} --command "{command do owners[]}"\`); passado o horário, publica com o \`command\` do \`owners[]\` (\`--only {id} --publish --now\`).`,
    "",
    `Se o post já foi feito à mão, só registrar: \`npx tsx scripts/publish-shorts.ts ${aammdd} --mark {destino}=URL\`.`,
  );
  return {
    subject: `[diar.ia.br] Vertical de ${aammdd}: task one-shot recusada pela autorização do plano (${dests.join(", ")})`,
    body: lines.join("\n"),
  };
}

export type AuthorizationAlarmOutcome = "not-task" | "already" | "delivered" | "email-pending" | "failed";

/**
 * Alarma a recusa da task one-shot. Não lança: devolve o desfecho (o chamador
 * já sai exit 2 de qualquer jeito). `not-task` = nenhum destino recusado é de
 * task one-shot com este comando.
 */
export async function alarmTaskAuthorizationRefusal(input: {
  editionDir: string;
  aammdd: string;
  part: VideoPlanPart;
  command: string;
  refusals: readonly AuthorizationRefusal[];
  notifyDeps?: NotifyEditorDeps;
  log?: (line: string) => void;
}): Promise<AuthorizationAlarmOutcome> {
  const log = input.log ?? ((l: string) => console.error(l));
  const task = oneShotTaskRefusals(input.refusals, input.command);
  if (!task.length) return "not-task";
  try {
    const key = authorizationAlarmKey(input.part, task);
    const statePath = join(input.editionDir, AUTHORIZATION_ALARM_STATE_FILE);
    const stateRaw = existsSync(statePath) ? readFileSync(statePath, "utf8") : null;
    if (alreadyAlarmed(stateRaw, key)) {
      log(`[alarme] recusa da task one-shot (${key}) já avisada nesta edição: não repete (#12859)`);
      return "already";
    }
    const { subject, body } = buildAuthorizationRefusalAlarm({ aammdd: input.aammdd, part: input.part, command: input.command, refusals: task });
    const res = await notifyEditor(
      { check: AUTHORIZATION_ALARM_CHECK, fingerprint: `${input.aammdd}:${key}`, severity: "urgente", family: "evento", subject, body, forceEmail: emailPending(stateRaw, key) },
      input.notifyDeps ?? {},
    );
    const delivery = alarmDelivery(res);
    const next = nextAlarmState(stateRaw, input.aammdd, key, delivery);
    if (next !== null) {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileAtomic(statePath, next);
    }
    if (delivery.kind === "retry") {
      log(`[aviso] alarme da recusa da task one-shot NÃO entregue: ${delivery.error} (#12859)`);
      return "failed";
    }
    if (delivery.kind === "email-pending") {
      log(`[aviso] alarme da recusa da task one-shot: issue ${res.issue?.url ?? "aberta"}, e-mail não enviado (${delivery.error}) (#12859)`);
      return "email-pending";
    }
    log(`[alarme] recusa da task one-shot avisada ao editor: ${res.issue?.url ?? "issue registrada"}${res.emailSent ? " (e-mail enviado)" : ""} (#12859)`);
    return "delivered";
  } catch (e) {
    log(`[aviso] alarme da recusa da task one-shot falhou: ${(e as Error).message} (#12859)`);
    return "failed";
  }
}
