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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { EnvBackupError, LocalOnlyEnvKeysError, syncEnv } from "../scripts/sync-env.ts";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");

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

  it("retenção de .env.bak é rasa (1 geração) — 2º sync sobrescreve o backup do 1º, não acumula", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-env-test-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "V=A\n");

      syncEnv(envPath, () => "V=B\n"); // A -> B
      assert.equal(readFileSync(`${envPath}.bak`, "utf8"), "V=A\n");

      syncEnv(envPath, () => "V=C\n"); // B -> C
      assert.equal(readFileSync(`${envPath}.bak`, "utf8"), "V=B\n", "backup deve ser B (geração anterior), não A");
      assert.equal(readFileSync(envPath, "utf8"), "V=C\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("não aborta quando o Doppler tem chave NOVA que o .env local ainda não tem (remote-only é benigno)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-env-test-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "CLARICE_API_KEY=old\n");

      syncEnv(envPath, () => "CLARICE_API_KEY=old\nNOVA_CHAVE_NO_VAULT=valor\n");

      assert.equal(readFileSync(envPath, "utf8"), "CLARICE_API_KEY=old\nNOVA_CHAVE_NO_VAULT=valor\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aborta com 2+ chaves só-locais e formata err.keys/mensagem com todas, não só a 1ª", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-env-test-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(
        envPath,
        "CLARICE_API_KEY=old\nANTHROPIC_API_KEY=segredo-1\nOUTRA_CHAVE_LOCAL=segredo-2\n",
      );

      assert.throws(
        () => syncEnv(envPath, () => "CLARICE_API_KEY=new\n"),
        (err: unknown) => {
          assert.ok(err instanceof LocalOnlyEnvKeysError);
          assert.deepEqual(err.keys, ["ANTHROPIC_API_KEY", "OUTRA_CHAVE_LOCAL"]);
          assert.ok(err.message.includes("ANTHROPIC_API_KEY, OUTRA_CHAVE_LOCAL"));
          assert.ok(!err.message.includes("segredo-1"));
          assert.ok(!err.message.includes("segredo-2"));
          return true;
        },
      );

      assert.equal(existsSync(`${envPath}.bak`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backup atômico (#5155 fleet review finding 1): falha na escrita de .env.bak não deixa .env sobrescrito nem cria .env.bak", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-env-test-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "CLARICE_API_KEY=old\n");

      // Fault injection real (sem mock de módulo — named imports de builtins
      // não veem monkey-patch de `fs.writeFileSync` sob a transpilação do
      // tsx, confirmado empiricamente): pré-criar `.env.bak.tmp` como
      // DIRETÓRIO força o `writeFileSync(backupTmpPath, ...)` do código de
      // produção a lançar EISDIR de verdade, no mesmo ponto que uma falha
      // real de disco/permissão atingiria.
      mkdirSync(`${envPath}.bak.tmp`);

      assert.throws(
        () => syncEnv(envPath, () => "CLARICE_API_KEY=new\n"),
        (err: unknown) => {
          // A falha original (EISDIR na escrita do backup) é reportada como
          // EnvBackupError — fase local, distinta de falha do Doppler — e
          // não fica mascarada pela limpeza best-effort do .tmp (que também
          // falharia aqui, já que o "arquivo" é na verdade um diretório).
          assert.ok(err instanceof EnvBackupError);
          return true;
        },
      );

      // .env continua com o conteúdo antigo — a falha do backup abortou
      // ANTES da escrita final (tmp+rename) do .env principal, então o
      // .env nunca chega a ser tocado.
      assert.equal(readFileSync(envPath, "utf8"), "CLARICE_API_KEY=old\n");
      // .env.bak nunca chega a existir — o rename backupTmpPath→backupPath
      // nunca roda porque a escrita anterior já lançou.
      assert.equal(existsSync(`${envPath}.bak`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("entrypoint guard (#5679)", () => {
  it("roda main() quando o script é invocado diretamente como processo filho", () => {
    // Regressão específica: o guard antigo (`import.meta.url ===
    // \`file://${process.argv[1]}\``) comparava uma URL file:// contra o
    // path NATIVO de argv[1] — no Windows essa comparação nunca bate
    // (barras invertidas + sem o prefixo file:///), então main() nunca
    // rodava e o script saía silencioso com exit 0. Um teste que só importa
    // o módulo (como os `describe("syncEnv", ...)` acima) não exercita essa
    // condição — ela só é alcançada rodando o arquivo como entrypoint de
    // verdade via subprocesso. Não dá pra reproduzir o bug do Windows em si
    // num runner Linux (a comparação de string bate nos dois formatos por
    // acaso quando native path == URL path), mas dá pra travar que a
    // condição SEMPRE usa `fileURLToPath` (paths nativos dos dois lados) em
    // vez de reconstruir uma URL a partir de argv[1] — checando que main()
    // roda de fato quando invocado como script.
    //
    // Remove `doppler` do PATH do subprocesso pra forçar uma falha rápida e
    // determinística (ENOENT) em vez de uma chamada de rede real — o que
    // importa aqui é só confirmar que main() RODOU (e portanto imprimiu
    // algo em vez de sair silencioso), não o resultado do sync em si.
    const strippedPath = process.env.PATH?.split(":")
      .filter((entry) => !existsSync(join(entry, "doppler")))
      .join(":");

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(repoRoot, "scripts", "sync-env.ts")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, PATH: strippedPath ?? "" },
      },
    );

    // main() rodou: tentou chamar `doppler` (ausente do PATH stripado),
    // capturou o erro no catch de main() e reportou via stderr + exit
    // code != 0. Um script que saísse silencioso (bug original) teria
    // stdout/stderr vazios e exit code 0.
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Falha ao sincronizar \.env via Doppler/);
  });
});
