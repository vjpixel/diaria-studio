import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isTaskkillByImageCommand,
  TASKKILL_BLOCK_REASON,
  isRmCommand,
  extractRmTargetPaths,
  isPathInsideCheckout,
  isLinkedWorktree,
  sessionsDir,
  machineTag,
  readActiveCoordinatorSessionIds,
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

describe("readActiveCoordinatorSessionIds (#6971) — fail-open sempre", () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  function freshRoot(): string {
    const root = join(tmpdir(), `rm-hook-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    return root;
  }
  function writeSession(root: string, filename: string, record: Record<string, unknown>) {
    const dir = sessionsDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), JSON.stringify(record), "utf8");
  }

  const NOW = Date.parse("2026-09-01T12:00:00.000Z");
  const ONE_HOUR_MS = 60 * 60 * 1000;

  it("diretório ausente → Set vazio", () => {
    assert.deepEqual(readActiveCoordinatorSessionIds(freshRoot(), NOW), new Set());
  });

  it("sessão overnight fresca, mesma máquina → incluída", () => {
    const root = freshRoot();
    writeSession(root, "overnight-helios-sess1.json", {
      kind: "overnight",
      sessionId: "sess1",
      startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
      lastHeartbeat: new Date(NOW - ONE_HOUR_MS).toISOString(),
      machineTag: machineTag(),
    });
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set(["sess1"]));
  });

  it("JSON malformado em uma entrada não derruba a leitura das demais", () => {
    const root = freshRoot();
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(join(sessionsDir(root), "overnight-helios-broken.json"), "{not valid json", "utf8");
    writeSession(root, "overnight-helios-sess2.json", {
      kind: "overnight",
      sessionId: "sess2",
      startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
      machineTag: machineTag(),
    });
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set(["sess2"]));
  });
});

describe("shouldBlockSharedCheckoutRm (#6971)", () => {
  const root = process.platform === "win32" ? "C:\\repo" : "/repo";
  const insidePath = process.platform === "win32" ? "C:\\repo\\.pr6950-review.md" : "/repo/.pr6950-review.md";
  const outsidePath = process.platform === "win32" ? "C:\\tmp\\x.md" : "/tmp/x.md";

  it("bloqueia: rodada ativa, chamada não é a coordenadora, path dentro do checkout principal", () => {
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [insidePath],
        checkoutRoot: root,
        isWorktree: false,
        activeCoordinatorSessionIds: new Set(["coord-1"]),
        callerSessionId: "review-subagent-2",
      }),
      true,
    );
  });

  it("permite: chamada É a própria coordenadora registrada", () => {
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [insidePath],
        checkoutRoot: root,
        isWorktree: false,
        activeCoordinatorSessionIds: new Set(["coord-1"]),
        callerSessionId: "coord-1",
      }),
      false,
    );
  });

  it("permite: nenhuma coordenadora ativa (sessão interativa comum) — cobertura HONESTA parcial do #6971", () => {
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [insidePath],
        checkoutRoot: root,
        isWorktree: false,
        activeCoordinatorSessionIds: new Set(),
        callerSessionId: "qualquer-sessao",
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
        activeCoordinatorSessionIds: new Set(["coord-1"]),
        callerSessionId: "subagent-2",
      }),
      false,
    );
  });

  it("permite: rm FORA do repo (deve PASSAR) mesmo com rodada ativa e session_id diferente", () => {
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [outsidePath],
        checkoutRoot: root,
        isWorktree: false,
        activeCoordinatorSessionIds: new Set(["coord-1"]),
        callerSessionId: "subagent-2",
      }),
      false,
    );
  });

  it("#7055 FAIL-CLOSED: session_id da chamada ausente (undefined) → bloqueia (era fail-open)", () => {
    // Regressão do #7055: reincidência do MESMO incidente do #6971/#6982 1h
    // após o guard estar mergeado — um subagente de review apagou os mesmos
    // 3 arquivos, e a reprodução ao vivo mostrou `session_id` ausente/vazio
    // saindo pela porta antecipada e liberando o `rm` incondicionalmente.
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [insidePath],
        checkoutRoot: root,
        isWorktree: false,
        activeCoordinatorSessionIds: new Set(["coord-1"]),
        callerSessionId: undefined,
      }),
      true,
    );
  });

  it("#7055 FAIL-CLOSED: session_id da chamada vazio ('') → bloqueia (era fail-open)", () => {
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [insidePath],
        checkoutRoot: root,
        isWorktree: false,
        activeCoordinatorSessionIds: new Set(["coord-1"]),
        callerSessionId: "",
      }),
      true,
    );
  });

  it("#7055 reprodução exata do payload do incidente: rm em .pr6950-review.md com session_id ausente, rodada develop ativa", () => {
    // Mesmo payload/cenário citado na issue #7055 (reprodução ao vivo do
    // hook): `rm -f .../.pr6950-review.md`, coordenadora `develop` ativa,
    // chamada sem `session_id`.
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [insidePath],
        checkoutRoot: root,
        isWorktree: false,
        activeCoordinatorSessionIds: new Set(["develop-helios-3132ef2c"]),
        callerSessionId: undefined,
      }),
      true,
    );
  });

  it("session_id ausente mas SEM coordenadora ativa continua permitindo (cobertura HONESTA — não é o bug do #7055)", () => {
    // O fail-open que o #7055 fecha é especificamente "coordenadora ativa +
    // session_id ausente". Sem NENHUMA coordenadora registrada, este guard
    // segue fora de escopo (mesmo caso já coberto acima, "nenhuma
    // coordenadora ativa") — session_id ausente não deveria criar um bloqueio
    // que nem uma sessão interativa comum, sem rodada nenhuma, sofreria.
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [insidePath],
        checkoutRoot: root,
        isWorktree: false,
        activeCoordinatorSessionIds: new Set(),
        callerSessionId: undefined,
      }),
      false,
    );
  });
});

describe("RM_BLOCK_REASON (#6971)", () => {
  it("cita a issue de origem, o checkout principal, e documenta a cobertura parcial", () => {
    assert.match(RM_BLOCK_REASON, /#6971/);
    assert.match(RM_BLOCK_REASON, /checkout principal/);
    assert.match(RM_BLOCK_REASON, /HONESTA/i);
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

describe("shouldBlockSharedCheckoutRm aceita entradas {path, cwd} (#7757)", () => {
  const checkoutRoot = process.platform === "win32" ? "C:\\repo" : "/repo";
  const outsideDir = process.platform === "win32" ? "C:\\Users\\x\\memory" : "/home/x/memory";

  it("bloco (a) reproduzido: cwd fora do checkout → NÃO bloqueia", () => {
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [{ path: "project_x.md", cwd: outsideDir }],
        checkoutRoot,
        isWorktree: false,
        activeCoordinatorSessionIds: new Set(["coord-1"]),
        callerSessionId: "outra-sessao",
      }),
      false,
    );
  });

  it("bloco (b) reproduzido: cwd dentro do checkout → bloqueia", () => {
    const insideSubdir = process.platform === "win32" ? "C:\\repo\\sub" : "/repo/sub";
    assert.equal(
      shouldBlockSharedCheckoutRm({
        targetPaths: [{ path: "leftover.md", cwd: insideSubdir }],
        checkoutRoot,
        isWorktree: false,
        activeCoordinatorSessionIds: new Set(["coord-1"]),
        callerSessionId: "outra-sessao",
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

describe("shouldBlockSharedCheckoutGitDestructive (#7730)", () => {
  const root = process.platform === "win32" ? "C:\\repo" : "/repo";

  it("bloqueia: rodada ativa, chamada não é a coordenadora, wholeTree (clean/reset/stash)", () => {
    assert.equal(
      shouldBlockSharedCheckoutGitDestructive({
        target: { wholeTree: true, paths: [] },
        checkoutRoot: root,
        isWorktree: false,
        activeCoordinatorSessionIds: new Set(["coord-1"]),
        callerSessionId: "review-subagent-2",
      }),
      true,
    );
  });

  it("bloqueia: checkout -- com path dentro do checkout", () => {
    const insidePath = process.platform === "win32" ? "wrangler.toml" : "wrangler.toml";
    assert.equal(
      shouldBlockSharedCheckoutGitDestructive({
        target: { wholeTree: false, paths: [insidePath] },
        checkoutRoot: root,
        isWorktree: false,
        activeCoordinatorSessionIds: new Set(["coord-1"]),
        callerSessionId: "review-subagent-2",
      }),
      true,
    );
  });

  it("permite: path FORA do checkout", () => {
    const outsidePath = process.platform === "win32" ? "C:\\tmp\\x.md" : "/tmp/x.md";
    assert.equal(
      shouldBlockSharedCheckoutGitDestructive({
        target: { wholeTree: false, paths: [outsidePath] },
        checkoutRoot: root,
        isWorktree: false,
        activeCoordinatorSessionIds: new Set(["coord-1"]),
        callerSessionId: "review-subagent-2",
      }),
      false,
    );
  });

  it("permite: é a própria coordenadora", () => {
    assert.equal(
      shouldBlockSharedCheckoutGitDestructive({
        target: { wholeTree: true, paths: [] },
        checkoutRoot: root,
        isWorktree: false,
        activeCoordinatorSessionIds: new Set(["coord-1"]),
        callerSessionId: "coord-1",
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
        activeCoordinatorSessionIds: new Set(["coord-1"]),
        callerSessionId: "subagent-2",
      }),
      false,
    );
  });

  it("permite: sem coordenadora ativa (sessão interativa comum)", () => {
    assert.equal(
      shouldBlockSharedCheckoutGitDestructive({
        target: { wholeTree: true, paths: [] },
        checkoutRoot: root,
        isWorktree: false,
        activeCoordinatorSessionIds: new Set(),
        callerSessionId: "qualquer-sessao",
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
        activeCoordinatorSessionIds: new Set(["coord-1"]),
        callerSessionId: "subagent-2",
      }),
      false,
    );
  });

  it("session_id ausente com coordenadora ativa → bloqueia (mesmo fail-closed do #7055)", () => {
    assert.equal(
      shouldBlockSharedCheckoutGitDestructive({
        target: { wholeTree: true, paths: [] },
        checkoutRoot: root,
        isWorktree: false,
        activeCoordinatorSessionIds: new Set(["coord-1"]),
        callerSessionId: undefined,
      }),
      true,
    );
  });
});

describe("GIT_DESTRUCTIVE_BLOCK_REASON (#7730)", () => {
  it("cita a issue de origem e a alternativa não-destrutiva (git show/diff)", () => {
    assert.match(GIT_DESTRUCTIVE_BLOCK_REASON, /#7730/);
    assert.match(GIT_DESTRUCTIVE_BLOCK_REASON, /git show/);
  });
});
