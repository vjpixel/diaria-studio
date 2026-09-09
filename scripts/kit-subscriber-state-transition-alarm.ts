#!/usr/bin/env npx tsx
/**
 * scripts/kit-subscriber-state-transition-alarm.ts (#7660)
 *
 * Alarme de perda de assinante no Kit — emite quando alguém sai de `active`
 * para `complained`/`bounced`/`cancelled`/`inactive`, E quando alguém SOME
 * da conta inteira (evento distinto, #7660 3º comentário). Compara o
 * snapshot anterior (`data/kit-sub-state/prev.json`) com o atual
 * (`current.json`), abre uma issue por assinante e por evento, avisa o
 * editor por e-mail, e roda o snapshot atual por cima do anterior.
 *
 * **Não escreve no Kit.** Só `GET /v4/subscribers`. A recuperação
 * (re-registro via DOI para `complained`/`bounced`, reativação manual para
 * `cancelled`/`inactive`) é ação do editor, e o corpo da issue carrega o
 * playbook — inclusive a armadilha do recadastro disparar boas-vindas
 * indevidas (`kitLossRecoveryPlaybook`).
 *
 * ## De onde vem `current.json`
 *
 * `--fetch` (o modo da task agendada) BUSCA no Kit e grava o snapshot antes
 * de comparar. Sem a flag, o script exige o arquivo já no disco — é o modo
 * offline, usado pelos testes e por uma execução manual sobre um snapshot
 * capturado antes.
 *
 * `current.json` ausente SEM `--fetch` é erro duro (exit 1), nunca no-op: um
 * alarme que "roda ok" sem dado é pior que um alarme que não roda, porque a
 * task agendada fica verde enquanto ninguém está de olho — que foi
 * literalmente o estado da PR #7673, cujo `current.json` nenhum script deste
 * repo jamais produziu. Já `prev.json` ausente é legítimo (1ª execução): não
 * há transição a detectar contra o vazio, então grava a linha de base e sai.
 *
 * ## A varredura é por estado, não um `status=all` só
 *
 * Ficou em aberto no #7660 (2º comentário) se `GET /v4/subscribers?status=all`
 * de fato devolve os `complained` — a medição ao vivo não trouxe nenhum, e o
 * caso sumiu antes de dar pra reproduzir. Um alarme cujo dado de entrada
 * talvez omita justamente o estado que ele existe pra pegar não serve, então
 * `fetchCurrentSnapshot` varre `all` E cada estado de alarme
 * separadamente, unindo por id. Custa 4 varreduras paginadas a mais — hoje 1
 * página cada, porque os estados não-ativos somam dezenas de registros contra
 * o `per_page` 500 de `listAllKitSubscribers`; se `cancelled`/`inactive`
 * crescerem além disso vira mais de uma página por estado, sem mudar nada no
 * mecanismo. E não depende da resposta da pergunta acima.
 *
 * Medido ao vivo em 09/09/2026 (conta Kit da diária): `all` = 930, e as
 * varreduras por estado (`bounced` 6, `cancelled` 30, `inactive` 18) não
 * acrescentaram NENHUM id à união — `all` já os continha. `complained` = 0 na
 * conta, então a dúvida original segue sem resposta empírica; a varredura
 * extra fica como seguro barato até algum `complained` reaparecer e permitir
 * medir.
 *
 * Uso:
 *   npx tsx scripts/kit-subscriber-state-transition-alarm.ts --fetch --dry-run
 *   npx tsx scripts/kit-subscriber-state-transition-alarm.ts --fetch
 *   npx tsx scripts/kit-subscriber-state-transition-alarm.ts            # offline
 *
 * Premissa registrada (#7660): `bounced` INCLUÍDO por default mais seguro
 * (`KIT_STATE_TRANSITION_ALARM_STATES`). Se o editor quiser separar, trocar
 * a constante em `scripts/lib/kit-subscriber-state-transition-alarm.ts`.
 *
 * @see scripts/lib/kit-subscriber-state-transition-alarm.ts (lógica pura)
 * @see scripts/lib/alarm-issues.ts (abertura/fechamento das issues)
 */
import { resolve, join } from "node:path";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { isMainModule } from "./lib/cli-args.ts";
import {
  detectKitStateTransitions,
  detectKitDisappearances,
  toStateTransitionAlarmFindings,
  toDisappearanceAlarmFindings,
  shouldAlarmKitStateTransition,
  shouldAlarmKitDisappearance,
  advanceKitStateTransitionAlarmState,
  selectLatchableEvents,
  emptyKitStateTransitionAlarmState,
  KIT_STATE_TRANSITION_ALARM_STATES,
  KIT_STATE_TRANSITION_FROM_STATE,
  type KitDisappearance,
  type KitLossOnboardingContext,
  type KitStateTransitionAlarmState,
  type KitStateTransitionSnapshotEntry,
} from "./lib/kit-subscriber-state-transition-alarm.ts";
import {
  applyAlarmReconciliation,
  planAlarmReconciliation,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
  saveState,
  type AlarmFinding,
} from "./lib/alarm-issues.ts";
import {
  listAllKitSubscribers,
  type KitSubscriberListStatus,
  type KitSubscriberSummary,
} from "./lib/kit-subscribers.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { readStore, DEFAULT_STORE_PATH } from "./lib/onboarding-store.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const STATE_DIR = resolve(ROOT, "data", "kit-sub-state");
const PREV_PATH = join(STATE_DIR, "prev.json");
const CURRENT_PATH = join(STATE_DIR, "current.json");
const LATCH_PATH = join(STATE_DIR, ".transition-latch.json");
const ISSUES_STATE_PATH = join(STATE_DIR, ".alarm-issues.json");
const LOG = "[kit-subscriber-state-transition-alarm]";

/** `family: "evento"` nas findings — a issue não fecha sozinha, então este
 *  valor nunca chega a ser usado pra fechar nada. Existe porque
 *  `planAlarmReconciliation`/`applyAlarmReconciliation` o exigem. */
const CLOSE_AFTER_RUNS = 2;

function loadPrev(): KitStateTransitionSnapshotEntry[] {
  if (!existsSync(PREV_PATH)) return [];
  const raw: unknown = JSON.parse(readFileSync(PREV_PATH, "utf8"));
  return (Array.isArray(raw) ? raw : []) as KitStateTransitionSnapshotEntry[];
}

/** `null` = arquivo ausente, que é ERRO (ver docstring do módulo) — distinto
 *  de `[]`, que é "sincronizou e a base está vazia", estado válido. */
function loadCurrent(): KitSubscriberSummary[] | null {
  if (!existsSync(CURRENT_PATH)) return null;
  const raw: unknown = JSON.parse(readFileSync(CURRENT_PATH, "utf8"));
  return (Array.isArray(raw) ? raw : []) as KitSubscriberSummary[];
}

function loadLatch(): KitStateTransitionAlarmState {
  if (!existsSync(LATCH_PATH)) return emptyKitStateTransitionAlarmState();
  try {
    return JSON.parse(readFileSync(LATCH_PATH, "utf8")) as KitStateTransitionAlarmState;
  } catch {
    // Latch corrompido re-alarma (pior caso: 1 issue duplicada, que o
    // fingerprint de `alarm-issues` ainda deduplica) em vez de silenciar.
    return emptyKitStateTransitionAlarmState();
  }
}

/** Snapshot da rodada vira o `prev` da próxima — sem isso a MESMA transição
 *  seria redetectada para sempre, e o latch seria a única coisa segurando o
 *  alarme (ele re-arma quando o assinante volta a `active`, então não é
 *  garantia suficiente). */
function persistSnapshot(current: readonly KitSubscriberSummary[]): void {
  mkdirSync(STATE_DIR, { recursive: true });
  // `address`/`apoioNivel` entraram junto com a detecção de desaparecimento:
  // quem sumiu não está no snapshot ATUAL, então o anterior é a única fonte
  // que sobra pra dizer QUEM sumiu. Antes disso guardar só `{id, state}` era
  // o mínimo suficiente; agora seria o alarme dizendo "o id 4264399626
  // sumiu", que nenhum humano consegue acionar.
  const entries: KitStateTransitionSnapshotEntry[] = current.map((s) => ({
    id: s.id,
    state: s.state,
    address: s.email_address,
    ...(s.fields?.apoio_nivel ? { apoioNivel: s.fields.apoio_nivel } : {}),
  }));
  writeFileSync(PREV_PATH, JSON.stringify(entries, null, 2), "utf8");
}

/**
 * Varredura de estados no Kit — `all` mais cada estado de alarme, unidos por
 * id (ver "A varredura é por estado" na docstring do módulo). Em caso de id
 * repetido entre as varreduras, a versão da varredura POR ESTADO vence: ela
 * é a que responde a pergunta que interessa aqui.
 */
export async function fetchCurrentSnapshot(): Promise<KitSubscriberSummary[]> {
  const cfg = resolveKitConfig();
  if (!cfg.ok) throw new Error(`${LOG} ${cfg.reason}`);
  const byId = new Map<number, KitSubscriberSummary>();
  const varreduras: KitSubscriberListStatus[] = [
    "all",
    ...(KIT_STATE_TRANSITION_ALARM_STATES as KitSubscriberListStatus[]),
  ];
  for (const status of varreduras) {
    const page = await listAllKitSubscribers(cfg.config, { status });
    for (const s of page) byId.set(s.id, s);
    console.log(`${LOG} varredura status=${status}: ${page.length} assinante(s).`);
  }
  return [...byId.values()];
}

/**
 * Correlação com o histórico de envio (#7660, 1º comentário): mapa
 * `email → contexto de onboarding`, indexado em minúsculas.
 *
 * Fail-soft por desenho — store ausente (clone fresco, sessão sem `data/`)
 * devolve mapa vazio, e a issue diz "nenhum registro" em vez de o alarme
 * inteiro morrer por causa do enriquecimento.
 *
 * Quem garante isso é o próprio `readStore`, que trata ausência e JSON
 * corrompido internamente e nunca lança — o `try/catch` abaixo NÃO é o que
 * cobre esses dois casos. Ele existe pro resto: mudança de schema, `entries`
 * vindo `undefined`, qualquer `TypeError` sobre dado malformado. Por isso
 * loga como ERRO (não `warn`): perder a correlação em silêncio por meses
 * seria a mesma classe de falha que o alarme existe pra impedir, um nível
 * acima (achado do review da PR #7828).
 */
export function loadOnboardingCorrelations(
  storePath: string = DEFAULT_STORE_PATH,
): Map<string, KitLossOnboardingContext> {
  const map = new Map<string, KitLossOnboardingContext>();
  try {
    const { store } = readStore(storePath);
    for (const entry of Object.values(store.entries)) {
      if (!entry.email) continue;
      map.set(entry.email.toLowerCase(), {
        email1SentAt: entry.email1_sent_at,
        ...(entry.seeded_by ? { seededBy: entry.seeded_by } : {}),
      });
    }
  } catch (e) {
    console.error(
      `${LOG} ERRO estrutural lendo o store de onboarding (${(e as Error).message}) — ` +
        `seguindo SEM correlação. Ausência e JSON corrompido não caem aqui (readStore os trata), ` +
        `então isto é schema/dado inesperado, não "ainda não tem store".`,
    );
  }
  return map;
}

/** Só o que o e-mail lê de um `AlarmFindingOutcome` — declarado à parte pra
 *  o teste montar um outcome sem depender do envelope inteiro do
 *  `alarm-issues.ts`. */
export interface AlarmEmailOutcome {
  fingerprint: string;
  action: string;
  issueNumber: number | null;
  url: string | null;
  error?: string;
}

/**
 * Corpo do e-mail — o canal que faltava no caso de origem, onde a saída
 * ficou onze dias sem ninguém saber. A issue é o registro durável; o e-mail
 * é o que chega ao editor no mesmo dia.
 *
 * Exportado pra ser testável em unidade, como `buildKitSubscriberLimitAlarmEmail`
 * no alarme irmão — um bug de formatação aqui falharia exatamente do jeito
 * que este alarme existe pra impedir (achado do review da PR #7828).
 *
 * Outcome com `action: "failed"` sai NOMEADO e com o erro, nunca como um
 * `#?` mudo: é o único aviso de que aquele assinante ficou sem registro
 * durável nesta rodada (será retentado na próxima, ver `selectLatchableEvents`).
 */
export function buildAlarmEmail(
  transitions: readonly { address: string; id: number; fromState: string; toState: string }[],
  disappearances: readonly KitDisappearance[],
  findingOutcomes: readonly AlarmEmailOutcome[],
): { subject: string; body: string } {
  const total = transitions.length + disappearances.length;
  const falhas = findingOutcomes.filter((o) => o.action === "failed");
  const ok = findingOutcomes.filter((o) => o.action !== "failed");
  const subject =
    `[diar.ia.br] Kit: ${total} assinante(s) saíram da base` +
    (falhas.length ? ` — ${falhas.length} issue(s) NÃO abertas` : "");
  const linhas = [
    "Alarme de perda de assinante no Kit (#7660).",
    "",
    ...(transitions.length
      ? [
          "Transições de estado:",
          ...transitions.map((t) => `  - ${t.address} (id ${t.id}): ${t.fromState} → ${t.toState}`),
          "",
        ]
      : []),
    ...(disappearances.length
      ? [
          "Sumiram da conta:",
          ...disappearances.map((d) => `  - ${d.address ?? `id ${d.id}`} (último estado: ${d.lastState})`),
          "",
        ]
      : []),
    "Issues abertas com o playbook de recuperação:",
    ...(ok.length
      ? ok.map((o) => `  - ${o.url ?? `#${o.issueNumber ?? "?"}`}`)
      : ["  (nenhuma — ver o log da task)"]),
    ...(falhas.length
      ? [
          "",
          "FALHA ao abrir issue (o assinante fica sem registro durável nesta rodada;",
          "não entra no latch, então a próxima execução tenta de novo):",
          ...falhas.map((o) => `  - ${o.fingerprint}: ${o.error ?? "erro não reportado"}`),
        ]
      : []),
  ];
  return { subject, body: linhas.join("\n") };
}

export async function run(argv: readonly string[], now: Date = new Date()): Promise<number> {
  const dry = argv.includes("--dry-run");
  const fetchMode = argv.includes("--fetch");
  console.log(
    `${LOG} dry=${dry} fetch=${fetchMode} from=${KIT_STATE_TRANSITION_FROM_STATE} ` +
      `to=${KIT_STATE_TRANSITION_ALARM_STATES.join(",")}`,
  );

  let current: KitSubscriberSummary[] | null;
  if (fetchMode) {
    // Falha de fetch PROPAGA (o catch do entry-point vira exit 1) em vez de
    // cair pro snapshot velho do disco: comparar o snapshot de ontem consigo
    // mesmo daria "0 transições" — um verde que significa "não checei nada".
    current = await fetchCurrentSnapshot();
    mkdirSync(STATE_DIR, { recursive: true });
    if (!dry) writeFileSync(CURRENT_PATH, JSON.stringify(current, null, 2), "utf8");
    console.log(`${LOG} snapshot atual: ${current.length} assinante(s)${dry ? " (não gravado, --dry-run)" : ""}.`);
  } else {
    current = loadCurrent();
  }
  if (current === null) {
    console.error(
      `${LOG} ERRO: ${CURRENT_PATH} não existe e o modo offline não busca nada. ` +
        `Rode com --fetch (o modo da task agendada) ou plante o snapshot no disco. ` +
        `Sair 0 aqui deixaria a task agendada verde sem ter checado nada (#7660).`,
    );
    return 1;
  }

  const prev = loadPrev();
  if (prev.length === 0) {
    console.log(`${LOG} sem snapshot anterior — gravando linha de base (${current.length} assinantes) e saindo.`);
    if (!dry) persistSnapshot(current);
    return 0;
  }

  const transitions = detectKitStateTransitions(prev, current, now);
  const disappearances = detectKitDisappearances(prev, current, now);
  const latch = loadLatch();
  const novas = transitions.filter((t) => !latch.alertedSubscriberIds.includes(t.id));
  const novosSumicos = disappearances.filter((d) => !(latch.alertedDisappearedIds ?? []).includes(d.id));

  console.log(
    `${LOG} ${transitions.length} transição(ões) detectada(s), ${novas.length} ainda não alertada(s); ` +
      `${disappearances.length} desaparecimento(s), ${novosSumicos.length} ainda não alertado(s).`,
  );
  if (transitions.length > 0 && !shouldAlarmKitStateTransition(latch, transitions)) {
    console.log(`${LOG} transições já alertadas em execução anterior (latch) — sem reabrir issue.`);
  }
  if (disappearances.length > 0 && !shouldAlarmKitDisappearance(latch, disappearances)) {
    console.log(`${LOG} desaparecimentos já alertados em execução anterior (latch) — sem reabrir issue.`);
  }

  const correlations = loadOnboardingCorrelations();
  const findings: AlarmFinding[] = [
    ...toStateTransitionAlarmFindings(novas, correlations),
    ...toDisappearanceAlarmFindings(novosSumicos, correlations),
  ];
  const issuesState = loadAlarmIssuesState(ISSUES_STATE_PATH);

  if (dry) {
    const acoes = planAlarmReconciliation(findings, issuesState, CLOSE_AFTER_RUNS);
    console.log(`${LOG} --dry-run: ${acoes.length} ação(ões) — ${acoes.map((a) => a.kind).join(", ") || "nenhuma"}`);
    for (const t of novas) console.log(`${LOG} --dry-run: ${t.address} (id ${t.id}) ${t.fromState} → ${t.toState}`);
    for (const d of novosSumicos) {
      console.log(`${LOG} --dry-run: ${d.address ?? `id ${d.id}`} (id ${d.id}) ${d.lastState} → ausente`);
    }
    return 0;
  }

  const { nextState, findingOutcomes } = applyAlarmReconciliation(findings, issuesState, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_AFTER_RUNS,
  });
  saveAlarmIssuesState(nextState, ISSUES_STATE_PATH);
  for (const o of findingOutcomes) {
    console.log(`${LOG} issue ${o.action}${o.issueNumber ? ` #${o.issueNumber}` : ""}${o.url ? ` ${o.url}` : ""}`);
  }
  const failedFingerprints = new Set(
    findingOutcomes.filter((o) => o.action === "failed").map((o) => o.fingerprint),
  );
  if (failedFingerprints.size > 0) {
    console.error(
      `${LOG} ${failedFingerprints.size} issue(s) NÃO abertas — esses assinantes ficam FORA do latch ` +
        `e serão reprocessados na próxima execução.`,
    );
  }

  if (findings.length > 0) {
    // Sem try/catch, mesma disciplina de kit-subscriber-limit-alarm.ts: se o
    // envio falhar, o latch abaixo não avança e a próxima execução tenta de
    // novo, em vez de marcar como avisado algo que o editor nunca recebeu.
    const { subject, body } = buildAlarmEmail(novas, novosSumicos, findingOutcomes);
    const to = resolveEditorEmail(join(ROOT, "platform.config.json"));
    await sendGmailMessage(to, subject, body);
    console.log(`${LOG} e-mail de alarme enviado pra ${to}.`);
  }

  // Latch e snapshot avançam DEPOIS das issues e do e-mail: se qualquer um
  // lançar, a próxima execução redetecta e tenta de novo, em vez de perder o
  // evento. E entram no latch só os eventos cuja issue de fato foi aberta
  // (`selectLatchableEvents`) — latchar um que falhou o removeria de `novas`
  // pra sempre, matando o retry que o `applyAlarmReconciliation` preserva.
  const activeIds = current.filter((s) => s.state === KIT_STATE_TRANSITION_FROM_STATE).map((s) => s.id);
  const latchable = selectLatchableEvents(novas, novosSumicos, failedFingerprints);
  saveState(
    advanceKitStateTransitionAlarmState(latch, latchable.transitions, activeIds, now, latchable.disappearances),
    LATCH_PATH,
  );
  persistSnapshot(current);
  return 0;
}

if (isMainModule(import.meta.url)) {
  loadProjectEnv();
  // `process.exitCode`, nunca `process.exit()` — mesma disciplina dos outros
  // alarmes deste diretório.
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      console.error(`${LOG} erro:`, e);
      process.exitCode = 1;
    });
}
