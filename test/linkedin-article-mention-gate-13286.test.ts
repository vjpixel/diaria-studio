/**
 * #13286 — o `social-schedule-rotation.ts --record` da linha
 * `linkedin_article` recusa quando a conferência da menção @diar.ia.br do
 * post de feed (#13261) não existe para o ciclo ou reprovou. Cenário de
 * origem: a conferência era só prosa da skill, e nada impedia registrar o
 * agendamento sem ela.
 *
 * Os testes de CLI usam `--log` e `--weekly-root` em diretórios temporários:
 * nada toca `data/` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  FEED_POST_MENTION_REL,
  checkLinkedinArticleMentionGate,
} from "../scripts/lib/linkedin-article-mention-gate.ts";
import { FEED_POST_MENTION_REL as AUDIT_REL } from "../scripts/weekly-feed-post-mention-audit.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "scripts", "social-schedule-rotation.ts");

/** 261026 (segunda de publicação) → ciclo 26w43 (semana de conteúdo 19-23/10). */
const CYCLE = "26w43";

function withWeekly(audit: unknown | null, fn: (weeklyRoot: string, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mention-gate-13286-"));
  try {
    const weeklyRoot = join(dir, "weekly");
    mkdirSync(join(weeklyRoot, CYCLE, "_internal"), { recursive: true });
    if (audit !== null) {
      writeFileSync(
        join(weeklyRoot, CYCLE, FEED_POST_MENTION_REL),
        typeof audit === "string" ? audit : JSON.stringify(audit),
      );
    }
    fn(weeklyRoot, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const approved = { em: "2026-10-25T12:00:00.000Z", ok: true, status: "mention", message: "menção confirmada" };

describe("checkLinkedinArticleMentionGate (#13286)", () => {
  it("o CLI da conferência e a trava leem o mesmo arquivo", () => {
    assert.equal(AUDIT_REL, FEED_POST_MENTION_REL);
  });

  it("sem o arquivo da conferência: recusa, citando o ciclo", () => {
    withWeekly(null, (weeklyRoot) => {
      const g = checkLinkedinArticleMentionGate({ publishDate: "2026-10-26", weeklyRoot });
      assert.equal(g.ok, false);
      assert.equal(g.cycle, CYCLE);
      assert.match((g as { reason: string }).reason, /ausente para o ciclo 26w43/);
    });
  });

  it("conferência aprovada (mention ou not-needed): passa; aceita AAMMDD também", () => {
    withWeekly(approved, (weeklyRoot) => {
      const g = checkLinkedinArticleMentionGate({ publishDate: "261026", weeklyRoot });
      assert.deepEqual({ ok: g.ok, cycle: g.cycle }, { ok: true, cycle: CYCLE });
    });
    withWeekly({ ok: true, status: "not-needed", message: "x" }, (weeklyRoot) => {
      assert.equal(checkLinkedinArticleMentionGate({ publishDate: "2026-10-26", weeklyRoot }).ok, true);
    });
  });

  it("reprovada (plain-text, site-link, missing): recusa, mesmo com allowUnverified", () => {
    for (const status of ["plain-text", "site-link", "missing"]) {
      withWeekly({ ok: false, status, message: "texto puro" }, (weeklyRoot) => {
        const g = checkLinkedinArticleMentionGate({ publishDate: "2026-10-26", weeklyRoot, allowUnverified: true });
        assert.equal(g.ok, false, status);
        assert.match((g as { reason: string }).reason, new RegExp(`reprovou: status '${status}'`));
      });
    }
  });

  it("unverified: recusa por padrão, passa com allowUnverified", () => {
    withWeekly({ ok: false, status: "unverified", message: "sem sinal" }, (weeklyRoot) => {
      const g = checkLinkedinArticleMentionGate({ publishDate: "2026-10-26", weeklyRoot });
      assert.equal(g.ok, false);
      assert.match((g as { reason: string }).reason, /--mention-visual-ok/);
      assert.equal(checkLinkedinArticleMentionGate({ publishDate: "2026-10-26", weeklyRoot, allowUnverified: true }).ok, true);
    });
  });

  it("JSON corrompido ou ok:true com status estranho: recusa", () => {
    withWeekly("{quebrado", (weeklyRoot) => {
      assert.equal(checkLinkedinArticleMentionGate({ publishDate: "2026-10-26", weeklyRoot }).ok, false);
    });
    withWeekly({ ok: true, status: "plain-text" }, (weeklyRoot) => {
      assert.equal(checkLinkedinArticleMentionGate({ publishDate: "2026-10-26", weeklyRoot }).ok, false);
    });
  });

  it("data inválida: recusa sem ciclo", () => {
    const g = checkLinkedinArticleMentionGate({ publishDate: "lixo", weeklyRoot: tmpdir() });
    assert.deepEqual({ ok: g.ok, cycle: g.cycle }, { ok: false, cycle: null });
  });
});

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: ROOT, encoding: "utf8" });
}

describe("CLI --record --kind linkedin_article (#13286)", () => {
  const base = ["--record", "--date", "261026", "--kind", "linkedin_article"];

  it("agendar sem a conferência: exit 1, nada gravado", () => {
    withWeekly(null, (weeklyRoot, dir) => {
      const log = join(dir, "rot.jsonl");
      const r = runCli([...base, "--weekly-root", weeklyRoot, "--log", log]);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stderr, /#13286.*recusado.*ausente para o ciclo 26w43/);
      assert.equal(existsSync(log), false);
    });
  });

  it("conferência reprovada: exit 1, nada gravado (também com --time)", () => {
    withWeekly({ ok: false, status: "plain-text", message: "texto puro" }, (weeklyRoot, dir) => {
      const log = join(dir, "rot.jsonl");
      for (const extra of [[], ["--time", "14:25"]]) {
        const r = runCli([...base, ...extra, "--weekly-root", weeklyRoot, "--log", log]);
        assert.equal(r.status, 1, r.stdout);
        assert.match(r.stderr, /plain-text/);
      }
      assert.equal(existsSync(log), false);
    });
  });

  it("conferência aprovada: grava a linha", () => {
    withWeekly(approved, (weeklyRoot, dir) => {
      const log = join(dir, "rot.jsonl");
      const r = runCli([...base, "--weekly-root", weeklyRoot, "--log", log]);
      assert.equal(r.status, 0, r.stderr);
      const row = JSON.parse(readFileSync(log, "utf8").trim());
      assert.equal(row.kind, "linkedin_article");
    });
  });

  it("unverified + --mention-visual-ok: grava", () => {
    withWeekly({ ok: false, status: "unverified", message: "sem sinal" }, (weeklyRoot, dir) => {
      const log = join(dir, "rot.jsonl");
      assert.equal(runCli([...base, "--weekly-root", weeklyRoot, "--log", log]).status, 1);
      const r = runCli([...base, "--weekly-root", weeklyRoot, "--log", log, "--mention-visual-ok"]);
      assert.equal(r.status, 0, r.stderr);
    });
  });

  it("dia útil (--kind weekday) na mesma segunda não depende da conferência", () => {
    withWeekly(null, (weeklyRoot, dir) => {
      const log = join(dir, "rot.jsonl");
      const r = runCli(["--record", "--date", "261026", "--kind", "weekday", "--weekly-root", weeklyRoot, "--log", log]);
      assert.equal(r.status, 0, r.stderr);
    });
  });
});
