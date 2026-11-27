/**
 * #14216 — preflight mecânico no `gh pr create`: `docs/editorial-invariants.md`
 * do commit defasado e PR grande sem `removal-declaration:` são recusados ANTES
 * de a PR existir (a #14120 mediu 5 ciclos de `dev-fixer` causados pelas duas
 * falhas, com as regras já escritas nos itens 13 e 29 das regras de dispatch).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assessInvariantsDoc,
  compareInvariantsDoc,
  decidePrCreatePreflight,
  REGENERATE_INVARIANTS_COMMAND,
} from "../scripts/lib/pr-create-preflight.ts";
import { runPreflight as runCli } from "../scripts/check-pr-create-preflight.ts";
import { generateInvariantsMarkdown } from "../scripts/list-invariants.ts";
import {
  PREFLIGHT_PR_GUARD_BYPASS_ENV,
  appliesTo,
  bypassSource,
  commandDir,
  extractPrCreateBody,
  handlePayload,
  rawWordValue,
  resolveBody,
  runPreflight,
  type HandlePayloadDeps,
  type PreflightRunResult,
} from "../.claude/hooks/block-pr-create-preflight.mjs";
import { GUARDS } from "../.claude/hooks/pretooluse-bash-dispatch.mjs";

const ROOT = join(import.meta.dirname, "..");
const BIG = { files: 3, added: 812, removed: 40 };
const SMALL = { files: 1, added: 20, removed: 3 };

const tmpRoots: string[] = [];
after(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});

describe("decidePrCreatePreflight (#14216)", () => {
  it("documento do commit defasado: nega com o comando de regenerar", () => {
    const r = decidePrCreatePreflight({ invariants: { status: "stale" }, stats: SMALL, body: "x" });
    assert.equal(r.deny.length, 1);
    assert.ok(r.deny[0].includes(REGENERATE_INVARIANTS_COMMAND));
  });

  it("documento ausente e regenerado-sem-commit também negam", () => {
    assert.equal(decidePrCreatePreflight({ invariants: { status: "missing" }, stats: SMALL, body: "x" }).deny.length, 1);
    const r = decidePrCreatePreflight({ invariants: { status: "uncommitted" }, stats: SMALL, body: "x" });
    assert.match(r.deny[0], /regenerado mas não commitado/);
  });

  it("PR acima do limiar com corpo lido sem removal-declaration: nega (o cenário da #14120)", () => {
    const r = decidePrCreatePreflight({ invariants: { status: "ok" }, stats: BIG, body: "Closes #1\n\nsem a linha" });
    assert.equal(r.removal?.status, "missing");
    assert.equal(r.deny.length, 1);
    assert.match(r.deny[0], /removal-declaration:/);
    assert.match(r.deny[0], /812/);
  });

  it("PR acima do limiar com a declaração passa", () => {
    const r = decidePrCreatePreflight({
      invariants: { status: "ok" },
      stats: BIG,
      body: "removal-declaration: feature nova, não substitui código existente",
    });
    assert.deepEqual(r.deny, []);
    assert.equal(r.removal?.status, "ok");
  });

  it("PR abaixo do limiar não precisa de declaração", () => {
    const r = decidePrCreatePreflight({ invariants: { status: "ok" }, stats: SMALL, body: "" });
    assert.deepEqual(r.deny, []);
    assert.deepEqual(r.warn, []);
  });

  it("corpo não determinável com PR grande: aviso, nunca recusa", () => {
    const r = decidePrCreatePreflight({ invariants: { status: "ok" }, stats: BIG, body: null, bodyUnknownReason: "--fill" });
    assert.deepEqual(r.deny, []);
    assert.equal(r.warn.length, 1);
    assert.match(r.warn[0], /--fill/);
  });

  it("diff não medido e registry indisponível: só avisos", () => {
    const r = decidePrCreatePreflight({ invariants: { status: "unavailable", detail: "boom" }, stats: null, statsError: "sem origin/master", body: "x" });
    assert.deepEqual(r.deny, []);
    assert.equal(r.warn.length, 2);
  });

  it("warnOnlyReason (--head de outra branch): recusa vira aviso", () => {
    const r = decidePrCreatePreflight({ invariants: { status: "stale" }, stats: BIG, body: "", warnOnlyReason: "--head x" });
    assert.deepEqual(r.deny, []);
    assert.equal(r.warn.length, 2);
    assert.match(r.warn[0], /só aviso: --head x/);
  });
});

describe("assessInvariantsDoc (#14216): confere o COMMIT, não a árvore", () => {
  const g = "| regra | stage |\n";
  it("HEAD certo: ok, mesmo com a árvore diferente", () => {
    assert.deepEqual(assessInvariantsDoc({ generated: g, headDoc: g, diskDoc: "outro", registryDirty: false }), { status: "ok" });
  });
  it("certo no disco, defasado no HEAD: regenerado mas não commitado", () => {
    assert.deepEqual(assessInvariantsDoc({ generated: g, headDoc: "velho", diskDoc: g, registryDirty: false }), { status: "uncommitted" });
  });
  it("defasado nos dois: stale; fora do commit: missing", () => {
    assert.deepEqual(assessInvariantsDoc({ generated: g, headDoc: "velho", diskDoc: "velho", registryDirty: false }), { status: "stale" });
    assert.deepEqual(assessInvariantsDoc({ generated: g, headDoc: null, diskDoc: null, registryDirty: false }), { status: "missing" });
  });
  it("registry com mudança não commitada: indisponível (aviso), nunca ok", () => {
    assert.equal(assessInvariantsDoc({ generated: g, headDoc: g, diskDoc: g, registryDirty: true }).status, "unavailable");
  });
  it("compareInvariantsDoc segue o --check (compara aparado) e o documento do repo bate", () => {
    assert.deepEqual(compareInvariantsDoc("a\n", "a"), { status: "ok" });
    assert.deepEqual(compareInvariantsDoc("a", "b"), { status: "stale" });
    const committed = readFileSync(join(ROOT, "docs", "editorial-invariants.md"), "utf8");
    assert.deepEqual(compareInvariantsDoc(generateInvariantsMarkdown(), committed), { status: "ok" });
  });
});

describe("leitura do corpo (#14216)", () => {
  it("--body com aspas simples: literal, inclusive com $ (custa R$ 4.000)", () => {
    assert.deepEqual(extractPrCreateBody("gh pr create --title t --body 'custa R$ 4.000 removal-declaration: x'"), {
      kind: "text",
      body: "custa R$ 4.000 removal-declaration: x",
      base: null,
      head: null,
    });
  });
  it('--body "$(cat <<\'EOF\' ... EOF)": o formato padrão é texto determinístico', () => {
    const cmd = "gh pr create --title t --body \"$(cat <<'EOF'\nCloses #1\nremoval-declaration: nada removido (teste)\nnão é $VAR expandido\nEOF\n)\"";
    const r = extractPrCreateBody(cmd);
    assert.equal(r.kind, "text");
    assert.match((r as { body: string }).body, /removal-declaration: nada removido/);
    assert.match((r as { body: string }).body, /\$VAR/);
  });
  it("heredoc com delimitador sem aspas, variável e crase em aspas duplas: não determinável", () => {
    assert.equal(extractPrCreateBody('gh pr create --body "$(cat <<EOF\n$X\nEOF\n)"').kind, "unknown");
    assert.equal(extractPrCreateBody('gh pr create --body "$BODY"').kind, "unknown");
    assert.equal(extractPrCreateBody('gh pr create --body "corpo `date`"').kind, "unknown");
  });
  it('expansão fora do --body não contamina: cd "$(git rev-parse ...)" && gh pr create --body plain', () => {
    const r = extractPrCreateBody('cd "$(git rev-parse --show-toplevel)" && gh pr create --title t --body plain');
    assert.equal(r.kind, "text");
    assert.equal((r as { body: string }).body, "plain");
  });
  it("valor de flag de valor nunca vira corpo (-bump no título)", () => {
    const r = extractPrCreateBody("gh pr create --title -bump -H x --label -bfoo --body real");
    assert.equal((r as { body: string }).body, "real");
    assert.equal(r.head, "x");
    assert.equal(extractPrCreateBody("gh pr create -t -bump").kind, "unknown");
  });
  it("-bTEXTO e --body=TEXTO; --base capturado", () => {
    assert.equal((extractPrCreateBody("gh pr create -B develop -bTexto") as { body: string }).body, "Texto");
    assert.equal(extractPrCreateBody("gh pr create -B develop -bTexto").base, "develop");
    assert.equal((extractPrCreateBody("gh pr create --body=abc") as { body: string }).body, "abc");
  });
  it("--body-file com arquivo, com heredoc, e sem valor (mensagens separadas)", () => {
    assert.equal((extractPrCreateBody("gh pr create --title t --body-file /tmp/pr-body-14216-1.md") as { path: string }).path, "/tmp/pr-body-14216-1.md");
    const hd = extractPrCreateBody("gh pr create --title t --body-file - <<'EOF'\nlinha 1\nremoval-declaration: teste de heredoc\nEOF");
    assert.equal(hd.kind, "text");
    assert.match((hd as { body: string }).body, /teste de heredoc/);
    assert.equal((extractPrCreateBody("gh pr create --body") as { reason: string }).reason, "--body sem valor");
    assert.equal((extractPrCreateBody("gh pr create --body-file") as { reason: string }).reason, "--body-file sem valor");
    assert.equal(extractPrCreateBody('gh pr create --body-file "$F"').kind, "unknown");
  });
  it("--fill e sem corpo: não determinável; texto que só CITA gh pr create não é comando", () => {
    assert.equal(extractPrCreateBody("gh pr create --fill").kind, "unknown");
    assert.equal(extractPrCreateBody("gh pr create --title t").kind, "unknown");
    assert.equal(extractPrCreateBody("echo 'gh pr create --body x'").kind, "unknown");
    assert.equal(extractPrCreateBody("cat <<'EOF'\ngh pr create --body x\nEOF").kind, "unknown");
  });
  it("rawWordValue: $ sem nome é literal; \\$ em aspas duplas também", () => {
    assert.deepEqual(rawWordValue('"R$ 4.000"'), { text: "R$ 4.000" });
    assert.deepEqual(rawWordValue('"custa \\$HOME"'), { text: "custa $HOME" });
    assert.equal(rawWordValue('"$HOME"').dynamic, true);
  });
  it("--body-file relativo é lido no diretório do comando (alvo do cd), não no payload.cwd", () => {
    assert.equal(commandDir("cd /wt && gh pr create -F b-14216.md", "/main", "/x").replaceAll("\\", "/").replace(/^[A-Z]:/, ""), "/wt");
    let read = "";
    handlePayload({ tool_name: "Bash", cwd: "/main", tool_input: { command: "cd /wt && gh pr create -F b-14216.md" } }, {
      env: {},
      resolveRepoRoot: () => "/wt",
      isForeignRepo: () => false,
      isStudio: () => true,
      resolveLogRoot: () => "/wt",
      readFile: (p: string) => {
        read = p.replaceAll("\\", "/").replace(/^[A-Z]:/, "");
        return "corpo";
      },
      runPreflightFn: () => ({ infra: false, code: 0, result: { deny: [], warn: [] } }),
      logFn: () => {},
    });
    assert.equal(read, "/wt/b-14216.md");
  });
  it("resolveBody: arquivo ilegível é não determinável", () => {
    const bad = resolveBody({ kind: "file", path: "x-14216.md" }, "/wt", () => {
      throw new Error("ENOENT");
    });
    assert.equal(bad.body, null);
    assert.match(String(bad.reason), /ENOENT/);
  });
});

describe("hook block-pr-create-preflight (#14216)", () => {
  const payload = (command: string) => ({ tool_name: "Bash", cwd: "/wt", tool_input: { command } });
  const baseDeps = (run: PreflightRunResult, logs: Array<[string, string | undefined]> = []): HandlePayloadDeps => ({
    env: {},
    hookDir: "/wt/.claude/hooks",
    resolveRepoRoot: () => "/wt",
    isForeignRepo: () => false,
    isStudio: () => true,
    resolveLogRoot: () => "/wt",
    readFile: () => "corpo sem a linha",
    runPreflightFn: () => run,
    logFn: (m, _d, o) => logs.push([m, o.level]),
  });

  it("aplica-se a gh pr create (inclusive com atribuição na frente), não a outro comando", () => {
    assert.equal(appliesTo(payload("gh pr create --title x")), true);
    assert.equal(appliesTo(payload("FOO=1 gh pr create --title x")), true);
    assert.equal(appliesTo(payload("gh pr view 1")), false);
    assert.equal(appliesTo({ tool_name: "Edit", tool_input: { command: "gh pr create" } }), false);
  });

  it("deny do preflight vira permissionDecision deny com a mensagem", () => {
    const logs: Array<[string, string | undefined]> = [];
    const out = handlePayload(payload("gh pr create --title t --body-file b-14216.md"), baseDeps({ infra: false, code: 1, result: { deny: ["[#7115] PR adiciona 812 linhas"], warn: [] } }, logs)) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /812 linhas/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(PREFLIGHT_PR_GUARD_BYPASS_ENV));
    assert.deepEqual(logs.map((l) => l[0]), ["pr_create_preflight_blocked"]);
  });

  it("o corpo lido, a base e o --head chegam ao preflight", () => {
    let seen: unknown;
    handlePayload(payload("gh pr create -B develop -H outra --title t --body-file b-14216.md"), {
      ...baseDeps({ infra: true, output: "" }),
      runPreflightFn: (_cwd, arg) => {
        seen = arg;
        return { infra: false, code: 0, result: { deny: [], warn: [] } };
      },
    });
    assert.deepEqual(seen, { body: "corpo sem a linha", bodyReason: null, base: "develop", warnOnly: "--head outra: o guard confere o checkout atual, não a branch da PR" });
  });

  it("aviso sem deny vira systemMessage, sem decisão", () => {
    const out = handlePayload(payload("gh pr create --fill"), baseDeps({ infra: false, code: 0, result: { deny: [], warn: ["[#7115] corpo não lido"] } })) as {
      systemMessage: string;
      hookSpecificOutput: { permissionDecision?: string };
    };
    assert.match(out.systemMessage, /corpo não lido/);
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  });

  it("infra nunca é silenciosa: systemMessage 'NÃO rodou' e log warn; script ausente é silencioso", () => {
    const logs: Array<[string, string | undefined]> = [];
    const out = handlePayload(payload("gh pr create --title t"), baseDeps({ infra: true, output: "timeout" }, logs)) as { systemMessage: string };
    assert.match(out.systemMessage, /NÃO rodou: timeout/);
    assert.match(out.systemMessage, /list-invariants\.ts --check/);
    assert.deepEqual(logs, [["pr_create_preflight_infra_error", "warn"]]);
    assert.equal(handlePayload(payload("gh pr create --title t"), baseDeps({ infra: true, missing: true, output: "ausente" })), undefined);
  });

  it("bypass pela atribuição na frente do comando: não roda e loga com level warn", () => {
    const logs: Array<[string, string | undefined]> = [];
    let ran = false;
    const out = handlePayload(payload(`${PREFLIGHT_PR_GUARD_BYPASS_ENV}=1 gh pr create --title t`), {
      ...baseDeps({ infra: true, output: "" }, logs),
      runPreflightFn: () => {
        ran = true;
        return { infra: true, output: "" };
      },
    });
    assert.equal(out, undefined);
    assert.equal(ran, false);
    assert.deepEqual(logs, [["pr_create_preflight_bypassed", "warn"]]);
    assert.equal(bypassSource(`echo '${PREFLIGHT_PR_GUARD_BYPASS_ENV}=1 gh pr create'`, {}), null);
  });

  it("PR de outro repo (diaria-design) fica de fora", () => {
    const out = handlePayload(payload("gh pr create -R vjpixel/diaria-design --title t"), {
      ...baseDeps({ infra: false, code: 1, result: { deny: ["x"], warn: [] } }),
      isForeignRepo: () => true,
    });
    assert.equal(out, undefined);
  });

  it("runPreflight: node + loader do tsx, sem shell; script ou tsx ausentes; última linha com \\r\\n", () => {
    assert.deepEqual(runPreflight("/wt", { body: null, bodyReason: "x" }, () => ({}), () => false), {
      infra: true,
      missing: true,
      output: "scripts/check-pr-create-preflight.ts ausente neste checkout",
    });
    const noTsx = runPreflight("/wt", { body: null, bodyReason: "x" }, () => ({}), (p) => !p.replaceAll("\\", "/").includes("node_modules"));
    assert.equal(noTsx.infra, true);
    assert.equal("missing" in noTsx && noTsx.missing, false);
    let call: { cmd: string; args: string[]; opts: { shell?: boolean } } | null = null;
    const fake = (cmd: string, args: string[], opts: { shell?: boolean }) => {
      call = { cmd, args, opts };
      return { status: 1, stdout: 'log qualquer\r\n{"deny":["d"],"warn":[]}\r\n', stderr: "" };
    };
    const r = runPreflight("/wt", { body: "b", bodyReason: null, base: "develop" }, fake, () => true);
    assert.equal(r.infra, false);
    assert.deepEqual(r.infra === false && r.result.deny, ["d"]);
    assert.equal(call!.cmd, process.execPath);
    assert.equal(call!.opts.shell, undefined);
    assert.equal(call!.args[0], "--import");
    assert.ok(call!.args.includes("origin/develop"));
    assert.equal(runPreflight("/wt", { body: "b", bodyReason: null }, () => ({ status: null }), () => true).infra, true);
  });

  it("está armado no despachante de PreToolUse/Bash (#14045)", () => {
    assert.ok(GUARDS.some((g: { file: string; mode: string }) => g.file === "block-pr-create-preflight.mjs" && g.mode === "spawn-if-applies"));
  });
});

describe("contrato hook ↔ CLI com spawn real (#14216)", () => {
  it("o motivo do corpo não determinável chega ao CLI pelo ambiente", () => {
    const r = runPreflight(ROOT, { body: null, bodyReason: "motivo-14216 com espaço" });
    assert.equal(r.infra, false, r.infra ? r.output : "");
    assert.equal(r.infra === false && r.result.body_unknown_reason, "motivo-14216 com espaço");
  });
  it("o corpo chega por stdin", () => {
    const r = runPreflight(ROOT, { body: "removal-declaration: teste do contrato, nada removido", bodyReason: null });
    assert.equal(r.infra, false, r.infra ? r.output : "");
    assert.equal(r.infra === false && r.result.body_unknown_reason, null);
  });
});

describe("CLI check-pr-create-preflight em repo temporário (#14216)", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
  };
  const repo = (withDoc: string | null) => {
    const root = mkdtempSync(join(tmpdir(), "preflight-14216-"));
    tmpRoots.push(root);
    git(root, "init", "-q");
    writeFileSync(join(root, "a.txt"), "a\n");
    if (withDoc !== null) {
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs", "editorial-invariants.md"), withDoc);
    }
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    git(root, "tag", "base");
    return root;
  };
  const io = (body: string) => ({ readStdin: () => body, bodyUnknownFromEnv: () => undefined });
  const addBig = (root: string) => {
    writeFileSync(join(root, "big.txt"), Array.from({ length: 600 }, (_, i) => `linha ${i}`).join("\n") + "\n");
    git(root, "add", "big.txt");
    git(root, "commit", "-q", "-m", "big");
  };

  it("sem o documento no commit: code 1", async () => {
    const root = repo(null);
    const { code, result } = await runCli(["--base", "base", "--body-stdin"], root, io("x"));
    assert.equal(code, 1);
    assert.match(result.deny.join(), /não existe/);
  });

  it("mais de 500 adições: o corpo decide (sem declaração nega, com libera)", async () => {
    const root = repo(generateInvariantsMarkdown());
    addBig(root);
    const no = await runCli(["--base", "base", "--body-stdin"], root, io("Closes #1"));
    assert.equal(no.code, 1);
    assert.match(no.result.deny.join(), /removal-declaration/);
    const yes = await runCli(["--base", "base", "--body-stdin"], root, io("removal-declaration: feature nova, nada substituído"));
    assert.equal(yes.code, 0, yes.result.deny.join());
    const unread = await runCli(["--base", "base", "--body-stdin"], root, {
      readStdin: () => {
        throw new Error("EOF");
      },
      bodyUnknownFromEnv: () => undefined,
    });
    assert.equal(unread.code, 0);
    assert.match(unread.result.body_unknown_reason ?? "", /stdin ilegível/);
  });

  it("certo no disco, defasado no HEAD: regenerado mas não commitado", async () => {
    const root = repo("velho\n");
    writeFileSync(join(root, "docs", "editorial-invariants.md"), generateInvariantsMarkdown());
    const { code, result } = await runCli(["--base", "base", "--body-stdin"], root, io(""));
    assert.equal(code, 1);
    assert.match(result.deny.join(), /não commitado/);
  });
});
