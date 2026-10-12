/**
 * test/cleanup-tmp-300-symlink-10063.test.ts (#10063)
 *
 * Regressão do OOM diário da unit `diaria-tmp-cleanup`: `newestMtimeMs`
 * usava `readdirSync(path, { recursive: true })`, que no Node 24 desce em
 * symlink de diretório. Scratchpads de sessão guardam symlinks pro `data/`
 * (OneDrive) e pro `node_modules` — a varredura enumerava tudo isso e
 * estourava o heap (4,3 GB). Aqui: symlink nunca é seguido (nem o mtime do
 * alvo conta), ciclo de symlink não trava, e o atalho `stopAtMs` funciona.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync, lutimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { newestMtimeMs, collectSessionDirs } from "../scripts/cleanup-tmp-300.ts";
import { SESSION_DIR_MIN_AGE_MS } from "../scripts/lib/tmp-cleanup.ts";

const DAY = 24 * 60 * 60 * 1000;
let root: string;

function setOld(path: string, ms: number, link = false): void {
  const t = new Date(ms);
  if (link) lutimesSync(path, t, t);
  else utimesSync(path, t, t);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tmp-cleanup-10063-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("#10063 — newestMtimeMs nunca segue symlink", () => {
  it("symlink pra diretório com arquivo NOVO não torna a sessão recente (mtime do alvo não conta)", () => {
    const old = Date.now() - 10 * DAY;
    const external = join(root, "external-data");
    mkdirSync(external);
    writeFileSync(join(external, "fresh.txt"), "x"); // mtime = agora

    const session = join(root, "session");
    mkdirSync(join(session, "scratchpad"), { recursive: true });
    writeFileSync(join(session, "scratchpad", "a.txt"), "a");
    symlinkSync(external, join(session, "scratchpad", "data"));

    setOld(join(session, "scratchpad", "data"), old, true);
    setOld(join(session, "scratchpad", "a.txt"), old);
    setOld(join(session, "scratchpad"), old);
    setOld(session, old);

    const m = newestMtimeMs(session);
    assert.ok(Math.abs(m - old) < 1000, `esperava ~${old}, veio ${m} (seguiu o symlink?)`);
  });

  it("ciclo de symlink (a/up -> ..) termina e não multiplica entradas", () => {
    const session = join(root, "session");
    mkdirSync(join(session, "a"), { recursive: true });
    symlinkSync("..", join(session, "a", "up"));
    const t0 = Date.now();
    const m = newestMtimeMs(session);
    assert.ok(m > 0);
    assert.ok(Date.now() - t0 < 2000, "varredura não deveria demorar com um ciclo");
  });

  it("arquivo novo de verdade (não-symlink) dentro da sessão continua contando", () => {
    const old = Date.now() - 10 * DAY;
    const session = join(root, "session");
    mkdirSync(join(session, "tasks"), { recursive: true });
    writeFileSync(join(session, "tasks", "x.output"), "x"); // agora
    setOld(join(session, "tasks"), old);
    setOld(session, old);
    assert.ok(Date.now() - newestMtimeMs(session) < 60_000);
  });

  it("stopAtMs retorna cedo assim que acha um mtime acima do limiar", () => {
    const session = join(root, "session");
    mkdirSync(session);
    writeFileSync(join(session, "f"), "x");
    const cutoff = Date.now() - DAY;
    assert.ok(newestMtimeMs(session, cutoff) >= cutoff);
  });

  it("collectSessionDirs: sessão velha com symlink pra dado fresco sai velha (candidata), e o alvo nunca é tocado", () => {
    const now = Date.now();
    const old = now - SESSION_DIR_MIN_AGE_MS - DAY;
    const external = join(root, "external");
    mkdirSync(external);
    writeFileSync(join(external, "keep.txt"), "x");

    const claudeDir = join(root, "claude-1000");
    const session = join(claudeDir, "-home-x-proj", "sess-1");
    mkdirSync(session, { recursive: true });
    symlinkSync(external, join(session, "data"));
    setOld(join(session, "data"), old, true);
    setOld(session, old);

    const dirs = collectSessionDirs(claudeDir, now);
    assert.equal(dirs.length, 1);
    assert.ok(dirs[0].mtimeMs <= old + 1000);
    // Mesma chamada que o main() usa pra podar: remove o LINK, nunca o alvo
    // (o alvo real em produção é o data/ do OneDrive).
    rmSync(dirs[0].path, { recursive: true, force: true });
    assert.equal(existsSync(session), false);
    assert.ok(existsSync(join(external, "keep.txt")));
  });
});
