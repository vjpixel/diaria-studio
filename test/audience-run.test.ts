/**
 * test/audience-run.test.ts (#5192, reescrito no #10605)
 *
 * Cobre `scripts/audience-run.ts` depois da decisão 10 do editor
 * (08/11/2026): o perfil de audiência sai SÓ do formulário do onboarding, e
 * as fases MCP da survey da Beehiiv (`--resolve-only`, `--surveys-json`,
 * `--responses`) saíram. Nenhuma chamada de rede real: `fetchFormResponses`
 * e `exec` são fakes; arquivos sempre num `mkdtempSync` isolado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  runAudience,
  parsePlatformConfig,
  serializePlatformConfig,
  LEGACY_FLAG_MESSAGE,
  type AudienceRunDeps,
  type PlatformConfig,
  type StepResult,
} from "../scripts/audience-run.ts";
import type { FormResponse } from "../scripts/lib/onboarding-form-contract.ts";

function freshRoot(cfg: PlatformConfig = {}): string {
  const root = mkdtempSync(join(tmpdir(), "audience-run-"));
  writeFileSync(resolve(root, "platform.config.json"), serializePlatformConfig(cfg), "utf8");
  return root;
}

const R = (answers: Record<string, string>, email = "a@x.com"): FormResponse => ({ email, submitted_at: "2026-11-08T12:00:00Z", answers });

function deps(root: string, over: Partial<AudienceRunDeps> = {}): AudienceRunDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    rootDir: root,
    exec: (script): StepResult => {
      calls.push(script);
      return { code: 0, stdout: "", stderr: "" };
    },
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, c) => writeFileSync(p, c, "utf8"),
    fetchFormResponses: async () => [R({ nivel_ia: "x", area: "RH" }), R({ area: "Vendas" }, "b@x.com")],
    ...over,
  };
}

describe("audience-run (#10605): só o formulário do onboarding", () => {
  it("caminho feliz: grava só respostas do formulário, sem e-mail, e roda update-audience", async () => {
    const root = freshRoot();
    const d = deps(root);
    assert.equal((await runAudience([], d)).code, 0);
    const raw = JSON.parse(readFileSync(resolve(root, "data/audience-raw.json"), "utf8")) as { id: string }[];
    assert.deepEqual(raw.map((r) => r.id), ["onboarding-form:1", "onboarding-form:2"]);
    assert.ok(!JSON.stringify(raw).includes("@x.com"));
    assert.deepEqual(d.calls, ["scripts/update-audience.ts"]);
  });

  it("flags antigas da Beehiiv abortam (exit 1) sem ler o formulário nem gravar nada", async () => {
    for (const argv of [["--resolve-only"], ["--responses", "data/x.json"], ["--surveys-json=data/s.json"]]) {
      const root = freshRoot();
      let read = false;
      const d = deps(root, { fetchFormResponses: async () => { read = true; return []; } });
      assert.equal((await runAudience(argv, d)).code, 1, argv.join(" "));
      assert.equal(read, false);
      assert.equal(existsSync(resolve(root, "data/audience-raw.json")), false);
      assert.deepEqual(d.calls, []);
    }
    assert.match(LEGACY_FLAG_MESSAGE, /decisão 10/);
  });

  it("formulário não configurado, leitura falhando ou 0 respostas: aborta sem tocar em audience-raw.json", async () => {
    const cases: AudienceRunDeps["fetchFormResponses"][] = [async () => null, async () => { throw new Error("HTTP 503"); }, async () => []];
    for (const f of cases) {
      const root = freshRoot();
      const d = deps(root, { fetchFormResponses: f });
      assert.equal((await runAudience([], d)).code, 1);
      assert.equal(existsSync(resolve(root, "data/audience-raw.json")), false);
      assert.deepEqual(d.calls, []);
    }
  });

  it("--dry-run lê e conta, não grava nem roda update-audience", async () => {
    const root = freshRoot();
    const d = deps(root);
    assert.equal((await runAudience(["--dry-run"], d)).code, 0);
    assert.equal(existsSync(resolve(root, "data/audience-raw.json")), false);
    assert.deepEqual(d.calls, []);
  });

  it("platform.config.json ilegível: exit 2", async () => {
    const root = freshRoot();
    writeFileSync(resolve(root, "platform.config.json"), "{ nope", "utf8");
    assert.equal((await runAudience([], deps(root))).code, 2);
  });

  it("update-audience falhando propaga exit 1", async () => {
    const root = freshRoot();
    const d = deps(root, { exec: () => ({ code: 3, stdout: "", stderr: "boom" }) });
    assert.equal((await runAudience([], d)).code, 1);
  });

  it("parsePlatformConfig/serializePlatformConfig fazem o ida-e-volta", () => {
    const cfg: PlatformConfig = { onboarding: { followup: { form_responses_url: "https://f/api" } } };
    assert.deepEqual(parsePlatformConfig(serializePlatformConfig(cfg)), cfg);
  });
});
