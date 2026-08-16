import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREFLIGHT_KEYS,
  emptyPreflightState,
  formatProbe,
  isPreflightKey,
  preflightStatePath,
  readPreflightState,
  readProbe,
  setProbe,
} from "../scripts/lib/preflight-state.ts";

function tempEdition(): string {
  const root = mkdtempSync(join(tmpdir(), "preflight-state-"));
  const dir = join(root, "260817");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

describe("readPreflightState — fail-soft", () => {
  it("arquivo ausente → tudo null, não lança", () => {
    const dir = tempEdition();
    try {
      const s = readPreflightState(dir);
      for (const k of PREFLIGHT_KEYS) assert.equal(s[k], null, `${k} deveria ser null`);
      assert.equal(s.updated_at, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON corrompido → tudo null, não lança", () => {
    const dir = tempEdition();
    try {
      writeFileSync(preflightStatePath(dir), "{ isso não é json", "utf8");
      const s = readPreflightState(dir);
      assert.equal(s.chrome_mcp, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("valor de tipo errado é ignorado, não vira false", () => {
    const dir = tempEdition();
    try {
      writeFileSync(
        preflightStatePath(dir),
        JSON.stringify({ chrome_mcp: "sim", gmail_mcp: 1, beehiiv_mcp: true }),
        "utf8",
      );
      const s = readPreflightState(dir);
      assert.equal(s.chrome_mcp, null, "string não vira booleano");
      assert.equal(s.gmail_mcp, null, "número não vira booleano");
      assert.equal(s.beehiiv_mcp, true, "booleano legítimo sobrevive");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chave desconhecida no arquivo não contamina o resultado", () => {
    const dir = tempEdition();
    try {
      writeFileSync(
        preflightStatePath(dir),
        JSON.stringify({ chrome_mcp: true, probe_que_nao_existe: true }),
        "utf8",
      );
      const s = readPreflightState(dir);
      assert.deepEqual(Object.keys(s).sort(), [...PREFLIGHT_KEYS, "updated_at"].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("setProbe", () => {
  it("preserva os demais probes (merge, não sobrescrita)", () => {
    const dir = tempEdition();
    try {
      setProbe(dir, "chrome_mcp", true);
      setProbe(dir, "clarice_rest", false);
      const s = readPreflightState(dir);
      assert.equal(s.chrome_mcp, true, "o 2º write não pode apagar o 1º");
      assert.equal(s.clarice_rest, false);
      assert.equal(s.gmail_mcp, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("grava false de verdade — distinto de ausente", () => {
    const dir = tempEdition();
    try {
      setProbe(dir, "chrome_mcp", false);
      assert.equal(readProbe(dir, "chrome_mcp"), false);
      assert.equal(readProbe(dir, "gmail_mcp"), null);
      assert.notEqual(
        readProbe(dir, "chrome_mcp"),
        readProbe(dir, "gmail_mcp"),
        "'probado e indisponível' não pode ser igual a 'não probado'",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("permite voltar pra null (re-probar zera o registro anterior)", () => {
    const dir = tempEdition();
    try {
      setProbe(dir, "chrome_mcp", false);
      setProbe(dir, "chrome_mcp", null);
      assert.equal(readProbe(dir, "chrome_mcp"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carimba updated_at", () => {
    const dir = tempEdition();
    try {
      const s = setProbe(dir, "chrome_mcp", true, { now: () => new Date("2026-08-17T03:00:00Z") });
      assert.equal(s.updated_at, "2026-08-17T03:00:00.000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cria _internal/ se não existir", () => {
    const root = mkdtempSync(join(tmpdir(), "preflight-state-"));
    const dir = join(root, "260817");
    try {
      setProbe(dir, "chrome_mcp", true);
      assert.ok(existsSync(preflightStatePath(dir)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("formatProbe / isPreflightKey", () => {
  it("null vira 'unknown', nunca 'false'", () => {
    assert.equal(formatProbe(null), "unknown");
    assert.equal(formatProbe(false), "false");
    assert.equal(formatProbe(true), "true");
  });

  it("isPreflightKey rejeita chave inventada", () => {
    assert.equal(isPreflightKey("chrome_mcp"), true);
    assert.equal(isPreflightKey("chrome"), false);
  });

  it("emptyPreflightState traz todas as chaves conhecidas", () => {
    const s = emptyPreflightState();
    for (const k of PREFLIGHT_KEYS) assert.equal(s[k], null);
  });
});

describe("CLI", () => {
  function runCli(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const script = join(projectRoot, "scripts", "lib", "preflight-state.ts");
    return spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: projectRoot,
      encoding: "utf8",
    });
  }

  it("--get de estado inexistente imprime 'unknown' e sai 0", () => {
    const dir = tempEdition();
    try {
      const r = runCli(["--edition-dir", dir, "--get", "chrome_mcp"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), "unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--set grava e --get lê de volta", () => {
    const dir = tempEdition();
    try {
      assert.equal(runCli(["--edition-dir", dir, "--set", "clarice_rest=false"]).status, 0);
      const r = runCli(["--edition-dir", dir, "--get", "clarice_rest"]);
      assert.equal(r.stdout.trim(), "false");
      const onDisk = JSON.parse(readFileSync(preflightStatePath(dir), "utf8"));
      assert.equal(onDisk.clarice_rest, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chave inválida sai 2 — typo no playbook falha alto, não vira 'unknown'", () => {
    const dir = tempEdition();
    try {
      const r = runCli(["--edition-dir", dir, "--get", "chrome"]);
      assert.equal(r.status, 2);
      const w = runCli(["--edition-dir", dir, "--set", "chrome=true"]);
      assert.equal(w.status, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("valor inválido no --set sai 2", () => {
    const dir = tempEdition();
    try {
      const r = runCli(["--edition-dir", dir, "--set", "chrome_mcp=sim"]);
      assert.equal(r.status, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem --edition-dir sai 2", () => {
    assert.equal(runCli(["--get", "chrome_mcp"]).status, 2);
  });
});
