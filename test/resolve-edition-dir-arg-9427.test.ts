/**
 * #9427 — publishers do Stage 5 resolvem `--edition-dir` contra a raiz do
 * repo (nunca o cwd) e recusam o path convertido pelo MSYS para a instalação
 * do Git (`C:\Program Files\Git\...`), que foi o sintoma da edição 261002.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveEditionDirArg, tryResolveEditionDirArg, EditionDirArgError } from "../scripts/lib/resolve-edition-dir-arg.ts";

const ROOT = resolve(import.meta.dirname, "..");

test("relativo resolve contra a raiz informada, não contra o cwd", () => {
  const root = "/repo/root";
  assert.equal(
    resolveEditionDirArg("data/editions/2610/261002/", { root, platform: "linux" }),
    "/repo/root/data/editions/2610/261002",
  );
});

test("argumento que resolve para a raiz do filesystem é recusado ('$VAR/' com VAR vazia)", () => {
  assert.throws(() => resolveEditionDirArg("/", { root: "/repo", platform: "linux" }), EditionDirArgError);
  assert.throws(() => resolveEditionDirArg("C:\\", { root: "C:\\repo", platform: "win32" }), EditionDirArgError);
  assert.throws(() => resolveEditionDirArg("/c/", { root: "C:\\repo", platform: "win32" }), EditionDirArgError);
});

test("tryResolveEditionDirArg devolve erro em vez de lançar", () => {
  const bad = tryResolveEditionDirArg("C:/Program Files/Git", { root: "/repo", platform: "linux" });
  assert.equal(bad.ok, false);
  const good = tryResolveEditionDirArg("data/editions/2610/261002", { root: "/repo", platform: "linux" });
  assert.deepEqual(good, { ok: true, editionDir: "/repo/data/editions/2610/261002" });
});

test("absoluto POSIX passa intacto", () => {
  assert.equal(resolveEditionDirArg("/abs/ed/", { root: "/repo", platform: "linux" }), "/abs/ed");
});

test("vazio ou só espaços é erro (nunca a raiz do repo em silêncio)", () => {
  for (const raw of ["", "   ", undefined, null]) {
    assert.throws(() => resolveEditionDirArg(raw, { root: "/repo" }), EditionDirArgError);
  }
});

test("path convertido pelo MSYS para a instalação do Git é recusado (sintoma 261002)", () => {
  for (const raw of [
    "C:\\Program Files\\Git\\",
    "C:/Program Files/Git/",
    "C:/Program Files/Git/data/editions/2610/261002/",
    "C:\\Program Files (x86)\\Git\\",
  ]) {
    assert.throws(
      () => resolveEditionDirArg(raw, { root: "/repo", platform: "win32" }),
      (e: unknown) => e instanceof EditionDirArgError && /MSYS/.test(e.message),
      raw,
    );
  }
});

test("win32: drive estilo MSYS /c/... vira C:/...", () => {
  const out = resolveEditionDirArg("/c/Users/x/diaria/data/editions/2610/261002", { root: "C:/repo", platform: "win32" });
  assert.match(out.replace(/\\/g, "/"), /^C:\/Users\/x\/diaria\/data\/editions\/2610\/261002$/);
});

test("linux: /c/... não é reescrito (path POSIX legítimo)", () => {
  assert.equal(resolveEditionDirArg("/c/foo", { root: "/repo", platform: "linux" }), "/c/foo");
});

test("brevo-diaria-stage5-dispatch CLI: path MSYS da instalação do Git vira JSON failed antes de qualquer passo", () => {
  // Abortar ANTES de runStage5BrevoDispatch é o que torna este spawn seguro:
  // nenhum brevo-diaria-run/publish roda. Sem o fix, o CLI seguiria com
  // `C:\Program Files\Git\` como edition dir (sintoma 261002).
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(ROOT, "scripts/brevo-diaria-stage5-dispatch.ts"), "--edition-dir", "C:/Program Files/Git/"],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
  const out = JSON.parse(r.stdout.trim()) as { status: string; step: string; reason: string };
  assert.equal(out.status, "failed");
  assert.equal(out.step, "args", "nenhum passo do dispatch deveria ter rodado");
  assert.match(out.reason, /MSYS/);
});

test("todos os publishers que parseiam --edition-dir usam o helper (guard estrutural)", () => {
  for (const f of [
    "publish-linkedin.ts",
    "publish-instagram.ts",
    "publish-threads.ts",
    "publish-facebook.ts",
    "brevo-diaria-stage5-dispatch.ts",
    "kit-diaria-stage5-dispatch.ts",
    "publish-daily-brevo.ts",
    "publish-newsletter-kit.ts",
    "schedule-kit-diaria.ts",
    "schedule-daily-brevo.ts",
    "schedule-newsletter-kit.ts",
    "kit-refresh-social-edition-url.ts",
  ]) {
    const src = readFileSync(resolve(ROOT, "scripts", f), "utf8");
    assert.match(src, /(try)?[rR]esolveEditionDirArg(OrExit)?\(/, `${f} não usa o helper`);
    // Nenhuma resolução crua do argumento (cwd OU raiz sem o guard MSYS).
    assert.doesNotMatch(
      src,
      /resolve\(\s*(?:(?:ROOT|rootDir)\s*,\s*)?(?:editionDirArg|editionDirRaw|args\["edition-dir"\][^)]*|getArg\(argv, "edition-dir"\))\s*\)/,
      `${f} resolve --edition-dir sem o helper`,
    );
  }
});
