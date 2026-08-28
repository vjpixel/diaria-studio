// PreToolUse hook — mantém um "beacon" de atividade por sessão em
// `data/sessions/`, escrito AUTOMATICAMENTE a cada chamada de ferramenta
// (#6168 Parte B).
//
// Wired em .claude/settings.json sob hooks.PreToolUse, matcher
// "Bash|Edit|Write|NotebookEdit".
//
// ─────────────────────────────────────────────────────────────────────────
// POR QUE ISTO É UM HOOK, E NÃO UM PASSO DE SKILL
// ─────────────────────────────────────────────────────────────────────────
//
// O argumento central de desenho da #6168 é uma observação sobre o próprio
// repo: **o que depende de skill lembrar, não acontece.** Três mecanismos
// corretos, testados e inertes provaram isso:
//
//   - #5156 item 6 — `heartbeat --active-worktrees N` nunca foi chamado por
//     skill nenhuma. O read-path existe e é testado; o campo fica `undefined`
//     pra sempre, há meses.
//   - #6160 — `register` nunca recebia `--pid` de overnight/develop, então o
//     branch "processo vivo protege o registro" do GC era inalcançável
//     justamente pros 2 kinds que mais rodam. Fechado por HOOK
//     (`inject-session-id.mjs`), não por skill.
//   - #5156 item 11 — `plan.session_id` tem rollout pendente; nenhuma skill
//     grava.
//
// Por isso o beacon roda no `PreToolUse`, que o harness executa em TODA
// chamada de ferramenta de TODA sessão — registrada ou não, skill ou
// conversa comum. Nenhuma skill precisa cooperar, e é essa propriedade que
// fecha o buraco 3 da issue (sessão interativa invisível ao registro —
// incidente #5751, em que o `helios` segurava #5738 em `claimed_issues`
// enquanto uma sessão interativa a implementava e mergeava em paralelo).
//
// ─────────────────────────────────────────────────────────────────────────
// A OBJEÇÃO QUE QUASE DERRUBOU ISTO, E COMO ELA FOI RESPONDIDA
// ─────────────────────────────────────────────────────────────────────────
//
// Uma sessão peer, ao ser convidada a se registrar, RECUSOU de propósito, com
// um argumento correto: "esta sessão não emite heartbeat depois que a conversa
// termina" — registrar deixaria uma claim órfã, trocando risco de colisão por
// risco de bloqueio permanente, "que é pior porque não se resolve sozinho".
//
// Metade da objeção morre com o próprio hook: o heartbeat é automático
// ENQUANTO a sessão está viva, sem ninguém lembrar de nada. A outra metade é
// real — quando a conversa acaba, as chamadas param e o registro sobrevive —
// e foi respondida em `scripts/lib/session-registry.ts` com janelas próprias
// pro kind `interactive`: `INTERACTIVE_SOFT_STALE_MS` (15 min, contra 90) e
// `GC_INTERACTIVE_MAX_AGE_MS` (2h, contra 7 dias). Sem essas duas constantes,
// este hook PIORARIA o problema que existe pra resolver.
//
// ─────────────────────────────────────────────────────────────────────────
// BLAST RADIUS (decisões explícitas, não efeitos colaterais)
// ─────────────────────────────────────────────────────────────────────────
//
// Registrar sessões interativas muda o significado de "existe sessão ativa"
// pra três consumidores. Cada um foi tratado, e `test/session-beacon-*.test.ts`
// trava os três:
//
//   1. `scripts/cleanup-merged-worktrees.ts` → `shouldSkipForSharedSession`
//      pulava a varredura se QUALQUER sessão estivesse ativa. Com interativas
//      registrando, passaria a pular SEMPRE. Corrigido lá: filtra por kind
//      coordenador.
//   2. `.claude/hooks/block-gh-pr-merge-subagent.mjs` → `COORDINATOR_KINDS`
//      NÃO recebe o kind novo. Interativa não é coordenadora e não vira uma
//      por relabel; o caminho legítimo dela pro merge é a concessão de janela
//      (#6296), nunca o kind.
//   3. `isIssueClaimedByOther` → claim de interativa BLOQUEIA overnight/
//      develop. É premissa deliberada: é literalmente o caso do #5751.
//
// ─────────────────────────────────────────────────────────────────────────
// CUSTO E FAIL-OPEN
// ─────────────────────────────────────────────────────────────────────────
//
// Roda em toda chamada de ferramenta, então não pode custar caro: nenhum
// subprocesso (a branch sai de ler `.git/HEAD`; a raiz do checkout principal
// sai de ler `.git`), e um throttle de `MIN_WRITE_INTERVAL_MS` evita reescrever
// o arquivo quando nada mudou — `data/sessions/` vive numa junction OneDrive,
// e escrita de alta frequência ali é exatamente o que gera cópia de conflito
// `-safeBackup-NNNN` (#5427/#6130).
//
// Fail-open TOTAL, sem exceção: este hook NUNCA emite saída (não altera nem
// bloqueia nada) e engole toda exceção. Um beacon quebrado pode custar
// visibilidade; nunca pode custar uma chamada de ferramenta do editor.
//
// Self-contained (nenhum import de `scripts/*.ts`): mesma razão documentada em
// `pr-create-review.mjs` e `block-gh-pr-merge-subagent.mjs` — um import
// estático de `.ts` quebra o hook inteiro, em silêncio, num Node sem
// type-stripping nativo. **Precisão sobre o que é testado (#6303 Finding M —
// a afirmação anterior aqui, "as constantes duplicadas aqui são travadas
// contra a fonte", era imprecisa: `test/session-beacon-hook.test.ts` só
// comparava a função/constante DESTE arquivo contra um literal, nunca
// importava a versão irmã de `session-registry.ts` lado a lado — dois pinos
// independentes, cada um certo por coincidência):** o cross-check DE
// VERDADE — `TOUCHED_PATHS_CAP`, `normalizePath`/`normalizeBeaconPath`,
// `collapsePaths`/`collapseTouchedPaths` importados dos DOIS módulos e
// comparados — mora em `test/session-beacon-blast-radius.test.ts` (describe
// "#6303 Findings L/M/J"). `test/session-beacon-hook.test.ts` continua
// testando o COMPORTAMENTO das funções deste arquivo isoladamente (útil por
// si só), mas não prova mais paridade cruzada nenhuma — nem o título dos
// testes lá afirma isso.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";

/** Kind das sessões registradas por este hook. Nunca coordenador — ver blast radius 2. */
export const BEACON_KIND = "interactive";

/**
 * Duplicado de `COORDINATOR_SESSION_KINDS` (`scripts/lib/session-registry.ts`)
 * — hook self-contained, mesma razão documentada em `pr-create-review.mjs`/
 * `block-gh-pr-merge-subagent.mjs`. `test/session-beacon-blast-radius.test.ts`
 * trava que os dois conjuntos não divergem.
 *
 * Usado por `findExistingSessionFile` (#6326 fleet review item 3) pra
 * preferir um registro COORDENADOR sobre um `interactive` pro MESMO
 * sessionId, em vez de decidir por ordem alfabética — ver docstring de
 * `findExistingSessionFile`.
 */
export const COORDINATOR_KIND_PREFIXES = ["overnight", "develop", "continuo"];

/** Duplicado de `TOUCHED_PATHS_CAP` em session-registry.ts (hook self-contained). */
export const TOUCHED_PATHS_CAP = 200;

/**
 * Não reescreve o registro se o último write foi há menos que isto E nada
 * mudou (nenhum caminho novo, mesma branch, mesmo verbo). Ver "CUSTO" acima.
 */
export const MIN_WRITE_INTERVAL_MS = 5000;

/** Sanitiza o hostname pra nome de arquivo seguro. Nunca lança. */
export function machineTag() {
  try {
    return (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    return "unknown";
  }
}

/**
 * Resolve a raiz do checkout PRINCIPAL **sem spawnar processo** — os hooks
 * irmãos usam `git rev-parse --git-common-dir`, que é correto mas custa um
 * subprocesso; aqui isso rodaria a cada chamada de ferramenta.
 *
 * Regras, todas por leitura de arquivo:
 *   - `<dir>/.git` é DIRETÓRIO  → `<dir>` já é o checkout principal.
 *   - `<dir>/.git` é ARQUIVO    → conteúdo `gitdir: <main>/.git/worktrees/<nome>`;
 *     subir 3 níveis a partir dali devolve `<main>`.
 * Devolve `null` quando não dá pra determinar — o caller então não faz nada
 * (fail-open).
 */
export function resolveMainRepoRootNoSpawn(startDir, fs = { existsSync, readFileSync, statIsDirectory }) {
  try {
    const gitPath = join(startDir, ".git");
    if (!fs.existsSync(gitPath)) return null;
    if (fs.statIsDirectory(gitPath)) return startDir;
    const raw = fs.readFileSync(gitPath, "utf8");
    const match = /gitdir:\s*(.+)/.exec(raw);
    if (!match) return null;
    const gitDir = resolvePath(startDir, match[1].trim());
    // .../<main>/.git/worktrees/<nome>  →  sobe worktrees/<nome> e o .git
    const worktreesDir = dirname(gitDir);
    if (dirname(worktreesDir).endsWith(".git") || /[\\/]\.git$/.test(dirname(worktreesDir))) {
      return dirname(dirname(worktreesDir));
    }
    return null;
  } catch {
    return null;
  }
}

/** Helper injetável — `statSync(...).isDirectory()` via import ESM real (`node:fs`). */
function statIsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    try {
      // Fallback: readdirSync lança ENOTDIR em arquivo, o que responde a mesma pergunta.
      readdirSync(path);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * `true` quando `startDir` é um worktree VINCULADO (`.git` é ARQUIVO com
 * `gitdir:`), `false` quando é o checkout principal (`.git` é DIRETÓRIO) ou
 * quando não dá pra determinar (#6303 review cruzado, P2).
 *
 * Usado pra não registrar subagente: todo implementador despachado via
 * `Agent` roda com `isolation: "worktree"`, então o próprio arquivo deste
 * hook mora num worktree vinculado. Ver o racional completo no entrypoint.
 *
 * Fail-open pro lado de REGISTRAR (`false` na dúvida): se não deu pra ler o
 * `.git`, o comportamento volta a ser o de antes deste guard. Errar aqui
 * custa um registro a mais, não um registro a menos — e um registro a menos
 * seria justamente cegar o `conflicts` da sessão real.
 */
export function isLinkedWorktree(startDir) {
  try {
    const gitPath = join(startDir, ".git");
    if (!existsSync(gitPath)) return false;
    return !statIsDirectory(gitPath);
  } catch {
    return false;
  }
}

/**
 * Lê a branch corrente a partir de `.git/HEAD` (do worktree, quando for um).
 * `null` em detached HEAD ou qualquer falha — nunca lança, nunca spawna.
 */
export function readCurrentBranch(startDir) {
  try {
    const gitPath = join(startDir, ".git");
    if (!existsSync(gitPath)) return null;
    let gitDir = gitPath;
    if (!statIsDirectory(gitPath)) {
      const match = /gitdir:\s*(.+)/.exec(readFileSync(gitPath, "utf8"));
      if (!match) return null;
      gitDir = resolvePath(startDir, match[1].trim());
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1] : null; // detached HEAD → null, de propósito
  } catch {
    return null;
  }
}

/** Normaliza caminho pra comparação cross-máquina. Espelha `normalizeBeaconPath`. */
export function normalizePath(path) {
  return String(path)
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/**
 * Extrai o(s) caminho(s) que a chamada de ferramenta vai tocar, relativos à
 * raiz. Só Edit/Write/NotebookEdit têm `file_path` — para `Bash` retorna
 * vazio de propósito: parsear caminho de linha de comando é frágil, e o sinal
 * que interessa do Bash é o VERBO (ver `sniffVerb`), não os arquivos.
 *
 * #6303 Finding U: `path.relative()` entre DRIVES diferentes no Windows
 * (`C:\foo` vs `D:\bar\x.txt`) não devolve uma string começando com `..` — o
 * guard `rel.startsWith("..")` sozinho não pega esse caso, e uma string sem
 * sentido (o path ABSOLUTO do outro drive, sem transformação nenhuma —
 * `path.relative` não sabe cruzar drives) entraria em `touched_paths`. Hoje
 * é latente (o repo, worktrees, scratchpad e a junction OneDrive vivem todos
 * no mesmo drive nesta máquina) e o pior efeito é POLUIÇÃO do campo, nunca
 * falso-negativo — mas o segundo guard (`isAbsolute(rel)`, o sinal confiável
 * de "não há caminho relativo real entre os dois") é barato e fecha a
 * lacuna por completo.
 */
export function extractTouchedPaths(toolName, toolInput, repoRoot) {
  const filePath = toolInput?.file_path ?? toolInput?.notebook_path;
  if (!filePath) return [];
  if (!["Edit", "Write", "NotebookEdit"].includes(toolName)) return [];
  try {
    const rel = relative(repoRoot, resolvePath(String(filePath)));
    // Fora do repo (scratchpad, /tmp, ou outro DRIVE no Windows — #6303
    // Finding U) não interessa a nenhum peer.
    if (rel.startsWith("..") || rel === "" || isAbsolute(rel)) return [];
    return [normalizePath(rel)];
  } catch {
    return [];
  }
}

/**
 * Verbo curto a partir de um comando Bash. Deliberadamente uma lista pequena
 * de verbos que MUDAM estado compartilhado — não é um parser de shell, e não
 * precisa ser: o valor está em distinguir "commitou e abriu PR" de "editou e
 * foi dormir" (evidência 2 da #6168), não em classificar todo comando.
 */
export function sniffVerb(command) {
  if (typeof command !== "string") return null;
  if (/\bgit\s+commit\b/.test(command)) return "commit";
  if (/\bgit\s+(checkout|switch)\b/.test(command)) return "checkout";
  if (/\bgit\s+push\b/.test(command)) return "push";
  if (/\bgh\s+pr\s+create\b/.test(command)) return "pr-create";
  if (/\bgh\s+pr\s+merge\b/.test(command)) return "pr-merge";
  if (/\bgit\s+worktree\s+add\b/.test(command)) return "worktree-open";
  return null;
}

/**
 * Aplica o teto colapsando pra prefixo de diretório em vez de truncar.
 * Espelha `collapseTouchedPaths` de session-registry.ts.
 */
export function collapsePaths(paths, cap = TOUCHED_PATHS_CAP) {
  let current = [...new Set(paths.map(normalizePath))].filter((p) => p !== "");
  if (current.length <= cap) return current.sort();
  const maxDepth = Math.max(...current.map((p) => p.split("/").length));
  for (let depth = maxDepth - 1; depth >= 1; depth--) {
    current = [
      ...new Set(
        current.map((p) => {
          const parts = p.split("/");
          return parts.length > depth ? parts.slice(0, depth).join("/") : p;
        }),
      ),
    ];
    if (current.length <= cap) break;
  }
  return current.sort().slice(0, cap);
}

/**
 * Função PURA — dado o registro anterior (ou `null`) e o que aconteceu agora,
 * devolve o registro novo, ou `null` quando nada mudou o bastante pra
 * justificar um write (throttle).
 *
 * `git commit` ZERA `dirty_paths`: é o que faz o campo significar "trabalho
 * não commitado" em vez de "arquivos que a sessão já tocou alguma vez" —
 * exatamente a distinção que a evidência 2 da issue pedia (um tick terminou
 * deixando 4 arquivos sem commit em `master` num checkout compartilhado e
 * reportou "concluído"; qualquer sessão que rodasse `git add -A` no intervalo
 * publicaria trabalho de outra frente na PR errada).
 */
export function buildBeaconRecord(previous, event) {
  const { kind, machineTag: tag, sessionId, branch, newPaths, verb, nowIso, pid } = event;
  const nowMs = Date.parse(nowIso);

  const prevTouched = previous?.touched_paths ?? [];
  const prevDirty = previous?.dirty_paths ?? [];
  const added = newPaths.filter((p) => !prevTouched.includes(p));

  const branchChanged = Boolean(branch) && previous?.branch !== branch;
  const verbChanged = Boolean(verb) && previous?.last_action?.verb !== verb;
  const nothingNew = added.length === 0 && !branchChanged && !verbChanged;

  if (previous && nothingNew) {
    const lastMs = Date.parse(previous.lastHeartbeat ?? "");
    if (Number.isFinite(lastMs) && Number.isFinite(nowMs) && nowMs - lastMs < MIN_WRITE_INTERVAL_MS) {
      return null; // throttle: nada novo e o último write foi agora há pouco
    }
  }

  const record = {
    ...(previous ?? {}),
    kind: previous?.kind ?? kind,
    machineTag: previous?.machineTag ?? tag,
    sessionId,
    startedAt: previous?.startedAt ?? nowIso,
    lastHeartbeat: nowIso,
    claimed_issues: previous?.claimed_issues ?? [],
    touched_paths: collapsePaths([...prevTouched, ...newPaths]),
    // `git commit` zera o não-commitado; qualquer outra coisa acumula.
    dirty_paths: verb === "commit" ? [] : collapsePaths([...prevDirty, ...newPaths]),
  };
  if (branch) record.branch = branch;
  if (verb) record.last_action = { verb, at: nowIso };
  if (previous?.pid === undefined && pid !== undefined) record.pid = pid;
  return record;
}

/**
 * Localiza o arquivo de registro DESTA sessão em `data/sessions/`, qualquer
 * que seja o kind. Uma sessão coordenadora (`overnight`/`develop`/`continuo`)
 * já tem registro próprio, escrito pela skill dela — o beacon deve ENRIQUECER
 * esse registro, nunca criar um `interactive-*` paralelo pro mesmo
 * `sessionId` (isso a faria aparecer duas vezes em `list-active` e contar
 * duplicado em todo consumidor).
 *
 * **#6326 fleet review item 3 — desempate por KIND, não por ordem
 * alfabética.** A versão anterior fazia só `.sort()[0]` sobre todo match do
 * sufixo. Isso é correto SÓ por acidente: alfabeticamente
 * `continuo` < `develop` < `interactive` < `overnight`. Então, quando os dois
 * arquivos presentes eram `{develop|continuo}-*` + `interactive-*`, o
 * coordenador vinha primeiro (certo, por sorte de ordenação) — mas quando
 * eram `interactive-*` + `overnight-*` (o par exato medido ao vivo no
 * `helios` pela #6326), `interactive` vinha ANTES de `overnight` e o beacon
 * escolhia o arquivo ERRADO **permanentemente**: escrevia heartbeat no
 * `interactive-*` só recém-promovido-e-removido por `registerSession`,
 * recriando-o, e o `overnight-*` coordenador ficava sem heartbeat do beacon
 * dali em diante. Agora: se QUALQUER match for de kind coordenador
 * (`COORDINATOR_KIND_PREFIXES`), prefere ele explicitamente sobre
 * `interactive` — nunca depende de ordenação lexicográfica de novo.
 */
export function findExistingSessionFile(sessionsDir, sessionId, fs = { existsSync, readdirSync }) {
  try {
    if (!fs.existsSync(sessionsDir)) return null;
    const suffix = `-${sessionId}.json`;
    const matches = fs
      .readdirSync(sessionsDir)
      .filter((n) => n.endsWith(suffix) && !n.startsWith(".") && !n.includes("-safeBackup-"));
    if (matches.length === 0) return null;
    const coordinatorMatches = matches
      .filter((n) => COORDINATOR_KIND_PREFIXES.some((k) => n.startsWith(`${k}-`)))
      .sort();
    if (coordinatorMatches.length > 0) return coordinatorMatches[0];
    return matches.sort()[0];
  } catch {
    return null;
  }
}

/**
 * Resolve, IMEDIATAMENTE ANTES do write (#6326 fleet review item 3), o path
 * onde o beacon vai gravar — reduz (nunca elimina) a janela de corrida entre
 * a resolução original de `path` (feita mais cedo nesta mesma invocação) e o
 * `writeJsonAtomic`: se `registerSession` promoveu e removeu o arquivo
 * resolvido nesse meio-tempo (a skill rodando `register` concorrente à
 * própria chamada de ferramenta que disparou este beacon), escrever cego no
 * `resolvedPath` recriaria exatamente o `interactive-*` que acabou de ser
 * removido.
 *
 * Se `resolvedPath` ainda existe, usa ele (caminho comum, sem custo extra —
 * só um `existsSync`). Se sumiu, re-resolve via `findExistingSessionFile`
 * (que agora já prefere kind coordenador, ver acima) — achando um registro
 * novo (o promovido), escreve nele; não achando nada, cai de volta no
 * `resolvedPath` original (comportamento anterior, cria o registro do zero).
 *
 * **Risco residual, deliberadamente não eliminado:** não há lock
 * cross-processo aqui (mesma limitação documentada pro merge lock em
 * `scripts/lib/session-registry.ts`, #6182) — entre este `existsSync` e o
 * `writeJsonAtomic` que o chama, o arquivo re-resolvido ainda pode, em
 * teoria, ser promovido/removido de novo por outra chamada concorrente. Isto
 * estreita a janela de corrida de "toda a duração de uma chamada de
 * ferramenta" pra "os poucos microssegundos entre um `existsSync` e um
 * write atômico" — não a fecha por completo. Nunca lança (mesma disciplina
 * fail-open do hook inteiro — qualquer erro aqui cai no catch externo do
 * entrypoint).
 */
export function resolveWritePathAtWriteTime(sessionsDir, sessionId, resolvedPath, fs = { existsSync, readdirSync }) {
  if (fs.existsSync(resolvedPath)) return resolvedPath;
  const reresolved = findExistingSessionFile(sessionsDir, sessionId, fs);
  return reresolved ? join(sessionsDir, reresolved) : resolvedPath;
}

/** Write atômico (write-then-rename), mesmo padrão de `writeFileAtomic` — ver #6130 item 4. */
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  renameSync(tmp, path);
}

// #2019-style CLI guard — só roda o corpo quando este arquivo é o entrypoint
// (nunca ao ser importado por test/session-beacon-hook.test.ts).
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (import.meta.url === `file://${_argv1}` || import.meta.url === `file:///${_argv1.replace(/^\//, "")}`) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(data || "{}");
      const sessionId = payload.session_id;
      if (!sessionId) return; // sem identidade não há beacon possível

      const hookDir = dirname(fileURLToPath(import.meta.url));
      const cwdRoot = join(hookDir, "..", "..");

      // #6303 review cruzado (P2): NÃO registrar subagente.
      //
      // A premissa está asserida no guard irmão
      // (`block-gh-pr-merge-subagent.mjs`) e ele DEPENDE dela: subagente
      // despachado via `Agent` roda com `session_id` PRÓPRIO, diferente do
      // coordenador. Sem este guard, o beacon criaria um registro
      // `interactive-*` para CADA subagente.
      //
      // A conta, medida e não estimada: `seed/sources.csv` tem 53 fontes, e
      // o Stage 1 de UMA edição despacha um `source-researcher` por fonte,
      // mais os `discovery-searcher`, mais 3 `writer-destaque`, mais os
      // sociais. São centenas de arquivos por dia num diretório que é
      // junction OneDrive já documentado como propenso a cópia de conflito
      // `-safeBackup-NNNN` (#5427/#6130) — e o GC que os reaparia
      // (`Diaria-Session-Registry-Gc`, #6130) está "DECLARADA — ainda NÃO
      // armada" em `docs/scheduled-tasks-registry.md`. O lixo não teria
      // quem recolhesse.
      //
      // Discriminador, sem custo: subagente implementador roda com
      // `isolation: "worktree"`, então o PRÓPRIO arquivo deste hook está
      // dentro de um worktree vinculado (`.git` é ARQUIVO com `gitdir:`, não
      // diretório). Coordenador e sessão interativa rodam no checkout
      // principal (`.git` é diretório). É a mesma leitura que
      // `resolveMainRepoRootNoSpawn` já faz — nenhum subprocesso a mais.
      //
      // Consequência aceita e declarada: uma sessão INTERATIVA que rode a
      // partir de um worktree também não emite beacon. É o lado seguro do
      // trade-off (deixar de registrar alguém é degradação de visibilidade;
      // registrar centenas de subagentes efêmeros é lixo ativo num diretório
      // sincronizado sem GC armado), e o `conflicts` dessa sessão continua
      // funcionando — ela só não aparece como peer para as outras.
      if (isLinkedWorktree(cwdRoot)) return;

      const mainRoot = resolveMainRepoRootNoSpawn(cwdRoot) ?? cwdRoot;
      const sessionsDir = join(mainRoot, "data", "sessions");
      // `data/` é junction do OneDrive e NÃO existe num clone fresco nem num
      // worktree — sem ela não há registro compartilhado pra alimentar.
      if (!existsSync(join(mainRoot, "data"))) return;

      const tag = machineTag();
      const existing = findExistingSessionFile(sessionsDir, sessionId);
      const path = existing
        ? join(sessionsDir, existing)
        : join(sessionsDir, `${BEACON_KIND}-${tag}-${sessionId}.json`);

      let previous = null;
      try {
        if (existsSync(path)) previous = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        previous = null; // ilegível/parcial — trata como novo, nunca lança
      }

      const record = buildBeaconRecord(previous, {
        kind: BEACON_KIND,
        machineTag: tag,
        sessionId,
        branch: readCurrentBranch(cwdRoot),
        newPaths: extractTouchedPaths(payload.tool_name, payload.tool_input, cwdRoot),
        verb: sniffVerb(payload.tool_input?.command),
        nowIso: new Date().toISOString(),
        // process.ppid — mesmo racional do #6160 (premissa: harness spawna
        // este hook como filho direto da sessão, então ppid seria o pid
        // dela). #6294 mediu essa premissa como FALSA pelo menos uma vez ao
        // vivo (ver docblock de inject-session-id.mjs e de decideSessionGc
        // em scripts/lib/session-registry.ts) — `pid` continua gravado
        // (não há fonte melhor disponível daqui), mas `decideSessionGc` não
        // trata mais "pid morto" como sinal de remoção por causa disso.
        pid: process.ppid,
      });
      if (record) {
        // #6326 fleet review item 3: re-resolve o path de escrita agora,
        // reduzindo (não eliminando — ver docstring de
        // `resolveWritePathAtWriteTime`) a janela de corrida com
        // `registerSession` promovendo este MESMO sessionId entre a
        // resolução original de `path` (acima) e este write.
        const writePath = resolveWritePathAtWriteTime(sessionsDir, sessionId, path);
        writeJsonAtomic(writePath, record);
      }
      // Nunca emitir saída: este hook não altera nem bloqueia a chamada.
    } catch {
      // Fail-open total — ver "CUSTO E FAIL-OPEN" no topo.
    }
  });
}
