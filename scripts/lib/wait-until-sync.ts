/**
 * scripts/lib/wait-until-sync.ts (#5724)
 *
 * Sincroniza o marcador `<!-- aguardando-ate: AAAA-MM-DD -->` no CORPO de
 * uma issue do GitHub — o sinal que `parseWaitUntil`/`classifyExecTrack`
 * (`scripts/lib/issue-exec-track.ts`) leem pra classificar uma issue como
 * `agendada`. Antes deste módulo, `clarice-envio-override.ts --set` gravava
 * o override em `data/clarice-envio-override.json` (que TEM `until` e
 * `issueRef`) mas nunca escrevia o marcador correspondente na issue — quem
 * postava o comentário narrando o override fazia isso à mão, em prosa, sem
 * o marcador machine-readable. Resultado ao vivo: a #5673, com override
 * ativo até `2026-08-21T09:00:00Z`, foi classificada `overnight` (elegível
 * imediata) em três varreduras seguidas do painel de Triagem.
 *
 * ─── Formato da data: ARREDONDA PRA CIMA, nunca pra baixo ──────────────────
 *
 * `until` é ISO com hora (`2026-08-21T09:00:00.000Z`); o marcador só aceita
 * `AAAA-MM-DD` (`WAIT_UNTIL_RE` em `issue-exec-track.ts`), e
 * `parseWaitUntil` interpreta essa data como a meia-noite de Brasília
 * (America/Sao_Paulo, #10947 — era meia-noite UTC até então) do dia
 * informado. Arredondar pro dia CORRENTE do `until` (`2026-08-21` no exemplo
 * acima) faria o marcador expirar à meia-noite BRT do dia 21 (03:00Z), ANTES
 * das 09:00Z reais do override — reabrindo a issue como elegível por ~6h
 * antes do prazo de verdade. `computeWaitUntilMarkerDate` sobe pro dia BRT
 * SEGUINTE sempre que `until` cair depois da meia-noite BRT do seu dia,
 * garantindo que o instante de desarme do marcador nunca fique ANTES do
 * instante real de expiração — o preço é o marcador ficar "agendada" por
 * até ~24h a mais do que o override cobre de fato, que é o lado seguro de
 * errar (a issue reaparece tarde demais, nunca cedo demais).
 *
 * `until` só-data (`AAAA-MM-DD`, a forma de `route-issue.ts --until`) é um
 * dia de calendário BRT e vira o marcador sem conversão nenhuma (#10947).
 *
 * ─── Idempotência ────────────────────────────────────────────────────────
 *
 * `upsertWaitUntilMarker` SUBSTITUI um marcador já existente em vez de
 * duplicar — `--set` chamado 2x (ex: pra estender o prazo) atualiza a data
 * no lugar, nunca empilha um 2º comentário/linha. O marcador é inserido no
 * TOPO do corpo (convenção observada nas issues #5116/#5125/#5639 — é onde
 * `classifyExecTrack`/o editor esperam achá-lo, sempre como a primeira
 * linha, separado do resto do corpo por uma linha em branco).
 *
 * ─── Fail-soft (#738) ────────────────────────────────────────────────────
 *
 * A escrita no GitHub depende de rede/`gh` autenticado. `syncWaitUntilMarkerOnIssue`/
 * `clearWaitUntilMarkerOnIssue` NUNCA lançam — devolvem `{ok: false, error}`
 * pro caller decidir o que fazer. `clarice-envio-override.ts` usa isso pra
 * NUNCA deixar uma falha de sincronização impedir a gravação local do
 * override (que é a função primária do comando) — só emite um warning
 * inequívoco em stderr: "override gravado, marcador NÃO sincronizado".
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnGhSync, type GhSpawnResult } from "./shared/gh-run.ts";
import { WAIT_UNTIL_RE, waitUntilDayStartMs, waitUntilYmdAt } from "./issue-exec-track.ts";

export type GhRunFn = (args: string[], cwd: string) => GhSpawnResult;

export interface WaitUntilSyncResult {
  readonly ok: boolean;
  readonly action: "inserted" | "updated" | "removed" | "noop" | "failed";
  readonly error?: string;
}

/**
 * Data do marcador (`AAAA-MM-DD`) pra um `until` ISO com hora, arredondada
 * pra cima o suficiente pra que a meia-noite BRT do marcador nunca fique
 * ANTES do instante real de `until` — ver docstring do módulo. Lança se `until` não
 * for parseável (mesmo contrato de `setClariceEnvioOverride`, que já valida
 * isso antes de chamar este módulo).
 */
export function computeWaitUntilMarkerDate(untilIso: string): string {
  // Só-data: já é o dia de calendário BRT pedido (#10947). Validado pela
  // mesma função que a leitura usa — data inexistente (`2026-02-30`) lança
  // em vez de virar um marcador que `parseWaitUntil` ignoraria em silêncio.
  if (/^\d{4}-\d{2}-\d{2}$/.test(untilIso)) {
    if (waitUntilDayStartMs(untilIso) === null) {
      throw new Error(`until inválido (data inexistente): ${JSON.stringify(untilIso)}`);
    }
    return untilIso;
  }
  const untilMs = Date.parse(untilIso);
  if (Number.isNaN(untilMs)) {
    throw new Error(`until inválido (não-parseável): ${JSON.stringify(untilIso)}`);
  }
  const sameDay = waitUntilYmdAt(untilMs);
  const sameDayStartMs = waitUntilDayStartMs(sameDay) as number;
  if (untilMs <= sameDayStartMs) return sameDay;
  // Dia BRT seguinte: +36h a partir do início do dia cai com folga no dia
  // seguinte mesmo num dia de 23h/25h (horário de verão), sem aritmética de
  // calendário à mão.
  return waitUntilYmdAt(sameDayStartMs + 36 * 60 * 60 * 1000);
}

/** Insere (se ausente) ou substitui (se já presente) o marcador no TOPO do
 * corpo — função pura, sem I/O. `body` pode vir `null`/`undefined` (issue
 * sem corpo) — tratado como string vazia. */
export function upsertWaitUntilMarker(body: string | null | undefined, ymd: string): string {
  const marker = `<!-- aguardando-ate: ${ymd} -->`;
  const src = body ?? "";
  if (WAIT_UNTIL_RE.test(src)) {
    return src.replace(WAIT_UNTIL_RE, marker);
  }
  const rest = src.replace(/^\s+/, "");
  return rest.length > 0 ? `${marker}\n\n${rest}` : `${marker}\n`;
}

/** Derivado de `WAIT_UNTIL_RE.source` (self-review do #5729: uma regex
 * própria redigitando o padrão do marcador contradiria o próprio propósito
 * do export — "fonte única entre leitura e escrita, nunca duas regexes que
 * podem divergir"). `WAIT_UNTIL_RE` termina em `$` (fim de linha, não
 * consome o `\n`); pra remoção precisamos engolir também a(s) quebra(s) de
 * linha que seguem o marcador — troca o `$` final pelo sufixo que consome
 * até 2 newlines (CRLF-safe), sem tocar o resto do padrão (sintaxe do
 * comentário + formato da data continuam vindo de `WAIT_UNTIL_RE`). */
const WAIT_UNTIL_MARKER_AND_TRAILING_BLANK_RE = new RegExp(
  `${WAIT_UNTIL_RE.source.replace(/\$$/, "")}\\r?\\n?\\r?\\n?`,
  "im",
);

/** Remove o marcador (e a linha em branco que normalmente o segue) do
 * corpo. No-op (devolve o `body` original) se não houver marcador. */
export function removeWaitUntilMarker(body: string | null | undefined): string {
  const src = body ?? "";
  if (!WAIT_UNTIL_RE.test(src)) return src;
  return src.replace(WAIT_UNTIL_MARKER_AND_TRAILING_BLANK_RE, "");
}

/** `gh issue view --json body -q .body` (self-review, achado ao vivo contra a
 * #5724) SEMPRE termina o stdout com exatamente um `\n` extra, mesmo quando o
 * corpo real da issue não termina em newline — é o `-q`/`--jq` do próprio
 * `gh` que anexa isso, não parte do corpo. Sem remover esse `\n` artificial
 * antes de reusar o texto como base de um `gh issue edit --body`, cada ciclo
 * fetch→edit (ex: `--set` estendendo `until` pra uma data nova) escreveria de
 * volta um `\n` a mais, que o PRÓXIMO fetch devolveria como DOIS — linha em
 * branco crescendo a cada extensão do override. Stripar exatamente 1 (nunca
 * mais) recupera o corpo real: se o corpo de verdade também termina em `\n`,
 * o `-q` ainda adiciona só mais 1 por cima, então remover 1 é sempre a
 * operação correta, nunca destrutiva do conteúdo genuíno. */
function stripGhJqTrailingNewline(raw: string): string {
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

function fetchIssueBody(
  issueNumber: number,
  cwd: string,
  ghRun: GhRunFn,
): { ok: true; body: string } | { ok: false; error: string } {
  const res = ghRun(["issue", "view", String(issueNumber), "--json", "body", "-q", ".body"], cwd);
  if (res.status !== 0) {
    return { ok: false, error: res.stderr.trim() || `gh issue view falhou (status ${res.status ?? "null"})` };
  }
  return { ok: true, body: stripGhJqTrailingNewline(res.stdout) };
}

function editIssueBody(
  issueNumber: number,
  body: string,
  cwd: string,
  ghRun: GhRunFn,
): { ok: true } | { ok: false; error: string } {
  const res = ghRun(["issue", "edit", String(issueNumber), "--body", body], cwd);
  if (res.status !== 0) {
    return { ok: false, error: res.stderr.trim() || `gh issue edit falhou (status ${res.status ?? "null"})` };
  }
  return { ok: true };
}

/**
 * Ponto de entrada de `--set`: garante que a issue `issueNumber` tenha o
 * marcador `aguardando-ate:` refletindo `untilIso` (arredondado pra cima —
 * ver `computeWaitUntilMarkerDate`). Idempotente — chamar de novo com o
 * mesmo `until` não gera `gh issue edit` (devolve `action: "noop"`); com
 * `until` diferente, ATUALIZA o marcador existente em vez de duplicar.
 * Nunca lança — falha de rede/`gh` vira `{ok: false, action: "failed"}`.
 */
export function syncWaitUntilMarkerOnIssue(
  issueNumber: number,
  untilIso: string,
  cwd: string,
  ghRun: GhRunFn = spawnGhSync,
): WaitUntilSyncResult {
  let ymd: string;
  try {
    ymd = computeWaitUntilMarkerDate(untilIso);
  } catch (e) {
    return { ok: false, action: "failed", error: (e as Error).message };
  }

  const fetched = fetchIssueBody(issueNumber, cwd, ghRun);
  if (!fetched.ok) return { ok: false, action: "failed", error: fetched.error };

  const hadMarker = WAIT_UNTIL_RE.test(fetched.body);
  const nextBody = upsertWaitUntilMarker(fetched.body, ymd);
  if (nextBody === fetched.body) return { ok: true, action: "noop" };

  const edited = editIssueBody(issueNumber, nextBody, cwd, ghRun);
  if (!edited.ok) return { ok: false, action: "failed", error: edited.error };
  return { ok: true, action: hadMarker ? "updated" : "inserted" };
}

/**
 * Ponto de entrada de `--clear`: remove o marcador `aguardando-ate:` da
 * issue `issueNumber`, se presente. Nunca lança — mesmo contrato de
 * `syncWaitUntilMarkerOnIssue`.
 */
export function clearWaitUntilMarkerOnIssue(
  issueNumber: number,
  cwd: string,
  ghRun: GhRunFn = spawnGhSync,
): WaitUntilSyncResult {
  const fetched = fetchIssueBody(issueNumber, cwd, ghRun);
  if (!fetched.ok) return { ok: false, action: "failed", error: fetched.error };
  if (!WAIT_UNTIL_RE.test(fetched.body)) return { ok: true, action: "noop" };

  const nextBody = removeWaitUntilMarker(fetched.body);
  const edited = editIssueBody(issueNumber, nextBody, cwd, ghRun);
  if (!edited.ok) return { ok: false, action: "failed", error: edited.error };
  return { ok: true, action: "removed" };
}

export interface ReadIssueRefForClearOptions {
  /** Chamado quando o arquivo EXISTE mas não deu pra determinar o
   * `issueRef` (JSON quebrado, shape errado, `issueRef` ausente/não-numérico)
   * — NUNCA chamado por ausência de arquivo (mesma convenção de
   * `ReadClariceEnvioOverrideOptions.onInvalid`: ausência é o caso normal,
   * silencioso; presente-mas-ilegível é sinal de PROBLEMA). Default
   * `console.warn`. */
  onInvalid?: (message: string) => void;
}

/** Lê só o `issueRef` cru do arquivo de override, sem passar pela validação
 * de `readClariceEnvioOverrideState` (que devolve `null` pra override
 * EXPIRADO — mas `--clear` precisa saber qual issue tinha o marcador
 * mesmo que o `until` já tenha passado, ex: revogação manual antes do
 * prazo natural).
 *
 * **Self-review do #5729 — 3 desfechos, não 2:** a versão original desta
 * função colapsava "arquivo ausente" (caso normal — nunca houve override, ou
 * já foi limpo antes) e "arquivo presente mas ilegível" (JSON corrompido,
 * shape errado, `issueRef` malformado) no MESMO `undefined` silencioso. O
 * cenário real que isso escondia: JSON local corrompido enquanto existe um
 * marcador válido numa issue de um `--set` anterior bem-sucedido — o
 * `--clear` apagava o override e imprimia só `"cleared"`, sem tocar o
 * marcador nem avisar que não conseguiu determinar QUAL issue precisava de
 * limpeza. A issue ficava presa em `agendada` até o prazo expirar sozinho,
 * sem sinal nenhum de que algo tinha saído errado.
 *
 * Agora: ausência de arquivo → `undefined`, SEM chamar `opts.onInvalid`
 * (comportamento normal). Presente mas ilegível/malformado → `undefined`,
 * COM `opts.onInvalid` chamado — o caller (`runCli` em
 * `clarice-envio-override.ts`) usa isso pra imprimir um aviso inequívoco em
 * vez de deixar `"cleared"` sozinho insinuar que nada ficou pra trás. */
export function readIssueRefForClear(rootDir: string, opts: ReadIssueRefForClearOptions = {}): number | undefined {
  const warn = opts.onInvalid ?? ((m: string) => console.warn(m));
  const p = resolve(rootDir, "data", "clarice-envio-override.json");
  if (!existsSync(p)) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    warn(
      `[wait-until-sync] ${p} existe mas não deu pra ler/parsear (${(e as Error).message}) — ` +
        `não dá pra determinar qual issue tinha o marcador.`,
    );
    return undefined;
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warn(`[wait-until-sync] ${p} existe mas não é um objeto JSON — não dá pra determinar qual issue tinha o marcador.`);
    return undefined;
  }

  const issueRef = (raw as Record<string, unknown>).issueRef;
  if (typeof issueRef !== "number" || !Number.isInteger(issueRef)) {
    warn(
      `[wait-until-sync] ${p} sem "issueRef" numérico válido (${JSON.stringify(issueRef)}) — ` +
        `não dá pra determinar qual issue tinha o marcador.`,
    );
    return undefined;
  }

  return issueRef;
}
