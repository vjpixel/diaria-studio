/**
 * test/hermes-config-writer.test.ts (#6817 item 3)
 *
 * Cobre o miolo puro (`scripts/lib/hermes-config-writer.ts`) e o CLI
 * (`scripts/write-hermes-config.ts`) — verbo único de escrita de config de
 * runtime do Hermes (backup, validate/smoke/revert, eco redigido).
 *
 * Os testes E2E do CLI operam sob `data/` (raiz `diaria-studio`, sempre
 * `enabled: true`) — nunca sob `~/.hermes`/`~/hermes-agent` reais, que numa
 * máquina de desenvolvimento podem ser diretórios de produção de verdade.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_SENSITIVE_CONFIG_KEYS,
  buildBackupFileName,
  findMostRecentBackup,
  formatBackupTimestamp,
  redactConfigText,
  slugifyMotivo,
} from "../scripts/lib/hermes-config-writer.ts";

describe("slugifyMotivo", () => {
  it("minúsculas, espaços e pontuação viram hífen único", () => {
    assert.equal(slugifyMotivo("Trocar Modelo do Profile Coding!"), "trocar-modelo-do-profile-coding");
  });
  it("hífens nas pontas são removidos", () => {
    assert.equal(slugifyMotivo("  --teste-- "), "teste");
  });
  it("motivo vazio ou só símbolos vira 'sem-motivo'", () => {
    assert.equal(slugifyMotivo(""), "sem-motivo");
    assert.equal(slugifyMotivo("!!!"), "sem-motivo");
  });
});

describe("formatBackupTimestamp", () => {
  it("produz string só de dígitos + T/Z, ordenável lexicograficamente = cronologicamente", () => {
    const a = formatBackupTimestamp(new Date("2026-09-04T04:08:32.123Z"));
    const b = formatBackupTimestamp(new Date("2026-09-04T05:00:00.000Z"));
    assert.equal(a, "20260904T040832Z");
    assert.equal(b, "20260904T050000Z");
    assert.ok(a < b);
  });
});

describe("buildBackupFileName", () => {
  it("monta <basename>.bak-<motivo>-<data>", () => {
    assert.equal(
      buildBackupFileName("config.yaml", "trocar modelo", "20260904T040832Z"),
      "config.yaml.bak-trocar-modelo-20260904T040832Z",
    );
  });
});

describe("findMostRecentBackup", () => {
  it("escolhe o backup mais recente por ordenação lexicográfica do timestamp", () => {
    const files = [
      "config.yaml.bak-a-20260904T040000Z",
      "config.yaml.bak-b-20260904T090000Z",
      "config.yaml.bak-c-20260903T235959Z",
      "outro-arquivo.txt",
    ];
    assert.equal(findMostRecentBackup("config.yaml", files), "config.yaml.bak-b-20260904T090000Z");
  });

  it("nenhum backup no diretório -> undefined", () => {
    assert.equal(findMostRecentBackup("config.yaml", ["outro.txt"]), undefined);
  });
});

describe("redactConfigText", () => {
  it("redige chave sensível top-level, preserva indentação e o resto do arquivo", () => {
    const text = ["dashboard:", "  basic_auth:", "    password_hash: abc123XYZ", "  port: 8080"].join("\n");
    const { redacted, matchedKeys } = redactConfigText(text, DEFAULT_SENSITIVE_CONFIG_KEYS);
    assert.match(redacted, /password_hash: <redacted>/);
    assert.match(redacted, /port: 8080/, "chave não-sensível não deve ser tocada");
    assert.deepEqual(matchedKeys, ["password_hash"]);
    assert.equal(redacted.includes("abc123XYZ"), false);
  });

  it("case-insensitive no nome da chave", () => {
    const { redacted } = redactConfigText("API_KEY: sk-live-xyz", ["api_key"]);
    assert.match(redacted, /API_KEY: <redacted>/);
  });

  it("chave sensível sem valor na mesma linha (bloco aninhado abaixo) não é tocada", () => {
    const text = "token:\n  value: abc\n  expires: 2026-01-01";
    const { redacted, matchedKeys } = redactConfigText(text, ["token"]);
    assert.equal(redacted, text);
    assert.deepEqual(matchedKeys, []);
  });

  it("linha sem formato chave:valor passa intacta (comentário, lista, etc)", () => {
    const text = "# comentário sobre token\n- item de lista\ntoken: real-secret";
    const { redacted } = redactConfigText(text, ["token"]);
    assert.match(redacted, /# comentário sobre token/);
    assert.match(redacted, /- item de lista/);
    assert.match(redacted, /token: <redacted>/);
  });

  it("nenhuma chave sensível casa -> matchedKeys vazio, texto idêntico", () => {
    const text = "model: sonnet\nprovider: anthropic";
    const { redacted, matchedKeys } = redactConfigText(text, DEFAULT_SENSITIVE_CONFIG_KEYS);
    assert.equal(redacted, text);
    assert.deepEqual(matchedKeys, []);
  });
});

describe("CLI write-hermes-config.ts", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const script = resolve(repoRoot, "scripts/write-hermes-config.ts");

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", script, ...args], { cwd: repoRoot, encoding: "utf8" });
  }

  function withTmpDataDir<T>(fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(repoRoot, "data", "tmp-write-hermes-config-test-"));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("path fora da allowlist (/tmp) -> denied, exit 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-config-writer-"));
    try {
      const target = join(dir, "config.yaml");
      const contentFile = join(dir, "novo.yaml");
      writeFileSync(contentFile, "model: sonnet\n");
      const r = runCli(["--path", target, "--content-file", contentFile, "--reason", "teste"]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /denied/);
      assert.equal(existsSync(target), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("1ª escrita (arquivo não existia): escreve, sem backup, relata isso", () => {
    withTmpDataDir((dir) => {
      const target = join(dir, "config.yaml");
      const contentFile = join(dir, "novo.yaml");
      writeFileSync(contentFile, "model: sonnet\n");
      const r = runCli(["--path", target, "--content-file", contentFile, "--reason", "primeira escrita"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /não existia — sem backup/);
      assert.equal(readFileSync(target, "utf8"), "model: sonnet\n");
    });
  });

  it("escrita sobre arquivo existente cria backup com o conteúdo ANTERIOR", () => {
    withTmpDataDir((dir) => {
      const target = join(dir, "config.yaml");
      writeFileSync(target, "model: haiku\n");
      const contentFile = join(dir, "novo.yaml");
      writeFileSync(contentFile, "model: sonnet\n");
      const r = runCli(["--path", target, "--content-file", contentFile, "--reason", "trocar modelo"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(target, "utf8"), "model: sonnet\n");
      const backupMatch = /backup criado: (\S+)/.exec(r.stdout);
      assert.ok(backupMatch, "stdout deveria citar o path do backup");
      assert.equal(readFileSync(backupMatch![1], "utf8"), "model: haiku\n");
    });
  });

  it("--validate-cmd que falha -> REVERT automático, exit 1, arquivo volta ao estado anterior", () => {
    withTmpDataDir((dir) => {
      const target = join(dir, "config.yaml");
      writeFileSync(target, "model: haiku\n");
      const contentFile = join(dir, "novo.yaml");
      writeFileSync(contentFile, "model: BROKEN\n");
      const r = runCli([
        "--path", target,
        "--content-file", contentFile,
        "--reason", "quebra de propósito",
        "--validate-cmd", "false",
      ]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /REVERTIDO/);
      assert.equal(readFileSync(target, "utf8"), "model: haiku\n", "arquivo deveria ter voltado ao conteúdo original");
    });
  });

  it("--validate-cmd que falha numa 1ª escrita (sem backup) -> REVERT remove o arquivo", () => {
    withTmpDataDir((dir) => {
      const target = join(dir, "config.yaml");
      const contentFile = join(dir, "novo.yaml");
      writeFileSync(contentFile, "model: BROKEN\n");
      const r = runCli(["--path", target, "--content-file", contentFile, "--reason", "teste", "--validate-cmd", "false"]);
      assert.equal(r.status, 1);
      assert.equal(existsSync(target), false, "arquivo criado nesta escrita deveria ter sido removido no revert");
    });
  });

  it("--validate-cmd ok + --smoke-cmd que falha -> ainda reverte (a segunda checagem também vale)", () => {
    withTmpDataDir((dir) => {
      const target = join(dir, "config.yaml");
      writeFileSync(target, "model: haiku\n");
      const contentFile = join(dir, "novo.yaml");
      writeFileSync(contentFile, "model: sonnet\n");
      const r = runCli([
        "--path", target,
        "--content-file", contentFile,
        "--reason", "smoke falha",
        "--validate-cmd", "true",
        "--smoke-cmd", "false",
      ]);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /validate-cmd ok/);
      assert.match(r.stderr, /REVERTIDO/);
      assert.equal(readFileSync(target, "utf8"), "model: haiku\n");
    });
  });

  it("validate + smoke ok -> sucesso, arquivo com o conteúdo novo", () => {
    withTmpDataDir((dir) => {
      const target = join(dir, "config.yaml");
      writeFileSync(target, "model: haiku\n");
      const contentFile = join(dir, "novo.yaml");
      writeFileSync(contentFile, "model: sonnet\n");
      const r = runCli([
        "--path", target,
        "--content-file", contentFile,
        "--reason", "tudo ok",
        "--validate-cmd", "true",
        "--smoke-cmd", "true",
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /sucesso/);
      assert.equal(readFileSync(target, "utf8"), "model: sonnet\n");
    });
  });

  it("--echo-to sob raiz permitida escreve cópia redigida; --echo-to negado só avisa (não reverte a escrita principal)", () => {
    withTmpDataDir((dir) => {
      const target = join(dir, "config.yaml");
      const contentFile = join(dir, "novo.yaml");
      writeFileSync(contentFile, "model: sonnet\ntoken: super-secret\n");

      // echo-to sob /tmp -> allowlist nega -> aviso, mas escrita principal segue de pé
      const echoDenied = join(mkdtempSync(join(tmpdir(), "hermes-echo-")), "echo.yaml");
      const r1 = runCli(["--path", target, "--content-file", contentFile, "--reason", "eco negado", "--echo-to", echoDenied]);
      assert.equal(r1.status, 0, r1.stderr);
      assert.match(r1.stderr, /eco pra .* PULADO/);
      assert.equal(existsSync(echoDenied), false);
      assert.equal(readFileSync(target, "utf8"), "model: sonnet\ntoken: super-secret\n", "escrita principal não deveria ser afetada pelo eco negado");

      // echo-to sob data/ (raiz permitida) -> escreve, redigindo `token`
      const echoAllowed = join(dir, "echo-destino", "config.yaml");
      const r2 = runCli(["--path", target, "--content-file", contentFile, "--reason", "eco ok", "--echo-to", echoAllowed]);
      assert.equal(r2.status, 0, r2.stderr);
      assert.ok(existsSync(echoAllowed));
      const echoed = readFileSync(echoAllowed, "utf8");
      assert.match(echoed, /token: <redacted>/);
      assert.equal(echoed.includes("super-secret"), false);
    });
  });

  it("tentativa de escrever ~/.hermes/auth.json via este verbo é negada (hard-deny vence mesmo pelo caminho oficial)", () => {
    withTmpDataDir((dir) => {
      // Simula o hard-deny usando o path real (~/.hermes/auth.json) — não
      // precisamos que o arquivo exista de verdade, isPathAllowed nega
      // antes de qualquer I/O.
      const contentFile = join(dir, "novo.yaml");
      writeFileSync(contentFile, "sk-or-fake\n");
      const target = resolve(process.env.HOME ?? "/root", ".hermes", "auth.json");
      const r = runCli(["--path", target, "--content-file", contentFile, "--reason", "tentativa negada"]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /NEGADO permanentemente/);
    });
  });

  it("modo --revert restaura o backup mais recente quando --backup é omitido", () => {
    withTmpDataDir((dir) => {
      const target = join(dir, "config.yaml");
      writeFileSync(target, "model: haiku\n");
      const contentFile = join(dir, "novo.yaml");
      writeFileSync(contentFile, "model: sonnet\n");
      const write = runCli(["--path", target, "--content-file", contentFile, "--reason", "antes do revert manual"]);
      assert.equal(write.status, 0, write.stderr);
      assert.equal(readFileSync(target, "utf8"), "model: sonnet\n");

      const revert = runCli(["--path", target, "--revert"]);
      assert.equal(revert.status, 0, revert.stderr);
      assert.match(revert.stdout, /revert ok/);
      assert.equal(readFileSync(target, "utf8"), "model: haiku\n");
    });
  });

  it("--revert sem nenhum backup existente -> exit 2, mensagem clara", () => {
    withTmpDataDir((dir) => {
      const target = join(dir, "config.yaml");
      writeFileSync(target, "model: haiku\n");
      const r = runCli(["--path", target, "--revert"]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /nenhum backup encontrado/);
    });
  });

  it("uso inválido (sem --path) -> exit 2", () => {
    const r = runCli([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /uso:/);
  });

  it("modo escrita sem --reason ou sem --content-file -> exit 2", () => {
    withTmpDataDir((dir) => {
      const target = join(dir, "config.yaml");
      const r1 = runCli(["--path", target, "--content-file", join(dir, "x.yaml")]);
      assert.equal(r1.status, 2);
      mkdirSync(dir, { recursive: true });
      const r2 = runCli(["--path", target, "--reason", "sem content file"]);
      assert.equal(r2.status, 2);
    });
  });
});
