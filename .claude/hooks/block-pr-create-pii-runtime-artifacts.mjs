// PreToolUse hook — recusa `gh pr create` quando o CONTEÚDO DA BRANCH (diff
// contra `origin/master`/`master`, não só o comando em si) carrega um
// artefato de runtime versionado (`_tmp_*`, `data/**`, dumps/backups/caches)
// ou PII de assinante (regex de e-mail em linha ADICIONADA fora de
// fixture/teste declarado) — #6753.
//
// Incidente de origem: branch `continuo/fix-6678-brevo-diaria-origin`
// (commit `f107aa08`) misturou um fix legítimo (#6678) com scope creep +
// ~20 arquivos de dump em `scripts/_tmp_eng*/` contendo e-mail e
// `subscriber_id` reais de assinante. Dois commits de "limpeza" seguintes
// falharam: `.gitignore` não afeta arquivo já TRACKED, e `git rm --cached`
// deixou 1 arquivo pra trás (`scripts/_tmp_engagement_backup3/
// b29f6620_p1.json`, 100 registros de assinante) — que só foi achado ~14h
// depois pelo `daily-review` (#6691), já em `master`. Nenhum guard mecânico
// existia no caminho de abertura de PR pra pegar isso ANTES do merge; o
// review por PR do contínuo é auto-assinado (#6732), então esse gate também
// não protegia. Causa-raiz completa (a regra de `.gitignore` do #6541 estava
// SINTATICAMENTE morta por um comentário inline — `.gitignore` não suporta
// `# comentário` no fim da linha) e purga confirmada do histórico remoto:
// ver #6753 (comentário de fechamento) e PR #6707.
//
// Por que olhar o DIFF DA BRANCH inteira, não só o `git diff` sem stage ou o
// que este comando `Bash` adicionaria: o `.gitignore` protege só contra
// `git add` de arquivo NOVO — nunca contra um arquivo já TRACKED (que foi
// exatamente o modo de falha real). O guard aqui compara o HEAD da branch
// contra o merge-base com `origin/master`/`master` — cobre TUDO que a PR vai
// levar pra master, não só o commit mais recente, então mesmo se um commit
// de "limpeza" tivesse rodado só um `git rm --cached` incompleto (como
// aconteceu de verdade), o arquivo que sobrou ainda aparece como `A`
// (added) nesse diff acumulado.
//
// Dois sinais, cada um objetivo e barato (item 1/2 da proposta da issue —
// item 3, "fora do escopo declarado da issue", ficou de fora de propósito,
// porque exige julgamento de escopo que este guard não tenta fazer):
//
//   1. **Artefato de runtime tracked** (`isRuntimeArtifactPath`) — qualquer
//      arquivo NOVO (status `A`) ou renomeado PARA (status `R…`) um path que
//      bate um padrão de diretório/arquivo de runtime (`_tmp_*`, `data/**`,
//      `*-backup*/`, `*dump*`, `.cache/`, `*.tmp`). Estes NUNCA deveriam
//      estar versionados (mesmo invariante do CLAUDE.md — `data/` é
//      junction OneDrive com `.gitignore` blanket).
//   2. **PII de e-mail em linha ADICIONADA** (`EMAIL_RE`) fora de um path de
//      fixture/teste declarado (`isFixturePath`) — escaneia só as linhas
//      `+` do diff acumulado (não o arquivo inteiro), porque a maioria dos
//      arquivos do repo já tem e-mails legítimos e ESTÁVEIS em partes não
//      tocadas por esta PR (config do projeto, endereço interno em
//      comentário, domínio sintético de teste) — só o que esta BRANCH
//      efetivamente introduz de novo importa. Testado ao vivo contra o repo
//      real (260829): `platform.config.json`/`scripts/lib/clarice-db.ts`
//      têm dezenas de e-mails legítimos pré-existentes; escanear o arquivo
//      inteiro bloquearia qualquer PR futura que tocasse 1 linha desses
//      arquivos. Escanear só `+` evita esse falso positivo em massa E ainda
//      pega o caso real (o dump era 100% linhas novas — arquivo inteiro
//      recém-criado na branch).
//
// Fail-soft/fail-open em qualquer falha de infraestrutura (git indisponível,
// não é um repo, sem `origin/master` nem `master` resolvível, comando não
// reconhecido como `gh pr create`) — mesma filosofia dos hooks irmãos
// (`block-gh-pr-merge-subagent.mjs`, `block-branch-checkout-main.mjs`): um
// guard que não consegue AVALIAR o risco não pode travar `gh pr create`
// legítimo por um soluço de infra. A defesa em profundidade continua
// existindo (`daily-review`, review por PR) — este guard reduz a janela de
// exposição, não a substitui.
//
// Self-contained (nenhum import de `scripts/*.ts`) — mesma razão documentada
// nos hooks irmãos: um import estático de `.ts` quebra o hook inteiro,
// silenciosamente, num Node sem type-stripping nativo. As funções PURAS
// abaixo são exportadas (não duplicadas em outro arquivo) porque este
// próprio arquivo já é `.mjs` puro — `test/block-pr-create-pii-runtime-artifacts.test.ts`
// importa direto daqui, sem precisar de cópia.
//
// Schema do hook `PreToolUse`: mesmo contrato dos hooks irmãos — JSON no
// stdin com `session_id`/`tool_name`/`tool_input`, saída
// `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision:
// "deny", permissionDecisionReason: "..." } }` em stdout com exit 0 para
// bloquear; nenhuma saída para permitir (equivalente a "defer").

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Remove o CONTEÚDO de spans entre aspas (simples ou duplas), preservando
 * tudo fora deles. Duplicado de `block-branch-checkout-main.mjs`/
 * `block-gh-pr-merge-subagent.mjs` — mesma razão self-contained.
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

/**
 * `true` quando `command` contém `gh pr create` como comando REAL — início
 * de string ou depois de um separador de comando (`&&`/`;`/`|`/newline),
 * depois de remover o conteúdo de aspas (nunca casa uma citação de
 * "gh pr create" dentro de um `--body`/string). Versão simplificada
 * (booleana, não 3-state) de `isGhPrCreateCommand` em `pr-create-review.mjs`
 * — este guard é PreToolUse (decide ANTES da execução) e prefere fail-open
 * (não bloquear) quando o comando não é reconhecido com confiança, então o
 * 3º estado "unknown" colapsa em `false` aqui.
 *
 * **Exceção deliberada à regra "aspas nunca contam" (fleet review pós-PR
 * #6776, finding 1):** um `gh pr create` embrulhado em `bash -c "..."`/
 * `sh -c "..."`/`zsh -c "..."` é uma invocação REAL, não uma citação — mas
 * `stripQuotedSpans` remove o conteúdo de QUALQUER string entre aspas,
 * inclusive o argumento de `-c`, então a checagem principal (sobre o
 * comando stripado) nunca veria esse `gh pr create`. `containsShellWrappedGhPrCreate`
 * checa o comando BRUTO (não stripado) só quando há sinal de um
 * interpretador `-c`/`--command`, evitando reabrir a brecha original (uma
 * citação solta tipo `echo "rodar gh pr create depois"` continua sem
 * interpretador `-c`, então não é afetada).
 */
export function containsShellWrappedGhPrCreate(command) {
  if (typeof command !== "string") return false;
  return (
    /\b(?:bash|sh|zsh)\s+(?:-\w*c\w*\s|--command[= ])/i.test(command) &&
    /\bgh\s+pr\s+create\b/i.test(command)
  );
}

export function isGhPrCreateCommand(command) {
  if (typeof command !== "string") return false;
  if (containsShellWrappedGhPrCreate(command)) return true;
  const stripped = stripQuotedSpans(command);
  return /^\s*gh\s+pr\s+create\b|(?:&&|;|\|\||\||\n)\s*gh\s+pr\s+create\b/.test(stripped);
}

/** Padrões de path que nunca deveriam estar versionados — artefato de
 * runtime (#6753). Casam contra o path RELATIVO ao repo (barras `/`, nunca
 * `\`).
 *
 * **Ajustados no fleet review pós-PR #6776 (findings 2 e 3):**
 * - `dump` era substring livre (`[^/]*dump[^/]*`) e colidia com o arquivo
 *   real `scripts/dump-worker-logs.ts` (código-fonte legítimo, "dump" é só
 *   parte do nome). Restrito a "dump"/"dumps" como SEGMENTO de diretório
 *   inteiro, ou como SUFIXO de nome de arquivo antes da extensão
 *   (`*-dump.ext`, `*_dump.ext`, `dump.ext` bare) — nunca como prefixo de
 *   um nome maior.
 * - `backup` só casava a forma DIRETÓRIO (`*-backup3/`) — um arquivo bare
 *   como `subscribers-backup.json` (sem diretório dedicado) passava
 *   despercebido. Adicionado o par em forma de ARQUIVO.
 */
export const RUNTIME_ARTIFACT_PATH_PATTERNS = [
  /(^|\/)_tmp_[^/]*(\/|$)/i, // scripts/_tmp_*/ (o padrão exato do incidente)
  /(^|\/)tmp_[^/]*(\/|$)/i,
  /^data\//i, // qualquer path sob data/ — CLAUDE.md: nada ali é pra ir pro repo
  /(^|\/)[\w.-]*-backup\d*\//i, // diretório *-backup*/ (scripts/_tmp_engagement_backup3/)
  /(^|\/)[\w.-]*[-_]backups?\.[^/]+$/i, // arquivo bare *-backup.ext / *_backups.ext
  /(^|\/)dumps?(\/|$)/i, // diretório (ou arquivo sem extensão) literalmente "dump"/"dumps"
  /(^|\/)dumps?\.[^/]+$/i, // arquivo bare "dump.ext"/"dumps.ext" (sem prefixo)
  /(^|\/)[\w.-]*[-_]dumps?\.[^/]+$/i, // arquivo *-dump.ext / *_dumps.ext
  /(^|\/)\.cache(\/|$)/i,
  /\.tmp$/i,
  // #6971 — rascunho de SESSÃO (corpo de PR, comentário de review, patch
  // temporário) largado solto na raiz do checkout compartilhado em vez de
  // /tmp ou do scratchpad da sessão (Direção 3 da issue: "parar de usar o
  // checkout como área de rascunho entre sessões" — não impede a escrita
  // untracked em si, mas barra que ela seja COMMITADA via `gh pr create`,
  // reduzindo o hábito). Padrões vistos ao vivo no `git status` da rodada
  // 01-02/09/2026: `_tmp_cover_snippet.js`/`_tmp_gencover.mjs` (já cobertos
  // acima, prefixo `_tmp_`), `all_issues_tmp.json`/`rest_issues_tmp.json`
  // (sufixo `_tmp.ext`, forma NOVA — não casava nenhum padrão acima) e
  // `scratch-drift.ts`. `.prNNNN-review.md` é o nome exato do arquivo do
  // incidente de origem (#6971 — `rm -f .pr6950-review.md`); `_prbody`/
  // `_commitmsg` são os nomes sugeridos no checklist de dispatch (item 20
  // de `context/overnight-dispatch-rules.md`) para quem hoje monta corpo de
  // PR/commit num arquivo solto em vez de heredoc/Write no scratchpad.
  /(^|\/)[\w.-]*_tmp\.[^/]+$/i, // arquivo bare *_tmp.ext (sufixo — all_issues_tmp.json)
  /(^|\/)scratch[-_.][\w.-]*$/i, // scratch-*/scratch_*/scratch.* (scratch-drift.ts)
  /(^|\/)\.pr\d+-review\.[^/]+$/i, // .prNNNN-review.md — nome exato do incidente de origem
  /(^|\/)_(prbody|commitmsg)[\w.-]*$/i, // _prbody*/_commitmsg* — corpo de PR/commit num arquivo solto
];

/** `true` se `path` bate algum padrão de artefato de runtime acima. */
export function isRuntimeArtifactPath(path) {
  if (typeof path !== "string" || path === "") return false;
  const normalized = path.replaceAll("\\", "/");
  return RUNTIME_ARTIFACT_PATH_PATTERNS.some((re) => re.test(normalized));
}

/** Paths de fixture/teste declarados — nunca entram na checagem de PII
 * (#6753 item 2, "fora de fixture declarada"). Cobre a convenção real do
 * repo: `test/**`, `*.test.ts`/`*.spec.ts`, `__fixtures__/`, `fixtures/`. */
export function isFixturePath(path) {
  if (typeof path !== "string" || path === "") return false;
  const normalized = path.replaceAll("\\", "/");
  return (
    /^test\//i.test(normalized) ||
    /(^|\/)__fixtures__\//i.test(normalized) ||
    /(^|\/)fixtures\//i.test(normalized) ||
    /\.(test|spec)\.[jt]sx?$/i.test(normalized)
  );
}

/** Regex de detecção de e-mail — mesma forma usada em todo o repo
 * (`scripts/lib/canonicalize-gmail.ts` e afins), suficiente pra detecção
 * (não precisa de RFC completo pra este guard). */
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Parse de `git diff --name-status <base> <head>` — devolve
 * `{ status, path }[]`. Renomeações (`R100\told\tnew`) resolvem `path` pro
 * destino (`new`) — é o path que vai existir em `master` se a PR mergear.
 */
export function parseNameStatus(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  const out = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    const status = parts[0];
    if (!status) continue;
    const path = status.startsWith("R") || status.startsWith("C") ? parts[2] : parts[1];
    if (path) out.push({ status, path });
  }
  return out;
}

/**
 * Parse de um diff unificado (`git diff <base> <head>`) — devolve
 * `Map<path, string[]>` das linhas ADICIONADAS (`+`, excluindo o marcador
 * `+++`) por arquivo de DESTINO (o lado `b/`). Só as linhas `+` importam
 * para a checagem de PII (#6753 — conteúdo NOVO que esta branch introduz,
 * não o arquivo inteiro).
 */
export function parseAddedLinesByFile(diffText) {
  const byFile = new Map();
  if (typeof diffText !== "string" || diffText === "") return byFile;
  let currentPath = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      if (raw === "/dev/null") {
        currentPath = null;
      } else {
        currentPath = raw.startsWith("b/") ? raw.slice(2) : raw;
        if (!byFile.has(currentPath)) byFile.set(currentPath, []);
      }
      continue;
    }
    if (line.startsWith("diff --git ")) {
      currentPath = null; // reset até o próximo "+++ b/..." confirmar o path
      continue;
    }
    if (currentPath && line.startsWith("+") && !line.startsWith("+++")) {
      byFile.get(currentPath).push(line.slice(1));
    }
  }
  return byFile;
}

/**
 * Pure: combina os dois sinais e devolve os findings — `[]` quando a branch
 * está limpa. `nameStatusEntries`/`addedLinesByFile` vêm de
 * `parseNameStatus`/`parseAddedLinesByFile` (produção) ou fixtures (teste).
 */
export function findDangerousDiffContent(nameStatusEntries, addedLinesByFile) {
  const findings = [];

  for (const entry of nameStatusEntries) {
    if (!entry.status.startsWith("A") && !entry.status.startsWith("R")) continue;
    if (isRuntimeArtifactPath(entry.path)) {
      findings.push({
        path: entry.path,
        kind: "runtime-artifact",
        detail: "path bate padrão de artefato de runtime (_tmp_/data//*-backup*//dump/.cache/.tmp) — nunca deveria estar versionado",
      });
    }
  }

  for (const [path, lines] of addedLinesByFile.entries()) {
    if (isFixturePath(path)) continue;
    const emailLines = lines.filter((l) => EMAIL_RE.test(l));
    if (emailLines.length > 0) {
      findings.push({
        path,
        kind: "pii-email",
        detail: `${emailLines.length} linha(s) adicionada(s) com padrão de e-mail fora de fixture/teste declarado`,
      });
    }
  }

  return findings;
}

/** Monta a mensagem de recusa (nunca imprime o e-mail em si — só path +
 * contagem, #6753: evitar que a própria mensagem de bloqueio vire mais um
 * lugar onde a PII aparece em texto). */
export function buildDenyMessage(findings) {
  const lines = [
    "gh pr create bloqueado pelo guard mecânico de higiene de commit (#6753): a branch contém conteúdo perigoso que não deveria ir pra master.",
  ];
  for (const f of findings) {
    lines.push(`  - [${f.kind}] ${f.path} — ${f.detail}`);
  }
  lines.push(
    "Remova o(s) arquivo(s)/linha(s) acima da branch (git rm --cached + commit, ou reescreva o histórico da branch) antes de abrir a PR. " +
      "Se for falso positivo, confirme manualmente e peça pro editor revisar — este guard nunca deve ser contornado sem revisão humana.",
  );
  return lines.join("\n");
}

/** Resolve o alvo de comparação (`origin/master` preferido, `master` como
 * fallback) — `null` se nenhum dos dois resolver (fail-open no chamador). */
function resolveBaseRef(cwd) {
  for (const ref of ["origin/master", "master"]) {
    const result = spawnSync("git", ["rev-parse", "--verify", ref], {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
    });
    if (!result.error && result.status === 0) return ref;
  }
  return null;
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  return result.stdout ?? "";
}

// #2019-style CLI guard — só roda o corpo do hook quando este arquivo é o
// entrypoint (nunca ao ser importado por test/block-pr-create-pii-runtime-artifacts.test.ts).
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
      if (!isGhPrCreateCommand(command)) return;

      const hookDir = dirname(fileURLToPath(import.meta.url));
      const cwd = join(hookDir, "..", "..");

      const baseRef = resolveBaseRef(cwd);
      if (!baseRef) return; // fail-open: não deu pra achar master/origin-master

      const mergeBase = runGit(["merge-base", baseRef, "HEAD"], cwd);
      if (mergeBase === null) return; // fail-open
      const base = mergeBase.trim();
      if (!base) return;

      const nameStatusRaw = runGit(["diff", "--name-status", base, "HEAD"], cwd);
      if (nameStatusRaw === null) return; // fail-open
      const diffRaw = runGit(["diff", base, "HEAD"], cwd);
      if (diffRaw === null) return; // fail-open

      const nameStatusEntries = parseNameStatus(nameStatusRaw);
      const addedLinesByFile = parseAddedLinesByFile(diffRaw);
      const findings = findDangerousDiffContent(nameStatusEntries, addedLinesByFile);

      if (findings.length > 0) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: buildDenyMessage(findings),
            },
          }),
        );
      }
      // Sem findings: não emitir nada — cai no fluxo normal de permissão.
    } catch {
      // Fail-open, sempre: um hook quebrado não pode travar `gh pr create`
      // legítimo de uma sessão coordenadora ou interativa comum.
    }
  });
}

