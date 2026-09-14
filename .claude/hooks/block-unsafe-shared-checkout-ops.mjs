// PreToolUse hook — dois guards mecânicos distintos sobre `Bash`, empacotados
// juntos por decisão explícita de dispatch (#6982 + #6971, lote
// `guards-de-subagente`, 01/09/2026): "prefira UM hook coeso a dois hooks
// quase iguais, contanto que nenhuma das duas regras fique mais fraca".
// Nenhum dos dois guards compartilha lógica de detecção de comando — eles só
// compartilham arquivo/infra de teste. Ver o docblock de cada guard abaixo
// para a issue de origem e o raciocínio completo.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Utilitários compartilhados (parsing de comando) — duplicados de
// `block-branch-checkout-main.mjs` por decisão de "self-contained" já
// documentada nos hooks irmãos (nenhum import estático de `.ts`, quebra em
// Node sem type-stripping nativo).
// ---------------------------------------------------------------------------

/**
 * Remove o CONTEÚDO de spans entre aspas (simples ou duplas), preservando
 * tudo fora deles. Duplicado de `block-branch-checkout-main.mjs`.
 */
export function stripQuotedSpans(command) {
  let result = "";
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < n && command[j] !== "'") j++;
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

const SEPARATOR_RE = /(?:&&|;|\|\||\||\n)/;

/**
 * Remove o CORPO de heredocs (`<<EOF ... EOF`, `<<'EOF' ... EOF`,
 * `<<-EOF ... EOF`), preservando a linha de abertura (#7757, Modo 2).
 *
 * Sem isto, `commandSegments` divide por `\n` (`SEPARATOR_RE`) e trata cada
 * LINHA do corpo de um heredoc como um segmento de comando independente —
 * um `gh issue create --body-file x <<'EOF' ... rm -f /caminho ... EOF`
 * cujo corpo apenas DESCREVE um comando perigoso (documentação, issue body)
 * era detectado como se o comando estivesse sendo de fato invocado. Nenhum
 * arquivo seria apagado; o guard bloqueava mesmo assim.
 *
 * Escopo: casa `<<` ou `<<-`, seguido de um delimitador (com ou sem aspas
 * simples/duplas — a diferença dita só se o shell faz expansão dentro do
 * corpo, irrelevante aqui). Localiza a linha terminadora — `<<-` permite
 * indentação antes do delimitador, `<<` exige coluna 0. Sem terminador
 * encontrado (heredoc mal-formado, ou string truncada), o restante do
 * comando é descartado da varredura — mais seguro do que arriscar reincluir
 * um corpo de heredoc não fechado como se fosse comando real.
 */
export function stripHeredocSpans(command) {
  if (typeof command !== "string") return command;
  const startRe = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  let result = "";
  let lastIndex = 0;
  let m;
  while ((m = startRe.exec(command)) !== null) {
    if (m.index < lastIndex) continue; // dentro de um heredoc já removido
    const delim = m[2];
    const isDashVariant = m[0].startsWith("<<-");
    const markerEnd = m.index + m[0].length;
    const lineEnd = command.indexOf("\n", markerEnd);
    if (lineEnd === -1) {
      // Sem corpo nesta string (marcador na última linha) — nada a remover.
      result += command.slice(lastIndex);
      lastIndex = command.length;
      break;
    }
    const bodyStart = lineEnd + 1;
    const terminatorRe = new RegExp(`^${isDashVariant ? "[ \\t]*" : ""}${delim}[ \\t]*$`, "m");
    const termMatch = terminatorRe.exec(command.slice(bodyStart));
    const stripEnd = termMatch ? bodyStart + termMatch.index + termMatch[0].length : command.length;
    result += command.slice(lastIndex, lineEnd + 1);
    lastIndex = stripEnd;
    startRe.lastIndex = stripEnd;
  }
  result += command.slice(lastIndex);
  return result;
}

/** Divide `command` (sem heredocs nem aspas) em segmentos de comando REAL,
 * cada um já tokenizado por espaço. */
function commandSegments(command) {
  if (typeof command !== "string") return [];
  const stripped = stripQuotedSpans(stripHeredocSpans(command));
  return stripped
    .split(SEPARATOR_RE)
    .map((seg) => seg.trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
}

/**
 * Tokeniza um segmento de comando preservando o VALOR de tokens entre aspas
 * (diferente de `commandSegments`, que descarta o conteúdo citado via
 * `stripQuotedSpans` — suficiente pra detecção de comando, insuficiente pra
 * extrair o ARGUMENTO de um `cd`, ex: `cd "C:/Users/.../memory"`).
 */
function tokenizeSegmentPreservingQuotes(segment) {
  const tokens = [];
  let current = "";
  let inToken = false;
  let i = 0;
  const n = segment.length;
  while (i < n) {
    const ch = segment[i];
    if (ch === " " || ch === "\t") {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      inToken = true;
      while (i < n && segment[i] !== quote) {
        current += segment[i];
        i++;
      }
      i++; // fecha aspas (ou fim da string, se malformado)
      continue;
    }
    inToken = true;
    current += ch;
    i++;
  }
  if (inToken) tokens.push(current);
  return tokens;
}

/**
 * Divide `command` em segmentos preservando o VALOR entre aspas (usado só
 * pra rastrear `cd`, que precisa do argumento real — ver
 * `extractRmTargetsWithCwd`). Heredocs ainda são removidos primeiro (mesmo
 * motivo de `commandSegments`).
 */
// Limitação aceita: divide por SEPARATOR_RE ANTES de tokenizar (diferente de
// `commandSegments`, que usa `stripQuotedSpans` — remove o conteúdo citado
// antes de separar, então um `&&`/`;` dentro de aspas nunca quebra o
// segmento errado). Aqui precisamos do VALOR entre aspas (o argumento de
// `cd`), então não dá pra remover o conteúdo antes. Um separador LITERAL
// dentro de um path entre aspas (`cd "a && b"`) quebraria incorretamente —
// caso extremo, não observado em uso real, aceito pelo mesmo padrão de
// cobertura parcial documentada nos guards irmãos deste arquivo.
function commandSegmentsPreservingQuotes(command) {
  if (typeof command !== "string") return [];
  const withoutHeredoc = stripHeredocSpans(command);
  return withoutHeredoc
    .split(SEPARATOR_RE)
    .map((seg) => tokenizeSegmentPreservingQuotes(seg.trim()))
    .filter((tokens) => tokens.length > 0);
}

// ---------------------------------------------------------------------------
// Guard 1 — `taskkill /IM` (#6982)
//
// Incidente de origem: subagente da #6976 (01/09/2026) subiu um servidor
// HTTP local pra checagem visual e, ao limpar, rodou
// `taskkill /F /IM python.exe` — mata por NOME DE IMAGEM, não por PID: matou
// 9 processos `python.exe` alheios numa máquina compartilhada (o editor
// trabalha nela, há sessões paralelas do Claude Code e tarefas agendadas).
// A memória do projeto já documentava esse anti-padrão para `node.exe`
// (`context/overnight-dispatch-rules.md` item 12, #5432) — mas o subagente
// lidava com `python.exe` e não se reconheceu no padrão porque a prosa citava
// só o binário do incidente original, não a classe inteira. Subagente com
// `isolation: worktree` recebe o prompt da tarefa, não o inventário de
// memórias do editor — "o agente vai lembrar" é frágil por construção, a
// mesma conclusão que o #6864/#6941 já registraram para outras classes de
// instrução em prosa.
//
// Detecção: `taskkill` (comando real, primeiro token do segmento, aceita
// path completo tipo `C:\Windows\System32\taskkill.exe`) seguido de QUALQUER
// token que seja a flag `/IM`/`-IM`/`--IM`/`//IM` (case-insensitive, 1-2
// prefixos de `/` ou `-`, MSYS costuma duplicar a barra — ver o próprio
// incidente do #5432: `taskkill //F //IM node.exe //T`). `taskkill /PID N`
// (o uso CORRETO, mata por processo específico) nunca casa — não há token
// `/IM` na chamada.
export function isTaskkillByImageCommand(command) {
  for (const tokens of commandSegments(command)) {
    const cmdToken = tokens[0].toLowerCase();
    const isTaskkill = cmdToken === "taskkill" || /[\\/]taskkill(\.exe)?$/i.test(cmdToken);
    if (!isTaskkill) continue;
    const hasImFlag = tokens.slice(1).some((t) => /^[\/-]{1,2}im$/i.test(t));
    if (hasImFlag) return true;
  }
  return false;
}

export const TASKKILL_BLOCK_REASON =
  "taskkill /IM (mata por NOME DE IMAGEM) bloqueado pelo guard mecânico do overnight/develop (#6982): " +
  "isso encerra TODO processo com esse nome na máquina, incluindo os de outras sessões concorrentes " +
  "(overnight, develop, continuo, sessão interativa do editor, Studio server, tarefas agendadas) — nunca " +
  "só o seu. Guarde o PID do processo que VOCÊ mesmo iniciou (retorno de spawn/exec, ou `$!` no shell) e " +
  "mate só ele: `taskkill /F /PID {pid}` no Windows, `kill {pid}` no Unix. Nunca `/IM {nome}` (nem " +
  "variantes `-IM`/`--IM`/`//IM`) sem escopo ao PID/árvore do chamador. Ver " +
  "context/overnight-dispatch-rules.md item 12.";

// ---------------------------------------------------------------------------
// Shared: sujeira PRÓPRIA vs ALHEIA no checkout compartilhado (#8107)
//
// Guard 2 (`rm`, #6971) e Guard 3 (git destrutivo, #7730) bloqueavam,
// originalmente, só quando existia ≥1 rodada coordenadora
// (overnight/develop/continuo) ATIVA registrada em `data/sessions/*.json` —
// "cobertura HONESTA" documentada explicitamente no docblock anterior desta
// seção ("só protege enquanto uma rodada coordenadora está registrada").
//
// Incidente de origem da mudança (#8107, 13-14/09/2026): uma sessão rodou
// `git reset --hard origin/fix/8100-...` no checkout PRINCIPAL compartilhado
// depois que a coordenadora `/diaria-develop` mais recente já tinha encerrado
// seu registro (`session-registry.ts end`) — `coordinators.size === 0` no
// instante da chamada, então o guard antigo saía por `return false` por
// desenho, não por bug. O comando destruiu 8 arquivos NÃO-commitados de uma
// sessão concorrente, sem stash/commit/cópia em lugar nenhum — perda
// permanente (diferente do #7730, onde o dano real apurado foi zero por
// sorte). Decisão do editor (comentário da issue): estender a proteção pra
// valer SEMPRE, não só durante rodadas automatizadas.
//
// Modelo novo — os dois guards reusam o MESMO discriminador que
// `session-registry.ts` (`evaluateEndGuard`) já usa com sucesso pra separar
// sujeira própria de alheia: interseção entre `git status --porcelain` e os
// `touched_paths`/`dirty_paths` do registro da sessão CHAMADORA
// (`data/sessions/*-{session_id}.json`, QUALQUER `kind` — não só
// coordenadora; `session-beacon.mjs` já popula esses campos automaticamente
// pra toda sessão, incluindo `interactive`, a cada `Edit`/`Write`/
// `NotebookEdit`). Pergunta que os dois guards fazem agora: "existe sujeira
// ALHEIA (não atribuível à sessão chamadora) que o comando destrutivo
// atingiria?" — independente de haver coordenadora registrada.
//
// Reusa os mesmos PRIMITIVOS de overlap que `evaluateEndGuard` usa
// (`normalizeBeaconPath`/`beaconPathsOverlap`/`extractPorcelainPath`), mas
// com a POLÍTICA invertida de propósito — os dois servem propósitos
// diferentes: `evaluateEndGuard` erra pro lado de deixar a sessão terminar
// (fail-OPEN) quando a atribuição de sujeira é incerta ("vazio/ausente →
// sempre avisa, nunca recusa" — ver docstring de `evaluateEndGuard`, "session
// sem beacon de paths"); estes guards erram pro lado de BLOQUEAR o comando
// destrutivo (fail-CLOSED) no mesmo caso. Faz sentido — terminar uma sessão
// com sujeira não-atribuída é reversível (a sessão pode ser retomada depois);
// deixar um `rm`/`reset --hard` rodar sobre sujeira não-atribuída não é
// (working tree não tem reflog).
//
// Fail-direction destes DOIS guards (nunca invertida entre si):
//
//   - `session_id` ausente/vazio, sem registro em `data/sessions/`, ou
//     registro sem `touched_paths`/`dirty_paths` → `ownPaths = []` → TODA
//     sujeira do checkout conta como alheia → **bloqueia** (fail-CLOSED —
//     mais conservador, protege por padrão quando não sabemos o que é
//     nosso). Cobre o caso do incidente de origem: um subagente ad-hoc, ou
//     qualquer chamada sem beacon de paths, nunca ganha um passe livre só
//     por não ter se declarado.
//   - `git status --porcelain` falha ou estoura o timeout (`readGitPorcelainPaths`,
//     4s) → **fail-OPEN** (`foreignDirtyPaths === null`, os dois guards
//     devolvem `false`) — mesmo princípio de todo o resto do arquivo: um
//     soluço de I/O do OneDrive/rede nunca pode travar Bash legítimo.
//   - Árvore limpa, ou toda sujeira é da própria sessão chamadora →
//     `foreignDirtyPaths.length === 0` → nunca bloqueia (o comando só
//     arrisca o próprio trabalho do chamador, decisão dele).
//
// Limitação aceita, documentada em vez de escondida: `touched_paths`/
// `dirty_paths` só rastreiam caminhos tocados via `Edit`/`Write`/
// `NotebookEdit` (ver `session-beacon.mjs`) — um arquivo criado por Bash puro
// (`echo x > f.md`) nunca entra no beacon da própria sessão, então um `rm`
// subsequente nele (mesmo sendo genuinamente próprio) é tratado como sujeira
// alheia e bloqueado. Mesma classe de cobertura parcial, honesta, que o
// docblock anterior já aplicava a outra dimensão do problema.

/** Duplicado de `session-registry.ts` (`normalizeBeaconPath`). */
export function normalizeBeaconPath(path) {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/**
 * `true` quando dois caminhos se sobrepõem — iguais, ou um é prefixo de
 * DIRETÓRIO do outro. Duplicado de `session-registry.ts` (`beaconPathsOverlap`).
 */
export function beaconPathsOverlap(a, b) {
  const x = normalizeBeaconPath(a);
  const y = normalizeBeaconPath(b);
  if (x === "" || y === "") return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/**
 * Extrai o caminho de uma linha de `git status --porcelain` (formato
 * `XY caminho`, ou `XY orig -> novo` pra renames/cópias — usa o lado NOVO).
 * Duplicado de `session-registry.ts` (`extractPorcelainPath`), com um fix
 * que a cópia original AINDA NÃO TEM (#8107, self-review — achado do
 * `silent-failure-hunter`): o split por `" -> "` só é aplicado quando o
 * STATUS (2 primeiros chars da linha) é de fato rename/copy (`R`/`C` em
 * qualquer posição). Sem essa checagem, um arquivo `??`/`M` cujo NOME real
 * contenha a substring literal `" -> "` (ex: `plan -> v2.md`, nome plausível
 * de rascunho) seria cortado incorretamente pro que vem depois da seta —
 * `readGitPorcelainPaths` devolveria `"v2.md"` (arquivo que não existe) em
 * vez do caminho real, e um `rm "plan -> v2.md"` que deveria bater contra
 * essa sujeira alheia nunca casaria (`beaconPathsOverlap` compara o path
 * ERRADO) — silenciosamente permitindo o comando destrutivo que o guard
 * existe pra bloquear. Callers de `session-registry.ts` (`evaluateEndGuard`)
 * têm o mesmo bug, mas lá o pior caso é só um WARNING em vez de bloqueio —
 * aqui a consequência é bloqueio destrutivo passando sem aviso, por isso o
 * fix entrou aqui primeiro (issue de acompanhamento pro lado
 * `session-registry.ts`, mesmo bug, consequência mais branda).
 */
export function extractPorcelainPath(line) {
  const status = line.slice(0, 2);
  const body = line.slice(3); // remove "XY " (2 chars de status + 1 espaço)
  const isRenameOrCopy = status.includes("R") || status.includes("C");
  if (!isRenameOrCopy) return body;
  const arrowIdx = body.indexOf(" -> ");
  return arrowIdx === -1 ? body : body.slice(arrowIdx + 4);
}

/**
 * `git status --porcelain` em `repoRoot`, com timeout CURTO (#8107 — este
 * hook roda em TODO `Bash` de TODA sessão; o subprocesso síncrono só é pago
 * quando um comando potencialmente destrutivo já foi detectado por
 * `isRmCommand`/`detectDestructiveGitTarget`, nunca em toda invocação de
 * Bash). Devolve os caminhos JÁ normalizados (formato `git status`, relativo
 * a `repoRoot`), ou `null` se o comando falhar/estourar o timeout —
 * fail-OPEN, nunca travar Bash legítimo por soluço de I/O.
 *
 * `maxBuffer` explícito e generoso (20 MiB, contra o default de 1 MiB do
 * `execFileSync`) — achado do `silent-failure-hunter` (#8107 self-review):
 * sem isso, o guard tende a falhar-abrir justo quando há MAIS sujeira pra
 * proteger (checkout com muitos arquivos dirty/untracked produz saída maior,
 * mais perto de estourar o buffer padrão) — o pior momento possível pra um
 * guard de segurança degradar em silêncio.
 */
export function readGitPorcelainPaths(repoRoot, timeoutMs = 4000) {
  try {
    const res = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      // windowsHide: true (#7952) — este hook roda em toda sessão, inclusive
      // Windows; sem isso, `git` pode alocar uma janela de console própria.
      windowsHide: true,
    });
    return res
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .map((line) => normalizeBeaconPath(extractPorcelainPath(line)))
      .filter((p) => p !== "");
  } catch (err) {
    // Fail-OPEN, mas não em silêncio total (achado do `silent-failure-hunter`
    // #8107 self-review) — sem isto, o guard podia ficar desarmado por N
    // chamadas (git ausente do PATH, buffer estourado, timeout persistente)
    // sem NENHUM sinal operacional, até o próximo incidente. Best-effort,
    // nunca lança, nunca vai pro stdout (que carrega o contrato JSON do
    // hook) — só stderr, puramente diagnóstico.
    try {
      process.stderr.write(
        `block-unsafe-shared-checkout-ops: git status --porcelain falhou em ${repoRoot} — guard de rm/git ` +
          `destrutivo fail-open pra esta chamada (${err?.code ?? err?.message ?? "erro desconhecido"}).\n`,
      );
    } catch {
      // stderr indisponível: sem sorte, mas nunca lança por causa disso.
    }
    return null;
  }
}

/**
 * Localiza o arquivo de registro (`data/sessions/*.json`) que casa
 * `sessionId`, QUALQUER `kind` (#8107 — diferente do modelo anterior, que só
 * olhava kinds coordenadores). Casa pelo SUFIXO `-{sessionId}.json`, mesma
 * técnica de `findExistingSessionFileAnyKind` em `session-registry.ts` — a
 * ambiguidade posicional documentada lá (tag/sessionId podem conter `-`) é
 * irrelevante aqui porque não precisamos separar os dois, só casar o sufixo
 * inteiro. Exclui backups `-safeBackup-` e dotfiles (`.merge-lock.json`).
 */
function findOwnSessionFile(repoRoot, sessionId) {
  const dir = sessionsDir(repoRoot);
  const suffix = `-${sessionId}.json`;
  let entries;
  try {
    if (!existsSync(dir)) return null;
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const names = entries
    .filter((n) => n.endsWith(suffix) && !n.startsWith(".") && !n.includes("-safeBackup-"))
    .sort();
  return names.length > 0 ? join(dir, names[0]) : null;
}

/**
 * `touched_paths` ∪ `dirty_paths` do registro da PRÓPRIA sessão chamadora
 * (#8107). `session_id` ausente/vazio, sem registro correspondente em
 * `data/sessions/`, ou registro sem esses campos → `[]` — fail-CLOSED: sem
 * essa lista, o guard não tem como saber o que é seu, então trata tudo como
 * alheio (ver docblock da seção acima). Nunca lança — JSON malformado (uma
 * escrita concorrente truncada, corrupção do OneDrive) cai no mesmo `[]`.
 */
export function readOwnSessionPaths(repoRoot, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return [];
  const filePath = findOwnSessionFile(repoRoot, sessionId);
  if (!filePath) return [];
  try {
    const record = JSON.parse(readFileSync(filePath, "utf8"));
    if (!record || typeof record !== "object") return [];
    const touched = Array.isArray(record.touched_paths) ? record.touched_paths : [];
    const dirty = Array.isArray(record.dirty_paths) ? record.dirty_paths : [];
    return [...new Set([...touched, ...dirty].map(normalizeBeaconPath))].filter((p) => p !== "");
  } catch {
    return [];
  }
}

/**
 * Sujeira do `git status --porcelain` que NÃO é atribuível à sessão
 * chamadora — o alvo real que os dois guards protegem (#8107). `null`
 * propaga o fail-open de `readGitPorcelainPaths` (git status indisponível).
 */
export function computeForeignDirtyPaths(porcelainPaths, ownPaths) {
  if (porcelainPaths === null) return null;
  const normalizedOwn = [...new Set((ownPaths ?? []).map(normalizeBeaconPath))].filter((p) => p !== "");
  return porcelainPaths.filter((p) => !normalizedOwn.some((op) => beaconPathsOverlap(op, p)));
}

/**
 * Resolve `targetPath` pra um caminho RELATIVO a `checkoutRoot` (mesmo
 * formato de `git status --porcelain`), pra comparar contra
 * `foreignDirtyPaths`. `null` quando o alvo resolve pra FORA do checkout
 * (nunca é problema destes guards — outro guard, ou nenhum, cobre isso).
 * `"."` quando o alvo É o próprio diretório-base resolvido (cobre tudo
 * abaixo dele — usado tanto por um `rm .`/`git checkout -- .` quanto pelo
 * `cwd` efetivo depois de um `cd` pra dentro do checkout).
 */
function relativeToCheckout(targetPath, checkoutRoot, effectiveCwd) {
  try {
    if (typeof targetPath !== "string" || targetPath === "") return null;
    const baseCwd = effectiveCwd ?? checkoutRoot;
    const resolved = isAbsolute(targetPath) ? resolvePath(targetPath) : resolvePath(baseCwd, targetPath);
    const rootResolved = resolvePath(checkoutRoot);
    if (resolved === rootResolved) return ".";
    if (!resolved.startsWith(rootResolved + sep)) return null;
    return resolved.slice(rootResolved.length + 1).split(sep).join("/");
  } catch {
    return null;
  }
}

/**
 * `true` quando o caminho-alvo (já relativizado por `relativeToCheckout`)
 * atinge alguma sujeira alheia — `"."` (alvo é o diretório inteiro) atinge
 * QUALQUER sujeira alheia existente; um caminho específico só atinge sujeira
 * que sobrepõe ele (`beaconPathsOverlap`).
 */
function targetHitsForeignDirt(relTarget, foreignDirtyPaths) {
  if (relTarget === null) return false;
  if (relTarget === ".") return foreignDirtyPaths.length > 0;
  return foreignDirtyPaths.some((fd) => beaconPathsOverlap(relTarget, fd));
}

// ---------------------------------------------------------------------------
// Guard 2 — `rm` em caminho dentro do checkout PRINCIPAL compartilhado,
// atingindo sujeira ALHEIA (#6971, generalizado pelo #8107 — ver seção
// "Shared" acima)
//
// Incidente de origem: frota de review da PR #6969 (01/09/2026) — um agente
// despachado com instrução EXPLÍCITA de somente-leitura ("No file edits, no
// git checkout/switch/stash/reset/add/commit") rodou
// `rm -f /home/vjpixel/diaria-studio/.pr6950-review.md` como "limpeza". O
// arquivo era UNTRACKED — nada em git pra restaurar; recuperado só por sorte
// (cópia solta em /tmp). A #6971 concluiu, na mesma linha do #6864/#6941,
// que "instrução em prosa não é guard" e pediu restringir MECANICAMENTE.
//
// Restringir as FERRAMENTAS do agente de review na origem (a direção
// preferida pela #6971) segue não sendo implementável a partir deste repo —
// `pr-review-toolkit:code-reviewer` e os demais da frota são definidos pelo
// PLUGIN do marketplace, com `Tools: "All tools"` fixo; não há parâmetro na
// ferramenta `Agent` pra sobrescrever isso num `subagent_type` já registrado.
// O que este guard cobre é a mitigação mecânica que INDEPENDE de identificar
// "isto é um subagente de review" — protege qualquer chamada, de qualquer
// sessão/subagente, que atingiria sujeira alheia no checkout compartilhado.
//
// #7055 (fail-closed, 02/09/2026, preservado pelo #8107): `session_id`
// ausente/vazio na chamada nunca ganha passe livre — sem ele, `readOwnSessionPaths`
// devolve `[]`, então toda sujeira do checkout conta como alheia.

/**
 * `true` se `command` contém um `rm` real (segmento de comando, não citado
 * dentro de aspas) como primeiro token do segmento.
 */
export function isRmCommand(command) {
  return commandSegments(command).some((tokens) => {
    const cmdToken = tokens[0].toLowerCase();
    return cmdToken === "rm" || /[\\/]rm$/i.test(cmdToken);
  });
}

/**
 * Extrai os argumentos de PATH (tokens que não começam com `-`) de toda
 * invocação `rm` encontrada em `command`. Não resolve/normaliza — devolve os
 * tokens crus, na ordem em que aparecem.
 */
export function extractRmTargetPaths(command) {
  const paths = [];
  for (const tokens of commandSegments(command)) {
    const cmdToken = tokens[0].toLowerCase();
    const isRm = cmdToken === "rm" || /[\\/]rm$/i.test(cmdToken);
    if (!isRm) continue;
    for (const t of tokens.slice(1)) {
      if (t.startsWith("-")) continue; // flag: -f, -rf, --force, etc.
      paths.push(t);
    }
  }
  return paths;
}

/**
 * Igual a `extractRmTargetPaths`, mas devolve `{ path, cwd }` — o `cwd`
 * EFETIVO de cada invocação `rm`, rastreado simulando `cd` ao longo dos
 * segmentos do comando (#7757, Modo 1). Sem isto, um `cd <dir fora do
 * checkout> && rm <relativo>` resolvia o `<relativo>` contra `initialCwd`
 * (a raiz do checkout, premissa fixa dos hooks irmãos) em vez do diretório
 * pra onde o `cd` de fato mudou — falso-positivo medido ao vivo: comando
 * rodando fora do checkout, acusado de mirar "dentro do checkout principal
 * compartilhado".
 *
 * `cd <path>` relativo resolve contra o `cwd` corrente (encadeamento de
 * `cd`s); `cd <path>` absoluto substitui o `cwd` por completo. Só o PRIMEIRO
 * argumento não-flag de cada segmento `cd` é considerado.
 */
export function extractRmTargetsWithCwd(command, initialCwd) {
  const results = [];
  let cwd = initialCwd;
  for (const tokens of commandSegmentsPreservingQuotes(command)) {
    const cmdToken = (tokens[0] ?? "").toLowerCase();
    if (cmdToken === "cd") {
      const target = tokens.slice(1).find((t) => !t.startsWith("-"));
      if (target) {
        try {
          cwd = isAbsolute(target) ? resolvePath(target) : resolvePath(cwd, target);
        } catch {
          // cwd inválido: mantém o anterior, fail-safe (não perde rastro).
        }
      }
      continue;
    }
    const isRm = cmdToken === "rm" || /[\\/]rm$/i.test(cmdToken);
    if (!isRm) continue;
    for (const t of tokens.slice(1)) {
      if (t.startsWith("-")) continue;
      results.push({ path: t, cwd });
    }
  }
  return results;
}

/**
 * `true` quando `targetPath` (token cru de um argumento `rm`) resolve para
 * DENTRO de `checkoutRoot`. Caminho relativo é resolvido contra
 * `effectiveCwd` quando informado (#7757 — o `cwd` real no momento da
 * invocação, rastreado por `extractRmTargetsWithCwd`), senão contra
 * `checkoutRoot` (comportamento anterior, preservado por compatibilidade —
 * mesma suposição de "cwd ≈ raiz do checkout" já feita pelos hooks irmãos,
 * que também não recebem `cwd` no payload). Nunca lança.
 */
export function isPathInsideCheckout(targetPath, checkoutRoot, effectiveCwd) {
  try {
    if (typeof targetPath !== "string" || targetPath === "") return false;
    const baseCwd = effectiveCwd ?? checkoutRoot;
    const resolved = isAbsolute(targetPath) ? resolvePath(targetPath) : resolvePath(baseCwd, targetPath);
    const rootResolved = resolvePath(checkoutRoot);
    if (resolved === rootResolved) return true;
    return resolved.startsWith(rootResolved + sep);
  } catch {
    return false;
  }
}

/** `statSync(...).isDirectory()` que nunca lança. Duplicado dos hooks irmãos. */
function statIsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Duplicado de `block-branch-checkout-main.mjs` (`isLinkedWorktree`). */
export function isLinkedWorktree(startDir) {
  try {
    const gitPath = join(startDir, ".git");
    if (!existsSync(gitPath)) return false;
    return !statIsDirectory(gitPath);
  } catch {
    return false;
  }
}

export function sessionsDir(repoRoot) {
  return join(repoRoot, "data", "sessions");
}

/**
 * Função pura — decide se um `rm` visando `targetPaths` deve ser bloqueado,
 * dado `checkoutRoot`, se ele É um worktree vinculado, e a sujeira ALHEIA
 * já calculada (`foreignDirtyPaths`, ver `computeForeignDirtyPaths` na seção
 * "Shared" acima — #8107, substitui o modelo por coordenadora ativa).
 *
 * Bloqueia quando: (a) `checkoutRoot` é o checkout PRINCIPAL (não um
 * worktree — subagentes implementadores rodam em worktree próprio, nunca
 * bloqueado aqui); (b) `foreignDirtyPaths` não é `null` (git status
 * disponível — `null` propaga fail-open) nem vazio (há sujeira alheia real);
 * (c) ≥1 `targetPath` resolve pra um caminho DENTRO do checkout que atinge
 * essa sujeira alheia (`targetHitsForeignDirt`).
 *
 * **#7757 — `targetPaths` aceita entradas mistas.** Cada entrada é uma
 * `string` (resolvida contra `checkoutRoot`) OU um objeto `{ path, cwd }`
 * (resolvida contra o `cwd` EFETIVO daquela invocação — ver
 * `extractRmTargetsWithCwd`, que corrige o falso-positivo "path relativo
 * resolvido contra o project root em vez do `cwd` real após um `cd`").
 */
export function shouldBlockSharedCheckoutRm({ targetPaths, checkoutRoot, isWorktree, foreignDirtyPaths }) {
  if (isWorktree) return false; // worktree de subagente: rm no próprio worktree é normal
  if (foreignDirtyPaths === null) return false; // git status indisponível: fail-open
  if (foreignDirtyPaths.length === 0) return false; // nada alheio pra proteger
  const paths = targetPaths ?? [];
  return paths.some((p) => {
    const targetPath = typeof p === "string" ? p : p.path;
    const cwd = typeof p === "string" ? undefined : p.cwd;
    return targetHitsForeignDirt(relativeToCheckout(targetPath, checkoutRoot, cwd), foreignDirtyPaths);
  });
}

export const RM_BLOCK_REASON =
  "rm em caminho dentro do checkout PRINCIPAL compartilhado bloqueado pelo guard mecânico (#6971, " +
  "generalizado pelo #8107): o alvo atinge sujeira NÃO-commitada de OUTRA sessão (git status --porcelain " +
  "que não bate com touched_paths/dirty_paths do SEU registro em data/sessions/*.json). O checkout é " +
  "compartilhado por várias sessões concorrentes; arquivo untracked apagado ali não tem desfazer (não há " +
  "`git checkout --` que salve). Se você é subagente implementador: seu trabalho roda no PRÓPRIO worktree " +
  "(isolation: \"worktree\"), rode o rm ali, não no checkout principal. Se você é um agente de REVIEW: " +
  "você não tem razão legítima pra apagar nada — se o arquivo era um rascunho seu, deixe-o, ou escreva " +
  "rascunhos fora da árvore (/tmp, scratchpad) da próxima vez. Se o alvo é seu (touched_paths/dirty_paths " +
  "do seu próprio registro cobre esse arquivo), o guard já teria deixado passar — se você acha que este " +
  "bloqueio é falso-positivo, confira se sua sessão está registrada (`npx tsx " +
  "scripts/lib/session-registry.ts register --kind {overnight|develop|continuo|interactive}`) e se o " +
  "arquivo foi tocado via Edit/Write (rm em arquivo criado só por Bash puro nunca entra no seu beacon — " +
  "limitação conhecida, ver docblock da seção 'Shared' no início deste hook). Evite `rm` em caminho do " +
  "checkout compartilhado por padrão, mesmo quando o guard deixa passar.";

// ---------------------------------------------------------------------------
// Guard 3 — comandos git DESTRUTIVOS de working tree no checkout PRINCIPAL
// compartilhado, atingindo sujeira ALHEIA — mesmo discriminador do Guard 2
// (#7730, generalizado pelo #8107)
//
// Incidente de origem (09/09/2026): um agente `pr-review-toolkit:code-reviewer`
// despachado pra revisar a PR #7721, no checkout PRINCIPAL compartilhado, rodou
// `git checkout origin/master -- .` pra comparar `wrangler.toml` entre
// branches — reverteu TODO o working tree, não só o arquivo que ele queria
// comparar, apesar de instrução explícita de "somente leitura". O guard do
// #6971 (Guard 2 acima) já cobre `rm`; este cobre a MESMA classe de dano
// (descarte de trabalho não-commitado num checkout compartilhado, sem
// desfazer possível — working tree não tem reflog) pelos comandos git que
// fazem o equivalente: `git checkout <ref> -- <path>`/`git checkout --
// <path>`, `git restore`, `git clean -f`/`-fd`/`-fdx`, `git reset --hard`,
// `git stash`.
//
// 2ª ocorrência (#8107, 13-14/09/2026): `git reset --hard origin/...` rodado
// no checkout compartilhado depois que a única coordenadora registrada já
// tinha encerrado seu tick — destruiu 8 arquivos não-commitados de outra
// sessão. O modelo por "coordenadora ativa" nunca cobria esse caso por
// desenho; ver seção "Shared" no início deste arquivo pro modelo novo.
//
// Deliberadamente FORA do escopo: `git checkout <branch>` (troca de branch
// sem `--`/path — território de `block-branch-checkout-main.mjs`) e
// `git checkout`/`git switch` sem argumento que descarte arquivo.
//
// Mesmas condições do Guard 2: bloqueia só quando (a) não é worktree
// vinculado, (b) `foreignDirtyPaths` não é `null` (git status disponível) e
// não é vazio (há sujeira alheia real na árvore), e (c) o alvo do comando
// (path específico pra checkout/restore; o working tree INTEIRO pra
// clean/reset --hard/stash, que não recebem path) atinge essa sujeira.

export const GIT_DESTRUCTIVE_COMMANDS = ["checkout", "restore", "clean", "reset", "stash"];

/**
 * `git checkout <ref> -- <path...>` ou `git checkout -- <path...>` — só casa
 * quando há um token `--` literal no segmento (descarta arquivo). `git
 * checkout <branch>` (sem `--`) NÃO casa — é troca de branch, coberta em
 * outro hook. Devolve os paths depois do `--`, ou `null` se o segmento não
 * for um checkout com `--`.
 *
 * **Exceção fix iteration 1 do #7767 (lockout real, não hipotético):**
 * `scripts/lib/git-sync.ts` — que roda no Stage 0 de TODA edição — instrui
 * literalmente `git checkout HEAD -- <arquivo>` como o remédio documentado
 * pro estado absorvente `preexisting_unmerged_state` (índice com caminhos
 * UU/AA de uma stash pop conflitante de rodada anterior). Bloquear esse
 * comando incondicionalmente (#8107 — o guard agora roda SEMPRE, não só com
 * coordenadora ativa) deixaria o fluxo de edição sem caminho de recuperação.
 * `HEAD` como ref explícito (não `origin/master`,
 * não qualquer outro ref — o caso do incidente que originou o #7730) é
 * exempto: descarta o lado LOCAL de um path específico em favor do último
 * commit já mergeado, blast radius bem mais estreito que
 * `git checkout origin/master -- .` (árvore inteira, ref arbitrário
 * potencialmente divergente).
 */
function extractGitCheckoutDashDashPaths(tokens) {
  if (tokens[0]?.toLowerCase() !== "git" || tokens[1]?.toLowerCase() !== "checkout") return null;
  const dashIdx = tokens.indexOf("--");
  if (dashIdx === -1) return null;
  const refToken = dashIdx > 2 ? tokens[dashIdx - 1] : undefined;
  if (refToken?.toUpperCase() === "HEAD") return null; // exceção documentada acima
  return tokens.slice(dashIdx + 1);
}

/**
 * `git checkout -f`/`--force` (com ou sem `--`) — descarta modificações
 * locais mesmo quando git normalmente recusaria (troca de branch com
 * arquivo modificado que conflitaria). Achado do fix iteration 1 do #7767:
 * o falso-negativo original só olhava `--`, então `git checkout -f
 * <branch>` (força a troca por cima de mudanças locais, tão destrutivo
 * quanto `reset --hard`) passava batido.
 */
function isGitCheckoutForce(tokens) {
  if (tokens[0]?.toLowerCase() !== "git" || tokens[1]?.toLowerCase() !== "checkout") return false;
  return tokens.slice(2).some((t) => t === "-f" || t === "--force");
}

/**
 * `git checkout .` (SEM `--` explícito) — idioma comum pra "descartar tudo
 * que mudou no cwd". Não há ambiguidade real (nenhuma branch se chama
 * literalmente `.`), então git resolve isso como pathspec mesmo sem `--`.
 * Achado do fix iteration 1 do #7767 (mesmo tipo de falso-negativo do
 * `-f` acima — `detectDestructiveGitTarget` só casava com `--` literal).
 */
function isGitCheckoutBareDot(tokens) {
  if (tokens[0]?.toLowerCase() !== "git" || tokens[1]?.toLowerCase() !== "checkout") return false;
  const nonFlags = tokens.slice(2).filter((t) => !t.startsWith("-"));
  return nonFlags.length === 1 && nonFlags[0] === ".";
}

/** `git restore <path...>` — sempre destrutivo (equivalente moderno do checkout -- path). */
function extractGitRestorePaths(tokens) {
  if (tokens[0]?.toLowerCase() !== "git" || tokens[1]?.toLowerCase() !== "restore") return null;
  return tokens.slice(2).filter((t) => !t.startsWith("-"));
}

/** `git clean` com flag de força (`-f`, `-fd`, `-fdx`, `-dfx`, `--force`, ...). */
function isGitCleanForce(tokens) {
  if (tokens[0]?.toLowerCase() !== "git" || tokens[1]?.toLowerCase() !== "clean") return false;
  return tokens.slice(2).some((t) => t === "--force" || /^-[a-z]*f[a-z]*$/i.test(t));
}

/** `git reset --hard [ref]`. */
function isGitResetHard(tokens) {
  if (tokens[0]?.toLowerCase() !== "git" || tokens[1]?.toLowerCase() !== "reset") return false;
  return tokens.slice(2).some((t) => t === "--hard");
}

/**
 * `git stash` mutante — bare (== `push`), `push`, `save` (sintaxe antiga,
 * mesmo efeito de `push`), `pop`, `apply`, `drop`, `clear`. `list`/`show`
 * são leitura pura, `create`/`store` não tocam a working tree (`create`
 * só devolve um objeto de commit; `store` só grava uma ref já existente) —
 * nenhum dos 4 casa, de propósito.
 */
function isGitStashMutating(tokens) {
  if (tokens[0]?.toLowerCase() !== "git" || tokens[1]?.toLowerCase() !== "stash") return false;
  const sub = tokens[2]?.toLowerCase();
  if (sub === undefined) return true; // `git stash` bare == `git stash push`
  if (sub.startsWith("-")) return true; // ex: `git stash -u` (flag do push implícito)
  return ["push", "save", "pop", "apply", "drop", "clear"].includes(sub);
}

/**
 * Varre `command` por qualquer comando git destrutivo (#7730). Devolve
 * `{ wholeTree: boolean, paths: string[] }` do PRIMEIRO segmento que casar,
 * ou `null` se nenhum casar. `wholeTree: true` (clean/reset --hard/stash) —
 * sem path próprio, o alvo é a working tree inteira do cwd corrente.
 * `wholeTree: false` (checkout --/restore) — `paths` traz os alvos
 * explícitos.
 */
export function detectDestructiveGitTarget(command) {
  for (const tokens of commandSegments(command)) {
    const checkoutPaths = extractGitCheckoutDashDashPaths(tokens);
    if (checkoutPaths !== null) return { wholeTree: false, paths: checkoutPaths };
    if (isGitCheckoutForce(tokens)) return { wholeTree: true, paths: [] };
    if (isGitCheckoutBareDot(tokens)) return { wholeTree: true, paths: [] };
    const restorePaths = extractGitRestorePaths(tokens);
    if (restorePaths !== null) return { wholeTree: false, paths: restorePaths };
    if (isGitCleanForce(tokens)) return { wholeTree: true, paths: [] };
    if (isGitResetHard(tokens)) return { wholeTree: true, paths: [] };
    if (isGitStashMutating(tokens)) return { wholeTree: true, paths: [] };
  }
  return null;
}

/**
 * Função pura — mesma decisão de `shouldBlockSharedCheckoutRm`, generalizada
 * pro alvo de um comando git destrutivo (`detectDestructiveGitTarget`), com
 * a sujeira ALHEIA já calculada (`foreignDirtyPaths`, #8107 — substitui o
 * modelo por coordenadora ativa). `wholeTree: true` (clean/reset --hard/
 * stash) atinge QUALQUER sujeira alheia existente, incondicionalmente — o
 * comando roda no cwd corrente, que (na ausência de payload de `cwd`, mesma
 * premissa dos guards irmãos) é o checkoutRoot inteiro.
 */
export function shouldBlockSharedCheckoutGitDestructive({ target, checkoutRoot, isWorktree, foreignDirtyPaths }) {
  if (!target) return false;
  if (isWorktree) return false;
  if (foreignDirtyPaths === null) return false; // git status indisponível: fail-open
  if (foreignDirtyPaths.length === 0) return false; // nada alheio pra proteger
  if (target.wholeTree) return true; // já sabemos que há sujeira alheia em algum lugar da árvore
  return target.paths.some((p) => targetHitsForeignDirt(relativeToCheckout(p, checkoutRoot), foreignDirtyPaths));
}

export const GIT_DESTRUCTIVE_BLOCK_REASON =
  "Comando git DESTRUTIVO de working tree (`git checkout <ref> -- <path>`, `git restore`, `git clean -f`, " +
  "`git reset --hard`, ou `git stash`) bloqueado pelo guard mecânico (#7730, generalizado pelo #8107) — o " +
  "alvo atinge sujeira NÃO-commitada de OUTRA sessão (git status --porcelain que não bate com " +
  "touched_paths/dirty_paths do SEU registro em data/sessions/*.json). O checkout é compartilhado por " +
  "várias sessões concorrentes; working tree não tem reflog — o que este comando descartaria não tem " +
  "desfazer. Se você é subagente implementador ou de review: não rode comandos git destrutivos no " +
  "checkout PRINCIPAL compartilhado — seu trabalho roda no PRÓPRIO worktree (isolation: \"worktree\"); se " +
  "precisa só COMPARAR conteúdo entre branches, use `git show <ref>:<path>` ou `git diff <ref> -- <path>` " +
  "(nunca escrevem no working tree). Se o alvo é seu (touched_paths/dirty_paths do seu próprio registro " +
  "cobre esse arquivo), o guard já teria deixado passar — confira se sua sessão está registrada e se o " +
  "arquivo foi tocado via Edit/Write (ver docblock da seção 'Shared' no início deste hook pra limitações " +
  "conhecidas). Evite comandos git destrutivos no checkout compartilhado por padrão, mesmo quando o guard " +
  "deixa passar.";

// ---------------------------------------------------------------------------
// Entry point CLI
// ---------------------------------------------------------------------------

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(data || "{}");
      if (payload.tool_name && payload.tool_name !== "Bash") return;
      const command = payload.tool_input?.command;
      if (typeof command !== "string") return;

      // Guard 1: taskkill /IM — universal, independe de rodada ativa.
      if (isTaskkillByImageCommand(command)) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: TASKKILL_BLOCK_REASON,
            },
          }),
        );
        return;
      }

      // Guards 2/3 (#8107): rm ou git destrutivo no checkout principal
      // compartilhado, atingindo sujeira ALHEIA. `git status --porcelain`
      // (custo real, síncrono) só roda quando um dos dois padrões já casou —
      // nunca em toda invocação de Bash.
      const isRm = isRmCommand(command);
      const gitTarget = detectDestructiveGitTarget(command);
      if (isRm || gitTarget) {
        const hookDir = dirname(fileURLToPath(import.meta.url));
        const checkoutRoot = join(hookDir, "..", "..");
        const worktree = isLinkedWorktree(checkoutRoot);
        if (!worktree) {
          const ownPaths = readOwnSessionPaths(checkoutRoot, payload.session_id);
          const porcelainPaths = readGitPorcelainPaths(checkoutRoot);
          const foreignDirtyPaths = computeForeignDirtyPaths(porcelainPaths, ownPaths);

          if (isRm) {
            // #7757: cwd-aware — resolve cada path relativo contra o cwd
            // EFETIVO (rastreando `cd` no próprio comando), não
            // incondicionalmente contra checkoutRoot.
            const targetPaths = extractRmTargetsWithCwd(command, checkoutRoot);
            if (
              shouldBlockSharedCheckoutRm({ targetPaths, checkoutRoot, isWorktree: worktree, foreignDirtyPaths })
            ) {
              process.stdout.write(
                JSON.stringify({
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: RM_BLOCK_REASON,
                  },
                }),
              );
              return;
            }
          }

          if (gitTarget) {
            if (
              shouldBlockSharedCheckoutGitDestructive({
                target: gitTarget,
                checkoutRoot,
                isWorktree: worktree,
                foreignDirtyPaths,
              })
            ) {
              process.stdout.write(
                JSON.stringify({
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: GIT_DESTRUCTIVE_BLOCK_REASON,
                  },
                }),
              );
              return;
            }
          }
        }
      }
      // Sem bloqueio: não emitir nada — cai no fluxo normal de permissão.
    } catch (err) {
      // Fail-open, sempre: um hook quebrado não pode travar Bash legítimo.
      // Diagnóstico best-effort em stderr (achado do `silent-failure-hunter`
      // #8107 self-review) — antes disto, uma exceção não-antecipada aqui
      // desarmava os 3 guards em silêncio total, indistinguível de "nada pra
      // bloquear". Nunca vai pro stdout (contrato JSON do hook), nunca lança.
      try {
        process.stderr.write(
          `block-unsafe-shared-checkout-ops: exceção não-tratada, hook fail-open pra esta chamada (${err?.message ?? "erro desconhecido"}).\n`,
        );
      } catch {
        // stderr indisponível: sem sorte, mas nunca lança por causa disso.
      }
    }
  });
}
