/**
 * test/studio-review-actions.test.ts (#3559)
 *
 * Ação rápida "trocar destaque" (`scripts/studio-ui/studio-review-actions.ts`)
 * — a única ação ponta-a-ponta exigida pelo aceite do #3559. `spawnFn` é
 * sempre injetado aqui: nunca spawna `swap-destaque.ts` de verdade nem toca
 * `data/` real (o script real muta `01-approved.json`/`02-reviewed.md`, o
 * que exigiria fixtures pesadas fora do escopo deste teste — a integração
 * real é a mesma CLI que já tem sua própria suíte).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateSwapRequest,
  runSwapDestaque,
  type SwapDestaqueRequest,
} from "../scripts/studio-ui/studio-review-actions.ts";

describe("validateSwapRequest (#3559)", () => {
  it("aceita uma requisição bem formada", () => {
    assert.equal(validateSwapRequest({ aammdd: "260716", promote: "radar:0", demote: "d1" }), null);
  });

  it("rejeita aammdd inválido", () => {
    assert.match(validateSwapRequest({ aammdd: "abc", promote: "radar:0", demote: "d1" }) ?? "", /aammdd/);
  });

  it("rejeita promote fora do formato bucket:idx", () => {
    assert.match(validateSwapRequest({ aammdd: "260716", promote: "radar", demote: "d1" }) ?? "", /promote/);
  });

  it("rejeita bucket desconhecido", () => {
    assert.match(validateSwapRequest({ aammdd: "260716", promote: "nao-existe:0", demote: "d1" }) ?? "", /promote/);
  });

  it("rejeita demote fora de d1/d2/d3", () => {
    assert.match(validateSwapRequest({ aammdd: "260716", promote: "radar:0", demote: "d4" }) ?? "", /demote/);
  });
});

/** Cria um rootDir tmp com um `scripts/swap-destaque.ts` stub — só o
 * suficiente pro guard `existsSync(scriptPath)` de `runSwapDestaque`
 * (produção sempre roda contra o repo real, onde o arquivo existe de
 * verdade; aqui simulamos isso pra exercitar o caminho até o `spawnFn`). */
function makeRootWithScriptStub(): string {
  const root = mkdtempSync(join(tmpdir(), "studio-swap-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "swap-destaque.ts"), "// stub pra teste — nunca executado de verdade\n");
  return root;
}

describe("runSwapDestaque (#3559)", () => {
  it("requisição inválida não spawna processo nenhum", () => {
    const root = makeRootWithScriptStub();
    try {
      let called = false;
      const fakeSpawn = () => {
        called = true;
        return { status: 0, stdout: "{}", stderr: "", error: undefined } as ReturnType<
          typeof import("node:child_process").spawnSync
        >;
      };
      const req: Partial<SwapDestaqueRequest> = { aammdd: "260716", promote: "bad", demote: "d1" };
      const result = runSwapDestaque(root, req as SwapDestaqueRequest, fakeSpawn as never);
      assert.equal(result.ok, false);
      assert.equal(called, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("script ausente no rootDir → erro fail-soft, sem spawnar", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-swap-noscript-"));
    try {
      let called = false;
      const fakeSpawn = () => {
        called = true;
        return { status: 0, stdout: "{}", stderr: "", error: undefined } as ReturnType<
          typeof import("node:child_process").spawnSync
        >;
      };
      const req: SwapDestaqueRequest = { aammdd: "260716", promote: "radar:0", demote: "d1" };
      const result = runSwapDestaque(root, req, fakeSpawn as never);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /swap-destaque\.ts não encontrado/);
      assert.equal(called, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("spawn bem-sucedido repassa o JSON de stdout (dry-run)", () => {
    const root = makeRootWithScriptStub();
    try {
      const fakeStdout = JSON.stringify({ edition: "260716", dry_run: true, promoted: { bucket: "radar", idx: 0 } });
      const fakeSpawn = (_cmd: string, args: readonly string[]) => {
        assert.ok(args.includes("--dry-run"), "dry-run deve propagar --dry-run pro CLI");
        assert.ok(args.includes("--edition") && args.includes("260716"));
        return { status: 0, stdout: fakeStdout, stderr: "", error: undefined } as ReturnType<
          typeof import("node:child_process").spawnSync
        >;
      };
      const req: SwapDestaqueRequest = { aammdd: "260716", promote: "radar:0", demote: "d1", dryRun: true };
      const result = runSwapDestaque(root, req, fakeSpawn as never);
      assert.equal(result.ok, true);
      assert.equal(result.dryRun, true);
      assert.deepEqual(result.result, JSON.parse(fakeStdout));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--drop só é passado quando drop:true", () => {
    const root = makeRootWithScriptStub();
    try {
      let sawDrop = false;
      const fakeSpawn = (_cmd: string, args: readonly string[]) => {
        sawDrop = args.includes("--drop");
        return { status: 0, stdout: "{}", stderr: "", error: undefined } as ReturnType<
          typeof import("node:child_process").spawnSync
        >;
      };
      const req1: SwapDestaqueRequest = { aammdd: "260716", promote: "radar:0", demote: "d2", drop: false, dryRun: true };
      runSwapDestaque(root, req1, fakeSpawn as never);
      assert.equal(sawDrop, false);

      const req2: SwapDestaqueRequest = { aammdd: "260716", promote: "radar:0", demote: "d2", drop: true, dryRun: true };
      runSwapDestaque(root, req2, fakeSpawn as never);
      assert.equal(sawDrop, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exit code != 0 vira erro fail-soft (não lança)", () => {
    const root = makeRootWithScriptStub();
    try {
      const fakeSpawn = () =>
        ({ status: 1, stdout: "", stderr: "Erro: --demote d1 fora de range", error: undefined }) as ReturnType<
          typeof import("node:child_process").spawnSync
        >;
      const req: SwapDestaqueRequest = { aammdd: "260716", promote: "radar:0", demote: "d1" };
      const result = runSwapDestaque(root, req, fakeSpawn as never);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /fora de range/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("erro de spawn (ex: ENOENT) vira erro fail-soft (não lança)", () => {
    const root = makeRootWithScriptStub();
    try {
      const fakeSpawn = () =>
        ({ status: null, stdout: "", stderr: "", error: new Error("spawn ENOENT") }) as ReturnType<
          typeof import("node:child_process").spawnSync
        >;
      const req: SwapDestaqueRequest = { aammdd: "260716", promote: "radar:0", demote: "d1" };
      const result = runSwapDestaque(root, req, fakeSpawn as never);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /ENOENT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
