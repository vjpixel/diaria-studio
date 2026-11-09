/**
 * Tests for `scripts/lib/env-loader.ts` (#923, consolidado pra arquivo único em #4820).
 *
 * Reproduz o cenário 2026-05-07: scripts standalone não carregavam .env
 * → process.env.DIARIA_LINKEDIN_CRON_TOKEN ficava undefined → publish-linkedin
 * fazia fallback silencioso pra fire-now em vez de agendar.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { parse as dotenvParse } from "dotenv";

import {
  adoptDotenvForSystemdParsedKeys,
  isValidServiceAccountJson,
  loadProjectEnv,
  warnOnEnvDivergence,
} from "../scripts/lib/env-loader.ts";
import { parseSystemdEnvironmentFile } from "../scripts/lib/systemd-env-file.ts";

describe("#923 loadProjectEnv", () => {
  let tmpRoot: string;
  // Salvar e restaurar process.env entre tests
  const SAVED_KEYS = [
    "TEST_ENV_LOADER_FALLBACK",
    "TEST_ENV_LOADER_LOCAL_ONLY",
    "TEST_ENV_LOADER_PROCESS_WIN",
  ];
  const saved: Record<string, string | undefined> = {};

  before(() => {
    for (const k of SAVED_KEYS) saved[k] = process.env[k];
  });

  after(() => {
    for (const k of SAVED_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("carrega .env quando existe", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-1-"));
    writeFileSync(resolve(tmpRoot, ".env"), "TEST_ENV_LOADER_FALLBACK=hello-env\n");
    delete process.env.TEST_ENV_LOADER_FALLBACK;

    const loaded = loadProjectEnv(tmpRoot);
    assert.equal(process.env.TEST_ENV_LOADER_FALLBACK, "hello-env");
    assert.ok(loaded.some((p) => p.endsWith(".env")));

    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("#4820 — .env.local NÃO é mais carregado (regressão: só .env é lido)", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-2-"));
    writeFileSync(
      resolve(tmpRoot, ".env.local"),
      "TEST_ENV_LOADER_LOCAL_ONLY=from-local-only\n",
    );
    delete process.env.TEST_ENV_LOADER_LOCAL_ONLY;

    const loaded = loadProjectEnv(tmpRoot);
    assert.equal(process.env.TEST_ENV_LOADER_LOCAL_ONLY, undefined);
    assert.ok(!loaded.some((p) => p.endsWith(".env.local")));

    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("não sobrescreve var já presente em process.env (real env > .env)", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-3-"));
    writeFileSync(
      resolve(tmpRoot, ".env"),
      "TEST_ENV_LOADER_PROCESS_WIN=from-file\n",
    );
    process.env.TEST_ENV_LOADER_PROCESS_WIN = "from-process";

    loadProjectEnv(tmpRoot);
    assert.equal(process.env.TEST_ENV_LOADER_PROCESS_WIN, "from-process");

    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("idempotente — chamar 2× não erra", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-4-"));
    writeFileSync(resolve(tmpRoot, ".env"), "DUMMY=ok\n");

    loadProjectEnv(tmpRoot);
    loadProjectEnv(tmpRoot);
    // sucesso = não jogou
    assert.ok(true);

    rmSync(tmpRoot, { recursive: true, force: true });
  });
});

describe("#8237 warnOnEnvDivergence", () => {
  let tmpRoot: string;

  after(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("avisa (stderr) quando uma chave do .env diverge do ambiente já presente", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-divergence-"));
    const envFile = resolve(tmpRoot, ".env");
    writeFileSync(envFile, "GOOGLE_CLIENT_ID=from-dotenv\n");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      warnOnEnvDivergence(envFile, { GOOGLE_CLIENT_ID: "from-parent-process" } as NodeJS.ProcessEnv);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /GOOGLE_CLIENT_ID/);
    assert.match(warnings[0], /ambiente vence/);
  });

  it("não avisa quando o valor do ambiente bate com o do .env", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-divergence-match-"));
    const envFile = resolve(tmpRoot, ".env");
    writeFileSync(envFile, "SOME_KEY=same-value\n");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      warnOnEnvDivergence(envFile, { SOME_KEY: "same-value" } as NodeJS.ProcessEnv);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 0);
  });

  it("não avisa quando a chave não está no ambiente (caso comum — nada setado ainda)", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-divergence-absent-"));
    const envFile = resolve(tmpRoot, ".env");
    writeFileSync(envFile, "SOME_OTHER_KEY=value\n");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      warnOnEnvDivergence(envFile, {} as NodeJS.ProcessEnv);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 0);
  });

  it("nunca lança — arquivo ilegível vira no-op silencioso (dotenvConfig trata o erro de verdade)", () => {
    assert.doesNotThrow(() => warnOnEnvDivergence(resolve(tmpdir(), "arquivo-que-nao-existe.env")));
  });

  it("no máximo 1 aviso por chave por processo — chamadas repetidas não reemitem", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-divergence-dedupe-"));
    const envFile = resolve(tmpRoot, ".env");
    writeFileSync(envFile, "DEDUPE_KEY=from-dotenv\n");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const env = { DEDUPE_KEY: "from-parent-process" } as NodeJS.ProcessEnv;
      warnOnEnvDivergence(envFile, env);
      warnOnEnvDivergence(envFile, env);
      warnOnEnvDivergence(envFile, env);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
  });

  it("loadProjectEnv() de verdade aciona o aviso quando o .env carregado diverge do ambiente", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-divergence-wired-"));
    writeFileSync(resolve(tmpRoot, ".env"), "TEST_ENV_LOADER_WIRED_DIVERGENCE=from-dotenv\n");
    process.env.TEST_ENV_LOADER_WIRED_DIVERGENCE = "from-process";

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      loadProjectEnv(tmpRoot);
    } finally {
      console.warn = originalWarn;
      delete process.env.TEST_ENV_LOADER_WIRED_DIVERGENCE;
    }

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /TEST_ENV_LOADER_WIRED_DIVERGENCE/);
  });

  it("sob systemd (INVOCATION_ID), o aviso aponta onde procurar a outra fonte (#12477)", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-divergence-systemd-hint-"));
    const envFile = resolve(tmpRoot, ".env");
    writeFileSync(envFile, "SYSTEMD_HINT_KEY=from-dotenv\n");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      warnOnEnvDivergence(envFile, { SYSTEMD_HINT_KEY: "outra-fonte", INVOCATION_ID: "abc" } as NodeJS.ProcessEnv);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /show-environment/);
    assert.match(warnings[0], /systemd-env-divergence\.md/);
  });
});

describe("#12477 mesmo .env lido pelo systemd (EnvironmentFile=)", () => {
  let tmpRoot: string;

  after(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Linha como `materialize-google-ads-credentials.ts` grava (#6704): JSON sem
  // aspas, com `\n` escapados dentro da private_key.
  const SA_JSON = '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\\nMIIabc\\n-----END PRIVATE KEY-----\\n","client_email":"x@y.iam.gserviceaccount.com"}';
  // O que o systemd põe no ambiente da unit a partir dessa linha: barras removidas.
  const SA_JSON_SYSTEMD = SA_JSON.replace(/\\/g, "");

  it("reproduz o cenário: ambiente = parse systemd do .env => adota o valor do dotenv, sem aviso", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-systemd-"));
    const key = "TEST_ENV_LOADER_GADS_SA_JSON";
    writeFileSync(resolve(tmpRoot, ".env"), `${key}=${SA_JSON}\n`);
    process.env[key] = SA_JSON_SYSTEMD;

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    let loaded: string | undefined;
    try {
      loadProjectEnv(tmpRoot);
      loaded = process.env[key];
    } finally {
      console.warn = originalWarn;
      delete process.env[key];
    }

    assert.equal(loaded, SA_JSON);
    const parsed = JSON.parse(loaded!);
    assert.match(parsed.private_key, /-----BEGIN PRIVATE KEY-----\nMIIabc\n/);
    assert.equal(warnings.filter((w) => w.includes(key)).length, 0);
  });

  it("adoptDotenvForSystemdParsedKeys devolve só as chaves trocadas", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-systemd-adopt-"));
    const envFile = resolve(tmpRoot, ".env");
    writeFileSync(envFile, `SA=${SA_JSON}\nPLAIN=igual\n`);
    const env = { SA: SA_JSON_SYSTEMD, PLAIN: "igual" } as NodeJS.ProcessEnv;

    assert.deepEqual(adoptDotenvForSystemdParsedKeys(envFile, env), ["SA"]);
    assert.equal(env.SA, SA_JSON);
    assert.equal(env.PLAIN, "igual");
  });

  it("valor de OUTRA fonte (não bate com o parse systemd) continua vencendo", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-systemd-other-"));
    const envFile = resolve(tmpRoot, ".env");
    writeFileSync(envFile, `SA=${SA_JSON}\n`);
    const env = { SA: '{"type":"service_account","client_email":"outra@y"}' } as NodeJS.ProcessEnv;

    assert.deepEqual(adoptDotenvForSystemdParsedKeys(envFile, env), []);
    assert.equal(env.SA, '{"type":"service_account","client_email":"outra@y"}');
  });

  it(".env no formato do Doppler (aspas duplas): mantém o valor do systemd, que é o bom, e não avisa", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-systemd-doppler-"));
    const key = "TEST_ENV_LOADER_GADS_SA_JSON_QUOTED";
    // Como o Doppler grava: entre aspas duplas, `\"` internos, `\n` literais.
    const line = `${key}="${SA_JSON.replace(/"/g, '\\"')}"\n`;
    writeFileSync(resolve(tmpRoot, ".env"), line);
    const systemdValue = parseSystemdEnvironmentFile(line)[key];
    assert.ok(isValidServiceAccountJson(systemdValue), "pré-condição: o systemd lê o JSON certo");
    assert.ok(!isValidServiceAccountJson(dotenvParse(line)[key]), "pré-condição: o dotenv corrompe");
    process.env[key] = systemdValue;

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    let loaded: string | undefined;
    try {
      loadProjectEnv(tmpRoot);
      loaded = process.env[key];
    } finally {
      console.warn = originalWarn;
      delete process.env[key];
    }

    assert.equal(loaded, systemdValue);
    assert.equal(warnings.filter((w) => w.includes(key)).length, 0);
  });

  it("valor sem aspas com `#` no meio: a unit continua com o valor inteiro do systemd, sem aviso", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-systemd-hash-"));
    const key = "TEST_ENV_LOADER_HASH_VALUE";
    writeFileSync(resolve(tmpRoot, ".env"), `${key}=abc#def\n`);
    process.env[key] = "abc#def";

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    let loaded: string | undefined;
    try {
      loadProjectEnv(tmpRoot);
      loaded = process.env[key];
    } finally {
      console.warn = originalWarn;
      delete process.env[key];
    }

    assert.equal(loaded, "abc#def");
    assert.equal(warnings.filter((w) => w.includes(key)).length, 0);
  });

  it("arquivo ilegível vira lista vazia, sem lançar", () => {
    assert.deepEqual(adoptDotenvForSystemdParsedKeys(resolve(tmpdir(), "nao-existe-12477.env"), {}), []);
  });
});
