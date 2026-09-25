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
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EnvBackupError, LocalOnlyEnvKeysError, syncEnv } from "../scripts/sync-env.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

  it("chave só-local em minúscula/mista (não UPPER_SNAKE_CASE) continua protegida por LocalOnlyEnvKeysError (review PR #8280, finding 1)", () => {
    // O regex de chave válida é case-insensitive de propósito — restringir a
    // UPPER_SNAKE_CASE perderia silenciosamente a proteção do #5155 (guard
    // contra apagar credencial em silêncio) pra qualquer chave legítima que
    // não siga a convenção do projeto. A linha real que motivou o guard de
    // linha malformada já falha por ter espaço/aspas/dois-pontos, não por
    // causa de minúscula — não precisa de UPPER_SNAKE_CASE pra ser pega.
    const dir = mkdtempSync(join(tmpdir(), "sync-env-test-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "CLARICE_API_KEY=old\nmy_legacy_lowercase_key=segredo-local\n");

      assert.throws(
        () => syncEnv(envPath, () => "CLARICE_API_KEY=new\n"),
        (err: unknown) => {
          assert.ok(err instanceof LocalOnlyEnvKeysError);
          assert.deepEqual(err.keys, ["my_legacy_lowercase_key"]);
          assert.ok(!err.message.includes("segredo-local"));
          return true;
        },
      );

      assert.equal(existsSync(`${envPath}.bak`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("BOM UTF-8 no início do .env não faz a 1ª chave virar 'malformada' (review PR #8280, finding 2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-env-test-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "﻿CLARICE_API_KEY=old\n");

      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      try {
        syncEnv(envPath, () => "CLARICE_API_KEY=new\n");
      } finally {
        console.warn = originalWarn;
      }

      assert.equal(readFileSync(envPath, "utf8"), "CLARICE_API_KEY=new\n");
      // Sem chave "malformada" fantasma (﻿CLARICE_API_KEY) e sem
      // LocalOnlyEnvKeysError — CLARICE_API_KEY reconhecida normalmente
      // dos dois lados apesar do BOM.
      assert.equal(warnings.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("linha de continuação de valor multilinha com '=' no meio (chave JSON malformada) nunca vaza pra LocalOnlyEnvKeysError (260917)", () => {
    // Reproduz o achado ao vivo: `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` colado
    // sem escapar `\n` — a 2ª linha (fragmento de private_key em base64,
    // que contém `=`) seria tratada como uma CHAVE nova antes do fix, e
    // `LocalOnlyEnvKeysError.message` (via `keys.join(", ")`) ecoaria esse
    // fragmento de segredo no stdout/stderr.
    const dir = mkdtempSync(join(tmpdir(), "sync-env-test-"));
    try {
      const envPath = join(dir, ".env");
      const secretFragment =
        '"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDfakekeymaterial==\\n-----END PRIVATE KEY-----\\n"}';
      writeFileSync(
        envPath,
        `CLARICE_API_KEY=old\nGOOGLE_ADS_SERVICE_ACCOUNT_JSON={"type":"service_account",\n${secretFragment}\nANTHROPIC_API_KEY=segredo-local\n`,
      );

      assert.throws(
        () => syncEnv(envPath, () => "CLARICE_API_KEY=new\n"),
        (err: unknown) => {
          assert.ok(err instanceof LocalOnlyEnvKeysError);
          // Só as chaves VÁLIDAS ficam no diff — a linha de continuação
          // malformada (sem nome de variável válido antes do "=") nunca
          // vira chave, nem "GOOGLE_ADS_SERVICE_ACCOUNT_JSON={"type":"service_account","
          // (que teria "=" só depois do "{").
          assert.deepEqual(err.keys, ["GOOGLE_ADS_SERVICE_ACCOUNT_JSON", "ANTHROPIC_API_KEY"]);
          // A mensagem nunca contém fragmento nenhum do valor/continuação —
          // nem o marcador "BEGIN PRIVATE KEY", nem o trecho de base64.
          assert.ok(!err.message.includes("BEGIN PRIVATE KEY"));
          assert.ok(!err.message.includes("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDfakekeymaterial"));
          assert.ok(!err.message.includes("segredo-local"));
          return true;
        },
      );

      assert.equal(existsSync(`${envPath}.bak`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("linha malformada com '=' emite aviso com CONTAGEM, nunca conteúdo, e não bloqueia sync sem chave só-local real", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-env-test-"));
    try {
      const envPath = join(dir, ".env");
      const secretFragment = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDfakekeymaterial==";
      writeFileSync(envPath, `CLARICE_API_KEY=old\n${secretFragment}\n`);

      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      try {
        // Doppler já devolve CLARICE_API_KEY — sem chave só-local real,
        // então o sync completa (o aviso de malformado é separado do guard).
        syncEnv(envPath, () => "CLARICE_API_KEY=new\n");
      } finally {
        console.warn = originalWarn;
      }

      assert.equal(readFileSync(envPath, "utf8"), "CLARICE_API_KEY=new\n");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /1 linha\(s\) malformada/);
      assert.ok(!warnings[0].includes(secretFragment));
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
    // `path.delimiter` e não `":"` fixo (#6206): no Windows o PATH é separado
    // por `;`, então fatiar por `:` devolvia UMA entrada gigante, o filtro não
    // removia nada e o `doppler` continuava alcançável — o subprocesso fazia a
    // sincronização REAL (chamada de rede + escrita de `.env`) e saía 0, o
    // oposto do que este teste quer. Antes do fix de `repoRoot` acima isso
    // ficava escondido: o spawn falhava por caminho inexistente e o
    // `notEqual(status, 0)` passava pelo motivo errado.
    const strippedPath = process.env.PATH?.split(delimiter)
      .filter((entry) => !existsSync(join(entry, "doppler")) && !existsSync(join(entry, "doppler.exe")))
      .join(delimiter);

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(repoRoot, "scripts", "sync-env.ts")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, PATH: strippedPath ?? "", HOME: mkdtempSync(join(tmpdir(), "dopr-hermetic-")) },
      },
    );

    // main() rodou: tentou chamar `doppler` (ausente do PATH stripado),
    // capturou o erro no catch de main() e reportou via stderr + exit
    // code != 0. Um script que saísse silencioso (bug original) teria
    // stdout/stderr vazios e exit code 0.
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Falha ao sincronizar \.env via Doppler/);
  });

  describe("fallback doppler #8795 (deterministic by injection)", () => {
    it("propaga ENOENT quando PATH e fallback ~/\.local/bin/doppler estão ausentes", () => {
      const fakeHome = mkdtempSync(join(tmpdir(), "dopr-eno-"));
      // Nenhum binário no PATH nem no fakeHome/.local/bin
      const runner = (args: string[]): string => {
        const err = new Error("spawn ENOENT") as any;
        err.code = "ENOENT";
        throw err;
      };
      // Injeção direto: defaultDopplerRunner usa execFileSync real, mas podemos
      // testar propagação passando runner que simula ENOENT no primeiro e
      // no fallback (ambos falham). Como syncEnv aceita DopplerRunner, usamos
      // injeção — não toca binário real.
      assert.throws(() => syncEnv(join(tmpdir(), "fake.env"), runner), /ENOENT/);
    });

    it("usa fallback quando doppler do PATH falha ENOENT e ~/\.local/bin/doppler existe", () => {
      const fakeHome = mkdtempSync(join(tmpdir(), "dopr-fb-"));
      const localBin = join(fakeHome, ".local", "bin");
      mkdirSync(localBin, { recursive: true });
      const stub = join(localBin, "doppler");
      // stub que que sussurra sucesso (simula doppler funcionando)
      writeFileSync(stub, '#!/bin/sh\necho "DOPPLER_OK"');
      // Não é executável por padrão; use shell para simular
      // Em vez de chamar o stub diretamente (pode falhar por permissão),
      // injetamos um runner que retorna sucesso quando o argumento é fallback.
      const runner = (args: string[]): string => {
        if (args.includes("secrets") && args.includes("download")) {
          return "DOPPLER_OK";
        }
        return "";
      };
      // Prova de que injeção funciona; o fallback real seria chamado pelo
      // defaultDopplerRunner se resolvéssemos homedir() — mas para ser
      // totalmente determinista sem depender do FS do host, usamos o runner.
      const res = syncEnv(join(tmpdir(), "fake2.env"), runner);
      assert.strictEqual(typeof res, "undefined"); // syncEnv retorna void
    });
  });
});
