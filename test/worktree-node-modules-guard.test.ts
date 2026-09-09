// Regressão #7763: symlink node_modules → fora do worktree + npm ci = principal vazio
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, rmSync, mkdirSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNodeModulesSymlink, guardBeforeNpmInstall } from "../scripts/lib/worktree-node-modules-guard.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK_BASENAME = "block-npm-install-node-modules-symlink.mjs";

function withTmp(fn: (dir: string) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), "wt-7763-"));
  try {
    fn(tmp);
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

test("bloqueia symlink apontando para fora do worktree", () => {
  withTmp((tmp) => {
    const outside = mkdtempSync(join(tmpdir(), "wt-7763-principal-"));
    try {
      mkdirSync(join(outside, "node_modules"), { recursive: true });
      symlinkSync(join(outside, "node_modules"), join(tmp, "node_modules"), "junction");
      const r = checkNodeModulesSymlink(tmp);
      assert.equal(r.blocked, true);
      assert.match(r.reason, /fora do worktree/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("aceita diretório real", () => {
  withTmp((tmp) => {
    mkdirSync(join(tmp, "node_modules"), { recursive: true });
    const r = checkNodeModulesSymlink(tmp);
    assert.equal(r.blocked, false);
  });
});

test("aceita node_modules ausente (instalação necessária)", () => {
  withTmp((tmp) => {
    const r = checkNodeModulesSymlink(tmp);
    assert.equal(r.blocked, false);
    assert.match(r.reason, /ausente/);
  });
});

test("aceita symlink intra-worktree (self-referente)", () => {
  withTmp((tmp) => {
    const inner = join(tmp, "vendor-node-modules");
    mkdirSync(inner, { recursive: true });
    symlinkSync(inner, join(tmp, "node_modules"), "junction");
    const r = checkNodeModulesSymlink(tmp);
    assert.equal(r.blocked, false);
    assert.match(r.reason, /intra-worktree/);
  });
});

test("lança no guardBeforeNpmInstall quando bloqueado", () => {
  withTmp((tmp) => {
    const outside = mkdtempSync(join(tmpdir(), "wt-7763-principal-"));
    try {
      mkdirSync(join(outside, "node_modules"), { recursive: true });
      symlinkSync(join(outside, "node_modules"), join(tmp, "node_modules"), "junction");
      assert.throws(() => guardBeforeNpmInstall(tmp), /\[GUARD #7763\]/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// Achado do review da PR #7774: erro de inspeção que NÃO seja ENOENT (EACCES,
// EPERM) não pode virar "não bloqueado" — mascarar falha de inspeção é
// exatamente o caminho que o guard existe para fechar.
test("erro de inspeção não-ENOENT bloqueia em vez de mascarar", { skip: process.platform === "win32" ? "chmod não restringe leitura no Windows" : process.getuid?.() === 0 ? "root ignora permissão de diretório" : false }, () => {
  withTmp((tmp) => {
    const locked = join(tmp, "locked");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const r = checkNodeModulesSymlink(locked);
      assert.equal(r.blocked, true);
      assert.match(r.reason, /não foi possível inspecionar/);
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

// #7774: o guard só fecha o #7763 se ALGUMA COISA o invocar antes do `npm ci`
// real. O `preinstall` do package.json foi TENTADO e não serve: medido ao vivo
// (npm 11, 09/09/2026), o `npm ci` remove a árvore antiga — seguindo a junction
// e esvaziando o alvo — ANTES de disparar lifecycle script algum; quando o
// preinstall roda, `node_modules` já é ENOENT e o guard legitimamente libera.
// O enforcement real é o PreToolUse hook, que roda antes do npm ser invocado.
test("o hook PreToolUse do guard está registrado em .claude/settings.json", () => {
  const settings = JSON.parse(readFileSync(join(repoRoot, ".claude/settings.json"), "utf8")) as {
    hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ args?: string[] }> }> };
  };
  const bashGroups = (settings.hooks?.PreToolUse ?? []).filter((g) => g.matcher === "Bash");
  const args = bashGroups.flatMap((g) => (g.hooks ?? []).flatMap((h) => h.args ?? []));
  assert.ok(
    args.some((a) => a.includes(HOOK_BASENAME)),
    `o hook ${HOOK_BASENAME} precisa estar no grupo PreToolUse/Bash — sem isso o guard não intercepta npm ci nenhum`,
  );
  assert.ok(existsSync(join(repoRoot, ".claude/hooks", HOOK_BASENAME)));
});

test("package.json NÃO declara preinstall pro guard (é inerte no npm ci)", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.ok(
    !/guard-node-modules-symlink|worktree-node-modules-guard/.test(pkg.scripts?.preinstall ?? ""),
    "preinstall roda DEPOIS de o npm ci apagar node_modules — não use esse caminho, o hook PreToolUse é o enforcement",
  );
});

test("hook nega npm ci quando node_modules escapa do diretório", async () => {
  const hook = await import(`../.claude/hooks/${HOOK_BASENAME}`);
  const inspect = (dir: string) => (dir === "/wt" ? "/principal/node_modules" : null);
  const hit = hook.findBlockedNpmInstall("npm ci", "/wt", inspect);
  assert.ok(hit);
  assert.match(hook.blockReason(hit), /\[GUARD #7763\]/);
  assert.equal(hook.findBlockedNpmInstall("npm ci", "/outro", inspect), null);
});

test("hook rastreia cd e --prefix, e ignora npm que não instala", async () => {
  const hook = await import(`../.claude/hooks/${HOOK_BASENAME}`);
  const inspect = (dir: string) => (dir.replaceAll("\\", "/").endsWith("/wt") ? "/principal/node_modules" : null);
  assert.ok(hook.findBlockedNpmInstall("cd /wt && npm ci", "/qualquer", inspect), "cd deve mover o alvo");
  assert.ok(hook.findBlockedNpmInstall("npm install --prefix /wt", "/qualquer", inspect), "--prefix deve mover o alvo");
  assert.equal(hook.findBlockedNpmInstall("cd /wt && npm run build", "/x", inspect), null, "npm run não reinstala");
  assert.equal(hook.findBlockedNpmInstall("cd /wt && npm test", "/x", inspect), null, "npm test não reinstala");
});

// Dois achados do review da PR #7774, ambos reproduzidos ao vivo antes do fix:
// (1) BYPASS — `bash -c "cd /wt && npm ci"` passava batido, porque o split
//     ingênuo por separadores quebrava dentro da string citada e o `npm ci"`
//     resultante não casava com a regex. O hook irmão resolve casos assim com
//     `stripQuotedSpans`, que aqui seria pior: DESCARTA justamente o comando
//     perigoso. A saída foi promover o argumento de wrappers conhecidos.
// (2) FALSO POSITIVO — um heredoc que só MENCIONA `npm ci` (README, corpo de
//     issue) era negado como se estivesse instalando.
test("hook não é enganado por wrapper de shell nem por heredoc (#7774)", async () => {
  const hook = await import(`../.claude/hooks/${HOOK_BASENAME}`);
  const inspect = (dir: string) => (dir.replaceAll("\\", "/").endsWith("/wt") ? "/principal/node_modules" : null);
  const blocked = (cmd: string, cwd = "/x") => Boolean(hook.findBlockedNpmInstall(cmd, cwd, inspect));

  // Bypass: o comando real está DENTRO das aspas do wrapper.
  assert.ok(blocked('bash -c "cd /wt && npm ci"'), "bash -c com aspas duplas");
  assert.ok(blocked("sh -c 'cd /wt && npm install'"), "sh -c com aspas simples");
  assert.ok(blocked('powershell -Command "cd /wt; npm ci"'), "powershell -Command");
  assert.ok(blocked('cmd /c "cd /wt && npm ci"'), "cmd /c");
  assert.ok(blocked('bash -c "bash -c \\"cd /wt && npm ci\\""'), "wrapper aninhado (escape de aspas)");

  // Falso positivo: heredoc que só cita o comando como texto.
  assert.equal(blocked("cat <<EOF\ncd /wt\nnpm ci\nEOF", "/wt"), false, "corpo de heredoc é texto, não comando");
  // E string citada que NÃO é argumento de wrapper continua fora do radar.
  assert.equal(blocked('git commit -m "roda npm ci"', "/wt"), false, "mensagem de commit não é comando");
});

// Rodada seguinte do mesmo review, os dois também reproduzidos antes do fix:
// (1) BYPASS — subshell (`(cd /wt && npm ci)`) e command substitution
//     (`$(...)`) deixavam um `)` colado no segmento, e `isNpmInstallSegment`
//     exige espaço ou fim de string depois do subcomando. Subshell é a forma
//     idiomática de rodar algo num diretório sem mexer no `cd` da sessão —
//     mais provável, aqui, que o `bash -c` da rodada anterior.
// (2) FALSO POSITIVO — o wrapper era reconhecido em QUALQUER posição do texto,
//     então `echo "use bash -c 'npm ci'"` tinha o miolo promovido a comando.
//     Mesma classe do falso positivo do heredoc, por outra porta: agora o
//     wrapper só conta quando ABRE o segmento (posição de comando).
test("hook cobre subshell e não reage a wrapper citado como texto (#7774)", async () => {
  const hook = await import(`../.claude/hooks/${HOOK_BASENAME}`);
  const inspect = (dir: string) => (dir.replaceAll("\\", "/").endsWith("/wt") ? "/principal/node_modules" : null);
  const blocked = (cmd: string, cwd = "/x") => Boolean(hook.findBlockedNpmInstall(cmd, cwd, inspect));

  assert.ok(blocked("(cd /wt && npm ci)"), "subshell");
  assert.ok(blocked("RESULT=$(cd /wt && npm ci)"), "command substitution");
  assert.ok(blocked("cd /wt && (npm ci)"), "subshell só com o install");
  assert.ok(blocked("npm ci &", "/wt"), "background");
  assert.ok(blocked("/usr/bin/npm ci", "/wt"), "npm por caminho absoluto");

  assert.equal(blocked(`echo "ver bash -c 'npm ci' no guard"`, "/wt"), false, "wrapper citado dentro de echo é texto");
  assert.equal(blocked(`git log --grep "bash -c \\"npm ci\\""`, "/wt"), false, "wrapper citado num --grep é texto");
  assert.equal(blocked("npm ls", "/wt"), false, "npm ls não reinstala");
  assert.equal(blocked("cd /outro && npm ci"), false, "diretório sem symlink segue liberado");
});

// Terceiro par de achados do mesmo review: ancorar o wrapper em `^` para matar
// o falso positivo do texto citado passou a exigir que ele ABRISSE o segmento,
// e com isso `sudo bash -c "npm ci"` / `FOO=bar bash -c "npm ci"` — que a
// versão anterior pegava — escaparam. O prefixo que não muda QUAL comando roda
// (atribuição inline + no-op como sudo/env/exec/nice/command/time/nohup) passou
// a ser reconhecido, e vale igual para o `npm` direto: `sudo npm ci` instala
// como qualquer outro. `{ ...; }` fechou junto, pela mesma porta do subshell.
test("hook enxerga através de sudo/env/atribuição inline e de agrupamento (#7774)", async () => {
  const hook = await import(`../.claude/hooks/${HOOK_BASENAME}`);
  const inspect = (dir: string) => (dir.replaceAll("\\", "/").endsWith("/wt") ? "/principal/node_modules" : null);
  const blocked = (cmd: string, cwd = "/wt") => Boolean(hook.findBlockedNpmInstall(cmd, cwd, inspect));

  // npm direto atrás de prefixo no-op.
  assert.ok(blocked("sudo npm ci"), "sudo npm ci");
  assert.ok(blocked("env FOO=bar npm ci"), "env com atribuição");
  assert.ok(blocked("FOO=bar npm ci"), "atribuição inline");

  // Wrapper de shell atrás do mesmo prefixo.
  assert.ok(blocked('sudo bash -c "npm ci"'), "sudo + wrapper");
  assert.ok(blocked('env FOO=bar bash -c "npm ci"'), "env + wrapper");
  assert.ok(blocked('TERM=xterm bash -c "cd /wt && npm ci"', "/x"), "atribuição + wrapper + cd");
  assert.ok(blocked('nice bash -c "npm ci"'), "nice");
  assert.ok(blocked('exec bash -c "npm ci"'), "exec");
  assert.ok(blocked('command bash -c "npm ci"'), "command");
  assert.ok(blocked('nohup bash -c "npm ci"'), "nohup");

  // Agrupamento por chaves, mesma porta do subshell.
  assert.ok(blocked("{ cd /wt && npm ci; }", "/x"), "agrupamento por chaves");

  // O reconhecimento por posição estrutural não reabre o falso positivo do
  // texto citado.
  assert.equal(blocked(`gh pr comment 1 --body "rode npm ci depois"`), false, "corpo de comentário é texto");
  assert.equal(blocked("npx tsx scripts/x.ts"), false, "npx não é npm install");
});

// Última rodada do review da PR #7774. A enumeração de prefixos foi trocada
// por um critério ESTRUTURAL — "está fora de aspas?" — porque cada rodada que
// listava o que pode vir antes do comando (`FOO=bar`, `sudo`, depois as flags
// de cada um) fechava os casos citados e o review devolvia outros:
// `sudo -p 'senha:'`, `sudo -a`, `sudo -t 30`, `--preserve-env=`. A lista de
// flags de `sudo`/`env` é aberta demais para enumerar, e o lado errado do erro
// aqui é "não bloqueia".
test("hook reconhece npm/wrapper por posição estrutural, não por lista de prefixos (#7774)", async () => {
  const hook = await import(`../.claude/hooks/${HOOK_BASENAME}`);
  const inspect = (dir: string) => (dir.replaceAll("\\", "/").endsWith("/wt") ? "/principal/node_modules" : null);
  const blocked = (cmd: string, cwd = "/wt") => Boolean(hook.findBlockedNpmInstall(cmd, cwd, inspect));

  // Prefixos que nenhuma lista previa — todos bloqueiam agora.
  assert.ok(blocked("sudo -p 'senha:' npm ci"), "flag com valor citado");
  assert.ok(blocked("sudo -a pam npm ci"), "flag de auth com valor");
  assert.ok(blocked("sudo -t 30 npm ci"), "flag de timeout com valor");
  assert.ok(blocked("sudo --preserve-env=PATH npm ci"), "--flag=valor");
  assert.ok(blocked("nice -n 10 npm ci"), "nice com nível");
  assert.ok(blocked("timeout 300 npm ci"), "wrapper que nunca esteve na lista");
  assert.ok(blocked("xargs -I{} npm ci"), "wrapper com chave no argumento");
  assert.ok(blocked("sudo -p 'senha:' bash -c \"npm ci\""), "prefixo arbitrário + wrapper");

  // Os que a enumeração já pegava seguem pegando.
  assert.ok(blocked("sudo -u foo npm ci"), "sudo -u");
  assert.ok(blocked("env -i npm ci"), "env -i");
  assert.ok(blocked("sudo -E -H npm ci"), "flags encadeadas");
  assert.ok(blocked(`NODE_OPTIONS="--stack-size 4096" npm ci`), "valor citado com espaço");
  assert.ok(blocked(`NPM_CONFIG_CACHE='/tmp/a b' npm ci`), "valor citado com aspas simples");
  assert.ok(blocked(`sudo -u foo bash -c "npm ci"`), "flag com valor + wrapper");

  // E o critério continua distinguindo comando de texto.
  assert.equal(blocked("A=B npm run test"), false, "npm run não reinstala");
  assert.equal(blocked(`curl --data '{"a":1}' http://x`), false, "JSON citado não vira comando");
  assert.equal(blocked(`gh issue create --body "veja: npm install falha"`), false, "corpo de issue é texto");
  assert.equal(blocked(`git commit -m 'fix: npm install lento'`), false, "mensagem de commit é texto");
});

// Achado do review da PR #7848: mascarar TODO span citado desligava a detecção
// quando o próprio nome do programa vinha citado — `"npm" ci` roda exatamente
// como `npm ci`. A distinção que resolve, sem parser de shell: span citado SEM
// espaço dentro é um token (nome de programa), span COM espaço é prosa.
test("nome de programa citado é token, não texto (#7848)", async () => {
  const hook = await import(`../.claude/hooks/${HOOK_BASENAME}`);
  const inspect = (dir: string) => (dir.replaceAll("\\", "/").endsWith("/wt") ? "/principal/node_modules" : null);
  const blocked = (cmd: string, cwd = "/wt") => Boolean(hook.findBlockedNpmInstall(cmd, cwd, inspect));

  assert.ok(blocked(`"npm" ci`), "npm citado com aspas duplas");
  assert.ok(blocked(`'npm' install`), "npm citado com aspas simples");
  assert.ok(blocked(`'bash' -c "npm ci"`), "binário do wrapper citado");
  assert.ok(blocked(`"npm" ci --prefix /wt`, "/x"), "npm citado + --prefix");

  // Span COM espaço segue sendo prosa — é o que separa token de texto.
  assert.equal(blocked(`gh issue create --title "npm"`), false, "argumento citado de uma palavra não é comando");
  assert.equal(blocked(`echo "npm" && echo ok`), false, "eco de uma palavra não é npm install");
  assert.equal(blocked(`git commit -m "roda npm ci"`), false, "prosa citada segue sendo texto");

  // Só o token que ABRE o segmento vale como nome de programa: sem isso, dois
  // argumentos citados adjacentes de OUTRO programa se juntavam num `npm ci`
  // que ninguém invocou (falso positivo do mesmo review).
  assert.equal(blocked(`echo "npm" "ci"`), false, "dois argumentos citados adjacentes não são um comando");
  assert.equal(blocked(`assert_equal "npm" "ci"`), false, "assertion com dois argumentos citados");
  assert.equal(blocked(`printf "%s" "npm" "install"`), false, "printf com argumentos citados");
});

// `maskQuotedSpans` precisa preservar OFFSET, não só esconder texto: o payload
// do wrapper é lido no texto ORIGINAL a partir do índice casado na versão
// mascarada. Escape (`\"`) ocupa 2 caracteres no original e 1 no valor lido,
// então o span mascarado é preenchido até a largura original.
test("maskQuotedSpans preserva comprimento e offsets", async () => {
  const hook = await import(`../.claude/hooks/${HOOK_BASENAME}`);
  for (const input of [
    `git commit -m "roda npm ci"`,
    `bash -c "bash -c \\"npm ci\\""`,
    `echo "a\\"b" fim`,
    `'npm' ci`,
    `"aspas nao fechadas`,
    ``,
  ]) {
    assert.equal(hook.maskQuotedSpans(input).length, input.length, `comprimento preservado em: ${input}`);
  }
});

// O hook é self-contained (nenhum import de `.ts`, convenção dos hooks
// irmãos), então a paridade com a lib precisa ser travada por teste.
test("hook e lib concordam nos mesmos casos (paridade do guard duplicado)", async () => {
  const hook = await import(`../.claude/hooks/${HOOK_BASENAME}`);
  withTmp((tmp) => {
    const outside = mkdtempSync(join(tmpdir(), "wt-7763-principal-"));
    try {
      // 1. symlink externo → ambos bloqueiam
      mkdirSync(join(outside, "node_modules"), { recursive: true });
      symlinkSync(join(outside, "node_modules"), join(tmp, "node_modules"), "junction");
      assert.equal(checkNodeModulesSymlink(tmp).blocked, true);
      assert.ok(hook.nodeModulesEscapesDir(tmp));
      rmSync(join(tmp, "node_modules"), { recursive: true, force: true });

      // 2. ausente → ambos liberam
      assert.equal(checkNodeModulesSymlink(tmp).blocked, false);
      assert.equal(hook.nodeModulesEscapesDir(tmp), null);

      // 3. diretório real → ambos liberam
      mkdirSync(join(tmp, "node_modules"), { recursive: true });
      assert.equal(checkNodeModulesSymlink(tmp).blocked, false);
      assert.equal(hook.nodeModulesEscapesDir(tmp), null);
      rmSync(join(tmp, "node_modules"), { recursive: true, force: true });

      // 4. symlink intra-worktree → ambos liberam
      const inner = join(tmp, "vendor-node-modules");
      mkdirSync(inner, { recursive: true });
      symlinkSync(inner, join(tmp, "node_modules"), "junction");
      assert.equal(checkNodeModulesSymlink(tmp).blocked, false);
      assert.equal(hook.nodeModulesEscapesDir(tmp), null);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
