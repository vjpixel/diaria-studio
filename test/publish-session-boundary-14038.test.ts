/**
 * test/publish-session-boundary-14038.test.ts (#14038, #14027)
 *
 * Transcript 760277da (261119): `/diaria-edicao` e `/diaria-publica` na mesma
 * sessão, 591k de contexto no início da Etapa 5. Nada conferia a fronteira
 * pós-gate 4 do #6171. Agora o sentinel do Stage 4 grava o `session_id` e o
 * Passo 0 das duas skills de publicação para quando é a mesma sessão.
 *
 * #14027: o Passo 0 do `/diaria-publica` passa a esperar o sync do sentinel
 * (`assert --wait-seconds 180`), como a Etapa 5 desde o #13851.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSentinel, writeSentinel } from "../scripts/lib/pipeline-state.ts";
import {
  assessPublishSessionBoundary,
  describePublishSessionBoundary,
} from "../scripts/lib/publish-session-boundary.ts";
import { resolveEditionDirSafe } from "../scripts/check-publish-session-boundary.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sentinelCli = join(repoRoot, "scripts", "pipeline-sentinel.ts");
const boundaryCli = join(repoRoot, "scripts", "check-publish-session-boundary.ts");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");

const GATE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

function makeEdition(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "publish-session-14038-"));
  const dir = join(root, "261119");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), "revisado");
  writeFileSync(join(dir, "03-social.md"), "social");
  return { root, dir };
}

/** Ambiente sem a sessão do harness que roda o teste (ela vazaria para o CLI). */
function envWithSession(id: string | null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  if (id) env.CLAUDE_CODE_SESSION_ID = id;
  return env;
}

function run(cli: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { cwd: repoRoot, encoding: "utf8", env });
}

describe("assessPublishSessionBoundary (#14038)", () => {
  it("mesma sessão do gate 4: same-session", () => {
    assert.deepEqual(
      assessPublishSessionBoundary({ sentinelPresent: true, stage4SessionId: GATE, currentSessionId: ` ${GATE} ` }),
      { verdict: "same-session", sessionId: GATE },
    );
  });

  it("sessão diferente: new-session", () => {
    assert.deepEqual(
      assessPublishSessionBoundary({ sentinelPresent: true, stage4SessionId: GATE, currentSessionId: OTHER }),
      { verdict: "new-session", stage4SessionId: GATE, currentSessionId: OTHER },
    );
  });

  it("sem como comparar: unknown, nunca same-session (fail-open)", () => {
    assert.equal(
      assessPublishSessionBoundary({ sentinelPresent: false, stage4SessionId: GATE, currentSessionId: GATE }).verdict,
      "unknown",
    );
    assert.deepEqual(
      assessPublishSessionBoundary({ sentinelPresent: true, stage4SessionId: undefined, currentSessionId: GATE }),
      { verdict: "unknown", reason: "sentinel_without_session" },
    );
    assert.deepEqual(
      assessPublishSessionBoundary({ sentinelPresent: true, stage4SessionId: GATE, currentSessionId: "  " }),
      { verdict: "unknown", reason: "current_session_unknown" },
    );
  });

  it("sentinel presente mas ilegível: motivo próprio, ainda fail-open", () => {
    assert.deepEqual(
      assessPublishSessionBoundary({ sentinelPresent: true, sentinelUnreadable: true, stage4SessionId: undefined, currentSessionId: GATE }),
      { verdict: "unknown", reason: "sentinel_unreadable" },
    );
    assert.match(
      describePublishSessionBoundary({ verdict: "unknown", reason: "sentinel_unreadable" }, "261119") ?? "",
      /ilegível/,
    );
  });

  it("o halt pede sessão nova (não só /clear), cita a Etapa 4 refeita e o override", () => {
    const halt = describePublishSessionBoundary({ verdict: "same-session", sessionId: GATE }, "261119");
    assert.match(halt ?? "", /abrir uma sessão nova do Claude Code/);
    assert.match(halt ?? "", /\/clear pode não bastar/);
    assert.match(halt ?? "", /refazer a Etapa 4 dentro da sessão de publicação/);
    assert.match(halt ?? "", /--allow-same-session/);
    assert.match(halt ?? "", /#6171/);
    assert.match(
      describePublishSessionBoundary({ verdict: "unknown", reason: "sentinel_without_session" }, "261119") ?? "",
      /^\[aviso\]/,
    );
    assert.equal(
      describePublishSessionBoundary({ verdict: "new-session", stage4SessionId: GATE, currentSessionId: OTHER }, "x"),
      null,
    );
  });
});

describe("sentinel do Stage 4 grava o session_id (#14038)", () => {
  it("writeSentinel grava session_id só quando há id", () => {
    const { root, dir } = makeEdition();
    try {
      writeSentinel(dir, 4, ["02-reviewed.md"], { sessionId: GATE });
      assert.equal(readSentinel(dir, 4)?.session_id, GATE);
      writeSentinel(dir, 3, ["02-reviewed.md"], { sessionId: "  " });
      assert.equal("session_id" in (readSentinel(dir, 3) ?? {}), false);
      writeSentinel(dir, 2, ["02-reviewed.md"]);
      assert.equal("session_id" in (readSentinel(dir, 2) ?? {}), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CLI write --step 4 lê CLAUDE_CODE_SESSION_ID; o check sai 3 na mesma sessão e 0 em outra", () => {
    const { root, dir } = makeEdition();
    try {
      // `--dir` fora do layout da diária: o gate de invariantes do write não roda.
      const w = run(sentinelCli, ["write", "--edition", "261119", "--step", "4", "--dir", dir, "--outputs", "02-reviewed.md,03-social.md"], envWithSession(GATE));
      assert.equal(w.status, 0, w.stderr);
      const sentinel = JSON.parse(readFileSync(join(dir, "_internal", ".step-4-done.json"), "utf8"));
      assert.equal(sentinel.session_id, GATE);

      const same = run(boundaryCli, ["--edition", "261119", "--dir", dir], envWithSession(GATE));
      assert.equal(same.status, 3, same.stderr);
      assert.equal(JSON.parse(same.stdout).verdict, "same-session");
      assert.match(same.stderr, /sessão nova do Claude Code/);

      const allowed = run(boundaryCli, ["--edition", "261119", "--dir", dir, "--allow-same-session"], envWithSession(GATE));
      assert.equal(allowed.status, 0, allowed.stderr);
      assert.match(allowed.stderr, /--allow-same-session/);

      const fresh = run(boundaryCli, ["--edition", "261119", "--dir", dir], envWithSession(OTHER));
      assert.equal(fresh.status, 0, fresh.stderr);
      assert.equal(JSON.parse(fresh.stdout).verdict, "new-session");
      assert.equal(fresh.stderr.trim(), "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sentinel legado (sem session_id) e sessão desconhecida seguem com aviso, exit 0", () => {
    const { root, dir } = makeEdition();
    try {
      writeSentinel(dir, 4, ["02-reviewed.md"]);
      const legacy = run(boundaryCli, ["--edition", "261119", "--dir", dir], envWithSession(GATE));
      assert.equal(legacy.status, 0, legacy.stderr);
      assert.match(legacy.stderr, /sem session_id/);

      writeSentinel(dir, 4, ["02-reviewed.md"], { sessionId: GATE });
      const noEnv = run(boundaryCli, ["--edition", "261119", "--dir", dir], envWithSession(null));
      assert.equal(noEnv.status, 0, noEnv.stderr);
      assert.match(noEnv.stderr, /sessão corrente desconhecida/);

      // Sentinel malformado: aviso "ilegível", exit 0 (fail-open).
      writeFileSync(join(dir, "_internal", ".step-4-done.json"), "{não é json");
      const bad = run(boundaryCli, ["--edition", "261119", "--dir", dir], envWithSession(GATE));
      assert.equal(bad.status, 0, bad.stderr);
      assert.equal(JSON.parse(bad.stdout).reason, "sentinel_unreadable");
      assert.match(bad.stderr, /ilegível/);

      const usage = run(boundaryCli, [], envWithSession(GATE));
      assert.equal(usage.status, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveEditionDirSafe (#14038)", () => {
  it("exceção do resolvedor vira erro (exit 2 no CLI), nunca crash", () => {
    const r = resolveEditionDirSafe({ edition: "261119" }, () => {
      throw new Error("EACCES data/editions");
    });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /^\[error\] diretório da edição 261119 não resolvido: EACCES data\/editions/);
    assert.deepEqual(resolveEditionDirSafe({ edition: "261119" }, () => "/x/261119"), { ok: true, dir: "/x/261119" });
  });
});

describe("skills de publicação (#14038, #14027)", () => {
  it("/diaria-publica Passo 0: assert com a espera do sync e o check de sessão", () => {
    const skill = read(".claude/skills/diaria-publica/SKILL.md");
    const start = skill.indexOf("## Passo 0 — Pré-condição: Stage 4 aprovado");
    assert.ok(start > 0, "Passo 0 do /diaria-publica");
    const passo0 = skill.slice(start, skill.indexOf("\n## ", start + 5));
    assert.match(passo0, /pipeline-sentinel\.ts assert --edition \{AAMMDD\} --step 4 --sync-hint --wait-seconds 180/);
    assert.doesNotMatch(passo0, /pipeline-sentinel\.ts exists/);
    assert.match(passo0, /timeout: 240000/);
    assert.match(passo0, /exit 64/);
    const sentinelAt = passo0.indexOf("pipeline-sentinel.ts assert");
    const boundaryAt = passo0.indexOf("check-publish-session-boundary.ts --edition {AAMMDD}");
    assert.ok(boundaryAt > sentinelAt, "check de sessão depois do sentinel");
    assert.match(passo0, /exit 3[\s\S]{0,120}parar antes de qualquer outro passo/);
  });

  it("/diaria-5-publicacao confere a sessão antes do dispatch", () => {
    const skill = read(".claude/skills/diaria-5-publicacao/SKILL.md");
    const at = skill.indexOf("check-publish-session-boundary.ts --edition {AAMMDD}");
    assert.ok(at > 0, "check de sessão no /diaria-5-publicacao");
    assert.ok(at < skill.indexOf("## Passo 0 — Confirmar modo de publicação"), "antes do Passo 0 (dispatch)");
    assert.match(skill, /exit 3[\s\S]{0,80}parar antes de qualquer dispatch/);
  });

  it("as duas skills pedem sessão nova (não só /clear), citam a Etapa 4 refeita, o override e o exit 2", () => {
    for (const p of [".claude/skills/diaria-publica/SKILL.md", ".claude/skills/diaria-5-publicacao/SKILL.md"]) {
      const skill = read(p);
      assert.match(skill, /abrir uma sessão nova do Claude Code \(nova conversa ou janela\)/, p);
      assert.match(skill, /\/clear pode não bastar/, p);
      assert.doesNotMatch(skill, /rodar \/clear \(ou abrir sessão nova\)/, p);
      assert.match(skill, /[Rr]efazer a Etapa 4 dentro d/, p);
      assert.match(skill, /--allow-same-session/, p);
      assert.match(skill, /diretório da edição não resolvido/, p);
    }
  });
});
