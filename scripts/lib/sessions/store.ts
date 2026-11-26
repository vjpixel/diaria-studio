/**
 * scripts/lib/sessions/store.ts (#14004)
 *
 * Camada de disco do registro: caminhos de `data/sessions/`, leitura e escrita
 * JSON (atômica, com lock e CAS), cópias de conflito do sync (`-safeBackup-`)
 * e a união dos registros (`mergeSessionRecords`).
 *
 * Parte de `scripts/lib/session-registry.ts`, dividido em módulos no #14004 sem
 * mudar comportamento. Fora de `scripts/lib/sessions/`, importe sempre de
 * `session-registry.ts`, que reexporta a API pública inteira e segue sendo a
 * entrada do CLI. O docstring de topo de `session-registry.ts` continua sendo o
 * mapa do registro.
 */

import { basename, dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { writeFileAtomic } from "../atomic-write.ts";
import { tryStealOrphan, withFileLock } from "../file-lock.ts";
import { conflictCopyBelongsToStem, isSyncConflictCopyName, rcloneConflictOriginalName } from "../sync-conflict-copy.ts";
// #12547: mesma sonda que o guard de merge usa pra separar "data/sessions
// nunca existiu" de "data/ é junction cujo alvo sumiu".
import { probeSessionsDir, type SessionsDirProbe } from "../sessions-dir-probe.mjs";
import { DEFAULT_ISSUE_REPO, mergeLockFileName } from "../issue-repos.ts";
import {
  ALL_SESSION_KINDS,
  type MergeGrant,
  type SessionKind,
  type SessionRecord,
  softStaleMsForKind,
} from "./types.ts";

/**
 * Tolerância de clock skew entre máquinas (#5161 fleet review item 2).
 * `listActiveSessions` e `acquireMergeLock` comparam timestamps ESCRITOS por
 * uma máquina contra o relógio de QUEM LÊ — se os relógios não estão
 * perfeitamente sincronizados (NTP), um timestamp genuinamente recente pode
 * parecer "no futuro" pra quem lê. Um delta pequeno (≤60s) é tratado como
 * jitter normal, nunca como sinal de corrupção/abandono. Um delta MAIOR que
 * isso ainda é tratado com segurança (nunca finge que um registro que parece
 * "do futuro" está abandonado/roubável), mas gera um warning em stderr — ver
 * `warnClockSkew` — porque não é mais jitter, pode ser skew real entre
 * máquinas que vale a pena investigar.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

/**
 * Loga (stderr, nunca lança) um aviso de possível clock skew — usado sempre
 * que um timestamp "no futuro" (relativo ao relógio de quem lê) influencia
 * uma decisão de staleness/freshness em `listActiveSessions`/
 * `acquireMergeLock`. Nunca silencioso: um relógio adiantado numa máquina
 * pode fazer sessões/locks genuinamente ativos desaparecerem/serem roubados
 * sem aviso nenhum se isto não for logado (#5161 item 2).
 */
export function warnClockSkew(context: string, identifier: string, deltaMs: number): void {
  try {
    process.stderr.write(
      `session-registry: aviso de possível clock skew em ${context} — "${identifier}" tem timestamp ` +
        `~${Math.round(-deltaMs / 1000)}s no "futuro" relativo ao relógio de quem lê (delta=${deltaMs}ms). ` +
        "Se as máquinas envolvidas não estão sincronizadas via NTP, isto pode estar mascarando/excluindo " +
        "uma sessão ou lock genuinamente ativo. Ver CLOCK_SKEW_TOLERANCE_MS em scripts/lib/session-registry.ts.\n",
    );
  } catch {
    // Nunca deixar um log de warning derrubar o caminho fail-soft principal.
  }
}

/** Sanitiza o hostname pra um nome de arquivo seguro. Nunca lança — "unknown" em falha. */
export function machineTag(): string {
  try {
    return (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    return "unknown";
  }
}

export function sessionsDir(repoRoot: string): string {
  return join(repoRoot, "data", "sessions");
}

export function sessionFilePath(repoRoot: string, kind: SessionKind, tag: string, sessionId: string): string {
  return join(sessionsDir(repoRoot), `${kind}-${tag}-${sessionId}.json`);
}

/**
 * Caminho do merge lock. **Por repo desde o #10618** (decisão do editor: a
 * linearidade do squash só importa dentro de um mesmo repo — um merge no
 * `vjpixel/diaria-design` nunca precisa esperar um do `diaria-studio`). O repo
 * default segue em `.merge-lock.json` (sessões e hooks já rodando continuam
 * lendo o mesmo arquivo); os outros, em `.merge-lock--{owner}--{repo}.json`
 * (`mergeLockFileName` em `scripts/lib/issue-repos.ts`).
 */
export function mergeLockPath(repoRoot: string, repo: string = DEFAULT_ISSUE_REPO): string {
  return join(sessionsDir(repoRoot), mergeLockFileName(repo));
}

/**
 * Loga (stderr, nunca lança) uma falha de I/O real lendo `path` — distinta de
 * "arquivo ausente" (ENOENT, silencioso — caso comum e esperado) ou "JSON
 * malformado" (também silencioso — arquivo de outra sessão só parcialmente
 * escrito, não é um sinal de bug). `data/` é uma junction OneDrive: erros
 * como EBUSY/EPERM/EACCES são REALISTAMENTE transitórios (sync em andamento),
 * não "o arquivo nunca existiu" — tratar os dois casos como indistinguíveis
 * (#5161 fleet review item 3) enfraquece tanto `listActiveSessions` quanto
 * `acquireMergeLock`: um lock/sessão de OUTRA sessão que falhou por I/O
 * transitório vira "ausente" e é ignorado/roubado sem aviso nenhum.
 */
export function warnIoError(path: string, error: unknown): void {
  try {
    const code = (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.message ?? String(error);
    process.stderr.write(
      `session-registry: falha de I/O lendo "${path}" (${code}) — tratando como ausente por segurança (fail-soft), ` +
        "mas isto pode ser TRANSITÓRIO (ex: sync do Drive gravando o arquivo agora), não uma ausência real. " +
        "Se isto se repetir para o mesmo path, investigar antes de confiar na leitura.\n",
    );
  } catch {
    // Nunca deixar um log de warning quebrar o caminho fail-soft.
  }
}

/** Paths de `data/` indisponível já avisados neste processo (#12547): uma
 * linha por causa, não uma por leitura — `listSessionJsonFiles` roda dezenas
 * de vezes num único comando. */
const warnedUnavailableSessionsDirs = new Set<string>();

/**
 * #12547: chamado quando `data/sessions` não existe. Separa "nunca existiu"
 * (clone fresco, sessão cloud: silencioso) de "`data/` é link/junction cujo
 * alvo sumiu" (Drive for desktop fechado no Neo): no segundo caso escreve em
 * stderr a mensagem que nomeia causa e ação. Devolve a sonda para quem
 * precisa decidir (`checkSessionsScanHealth`). Nunca lança.
 */
export function probeSessionsDirWithWarning(repoRoot: string): SessionsDirProbe {
  const probe = probeSessionsDir(repoRoot);
  if (probe.degraded && !warnedUnavailableSessionsDirs.has(probe.path)) {
    warnedUnavailableSessionsDirs.add(probe.path);
    try {
      process.stderr.write(`session-registry: ATENÇÃO — ${probe.message} Tratando como nenhuma sessão registrada (fail-soft).\n`);
    } catch {
      // log nunca derruba o caminho fail-soft
    }
  }
  return probe;
}

export function readJsonSafe<T>(path: string): T | null {
  let raw: string;
  try {
    if (!existsSync(path)) return null;
    raw = readFileSync(path, "utf8");
  } catch (e) {
    // ENOENT aqui (arquivo removido entre o existsSync e o readFileSync,
    // corrida benigna) é equivalente a "ausente" — silencioso, igual antes.
    // Qualquer OUTRO código (EBUSY/EPERM/EACCES/etc) é uma falha de I/O real
    // que merece ficar visível, não se disfarçar de "nunca existiu".
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") warnIoError(path, e);
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    // JSON malformado — comportamento pré-existente preservado (silencioso):
    // não é uma falha de I/O, é conteúdo genuinamente inválido.
    return null;
  }
}

/**
 * #6130 item 4 (reduzir a janela de conflito de escrita): write-then-rename
 * atômico (`writeFileAtomic`, já usado por outros outputs do pipeline) em
 * vez de `writeFileSync` in-place — elimina a classe "leitura vê arquivo
 * PARCIALMENTE escrito" (kill/crash/sync do OneDrive no meio de um write).
 * **Não elimina** a classe "lost update" de duas sessões fazendo
 * leitura→merge→escrita concorrente sobre o MESMO registro (ex: duas
 * chamadas de `claimIssue` pra sessões DIFERENTES nunca colidem — cada uma
 * escreve seu PRÓPRIO arquivo — mas duas chamadas concorrentes pra a MESMA
 * sessão, do tipo que só aconteceria por bug de dispatch, ainda podem
 * perder uma escrita) — isso exigiria locking/CAS por registro, avaliado
 * como refactor grande demais pra esta unidade (ver corpo da issue #6130,
 * item sem checkbox). `mkdirSync` continua incondicional antes do write —
 * `writeFileAtomic` não cria o diretório pai.
 */
export function writeJsonSafe(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(value), { fsync: false });
}

/**
 * #6952 — read-modify-write do record de sessão sob lock exclusivo, em vez de
 * solto.
 *
 * `writeJsonSafe` torna a ESCRITA atômica (write-then-rename, #6130), mas a
 * leitura que a precede é separada — entre `readJsonSafe` e o
 * `writeFileAtomic` outro processo pode gravar o seu próprio registro, e a
 * nossa escrita (com `...current`) apaga esse update. É o lost-update
 * clássico:
 *
 *   t0  nós lemos current            (sem merge_grant)
 *   t1  outro processo lê current, grava current + merge_grant
 *   t2  nós gravamos NOSSO current  (de t0, sem merge_grant)   <- grant perdido
 *
 * O #6952 mediu isso ao vivo: o `grant-merge` concedeu a janela, a
 * beneficiária confirmou `granted: true`, e antes do `gh pr merge` o beacon
 * do concedente (que estava ativo trabalhando) reescreveu o registro a partir
 * de um `current` sem o grant — e o grant sumiu.
 *
 * Esta função fecha a classe inteira (não só o `merge_grant`):
 * `claimed_issues` (claimIssue/unclaimIssue) e os campos do beacon
 * (`touched_paths`/`dirty_paths`/`lastHeartbeat`) correm o mesmo risco hoje,
 * porque todos os escritores do record fazem read-modify-write com spread.
 *
 * Mecanismo: `withFileLock` em `{path}.lock` (criação exclusiva `wx`, spin
 * com timeout — mesmo mecanismo de `scripts/lib/file-lock.ts`, #4125, usado
 * já por `publish-facebook.ts`/`publish-linkedin.ts`). O lock serializa a
 * seção read-modify-write inteira: enquanto um processo tem o lock, nenhum
 * outro pode estar no meio da mesma seção, então o `merge(current)` lê um
 * `current` que NINGUÉM mais vai alterar antes da nossa escrita. A escrita
 * atômica (`writeJsonSafe`) então publica o resultado completo.
 *
 * `merge` é uma FUNÇÃO (não um objeto fixo) pra que o patch seja REFEITO a
 * cada retry contra o `current` fresco — um `patch` congelado na primeira
 * leitura repetiria exatamente o bug (preservaria o `current` STALE).
 *
 * `verify` roda DEPOIS da escrita, sob o mesmo lock: confirma que o que está
 * no disco agora é de fato a NOSSA escrita. É defesa em profundidade contra o
 * caso que o `wx` não cobre — entre máquinas via OneDrive o lock é
 * **advisory** (#6182, mesma limitação do merge lock): cada máquina vê um
 * inode distinto no junction e pode criar o `.lock` simultaneamente. No
 * caminho feliz (mesma máquina, lock real) o `verify` é só uma leitura a mais
 * e sempre passa.
 *
 * **O alcance do `verify` entre MÁQUINAS é limitado, e a limitação precisa
 * ficar escrita (achado do review da PR #6969).** Ele é uma leitura-após-
 * escrita feita na MESMA máquina que acabou de escrever: observa o próprio
 * write, não o da outra máquina — o sync do OneDrive não é instantâneo, então
 * no instante do `verify` a escrita remota simplesmente ainda não chegou.
 *
 * A autocura ("os dois lados detectam e refazem") vale quando o sync produz
 * **cópia de conflito** (`-safeBackup-*`), que é o comportamento observado na
 * prática — havia 15 delas em `data/sessions/` no dia em que isto foi
 * escrito, e é por isso que a união do `mergeSessionRecords` (#6952, 2ª
 * metade) é o que de fato recupera o dado nesse cenário: o `verify` não
 * recupera, a UNIÃO recupera.
 *
 * Se em vez disso houver last-writer-wins silencioso (sem cópia de
 * conflito), nem o `verify` nem a união ajudam: a escrita local seguinte da
 * concedente pode sobrescrever um `consumedAt` gravado do outro lado,
 * ressuscitando concessão já usada. Esse caminho NÃO foi reproduzido —
 * exigiria duas máquinas sincronizando ao vivo — e está registrado aqui como
 * limitação conhecida, não como cenário descartado.
 *
 * **Fail-closed quando não converge:** se `attempts` se esgotar, a função
 * LANÇA (re-propaga a última falha) em vez de silenciosamente gravar o
 * registro antigo. Um lost update que não foi resolvido é pior que um erro
 * visível — sem isto o grant desaparece e o diagnosticador acha que o
 * coordenador nunca concedeu (exatamente o diagnóstico errado do #6952).
 * O outro escritor é o beacon (`.claude/hooks/session-beacon.mjs`), que roda
 * a cada chamada de ferramenta mas só ESCREVE quando há novidade ou quando
 * passaram `MIN_WRITE_INTERVAL_MS` (5s) desde o último heartbeat — e desde o
 * #6952 ele adquire ESTA MESMA lock file, então os dois lados se serializam
 * de verdade em vez de cada um trancar consigo mesmo. Como cada tentativa
 * espera o lock por até 10s (`withFileLock`), o teto de `attempts` não é uma
 * janela de tempo fixa: é quantas vezes aceitamos perder a corrida do
 * `verify` antes de desistir, e só o caminho advisory cross-máquina (#6182)
 * faz o `verify` falhar.
 *
 * `attempts` é o teto de retries (default 50). Cada retry é uma leitura +
 * uma escrita atômica + uma verificação — 3 syscalls a mais, barato.
 */
/**
 * #6952 (achado do review): idade a partir da qual um `.lock` de registro de
 * sessão é considerado ÓRFÃO e quebrado à força.
 *
 * O `wx` não tem dono nem TTL: se o processo que segurava o lock morre sem
 * rodar o `finally` (SIGKILL, OOM, a máquina suspendendo, o binário do Claude
 * Code quebrando no meio — que aconteceu 5× num único dia), o arquivo fica no
 * disco PARA SEMPRE. Sem quebra por idade, todo escritor seguinte — os três
 * programas — passa a gastar o timeout inteiro e falhar, indefinidamente: um
 * grant perdido de vez em quando viraria uma parada total do registro.
 *
 * 60s é folgado por construção: a seção crítica é um read-modify-write de um
 * JSON pequeno (millissegundos), e o teto de espera de UMA tentativa é 10s.
 * Um lock com mais de 60s não está sendo usado por ninguém vivo.
 */
export const STALE_LOCK_MS = 60_000;

/**
 * #9220: teto de idade pra quebrar `.lock` de registro cujo dono é de OUTRO
 * host. `data/sessions/` sincroniza pelo OneDrive, então um lock deixado por
 * uma máquina que caiu segurando-o chega aqui com `host` alheio — e o PID não
 * é verificável daqui. Sem teto, ele travava o registro para sempre (regressão
 * do #9193). 30 min fica ordens de grandeza acima do pior caso da seção
 * crítica do registry (read-modify-write de um JSON pequeno, ms; uma tentativa
 * espera no máximo 10s) E acima da latência de sync do OneDrive entre
 * máquinas (minutos) — um lock alheio com 30 min não pertence a ninguém vivo.
 * Vale só no `breakStaleLock`; o `withFileLock` genérico segue sem quebrar
 * lock de outro host (há call sites que fazem rede na seção crítica).
 */
export const FOREIGN_HOST_STALE_LOCK_MS = 30 * 60_000;

/**
 * Remove um `.lock` órfão. Devolve `true` se removeu. Desde #9193 delega à
 * política de `file-lock.ts` (#9185): lock com dono `{pid, host, ts, token}`
 * deste host só é quebrado se o PID morreu — nunca por idade (seção crítica
 * lenta não é órfão). Dono de OUTRO host (PID inverificável) é quebrado só
 * após `FOREIGN_HOST_STALE_LOCK_MS` (#9220). Só conteúdo
 * legado/vazio cai no critério de idade (`STALE_LOCK_MS`). A remoção relê o
 * arquivo (inode + conteúdo) sob `.steal` antes do `unlink`, então não apaga
 * um lock novo criado entre o julgamento e a remoção. Fail-soft em tudo: lock inexistente, `stat` falhando, corrida com
 * outro quebrador — nada disso lança, porque quebrar lock é melhor-esforço e
 * nunca deve ser o motivo de uma falha.
 */
export function breakStaleLock(lockPath: string, now: number = Date.now()): boolean {
  try {
    return tryStealOrphan(lockPath, STALE_LOCK_MS, now, FOREIGN_HOST_STALE_LOCK_MS);
  } catch {
    return false;
  }
}

export function writeJsonSafeWithCas(
  path: string,
  merge: (current: SessionRecord | null) => SessionRecord,
  verify: (onDisk: SessionRecord | null) => boolean,
  attempts: number = 50,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      // Antes de esperar mais 10s por um lock, checa se ele é de um processo
      // que morreu segurando-o. Sem isto, um lock órfão wedgeia o registro
      // para sempre (ver `STALE_LOCK_MS`).
      breakStaleLock(lockPath);
      withFileLock(lockPath, () => {
        const current = readJsonSafe<SessionRecord>(path);
        const value = merge(current);
        writeJsonSafe(path, value);
        const onDisk = readJsonSafe<SessionRecord>(path);
        if (!verify(onDisk)) {
          // Outra sessão escreveu entre a nossa leitura e a nossa escrita, e
          // a nossa escrita atômica a sobrescreveu — lost update (só pode
          // acontecer no caminho advisory cross-máquina). Relê e retry.
          throw new Error("CAS verify failed: another writer overwrote our write");
        }
      });
      return;
    } catch (e) {
      // `withFileLock` lançou: ou verify falhou (lost update, retry), ou o
      // lock timeout estourou (outro processo segura há 10s+ — raro, mas o
      // beacon roda a cada ~1s então é só esperar), ou falha de I/O no
      // read/write interno. Todas as três são retry-áveis.
      lastErr = e;
    }
  }
  throw new Error(
    `writeJsonSafeWithCas: ${attempts} tentativas de CAS falharam em ${path} ` +
      `— outro processo (beacon) continua escrevendo o registro; última falha: ${(lastErr as Error)?.message ?? String(lastErr)}`,
  );
}

/**
 * Localiza, em `data/sessions/`, o arquivo de registro REAL (nunca backup)
 * de QUALQUER kind para `sessionId` — espelha `findExistingSessionFile` do
 * beacon (`.claude/hooks/session-beacon.mjs`), que cobre a ordem "register
 * primeiro, beacon depois" (enriquece o arquivo já existente em vez de criar
 * um `interactive-*` paralelo).
 *
 * `registerSession` usa isto pra cobrir a ordem INVERSA (#6326): o beacon
 * dispara no `PreToolUse`, ANTES de a skill rodar `register` — cria
 * `interactive-{tag}-{sessionId}.json` sem saber que a sessão vai virar
 * coordenadora minutos depois. Sem esta busca, `registerSession` escreveria
 * cego no path do kind novo (`sessionFilePath`), sem olhar se já existe um
 * arquivo de OUTRO kind pro mesmo `sessionId` — e sobrariam dois registros
 * pra uma sessão só, contando dobrado em `list-active` (achado ao vivo do
 * #6326: `overnight-300-{uuid}.json` + `interactive-300-{uuid}.json`
 * simultâneos, o 2º congelado a partir do momento em que o beacon passa a
 * enriquecer só o 1º).
 *
 * Match por SUFIXO `-{sessionId}.json`, nunca por tag/kind explícitos —
 * mesmo critério do irmão (cobre o caso raro de a sessão trocar de
 * `machineTag()` entre o beacon e o `register`, ex: hostname mudou no meio).
 * Ordena alfabeticamente e devolve o primeiro quando há mais de um
 * candidato (não deveria acontecer em operação normal — é exatamente o bug
 * que esta função corrige — mas nunca lança). **#6326 fleet review P3
 * (decisão registrada, não corrigida neste PR):** casa só por SUFIXO de
 * nome de arquivo, sem validar que o prefixo antes do sufixo é de fato um
 * `SessionKind` conhecido (`parseSessionFileName(): {kind,tag,sessionId} |
 * null` fecharia isso). Risco prático baixo — o `kind` usado no restante da
 * função sempre vem do parâmetro TIPADO, nunca é lido de volta do nome do
 * arquivo — e esta é a mesma ausência de validação de shape que já existia
 * em `listSessionJsonFiles`/`readMergedSessionGroups` antes deste PR, não
 * uma regressão introduzida aqui. **Fechado em #6338** — ver
 * `parseSessionFileName` abaixo, agora usada como filtro aqui.
 */
export function findExistingSessionFileAnyKind(repoRoot: string, sessionId: string): string | null {
  const suffix = `-${sessionId}.json`;
  const names = listSessionJsonFiles(repoRoot)
    .filter((n) => n.endsWith(suffix) && !isSyncConflictCopyName(n) && parseSessionFileName(n) !== null)
    .sort();
  return names.length > 0 ? join(sessionsDir(repoRoot), names[0]!) : null;
}

/**
 * Parseia um nome de arquivo de registro de sessão (`{kind}-{tag}-{sessionId}.json`)
 * validando que o PREFIXO é um `SessionKind` conhecido (#6338) — fecha a
 * lacuna documentada em `findExistingSessionFileAnyKind` acima, onde o
 * casamento por sufixo `-{sessionId}.json` nunca checava o que vinha antes.
 *
 * **Ambiguidade estrutural, documentada, não escondida:** tanto `tag`
 * (`machineTag()` — alfanumérico/`_`/`-`, hostname pode ter hífen) quanto
 * `sessionId` (tipicamente um UUID, também com hífens) podem conter `-`, então
 * o corte entre os dois a partir só da string é inerentemente ambíguo — não
 * há como este parser "adivinhar" onde a tag termina e o sessionId começa
 * quando ambos usam o mesmo separador do nome de arquivo. Por isso o campo
 * `tag`/`sessionId` retornados usam o corte ingênuo "primeiro `-` depois do
 * kind" e só devem ser tratados como confiáveis quando o chamador não precisa
 * distinguir os dois com certeza (o caso concreto que motivou a issue — só
 * validar que o `kind` é conhecido). Quem precisa casar um `sessionId`
 * ESPECÍFICO (como `findExistingSessionFileAnyKind`) deve continuar casando
 * pelo sufixo `-{sessionId}.json` conhecido, e usar este parser só pra validar
 * o prefixo — nunca para redescobrir o sessionId a partir do nome.
 *
 * `null` quando: não termina em `.json`, ou o prefixo não bate com nenhum dos
 * `ALL_SESSION_KINDS`, ou não sobra `tag-sessionId` suficiente depois do kind.
 *
 * **#6934 — casamento por prefixo MAIS LONGO, não pela ordem de declaração
 * de `ALL_SESSION_KINDS`.** Desde que `continuo-review` existe, `continuo` é
 * um prefixo verdadeiro dele (`"continuo-review-tag-id".startsWith("continuo-")`
 * também é `true`) — um `.find()` ingênuo na ordem do array casaria sempre
 * `continuo` primeiro e devolveria `tag: "review", sessionId: "tag-id"`,
 * errado em silêncio. Mesma técnica de desempate já usada por
 * `groupBackupsByRealStem` acima (mais longo = mais específico = vence):
 * ordena os candidatos por comprimento decrescente antes do `.find()`, então
 * o resultado nunca depende de qual kind foi declarado antes do outro.
 */
export function parseSessionFileName(
  name: string,
): { kind: SessionKind; tag: string; sessionId: string } | null {
  if (!name.endsWith(".json")) return null;
  const stem = name.slice(0, -".json".length);
  const kindsByLengthDesc = [...ALL_SESSION_KINDS].sort((a, b) => b.length - a.length);
  const kind = kindsByLengthDesc.find((k) => stem.startsWith(`${k}-`));
  if (!kind) return null;
  const rest = stem.slice(kind.length + 1);
  const sepIndex = rest.indexOf("-");
  if (sepIndex <= 0 || sepIndex >= rest.length - 1) return null; // sem tag/sessionId não-vazios dos dois lados
  return { kind, tag: rest.slice(0, sepIndex), sessionId: rest.slice(sepIndex + 1) };
}

/**
 * Agrupa cópias de conflito `-safeBackup-` de `names` (listagem CRUA de
 * `data/sessions/`, real+backup) por STEM do arquivo real "dono" mais
 * ESPECÍFICO — extraído de `readMergedSessionGroups` (#6130) e reusado por
 * `readMergedRecordForRealFile` (#6326 fleet review item 5a — a versão
 * anterior desta 2ª função tinha sua PRÓPRIA regra, mais fraca, que só
 * olhava pro stem-alvo isoladamente, sem competir contra outros stems reais
 * do diretório).
 *
 * Desempate: quando mais de um stem real é prefixo válido do mesmo nome de
 * backup (ex: stems `interactive-tag-X` e `interactive-tag-X-2` concorrendo
 * pelo backup `interactive-tag-X-2-tag-safeBackup-0001.json`), o STEM MAIS
 * LONGO (mais específico) vence — nunca o mais curto, que atribuiria o
 * backup à sessão ERRADA. Backup sem nenhum stem real correspondente
 * (órfão) não aparece no mapa devolvido.
 */
export function groupBackupsByRealStem(names: readonly string[]): Map<string, string[]> {
  const realStems = names
    .filter((n) => !isSyncConflictCopyName(n))
    .map((n) => n.slice(0, -".json".length))
    .sort((a, b) => b.length - a.length);
  const backupsByRealStem = new Map<string, string[]>();
  for (const backup of names) {
    if (!isSyncConflictCopyName(backup)) continue;
    const matchStem = realStems.find((stem) => conflictCopyBelongsToStem(backup, stem, ".json"));
    if (!matchStem) continue; // órfão
    const list = backupsByRealStem.get(matchStem) ?? [];
    list.push(backup);
    backupsByRealStem.set(matchStem, list);
  }
  return backupsByRealStem;
}

/**
 * Lê o registro efetivo de um arquivo REAL de sessão já conhecido, mesclado
 * com seus próprios `-safeBackup-` do OneDrive (`mergeSessionRecords`) — usado
 * pela promoção de kind em `registerSession` (#6326) pra garantir que um
 * claim que só sobreviveu num backup do registro ANTIGO não se perca na
 * promoção. Reusa `groupBackupsByRealStem` (mesma disciplina fail-safe de
 * `readMergedSessionGroups`, com o mesmo desempate "stem mais específico
 * vence" — não uma versão mais fraca). `null` quando nem o arquivo real nem
 * nenhum backup dele foi legível.
 */
export function readMergedRecordForRealFile(repoRoot: string, realPath: string): SessionRecord | null {
  const dir = sessionsDir(repoRoot);
  const realName = basename(realPath);
  const stem = realName.slice(0, -".json".length);
  const backupNames = groupBackupsByRealStem(listSessionJsonFiles(repoRoot)).get(stem) ?? [];
  // Fleet review (#7467, achado CRÍTICO): a leitura do REAL é checada
  // EXPLICITAMENTE, separada do `.filter()` que descarta backups
  // ilegíveis — nunca misturadas no mesmo filtro. Se o real falhar (race
  // ENOENT do #7002, ou JSON malformado — `readJsonSafe` devolve `null`
  // silenciosamente pros dois), o `.filter()` sozinho reindexaria o
  // primeiro BACKUP sobrevivente pra posição 0, e `mergeSessionRecords`
  // com `realIndex` default (0) o trataria como testemunha autoritativa de
  // `consumedAt` — exatamente a classe de bug que o #7462 existe pra
  // fechar, reintroduzida aqui por um invariante implícito nunca validado.
  const realRecord = readJsonSafe<SessionRecord>(join(dir, realName));
  const backupRecords = backupNames
    .map((n) => readJsonSafe<SessionRecord>(join(dir, n)))
    .filter((r): r is SessionRecord => r !== null);
  if (realRecord === null && backupRecords.length === 0) return null;
  if (realRecord === null) {
    process.stderr.write(
      `session-registry: ATENÇÃO — readMergedRecordForRealFile: o arquivo real "${realName}" está ilegível/ausente ` +
        `mas ${backupRecords.length} cópia(s) -safeBackup- sobrevivem — tratando como grupo ÓRFÃO (realIndex=-1, #6972): ` +
        "consumedAt de nenhuma delas é confiado como testemunha.\n",
    );
    return mergeSessionRecords(backupRecords, -1);
  }
  return mergeSessionRecords([realRecord, ...backupRecords]);
}

/**
 * Registro efetivo de UM arquivo real de sessão — o real unido aos seus
 * `-safeBackup-` (`claimed_issues` em união, heartbeat mais recente), mesma
 * semântica fail-safe do read-path (#6623/#6130). Exportado para consumidores
 * fora deste módulo que decidem algo por arquivo (ex:
 * `scripts/sweep-continuo-orphan-sessions.ts`, #10015) e não podem ver só o
 * real: uma claim que sobreviveu apenas num backup continua sendo claim.
 * `null` quando nem o real nem nenhum backup do grupo é legível.
 */
export function readEffectiveSessionRecord(repoRoot: string, realPath: string): SessionRecord | null {
  return readMergedRecordForRealFile(repoRoot, realPath);
}

/**
 * Paths absolutos dos `-safeBackup-*` do MESMO grupo de um arquivo real de
 * sessão — mesma composição de `groupBackupsByRealStem` que
 * `readMergedRecordForRealFile` usa para o READ-path. Usada por
 * `unclaimIssue` (#6567) para propagar a remoção de uma issue a TODAS as
 * cópias do grupo, não só ao arquivo real: sem isto, `writeJsonSafe` no real
 * deixa `-safeBackup-*` órfãos ainda carregando a issue em `claimed_issues`,
 * e como o read-path (`readMergedSessionGroups`/`mergeSessionRecords`) faz
 * união real+backups por design fail-safe, a issue continua aparecendo como
 * reivindicada para `is-claimed`/`list-active` mesmo depois do
 * `unclaim-issue` reportar sucesso. Lista vazia quando não há backup do
 * grupo (caso comum) — nenhuma mudança de comportamento no caminho feliz.
 */
export function sessionGroupBackupPaths(repoRoot: string, realPath: string): string[] {
  const dir = sessionsDir(repoRoot);
  const realName = basename(realPath);
  const stem = realName.slice(0, -".json".length);
  const backupNames = groupBackupsByRealStem(listSessionJsonFiles(repoRoot)).get(stem) ?? [];
  return backupNames.map((n) => join(dir, n));
}

/**
 * Um grupo de cópias de conflito do OneDrive (`-safeBackup-*`) que NÃO tem
 * arquivo real correspondente em `data/sessions/` (#7002/#7003).
 *
 * A identidade vem do CONTEÚDO (`kind`/`machineTag`/`sessionId`), nunca do
 * nome do arquivo: o nome do backup é `{stem-real}-{tag}-safeBackup-NNNN.json`
 * e o `-{tag}` que o cliente OneDrive intercala não é garantia de formato —
 * o conteúdo é, e é ele que reconstrói o path do arquivo real
 * (`sessionFilePath`, que é literalmente `{kind}-{tag}-{sessionId}.json`).
 */
interface OrphanBackupGroup {
  /** Stem do arquivo REAL que este grupo representa (o que sumiu do disco). */
  stem: string;
  kind: SessionKind;
  machineTag: string;
  sessionId: string;
  /** Paths absolutos das cópias que compõem o grupo. */
  files: string[];
  /** União (`mergeSessionRecords`) de todas as cópias legíveis do grupo. */
  record: SessionRecord;
  /** `true` se QUALQUER cópia carrega `endedAt` — ver `isOrphanBackupGroupLive`. */
  anyEnded: boolean;
}

/**
 * Nomes das cópias `-safeBackup-` de `names` que estão ÓRFÃS: nenhum arquivo
 * REAL existente é prefixo delas (#7002). Complemento exato de
 * `groupBackupsByRealStem` — deriva do mesmo mapa em vez de reimplementar a
 * regra de desempate ("stem mais longo vence"), pra as duas leituras nunca
 * discordarem sobre a que grupo um backup pertence.
 */
function orphanBackupNames(names: readonly string[]): string[] {
  const owned = new Set<string>();
  for (const list of groupBackupsByRealStem(names).values()) {
    for (const name of list) owned.add(name);
  }
  return names.filter((n) => isSyncConflictCopyName(n) && !owned.has(n));
}

/**
 * Agrupa as cópias ÓRFÃS de `data/sessions/` por identidade de sessão
 * (`kind`/`machineTag`/`sessionId` lidos do conteúdo) e devolve a união de
 * cada grupo (#7002).
 *
 * Existe porque "backup órfão" tem DUAS causas indistinguíveis pela forma em
 * disco, e o read-path tratava as duas como a mesma:
 *   1. sessão encerrada limpo — `endSession` removeu o arquivo real de
 *      propósito e a cópia de conflito sobrou (o caso do #5427);
 *   2. **o arquivo real sumiu por lost-update enquanto a sessão seguia VIVA**
 *      — medido ao vivo no #7002 (a coordenadora perdeu o próprio arquivo com
 *      10 claims e um `merge_grant` íntegros nos backups, e passou a aparecer
 *      pras outras sessões com `claimed_issues: []`).
 *
 * Grupo ilegível/sem identidade não entra (mesma disciplina de
 * `readMergedSessionGroups`: nunca inventar sessão a partir de conteúdo que
 * não se conseguiu interpretar). `kind` fora de `ALL_SESSION_KINDS` também
 * não entra — um registro que este módulo não classifica nunca vira sessão
 * ativa por promoção.
 */
export function readOrphanBackupGroups(repoRoot: string): OrphanBackupGroup[] {
  const dir = sessionsDir(repoRoot);
  const names = listSessionJsonFiles(repoRoot);
  const byIdentity = new Map<string, { files: string[]; records: SessionRecord[] }>();
  for (const name of orphanBackupNames(names)) {
    const record = readJsonSafe<SessionRecord>(join(dir, name));
    if (!record || !record.sessionId || !record.kind || !record.machineTag) continue;
    if (!(ALL_SESSION_KINDS as readonly string[]).includes(record.kind)) continue;
    const stem = `${record.kind}-${record.machineTag}-${record.sessionId}`;
    const entry = byIdentity.get(stem) ?? { files: [], records: [] };
    entry.files.push(join(dir, name));
    entry.records.push(record);
    byIdentity.set(stem, entry);
  }

  const out: OrphanBackupGroup[] = [];
  for (const [stem, entry] of byIdentity) {
    const first = entry.records[0]!;
    // #7462: grupo órfão = SÓ `-safeBackup-*`, sem arquivo real. Passa
    // `realIndex = -1` pro `mergeSessionRecords` para que o `consumedAt` NUNCA
    // propague de um backup: sem real a testemunhar, o grant é considerado
    // vivo (mesma decisão do #6972 pro `merge_grant` inteiro). Antes, o
    // default 0 fazia o primeiro backup da lista atuar como se fosse o real.
    out.push({
      stem,
      kind: first.kind,
      machineTag: first.machineTag,
      sessionId: first.sessionId,
      files: entry.files,
      record: mergeSessionRecords(entry.records, -1),
      anyEnded: entry.records.some((r) => Boolean(r.endedAt)),
    });
  }
  return out;
}

/**
 * `true` quando um grupo órfão ainda representa uma sessão VIVA (#7002) — o
 * único caso em que ele volta a contar como sessão ativa no read-path.
 *
 * Duas condições, as duas necessárias:
 *   1. **Nenhuma** cópia do grupo carrega `endedAt`. `endSession` carimba esse
 *      campo em todas as cópias do grupo ANTES de remover o arquivo real
 *      (#7002), então um encerramento limpo fica marcado no próprio conteúdo
 *      — é o que separa a causa (1) da causa (2) descritas em
 *      `readOrphanBackupGroups` sem depender de heurística de tempo.
 *   2. O heartbeat mais recente do grupo está DENTRO da janela de liveness do
 *      kind (`softStaleMsForKind` — 90min pra coordenadora, 15min pra
 *      `interactive`). É exatamente o mesmo critério que `decideSessionGc` já
 *      usa pra NUNCA remover um backup órfão recente ("heartbeat recente …
 *      sessão claramente ativa"): o GC já tratava esse grupo como vivo
 *      enquanto o read-path o descartava, e é essa assimetria que o #7002
 *      mediu como falso-negativo de claim.
 *
 * Heartbeat no futuro além da tolerância de skew nunca conta como vivo —
 * mesma disciplina de `listActiveSessions`/`isMergeGrantLive`.
 */
/**
 * #13114 — o grupo (arquivo real + cópias de conflito) pertence a uma sessão
 * que já chamou `end`, mesmo com o arquivo real de volta no disco. Devolve o
 * `endedAt` que prova isso, ou `null`.
 *
 * Caso medido em 15/11/2026: o tick do contínuo
 * `hermes-cron-5d791ef6fc2c-20261115T145542Z` chamou `end` às 15:10:24Z
 * (evento `ended` em `data/session-lifecycle.jsonl`). Havia uma `.conflict1`
 * do rclone no disco, e `endSession` a carimbou com `endedAt` antes de apagar
 * o real. Depois disso o bisync trouxe o real de volta, numa versão com
 * heartbeat de 15:06:51Z e sem `endedAt`. O read-path tratava o real como
 * sessão viva (a cópia carimbada só saía da união), e a claim #13093 ficou
 * presa até a janela de 24h: o watchdog do contínuo leu isso como "higiene de
 * fim de tick falhou".
 *
 * Regra: algum registro do grupo traz `endedAt` e nenhum registro SEM
 * `endedAt` tem heartbeat posterior a ele. Uma sessão viva sempre escreve
 * depois do próprio `end` (um `register` novo com o mesmo id grava heartbeat
 * fresco), então heartbeat mais novo que o carimbo continua contando como
 * vida. Puro.
 */
export function endedAfterLastHeartbeat(records: readonly SessionRecord[]): string | null {
  let endedIso: string | null = null;
  let endedMs = -Infinity;
  let liveHeartbeatMs = -Infinity;
  for (const r of records) {
    if (r.endedAt) {
      const ms = Date.parse(r.endedAt);
      if (Number.isFinite(ms) && ms > endedMs) {
        endedMs = ms;
        endedIso = r.endedAt;
      }
      continue;
    }
    const hb = Date.parse(r.lastHeartbeat ?? r.startedAt ?? "");
    if (Number.isFinite(hb) && hb > liveHeartbeatMs) liveHeartbeatMs = hb;
  }
  if (endedIso === null) return null;
  return endedMs >= liveHeartbeatMs ? endedIso : null;
}

export function isOrphanBackupGroupLive(group: OrphanBackupGroup, now: number): boolean {
  if (group.anyEnded) return false;
  const record = group.record;
  const heartbeatMs = Date.parse(record.lastHeartbeat ?? record.startedAt ?? "");
  if (!Number.isFinite(heartbeatMs)) return false;
  const ageMs = now - heartbeatMs;
  if (ageMs < -CLOCK_SKEW_TOLERANCE_MS) return false;
  return ageMs <= softStaleMsForKind(record.kind);
}

/**
 * Loga (stderr, nunca lança) que uma escrita no registro (`claim-issue`,
 * `grant-merge`) encontrou o PRÓPRIO arquivo-âncora ausente e o reconstruiu a
 * partir das cópias de conflito órfãs (#7003).
 *
 * O ponto da issue: o auto-registro do #6369 é razoável pra "sessão nunca
 * registrada", mas quando a âncora some NO MEIO de uma sessão viva ele
 * converte perda de ARQUIVO em perda SILENCIOSA de ESTADO — recria o registro
 * zerado e segue. Reproduzido ao vivo: 10 `claim-issue` sequenciais deixaram a
 * âncora com 3 claims. Aqui a recuperação é ruidosa de propósito: quem lê o
 * stderr (systemd/Task Scheduler/terminal) vê que houve competição de escrita,
 * não um registro novo nascendo.
 */
export function warnAnchorRecoveredFromOrphanBackups(
  verb: string,
  sessionId: string,
  anchorPath: string,
  group: OrphanBackupGroup,
): void {
  try {
    process.stderr.write(
      `session-registry: ATENÇÃO — ${verb}: o arquivo-âncora da sessão sessionId="${sessionId}" ` +
        `("${anchorPath}") NÃO existe, mas ${group.files.length} cópia(s) de conflito do OneDrive dela sobrevivem ` +
        `com heartbeat recente. Isto NÃO é uma sessão nova: é a âncora sumindo sob escrita concorrente (#7002/#7003). ` +
        `O registro foi RECONSTRUÍDO a partir das cópias (claims recuperadas: ` +
        `${(group.record.claimed_issues ?? []).length}), nunca recriado zerado.\n`,
    );
  } catch {
    // Nunca deixar um log de warning derrubar o caminho principal.
  }
}

/**
 * Reconstrói o arquivo-âncora de uma sessão a partir das cópias de conflito
 * ÓRFÃS dela (#7003), quando (e só quando) o arquivo real sumiu e o grupo
 * órfão ainda parece vivo. Devolve o grupo usado, ou `null` quando não há o
 * que recuperar (o caso comum: sessão genuinamente nova).
 *
 * **Por que reconstruir em vez de abortar.** A issue pede que um claim que
 * encontra o próprio record ausente seja RUIDOSO, não silencioso. Abortar o
 * claim seria ruidoso e deixaria a sessão viva SEM claim nenhuma — o
 * falso-negativo que a própria #7003 chama de "pior que falso-positivo".
 * Reconstruir + avisar alto preserva o estado (que é o dano real medido) e
 * mantém o sinal visível pra quem investiga.
 *
 * A escrita é um CAS (`writeJsonSafeWithCas`) como todas as outras deste
 * módulo, e a base é a UNIÃO do que estiver em disco no momento do lock com o
 * grupo órfão — nunca um `...record` congelado: se outro escritor recriou a
 * âncora enquanto esperávamos o lock, o conteúdo dele entra na união em vez de
 * ser sobrescrito.
 */
export function recoverAnchorFromOrphanBackups(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  tag: string,
  now: string,
  nowMs: number = Date.parse(now),
): OrphanBackupGroup | null {
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  if (existsSync(path)) return null;
  const stem = `${kind}-${tag}-${sessionId}`;
  const group = readOrphanBackupGroups(repoRoot).find((g) => g.stem === stem);
  if (!group) return null;
  if (!isOrphanBackupGroupLive(group, Number.isFinite(nowMs) ? nowMs : Date.now())) return null;

  writeJsonSafeWithCas(
    path,
    (current) => {
      // #7462: `group.record` é a união de um grupo ÓRFÃO (só backups, sem
      // arquivo real) — o seu `consumedAt` nunca é testemunha. Quando
      // `current` existe, ele é o arquivo REAL (outro escritor recriou a
      // âncora enquanto esperávamos o lock), então o real é a posição 1; quando
      // não existe, o grupo é só backups e não há real a consultar. O default
      // `realIndex=0` trataria o órfão como se fosse o real e podia propagar
      // um `consumedAt` que o real nunca teve — mesma classe de bug que a
      // issue #7462 relata.
      const merged = mergeSessionRecords(current ? [group.record, current] : [group.record], current ? 1 : -1);
      const record: SessionRecord = {
        ...merged,
        kind,
        machineTag: tag,
        sessionId,
        startedAt: merged.startedAt ?? now,
        lastHeartbeat: now,
      };
      // `stale` é campo COMPUTADO (nunca persistido) e `endedAt` nunca chega
      // aqui (grupo com `endedAt` não é "vivo"), mas remover explicitamente
      // impede que um deles vaze pro disco caso a origem já viesse sujo.
      delete record.stale;
      delete record.endedAt;
      // **`merge_grant` NÃO é recuperado — assimetria deliberada (#6972).**
      // Claim se recupera porque a direção segura é "preferir reivindicada";
      // concessão de merge NÃO, porque a direção segura é a oposta. Promover
      // pro arquivo real um grant que só existia em cópia de conflito faria o
      // gate do #5716 passar a honrá-lo — exatamente o que o review da PR
      // #6969 recusou ("grant é autorização, e autorização não se infere de
      // detrito"), só que pela porta dos fundos de um `claim-issue`. O
      // caminho correto continua sendo o que `check-merge-grant` manda fazer:
      // pedir RECONCESSÃO à coordenadora, que aí escreve o grant no arquivo
      // real deliberadamente (e `grantMergeWindow`, logo depois de recuperar
      // a âncora, faz precisamente isso).
      delete record.merge_grant;
      // Exceção estreita: se outro escritor recriou a âncora enquanto
      // esperávamos o lock e ELE gravou um grant no arquivo REAL, esse grant
      // é deliberado — preservá-lo é o oposto de promover detrito.
      if (current?.merge_grant) record.merge_grant = current.merge_grant;
      return record;
    },
    (onDisk) => onDisk?.lastHeartbeat === now && onDisk?.sessionId === sessionId,
  );
  return group;
}

/** Nomes de arquivo `.json` de sessão (real ou backup) em `data/sessions/` —
 * exclui dotfiles (`.merge-lock.json` etc). Fail-soft: diretório ausente ou
 * erro de leitura → array vazio, nunca lança. Ordem não é garantida
 * (`readdirSync` bruto). Inclui a cópia de conflito do rclone bisync
 * (`{nome}.json.conflictN`, #12357): ela não termina em `.json`, e sem isto
 * o registro nem unia a claim que só sobreviveu nela nem a recolhia no GC.
 * Quem separa real de cópia é `isSyncConflictCopyName`. */
export function listSessionJsonFiles(repoRoot: string): string[] {
  const dir = sessionsDir(repoRoot);
  if (!existsSync(dir)) {
    // #12547: segue fail-soft (lista vazia), mas a junction pendente de
    // `data/` deixa de se passar por "nenhuma sessão" em silêncio.
    probeSessionsDirWithWarning(repoRoot);
    return [];
  }
  try {
    return readdirSync(dir).filter(
      (n) => !n.startsWith(".") && (n.endsWith(".json") || rcloneConflictOriginalName(n)?.endsWith(".json") === true),
    );
  } catch (e) {
    // #6277 (achado do review): este catch era VAZIO. Uma falha de I/O no
    // diretório inteiro (EBUSY/EPERM/EACCES — os mesmos transitórios de
    // OneDrive que `readJsonSafe` já loga por arquivo) colapsava para "nenhuma
    // sessão existe", sem uma linha de aviso. Pior que o caso por-arquivo, que
    // ao menos avisa. Isso virou crítico quando `findActiveSessionsOfKind`
    // passou a decidir "há overnight rodando?" em cima disso: falha de leitura
    // vira `active: false` e o contínuo volta a duplicar o trabalho do
    // overnight — exatamente o desperdício que o mecanismo existe pra evitar.
    warnIoError(dir, e);
    return [];
  }
}

/**
 * Une um grupo de registros (arquivo real + eventuais cópias de conflito do
 * MESMO sessionId, #6130) num único `SessionRecord` efetivo:
 *   - `claimed_issues`: UNIÃO de todos os arrays do grupo — fail-safe,
 *     preferir "está reivindicada" a "não está" (ver docstring do módulo).
 *   - `merge_grant`: UNIDO também, desde o #6952 — ver abaixo.
 *   - demais campos (phase, pid, active_worktrees, lastHeartbeat…): copiados
 *     do registro com o `lastHeartbeat` MAIS RECENTE do grupo — se qualquer
 *     cópia mostra atividade recente, o grupo inteiro é tratado como
 *     recente (mesmo princípio fail-safe: preferir "viva" a "stale").
 *
 * **#6952, segunda metade — por que `merge_grant` precisou entrar na união.**
 * Até aqui só `claimed_issues`/`claimed_issues_at` eram unidos; todo o resto
 * vinha de `...primary`, e `primary` é escolhido por heartbeat mais recente.
 * Um `merge_grant` gravado num record que PERDE essa disputa — uma cópia de
 * conflito do OneDrive com heartbeat mais novo, o cenário para o qual esta
 * função existe — era descartado em SILÊNCIO na leitura. Exatamente o oposto
 * do que o #6130/#6436 garantiram pra claim, e é essa assimetria que explica
 * o sintoma medido no #6952: a claim sobrevivia e o grant sumia.
 *
 * Isto é uma metade independente do lost update de ESCRITA (fechado pelo
 * `writeJsonSafeWithCas`): serializar toda escrita não ajuda em nada aqui,
 * porque as duas cópias são gravadas corretamente, cada uma no seu arquivo, e
 * a perda acontece depois, na hora de ler.
 *
 * Regra da união, e o cuidado que ela exige:
 *   1. Vence o grant de `grantedAt` MAIS RECENTE do grupo — não o do
 *      `primary`. Uma concessão nova nunca é ofuscada por uma velha só
 *      porque a velha está no arquivo com heartbeat mais alto.
 *   2. `consumedAt` PROPAGA — mas só do arquivo REAL, nunca de uma cópia
 *      `-safeBackup-` (#7462). Se o real mostra a concessão vencedora como
 *      consumida, o resultado sai consumido (com o `consumedAt` mais ANTIGO —
 *      a primeira consumação é a real). É a direção segura: sem isto, uma
 *      cópia velha sem `consumedAt` RESSUSCITA um grant já usado e o transforma
 *      em uso duplo — dano pior que a perda que esta função conserta. Um guard
 *      que erra para o lado do dano é pior que nenhum guard.
 *
 *   **Por que a fonte do `consumedAt` importa (#7462).** O #6952 fez a união
 *   para que uma concessão que sobrevivesse só num backup não sumisse na
 *   leitura — e é isso mesmo que causou o sintoma: o `consumedAt` também
 *   passou a vir de cópias de conflito, e o read-path (`findLiveMergeGrant` →
 *   `isMergeGrantLive`) passou a ver uma concessão como já usada mesmo quando
 *   o ARQUIVO REAL (o único que o gate de merge
 *   `.claude/hooks/block-gh-pr-merge-subagent.mjs` lê, que pula
 *   `-safeBackup-` nomes) nunca foi carimbado. Resultado: `check-merge-grant`
 *   dizia `granted: true` e o `gh pr merge` era bloqueado com
 *   `consumedAt` já presente, sem que nenhuma sessão tivesse chamado
 *   `consume-merge-grant` — exatamente o que a issue #7462 relata, reproduzido
 *   2×. O `consumedAt` é um carimbo de FATO, não um voto de maioria: só
 *   conta quando está no registro que o merge de fato escreveu.
 *
 *   A distinção é o que `mergeSessionRecords` recebe já resolvido — o caller
 *   passa os records com o real na posição 0 (ver `readMergedSessionGroups`,
 *   `readMergedRecordForRealFile`, `dedupeBySessionId`). Quando o real é
 *   ilegível/ausente, o grupo é de fato SÓ backups (órfão) e aí não há real a
 *   consultar — o grant é considerado vivo, como o #6972 já decide pro
 *   `merge_grant` inteiro (não se recupera um grant de órfão pro real).
 *
 * As duas identidades são comparadas por `(grantedBy, grantedTo, grantedAt)`:
 * é o que distingue "a mesma concessão em duas cópias do arquivo" de "duas
 * concessões diferentes".
 *
 * Pura — não lê disco. `records` não pode ser vazio.
 */
export function mergeSessionRecords(
  records: readonly SessionRecord[],
  // #7462: índice do arquivo REAL no array. `consumedAt` só propaga dele —
  // cópias `-safeBackup-` são detrito de sync, não prova de consumo. Default 0
  // porque os callers que passam records crus colocam o real em [0]
  // (`readMergedSessionGroups`, `readMergedRecordForRealFile`,
  // `decideClaimReconciliation`, `mergeGrantBlocksBackupCleanup`). `−1` = grupo
  // sem real (órfão): o grant é considerado vivo, como o #6972 decide pro
  // `merge_grant` inteiro. Callers que já mesclaram (ex: `dedupeBySessionId`)
  // passam o default — o `consumedAt` deles já reflete o real.
  realIndex: number = 0,
): SessionRecord {
  // #6130 (achado do fleet review, P3 alta confiança): o invariante "records
  // não pode ser vazio" só existia em comentário — um `records[0]!` mentia
  // pro type checker. Falha nomeada em vez de um TypeError opaco.
  if (records.length === 0) {
    throw new Error("mergeSessionRecords: records não pode ser vazio");
  }
  // Fleet review (#7467, achado MÉDIO): `records[realIndex]!` mais abaixo é
  // non-null assertion — fora do range, um `TypeError` opaco ("Cannot read
  // properties of undefined") em vez de um erro nomeado que aponta pra causa.
  // Mesma disciplina do guard "records não vazio" acima (#6130): `-1` (órfão,
  // #6972) é o único valor negativo válido — qualquer outro fora de
  // `[0, records.length)` é um bug do caller, não um caso a tolerar.
  if (realIndex !== -1 && (realIndex < 0 || realIndex >= records.length)) {
    throw new Error(
      `mergeSessionRecords: realIndex (${realIndex}) fora do range válido — records tem ${records.length} elemento(s); ` +
        "só -1 (grupo órfão, #6972) ou um índice dentro de [0, records.length) são aceitos",
    );
  }
  let primary = records[0]!;
  let primaryHb = Date.parse(primary.lastHeartbeat ?? primary.startedAt ?? "");
  for (const r of records.slice(1)) {
    const hb = Date.parse(r.lastHeartbeat ?? r.startedAt ?? "");
    if (Number.isFinite(hb) && (!Number.isFinite(primaryHb) || hb > primaryHb)) {
      primary = r;
      primaryHb = hb;
    }
  }
  const claimedUnion = new Set<number>();
  for (const r of records) for (const issue of r.claimed_issues ?? []) claimedUnion.add(issue);
  // #10618 — mesma união fail-safe pras claims de outro repo.
  const foreignUnion = new Set<string>();
  for (const r of records) for (const ref of r.claimed_foreign_issues ?? []) foreignUnion.add(ref);
  const foreignAtUnion: Record<string, string> = {};
  for (const r of records) {
    for (const [key, at] of Object.entries(r.claimed_foreign_issues_at ?? {})) {
      const existing = foreignAtUnion[key];
      if (!existing || Date.parse(at) < Date.parse(existing)) foreignAtUnion[key] = at;
    }
  }
  // #6436 — une `claimed_issues_at` de todas as cópias do grupo, mantendo o
  // timestamp MAIS ANTIGO por issue (a claim "de verdade" começou lá, mesmo
  // que uma cópia de conflito do OneDrive tenha um valor mais recente por
  // ter sido escrita numa reivindicação subsequente ainda não deduplicada).
  const claimedAtUnion: Record<string, string> = {};
  for (const r of records) {
    for (const [key, at] of Object.entries(r.claimed_issues_at ?? {})) {
      const existing = claimedAtUnion[key];
      if (!existing || Date.parse(at) < Date.parse(existing)) {
        claimedAtUnion[key] = at;
      }
    }
  }
  // #6952 (2ª metade): `merge_grant` unido, não herdado do `primary`.
  const grants = records.map((r) => r.merge_grant).filter((g): g is MergeGrant => Boolean(g));
  let mergedGrant: MergeGrant | undefined;
  if (grants.length > 0) {
    let winner = grants[0]!;
    for (const g of grants.slice(1)) {
      const a = Date.parse(g.grantedAt ?? "");
      const b = Date.parse(winner.grantedAt ?? "");
      if (Number.isFinite(a) && (!Number.isFinite(b) || a > b)) winner = g;
    }
    // Só o ARQUIVO REAL testemunha um consumo de fato (#7462). Cópias
    // `-safeBackup-` são detrito de sync do OneDrive — uma concessão viva
    // nelas é sinal de que o real ficou pra trás, não de que alguém
    // consumiu. O `consumedAt` é um carimbo de FATO (o merge bem-sucedido
    // que o gravou), não um voto de maioria: quando o real é ilegível/ausente
    // (grupo órfão, `realIndex === -1`) não há quem testemunhe, e o grant
    // continua vivo — mesma decisão do #6972 pro `merge_grant` inteiro.
    //
    // O `consumedAt` vem SEMPRE do real, nunca do winner: o winner é o
    // grant de `grantedAt` mais recente do grupo, e pode ser um backup com
    // um `consumedAt` que o real nunca teve. `{ ...winner }` espalha o
    // `consumedAt` do próprio winner, então sem este `delete` o mesclado
    // sairia consumido de qualquer jeito quando o winner fosse um backup —
    // reproduzido ao vivo em #7462 com `realIndex=1` (real na posição 1) e
    // com `realIndex=-1` (grupo órfão, só backups).
    const realGrant = realIndex >= 0 ? records[realIndex]!.merge_grant : undefined;
    const realIsWitness =
      realGrant !== undefined &&
      realGrant.grantedBy === winner.grantedBy &&
      realGrant.grantedTo === winner.grantedTo &&
      realGrant.grantedAt === winner.grantedAt;
    // #7462: o `consumedAt` vem SÓ do real, nunca do winner. O winner é o
    // grant de `grantedAt` mais recente do grupo, e pode ser um backup com
    // um `consumedAt` que o real nunca teve — `{ ...winner }` espalha o
    // `consumedAt` do próprio winner, então sem este `delete` o mesclado
    // sairia consumido de qualquer jeito quando o winner fosse um backup
    // (reproduzido ao vivo em #7462 com `realIndex=1` e `realIndex=-1`).
    // Retira o carimbo do winner ANTES de reconstruir: o grant mesclado só
    // leva `consumedAt` quando alguém que TESTEMUNHA a MESMA identidade
    // (ver abaixo) o mostra consumido.
    const { consumedAt: _winnerConsumedAt, ...winnerClean } = winner;
    let consumedAt: string | undefined;
    if (realIsWitness) {
      // O real carrega ESTA identidade (consumida ou não) — é o único que
      // testemunha (#7462). Backups nunca contradizem o real.
      consumedAt = realGrant.consumedAt;
    } else if (realIndex >= 0) {
      // #6952 (achado que reabriu #7462): o real EXISTE, mas não carrega
      // NENHUMA opinião sobre esta identidade — não tem `merge_grant`
      // (beacon reescreveu sem ele) ou tem um de OUTRA concessão. O real
      // nunca teve chance de testemunhar esta, então "só o real conta" não
      // se aplica: cai pro comportamento pré-#7462 (união por identidade
      // entre as cópias que de fato carregam o grant — normalmente só
      // backups, já que o real não o carrega). Sem este fallback,
      // `consumeMergeGrant` carimba o backup (única cópia com a
      // identidade, igual sempre fez) mas a releitura nunca via o carimbo
      // — grant encontrável e PERPETUAMENTE inconsumível.
      for (const g of grants) {
        if (g.grantedBy !== winner.grantedBy || g.grantedTo !== winner.grantedTo || g.grantedAt !== winner.grantedAt) {
          continue;
        }
        if (!g.consumedAt) continue;
        if (!consumedAt || Date.parse(g.consumedAt) < Date.parse(consumedAt)) consumedAt = g.consumedAt;
      }
    }
    // Se `realIndex === -1` (grupo ÓRFÃO, #6972): nenhum dos dois ramos acima
    // roda, `consumedAt` fica `undefined` — sem real, não há testemunha, e o
    // grant é considerado vivo (nunca consumido), mesma decisão do #6972.
    //
    // Só inclui `consumedAt` quando REALMENTE está presente. Um grant vivo
    // (não consumido) não tem o campo — e `assert.deepEqual` distingue
    // `{ ...grant, consumedAt: undefined }` de `grant` (o campo ausente).
    // Sem este spread condicional, o mesclado sairia com a CHAVE `consumedAt`
    // definida como `undefined` pra qualquer grant vivo, quebrando a
    // representação canônica do #6952/#6972 (um grant vivo é exatamente um
    // objeto SEM `consumedAt`).
    mergedGrant = consumedAt ? { ...winnerClean, consumedAt } : winnerClean;
  }

  return {
    ...primary,
    ...(mergedGrant ? { merge_grant: mergedGrant } : {}),
    claimed_issues: [...claimedUnion].sort((a, b) => a - b),
    claimed_issues_at: claimedAtUnion,
    // #8521: histórico de claims também é UNIÃO das cópias (conflito do
    // OneDrive) — senão uma cópia vencedora sem o campo apagaria o histórico.
    ...(records.some((r) => r.claimed_issues_ever)
      ? { claimed_issues_ever: [...new Set(records.flatMap((r) => r.claimed_issues_ever ?? []))].sort((a, b) => a - b) }
      : {}),
    // #10618 — só materializa os campos de outro repo quando alguma cópia os
    // tem, pra não mudar o shape de registros que nunca reivindicaram fora.
    ...(records.some((r) => r.claimed_foreign_issues || r.claimed_foreign_issues_at)
      ? { claimed_foreign_issues: [...foreignUnion].sort(), claimed_foreign_issues_at: foreignAtUnion }
      : {}),
    ...(records.some((r) => r.claimed_foreign_issues_ever)
      ? { claimed_foreign_issues_ever: [...new Set(records.flatMap((r) => r.claimed_foreign_issues_ever ?? []))].sort() }
      : {}),
  };
}
