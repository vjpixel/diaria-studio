/**
 * studio-reports.ts (#3714, fatia da EPIC "Studio UI" #3554)
 *
 * Superfície de "Relatórios" do Studio — decisão do editor (comentário de
 * 2026-07-20 na issue #3714): **substituir** o draft de e-mail dos fechos de
 * pipeline (edição diária, `/diaria-overnight`, `/diaria-develop`) por um
 * link acessível na UI do Studio, não somar aos dois. O acesso remoto do
 * Studio (#3560) já cobre o alcance mobile que o e-mail dava.
 *
 * **Design: registry leve, conteúdo fica onde já estava.** Os HTMLs/markdowns
 * dos relatórios continuam na estrutura per-edição/per-sessão já existente
 * (`data/editions/{AAMMDD}/_internal/edition-report.html`,
 * `data/overnight/{AAMMDD}/report.md`, `data/develop/{AAMMDD}/report.md`) —
 * este arquivo NÃO reinventa onde o conteúdo mora. O único artefato novo é um
 * índice (`data/reports/index.jsonl`) que aponta pra esses arquivos, porque
 * não existe hoje um jeito barato de descobrir "todos os relatórios de todas
 * as sessões" sem esse índice (teria que varrer `data/editions/*`,
 * `data/overnight/*`, `data/develop/*` a cada request).
 *
 * **#4666: upsert por id, não append-only.** Até #4666 o registro era
 * append-only (mesma convenção de `data/run-log.jsonl`/`data/sources/{slug}.jsonl`)
 * e a leitura (`listReports`) dedupava por id na hora de exibir — a ideia era
 * "a última linha física vence". Na prática, um caller que re-registra o
 * MESMO `(kind, sessionId)` pra corrigir um relatório anterior (ex: rodada que
 * abortou e depois foi retomada manualmente) deixava a entrada FALSA enterrada
 * no arquivo pra sempre, e a superfície de notificação por e-mail (#4475)
 * disparava 2× — uma vez por registro, sem saber que era uma correção.
 * `registerReport` agora reescreve o arquivo removendo qualquer linha com o
 * MESMO id antes de acrescentar a nova (`data/reports/index.jsonl` nunca tem
 * 2 linhas pro mesmo id depois de #4666) — deixou de ser append-only, mas o
 * *conteúdo* servido a cada `id` sempre foi "a versão mais recente", então o
 * comportamento observável de `listReports`/`getReportById` não muda; só o
 * arquivo físico não acumula lixo.
 *
 * **Registro é 100% file-based, nunca uma chamada HTTP ao Studio** — o
 * servidor pode estar parado no momento em que um relatório é gerado (é um
 * dev server local, não sempre no ar); `registerReport` só escreve no disco,
 * então o Studio descobre o relatório na próxima vez que `listReports` rodar
 * (próximo load de `/relatorios` ou próximo request de `/api/reports`),
 * nunca bloqueia nem falha o produtor do relatório por o servidor estar
 * offline.
 *
 * `registerReport`/`listReports`/`getReportById`/`resolveReportHtml` são
 * puras o suficiente pra testar sem subir o servidor HTTP — só I/O de
 * arquivo, injetável via `rootDir` (mesmo padrão de `studio-round.ts`/
 * `studio-issues.ts`).
 *
 * **#4475: e-mail de notificação leve, não a volta do draft narrativo do
 * #3714** — DECISÃO REVERTIDA em 06/08 pelo editor (#4708), ver bloco
 * abaixo. Histórico preservado porque a issue #4708 explicitamente pediu
 * pra registrar a reversão em vez de só trocar o código: uma sessão futura
 * que lesse só "#4475: e-mail leve" concluiria que o corpo cheio é
 * regressão e reverteria de volta.
 *
 * O draft removido em #3714 era um e-mail PESADO — narrativa completa
 * colada via `create_draft` (MCP), que o editor precisava abrir e ler
 * inteiro. O que `registerReport` disparava entre #4475 (260802) e #4708
 * (260806) via `dispatchReportEmail` era só título + link — um PING pra
 * avisar que um relatório novo existe, sem reintroduzir o conteúdo
 * duplicado que #3714 tinha eliminado.
 *
 * **#4708 (2026-08-06): o editor quer o relatório COMPLETO de volta no
 * corpo do e-mail, não só título + link.** `buildReportEmail` (removida no
 * #7960, ver bloco abaixo) passou a ler o conteúdo real do relatório (via
 * `resolveReportHtml`, mesma resolução segura contra path traversal já
 * usada pelo Studio) e o embutia no corpo (conversão HTML→texto puro,
 * truncamento explícito quando o conteúdo era grande). Histórico
 * preservado pela mesma razão do bloco #4475/#4708 acima — quem lesse só
 * "canal de e-mail removido" sem este contexto poderia achar que o
 * conteúdo rico nunca foi um requisito real.
 *
 * **#7960 (2026-09-19, item 5 da #7957 — decisão do editor): `registerReport`
 * deixa de ter canal de e-mail PRÓPRIO e passa a delegar ao portão único
 * `notifyEditor` (`scripts/lib/editor-notify.ts`), severidade `"info"`.**
 * `notifyEditor` já vive em `scripts/lib/` (não em `studio-ui/`), então
 * importar dele daqui não viola a fronteira `lib/`↔`studio-ui/` (regra 4 de
 * `test/lib-boundary.test.ts` só proíbe o sentido contrário). Severidade
 * `"info"` nunca dispara e-mail nem abre issue em NENHUMA política de
 * `notifications.email_policy` (`"legacy"`/`"urgent_only"`) — só garante
 * que o registro fica visível em `data/run-log.jsonl` (lido por
 * `/diaria-log` e pelo auto-reporter), além do índice do Studio em si. Essa
 * é, na prática, a MESMA conclusão a que #7960 (item 4) já tinha chegado
 * pro relatório de `ads-daily-digest.ts` — que registra via `registerReport`
 * e separadamente chama `notifyEditor({severity: "info"})` — só que agora
 * dobrada pra dentro do próprio `registerReport`, em vez de cada caller
 * reimplementar o par. Todo o código Gmail bespoke (`sendGmailMessage`,
 * `buildReportEmail`, `resolveEditorEmail`, `defaultHasCredentials`,
 * `dispatchReportEmail`) foi removido — já estava morto na prática desde
 * que `registerReport` ganhou `notify = false` como default (#7957/#8077)
 * e nenhum caller de produção passava `notify: true` explícito.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { escHtml } from "../lib/html-escape.ts";
import { notifyEditor } from "../lib/editor-notify.ts"; // #7960 (item 5 da #7957) — substitui o canal de Gmail bespoke
import { acquireLock, releaseLock } from "../lib/file-lock.ts"; // #4677 — lock + write atômico do registry

// #4347: "clarice-novos" — relatório da skill /diaria-clarice-novos (rodada
// sem gate humano do laço cadastro-novo→envio-imediato, D14).
// #5026: "clarice-envio" — relatório da task diária Diaria-Clarice-Envio
// (19:00, planeja+agenda) e do guard Diaria-Clarice-Envio-Guard (05:00,
// cancela — recriar uma onda podada é follow-up NÃO implementado nesta
// versão, ver docstring de clarice-envio-guard.ts) — mesmo kind pros dois,
// `sessionId` distingue (`envio-{AAMMDD}...` vs `envio-{AAMMDD}-guard...`).
// #5236: "cac" — relatório de custo por leitor por canal (`scripts/cac-report.ts`),
// `sessionId` = data do snapshot Beehiiv usado (`YYYY-MM-DD`).
// #7978: "calibration" — relatório de evidência de 1 PR de calibração de
// score/seleção/prompt (portão de promoção, Camada 5 da #7972).
// `sessionId` = número da PR (ex: "8010"). `scripts/generate-calibration-evidence-report.ts`
// é o único chamador — nunca disparado automaticamente por overnight/develop
// (a REGRA DE OURO exige que uma calibração real sempre seja aberta e
// registrada por um fluxo que passa pelo gate de sign-off, nunca autônomo).
// #8144: "agent-eval" — relatório de 1 rodada do eval de regressão de prompt
// (#8143) sobre o(s) agent(s) que uma PR específica mudou (corpo ou
// `model:`). `sessionId` = número da PR (mesmo padrão de "calibration").
// `scripts/run-agent-eval-for-pr.ts` é o único chamador — roda na esteira
// overnight/develop (sessão autenticada claude.ai, #5608), nunca no runner
// do GitHub Actions (`scripts/check-agent-eval-required.ts` só DECIDE se
// precisa, nunca EXECUTA — ver docstring dos dois).
// #7960 (item 4 da #7957): "ads-digest" — digest DIÁRIO de gasto em ads
// (`scripts/ads-daily-digest.ts`), que até então saía por e-mail todo dia.
// `sessionId` = `periodDate` (`YYYY-MM-DD`, o dia coberto pelo digest).
// É `severity: "info"` no vocabulário do portão `notifyEditor` — nunca
// acionável; o que exige ação continua nos alarmes condicionais dedicados
// (`ads-test-watch.ts`, `ads-kill-switch-alarm.ts`).
// #7982: "calibration-audit" — auditoria contínua da autocalibração: relatório
// TRIMESTRAL de crescimento de allowlists e relatório MENSAL de minutos de toque
// por fase (`scripts/calibration-allowlist-growth-report.ts`,
// `scripts/calibration-touch-minutes-report.ts`). `sessionId` = `allowlist-YYYY-Qn`
// ou `touch-YYYY-MM`. Somente leitura, sem e-mail.
/**
 * Lista canônica dos kinds — **fonte única**. O tipo `ReportKind` é DERIVADO
 * dela (`(typeof VALID_KINDS)[number]`), e não o contrário: por construção
 * não existe membro da união que não esteja aqui, então o modo de falha que
 * o guard anterior dizia cobrir (kind na união, ausente na lista →
 * `isReportKind()` rejeita em runtime → `registerReport` descarta o
 * relatório em silêncio) deixou de ser representável (#8409).
 *
 * O guard anterior NÃO cobria isso: era um `Record<ReportKind, true>`
 * montado com `Object.fromEntries(...) as Record<ReportKind, true>`, e o
 * `as` é asserção, não verificação estrutural — compilava com qualquer
 * conteúdo. Ver `test/report-kind-exhaustiveness-8409.test.ts`, que compila
 * os dois padrões lado a lado com `tsc` e prova a diferença.
 */
const VALID_KINDS = [
  "edicao",
  "overnight",
  "develop",
  "mensal",
  "clarice-novos",
  "clarice-envio",
  "cac",
  "calibration",
  "agent-eval",
  "ads-digest",
  "calibration-audit",
] as const;

export type ReportKind = (typeof VALID_KINDS)[number];

export function isReportKind(value: string): value is ReportKind {
  return (VALID_KINDS as readonly string[]).includes(value);
}

const REPORTS_DIR = "data/reports";
const REGISTRY_FILE = "index.jsonl";

function registryPath(rootDir: string): string {
  return resolve(rootDir, REPORTS_DIR, REGISTRY_FILE);
}

/** Id estável do relatório — `{kind}-{sessionId}` (ex: `overnight-260720`).
 * Registrar de novo o mesmo `(kind, sessionId)` (relatório regenerado, ex:
 * `edition-report.html` reescrito em 6b-8 depois do 6b-6 descartável) reusa o
 * mesmo id — `registerReport` faz upsert por esse id (#4666), então a entrada
 * anterior é substituída, nunca duplicada. */
export function reportId(kind: ReportKind, sessionId: string): string {
  return `${kind}-${sessionId}`;
}

export interface ReportRegistryInput {
  kind: ReportKind;
  /** AAMMDD (edição/overnight/develop) ou ciclo (mensal, ex: "2605-06"). */
  sessionId: string;
  title: string;
  /** Path do relatório (HTML ou markdown) já persistido pelo caller,
   * relativo a `rootDir` — NUNCA absoluto (o registry é portável entre
   * máquinas via o junction `data/` do OneDrive). */
  htmlPath: string;
  /** ISO timestamp — default `now()` no momento do registro. */
  createdAt?: string;
  /**
   * #7982 item 3 — timestamp da decisão do editor sobre um PR de calibração
   * (`kind: "calibration"`; hoje `mergedAt` da PR, gravado por
   * `scripts/record-calibration-pr-decisions.ts`). Ausente até esse produtor
   * rodar; `renderLatencyMarkdown` mostra `n/d` enquanto isso.
   */
  decisionAt?: string;
  /** #7982 item 3 — minutos entre `createdAt` e `decisionAt` (proxy de tempo
   * de revisão), calculado pelo mesmo produtor acima. */
  estimatedReviewMinutes?: number;
}

export interface ReportEntry extends ReportRegistryInput {
  id: string;
  createdAt: string;
  /** Path servido pelo Studio — `GET {url}` (ver `server.ts`). */
  url: string;
  /**
   * `true` quando ALGUM registro deste `id` já disparou (ou tentou disparar) a
   * notificação via `notifyEditor` (`severity: "info"`, #7960 — antes do
   * #7960 isto gatilhava um e-mail de verdade via Gmail; hoje só garante que
   * o registro fica visível em `data/run-log.jsonl`).
   *
   * É a chave de dedup — e é deliberadamente "já NOTIFICOU", não "já existe
   * entrada". A diferença não é acadêmica: um caller pode registrar o MESMO
   * id mais de uma vez de propósito (ex: um HTML descartável seguido da
   * versão final, ver `notify:false`/`notify:true` em
   * `send-edition-report.ts`) — dedup por existência de entrada engoliria a
   * notificação da versão final. Nenhum caller de produção passa
   * `notify: true` hoje (#7960: default virou `false` em toda a cadeia), mas
   * o mecanismo continua correto pro dia em que um precisar.
   *
   * Ausente nas entradas gravadas antes do #5521 — tratado como `false`, então
   * o 1º registro pós-upgrade de uma rodada antiga ainda notifica (preferível
   * a suprimir uma notificação legítima por falta de dado histórico).
   */
  notified?: boolean;
}

export interface RegisterReportResult {
  ok: boolean;
  entry: ReportEntry | null;
  error: string | null;
  /** Resultado do disparo (best-effort) da notificação ao editor (#7960) —
   * nunca rejeita. Callers de produção ignoram (fire-and-forget: o registro
   * em `index.jsonl` já aconteceu antes deste disparo começar, então uma
   * falha de notificação nunca reflete no `ok`/`error` acima); testes podem
   * `await` pra asserção determinística. */
  notifyDispatch: Promise<ReportNotifyDispatchResult>;
}

// ─── Notificação ao editor (#7960, item 5 da #7957) ─────────────────────────
//
// Decisão do editor (19/09/2026): `registerReport` delega ao portão único
// `notifyEditor` (`scripts/lib/editor-notify.ts`), severidade `"info"`, em
// vez de manter um canal de e-mail Gmail próprio (histórico completo desse
// canal — #4475/#4708/#4478 — no bloco de comentários do topo do arquivo).
// `"info"` nunca dispara e-mail nem abre issue em NENHUMA política de
// `notifications.email_policy` — só garante que o registro fica visível em
// `data/run-log.jsonl` (`/diaria-log`, auto-reporter), além do índice do
// Studio em si. Fail-soft obrigatório, mesma disciplina do canal antigo: o
// disparo SÓ é tentado depois que o append em `index.jsonl` já terminou
// (`registerReport` chama `dispatchReportNotify` como último passo do
// caminho de sucesso), então qualquer falha nunca reflete no resultado do
// registro em si — só um warning em stderr.

/**
 * Resultado do disparo de notificação — union discriminada por `notified`
 * (mesmo desenho de #4478/type-design-analyzer que o antigo
 * `ReportEmailDispatchResult` tinha: uma interface flat permitiria o estado
 * impossível `{notified: true, error: "x"}`). 3 formas possíveis:
 *  - `{notified: true}` — `notifyEditor` rodou com sucesso.
 *  - `{notified: false, skipped: ...}` — nunca tentado: `register-failed`
 *    (o append em `index.jsonl` falhou antes do disparo — nada a notificar)
 *    ou `notify-disabled` (caller passou `notify: false` pro
 *    `registerReport` — default desde #7960, ver a chamada "descartável"
 *    6b-6 do Stage 6 em `send-edition-report.ts`).
 *  - `{notified: false, error: ...}` — `deps.notify` lançou (não deveria
 *    acontecer com a implementação de produção — `notifyEditor` em
 *    `severity: "info"` só grava em `data/run-log.jsonl` via `logEvent`,
 *    que é fail-soft por desenho — mas `deps.notify` é injetável, e um dep
 *    de teste customizado que lance é coberto pelo mesmo `catch`).
 */
export type ReportNotifyDispatchResult =
  | { notified: true }
  | {
      notified: false;
      skipped:
        | "register-failed"
        | "notify-disabled"
        /**
         * #5521 (mecanismo herdado do antigo canal de e-mail): um registro
         * anterior deste mesmo `id` já notificou — ou seja, é RE-registro da
         * mesma rodada, não rodada nova. Como o registro é upsert e a URL do
         * relatório é derivada do `id`, o link da 1ª notificação já aponta
         * pro conteúdo mais recente — suprimir as notificações seguintes não
         * esconde nada do editor.
         */
        | "already-notified"
    }
  | { notified: false; error: string };

/** Dependências injetáveis do disparo de notificação — mesmo padrão de
 * `AdsDailyDigestDeps.notify` (`scripts/ads-daily-digest.ts`), que já
 * injeta `notifyEditor` da mesma forma para o mesmo fim (#7960 item 4). */
export interface ReportNotifyDeps {
  /** `notifyEditor` injetável (testes) — default a implementação de
   * produção de `scripts/lib/editor-notify.ts`. */
  notify: typeof notifyEditor;
}

const defaultNotifyDeps: ReportNotifyDeps = {
  notify: notifyEditor,
};

/** URL pública do relatório pro link da notificação — prefere
 * `STUDIO_REMOTE_URL` (túnel Cloudflare, acessível fora da rede
 * local/mobile, ver `scripts/studio/verify-remote-tunnel.ts`) quando
 * definida; fallback `http://127.0.0.1:{STUDIO_PORT ?? 4174}` (mesmo
 * default de `scripts/register-report.ts`). */
function resolveReportUrl(entry: ReportEntry): string {
  const base = (process.env.STUDIO_REMOTE_URL || `http://127.0.0.1:${process.env.STUDIO_PORT ?? "4174"}`).replace(
    /\/$/,
    "",
  );
  return `${base}${entry.url}`;
}

/**
 * Dispara (best-effort) a notificação de um relatório recém-registrado via
 * `notifyEditor({severity: "info"})` (#7960). Nunca lança — qualquer falha
 * vira `{notified: false, error}` e um warning em stderr; o caller
 * (`registerReport`) já persistiu a entry em `index.jsonl` antes de chamar
 * isto, então o registro em si nunca depende do resultado da notificação.
 *
 * Corpo leve (título + link) — não embute mais o conteúdo completo do
 * relatório (isso era específico do e-mail lido na caixa de entrada, #4708;
 * ver histórico no topo do arquivo). `"info"` só precisa ficar visível em
 * `data/run-log.jsonl`; o conteúdo completo já está a 1 clique via
 * `entry.url`/`resolveReportUrl`, servido pelo próprio Studio.
 *
 * **Limitação conhecida, aceita (achado do silent-failure-hunter na PR
 * #8452, #8453):** pra `severity: "info"`, `notifyEditor` só chama
 * `logEvent` (`scripts/lib/run-log.ts`), que NUNCA lança (fail-soft por
 * design — "logging must never mask the original error"). Ou seja, o
 * `catch` abaixo nunca captura uma falha real de escrita em
 * `run-log.jsonl` (permissão, disco cheio, lock do OneDrive) — `notified`
 * fica `true` mesmo que o log não tenha sido gravado. Comportamento
 * PRÉ-EXISTENTE do portão `notifyEditor` (já documentado em
 * `worker-drift-check.ts` como trade-off aceito ao trocar o Gmail — que
 * lançava — por este portão), não introduzido por esta migração — os
 * outros 2 callers atuais (`weekly-worker-dlq-alarm.ts`,
 * `kit-subscriber-limit-alarm.ts`) já convivem com o mesmo gap. Risco
 * atual zero: todo caller de produção de `registerReport` fixa
 * `notify: false`. Consertar exige mexer em `logEvent`/`editor-notify.ts`
 * (afeta todos os callers do portão) — ver #8453 antes de ligar
 * `notify: true` em qualquer caller novo.
 */
export async function dispatchReportNotify(
  rootDir: string,
  entry: ReportEntry,
  deps: ReportNotifyDeps = defaultNotifyDeps,
): Promise<ReportNotifyDispatchResult> {
  try {
    const url = resolveReportUrl(entry);
    await deps.notify(
      {
        check: "studio-report",
        fingerprint: entry.id,
        severity: "info",
        subject: entry.title,
        body: `${entry.title}\n\nVer no Studio: ${url}`,
      },
      { cwd: rootDir, rootDir },
    );
    return { notified: true };
  } catch (e) {
    // Mesmo padrão de `scripts/lib/exit-handler.ts::runMain`: `(e as
    // Error).message` faria uma falha esperada e um bug de código novo
    // (throw de um valor não-Error) gerarem o MESMO log "fail-soft, ignore",
    // sem stack trace pra diferenciar os dois casos.
    const message = e instanceof Error ? e.message : String(e);
    console.warn(
      `[studio-reports] aviso: notifyEditor falhou pro relatório ${entry.id} (fail-soft, registro em index.jsonl já concluído): ${message}`,
    );
    if (e instanceof Error && e.stack) {
      console.warn(e.stack);
    }
    return { notified: false, error: message };
  }
}

/**
 * Registra um relatório — upsert de 1 linha JSON em `data/reports/index.jsonl`,
 * indexado por `reportId(kind, sessionId)` (#4666). Antes de escrever, remove
 * qualquer linha existente com o MESMO id — registrar de novo o mesmo
 * `(kind, sessionId)` (relatório regenerado, ou uma correção como o caso que
 * abriu a #4666: rodada abortou, registrou "0 contatos", depois foi retomada
 * manualmente e re-registrada com o resultado real) SUBSTITUI a entrada
 * anterior no arquivo físico, nunca deixa as duas coexistindo. Linhas
 * corrompidas (JSON inválido, ou sem campo `id` string) são preservadas
 * verbatim — este passo só remove o que consegue identificar com certeza como
 * "mesmo id", nunca arrisca descartar dado que não conseguiu interpretar.
 *
 * **#4677 (fleet review do #4666): lock + escrita atômica.** O read-modify-write
 * inteiro (ler o registry, montar `nextLines`, gravar) roda sob
 * `acquireLock`/`releaseLock` (`scripts/lib/file-lock.ts`, mesmo mecanismo de
 * `social-published-store.ts`) — `index.jsonl` é escrito por processos
 * concorrentes independentes (overnight, develop, diária, `clarice-novos`,
 * CLI manual), então sem lock um "lost update" é só uma questão de timing:
 * dois writers leem o mesmo snapshot, o segundo grava por cima do primeiro. A
 * gravação em si vai pra um `.tmp` e só then `renameSync` pro path vivo —
 * `rename` é atômico no filesystem, então uma falha (crash, disco cheio,
 * OneDrive segurando o arquivo — `data/` é junction, ver CLAUDE.md) nunca
 * deixa o arquivo real truncado ou vazio; na pior hipótese sobra um `.tmp`
 * órfão, nunca a perda do registry inteiro.
 *
 * **Fail-soft por design (#3714):** qualquer falha de escrita (disco cheio,
 * permissão, `rootDir` inválido) nunca lança — retorna `{ok: false, error}`.
 * O caller (send-edition-report.ts, fechos de overnight/develop) não deve
 * travar o pipeline por causa do registro no Studio; é só observabilidade
 * extra, não um passo crítico.
 *
 * **#7960 (item 5 da #7957, decisão do editor 19/09/2026): também notifica
 * via `notifyEditor({severity: "info"})`** (título + link, best-effort, via
 * `dispatchReportNotify`) depois que o upsert acima já terminou — a promise
 * fica disponível em `result.notifyDispatch` pra quem quiser aguardar
 * (testes) mas NUNCA precisa ser aguardada por callers de produção
 * (fail-soft: `dispatchReportNotify` nunca rejeita). Isto substitui o canal
 * de e-mail Gmail bespoke que existia até aqui (#4475/#4708/#4478, ver
 * histórico no topo do arquivo) — `"info"` nunca dispara e-mail nem abre
 * issue em nenhuma política de `notifications.email_policy`.
 *
 * **`notify` suprime o disparo sem afetar o registro (#4478, mecanismo
 * preservado da migração).** O Stage 6 diário chama `send-edition-report.ts`
 * 2× pro MESMO id (`edicao-{AAMMDD}`) — 6b-6 gera `edition-report.html` só
 * pra satisfazer `blockReasonForMarkingStageDone` (o próprio doc descreve
 * essa geração como "descartável"); 6b-8 regenera e registra de novo o
 * MESMO id como ÚLTIMO passo do pipeline. Sem supressão,
 * `dispatchReportNotify` dispararia 1× em 6b-6 e outra em 6b-8. `notify:
 * false` pula o disparo inteiramente (nem chama `dispatchReportNotify`) e
 * resolve `notifyDispatch` direto com `{notified: false, skipped:
 * "notify-disabled"}` — o upsert em `index.jsonl` acontece igual, só a
 * notificação é que não sai.
 *
 * **#7960 (item 4 da #7957, PR #8077): default virou `false`.** Antes,
 * `true` preservava o comportamento anterior (#4475: todo registro
 * notifica) pra todo caller que não passasse nada. A tabela de severidade
 * do editor (#7957, 10/09/2026) classifica TODO relatório registrado aqui —
 * edição, overnight/develop, Clarice novos/envio/guard, CAC, calibração —
 * como "Studio /relatorios, sem e-mail": o editor lê no `/relatorios`. Nenhum
 * caller de produção passa `notify` explicitamente (todos dependiam deste
 * default) — a mudança silencia TODOS eles de uma vez, que é exatamente o
 * objetivo. O parâmetro continua existindo (e a lógica de dedup/retry abaixo
 * continua exercitável via `notify: true` explícito) caso uma severidade
 * mais alta precise deste canal no futuro — mas hoje nenhum caller o faz.
 *
 * **Assimetria conhecida (achado do fleet review da PR #8077, baixa
 * prioridade, não endereçada):** `editor-notify.ts` (#7957) faz esse MESMO
 * tipo de rollout via config (`platform.config.json` ->
 * `notifications.email_policy`, `"legacy"`/`"urgent_only"`) — reversível
 * com 1 linha de config, sem tocar código. Aqui o default virou `false`
 * como LITERAL no código — reverter exige mudar este arquivo (e
 * `writeReportFile`/`writeEditionReport`/`ensureEditionReport`/
 * `register-report.ts`, que repassam o mesmo default adiante), não um
 * flip de config. Aceito deliberadamente: o canal de relatório não tem
 * rollout gradual planejado (diferente de `editor-notify.ts`, que
 * convivia com remetentes ainda não migrados durante a transição) — se
 * isso mudar, migrar pra uma chave própria em `notifications` é a
 * correção natural.
 */
export function registerReport(
  rootDir: string,
  input: ReportRegistryInput,
  notifyDeps: ReportNotifyDeps = defaultNotifyDeps,
  notify = false,
): RegisterReportResult {
  const id = reportId(input.kind, input.sessionId);
  const createdAt = input.createdAt ?? new Date().toISOString();
  let alreadyNotified = false;
  const entry: ReportEntry = {
    ...input,
    id,
    createdAt,
    url: `/relatorios/${id}`,
  };
  try {
    mkdirSync(resolve(rootDir, REPORTS_DIR), { recursive: true });
    const path = registryPath(rootDir);
    const lockPath = path + ".lock";
    acquireLock(lockPath);
    try {
      // #5521: dedup de e-mail por "já NOTIFICOU", nunca por "já existe
      // entrada" — ver `ReportEntry.notified`.
      alreadyNotified = readPreviousEntry(path, id)?.notified === true;
      const willNotify = notify && !alreadyNotified;
      entry.notified = alreadyNotified || willNotify;

      const otherLines = readLinesExcludingId(path, id);
      const nextLines = [...otherLines, JSON.stringify(entry)];
      const tmpPath = path + ".tmp";
      writeFileSync(tmpPath, nextLines.join("\n") + "\n", "utf8");
      renameSync(tmpPath, path);
    } finally {
      releaseLock(lockPath);
    }
    return {
      ok: true,
      entry,
      error: null,
      notifyDispatch: !notify
        ? Promise.resolve<ReportNotifyDispatchResult>({ notified: false, skipped: "notify-disabled" })
        : alreadyNotified
          ? Promise.resolve<ReportNotifyDispatchResult>({ notified: false, skipped: "already-notified" })
          : // #5521: `notified` é gravado OTIMISTA (antes do disparo, que é
            // assíncrono e fire-and-forget). Se `notifyEditor` lançar (dep de
            // teste customizado — a implementação de produção não lança, ver
            // docstring de `dispatchReportNotify`), desfazer a marca, senão a
            // rodada fica marcada como notificada para sempre e a notificação
            // se perde em silêncio: um retry veria `already-notified` e não
            // tentaria de novo. Fail-soft como todo este caminho.
            dispatchReportNotify(rootDir, entry, notifyDeps).then((result) => {
              if (!result.notified) clearNotifiedFlag(rootDir, id);
              return result;
            }),
    };
  } catch (e) {
    return {
      ok: false,
      entry: null,
      error: (e as Error).message,
      notifyDispatch: Promise.resolve<ReportNotifyDispatchResult>({ notified: false, skipped: "register-failed" }),
    };
  }
}

/**
 * Desfaz `notified` quando o disparo não aconteceu (#5521) — deixa a próxima
 * invocação livre pra tentar de novo. Fail-soft: qualquer erro aqui é
 * engolido, porque isto roda depois do registro já ter sucedido e nunca deve
 * transformar "notificação falhou" em "registro falhou".
 */
function clearNotifiedFlag(rootDir: string, id: string): void {
  try {
    const path = registryPath(rootDir);
    const lockPath = path + ".lock";
    acquireLock(lockPath);
    try {
      const previous = readPreviousEntry(path, id);
      if (!previous || previous.notified !== true) return;
      const otherLines = readLinesExcludingId(path, id);
      const nextLines = [...otherLines, JSON.stringify({ ...previous, notified: false })];
      const tmpPath = path + ".tmp";
      writeFileSync(tmpPath, nextLines.join("\n") + "\n", "utf8");
      renameSync(tmpPath, path);
    } finally {
      releaseLock(lockPath);
    }
  } catch {
    // best-effort — ver docstring.
  }
}

/** Entrada já gravada para `id`, se houver (#5521). */
function readPreviousEntry(path: string, id: string): Partial<ReportEntry> | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<ReportEntry>;
      if (parsed?.id === id) return parsed;
    } catch {
      // linha corrompida — ignorar
    }
  }
  return null;
}

/**
 * Lê `path` (se existir) e retorna todas as linhas não-vazias EXCETO a(s) que
 * tem `id` igual a `excludeId` — usado por `registerReport` pra fazer upsert
 * (#4666): as linhas restantes formam a base sobre a qual a nova entrada é
 * acrescentada.
 *
 * Linha corrompida (JSON inválido, ou sem campo `id` string) é preservada
 * verbatim — sem conseguir confirmar que é "o mesmo id", o upsert nunca a
 * descarta (mesma disciplina fail-soft de `listReports`, que ignora essas
 * linhas na LEITURA sem apagá-las do arquivo).
 */
function readLinesExcludingId(path: string, excludeId: string): string[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const kept: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<ReportEntry>;
      if (typeof parsed?.id === "string" && parsed.id === excludeId) {
        continue; // será substituída pela entrada nova logo em seguida.
      }
    } catch {
      // linha corrompida — não dá pra saber o id, preserva como está.
    }
    kept.push(line);
  }
  return kept;
}

/**
 * Lê o registry inteiro, dedupa por id (última linha física vence) e ordena
 * por `createdAt` desc (mais recente no topo — #3714 pede "mais recentes no
 * topo").
 *
 * **O dedup aqui é defensivo, não a linha de defesa principal (#4666).** Desde
 * #4666 `registerReport` já garante por construção que o arquivo nunca tem 2
 * linhas pro mesmo id (upsert na escrita) — este `byId.set` continua existindo
 * pra tolerar registry legado (linhas duplicadas escritas antes do fix) sem
 * exigir migração, e como defesa em profundidade caso outra escrita direta no
 * arquivo (fora de `registerReport`) volte a introduzir duplicatas.
 *
 * Fail-soft: registry ausente → `[]`; linha corrompida é ignorada
 * silenciosamente (nunca derruba a listagem inteira) — mesma convenção de
 * `tailJsonl`/outros leitores de jsonl do repo.
 */
export function listReports(rootDir: string): ReportEntry[] {
  const path = registryPath(rootDir);
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const byId = new Map<string, ReportEntry>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Partial<ReportEntry>;
      if (
        entry &&
        typeof entry.id === "string" &&
        typeof entry.kind === "string" &&
        typeof entry.sessionId === "string" &&
        typeof entry.title === "string" &&
        typeof entry.htmlPath === "string" &&
        typeof entry.createdAt === "string" &&
        typeof entry.url === "string"
      ) {
        byId.set(entry.id, entry as ReportEntry);
      }
    } catch {
      // linha corrompida (escrita concorrente truncada, etc.) — ignora.
    }
  }

  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** Busca uma entry específica pelo id (`{kind}-{sessionId}`) — `null` se
 * nunca registrada ou registry ausente. */
export function getReportById(rootDir: string, id: string): ReportEntry | null {
  return listReports(rootDir).find((r) => r.id === id) ?? null;
}

export interface PruneReportsRegistryResult {
  ok: boolean;
  /** Linhas não-vazias no arquivo antes da limpeza (0 se o registry não existe). */
  linesBefore: number;
  /** Linhas escritas de volta (1 por id único válido). */
  linesAfter: number;
  /** Linhas com `id` válido descartadas por serem cópia mais antiga do mesmo id. */
  removedDuplicates: number;
  /** Linhas descartadas por não terem `id` string (JSON inválido ou campo ausente). */
  removedCorrupted: number;
  error: string | null;
}

/**
 * Ação de manutenção ONE-OFF (#4666) — reescreve `data/reports/index.jsonl`
 * mantendo só 1 linha por id (a última fisicamente escrita, mesmo critério de
 * `listReports`) e descartando linhas corrompidas. Nunca precisa rodar em uso
 * normal: a partir de #4666 `registerReport` já faz upsert na escrita, então
 * o arquivo nunca mais acumula uma duplicata NOVA. Este helper existe só pra
 * limpar o histórico de duplicatas que se acumulou ANTES do fix (ex:
 * `clarice-novos-novos-260805`, caso que abriu a issue) — CLI fina em
 * `scripts/prune-reports-registry.ts`.
 *
 * **#4677:** mesmo lock + escrita atômica (`.tmp` + `renameSync`) de
 * `registerReport` — a reescrita completa do arquivo é o mesmo padrão
 * read-modify-write, sujeito ao mesmo risco de lost update se rodar
 * concorrente com um `registerReport` de outro processo.
 *
 * Idempotente: rodar de novo sobre um arquivo já limpo não remove nada
 * (`removedDuplicates`/`removedCorrupted` saem 0). Fail-soft, mesma disciplina
 * de `registerReport` — qualquer falha de I/O vira `{ok: false, error}`, nunca
 * lança.
 */
export function pruneReportsRegistry(rootDir: string): PruneReportsRegistryResult {
  const path = registryPath(rootDir);
  if (!existsSync(path)) {
    return { ok: true, linesBefore: 0, linesAfter: 0, removedDuplicates: 0, removedCorrupted: 0, error: null };
  }
  const lockPath = path + ".lock";
  try {
    let rawLines: string[] = [];
    let keptLines: string[] = [];
    let removedCorrupted = 0;

    acquireLock(lockPath);
    try {
      const raw = readFileSync(path, "utf8");
      rawLines = raw.split("\n").filter((l) => l.trim());

      const byId = new Map<string, string>();
      for (const line of rawLines) {
        let id: string | null = null;
        try {
          const parsed = JSON.parse(line) as Partial<ReportEntry>;
          if (typeof parsed?.id === "string") id = parsed.id;
        } catch {
          // segue null — tratado como corrompida abaixo.
        }
        if (id === null) {
          removedCorrupted++;
          continue;
        }
        byId.set(id, line); // última linha física por id vence.
      }

      keptLines = [...byId.values()];
      const tmpPath = path + ".tmp";
      writeFileSync(tmpPath, keptLines.length ? keptLines.join("\n") + "\n" : "", "utf8");
      renameSync(tmpPath, path);
    } finally {
      releaseLock(lockPath);
    }

    return {
      ok: true,
      linesBefore: rawLines.length,
      linesAfter: keptLines.length,
      removedDuplicates: rawLines.length - keptLines.length - removedCorrupted,
      removedCorrupted,
      error: null,
    };
  } catch (e) {
    return {
      ok: false,
      linesBefore: 0,
      linesAfter: 0,
      removedDuplicates: 0,
      removedCorrupted: 0,
      error: (e as Error).message,
    };
  }
}

export interface ReportRenderResult {
  ok: boolean;
  html: string;
}

/** Só linkifica esquemas conhecidos-seguros — nunca `javascript:`/`data:` etc.
 * (defesa extra: o conteúdo vem de output de agente, não de input confiável).
 * `/` sozinho é aceito (path relativo interno, ex: `/relatorios/outro-id`),
 * mas `//` (URL protocol-relative — resolve pro esquema da página atual,
 * `https:` em produção) é explicitamente rejeitado (#3788 Bug 2): sem essa
 * negative lookahead, `//evil.example/phish` casava no ramo `\/` sozinho e
 * virava um link clicável de phishing que escapou do allowlist. Bloqueia
 * também `/\` (barra seguida de contrabarra, ex: `/\evil.example/phish`) —
 * browsers normalizam `\` pra `/` na posição de authority delimiter, então
 * essa variante é o MESMO bypass do Bug 2 com um caractere diferente
 * (achado no self-review desta PR, nunca reportado na issue original). */
function isSafeUrl(url: string): boolean {
  return /^(https?:\/\/|mailto:|#|\/(?![/\\]))/i.test(url);
}

/** Aplica bold/itálico/código (nunca link) — usado tanto no texto fora de
 * links quanto no LABEL de um link (nunca na URL, ver `renderInline`).
 *
 * **Código roda PRIMEIRO, via extração por placeholder (#3797).** Antes,
 * código rodava por último, assumindo que os regexes de itálico (que exigem
 * delimitador não seguido/precedido de espaço) nunca casariam dentro de um
 * code-span já formado. Isso não cobre o caso em que o delimitador de ênfase
 * É o próprio conteúdo do code-span — bold ou itálico entre crases — onde
 * bold/itálico rodando antes do código corrompem a sintaxe literal que o
 * autor queria mostrar crua (ex: comentário/PR que documenta a sintaxe deste
 * próprio renderer). Agora cada code-span é extraído primeiro pro array
 * `codeSpans`, substituído por um token opaco (prefixo/sufixo `@@mdcode:...@@`
 * com um componente ALEATÓRIO por chamada — `session`, via `randomUUID()` —
 * pra nunca colidir com texto real do documento, mesma disciplina
 * anti-colisão usada pelo placeholder de link em `renderInline`) e só
 * restaurado depois que bold/itálico já rodaram sobre o resto da string — o
 * conteúdo do code-span nunca é reprocessado.
 *
 * **Ordem bold → itálico (#3790), depois restauração do código.** bold
 * (`**x**`) roda primeiro e consome TODOS os pares de asterisco duplo, então
 * quando o passe de itálico roda depois não sobra `**` pra confundir com
 * `*x*` (evita que `**negrito**` vire itálico-de-asterisco-solto por
 * acidente). Os regexes de itálico exigem fronteira de palavra (`\w`) nas
 * bordas — isso é o que protege identificadores `snake_case` e o marcador de
 * lista `- item`/`* item` (que já foi consumido pela regex de item de lista
 * ANTES desta função ser chamada — o `*`/`-` inicial nunca chega aqui) de
 * virarem itálico por engano. */
function applyInlineMarks(s: string): string {
  const session = randomUUID().replace(/-/g, "");
  const codeSpans: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, code: string) => {
    const token = `@@mdcode:${session}:${codeSpans.length}@@`;
    codeSpans.push(`<code>${code}</code>`);
    return token;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, "<em>$1</em>");
  s = s.replace(/(?<!\w)_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, "<em>$1</em>");
  codeSpans.forEach((code, i) => {
    s = s.split(`@@mdcode:${session}:${i}@@`).join(code);
  });
  return s;
}

/** Aplica as transformações inline markdown→HTML (bold, itálico, código,
 * link) a um trecho de texto que já passou por `escHtml` — nunca chamar em
 * texto cru.
 *
 * **Ordem deliberada (#3788 Bug 3):** link é processado PRIMEIRO — extrai
 * label+url, aplica bold/código só ao LABEL (nunca à URL) e protege a tag
 * `<a>` já montada com um placeholder opaco (sem `*`/crase) antes dos passes
 * de bold/código rodarem sobre o resto do texto. Sem isso, uma URL contendo
 * `**` ou crase seria re-escaneada pelos passes seguintes e o `href` sairia
 * corrompido (`href="https://evil.com/<strong>pwn</strong>"`) — a versão
 * anterior processava link→bold→code em sequência sobre a MESMA string
 * mutável, deixando o href exposto a esse re-scan.
 *
 * **Restauração do placeholder é posicionalmente segura via token aleatório
 * por chamada (#3797 Bug 2).** Antes, o token era `__mdlink_N__` — um padrão
 * PREVISÍVEL — e a restauração usava `split/join` (substitui TODA ocorrência
 * da substring, não só a posição onde o placeholder foi de fato inserido).
 * Se o LABEL de um link contivesse literalmente o texto de um token que
 * ainda ia ser criado por um link processado depois na mesma linha (ex:
 * `[__mdlink_1__](url-boa)` seguido de um 2º link que gera exatamente o
 * token `__mdlink_1__`), a passada de restauração do 2º link casava também
 * essa ocorrência "acidental" dentro do label do 1º — produzindo `<a>`
 * aninhado (HTML inválido) e uma repetição indevida do 2º link. Agora o
 * token inclui um componente aleatório (`session`, via `randomUUID()`)
 * gerado UMA vez por chamada de `renderInline` — nenhum texto de usuário
 * (que só chega até aqui depois de `escHtml`, então nunca contém o padrão
 * `@@mdlink:...@@` cru gerado nesta invocação específica) pode colidir com
 * ele, então o `split/join` continua simples mas agora é seguro: garantido
 * que a única ocorrência da string é a que foi inserida por este código. */
function renderInline(escapedText: string): string {
  const session = randomUUID().replace(/-/g, "");
  const placeholders: string[] = [];
  let s = escapedText.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    if (!isSafeUrl(url)) return applyInlineMarks(label);
    const anchor = `<a href="${url}" target="_blank" rel="noopener noreferrer">${applyInlineMarks(label)}</a>`;
    const token = `@@mdlink:${session}:${placeholders.length}@@`;
    placeholders.push(anchor);
    return token;
  });
  s = applyInlineMarks(s);
  placeholders.forEach((anchor, i) => {
    s = s.split(`@@mdlink:${session}:${i}@@`).join(anchor);
  });
  return s;
}

function renderTable(rows: string[][]): string {
  const [header, ...body] = rows;
  const thead = `<thead><tr>${header.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>`;
  const tbody = body.length
    ? `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>`
    : "";
  return `<table>${thead}${tbody}</table>`;
}

/**
 * Renderer markdown→HTML mínimo, zero-dep (#3784 — decisão do briefing: sem
 * lib `marked`/similar, "zero custo recorrente" também vale pra dependências
 * novas). Cobre o que `data/overnight|develop/{sessão}/report.md` de fato usa:
 * headings `#`/`##`/`###`, `**bold**`, `*itálico*`/`_itálico_` (#3790), `---`
 * como `<hr>`, parágrafos, listas `- item` e `1. item` (#3790), code fences
 * ` ``` ` (#3790, preservado literal em `<pre><code>`, sem syntax highlight)
 * e tabelas markdown (`| col | col |` + linha separadora `|---|---|`, só na
 * posição imediatamente após o header — #3789). Não é um parser CommonMark
 * completo (sem blockquotes, listas aninhadas, etc.) — suficiente pra leitura
 * no Studio sem investir num parser novo nesta fatia.
 *
 * **Ordem de segurança:** escapa o texto CRU inteiro primeiro (`escHtml`), só
 * depois aplica as transformações markdown em cima do texto já escapado —
 * HTML embutido no markdown (ex: um agente reportando `<script>` em texto
 * livre) nunca vira tag real, só entidade visível. Isso inclui o conteúdo de
 * code fences: como o `escHtml` já rodou sobre o texto inteiro ANTES do split
 * por linha, o conteúdo dentro de ` ``` ` já está seguro sem precisar de
 * processamento adicional (e sem re-rodar markdown inline dentro do bloco —
 * code é sempre literal).
 */
export function renderMarkdownToHtml(raw: string): string {
  const lines = escHtml(raw).split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let ulOpen = false;
  let olOpen = false;
  let tableRows: string[][] | null = null;
  let codeFenceOpen = false;
  let codeFenceLines: string[] = [];
  // #3796: comprimento (nº de backticks) da fence de ABERTURA — CommonMark
  // exige que o fechamento tenha comprimento >= abertura, senão uma fence de
  // 4 backticks fecharia numa linha interna de só 3 (conteúdo que devia ficar
  // literal dentro do bloco escaparia e seria reprocessado como markdown).
  let codeFenceMarkerLen = 0;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.join(" ")}</p>`);
      paragraph = [];
    }
  };
  const closeUl = () => {
    if (ulOpen) {
      out.push("</ul>");
      ulOpen = false;
    }
  };
  const closeOl = () => {
    if (olOpen) {
      out.push("</ol>");
      olOpen = false;
    }
  };
  const closeTable = () => {
    if (tableRows && tableRows.length) {
      out.push(renderTable(tableRows));
    }
    tableRows = null;
  };
  const closeBlocks = () => {
    flushParagraph();
    closeUl();
    closeOl();
    closeTable();
  };
  const flushCodeFence = () => {
    out.push(`<pre><code>${codeFenceLines.join("\n")}</code></pre>`);
    codeFenceLines = [];
    codeFenceOpen = false;
    codeFenceMarkerLen = 0;
  };

  for (const rawLine of lines) {
    // Code fence é tratado ANTES de qualquer outra detecção de sintaxe —
    // enquanto aberto, TODA linha (inclusive vazia, `---`, `| tabela |`) é
    // conteúdo literal do bloco, nunca reinterpretada como markdown (#3790).
    if (codeFenceOpen) {
      // #3796: só fecha se o comprimento da fence de fechamento for >= o da
      // abertura (CommonMark) — uma fence de 4 backticks não fecha numa
      // linha interna de 3 (ex: bloco que documenta code fences de 3
      // backticks dentro de um bloco de 4).
      const closeMatch = rawLine.trim().match(/^(`{3,})\s*$/);
      if (closeMatch && closeMatch[1].length >= codeFenceMarkerLen) {
        flushCodeFence();
      } else {
        codeFenceLines.push(rawLine);
      }
      continue;
    }

    const line = rawLine.trim();

    const fenceOpen = line.match(/^(`{3,})/);
    if (fenceOpen) {
      // Abre o fence — a info string opcional (ex: ```ts) é descartada, sem
      // syntax highlight (#3790). Guarda o comprimento (#3796) pra comparar
      // no fechamento.
      closeBlocks();
      codeFenceOpen = true;
      codeFenceLines = [];
      codeFenceMarkerLen = fenceOpen[1].length;
      continue;
    }
    if (line === "") {
      closeBlocks();
      continue;
    }
    if (/^-{3,}$/.test(line)) {
      closeBlocks();
      out.push("<hr>");
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeBlocks();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    if (line.startsWith("|") && line.endsWith("|")) {
      flushParagraph();
      closeUl();
      closeOl();
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      const isSeparatorRow = cells.every((c) => /^:?-+:?$/.test(c));
      // #3789: só a linha imediatamente seguinte ao header (posição — quando
      // `tableRows` tem exatamente 1 linha, o header, e nada mais) pode ser
      // tratada como separador `|---|---|`. Uma linha dash-like em qualquer
      // OUTRA posição do bloco é dado real (ex: placeholder de "N/A"),
      // preservada como row — nunca descartada silenciosamente.
      if (isSeparatorRow && tableRows && tableRows.length === 1) {
        continue;
      }
      if (!tableRows) tableRows = [];
      tableRows.push(cells);
      continue;
    }
    closeTable();

    const listItem = line.match(/^[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      closeOl();
      if (!ulOpen) {
        out.push("<ul>");
        ulOpen = true;
      }
      out.push(`<li>${renderInline(listItem[1])}</li>`);
      continue;
    }
    closeUl();

    const orderedItem = line.match(/^\d+\.\s+(.+)$/);
    if (orderedItem) {
      flushParagraph();
      if (!olOpen) {
        out.push("<ol>");
        olOpen = true;
      }
      out.push(`<li>${renderInline(orderedItem[1])}</li>`);
      continue;
    }
    closeOl();

    paragraph.push(renderInline(line));
  }
  closeBlocks();
  // Fence nunca fechado até o fim do texto (markdown malformado) — flush
  // gracioso do que foi coletado em vez de perder o conteúdo (#3790).
  // #3796: dispara mesmo com ZERO linhas de conteúdo coletadas (fence abre e
  // o input acaba ali) — antes o guard `&& codeFenceLines.length` descartava
  // esse caso em silêncio, sumindo com o marcador de abertura sem rastro
  // nenhum. Agora emite `<pre><code></code></pre>` vazio, preservando o fato
  // de que um fence foi aberto.
  if (codeFenceOpen) {
    flushCodeFence();
  }

  return out.join("\n");
}

/**
 * Resolve o conteúdo servível (HTTP) de uma `ReportEntry`.
 *
 * Guard de path traversal análogo a `resolveStaticPath` (static-serve.ts):
 * `htmlPath` vem de uma entry do registry — escrita pelos próprios scripts do
 * pipeline, mas nunca confiar cegamente num path relativo lido de um arquivo
 * em disco (#3563 mesma disciplina de escapar/validar antes de servir).
 *
 * `.html` é servido cru (edição/mensal já produzem HTML completo). Qualquer
 * outra extensão (`.md` — overnight/develop ainda geram markdown puro,
 * `report.md`) vira um wrap HTML mínimo com o corpo passado por
 * `renderMarkdownToHtml` (#3784) — headings/bold/hr/listas/tabelas viram
 * elementos de verdade em vez de markdown cru dentro de um `<pre>`.
 *
 * **`<pre>`/`<code>`/`<ol>` no CSS inline (#3798).** `renderMarkdownToHtml`
 * gera `<pre><code>` (code fences) e `<ol>` (listas numeradas) a partir de
 * `report.md`, mas o bloco `<style>` original só cobria `<code>` inline,
 * `<ul>` e headings — sem `overflow-x`/`white-space` em `<pre>`, uma linha
 * longa de code fence (comum: comando `npx tsx ... --flag` no relatório)
 * estoura a largura da página no Studio mobile (#3560), já que browsers não
 * quebram linha em `<pre>` por padrão.
 */
export function resolveReportHtml(rootDir: string, entry: ReportEntry): ReportRenderResult {
  const rootAbs = resolve(rootDir);
  const abs = resolve(rootDir, entry.htmlPath);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    return { ok: false, html: `<!doctype html><p>path inválido</p>` };
  }
  if (!existsSync(abs)) {
    return {
      ok: false,
      html: `<!doctype html><p>arquivo do relatório não encontrado: ${escHtml(entry.htmlPath)}</p>`,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (e) {
    return {
      ok: false,
      html: `<!doctype html><p>falha ao ler o relatório: ${escHtml((e as Error).message)}</p>`,
    };
  }

  if (abs.toLowerCase().endsWith(".html")) {
    return { ok: true, html: raw };
  }

  const wrapped = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${escHtml(entry.title)}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 24px; color: #222; line-height: 1.6; }
h1 { font-size: 18px; border-bottom: 2px solid #2563eb; padding-bottom: 8px; }
h2 { font-size: 16px; margin-top: 28px; }
h3 { font-size: 14px; margin-top: 20px; }
hr { border: none; border-top: 1px solid #ddd; margin: 20px 0; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px; }
th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; vertical-align: top; }
code { background: #f1f1f1; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
pre { overflow-x: auto; white-space: pre-wrap; word-break: break-word; background: #f8f8f8; padding: 12px; border-radius: 4px; }
pre code { background: none; padding: 0; }
ul, ol { padding-left: 20px; }
a { color: #2563eb; }
</style>
</head>
<body>
<h1>${escHtml(entry.title)}</h1>
${renderMarkdownToHtml(raw)}
</body>
</html>`;
  return { ok: true, html: wrapped };
}
