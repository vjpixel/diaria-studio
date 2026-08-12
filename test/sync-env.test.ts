/**
 * test/sync-env.test.ts (#5149, regressão pós-review do PR #5150;
 * backup + guard local-only #5155)
 *
 * O `npm run sync-env` original era `doppler secrets download ... > .env`
 * puro — a redireção de shell trunca `.env` ANTES do comando Doppler rodar,
 * então qualquer falha (sessão expirada, rede, projeto/config errado) zerava
 * as ~40 credenciais em produção. Reproduzido ao vivo no code-review.
 *
 * `scripts/sync-env.ts::syncEnv` escreve em tmp + rename, então `.env` só
 * muda quando o download tem sucesso. Este teste garante que a regressão
 * não volte (ex: alguém "simplificar" de volta pra redireção direta).
 *
 * #5155 — a issue original tinha uma 2ª causa raiz: nenhum backup do `.env`
 * anterior, e nenhuma checagem de chave que existisse só localmente (o
 * cenário real que destruiu `ANTHROPIC_API_KEY` em produção — a chave nunca
 * tinha sido posta no vault, então o 1º sync bem-sucedido a apagou em
 * silêncio). Os testes abaixo cobrem as duas proteções novas.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalOnlyEnvKeysError, syncEnv } from "../scripts/sync-env.ts";

describe("syncEnv", () => {
  it("não sobrescreve .env quando o Doppler falha", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-env-test-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "CLARICE_API_KEY=original\n");

      const failingRunner = () => {
        throw new Error("Doppler Error: Could not find requested project");
      };

      assert.throws(() => syncEnv(envPath, failingRunner));
      assert.equal(readFileSync(envPath, "utf8"), "CLARICE_API_KEY=original\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sobrescreve .env com o snapshot do Doppler quando o download tem sucesso", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-env-test-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "CLARICE_API_KEY=old\n");

      syncEnv(envPath, () => 'CLARICE_API_KEY="new"\n');

      assert.equal(readFileSync(envPath, "utf8"), 'CLARICE_API_KEY="new"\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cria .env do zero quando ele ainda não existe (máquina nova)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-env-test-"));
    try {
      const envPath = join(dir, ".env");
      assert.equal(existsSync(envPath), false);

      syncEnv(envPath, () => "CLARICE_API_KEY=first\n");

      assert.equal(readFileSync(envPath, "utf8"), "CLARICE_API_KEY=first\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("não deixa .env.tmp órfão no diretório após sucesso", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-env-test-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "X=1\n");

      syncEnv(envPath, () => "X=2\n");

      assert.equal(existsSync(`${envPath}.tmp`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("copia o .env existente para .env.bak antes de sobrescrever", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-env-test-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "CLARICE_API_KEY=old\n");

      syncEnv(envPath, () => "CLARICE_API_KEY=new\n");

      assert.equal(readFileSync(`${envPath}.bak`, "utf8"), "CLARICE_API_KEY=old\n");
      assert.equal(readFileSync(envPath, "utf8"), "CLARICE_API_KEY=new\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("não cria .env.bak quando .env ainda não existe (máquina nova)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-env-test-"));
    try {
      const envPath = join(dir, ".env");

      syncEnv(envPath, () => "CLARICE_API_KEY=first\n");

      assert.equal(existsSync(`${envPath}.bak`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aborta sem sobrescrever quando há chave só-local ausente no snapshot do Doppler", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-env-test-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "CLARICE_API_KEY=old\nANTHROPIC_API_KEY=segredo-local\n");

      assert.throws(
        () => syncEnv(envPath, () => "CLARICE_API_KEY=new\n"),
        (err: unknown) => {
          assert.ok(err instanceof LocalOnlyEnvKeysError);
          assert.deepEqual(err.keys, ["ANTHROPIC_API_KEY"]);
          // A mensagem nunca deve vazar o VALOR da chave só-local.
          assert.ok(!err.message.includes("segredo-local"));
          return true;
        },
      );

      // .env intocado (nem sobrescrito, nem apagado) e nenhum backup criado —
      // o abort acontece ANTES de qualquer escrita em disco.
      assert.equal(readFileSync(envPath, "utf8"), "CLARICE_API_KEY=old\nANTHROPIC_API_KEY=segredo-local\n");
      assert.equal(existsSync(`${envPath}.bak`), false);
      assert.equal(existsSync(`${envPath}.tmp`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("com force:true sobrescreve mesmo havendo chave só-local, mas ainda faz backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-env-test-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "CLARICE_API_KEY=old\nANTHROPIC_API_KEY=segredo-local\n");

      syncEnv(envPath, () => "CLARICE_API_KEY=new\n", { force: true });

      assert.equal(readFileSync(envPath, "utf8"), "CLARICE_API_KEY=new\n");
      assert.equal(
        readFileSync(`${envPath}.bak`, "utf8"),
        "CLARICE_API_KEY=old\nANTHROPIC_API_KEY=segredo-local\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
