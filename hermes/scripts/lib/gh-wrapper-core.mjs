// hermes/scripts/lib/gh-wrapper-core.mjs (#8884, buracos fechados no #8950)
//
// Lógica PURA (sem `child_process`, sem tocar o `gh` de verdade) por trás do
// wrapper `hermes/scripts/gh-wrapper.mjs`. Recebe o argv JÁ EXPANDIDO pelo
// shell (é essa a diferença em relação a `.claude/hooks/block-gh-comment-
// secrets.mjs`, que só vê o TEXTO do comando antes da expansão — por isso
// `--body "$VAR"` escapa daquele hook e não escapa deste) e decide se o
// comando publica texto e, se sim, se algum dos textos finais (body inline,
// `--body-file`/`-F`/`--input`, `--comment` de close, posicional de `gh gist
// create`, ou stdin quando qualquer uma dessas fontes usa `-`) carrega um
// segredo reconhecível.
//
// Padrões vêm de `.claude/hooks/lib/secret-patterns.mjs` — fonte única
// compartilhada com o hook do Claude Code e com `redact_public_text` de
// `hermes/scripts/continuo-pr-review.sh` (critério de pronto da #8884).
//
// #8950 fechou 4 buracos que deixavam passar texto sem checagem — todos por
// causa de `-F`/`-f` terem significado DIFERENTE conforme o subcomando
// (`-F` é `--body-file` em `pr`/`issue`/`release`/`gist`, mas é
// `--field key=value` em `gh api`; `-f` é o boolean `--fill` em `pr create`,
// mas é `--raw-field key=value` em `gh api`). A classificação de flags agora
// é resolvida por CONTEXTO (`nonApiBodyFlags`/isApi) em vez de um único par de
// conjuntos globais:
//   1. `-F arquivo`/`-F -` em `pr`/`issue`/`release`/`review` agora é lido
//      como arquivo (antes só `--body-file`/`--notes-file` eram reconhecidos
//      — a forma curta passava sem checagem nenhuma, e `-F -` sem checar
//      stdin).
//   2. `pr close`/`issue close --comment TEXTO` (e `-c`) agora publicam —
//      antes `close` nem entrava em `isPublishingInvocation`.
//   3. `--flag=valor` é normalizado ANTES de qualquer classificação
//      (`normalizeArgv`), então `--body-file=x`, `--title=x`, `--comment=x`,
//      `--input=x` etc. são tratados como o par `["--flag", "valor"]`
//      independente de qual flag específica é.
//   4. `gh api .../comments --input arquivo` (sem `-X`) agora é reconhecido
//      como publicação — `--input` conta como sinal de corpo, igual a
//      `-f`/`-F`/`--field`/`--raw-field`.
//
// #9020 fechou uma regressão do #8950: `normalizeArgv` aplicava o split de
// `--flag=valor`/`-Xvalor` a TODO token do argv, inclusive ao token que é o
// VALOR de uma flag anterior (`--body "--token=ghp_XXXX"` virava
// `["--body", "--token", "ghp_XXXX"]`, e `collectTextsToCheck` só via
// `"--token"` como body — o segredo inteiro escapava da inspeção, mas o `gh`
// real recebia o argv original intacto). A normalização agora é
// POSICIONAL: anda o argv token a token e, ao emitir uma flag que carrega
// valor em token separado (`longValueFlagsFor`), marca o PRÓXIMO token como
// valor e o repassa sem tocar — nunca reinterpretado como flag. Também
// ampliou `isPublishingInvocation`/`nonApiBodyFlags`/`shortValueFlagsFor`
// para cobrir `pr reopen`/`issue reopen --comment`/`-c` (mesma forma do gap
// de `close` fechado no #8950) e `pr merge --body`/`-b`/`--subject`/`-t`
// (o texto vira mensagem de commit pública).
//
// #9029/#9030 fecharam dois buracos pré-existentes achados no review do #9020:
//   - #9030: `[cmd, sub]` era sempre `argv[0]`/`argv[1]`, então uma flag
//     global antes do subcomando (`gh --repo o/r pr comment 1 --body X`) fazia
//     `isPublishingInvocation` nunca casar. `normalizeArgv` agora desloca
//     essas flags pro fim (`hoistCommand`) antes de ler `[cmd, sub]`.
//   - #9029: `collectTextsToCheck` pulava o token-valor ao achar uma flag,
//     então `--title --body SEGREDO` coletava só "--body". Agora o valor é
//     coletado E revisitado como possível flag (fail-closed).
//
// #9064: `gh gist edit` publica descrição (`-d`), nome de arquivo (`-f`,
// `-a`), conteúdo do arquivo-fonte posicional (`gh gist edit ID arq` ou `-`
// = stdin) e conteúdo do arquivo de `--add` — antes nem entrava em
// `isPublishingInvocation`. Posicionais de gist agora vêm de
// `gistContentSources` (create e edit). Fora de escopo, como no `pr create`
// sem `--body`: `gh gist edit ID` sem arquivo-fonte abre o `$EDITOR`, e o
// texto editado ali não passa pelo wrapper.
//
// Testável sem I/O real: toda leitura de arquivo/stdin é injetada via
// `deps` — ver `test/gh-wrapper.test.ts`.

import { findSecrets } from "../../../.claude/hooks/lib/secret-patterns.mjs";

/** Flags do `gh api` cujo VALOR é `campo=texto` ou `campo=@arquivo`. */
const API_FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field"]);
/** Flag genérica de arquivo-corpo do `gh api` (não é key=value, é path/-). */
const API_FILE_FLAGS = new Set(["--input"]);

/** Flags de texto público de `gh gist create`/`edit` (#9055, #9064): descrição e nome de arquivo. */
const GIST_TEXT_FLAGS = ["-d", "--desc", "-f", "--filename"];
/**
 * #9064: flags de `gh gist edit` que carregam valor além das de texto:
 * `-a`/`--add` (path de arquivo local cujo CONTEÚDO vira um arquivo novo do
 * gist — e o nome também é público) e `-r`/`--remove` (nome de arquivo a
 * remover; não publica, mas o valor precisa ser pulado para não virar
 * posicional).
 */
const GIST_EDIT_ADD_FLAGS = ["-a", "--add"];
const GIST_EDIT_REMOVE_FLAGS = ["-r", "--remove"];

/** Flags com valor em token separado no subcomando de gist (`create` ou `edit`). */
function gistValueFlags(sub) {
  const s = new Set(GIST_TEXT_FLAGS);
  if (sub === "edit") for (const f of [...GIST_EDIT_ADD_FLAGS, ...GIST_EDIT_REMOVE_FLAGS]) s.add(f);
  return s;
}

/**
 * Tokens posicionais de `gh gist create|edit ...` (argv normalizado), pulando
 * flags e seus valores. Em `create`, todos são arquivos (ou `-` = stdin); em
 * `edit`, o 1º é o id/url do gist e os demais são o arquivo-fonte cujo
 * conteúdo substitui o do gist (ou `-` = stdin) — #9064.
 */
function gistPositionals(argv) {
  const valueFlags = gistValueFlags(argv[1]);
  const toks = argv.slice(2);
  const out = [];
  let afterDoubleDash = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (typeof t !== "string") continue;
    // `--` encerra as flags: tudo depois é posicional, mesmo começando com `-`.
    if (afterDoubleDash) {
      out.push(t);
      continue;
    }
    if (t === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (t !== "-" && t.startsWith("-")) {
      if (valueFlags.has(t)) i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * Fontes de conteúdo que `gh gist create|edit` publicaria:
 *   - `sources`: arquivos posicionais, onde `-` = stdin;
 *   - `addFiles`: paths de `-a`/`--add` (só `edit`), sempre lidos como
 *     ARQUIVO — o `gh` abre o path literal, `-` ali não é stdin.
 */
function gistContentSources(argv) {
  const empty = { sources: [], addFiles: [], names: [] };
  if (argv[0] !== "gist") return empty;
  const pos = gistPositionals(argv);
  // #9084: `gh gist rename ID ANTIGO NOVO` — NOVO vira nome público do arquivo.
  if (argv[1] === "rename") return { ...empty, names: pos.slice(2, 3) };
  if (argv[1] === "create") return { ...empty, sources: pos };
  if (argv[1] === "edit") {
    const addFiles = [];
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === "--") break;
      if (GIST_EDIT_ADD_FLAGS.includes(argv[i]) && typeof argv[i + 1] === "string") addFiles.push(argv[i + 1]);
    }
    return { ...empty, sources: pos.slice(1), addFiles };
  }
  return empty;
}

const RELEASE_VALUE_FLAGS = new Set(["-t", "--title", "-n", "--notes", "-F", "--notes-file", "--target", "--discussion-category", "--notes-start-tag", "-R", "--repo", "--hostname"]);

/** #9150: assets posicionais de `gh release create TAG arq...` / `upload TAG arq...` (sufixo `#label` removido). */
function releaseAssetPaths(argv) {
  if (argv[0] !== "release" || !["create", "upload"].includes(argv[1])) return [];
  const pos = [];
  let afterDoubleDash = false;
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (typeof t !== "string") continue;
    if (afterDoubleDash) { pos.push(t); continue; }
    if (t === "--") { afterDoubleDash = true; continue; }
    if (t.startsWith("-") && t !== "-") { if (RELEASE_VALUE_FLAGS.has(t)) i++; continue; }
    pos.push(t);
  }
  return pos.slice(1).map((p) => { const i = p.indexOf("#"); return i > 0 ? p.slice(0, i) : p; });
}

/** Flags de arquivo (path ou `-` para stdin) em pr/issue/release/gist/review. */
const NON_API_FILE_FLAGS = new Set(["-F", "--body-file", "--notes-file"]);

/**
 * Flags de texto inline (valor literal publicado) em pr/issue/release/review,
 * por subcomando. `close`/`reopen` só publicam via `--comment`/`-c`; os
 * demais publicam via corpo/notas/título (`--subject` cobre `pr merge`,
 * #9020 — inofensivo nos demais subcomandos, que simplesmente não usam essa
 * flag).
 */
function nonApiBodyFlags(cmd, sub) {
  if (sub === "close" || sub === "reopen") return new Set(["-c", "--comment"]);
  const s = new Set(["-b", "--body", "-t", "--title", "-n", "--notes", "--subject"]);
  // #9055: em `gh gist create`, `-d`/`--desc` (descrição) e `-f`/`--filename`
  // (nome do arquivo quando o conteúdo vem de stdin) são texto PÚBLICO do
  // gist — antes eram só pulados como "valor de flag" pelo loop posicional e
  // nunca inspecionados. Fail-closed: o nome de arquivo também entra.
  // #9064: em `gh gist edit`, o path de `-a`/`--add` vira NOME público de
  // arquivo do gist — o nome é inspecionado aqui e o conteúdo em
  // `gistContentSources`.
  if (cmd === "gist") for (const f of GIST_TEXT_FLAGS) s.add(f);
  if (cmd === "gist" && sub === "edit") for (const f of GIST_EDIT_ADD_FLAGS) s.add(f);
  return s;
}

/**
 * Flags do `gh api` cujo TOKEN SEGUINTE é o valor da flag (nunca o path).
 * Usado só para achar o path posicional (`pathArg` abaixo) — sem isso, o
 * valor de `-X`/`--method` (ex: "PATCH") é confundido com o path quando vem
 * antes dele no argv, e `isPublishingInvocation` deixa passar (#8891). Forma
 * `--flag=valor` já vem normalizada em dois tokens antes de chegar aqui, então
 * segue consumindo 1 token do mesmo jeito.
 */
const GH_API_VALUE_FLAGS = new Set([
  "-X",
  "--method",
  "-H",
  "--header",
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
]);

/**
 * Flags curtas de 1 caractere que carregam um VALOR e que o `gh`/pflag aceita
 * COLADAS ao valor (`-Fcorpo.md`, `-F-`, `-btexto`, `-ccomentario`,
 * `-fcampo=valor`) — sem espaço, sem `=`. Resolvidas por CONTEXTO (mesma
 * razão de `nonApiBodyFlags`/`isApi` acima): `-f`/`-F` significam campo do
 * `gh api` num lugar e body-file/boolean noutro; `-c` é o `--comment` de
 * `close` (valor) num lugar e o `--comment` booleano de `pr review` (sem
 * valor) noutro. Nunca inclui uma flag SEM valor do contexto correspondente
 * (`-f`/`--fill` de `pr create`, `-c`/`--comment` de `pr review`) — colar um
 * valor a essas não é sintaxe válida do `gh` e não deve ser tratado como se
 * fosse (#8950).
 */
function shortValueFlagsFor(cmd, sub) {
  if (cmd === "api") return new Set(["-f", "-F"]);
  const s = new Set(["-F"]); // body-file/notes-file, universal em pr/issue/release/gist/review
  if (sub === "close" || sub === "reopen") s.add("-c");
  else {
    s.add("-b");
    s.add("-t");
    s.add("-n");
  }
  // #9055: `-dDESC`/`-fNOME` colados em `gh gist create` (`-f` aqui é
  // `--filename`, com valor — não o `--fill` booleano de `pr create`).
  if (cmd === "gist") {
    s.add("-d");
    s.add("-f");
  }
  // #9064: `-aPATH`/`-rNOME` colados em `gh gist edit`.
  if (cmd === "gist" && sub === "edit") {
    s.add("-a");
    s.add("-r");
  }
  return s;
}

/**
 * Flags (curtas E longas) cujo VALOR vem em token SEPARADO — usado por
 * `normalizeArgv` (#9020) pra saber que o token seguinte é um VALOR e nunca
 * deve ser reinterpretado como flag (nem splitado por `=`/glue). Combina os
 * conjuntos que `isPublishingInvocation`/`collectTextsToCheck` já conhecem
 * por contexto — nenhuma lista nova, só reuso.
 */
function longValueFlagsFor(cmd, sub, isApi) {
  const s = new Set();
  if (isApi) {
    for (const f of API_FIELD_FLAGS) s.add(f);
    for (const f of API_FILE_FLAGS) s.add(f);
    for (const f of GH_API_VALUE_FLAGS) s.add(f);
  } else {
    for (const f of nonApiBodyFlags(cmd, sub)) s.add(f);
    for (const f of NON_API_FILE_FLAGS) s.add(f);
    if (cmd === "gist") for (const f of gistValueFlags(sub)) s.add(f); // #9064: inclui `--remove`
  }
  return s;
}

/** Comandos de topo que `isPublishingInvocation` reconhece. */
const PUBLISHING_CMDS = new Set(["pr", "issue", "release", "gist", "api"]);
/** Subcomandos que `isPublishingInvocation` reconhece (pr/issue/release/gist). */
const PUBLISHING_SUBS = new Set(["comment", "create", "edit", "review", "close", "reopen", "merge", "rename", "upload"]);
/** Flags globais/herdadas cujo valor vem em token separado (`-R o/r`, `--repo o/r`). */
const GLOBAL_VALUE_FLAGS = new Set(["-R", "--repo", "--hostname"]);

/**
 * Índice do primeiro token a partir de `start` que NÃO é flag (nem valor de
 * flag). Valores em token separado são pulados junto com a flag:
 *   - flag conhecida com valor (`GLOBAL_VALUE_FLAGS`) → sempre pula o token
 *     seguinte (mesmo que ele seja "pr" — `gh -R pr issue comment` é repo "pr");
 *   - `--flag=valor` / `-Rvalor` → 1 token só;
 *   - flag DESCONHECIDA → pula o token seguinte como valor (mesma heurística
 *     do `stripFlags` do cobra), a não ser que ele seja um nome protegido
 *     (`protectedNames`: o comando/subcomando publicador) ou outra flag. Errar
 *     aqui só pode engolir um comando NÃO publicador — que não publicaria.
 */
function skipFlags(argv, start, protectedNames) {
  let i = start;
  while (i < argv.length) {
    const a = argv[i];
    if (typeof a !== "string" || !a.startsWith("-") || a === "-" || a === "--") break;
    if (a.includes("=") || (!a.startsWith("--") && a.length > 2)) {
      i += 1; // `--repo=o/r`, `-Ro/r`: valor colado
      continue;
    }
    if (GLOBAL_VALUE_FLAGS.has(a)) {
      i += 2;
      continue;
    }
    const next = argv[i + 1];
    const nextIsValue = typeof next === "string" && !next.startsWith("-") && !protectedNames.has(next);
    i += nextIsValue ? 2 : 1;
  }
  return i;
}

/**
 * #9030: coloca `[cmd, sub]` nas posições 0/1 quando há flags ANTES do comando
 * (`gh --repo o/r pr comment 1 --body X`) ou entre comando e subcomando
 * (`gh pr -R o/r comment ...`) — o cobra aceita as duas formas. Sem isso,
 * `[cmd, sub]` virava `["--repo", "o/r"]` e nenhuma regra casava.
 *
 * As flags deslocadas NÃO são descartadas: vão pro FIM do argv inspecionado.
 * O cobra repassa flags anteriores ao comando pro subcomando, então
 * `gh --body X pr comment 1` publica X — descartá-las abriria outro buraco.
 * Irem pro fim (e não logo depois de `sub`) preserva o path posicional de
 * `gh api` (`-R o/r` logo depois de `api` faria `findGhApiPath` achar "o/r").
 * Em `gh api`, flags entre `api` e o path ficam onde estão (lá `sub` não é
 * usado, e `-X POST` precisa continuar visível).
 *
 * Só reordena o argv INSPECIONADO; o `gh` real recebe o argv original. Sem
 * flag deslocada, devolve o próprio array.
 */
function hoistCommand(argv) {
  const ci = skipFlags(argv, 0, PUBLISHING_CMDS);
  if (ci >= argv.length) return argv;
  const leading = argv.slice(0, ci);
  const cmd = argv[ci];
  if (cmd === "api") return ci === 0 ? argv : ["api", ...argv.slice(ci + 1), ...leading];
  const si = skipFlags(argv, ci + 1, PUBLISHING_SUBS);
  if (ci === 0 && si === 1) return argv;
  const between = argv.slice(ci + 1, si);
  return [cmd, ...argv.slice(si), ...leading, ...between];
}

/**
 * Normaliza duas sintaxes de "flag colada ao valor" em `["--flag", "valor"]`
 * / `["-F", "valor"]` ANTES de qualquer classificação — sem isso, uma dessas
 * formas passa como token desconhecido e nem é lida nem pede stdin (#8950):
 *
 * 1. `--flag=valor` → split no primeiro `=`. Cobre TODAS as flags longas —
 *    inclusive `-f`/`-F` de campo do `gh api` (`--field=body=texto` vira
 *    `["--field", "body=texto"]`, que é exatamente como o parser de
 *    `-F`/`--field` já espera o valor).
 * 2. `-Fvalor`/`-F-`/`-bvalor`/`-cvalor`/`-fvalor` (flag curta de 1 caractere
 *    colada ao valor, sem espaço) → split em `[prefixo, resto]`, só para as
 *    flags que `shortValueFlagsFor` resolve como "carrega valor" NESTE
 *    comando/subcomando específico. Nunca separa cluster de flags booleanas
 *    (`-la`, `-dw`, etc.) — `gh` não usa esse padrão nas flags cobertas aqui,
 *    e só tocamos a flag que sabemos, por contexto, que tem valor.
 */
export function normalizeArgv(rawArgv) {
  if (!Array.isArray(rawArgv)) return rawArgv;
  // #9030: flags antes do comando/subcomando vão pro fim do argv INSPECIONADO
  // (`hoistCommand`) — senão `[cmd, sub]` vira `["--repo", "o/r"]` e nenhuma
  // regra casa. O `gh` real continua recebendo o argv original.
  const argv = hoistCommand(rawArgv);
  const [cmd, sub] = argv;
  const isApi = cmd === "api";
  const shortValueFlags = shortValueFlagsFor(cmd, sub);
  const longValueFlags = longValueFlagsFor(cmd, sub, isApi);
  const out = [];
  // #9020: token que é o VALOR de uma flag anterior (`--body`, `-t`, `-F`,
  // `--field`, etc.) nunca é reinterpretado como flag — passa intacto, sem
  // split. Sem isso, um valor como "--token=ghp_XXXX" ou "-tghp_XXXX" era
  // splitado como se fosse a PRÓXIMA flag, e só o pedaço final chegava a
  // `collectTextsToCheck` (o segredo inteiro escapava da inspeção enquanto o
  // `gh` real recebia o argv original completo).
  let expectValue = false;
  let afterDoubleDash = false;
  for (const a of argv) {
    // Depois de `--` (fora de valor de flag) nada é flag: repassa intacto.
    if (afterDoubleDash) {
      out.push(a);
      continue;
    }
    if (a === "--" && !expectValue) {
      out.push(a);
      afterDoubleDash = true;
      continue;
    }
    if (typeof a !== "string") {
      out.push(a);
      expectValue = false;
      continue;
    }
    if (expectValue) {
      out.push(a);
      expectValue = false;
      continue;
    }
    if (a.startsWith("--") && a.includes("=")) {
      const idx = a.indexOf("=");
      out.push(a.slice(0, idx), a.slice(idx + 1));
      continue;
    }
    if (!a.startsWith("--") && a.startsWith("-") && a.length > 2) {
      // #9150: pflag aceita cluster de curtas (`-ab VALOR`, `-dbVALOR`): booleanas
      // na frente, 1ª flag de valor consome o resto do token (ou o próximo).
      // Varre TODAS as posições, não só a 1ª. `-a=valor`: o `=` não é do valor (#9064).
      let split = false;
      for (let k = 1; k < a.length; k++) {
        const flag = "-" + a[k];
        if (!shortValueFlags.has(flag)) continue;
        const rest = a[k + 1] === "=" ? a.slice(k + 2) : a.slice(k + 1);
        out.push(flag);
        if (rest === "" && k === a.length - 1) expectValue = true;
        else out.push(rest);
        split = true;
        break;
      }
      if (split) continue;
    }
    out.push(a);
    if (a.startsWith("-") && (longValueFlags.has(a) || shortValueFlags.has(a))) {
      expectValue = true;
    }
  }
  return out;
}

/** Acha o path posicional de `gh api ...` (argv sem o `api` inicial), pulando flags com valor. */
function findGhApiPath(argvAfterApi) {
  for (let i = 0; i < argvAfterApi.length; i++) {
    const a = argvAfterApi[i];
    if (!a.startsWith("-")) return a;
    if (GH_API_VALUE_FLAGS.has(a)) i++; // pula o valor da flag, nunca é o path
  }
  return "";
}

/** O invocação (`argv` sem o `gh` inicial) publica texto no GitHub? */
export function isPublishingInvocation(rawArgv) {
  if (!Array.isArray(rawArgv) || rawArgv.length < 2) return false;
  const argv = normalizeArgv(rawArgv);
  const [cmd, sub] = argv;
  if ((cmd === "pr" || cmd === "issue") && ["comment", "create", "edit", "review", "close", "reopen"].includes(sub)) {
    return true;
  }
  if (cmd === "pr" && sub === "merge") return true; // #9020: --body/-b, --subject/-t viram mensagem de commit pública
  if (cmd === "release" && ["create", "edit", "upload"].includes(sub)) return true; // #9150: assets viram arquivos públicos
  if (cmd === "gist" && (sub === "create" || sub === "edit" || sub === "rename")) return true; // #9064: edit publica desc/nome/conteúdo; #9084: rename publica o nome novo
  if (cmd === "api") {
    const hasWriteMethod = argv.some(
      (a, i) =>
        (a === "-X" || a === "--method") && /^(?:POST|PATCH|PUT)$/i.test(argv[i + 1] ?? ""),
    );
    const hasBodyArg = argv.some((a) => API_FIELD_FLAGS.has(a) || API_FILE_FLAGS.has(a));
    const pathArg = findGhApiPath(argv.slice(1));
    const touchesTarget = /(?:^|\/)(?:comments|issues|pulls|reviews|gists|releases)\b/.test(pathArg) || pathArg === "graphql"; // #9150: gists/releases
    if ((hasWriteMethod || hasBodyArg) && touchesTarget) return true;
  }
  return false;
}

/** O comando precisa ler stdin (algum `-` usado como valor de arquivo/campo)? */
export function requiresStdin(rawArgv) {
  const argv = normalizeArgv(rawArgv);
  const [cmd] = argv;
  const isApi = cmd === "api";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!isApi && NON_API_FILE_FLAGS.has(a) && argv[i + 1] === "-") return true;
    if (isApi && API_FILE_FLAGS.has(a) && argv[i + 1] === "-") return true;
    if (isApi && API_FIELD_FLAGS.has(a)) {
      const v = argv[i + 1] ?? "";
      const m = v.match(/^[^=]+=@(.+)$/);
      if (m && m[1] === "-") return true;
    }
  }
  if (gistContentSources(argv).sources.includes("-")) return true;
  return false;
}

function safeRead(readFileSync, path) {
  try {
    return readFileSync(path);
  } catch {
    return ""; // arquivo ilegível: fail-open, mesma filosofia do hook irmão
  }
}

/**
 * Coleta todos os textos que este invocação publicaria, já resolvidos
 * (arquivo lido, stdin substituído). `deps.readFileSync(path): string` e
 * `deps.stdinText: string | undefined` (só precisa existir quando
 * `requiresStdin(argv)` for true).
 */
export function collectTextsToCheck(rawArgv, deps = {}) {
  const argv = normalizeArgv(rawArgv);
  const { readFileSync = () => "", stdinText } = deps;
  const resolveFileOrStdin = (path) => (path === "-" ? (stdinText ?? "") : safeRead(readFileSync, path));

  const [cmd, sub] = argv;
  const isApi = cmd === "api";
  const bodyFlags = isApi ? new Set() : nonApiBodyFlags(cmd, sub);
  const fileFlags = isApi ? API_FILE_FLAGS : NON_API_FILE_FLAGS;

  // #9029: o índice NUNCA pula o token-valor. Antes, ao achar `--title` o
  // loop consumia o token seguinte (`i++`) sem examiná-lo como flag — então
  // `--title --body SEGREDO` coletava só "--body" e o segredo real (o token
  // depois) nunca era lido. Agora o valor é coletado E revisitado na próxima
  // iteração: se ele próprio for uma flag reconhecida, o token seguinte também
  // é coletado. Fail-closed — as duas leituras possíveis do argv (valor
  // literal "--body" e flag `--body`) são inspecionadas; o custo é, no pior
  // caso, checar um texto a mais (nunca deixar um de fora).
  const texts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (bodyFlags.has(a)) {
      texts.push(argv[i + 1] ?? "");
      continue;
    }
    if (fileFlags.has(a)) {
      texts.push(resolveFileOrStdin(argv[i + 1] ?? ""));
      continue;
    }
    if (isApi && API_FIELD_FLAGS.has(a)) {
      const v = argv[i + 1] ?? "";
      const atMatch = v.match(/^([^=]+)=@(.+)$/);
      if (atMatch) {
        texts.push(resolveFileOrStdin(atMatch[2]));
      } else if (/^[^=]+=/.test(v)) {
        texts.push(v.slice(v.indexOf("=") + 1));
      }
      continue;
    }
  }

  const gist = gistContentSources(argv);
  for (const src of gist.sources) texts.push(resolveFileOrStdin(src));
  for (const path of gist.addFiles) texts.push(safeRead(readFileSync, path));
  for (const name of gist.names) texts.push(name);
  for (const path of releaseAssetPaths(argv)) texts.push(safeRead(readFileSync, path));

  return texts;
}

/**
 * Decisão final: `{ blocked: false }` (deixa passar) ou
 * `{ blocked: true, secrets: string[] }` (recusa, não repassa pro `gh` real).
 * Comando que não publica nada nunca é lido/verificado (fail-open por
 * escopo, não por erro).
 */
export function evaluateGhInvocation(argv, deps = {}) {
  if (!isPublishingInvocation(argv)) return { blocked: false };
  const texts = collectTextsToCheck(argv, deps);
  const found = new Set();
  for (const t of texts) for (const n of findSecrets(t)) found.add(n);
  if (found.size === 0) return { blocked: false };
  return { blocked: true, secrets: [...found] };
}
