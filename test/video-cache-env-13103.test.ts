/**
 * #13103 — `DIARIA_VIDEO_CACHE_DIR` só no `.env` do projeto (não no ambiente
 * do processo) era ignorada pela montagem e pelo `check-video-env.ts
 * --montagem`: nenhum dos dois carregava o `.env`, e o cache ia para
 * `~/.cache/diaria-video-montagem`, no disco do sistema (achado no 300 na
 * limpeza de disco da #12931).
 *
 * O teste de regressão da montagem é de comportamento: um `.env` de sandbox
 * com a variável apontando para um HD "desmontado" (diretório inexistente)
 * tem que fazer o `cliMain` parar com o erro do #12365 citando esse caminho,
 * antes de qualquer acesso ao Drive. Sem o carregamento, a variável nunca
 * chega e a montagem segue para a rede (o `driveFetch` falso acusa).
 * `check-video-env.ts` e `prune-video-montage-cache.ts` não têm ponto de
 * injeção do `.env` sem rede/subprocesso, então a ordem é conferida no fonte:
 * `loadProjectEnv` antes de ler a variável.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliMain } from "../scripts/video-montagem.ts";
import type { MontageDriveDeps } from "../scripts/lib/diaria/video-montage-drive.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ED = "261112";
const VARS = ["DIARIA_VIDEO_CACHE_DIR", "DIARIA_VIDEO_DRIVE_ROOT", "HOME"] as const;

const noNetwork: MontageDriveDeps = {
  driveFetch: () => {
    throw new Error("rede chamada: o cache não saiu do .env");
  },
};

async function withSandbox(fn: (base: string) => Promise<void>): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "vm-env-13103-"));
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  try {
    mkdirSync(join(base, "home"));
    process.env.HOME = join(base, "home");
    delete process.env.DIARIA_VIDEO_CACHE_DIR;
    delete process.env.DIARIA_VIDEO_DRIVE_ROOT;
    await fn(base);
  } finally {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(base, { recursive: true, force: true });
  }
}

const args = (base: string) => ["transcribe", ED, "--from-drive", "--state-dir", join(base, "state")];

describe("#13103 montagem lê DIARIA_VIDEO_CACHE_DIR do .env", { skip: process.platform === "win32" ? "POSIX (HOME)" : false }, () => {
  it("variável só no .env chega à resolução do cache (HD desmontado para antes do Drive)", async () => {
    await withSandbox(async (base) => {
      const hd = join(base, "hd-desmontado", "cache");
      writeFileSync(join(base, ".env"), `DIARIA_VIDEO_CACHE_DIR=${hd}\n`);
      await assert.rejects(cliMain(args(base), noNetwork, base, { path: join(base, "gpu.lock") }), (e: Error) => {
        assert.match(e.message, /DIARIA_VIDEO_CACHE_DIR aponta para/);
        assert.ok(e.message.includes(hd), e.message);
        return true;
      });
    });
  });

  it("o ambiente do processo continua vencendo o .env", async () => {
    await withSandbox(async (base) => {
      const fromEnvFile = join(base, "do-env-file");
      const fromProcess = join(base, "do-processo");
      writeFileSync(join(base, ".env"), `DIARIA_VIDEO_CACHE_DIR=${fromEnvFile}\n`);
      process.env.DIARIA_VIDEO_CACHE_DIR = fromProcess;
      await assert.rejects(cliMain(args(base), noNetwork, base, { path: join(base, "gpu.lock") }), (e: Error) => {
        assert.ok(e.message.includes(fromProcess), e.message);
        assert.ok(!e.message.includes(fromEnvFile), e.message);
        return true;
      });
    });
  });
});

/** Corpo de `function main(` até o fim do arquivo (o `main` é a última função antes do guard de CLI). */
function mainBody(rel: string): string {
  const src = readFileSync(join(REPO, rel), "utf8");
  const at = src.search(/\n(?:export )?(?:async )?function main\(/);
  assert.ok(at >= 0, `${rel}: sem function main(`);
  return src.slice(at);
}

describe("#13103 .env carregado antes de ler a variável", () => {
  for (const [rel, reads] of [
    ["scripts/check-video-env.ts", "runMontageEnvCheck("],
    ["scripts/prune-video-montage-cache.ts", "process.env.DIARIA_VIDEO_CACHE_DIR"],
  ] as const) {
    it(`${rel}: loadProjectEnv(ROOT) vem antes de ${reads}`, () => {
      const body = mainBody(rel);
      const load = body.indexOf("loadProjectEnv(ROOT)");
      const read = body.indexOf(reads);
      assert.ok(load >= 0, `${rel}: main não chama loadProjectEnv(ROOT)`);
      assert.ok(read > load, `${rel}: ${reads} antes do loadProjectEnv`);
    });
  }

  it("scripts/video-montagem.ts: o guard de CLI chama cliMain, não main", () => {
    const src = readFileSync(join(REPO, "scripts/video-montagem.ts"), "utf8");
    const guard = src.slice(src.lastIndexOf("if (isMainModule(import.meta.url))"));
    assert.match(guard, /runCli\(\(\) => cliMain\(\)/);
  });
});
