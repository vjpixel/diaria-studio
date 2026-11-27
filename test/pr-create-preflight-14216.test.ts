/**
 * #14216 — preflight mecânico no `gh pr create`: `docs/editorial-invariants.md`
 * defasado e PR grande sem `removal-declaration:` são recusados ANTES de a PR
 * existir (a #14120 mediu 5 ciclos de `dev-fixer` causados pelas duas falhas,
 * com as regras já escritas nos itens 13 e 29 das regras de dispatch).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  compareInvariantsDoc,
  decidePrCreatePreflight,
  REGENERATE_INVARIANTS_COMMAND,
} from "../scripts/lib/pr-create-preflight.ts";
import { generateInvariantsMarkdown } from "../scripts/list-invariants.ts";
import {
  PREFLIGHT_PR_GUARD_BYPASS_ENV,
  appliesTo,
  bypassSource,
  extractPrCreateBody,
  handlePayload,
  resolveBody,
  runPreflight,
} from "../.claude/hooks/block-pr-create-preflight.mjs";
import { GUARDS } from "../.claude/hooks/pretooluse-bash-dispatch.mjs";

const ROOT = join(import.meta.dirname, "..");
const BIG = { files: 3, added: 812, removed: 40 };
const SMALL = { files: 1, added: 20, removed: 3 };

describe("decidePrCreatePreflight (#14216)", () => {
  it("documento de invariantes defasado: nega com o comando de regenerar", () => {
    const r = decidePrCreatePreflight({ invariants: { status: "stale" }, stats: SMALL, body: "x" });
    assert.equal(r.deny.length, 1);
    assert.ok(r.deny[0].includes(REGENERATE_INVARIANTS_COMMAND));
  });

  it("documento ausente também nega", () => {
    const r = decidePrCreatePreflight({ invariants: { status: "missing" }, stats: SMALL, body: "x" });
    assert.equal(r.deny.length, 1);
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

  it("compareInvariantsDoc segue o --check (compara aparado)", () => {
    assert.deepEqual(compareInvariantsDoc("a\n", "a"), { status: "ok" });
    assert.deepEqual(compareInvariantsDoc("a", "b"), { status: "stale" });
    assert.deepEqual(compareInvariantsDoc("a", null), { status: "missing" });
  });

  it("o docs/editorial-invariants.md do repo bate com o registry (a regra que o guard confere)", () => {
    const committed = readFileSync(join(ROOT, "docs", "editorial-invariants.md"), "utf8");
    assert.deepEqual(compareInvariantsDoc(generateInvariantsMarkdown(), committed), { status: "ok" });
    assert.equal(compareInvariantsDoc(generateInvariantsMarkdown(), committed + "\n| regra nova | sem regenerar |").status, "stale");
  });
});

describe("extractPrCreateBody (#14216)", () => {
  it("--body com texto", () => {
    assert.deepEqual(extractPrCreateBody("gh pr create --title t --body 'oi removal-declaration: x'"), { kind: "text", body: "oi removal-declaration: x" });
  });
  it("-bTEXTO e --body=TEXTO", () => {
    assert.deepEqual(extractPrCreateBody("gh pr create -B master -bTexto"), { kind: "text", body: "Texto" });
    assert.deepEqual(extractPrCreateBody("gh pr create --body=abc"), { kind: "text", body: "abc" });
  });
  it("--body-file com arquivo", () => {
    assert.deepEqual(extractPrCreateBody("gh pr create --title t --body-file /tmp/pr-body-14216-1.md"), { kind: "file", path: "/tmp/pr-body-14216-1.md" });
    assert.deepEqual(extractPrCreateBody("gh pr create -F b-14216.md"), { kind: "file", path: "b-14216.md" });
  });
  it("--body-file - com heredoc: o corpo do heredoc", () => {
    const r = extractPrCreateBody("gh pr create --title t --body-file - <<'EOF'\nlinha 1\nremoval-declaration: teste de heredoc\nEOF");
    assert.equal(r.kind, "text");
    assert.match((r as { body: string }).body, /removal-declaration: teste de heredoc/);
  });
  it("--body com substituição de comando, --fill e sem corpo: não determinável", () => {
    assert.equal(extractPrCreateBody('gh pr create --title t --body "$(cat <<\'EOF\'\nx\nEOF\n)"').kind, "unknown");
    assert.equal(extractPrCreateBody("gh pr create --fill").kind, "unknown");
    assert.equal(extractPrCreateBody("gh pr create --title t").kind, "unknown");
    assert.equal(extractPrCreateBody('gh pr create --body-file "$F"').kind, "unknown");
  });
  it("texto que só CITA gh pr create não é comando", () => {
    assert.equal(extractPrCreateBody("echo 'gh pr create --body x'").kind, "unknown");
  });
  it("resolveBody lê o arquivo relativo ao cwd e trata ilegível como não determinável", () => {
    const ok = resolveBody({ kind: "file", path: "b-14216.md" }, "/wt", (p: string) => `lido:${p.replaceAll("\\", "/")}`);
    assert.match(String(ok.body), /lido:.*\/wt\/b-14216\.md$/);
    const bad = resolveBody({ kind: "file", path: "x-14216.md" }, "/wt", () => {
      throw new Error("ENOENT");
    });
    assert.equal(bad.body, null);
    assert.match(String(bad.reason), /ENOENT/);
  });
});

describe("hook block-pr-create-preflight (#14216)", () => {
  const payload = (command: string) => ({ tool_name: "Bash", cwd: "/wt", tool_input: { command } });
  const baseDeps = (run: unknown, logs: string[] = []) => ({
    env: {},
    hookDir: "/wt/.claude/hooks",
    resolveRepoRoot: () => "/wt",
    isForeignRepo: () => false,
    isStudio: () => true,
    resolveLogRoot: () => "/wt",
    readFile: () => "corpo sem a linha",
    runPreflightFn: () => run,
    logFn: (m: string) => logs.push(m),
  });

  it("aplica-se a gh pr create (inclusive com atribuição na frente), não a outro comando", () => {
    assert.equal(appliesTo(payload("gh pr create --title x")), true);
    assert.equal(appliesTo(payload("FOO=1 gh pr create --title x")), true);
    assert.equal(appliesTo(payload("gh pr view 1")), false);
    assert.equal(appliesTo({ tool_name: "Edit", tool_input: { command: "gh pr create" } }), false);
  });

  it("deny do preflight vira permissionDecision deny com a mensagem", () => {
    const logs: string[] = [];
    const out = handlePayload(
      payload("gh pr create --title t --body-file b-14216.md"),
      baseDeps({ infra: false, code: 1, result: { deny: ["[#7115] PR adiciona 812 linhas"], warn: [] } }, logs) as never,
    ) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /812 linhas/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(PREFLIGHT_PR_GUARD_BYPASS_ENV));
    assert.deepEqual(logs, ["pr_create_preflight_blocked"]);
  });

  it("o corpo lido chega ao preflight", () => {
    let seen: unknown;
    handlePayload(payload("gh pr create --title t --body-file b-14216.md"), {
      ...baseDeps(null),
      runPreflightFn: (_cwd: string, arg: unknown) => {
        seen = arg;
        return { infra: false, code: 0, result: { deny: [], warn: [] } };
      },
    } as never);
    assert.deepEqual(seen, { body: "corpo sem a linha", bodyReason: null });
  });

  it("aviso sem deny vira systemMessage, sem decisão", () => {
    const out = handlePayload(
      payload("gh pr create --fill"),
      baseDeps({ infra: false, code: 0, result: { deny: [], warn: ["[#7115] corpo não lido"] } }) as never,
    ) as { systemMessage: string; hookSpecificOutput: { permissionDecision?: string } };
    assert.match(out.systemMessage, /corpo não lido/);
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  });

  it("infra é fail-open e logado", () => {
    const logs: string[] = [];
    const out = handlePayload(payload("gh pr create --title t"), baseDeps({ infra: true, output: "timeout" }, logs) as never);
    assert.equal(out, undefined);
    assert.deepEqual(logs, ["pr_create_preflight_infra_error"]);
  });

  it("bypass pela atribuição na frente do comando: não roda e loga", () => {
    const logs: string[] = [];
    let ran = false;
    const out = handlePayload(payload(`${PREFLIGHT_PR_GUARD_BYPASS_ENV}=1 gh pr create --title t`), {
      ...baseDeps(null, logs),
      runPreflightFn: () => {
        ran = true;
        return { infra: true };
      },
    } as never);
    assert.equal(out, undefined);
    assert.equal(ran, false);
    assert.deepEqual(logs, ["pr_create_preflight_bypassed"]);
    assert.equal(bypassSource(`echo '${PREFLIGHT_PR_GUARD_BYPASS_ENV}=1 gh pr create'`, {}), null);
  });

  it("PR de outro repo (diaria-design) fica de fora", () => {
    const out = handlePayload(payload("gh pr create -R vjpixel/diaria-design --title t"), {
      ...baseDeps({ infra: false, code: 1, result: { deny: ["x"], warn: [] } }),
      isForeignRepo: () => true,
    } as never);
    assert.equal(out, undefined);
  });

  it("runPreflight: script ausente no checkout é infra; JSON da última linha é lido", () => {
    assert.equal(runPreflight("/wt", { body: null, bodyReason: "x" }, (() => ({})) as never, () => false).infra, true);
    const fake = () => ({ status: 1, stdout: 'log qualquer\n{"deny":["d"],"warn":[]}\n', stderr: "" });
    const r = runPreflight("/wt", { body: "b", bodyReason: null }, fake as never, () => true);
    assert.equal(r.infra, false);
    assert.deepEqual(r.result.deny, ["d"]);
    assert.equal(runPreflight("/wt", { body: "b", bodyReason: null }, (() => ({ status: null })) as never, () => true).infra, true);
  });

  it("está armado no despachante de PreToolUse/Bash (#14045)", () => {
    assert.ok(GUARDS.some((g: { file: string; mode: string }) => g.file === "block-pr-create-preflight.mjs" && g.mode === "spawn-if-applies"));
  });
});

describe("CLI check-pr-create-preflight (#14216)", () => {
  it("roda no checkout real: registry em dia, corpo com a declaração, nada a negar", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "check-pr-create-preflight.ts"), "--body-stdin"], {
      cwd: ROOT,
      input: "removal-declaration: teste do CLI, nada removido de propósito",
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(String(r.stdout).trim().split("\n").pop() ?? "{}");
    assert.deepEqual(out.deny, []);
  });
});
