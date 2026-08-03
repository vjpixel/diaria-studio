/**
 * apoio-reconciliation-cycle.ts (extraído no self-review consolidado do PR #4503)
 *
 * `scripts/apoios-diff-alarm.ts::main()` e
 * `scripts/sync-apoio-nivel-beehiiv.ts::main()` tinham um bloco de ~40 linhas
 * DUPLICADO quase byte-a-byte (drena Gmail → reconcilia promessas pendentes →
 * salva) — a duplicação já causou uma divergência real (um fixer round
 * anterior teve que portar o bloco manualmente pro segundo arquivo). Este
 * módulo extrai a sequência inteira numa função única e testável,
 * `runApoioReconciliationCycle`, chamada pelos dois `main()`.
 *
 * A extração também resolve 2 achados críticos do fleet review pré-merge do
 * PR #4503 (`code-reviewer` + `comment-analyzer`, convergência independente;
 * `silent-failure-hunter`):
 *
 * **Achado crítico 1 — notificações confirmadas nunca eram processadas.**
 * `drainApoiaSeNotifications` avança um cursor ÚNICO E COMPARTILHADO
 * (`data/apoia-se/gmail-drain-cursor.json`, ver `apoia-se-gmail-drain.ts`)
 * baseado no timestamp mais recente de TODAS as mensagens vistas — confirmações
 * ("novo apoio") E promessas juntas — independente do que o caller faz com o
 * resultado. Os 2 `main()` só consumiam `.promessas`, nunca `.notifications`:
 * um e-mail de "novo apoio" confirmado tinha seu timestamp consumido pelo
 * cursor mas NUNCA virava contato — e como o cursor já avançou, um force-refresh
 * manual depois (`refreshApoiosData`, único lugar que processava
 * `.notifications` antes desta unidade) já achava esse e-mail `iso <= lastDrain`
 * e pulava silenciosamente pra sempre. Um apoiador que PAGOU ficava invisível
 * pro CRM. Fix: `runApoioReconciliationCycle` processa `.notifications` via
 * `importNewApoiadoresFromGmail` ANTES de `.promessas` — MESMA ordem que
 * `refreshApoiosData` já estabelece (ver `studio-apoios.ts` em torno da linha
 * 1208-1220, dedup-ordering) — pra que uma promessa cujo e-mail já foi
 * importado como confirmado na MESMA leva seja corretamente deduplicada
 * contra o contato recém-criado.
 *
 * **Achado crítico 2 — `catch {}` vazio engolia `ApoiaSeAuthError`.**
 * `reconcilePendingPromises` (abaixo, movido de `sync-apoio-nivel-beehiiv.ts`)
 * tinha um `catch {}` vazio que engolia TUDO — incluindo chave apoia.se
 * expirada/rotacionada. Se a credencial morre, toda promessa pendente falhava
 * silenciosamente pra sempre, sem NENHUM log, indistinguível de "ainda não
 * pagou". Fix: `ApoiaSeAuthError` é tratada separadamente — propaga (throw),
 * já que "falharia igual pra todo item restante" (mesmo raciocínio de
 * `fetchCurrentStatuses` em `studio-apoios.ts`); outros erros (rede, API
 * não-auth) mantêm o comportamento de manter a promessa pendente, mas agora
 * com um log de aviso (antes: nada). `runApoioReconciliationCycle` captura
 * esse throw especificamente em `authError` — NUNCA misturado com o
 * `warning` genérico de outras falhas — pra que os 2 call sites tratem de
 * forma LOUD (log claro + saída não-zero), nunca "seguindo sem ela" (esse
 * fallback continua correto só para falhas transientes/não-auth).
 *
 * Fail-soft pra tudo, EXCETO `ApoiaSeAuthError` — nunca lança.
 */
import {
  ApoiaSeAuthError,
  checkBacker,
  defaultCacheDir,
  readApoiaSeEnv,
  type ApoiaSeEnv,
  type BackerStatus,
  type CheckBackerOptions,
} from "./apoia-se.ts";
import {
  loadPendingPromises,
  mergeNewPromises,
  pendingPromisesPath,
  savePendingPromises,
  type PendingPromise,
} from "./apoio-promise-store.ts";
import { drainApoiaSeNotifications, type DrainApoiaSeResult } from "./apoia-se-gmail-drain.ts";
import {
  importNewApoiadoresFromGmail,
  loadContacts,
  saveContacts,
  type ApoioContact,
} from "../studio-ui/studio-apoios.ts";

const LOG_PREFIX = "[apoio-reconciliation-cycle]";

// ── reconcilePendingPromises (movido de sync-apoio-nivel-beehiiv.ts, achado crítico 2) ──

export interface ReconcilePromisesResult {
  contacts: ApoioContact[];
  /** Promessas que continuam sem confirmação — voltam pro store pra próxima rodada. */
  remainingPromises: PendingPromise[];
  /** Promessas que confirmaram pagamento nesta rodada — já promovidas a contato. */
  promoted: PendingPromise[];
}

/**
 * Reconsulta `checkBacker` (forceRefresh) pra cada promessa pendente — se
 * confirmar pagamento no mês corrente, promove a pessoa a contato via
 * `importNewApoiadoresFromGmail` (mesma criação usada pro drain de
 * confirmados) e a remove do store; senão, continua pendente.
 *
 * `ApoiaSeAuthError` (achado crítico 2, PR #4503) PROPAGA — throw, nunca
 * engolida — porque uma chave apoia.se inválida falha igual pra TODO item
 * restante do lote (mesmo raciocínio de `fetchCurrentStatuses` em
 * `studio-apoios.ts`); o caller (`runApoioReconciliationCycle`) trata esse
 * throw de forma loud. Qualquer OUTRO erro (rede, API não-auth) mantém a
 * promessa no store pra reprocessar na próxima rodada — nunca a descarta por
 * um erro transiente — mas agora loga um aviso (antes: `catch {}` vazio,
 * silêncio total). `checkOpts` é injetável pra testes (nunca rede real).
 */
export async function reconcilePendingPromises(
  contacts: ApoioContact[],
  promises: PendingPromise[],
  checkOpts: CheckBackerOptions = {},
): Promise<ReconcilePromisesResult> {
  let currentContacts = contacts;
  const remainingPromises: PendingPromise[] = [];
  const promoted: PendingPromise[] = [];

  for (const promise of promises) {
    let status: BackerStatus;
    try {
      status = await checkBacker(promise.email, { ...checkOpts, forceRefresh: true });
    } catch (e) {
      if (e instanceof ApoiaSeAuthError) {
        throw e;
      }
      process.stderr.write(
        `${LOG_PREFIX} aviso: falha ao reconsultar promessa de ${promise.email} (${(e as Error).message}) — mantendo pendente.\n`,
      );
      remainingPromises.push(promise);
      continue;
    }

    if (status.isPaidThisMonth) {
      const { contacts: updated } = importNewApoiadoresFromGmail(currentContacts, [
        { name: promise.name, email: promise.email, value: promise.value },
      ]);
      currentContacts = updated;
      promoted.push(promise);
    } else {
      remainingPromises.push(promise);
    }
  }

  return { contacts: currentContacts, remainingPromises, promoted };
}

// ── runApoioReconciliationCycle — orquestração (#4490 causa 4) ─────────────

export interface ApoioReconciliationCycleOptions {
  /** Injetável pra testes — evita chamada de rede real ao Gmail. Default:
   * `drainApoiaSeNotifications(rootDir)`. */
  drainImpl?: () => Promise<DrainApoiaSeResult>;
  /** Injetável pra testes — evita I/O real de `contacts.jsonl`. Default:
   * `loadContacts(rootDir)`. */
  contacts?: ApoioContact[];
  /** Injetável pra testes — evita I/O real de `pending-promises.jsonl`.
   * Default: lido do store via `pendingPromisesPath(rootDir, env.campaign)`. */
  pendingPromises?: PendingPromise[];
  /** Injetável pra testes — evita ler `.env.local`/`APOIA_SE_*` reais.
   * Default: `readApoiaSeEnv()`. */
  env?: ApoiaSeEnv;
  /** Repassado a `checkBacker` (via `reconcilePendingPromises`) — `fetchImpl`,
   * `limiter`, `cacheDir`, `now`. `env`/`cacheDir` já têm default calculado
   * aqui; passar aqui também funciona como override pra testes. */
  checkOpts?: CheckBackerOptions;
}

export interface ApoioReconciliationCycleResult {
  /** `true` quando o drain de Gmail foi pulado (auth expirada, rede) — a
   * reconciliação de promessas segue só com o que já tinha no store. */
  drainSkipped: boolean;
  drainSkipReason?: string;
  /** Notificações de PAGAMENTO CONFIRMADO importadas como contato novo nesta
   * rodada (achado crítico 1 — antes, sempre 0 nestes 2 call sites, mesmo
   * quando o drain trazia notificações confirmadas de verdade). */
  notificationsImported: number;
  /** Promessas novas (ainda não pagas) drenadas do Gmail nesta rodada. */
  promessasDrained: number;
  /** Promessas confirmadas como pagamento e promovidas a contato nesta rodada. */
  promoted: PendingPromise[];
  /** Promessas que continuam sem confirmação — já persistidas de volta no store. */
  remainingPending: PendingPromise[];
  /** Falha NÃO relacionada a auth (env ausente, I/O, erro transiente na
   * reconciliação de alguma promessa específica) — reconciliação seguiu
   * (fail-soft) mas algo não rodou como esperado. `null` quando não houve. */
  warning: string | null;
  /** #4503 achado crítico 2: mensagem de `ApoiaSeAuthError` propagada por
   * `reconcilePendingPromises`. Quando presente, o caller DEVE tratar de
   * forma LOUD (log claro + saída não-zero) — nunca só "seguindo sem ela"
   * como os demais avisos fail-soft. `null` quando não houve. */
  authError: string | null;
  /** Contatos finais — já refletem notificações confirmadas + promessas
   * promovidas nesta rodada, e já persistidos em `contacts.jsonl` quando
   * houve mutação. */
  contacts: ApoioContact[];
}

/**
 * Orquestra o ciclo de reconciliação de apoio (#4490 causa 4): drena Gmail →
 * importa notificações CONFIRMADAS como contato (achado crítico 1) → funde +
 * reconcilia promessas pendentes (achado crítico 2, error handling correto)
 * → persiste contacts/pending-promises conforme mutação. Chamado por
 * `sync-apoio-nivel-beehiiv.ts::main()` e `apoios-diff-alarm.ts::main()` —
 * ambos rodavam essa mesma sequência DUPLICADA antes desta extração.
 *
 * Fail-soft pra tudo, EXCETO `ApoiaSeAuthError` (ver `authError` no retorno)
 * — nunca lança. Mutações de `contacts` já aplicadas ANTES de um eventual
 * `ApoiaSeAuthError` (ex: notificações confirmadas importadas) NUNCA são
 * descartadas — só a reconciliação de promessas em si é abortada; a pessoa
 * que confirmou pagamento via e-mail continua sendo salva mesmo que a
 * credencial apoia.se falhe logo depois, no passo seguinte.
 */
export async function runApoioReconciliationCycle(
  rootDir: string,
  opts: ApoioReconciliationCycleOptions = {},
): Promise<ApoioReconciliationCycleResult> {
  let contacts = opts.contacts ?? [];
  let notificationsImported = 0;
  let promessasDrained = 0;
  let promoted: PendingPromise[] = [];
  let remainingPending: PendingPromise[] = opts.pendingPromises ?? [];
  let warning: string | null = null;
  let authError: string | null = null;
  let drainSkipped = false;
  let drainSkipReason: string | undefined;
  let promisesPath: string | null = null;

  try {
    const env = opts.env ?? readApoiaSeEnv();
    promisesPath = pendingPromisesPath(rootDir, env.campaign);

    if (!opts.contacts) contacts = loadContacts(rootDir);
    let pending = opts.pendingPromises ?? loadPendingPromises(promisesPath);

    const runDrain = opts.drainImpl ?? (() => drainApoiaSeNotifications(rootDir));
    const drainResult = await runDrain();

    if (drainResult.skipped) {
      drainSkipped = true;
      drainSkipReason = drainResult.reason ?? "erro desconhecido";
    } else {
      // Achado crítico 1: notificações CONFIRMADAS antes de promessas — ver
      // cabeçalho do módulo pro rationale completo (mesma ordem de
      // `refreshApoiosData`).
      if (drainResult.notifications.length > 0) {
        const { contacts: updated, imported } = importNewApoiadoresFromGmail(contacts, drainResult.notifications);
        contacts = updated;
        notificationsImported = imported;
      }
      const drained = drainResult.promessas ?? [];
      if (drained.length > 0) {
        promessasDrained = drained.length;
        pending = mergeNewPromises(pending, drained);
      }
    }

    // Persistido já aqui (pré-reconcile) como o default de `remainingPending`
    // — se `reconcilePendingPromises` abaixo lançar `ApoiaSeAuthError`, uma
    // promessa recém-drenada do Gmail (cursor JÁ avançado, mesma classe do
    // achado crítico 1) não fica perdida: o `pending` mesclado ainda é
    // persistido no `finally` implícito abaixo (fora do try/catch).
    remainingPending = pending;

    if (pending.length > 0) {
      const reconciled = await reconcilePendingPromises(contacts, pending, {
        env,
        cacheDir: defaultCacheDir(env.campaign),
        ...opts.checkOpts,
      });
      contacts = reconciled.contacts;
      promoted = reconciled.promoted;
      remainingPending = reconciled.remainingPromises;
    }
  } catch (e) {
    if (e instanceof ApoiaSeAuthError) {
      authError = e.message;
    } else {
      warning = `reconciliação de promessas pendentes falhou (${(e as Error).message}) — seguindo sem ela.`;
    }
  }

  if (notificationsImported > 0 || promoted.length > 0) {
    saveContacts(rootDir, contacts);
  }
  if (promisesPath) {
    savePendingPromises(promisesPath, remainingPending);
  }

  return {
    drainSkipped,
    ...(drainSkipReason ? { drainSkipReason } : {}),
    notificationsImported,
    promessasDrained,
    promoted,
    remainingPending,
    warning,
    authError,
    contacts,
  };
}
