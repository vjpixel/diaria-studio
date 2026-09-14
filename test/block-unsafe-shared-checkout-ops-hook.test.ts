import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  isTaskkillByImageCommand,
  TASKKILL_BLOCK_REASON,
  isRmCommand,
  extractRmTargetPaths,
  isPathInsideCheckout,
  isLinkedWorktree,
  sessionsDir,
  normalizeBeaconPath,
  beaconPathsOverlap,
  extractPorcelainPath,
  readOwnSessionPaths,
  readGitPorcelainPaths,
  computeForeignDirtyPaths,
  shouldBlockSharedCheckoutRm,
  RM_BLOCK_REASON,
  stripQuotedSpans,
  stripHeredocSpans,
  extractRmTargetsWithCwd,
  detectDestructiveGitTarget,
  shouldBlockSharedCheckoutGitDestructive,
  GIT_DESTRUCTIVE_BLOCK_REASON,
} from "../.claude/hooks/block-unsafe-shared-checkout-ops.mjs";

// Lote `guards-de-subagente` (01/09/2026) — #6982 (taskkill /IM) + #6971 (rm
// no checkout compartilhado), empacotados num único hook por decisão
// explícita de dispatch ("prefira um hook coeso a dois hooks quase iguais").

describe("isTaskkillByImageCommand (#6982)", () => {
  it("detecta 'taskkill /F /IM <nome>' standalone", () => {
    assert.equal(isTaskkillByImageCommand("taskkill /F /IM python.exe"), true);
  });

  it("detecta variantes de flag: /im, -IM, --IM, //IM (MSYS duplica barra)", () => {
    assert.equal(isTaskkillByImageCommand("taskkill /im python.exe"), true);
    assert.equal(isTaskkillByImageCommand("taskkill -IM python.exe"), true);
    assert.equal(isTaskkillByImageCommand("taskkill --IM python.exe"), true);
    assert.equal(isTaskkillByImageCommand("taskkill //F //IM node.exe //T"), true);
  });

  it("detecta com path completo do executável", () => {
    assert.equal(isTaskkillByImageCommand("C:\\Windows\\System32\\taskkill.exe /IM node.exe"), true);
  });

  it("detecta dentro de comando encadeado", () => {
    assert.equal(isTaskkillByImageCommand("cd repo && taskkill /F /IM python.exe"), true);
    assert.equal(isTaskkillByImageCommand("echo done; taskkill /IM python.exe"), true);
  });

  it("ordem das flags trocada ainda casa", () => {
    assert.equal(isTaskkillByImageCommand("taskkill /IM python.exe /F"), true);
  });

  it("NÃO detecta 'taskkill /PID <n>' — uso CORRETO, deve PASSAR", () => {
    assert.equal(isTaskkillByImageCommand("taskkill /F /PID 1234"), false);
    assert.equal(isTaskkillByImageCommand("taskkill /PID 1234"), false);
  });

  it("NÃO detecta comando não-taskkill", () => {
    assert.equal(isTaskkillByImageCommand("npm run build -im"), false);
    assert.equal(isTaskkillByImageCommand("kill -9 1234"), false);
  });

  it("NÃO detecta 'taskkill /IM' citado dentro de um argumento (--body)", () => {
    assert.equal(
      isTaskkillByImageCommand('gh issue create --body "nunca rode taskkill /IM node.exe"'),
      false,
    );
  });

  it("tipo não-string devolve false", () => {
    assert.equal(isTaskkillByImageCommand(undefined), false);
    assert.equal(isTaskkillByImageCommand(null), false);
  });
});

describe("TASKKILL_BLOCK_REASON (#6982)", () => {
  it("cita a issue de origem e orienta matar por PID", () => {
    assert.match(TASKKILL_BLOCK_REASON, /#6982/);
    assert.match(TASKKILL_BLOCK_REASON, /PID/);
  });
});

describe("isRmCommand / extractRmTargetPaths (#6971)", () => {
  it("detecta 'rm' standalone e extrai paths, ignorando flags", () => {
    assert.equal(isRmCommand("rm -f foo.md"), true);
    assert.deepEqual(extractRmTargetPaths("rm -f foo.md"), ["foo.md"]);
    assert.deepEqual(extractRmTargetPaths("rm -rf /tmp/x /tmp/y"), ["/tmp/x", "/tmp/y"]);
  });

  it("detecta dentro de comando encadeado", () => {
    assert.equal(isRmCommand("cd repo && rm -f foo.md"), true);
    assert.equal(isRmCommand("ls; rm foo.md"), true);
  });

  it("NÃO detecta comando não-rm (ex: 'npm run rm-cache')", () => {
    assert.equal(isRmCommand("npm run rm-cache"), false);
  });

  it("NÃO detecta 'rm' citado dentro de argumento (--body)", () => {
    assert.equal(isRmCommand('gh issue create --body "rode rm -f depois"'), false);
  });

  it("tipo não-string devolve false/[]", () => {
    assert.equal(isRmCommand(undefined), false);
    assert.deepEqual(extractRmTargetPaths(undefined), []);
  });
});

describe("stripQuotedSpans (#6971/#6982)", () => {
  it("remove conteúdo entre aspas simples e duplas, preserva o resto", () => {
    assert.equal(stripQuotedSpans('echo "a b c" && rm -f x'), "echo  && rm -f x");
  });
});

describe("isPathInsideCheckout (#6971)", () => {
  const root = process.platform === "win32" ? "C:\\repo" : "/repo";

  it("path absoluto dentro do checkout → true", () => {
    const p = process.platform === "win32" ? "C:\\repo\\.pr6950-review.md" : "/repo/.pr6950-review.md";
    assert.equal(isPathInsideCheckout(p, root), true);
  });

  it("path relativo resolve contra checkoutRoot → true", () => {
    assert.equal(isPathInsideCheckout(".pr6950-review.md", root), true);
  });

  it("path absoluto FORA do checkout → false (deve PASSAR)", () => {
    const p = process.platform === "win32" ? "C:\\tmp\\x.md" : "/tmp/x.md";
    assert.equal(isPathInsideCheckout(p, root), false);
  });

  it("path vazio/tipo inválido → false", () => {
    assert.equal(isPathInsideCheckout("", root), false);
    assert.equal(isPathInsideCheckout(undefined, root), false);
  });
});

describe("isLinkedWorktree (#6971)", () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  function freshRoot(): string {
    const root = join(tmpdir(), `rm-hook-worktree-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    mkdirSync(root, { recursive: true });
    return root;
  }

  it("'.git' como DIRETÓRIO → checkout principal (false)", () => {
    const root = freshRoot();
    mkdirSync(join(root, ".git"));
    assert.equal(isLinkedWorktree(root), false);
  });

  it("'.git' como ARQUIVO com 'gitdir:' → worktree vinculado (true)", () => {
    const root = freshRoot();
    writeFileSync(join(root, ".git"), "gitdir: /some/main/.git/worktrees/agent-x\n", "utf8");
    assert.equal(isLinkedWorktree(root), true);
  });
});

// ---------------------------------------------------------------------------
// #8107 — modelo "sujeira PRÓPRIA vs ALHEIA", substitui o modelo anterior
// ("bloqueia só quando existe coordenadora overnight/develop/continuo
// ATIVA") pros Guards 2 e 3. Ver docblock da seção "Shared" do hook.
// ---------------------------------------------------------------------------

describe("normalizeBeaconPath / beaconPathsOverlap / extractPorcelainPath (#8107)", () => {
  it("normalizeBeaconPath: normaliza separador, remove './' e barra final", () => {
    assert.equal(normalizeBeaconPath("a\\b\\c"), "a/b/c");
    assert.equal(normalizeBeaconPath("./a/b"), "a/b");
    assert.equal(normalizeBeaconPath("a/b/"), "a/b");
  });

  it("beaconPathsOverlap: iguais, ou um é prefixo de DIRETÓRIO do outro", () => {
    assert.equal(beaconPathsOverlap("a/b", "a/b"), true);
    assert.equal(beaconPathsOverlap("a", "a/b/c"), true);
    assert.equal(beaconPathsOverlap("a/b/c", "a"), true);
    assert.equal(beaconPathsOverlap("a/b", "a/bc"), false); // não é prefixo de DIRETÓRIO
    assert.equal(beaconPathsOverlap("", "a"), false);
  });

  it("extractPorcelainPath: extrai o caminho de uma linha 'XY caminho'", () => {
    assert.equal(extractPorcelainPath(" M scripts/lib/foo.ts"), "scripts/lib/foo.ts");
    assert.equal(extractPorcelainPath("?? novo-arquivo.md"), "novo-arquivo.md");
  });

  it("extractPorcelainPath: rename 'XY orig -> novo' usa o lado NOVO", () => {
    assert.equal(extractPorcelainPath("R  velho.md -> novo.md"), "novo.md");
  });

  it("extractPorcelainPath: rename com 'C' (copy) na posição Y também usa o lado NOVO", () => {
    assert.equal(extractPorcelainPath(" C velho.md -> novo.md"), "novo.md");
  });

  it("extractPorcelainPath: NÃO trata como rename um arquivo untracked/modificado cujo NOME contém ' -> ' (achado silent-failure-hunter #8107)", () => {
    // Regressão: sem checar o status (RC), um nome de arquivo real contendo
    // a substring literal " -> " (plausível — rascunho tipo "plano -> v2.md")
    // era cortado incorretamente pro que vem depois da seta, devolvendo um
    // path que não existe. Isso fazia `computeForeignDirtyPaths` carregar o
    // caminho ERRADO adiante, e um `rm`/`git restore` no arquivo REAL nunca
    // batia contra ele — o comando destrutivo passava sem bloqueio.
    assert.equal(extractPorcelainPath("?? plano -> v2.md"), "plano -> v2.md");
    assert.equal(extractPorcelainPath(" M plano -> v2.md"), "plano -> v2.md");
  });
});

describe("readOwnSessionPaths (#8107) — fail-CLOSED sempre que a atribuição é incerta", () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  function freshRoot(): string {
    const root = join(tmpdir(), `own-paths-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    return root;
  }
  function writeSession(root: string, filename: string, record: Record<string, unknown>) {
    const dir = sessionsDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), JSON.stringify(record), "utf8");
  }

  it("session_id ausente/vazio → [] (fail-closed)", () => {
    const root = freshRoot();
    assert.deepEqual(readOwnSessionPaths(root, undefined), []);
    assert.deepEqual(readOwnSessionPaths(root, ""), []);
  });

  it("diretório de sessões ausente → [] (fail-closed)", () => {
    assert.deepEqual(readOwnSessionPaths(freshRoot(), "sess1"), []);
  });

  it("sessão registrada SEM touched_paths/dirty_paths → [] (fail-closed — registro antigo)", () => {
    const root = freshRoot();
    writeSession(root, "interactive-tag-sess1.json", { kind: "interactive", sessionId: "sess1" });
    assert.deepEqual(readOwnSessionPaths(root, "sess1"), []);
  });

  it("sessão registrada COM touched_paths/dirty_paths → devolve a união normalizada", () => {
    const root = freshRoot();
    writeSession(root, "interactive-tag-sess1.json", {
      kind: "interactive",
      sessionId: "sess1",
      touched_paths: ["a\\b.md", "c/d.md"],
      dirty_paths: ["c/d.md", "e/f.md"],
    });
    assert.deepEqual(readOwnSessionPaths(root, "sess1").sort(), ["a/b.md", "c/d.md", "e/f.md"]);
  });

  it("casa QUALQUER kind pelo sufixo '-{sessionId}.json' (#8107 — antes só coordenadora)", () => {
    const root = freshRoot();
    writeSession(root, "develop-300-devsess.json", {
      touched_paths: ["scripts/lib/foo.ts"],
    });
    assert.deepEqual(readOwnSessionPaths(root, "devsess"), ["scripts/lib/foo.ts"]);
  });

  it("JSON malformado → [] (fail-closed, nunca lança)", () => {
    const root = freshRoot();
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(join(sessionsDir(root), "interactive-tag-broken.json"), "{not valid json", "utf8");
    assert.deepEqual(readOwnSessionPaths(root, "broken"), []);
  });

  it("ignora backups '-safeBackup-' ao casar o sufixo", () => {
    const root = freshRoot();
    writeSession(root, "interactive-tag-sess1-safeBackup-0001.json", {
      touched_paths: ["nao-deveria-contar.md"],
    });
    assert.deepEqual(readOwnSessionPaths(root, "sess1"), []);
  });
});

describe("readGitPorcelainPaths (#8107) — fail-OPEN (null) quando git falha", () => {
  it("repo real, limpo → array vazio (não null)", () => {
    // Usa o próprio checkout de teste (cwd do test runner) — só garante que
    // a chamada tem sucesso e devolve um array (não valida o CONTEÚDO, que
    // varia com o estado real do checkout).
    const result = readGitPorcelainPaths(process.cwd());
    assert.equal(Array.isArray(result), true);
  });

  it("diretório que não é um repo git → null (fail-open)", () => {
    const dir = join(tmpdir(), `not-a-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      assert.equal(readGitPorcelainPaths(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cwd inexistente → null (fail-open, nunca lança)", () => {
    // execFileSync recusa um cwd que não existe (ENOENT) — mesma classe de
    // falha de I/O que um timeout real produziria; cobre o fail-open sem
    // depender de forçar um timeout genuíno (frágil entre plataformas, já
    // que `git status` costuma responder bem abaixo de qualquer timeout
    // pequeno o suficiente pra não flakear o teste).
    const missingDir = join(tmpdir(), `missing-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    assert.equal(readGitPorcelainPaths(missingDir), null);
  });
});

describe("computeForeignDirtyPaths (#8107)", () => {
  it("null (git status falhou) propaga null", () => {
    assert.equal(computeForeignDirtyPaths(null, ["a.md"]), null);
  });

  it("sujeira que sobrepõe ownPaths não conta como alheia", () => {
    assert.deepEqual(computeForeignDirtyPaths(["a.md", "b/c.md"], ["a.md"]), ["b/c.md"]);
  });

  it("ownPaths cobre DIRETÓRIO inteiro — sujeira dentro dele não é alheia", () => {
    assert.deepEqual(computeForeignDirtyPaths(["a/b.md", "a/c.md", "d.md"], ["a"]), ["d.md"]);
  });

  it("sem ownPaths (undefined/[]) — toda sujeira é alheia", () => {
    assert.deepEqual(computeForeignDirtyPaths(["a.md", "b.md"], []), ["a.md", "b.md"]);
    assert.deepEqual(computeForeignDirtyPaths(["a.md"], undefined), ["a.md"]);
  });

  it("árvore limpa → []", () => {
    assert.deepEqual(computeForeignDirtyPaths([], ["a.md"]), []);
  });
});

describe("shouldBlockSharedCheckoutRm (#6971, modelo próprio/alheio do #8107)", () => {
  const root = process.platform === "win32" ? "C:\\repo" : "/repo";
  const insidePath = process.platform === "win32" ? "C:\\repo\\.pr6950-review.md" : "/repo/.pr6950-review.md";
  const outsidePath = process.platform === "win32" ? "C:\\tmp\\x.md" : "/tmp/x.md";

  it("(a) cenário do incidente #8107: SEM coordenadora nenhuma registrada, sujeira alheia real → bloqueia", () => {
    // O cenário exato do incidente: nenhuma rodada coordenadora ativa (já
    // encerrou o registro), mas o arquivo-alvo é sujeira genuína de OUTRA
    // sessão. O modelo antigo (coordenadora ativa) deixaria passar; o novo
    // bloqueia porque o alvo intersecta `foreignDirtyPaths`.
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [insidePath],
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths: [".pr6950-review.md"],
      }),
      true,
    );
  });

  it("(b) sessão sem beacon de paths tentando destrutivo com sujeira alheia → bloqueia (fail-safe)", () => {
    // ownPaths vazio (sessão sem beacon) já vira `foreignDirtyPaths` contendo
    // TUDO que está sujo — simulado aqui passando o `computeForeignDirtyPaths`
    // real com ownPaths=[] pra deixar o encadeamento explícito.
    const foreignDirtyPaths = computeForeignDirtyPaths([".pr6950-review.md"], []);
    assert.equal(
      shouldBlockSharedCheckoutRm({ targetPaths: [insidePath], checkoutRoot: root, isWorktree: false, foreignDirtyPaths }),
      true,
    );
  });

  it("(c) sujeira é só a PRÓPRIA sessão (touched_paths bate) → permite", () => {
    const foreignDirtyPaths = computeForeignDirtyPaths([".pr6950-review.md"], [".pr6950-review.md"]);
    assert.deepEqual(foreignDirtyPaths, []);
    assert.equal(
      shouldBlockSharedCheckoutRm({ targetPaths: [insidePath], checkoutRoot: root, isWorktree: false, foreignDirtyPaths }),
      false,
    );
  });

  it("(d) git status --porcelain falha → fail-open, permite", () => {
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [insidePath],
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths: null,
      }),
      false,
    );
  });

  it("permite: é um worktree vinculado (rm no próprio worktree do subagente é normal)", () => {
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [insidePath],
        checkoutRoot: root,
        isWorktree: true,
        foreignDirtyPaths: [".pr6950-review.md"],
      }),
      false,
    );
  });

  it("permite: rm FORA do repo (deve PASSAR) mesmo com sujeira alheia real na árvore", () => {
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [outsidePath],
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths: [".pr6950-review.md"],
      }),
      false,
    );
  });

  it("permite: árvore inteiramente limpa (foreignDirtyPaths vazio)", () => {
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [insidePath],
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths: [],
      }),
      false,
    );
  });

  it("permite: sujeira alheia existe, mas em OUTRO arquivo que o rm não visa", () => {
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [insidePath],
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths: ["outro-arquivo.md"],
      }),
      false,
    );
  });

  it("múltiplos targetPaths — só UM sobrepõe sujeira alheia → bloqueia (achado pr-test-analyzer #8109)", () => {
    const otherInsidePath =
      process.platform === "win32" ? "C:\\repo\\arquivo-limpo.md" : "/repo/arquivo-limpo.md";
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [otherInsidePath, insidePath],
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths: [".pr6950-review.md"],
      }),
      true,
    );
  });

  it("múltiplos targetPaths — NENHUM sobrepõe sujeira alheia → permite", () => {
    const otherInsidePath =
      process.platform === "win32" ? "C:\\repo\\arquivo-limpo.md" : "/repo/arquivo-limpo.md";
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [otherInsidePath, insidePath],
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths: ["outro-arquivo-que-ninguem-visa.md"],
      }),
      false,
    );
  });

  it("targetPath resolve pro próprio checkoutRoot ('.') → atinge QUALQUER sujeira alheia (branch antes não coberto)", () => {
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: ["."],
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths: ["qualquer/arquivo.md"],
      }),
      true,
    );
  });
});

describe("RM_BLOCK_REASON (#6971/#8107)", () => {
  it("cita as duas issues de origem e o checkout principal", () => {
    assert.match(RM_BLOCK_REASON, /#6971/);
    assert.match(RM_BLOCK_REASON, /#8107/);
    assert.match(RM_BLOCK_REASON, /checkout principal/);
  });
});

// ---------------------------------------------------------------------------
// #7757 — 2 falsos-positivos do Guard 2 (#6971): path relativo resolvido
// contra o project root em vez do cwd EFETIVO, e casamento com a MENÇÃO do
// comando dentro de heredoc. Testes de regressão (a)-(e) literalmente
// listados na issue.
// ---------------------------------------------------------------------------

describe("stripHeredocSpans (#7757 Modo 2)", () => {
  it("remove o CORPO de um heredoc, preserva a linha de abertura e o que vem depois", () => {
    const cmd = 'cat <<EOF > file.md\nrm -f /home/x/y\nEOF\necho done';
    const stripped = stripHeredocSpans(cmd);
    assert.match(stripped, /^cat <<EOF > file\.md\n/);
    assert.doesNotMatch(stripped, /rm -f \/home\/x\/y/);
    assert.match(stripped, /echo done/);
  });

  it("respeita delimitador entre aspas simples ('EOF') — sem expansão, mesma extração", () => {
    const cmd = "cat <<'EOF' > file.md\nrm -f /a\nEOF\n";
    assert.doesNotMatch(stripHeredocSpans(cmd), /rm -f \/a/);
  });

  it("respeita '<<-' (permite indentação na linha terminadora)", () => {
    const cmd = "cat <<-EOF > file.md\n  rm -f /a\n  EOF\necho ok";
    const stripped = stripHeredocSpans(cmd);
    assert.doesNotMatch(stripped, /rm -f \/a/);
    assert.match(stripped, /echo ok/);
  });

  it("sem heredoc no comando: devolve inalterado", () => {
    assert.equal(stripHeredocSpans("rm -f foo.md"), "rm -f foo.md");
  });

  it("tipo não-string: devolve como veio", () => {
    assert.equal(stripHeredocSpans(undefined), undefined);
  });
});

describe("isRmCommand não casa MENÇÃO dentro de heredoc (#7757 Modo 2, teste (e) da issue)", () => {
  it("gh issue create --body-file cujo heredoc descreve 'rm -f X' → NÃO detecta rm real", () => {
    const cmd =
      "cat <<'EOF' > /tmp/body.md\n" +
      "O guard bloqueou um comando `rm -f /home/x/data.md` que nunca rodou.\n" +
      "EOF\n" +
      "gh issue create --title 'bug' --body-file /tmp/body.md";
    assert.equal(isRmCommand(cmd), false);
    assert.deepEqual(extractRmTargetPaths(cmd), []);
  });
});

describe("extractRmTargetsWithCwd / isPathInsideCheckout com cwd (#7757 Modo 1)", () => {
  const checkoutRoot = process.platform === "win32" ? "C:\\repo" : "/repo";
  const outsideDir = process.platform === "win32" ? "C:\\Users\\x\\memory" : "/home/x/memory";
  const insideSubdir = process.platform === "win32" ? "C:\\repo\\sub" : "/repo/sub";

  it("(a) cd <dir FORA do checkout> && rm <relativo> → resolve contra o cwd real, FORA do checkout", () => {
    const cmd = `cd "${outsideDir}" && rm -f project_x.md`;
    const targets = extractRmTargetsWithCwd(cmd, checkoutRoot);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].path, "project_x.md");
    assert.equal(isPathInsideCheckout(targets[0].path, checkoutRoot, targets[0].cwd), false);
  });

  it("(b) cd <subdir DO checkout> && rm <relativo> → segue DENTRO do checkout", () => {
    const cmd = `cd "${insideSubdir}" && rm -f leftover.md`;
    const targets = extractRmTargetsWithCwd(cmd, checkoutRoot);
    assert.equal(targets.length, 1);
    assert.equal(isPathInsideCheckout(targets[0].path, checkoutRoot, targets[0].cwd), true);
  });

  it("(c) path ABSOLUTO fora do checkout, sem cd → FORA (cwd é irrelevante pra absoluto)", () => {
    const abs = process.platform === "win32" ? "C:\\tmp\\x.md" : "/tmp/x.md";
    const targets = extractRmTargetsWithCwd(`rm -f ${abs}`, checkoutRoot);
    assert.equal(isPathInsideCheckout(targets[0].path, checkoutRoot, targets[0].cwd), false);
  });

  it("(d) path ABSOLUTO dentro do checkout, sem cd → DENTRO", () => {
    const abs = process.platform === "win32" ? "C:\\repo\\x.md" : "/repo/x.md";
    const targets = extractRmTargetsWithCwd(`rm -f ${abs}`, checkoutRoot);
    assert.equal(isPathInsideCheckout(targets[0].path, checkoutRoot, targets[0].cwd), true);
  });

  it("sem 'cd': cwd efetivo é o initialCwd (checkoutRoot) — mesmo comportamento de antes", () => {
    const targets = extractRmTargetsWithCwd("rm -f leftover.md", checkoutRoot);
    assert.equal(targets[0].cwd, checkoutRoot);
  });

  it("isPathInsideCheckout sem 3º argumento continua resolvendo contra checkoutRoot (compat)", () => {
    assert.equal(isPathInsideCheckout("leftover.md", checkoutRoot), true);
  });
});

describe("shouldBlockSharedCheckoutRm aceita entradas {path, cwd} (#7757, modelo #8107)", () => {
  const checkoutRoot = process.platform === "win32" ? "C:\\repo" : "/repo";
  const outsideDir = process.platform === "win32" ? "C:\\Users\\x\\memory" : "/home/x/memory";

  it("bloco (a) reproduzido: cwd fora do checkout → NÃO bloqueia, mesmo com sujeira alheia real", () => {
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [{ path: "project_x.md", cwd: outsideDir }],
        checkoutRoot,
        isWorktree: false,
        foreignDirtyPaths: ["project_x.md"],
      }),
      false,
    );
  });

  it("bloco (b) reproduzido: cwd dentro do checkout, alvo é sujeira alheia → bloqueia", () => {
    const insideSubdir = process.platform === "win32" ? "C:\\repo\\sub" : "/repo/sub";
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [{ path: "leftover.md", cwd: insideSubdir }],
        checkoutRoot,
        isWorktree: false,
        foreignDirtyPaths: ["sub/leftover.md"],
      }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// #7730 — Guard 3: comandos git destrutivos (checkout --/restore/clean/
// reset --hard/stash) no checkout principal compartilhado.
// ---------------------------------------------------------------------------

describe("detectDestructiveGitTarget (#7730)", () => {
  it("'git checkout <ref> -- <path>' → wholeTree false, paths = [<path>]", () => {
    const t = detectDestructiveGitTarget("git checkout origin/master -- .");
    assert.deepEqual(t, { wholeTree: false, paths: ["."] });
  });

  it("'git checkout -- <path>' (sem ref) → casa igual", () => {
    const t = detectDestructiveGitTarget("git checkout -- wrangler.toml");
    assert.deepEqual(t, { wholeTree: false, paths: ["wrangler.toml"] });
  });

  it("'git checkout <branch>' (SEM --) → NÃO casa — troca de branch, outro guard", () => {
    assert.equal(detectDestructiveGitTarget("git checkout master"), null);
    assert.equal(detectDestructiveGitTarget("git checkout -b feature/x"), null);
  });

  it("'git switch' → NÃO casa (fora de escopo deste guard)", () => {
    assert.equal(detectDestructiveGitTarget("git switch master"), null);
  });

  it("(fix iteration 1 #7767) 'git checkout HEAD -- <path>' → NÃO casa — exceção do lockout git-sync.ts", () => {
    assert.equal(detectDestructiveGitTarget("git checkout HEAD -- data/foo.md"), null);
    assert.equal(detectDestructiveGitTarget("git checkout head -- data/foo.md"), null); // case-insensitive
  });

  it("(fix iteration 1 #7767) 'git checkout origin/master -- <path>' CONTINUA casando — exceção é só HEAD", () => {
    assert.deepEqual(detectDestructiveGitTarget("git checkout origin/master -- data/foo.md"), {
      wholeTree: false,
      paths: ["data/foo.md"],
    });
  });

  it("(fix iteration 1 #7767) 'git checkout -f <branch>' → wholeTree true (falso-negativo original: só olhava '--')", () => {
    assert.deepEqual(detectDestructiveGitTarget("git checkout -f master"), { wholeTree: true, paths: [] });
    assert.deepEqual(detectDestructiveGitTarget("git checkout --force master"), { wholeTree: true, paths: [] });
  });

  it("(fix iteration 1 #7767) 'git checkout .' (SEM --) → wholeTree true", () => {
    assert.deepEqual(detectDestructiveGitTarget("git checkout ."), { wholeTree: true, paths: [] });
  });

  it("(fix iteration 1 #7767) 'git checkout -b feature/x' continua NÃO casando — criação de branch, não força nem é '.'", () => {
    assert.equal(detectDestructiveGitTarget("git checkout -b feature/x"), null);
  });

  it("'git restore <path...>' → wholeTree false", () => {
    const t = detectDestructiveGitTarget("git restore test/foo.test.ts");
    assert.deepEqual(t, { wholeTree: false, paths: ["test/foo.test.ts"] });
  });

  it("'git clean -f'/'-fd'/'-fdx'/'--force' → wholeTree true", () => {
    for (const cmd of ["git clean -f", "git clean -fd", "git clean -fdx", "git clean --force"]) {
      assert.deepEqual(detectDestructiveGitTarget(cmd), { wholeTree: true, paths: [] }, cmd);
    }
  });

  it("'git clean -n' (dry-run, sem force) → NÃO casa", () => {
    assert.equal(detectDestructiveGitTarget("git clean -n"), null);
    assert.equal(detectDestructiveGitTarget("git clean -nd"), null);
  });

  it("'git reset --hard [ref]' → wholeTree true", () => {
    assert.deepEqual(detectDestructiveGitTarget("git reset --hard"), { wholeTree: true, paths: [] });
    assert.deepEqual(detectDestructiveGitTarget("git reset --hard origin/master"), {
      wholeTree: true,
      paths: [],
    });
  });

  it("'git reset' (soft/mixed, sem --hard) → NÃO casa", () => {
    assert.equal(detectDestructiveGitTarget("git reset HEAD~1"), null);
    assert.equal(detectDestructiveGitTarget("git reset --soft HEAD~1"), null);
  });

  it("'git stash' bare, 'push', 'pop', 'apply', 'drop', 'clear' → wholeTree true", () => {
    for (const cmd of ["git stash", "git stash push", "git stash pop", "git stash apply", "git stash drop", "git stash clear"]) {
      assert.deepEqual(detectDestructiveGitTarget(cmd), { wholeTree: true, paths: [] }, cmd);
    }
  });

  it("(self-review #7767) 'git stash save <msg>' → wholeTree true — sintaxe antiga, mesmo efeito de 'push'", () => {
    assert.deepEqual(detectDestructiveGitTarget("git stash save 'wip'"), { wholeTree: true, paths: [] });
  });

  it("(self-review #7767) 'git stash create'/'store' → NÃO casa (não tocam a working tree)", () => {
    assert.equal(detectDestructiveGitTarget("git stash create"), null);
    assert.equal(detectDestructiveGitTarget("git stash store abc123"), null);
  });

  it("'git stash list'/'git stash show' → NÃO casa (leitura pura)", () => {
    assert.equal(detectDestructiveGitTarget("git stash list"), null);
    assert.equal(detectDestructiveGitTarget("git stash show -p"), null);
  });

  it("nenhum comando destrutivo → null", () => {
    assert.equal(detectDestructiveGitTarget("git status"), null);
    assert.equal(detectDestructiveGitTarget("git diff"), null);
    assert.equal(detectDestructiveGitTarget("git show origin/master:wrangler.toml"), null);
  });

  it("dentro de comando encadeado ainda casa", () => {
    assert.deepEqual(detectDestructiveGitTarget("cd repo && git reset --hard"), {
      wholeTree: true,
      paths: [],
    });
  });

  it("menção dentro de heredoc NÃO casa (mesmo fix do #7757 aplicado aqui via commandSegments)", () => {
    const cmd = "cat <<'EOF' > /tmp/x.md\nnunca rode git reset --hard aqui\nEOF\necho ok";
    assert.equal(detectDestructiveGitTarget(cmd), null);
  });
});

describe("shouldBlockSharedCheckoutGitDestructive (#7730, modelo próprio/alheio do #8107)", () => {
  const root = process.platform === "win32" ? "C:\\repo" : "/repo";

  it("(a) cenário do incidente #8107: SEM coordenadora nenhuma, wholeTree (reset --hard) + sujeira alheia real → bloqueia", () => {
    // Reprodução do incidente de origem: `git reset --hard origin/...` no
    // checkout compartilhado depois que a coordenadora já encerrou o
    // registro. wholeTree atinge QUALQUER sujeira alheia existente.
    assert.equal(
      shouldBlockSharedCheckoutGitDestructive({
        target: { wholeTree: true, paths: [] },
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths: ["scripts/lib/weekly-linkedin-render.ts", "context/audience-profile.md"],
      }),
      true,
    );
  });

  it("bloqueia: checkout -- com path que sobrepõe sujeira alheia", () => {
    assert.equal(
      shouldBlockSharedCheckoutGitDestructive({
        target: { wholeTree: false, paths: ["wrangler.toml"] },
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths: ["wrangler.toml"],
      }),
      true,
    );
  });

  it("permite: checkout -- com path que NÃO sobrepõe nenhuma sujeira alheia", () => {
    assert.equal(
      shouldBlockSharedCheckoutGitDestructive({
        target: { wholeTree: false, paths: ["wrangler.toml"] },
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths: ["outro-arquivo.md"],
      }),
      false,
    );
  });

  it("permite: path FORA do checkout, mesmo com sujeira alheia real na árvore", () => {
    const outsidePath = process.platform === "win32" ? "C:\\tmp\\x.md" : "/tmp/x.md";
    assert.equal(
      shouldBlockSharedCheckoutGitDestructive({
        target: { wholeTree: false, paths: [outsidePath] },
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths: ["a.md"],
      }),
      false,
    );
  });

  it("(b) sujeira alheia é da própria sessão (foreignDirtyPaths já veio vazio pós-filtro) → permite", () => {
    const foreignDirtyPaths = computeForeignDirtyPaths(["wrangler.toml"], ["wrangler.toml"]);
    assert.equal(
      shouldBlockSharedCheckoutGitDestructive({
        target: { wholeTree: false, paths: ["wrangler.toml"] },
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths,
      }),
      false,
    );
  });

  it("permite: é um worktree vinculado", () => {
    assert.equal(
      shouldBlockSharedCheckoutGitDestructive({
        target: { wholeTree: true, paths: [] },
        checkoutRoot: root,
        isWorktree: true,
        foreignDirtyPaths: ["a.md"],
      }),
      false,
    );
  });

  it("permite: árvore inteiramente limpa (foreignDirtyPaths vazio) — não é o bug, é o caso comum", () => {
    assert.equal(
      shouldBlockSharedCheckoutGitDestructive({
        target: { wholeTree: true, paths: [] },
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths: [],
      }),
      false,
    );
  });

  it("target null → nunca bloqueia", () => {
    assert.equal(
      shouldBlockSharedCheckoutGitDestructive({
        target: null,
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths: ["a.md"],
      }),
      false,
    );
  });

  it("(d) git status --porcelain falhou (foreignDirtyPaths null) → fail-open, permite mesmo wholeTree", () => {
    assert.equal(
      shouldBlockSharedCheckoutGitDestructive({
        target: { wholeTree: true, paths: [] },
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths: null,
      }),
      false,
    );
  });

  it("checkout -- com múltiplos paths — só UM sobrepõe sujeira alheia → bloqueia (achado pr-test-analyzer #8109)", () => {
    assert.equal(
      shouldBlockSharedCheckoutGitDestructive({
        target: { wholeTree: false, paths: ["arquivo-limpo.md", "wrangler.toml"] },
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths: ["wrangler.toml"],
      }),
      true,
    );
  });

  it("checkout -- com múltiplos paths — NENHUM sobrepõe sujeira alheia → permite", () => {
    assert.equal(
      shouldBlockSharedCheckoutGitDestructive({
        target: { wholeTree: false, paths: ["arquivo-limpo.md", "wrangler.toml"] },
        checkoutRoot: root,
        isWorktree: false,
        foreignDirtyPaths: ["outro-arquivo.md"],
      }),
      false,
    );
  });
});

describe("GIT_DESTRUCTIVE_BLOCK_REASON (#7730/#8107)", () => {
  it("cita as duas issues de origem e a alternativa não-destrutiva (git show/diff)", () => {
    assert.match(GIT_DESTRUCTIVE_BLOCK_REASON, /#7730/);
    assert.match(GIT_DESTRUCTIVE_BLOCK_REASON, /#8107/);
    assert.match(GIT_DESTRUCTIVE_BLOCK_REASON, /git show/);
  });
});

// ---------------------------------------------------------------------------
// #8107 (achado pr-test-analyzer) — smoke test de PONTA A PONTA via CLI: o
// hook real, invocado como subprocesso com o payload JSON que o harness
// manda por stdin, num checkout git de verdade. Cobre a fiação (`isRm ||
// gitTarget`, cálculo ÚNICO de `foreignDirtyPaths` compartilhado entre os
// dois guards, leitura de `payload.session_id`) que os testes unitários das
// funções puras acima NUNCA exercitam — era exatamente essa fiação que
// mudou de forma nesta PR (2 blocos independentes → 1 bloco compartilhado).
// ---------------------------------------------------------------------------

describe("CLI end-to-end (#8107) — hook real, subprocesso, checkout git de verdade", () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  function makeTempCheckout(): { root: string; hookPath: string } {
    const root = join(tmpdir(), `cli-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root });
    // Copia o hook REAL pro checkout temporário — checkoutRoot é derivado de
    // `import.meta.url` do próprio arquivo (dirname/../..), então só copiando
    // ele pra dentro de `<root>/.claude/hooks/` o hook "acha" que `root` é o
    // checkout principal.
    const hookSource = readFileSync(
      join(process.cwd(), ".claude", "hooks", "block-unsafe-shared-checkout-ops.mjs"),
      "utf8",
    );
    const hookPath = join(root, ".claude", "hooks", "block-unsafe-shared-checkout-ops.mjs");
    writeFileSync(hookPath, hookSource, "utf8");
    // `data/` é gitignored no repo real (`data/sessions/*.json` nunca é
    // tracked) — reproduz isso aqui, senão o PRÓPRIO arquivo de registro de
    // sessão apareceria como "??" e seria contado como sujeira alheia
    // (ninguém declara `data/sessions/...` no seu `touched_paths`).
    writeFileSync(join(root, ".gitignore"), "data/\n", "utf8");
    // Commita o estado inicial (hook copiado + .gitignore) — sem isto,
    // `git status --porcelain` veria o hook copiado como sujeira "??" e o
    // cenário "árvore limpa" nunca existiria de fato neste checkout de teste.
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
    return { root, hookPath };
  }

  function runHook(hookPath: string, payload: Record<string, unknown>): Record<string, unknown> | null {
    const res = execFileSync("node", [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10_000,
    });
    if (res.trim() === "") return null;
    return JSON.parse(res);
  }

  it("bloqueia via CLI: sujeira ALHEIA real no checkout, sem session_id (cenário do incidente #8107)", () => {
    const { root, hookPath } = makeTempCheckout();
    writeFileSync(join(root, "foreign.md"), "conteúdo de outra sessão\n", "utf8");
    const result = runHook(hookPath, {
      tool_name: "Bash",
      tool_input: { command: "git reset --hard" },
      // session_id ausente de propósito — reproduz o payload do incidente.
    });
    assert.notEqual(result, null);
    const out = result as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    assert.equal(out.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput?.permissionDecisionReason ?? "", /#8107/);
  });

  it("permite via CLI: árvore de trabalho limpa (nenhuma sujeira, alheia ou própria)", () => {
    const { root, hookPath } = makeTempCheckout();
    void root;
    const result = runHook(hookPath, {
      tool_name: "Bash",
      tool_input: { command: "git reset --hard" },
    });
    assert.equal(result, null); // sem bloqueio: hook não escreve nada no stdout
  });

  it("permite via CLI: sujeira existe mas é da PRÓPRIA sessão (touched_paths do beacon cobre o arquivo)", () => {
    const { root, hookPath } = makeTempCheckout();
    writeFileSync(join(root, "meu-arquivo.md"), "meu trabalho\n", "utf8");
    mkdirSync(join(root, "data", "sessions"), { recursive: true });
    writeFileSync(
      join(root, "data", "sessions", "interactive-tag-minha-sessao.json"),
      JSON.stringify({ kind: "interactive", sessionId: "minha-sessao", touched_paths: ["meu-arquivo.md"] }),
      "utf8",
    );
    const result = runHook(hookPath, {
      tool_name: "Bash",
      tool_input: { command: "git reset --hard" },
      session_id: "minha-sessao",
    });
    assert.equal(result, null);
  });

  it("permite via CLI: comando não-destrutivo (git status) nunca dispara os guards", () => {
    const { root, hookPath } = makeTempCheckout();
    writeFileSync(join(root, "foreign.md"), "sujeira alheia\n", "utf8");
    const result = runHook(hookPath, {
      tool_name: "Bash",
      tool_input: { command: "git status" },
    });
    assert.equal(result, null);
  });
});
