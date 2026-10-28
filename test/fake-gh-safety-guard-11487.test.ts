/**
 * test/fake-gh-safety-guard-11487.test.ts (#11487)
 *
 * Teste com `gh` falso no PATH escreveu no GitHub real: no Neo (Windows) o
 * shim bash perdeu para o `gh.exe` real e o teste do #9323 aplicou um label e
 * comentou na PR #9204 com a credencial do editor.
 *
 * Três partes:
 *
 * 1. **Sentinela**: o helper `test/_helpers/fake-gh.ts` só devolve o ambiente
 *    quando o `gh` resolvido é o stub (sonda), e falha alto quando não é.
 * 2. **Sem credencial**: o ambiente do helper leva token inválido, host
 *    `.invalid` e config vazia — um `gh` real que escape não autentica.
 * 3. **Guard estrutural**: nenhum arquivo de `test/` monta `gh` falso
 *    PREPENDENDO ao PATH herdado (o padrão do incidente) sem passar pelo
 *    helper. Montar o PATH só com o diretório do fake (`PATH: ghDir`, padrão
 *    dos testes que copiam o `node` como `gh.exe`) é seguro por construção —
 *    o `gh` real não está no PATH — e não é acusado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FAKE_GH_INVALID_HOST,
  FAKE_GH_INVALID_TOKEN,
  FAKE_GH_PROBE_ARG,
  FAKE_GH_SKIP_WIN32,
  assertFakeGhResolves,
  fakeGhEnv,
  withoutGhCredentials,
  writeFakeGh,
} from "./_helpers/fake-gh.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url));
const HELPER = join("test", "_helpers", "fake-gh.ts");

// ---------------------------------------------------------------------------
// Detecção (pura, exercitada por fixture abaixo)
// ---------------------------------------------------------------------------

/** O arquivo cria um executável `gh` e mexe no PATH de um processo filho. */
export function isFakeGhCandidate(src: string): boolean {
  const ghLiteral = /["'`]gh(?:\.exe|\.cmd|\.bat)?["'`]/.test(src);
  const writesFile = /\b(?:writeFileSync|copyFileSync|symlinkSync|linkSync)\s*\(/.test(src);
  const touchesPath = /\b(?:PATH|Path)\s*:|\[\s*pathKey\s*\]|\.PATH\s*=/.test(src);
  return ghLiteral && writesFile && touchesPath;
}

/**
 * Template literal que põe algo NA FRENTE do PATH herdado (`${dir}:${PATH}`,
 * `${dir}${delimiter}${env[pathKey]}`). É o que deixa o `gh` real alcançável
 * quando o fake não vence a resolução.
 */
export function prependsInheritedPath(src: string): boolean {
  return /`[^`]*(?::|;|\$\{\s*delimiter\s*\})\$\{[^}]*(?:PATH|Path|pathKey)[^}]*\}/.test(src);
}

/** Usa o helper (import + chamada da sonda, direta ou via `fakeGhEnv`). */
export function usesFakeGhHelper(src: string): boolean {
  return /_helpers\/fake-gh(?:\.ts)?["']/.test(src) && /\b(?:fakeGhEnv|assertFakeGhResolves)\s*\(/.test(src);
}

export function isFakeGhOffender(src: string): boolean {
  return isFakeGhCandidate(src) && prependsInheritedPath(src) && !usesFakeGhHelper(src);
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
    return e.isFile() && p.endsWith(".ts") ? [p] : [];
  });
}

// ---------------------------------------------------------------------------
// 1. Sentinela
// ---------------------------------------------------------------------------

describe("#11487 — sentinela: o gh resolvido tem de ser o stub", () => {
  it("fakeGhEnv devolve o ambiente quando o stub vence a resolução", { skip: FAKE_GH_SKIP_WIN32 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-gh-sentinela-"));
    try {
      writeFakeGh(dir, "#!/usr/bin/env bash\necho stub-chamado\n");
      const env = fakeGhEnv(dir);
      assert.doesNotThrow(() => assertFakeGhResolves(env));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shim em node também responde à sonda", { skip: FAKE_GH_SKIP_WIN32 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-gh-sentinela-node-"));
    try {
      writeFakeGh(dir, "#!/usr/bin/env node\nprocess.stdout.write('stub');\n");
      assert.doesNotThrow(() => fakeGhEnv(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("LANÇA quando o diretório do fake não tem gh (o PATH herdado resolveria o real)", () => {
    // É o cenário do incidente: o fake não vence e o próximo `gh` do PATH é
    // o real. Aqui o diretório nem tem `gh`, então a sonda cai no real (ou em
    // nenhum) e precisa falhar — em qualquer plataforma.
    const dir = mkdtempSync(join(tmpdir(), "fake-gh-sem-stub-"));
    try {
      assert.throws(() => fakeGhEnv(dir), /\[fake-gh #11487\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("LANÇA quando o gh resolvido é um impostor que não responde à sonda", { skip: FAKE_GH_SKIP_WIN32 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-gh-impostor-"));
    try {
      // Escrito à mão, sem o helper: faz o papel do `gh` real.
      const gh = join(dir, "gh");
      writeFileSync(gh, "#!/usr/bin/env bash\necho \"unknown command $1\" >&2\nexit 1\n");
      chmodSync(gh, 0o755);
      assert.throws(() => fakeGhEnv(dir), /NÃO é o falso/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeFakeGh recusa script sem shebang (o shim não teria como responder à sonda)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-gh-sem-shebang-"));
    try {
      assert.throws(() => writeFakeGh(dir, "echo oi\n"), /shebang/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o argumento da sonda não colide com subcomando real do gh", () => {
    assert.match(FAKE_GH_PROBE_ARG, /^__.*__$/);
  });
});

// ---------------------------------------------------------------------------
// 2. Sem credencial
// ---------------------------------------------------------------------------

describe("#11487 — ambiente do gh falso não carrega credencial", () => {
  it("token inválido (vence keyring/hosts.yml), host .invalid, config vazia, sem token Enterprise", () => {
    const env = withoutGhCredentials({
      GH_TOKEN: "ghp_real",
      GITHUB_TOKEN: "ghs_real",
      GH_ENTERPRISE_TOKEN: "x",
      GITHUB_ENTERPRISE_TOKEN: "y",
      GH_HOST: "github.com",
      GH_CONFIG_DIR: "/home/editor/.config/gh",
    });
    assert.equal(env.GH_TOKEN, FAKE_GH_INVALID_TOKEN);
    assert.equal(env.GITHUB_TOKEN, FAKE_GH_INVALID_TOKEN);
    assert.equal(env.GH_HOST, FAKE_GH_INVALID_HOST);
    assert.ok(FAKE_GH_INVALID_HOST.endsWith(".invalid"));
    assert.equal(env.GH_ENTERPRISE_TOKEN, undefined);
    assert.equal(env.GITHUB_ENTERPRISE_TOKEN, undefined);
    assert.notEqual(env.GH_CONFIG_DIR, "/home/editor/.config/gh");
    assert.deepEqual(readdirSync(env.GH_CONFIG_DIR as string), [], "GH_CONFIG_DIR precisa estar vazio");
  });

  it("fakeGhEnv aplica a neutralização e mantém o extra do teste", { skip: FAKE_GH_SKIP_WIN32 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-gh-cred-"));
    try {
      writeFakeGh(dir, "#!/bin/sh\nexit 0\n");
      const env = fakeGhEnv(dir, { FAKE_X: "1" }, { PATH: process.env.PATH, GH_TOKEN: "ghp_real" });
      assert.equal(env.GH_TOKEN, FAKE_GH_INVALID_TOKEN);
      assert.equal(env.FAKE_X, "1");
      assert.ok((env.PATH ?? "").startsWith(dir), "o diretório do fake vem primeiro no PATH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Guard estrutural
// ---------------------------------------------------------------------------

describe("#11487 — guard estrutural: gh falso prependido ao PATH só via helper", () => {
  it("nenhum arquivo de test/ prepende gh falso ao PATH herdado sem o helper", () => {
    const ofensores: string[] = [];
    for (const file of walk(join(REPO_ROOT, "test"))) {
      const rel = relative(REPO_ROOT, file);
      if (rel === SELF || rel === HELPER) continue;
      if (isFakeGhOffender(readFileSync(file, "utf8"))) ofensores.push(rel);
    }
    assert.deepEqual(
      ofensores,
      [],
      "teste monta gh falso na frente do PATH herdado sem test/_helpers/fake-gh.ts — fora do Linux o gh real " +
        "pode vencer e escrever no GitHub com a credencial de quem roda (#11487). Use writeFakeGh + fakeGhEnv:\n" +
        ofensores.join("\n"),
    );
  });

  it("a varredura não é vazia: acha os testes de gh falso que já existem", () => {
    const candidatos = walk(join(REPO_ROOT, "test")).filter((f) => isFakeGhCandidate(readFileSync(f, "utf8")));
    assert.ok(candidatos.length >= 5, `esperava vários testes de gh falso, achei ${candidatos.length}`);
  });

  it("as exclusões existem de fato", () => {
    assert.ok(existsSync(join(REPO_ROOT, HELPER)));
    assert.ok(existsSync(join(REPO_ROOT, SELF)));
  });

  it("ACUSA o padrão do incidente (#9323 antes do fix)", () => {
    const incidente = [
      'const bin = join(dir, "gh");',
      'writeFileSync(bin, `#!/usr/bin/env bash\\nexec node x "$@"\\n`, "utf8");',
      "chmodSync(bin, 0o755);",
      'execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` } });',
    ].join("\n");
    assert.equal(isFakeGhOffender(incidente), true);
  });

  it("ACUSA a variante com delimiter e pathKey", () => {
    const comDelimiter = 'writeFileSync(join(cwd, "gh"), s); spawnSync(t, [], { env: { ...process.env, PATH: `${cwd}${delimiter}${process.env.PATH ?? ""}` } });';
    assert.equal(isFakeGhOffender(comDelimiter), true);
    const comPathKey = 'writeFileSync(join(b, "gh"), s); env[pathKey] = `${b}${delimiter}${env[pathKey] ?? ""}`;';
    assert.equal(isFakeGhOffender(comPathKey), true);
  });

  it("não acusa quem usa o helper", () => {
    const migrado = [
      'import { fakeGhEnv, writeFakeGh } from "./_helpers/fake-gh.ts";',
      'writeFakeGh(dir, "#!/bin/sh\\nexit 0\\n"); writeFileSync(join(dir, "gh"), x);',
      "spawnSync(t, [], { env: fakeGhEnv(dir, { PATH: `${a}:${process.env.PATH}` }) });",
    ].join("\n");
    assert.equal(isFakeGhOffender(migrado), false);
  });

  it("não acusa PATH montado só com o diretório do fake (gh real fora do PATH)", () => {
    const isolado = [
      'const ghBin = join(ghDir, process.platform === "win32" ? "gh.exe" : "gh");',
      "copyFileSync(process.execPath, ghBin);",
      "const env = { ...process.env, PATH: ghDir, Path: ghDir };",
    ].join("\n");
    assert.equal(isFakeGhOffender(isolado), false);
  });

  it("import do helper sem chamar a sonda não basta", () => {
    const soImport = [
      'import { writeFakeGh } from "./_helpers/fake-gh.ts";',
      'writeFileSync(join(dir, "gh"), s);',
      "spawnSync(t, [], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });",
    ].join("\n");
    assert.equal(isFakeGhOffender(soImport), true);
  });
});
