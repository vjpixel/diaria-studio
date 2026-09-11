#!/usr/bin/env npx tsx
/**
 * scripts/kit-subscriber-state-transition-alarm.ts (#7660)
 *
 * Alarme de perda de assinante no Kit — emite quando alguém sai de `active`
 * para `complained`/`bounced`/`cancelled`/`inactive`, E quando alguém SOME
 * da conta inteira (evento distinto, #7660 3º comentário). Compara o
 * snapshot anterior (`data/kit-sub-state/prev.json`) com o atual
 * (`current.json`), registra cada achado via `notifyEditor` (severidade
 * `"silencio"`, #7902/#7960 — ver seção abaixo), e roda o snapshot atual por
 * cima do anterior.
 *
 * **Não escreve no Kit.** Só `GET /v4/subscribers`. A recuperação
 * (re-registro via DOI para `complained`/`bounced`, reativação manual para
 * `cancelled`/`inactive`) é ação do editor, e o corpo do registro carrega o
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
 * ## Notificação: `"silencio"` (#7902, #7960)
 *
 * Migrado de "abre 1 issue por assinante/evento + e-mail" pro portão
 * `notifyEditor` (`scripts/lib/editor-notify.ts`) com severidade
 * `"silencio"` — decisão explícita do editor (#7957): perda de assinante
 * isolada (sobretudo `cancelled`, que é a PRÓPRIA pessoa pedindo pra saír,
 * ver `kitLossRecoveryPlaybook` item 0) não justifica issue nem e-mail a
 * cada ocorrência; o registro que sobra é só `data/run-log.jsonl`. Achado
 * concreto que motivou (#7902): cadastro via ads pagos que cancelou 2 dias
 * depois — churn normal de aquisição, não um bug a investigar.
 * `notifyEditor` NUNCA lança pra `"silencio"` (só grava o log), então não há
 * mais caminho de falha de issue/e-mail a propagar ou reter no latch —
 * `advanceKitStateTransitionAlarmState` avança incondicionalmente com TODAS
 * as transições/desaparecimentos novos da rodada.
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
 * @see scripts/lib/editor-notify.ts (portão de notificação, severidade "silencio")
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
  emptyKitStateTransitionAlarmState,
  KIT_STATE_TRANSITION_ALARM_STATES,
  KIT_STATE_TRANSITION_FROM_STATE,
  type KitLossOnboardingContext,
  type KitStateTransitionAlarmState,
  type KitStateTransitionSnapshotEntry,
} from "./lib/kit-subscriber-state-transition-alarm.ts";
import { saveState, type AlarmFinding } from "./lib/alarm-issues.ts";
import {
  listAllKitSubscribers,
  type KitSubscriberListStatus,
  type KitSubscriberSummary,
} from "./lib/kit-subscribers.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { readStore, DEFAULT_STORE_PATH } from "./lib/onboarding-store.ts";
import { notifyEditor } from "./lib/editor-notify.ts";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const STATE_DIR = resolve(ROOT, "data", "kit-sub-state");
const PREV_PATH = join(STATE_DIR, "prev.json");
const CURRENT_PATH = join(STATE_DIR, "current.json");
const LATCH_PATH = join(STATE_DIR, ".transition-latch.json");
const LOG = "[kit-subscriber-state-transition-alarm]";

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
    // Latch corrompido re-alarma (pior caso: 1 log duplicado no run-log,
    // #7902/#7960) em vez de silenciar.
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
    console.log(`${LOG} transições já registradas em execução anterior (latch) — sem novo log.`);
  }
  if (disappearances.length > 0 && !shouldAlarmKitDisappearance(latch, disappearances)) {
    console.log(`${LOG} desaparecimentos já registrados em execução anterior (latch) — sem novo log.`);
  }

  const correlations = loadOnboardingCorrelations();
  const findings: AlarmFinding[] = [
    ...toStateTransitionAlarmFindings(novas, correlations),
    ...toDisappearanceAlarmFindings(novosSumicos, correlations),
  ];

  if (dry) {
    console.log(
      `${LOG} --dry-run: ${findings.length} ação(ões) — ` +
        (findings.length > 0 ? `notifyEditor("silencio") por achado` : "nenhuma"),
    );
    for (const t of novas) console.log(`${LOG} --dry-run: ${t.address} (id ${t.id}) ${t.fromState} → ${t.toState}`);
    for (const d of novosSumicos) {
      console.log(`${LOG} --dry-run: ${d.address ?? `id ${d.id}`} (id ${d.id}) ${d.lastState} → ausente`);
    }
    return 0;
  }

  // "silencio" (#7902, #7960): nem issue, nem e-mail — só log em
  // data/run-log.jsonl. `notifyEditor` nunca lança pra esta severidade, então
  // não há falha a reter fora do latch: diferente do regime anterior
  // (`applyAlarmReconciliation`), TODO achado desta rodada entra no latch.
  for (const f of findings) {
    await notifyEditor(
      { check: f.check, fingerprint: f.fingerprint, severity: "silencio", subject: f.title, body: f.body },
      { rootDir: ROOT },
    );
    console.log(`${LOG} registrado (silencio): ${f.fingerprint}`);
  }

  // Latch e snapshot avançam DEPOIS do log: se `notifyEditor` lançasse (não
  // lança pra "silencio", mas mantemos a ordem por disciplina — mesmo padrão
  // dos alarmes irmãos), a próxima execução redetectaria e tentaria de novo.
  const activeIds = current.filter((s) => s.state === KIT_STATE_TRANSITION_FROM_STATE).map((s) => s.id);
  saveState(advanceKitStateTransitionAlarmState(latch, novas, activeIds, now, novosSumicos), LATCH_PATH);
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
