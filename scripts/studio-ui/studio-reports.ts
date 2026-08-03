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
 * índice append-only (`data/reports/index.jsonl`, mesma convenção de
 * `data/run-log.jsonl`/`data/sources/{slug}.jsonl`) que aponta pra esses
 * arquivos, porque não existe hoje um jeito barato de descobrir "todos os
 * relatórios de todas as sessões" sem esse índice (teria que varrer
 * `data/editions/*`, `data/overnight/*`, `data/develop/*` a cada request).
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
 * #3714.** O draft removido em #3714 era um e-mail PESADO — narrativa
 * completa colada via `create_draft` (MCP), que o editor precisava abrir e
 * ler inteiro. O que `registerReport` dispara agora (`dispatchReportEmail`,
 * via Gmail API direta — `sendGmailMessage`, mesmo mecanismo do alarme de
 * guardrail, #4064) é só título + link — um PING pra avisar que um relatório
 * novo existe, não uma reintrodução do conteúdo duplicado que #3714
 * eliminou. Decisão do editor em #4475: quer o aviso por e-mail de volta,
 * mas mantendo o Studio como onde o relatório de fato é lido.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { escHtml } from "../lib/html-escape.ts";
import { sendGmailMessage, type GmailSendResult } from "../lib/gmail-send.ts";
import { resolveEditorEmail } from "../lib/inbox-stats.ts";
import { gFetch, CREDENTIALS_PATH_TEST_OVERRIDE_ENV } from "../google-auth.ts"; // #4478 achados 1/2

// #4347: "clarice-novos" — relatório da skill /diaria-clarice-novos (rodada
// sem gate humano do laço cadastro-novo→envio-imediato, D14).
export type ReportKind = "edicao" | "overnight" | "develop" | "mensal" | "clarice-novos";

const VALID_KINDS: ReportKind[] = ["edicao", "overnight", "develop", "mensal", "clarice-novos"];

export function isReportKind(value: string): value is ReportKind {
  return (VALID_KINDS as string[]).includes(value);
}

const REPORTS_DIR = "data/reports";
const REGISTRY_FILE = "index.jsonl";

function registryPath(rootDir: string): string {
  return resolve(rootDir, REPORTS_DIR, REGISTRY_FILE);
}

/** Id estável do relatório — `{kind}-{sessionId}` (ex: `overnight-260720`).
 * Registrar de novo o mesmo `(kind, sessionId)` (relatório regenerado, ex:
 * `edition-report.html` reescrito em 6b-8 depois do 6b-6 descartável) reusa o
 * mesmo id — a leitura (`listReports`) sempre usa a linha mais recente. */
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
}

export interface ReportEntry extends ReportRegistryInput {
  id: string;
  createdAt: string;
  /** Path servido pelo Studio — `GET {url}` (ver `server.ts`). */
  url: string;
}

export interface RegisterReportResult {
  ok: boolean;
  entry: ReportEntry | null;
  error: string | null;
  /** Resultado do disparo (best-effort) do e-mail de notificação (#4475) —
   * nunca rejeita. Callers de produção ignoram (fire-and-forget: o registro
   * em `index.jsonl` já aconteceu antes deste disparo começar, então uma
   * falha de e-mail nunca reflete no `ok`/`error` acima); testes podem
   * `await` pra asserção determinística. */
  emailDispatch: Promise<ReportEmailDispatchResult>;
}

// ─── Envio de e-mail de notificação (#4475) ─────────────────────────────────
//
// Decisão do editor (#4475): todo relatório registrado no Studio também sai
// por e-mail (Gmail API direta, mesmo mecanismo do alarme de guardrail —
// `sendGmailMessage`, nunca MCP, porque callers como `/diaria-overnight`
// podem rodar sem sessão Claude Code viva no momento do registro). Fail-soft
// obrigatório: o envio SÓ é tentado depois que o append em `index.jsonl` já
// terminou (`registerReport` chama `dispatchReportEmail` como último passo do
// caminho de sucesso), então qualquer falha de rede/token/escopo nunca reflete
// no resultado do registro em si — só um warning em stderr.

/**
 * Resultado do disparo de e-mail de notificação — union discriminada por
 * `sent` (#4478, achado type-design-analyzer do fleet review #4383: a
 * interface flat anterior — `{sent: boolean, skipped?, error?}` — permitia o
 * estado impossível `{sent: true, error: "x"}`, já que "enviado" e "erro"
 * nunca coexistem de verdade). 3 formas possíveis:
 *  - `{sent: true}` — enviado com sucesso.
 *  - `{sent: false, skipped: ...}` — nunca tentado: `no-credentials` (sessão
 *    cloud ou `oauth-setup.ts` nunca rodado), `register-failed` (o append em
 *    `index.jsonl` falhou antes do disparo — nada a notificar) ou
 *    `notify-disabled` (caller passou `notify: false` pro `registerReport` —
 *    #4478, ver a chamada "descartável" 6b-6 do Stage 6).
 *  - `{sent: false, error: ...}` — tentado e falhou (rede, token, escopo —
 *    fail-soft, nunca lançado, só reportado aqui).
 */
export type ReportEmailDispatchResult =
  | { sent: true }
  | { sent: false; skipped: "no-credentials" | "register-failed" | "notify-disabled" }
  | { sent: false; error: string };

/** Dependências injetáveis do disparo de e-mail — mesmo padrão de
 * `_fetchImpl` em `sendGmailMessage` (gmail-send.ts), pra tornar
 * `dispatchReportEmail`/`registerReport` testáveis sem rede real. */
export interface ReportEmailDeps {
  sendMail: (to: string, subject: string, body: string) => Promise<GmailSendResult>;
  resolveEditorEmail: (platformConfigPath: string) => string;
  /** `true` se há credencial OAuth local capaz de enviar e-mail — default
   * checa a presença de `{rootDir}/data/.credentials.json` (mesmo sinal
   * fail-soft de `scripts/lib/exec-mode.ts`: sessão cloud/clone fresco nunca
   * tem esse arquivo, então o envio é pulado silenciosamente, não tratado
   * como erro). */
  hasCredentials: (rootDir: string) => boolean;
}

/**
 * #4478 achado 1 (fleet review #4383, CRÍTICO): respeita
 * `DIARIA_TEST_CREDENTIALS_PATH` (`CREDENTIALS_PATH_TEST_OVERRIDE_ENV`,
 * `scripts/google-auth.ts`) quando definida — mesmo override que já protege
 * `data/.credentials.json` REAL em `getAccessToken`/`gFetch` desde o #4344.
 * Sem isso, um caller que passa o `rootDir` REAL do repo em vez do `rootDir`
 * fake de teste (exatamente o que `send-edition-report.ts`/`writeReportFile`
 * fazem — `ROOT` é sempre calculado a partir do path do próprio script,
 * nunca do `--edition-dir` de teste) faz `defaultHasCredentials` checar o
 * `data/.credentials.json` de VERDADE da máquina. 2 testes pré-existentes
 * (`test/send-edition-report-out.test.ts`, `test/ensure-edition-report-1950.test.ts`)
 * bateriam no Gmail real rodando `npm test` localmente numa máquina com
 * credenciais configuradas — mesma classe de incidente do #4344, dessa vez
 * no caminho de e-mail em vez do Drive. Este fix é defesa SISTÊMICA —
 * protege qualquer caller futuro que esqueça de passar
 * `--no-email`/`notify: false`, não só os 2 identificados agora (que também
 * ganharam a flag explícita — defesa em profundidade, ver os 2 arquivos
 * citados acima).
 *
 * Exportado (só pra teste direto, sem passar por `dispatchReportEmail`/
 * `registerReport` — evita qualquer risco de acionar `defaultEmailDeps.sendMail`
 * de verdade num teste, ver `test/studio-reports.test.ts`).
 */
export function defaultHasCredentials(rootDir: string): boolean {
  const override = process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV];
  return existsSync(override || resolve(rootDir, "data", ".credentials.json"));
}

/**
 * #4478 achado 2 (silent-failure-hunter, MEDIUM-HIGH): timeout curto pro
 * fetch fire-and-forget do e-mail de notificação. `gFetch`/`authedFetch`
 * (`scripts/google-auth.ts`) chamam `fetch()` puro, sem `AbortController` —
 * e `runMain` (`scripts/lib/exit-handler.ts`) NÃO chama `process.exit()` no
 * caminho de sucesso, então o processo Node fica vivo até o event loop
 * esvaziar, inclusive um fetch pendurado. Como `send-edition-report.ts --out
 * ...` é uma chamada BLOQUEANTE do orchestrator (Stage 6, passos 6b-6/6b-8),
 * um travamento de rede/DNS durante o envio "fire-and-forget" travaria a
 * invocação inteira bem além do limite de 60s do CLAUDE.md (#738). Poucos
 * segundos bastam pra uma notificação leve (título + link) — não precisa do
 * timeout mais longo (25s) do fetch in-page do Beehiiv (#4196), que espera
 * um payload bem maior.
 */
const NOTIFY_EMAIL_TIMEOUT_MS = 8_000;

function sendMailWithTimeout(to: string, subject: string, body: string): Promise<GmailSendResult> {
  return sendGmailMessage(to, subject, body, (url: string, options: RequestInit = {}) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), NOTIFY_EMAIL_TIMEOUT_MS);
    return gFetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
  });
}

const defaultEmailDeps: ReportEmailDeps = {
  sendMail: sendMailWithTimeout,
  resolveEditorEmail,
  hasCredentials: defaultHasCredentials,
};

/** URL pública do relatório pro link do e-mail — prefere `STUDIO_REMOTE_URL`
 * (túnel Cloudflare, acessível fora da rede local/mobile, ver
 * `scripts/studio/verify-remote-tunnel.ts`) quando definida; fallback
 * `http://127.0.0.1:{STUDIO_PORT ?? 4174}` (mesmo default de
 * `scripts/register-report.ts`). */
function resolveReportUrl(entry: ReportEntry): string {
  const base = (process.env.STUDIO_REMOTE_URL || `http://127.0.0.1:${process.env.STUDIO_PORT ?? "4174"}`).replace(
    /\/$/,
    "",
  );
  return `${base}${entry.url}`;
}

/**
 * Monta o e-mail de notificação — título do relatório + link (#4475).
 *
 * **Kinds com resumo curto pronto no próprio título** (overnight/develop —
 * ex: "Diar.ia overnight 260720 — 5 resolvidas, 2 puladas, 1 finding",
 * montado por `.claude/skills/diaria-overnight/SKILL.md` Fase 2 passo 3)
 * já carregam esse resumo em `entry.title`, então título+link no corpo cobre
 * o requisito de incluir o resumo sem duplicar lógica de digest aqui — este
 * módulo não conhece a estrutura de `plan.json`/`report.md` por kind, só o
 * texto que o caller já preparou como título.
 *
 * **`[Diar.ia]` só é prefixado quando o título ainda não começa com "Diar.ia"
 * (achado do self-review, #4478).** Todo `entry.title` de kind hoje em uso
 * (`overnight`/`develop`/`clarice-novos`/`edicao`) já começa com "Diar.ia" —
 * sem esse guard o subject saía `"[Diar.ia] Diar.ia overnight ..."`,
 * duplicando a marca.
 */
export function buildReportEmail(entry: ReportEntry): { subject: string; body: string } {
  const subject = entry.title.startsWith("Diar.ia") ? entry.title : `[Diar.ia] ${entry.title}`;
  const body = `${entry.title}\n\n${resolveReportUrl(entry)}\n`;
  return { subject, body };
}

/**
 * Dispara (best-effort) o e-mail de notificação de um relatório recém-
 * registrado. Nunca lança — toda falha (sem credencial, rede, token
 * expirado/escopo ausente) vira `{sent: false, skipped|error}` e um warning
 * em stderr; o caller (`registerReport`) já persistiu a entry em
 * `index.jsonl` antes de chamar isto, então o registro em si nunca depende
 * do resultado do e-mail.
 *
 * **`deps.hasCredentials` roda DENTRO do `try` (achado do self-review,
 * #4478).** Defesa em profundidade: com o dep default (`defaultHasCredentials`,
 * só um `existsSync`) essa checagem nunca lança na prática, mas `ReportEmailDeps`
 * é um tipo exportado pra injeção — um `hasCredentials` customizado (ex: teste,
 * ou um dep futuro que valide a credencial de verdade em vez de só checar a
 * presença do arquivo) que lance é coberto pelo mesmo `catch` de baixo, sem
 * precisar de um segundo bloco de tratamento.
 */
export async function dispatchReportEmail(
  rootDir: string,
  entry: ReportEntry,
  deps: ReportEmailDeps = defaultEmailDeps,
): Promise<ReportEmailDispatchResult> {
  try {
    if (!deps.hasCredentials(rootDir)) {
      // #4478 achado 4 (silent-failure-hunter, MEDIUM): antes 100% silencioso.
      // Em sessão cloud isto é esperado/documentado — mas se as credenciais
      // sumirem numa sessão LOCAL (arquivo corrompido/movido), toda
      // notificação parava de sair pra sempre sem nenhum rastro. Nível baixo
      // (não é warning de verdade — a função não é hot-path, roda 1x por
      // registro).
      console.warn(
        `[studio-reports] info: e-mail de notificação do relatório ${entry.id} pulado — sem credencial OAuth em ${rootDir} (esperado em sessão cloud; se isto aparecer numa sessão LOCAL, as credenciais podem ter sumido/corrompido — ver npx tsx scripts/oauth-setup.ts).`,
      );
      return { sent: false, skipped: "no-credentials" };
    }
    const to = deps.resolveEditorEmail(resolve(rootDir, "platform.config.json"));
    const { subject, body } = buildReportEmail(entry);
    await deps.sendMail(to, subject, body);
    return { sent: true };
  } catch (e) {
    // #4478 achado 3 (silent-failure-hunter, MEDIUM): padrão já estabelecido
    // em `scripts/lib/exit-handler.ts::runMain` — antes, `(e as Error).message`
    // fazia uma falha de rede esperada e um bug de código novo (throw de um
    // valor não-Error) gerarem o MESMO log "fail-soft, ignore", sem stack
    // trace pra diferenciar os dois casos.
    const message = e instanceof Error ? e.message : String(e);
    console.warn(
      `[studio-reports] aviso: envio de e-mail do relatório ${entry.id} falhou (fail-soft, registro em index.jsonl já concluído): ${message}`,
    );
    if (e instanceof Error && e.stack) {
      console.warn(e.stack);
    }
    return { sent: false, error: message };
  }
}

/**
 * Registra um relatório — append de 1 linha JSON em `data/reports/index.jsonl`.
 * Nunca reescreve/trunca o arquivo (append-only, mesma convenção de
 * `data/run-log.jsonl`): registrar de novo o mesmo id apenas adiciona uma
 * linha nova que supera a anterior na leitura (`listReports` dedupa por id,
 * última linha vence).
 *
 * **Fail-soft por design (#3714):** qualquer falha de escrita (disco cheio,
 * permissão, `rootDir` inválido) nunca lança — retorna `{ok: false, error}`.
 * O caller (send-edition-report.ts, fechos de overnight/develop) não deve
 * travar o pipeline por causa do registro no Studio; é só observabilidade
 * extra, não um passo crítico.
 *
 * **#4475: também dispara e-mail de notificação** (título + link, best-effort,
 * via `dispatchReportEmail`) depois que o append acima já terminou — a
 * promise fica disponível em `result.emailDispatch` pra quem quiser aguardar
 * (testes) mas NUNCA precisa ser aguardada por callers de produção (fail-soft:
 * `dispatchReportEmail` nunca rejeita).
 *
 * **#4478: `notify` suprime o disparo do e-mail sem afetar o registro.** O
 * Stage 6 diário chama `send-edition-report.ts` 2× pro MESMO id
 * (`edicao-{AAMMDD}`) — 6b-6 gera `edition-report.html` só pra satisfazer
 * `blockReasonForMarkingStageDone` (o próprio doc descreve essa geração como
 * "descartável, não é o que vai pro rascunho de e-mail"); 6b-8 regenera e
 * registra de novo o MESMO id como ÚLTIMO passo do pipeline. Sem supressão,
 * `dispatchReportEmail` dispararia 1×em 6b-6 e outra em 6b-8 — 2 e-mails por
 * edição, todo dia. `notify: false` pula o disparo inteiramente (nem chama
 * `dispatchReportEmail`, então `deps.hasCredentials` nunca roda pra essa
 * invocação) e resolve `emailDispatch` direto com
 * `{sent: false, skipped: "notify-disabled"}` — o append em `index.jsonl`
 * acontece igual, só o e-mail é que não sai. Default `true` preserva o
 * comportamento anterior (#4475) pra todo caller que não passar nada —
 * inclusive a chamada final de 6b-8, que deve continuar notificando.
 */
export function registerReport(
  rootDir: string,
  input: ReportRegistryInput,
  emailDeps: ReportEmailDeps = defaultEmailDeps,
  notify = true,
): RegisterReportResult {
  const id = reportId(input.kind, input.sessionId);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const entry: ReportEntry = {
    ...input,
    id,
    createdAt,
    url: `/relatorios/${id}`,
  };
  try {
    mkdirSync(resolve(rootDir, REPORTS_DIR), { recursive: true });
    appendFileSync(registryPath(rootDir), JSON.stringify(entry) + "\n", "utf8");
    return {
      ok: true,
      entry,
      error: null,
      emailDispatch: notify
        ? dispatchReportEmail(rootDir, entry, emailDeps)
        : Promise.resolve<ReportEmailDispatchResult>({ sent: false, skipped: "notify-disabled" }),
    };
  } catch (e) {
    return {
      ok: false,
      entry: null,
      error: (e as Error).message,
      emailDispatch: Promise.resolve<ReportEmailDispatchResult>({ sent: false, skipped: "register-failed" }),
    };
  }
}

/**
 * Lê o registry inteiro, dedupa por id (última linha física vence — um
 * relatório regenerado "sobrescreve" a entry anterior na leitura sem truncar
 * o arquivo) e ordena por `createdAt` desc (mais recente no topo — #3714
 * pede "mais recentes no topo").
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
