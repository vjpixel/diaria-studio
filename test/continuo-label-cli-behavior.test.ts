/**
 * test/continuo-label-cli-behavior.test.ts (#7704)
 *
 * Testa os 3 CLIs de label do contínuo END-TO-END, com um `gh` FAKE no PATH
 * — `test/continuo-labels.test.ts` cobre a lib pura e faz guards estáticos
 * sobre o texto dos arquivos, mas nunca roda `main()`, e foi essa lacuna
 * que deixou passar duas coisas no fleet review da PR #7706:
 *
 *  1. `labelApplied` significava "eu apliquei AGORA", então PR que já
 *     carregava o label reportava `false` — e o guard novo de
 *     `continuo-pr-review.sh` leria isso como falha de infra a cada tick,
 *     para sempre, com stderr vazio. A semântica passou a ser "o label ESTÁ
 *     na PR ao final" e é isso que estes testes travam.
 *  2. `mark-continuo-ci-fix-attempted.ts` ganhou DOIS pontos de `exit 1`
 *     (falha ao criar o label, falha ao aplicar) e nenhum teste exercia
 *     nenhum deles. Esse script fecha o cap de 1 tentativa de conserto de
 *     CI por PR — reportar sucesso sem o cap fechado é livelock.
 *
 * O fake de `gh` é um script de shell que responde por subcomando; cada
 * teste escolhe o cenário por variável de ambiente, sem rede nem `gh` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `gh` falso, COM ESTADO — um arquivo `labels.json` no diretório do fake
 * guarda os labels da PR, então `POST .../issues/N/labels` de fato muda o
 * que a releitura seguinte enxerga. Sem estado, `addPrLabelsRest` (que relê
 * depois de escrever, #6292) nunca poderia passar e o teste de sucesso
 * viraria falso vermelho.
 *
 * Escrito em Node, não em shell: o fluxo real faz duas leituras com `--jq`
 * diferentes (`[.labels[].name]`, array JSON, de `fetchLabels`; e
 * `.labels[].name`, uma por linha, da releitura), e distinguir isso em bash
 * dentro de um template literal de TS é escape demais para o que a fixture
 * precisa fazer.
 *
 * Cenários (`mode`):
 *  - `labeled`     — a PR já começa com o label pedido.
 *  - `unlabeled`   — começa sem label; o POST grava e a releitura enxerga.
 *  - `create-fail` — `POST repos/{owner}/{repo}/labels` (criação do label no
 *                    REPO) falha com um 422 que NÃO é `already_exists`.
 *  - `apply-fail`  — tudo responde 200, mas a releitura continua sem o
 *                    label: o modo de falha silenciosa do #6292, em que o
 *                    `gh` reporta sucesso sem ter aplicado nada.
 */
function makeFakeGh(mode: string, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const statePath = join(dir, "labels.json");
  writeFileSync(statePath, JSON.stringify(mode === "labeled" ? [label] : []), "utf8");

  const fakeJs = [
    'import { readFileSync, writeFileSync } from "node:fs";',
    "const MODE = process.env.FAKE_GH_MODE;",
    "const STATE = process.env.FAKE_GH_STATE;",
    "const argv = process.argv.slice(2);",
    "const joined = argv.join(' ');",
    "const read = () => JSON.parse(readFileSync(STATE, 'utf8'));",
    "",
    "if (argv[0] === 'pr' && argv[1] === 'view') {",
    "  const names = read();",
    "  const jq = argv[argv.indexOf('--jq') + 1] ?? '';",
    "  process.stdout.write(jq.startsWith('[') ? JSON.stringify(names) : names.join('\\n') + (names.length ? '\\n' : ''));",
    "  process.exit(0);",
    "}",
    "",
    "if (argv[0] === 'api' && joined.includes('POST')) {",
    "  const isRepoLabelCreate = joined.includes('repos/{owner}/{repo}/labels');",
    "  if (isRepoLabelCreate && MODE === 'create-fail') {",
    "    process.stderr.write('HTTP 422: Validation Failed\\ndescription is too long (maximum is 100 characters)\\n');",
    "    process.exit(1);",
    "  }",
    "  if (!isRepoLabelCreate && MODE !== 'apply-fail') {",
    "    const added = argv.filter((a) => a.startsWith('labels[]=')).map((a) => a.slice('labels[]='.length));",
    "    writeFileSync(STATE, JSON.stringify([...new Set([...read(), ...added])]));",
    "  }",
    "  process.stdout.write('{\"ok\":true}');",
    "  process.exit(0);",
    "}",
    "",
    "process.stderr.write('fake gh: subcomando nao previsto: ' + joined + '\\n');",
    "process.exit(1);",
  ].join("\n");
  const fakeJsPath = join(dir, "fake-gh.mjs");
  writeFileSync(fakeJsPath, fakeJs, "utf8");

  const shim = ["#!/usr/bin/env bash", 'exec node "' + fakeJsPath + '" "$@"'].join("\n") + "\n";
  const bin = join(dir, "gh");
  writeFileSync(bin, shim, "utf8");
  chmodSync(bin, 0o755);

  fakeEnv.set(dir, { FAKE_GH_MODE: mode, FAKE_GH_STATE: statePath });
  return dir;
}

/** Env por diretório de fake — `runCli` injeta ao chamar. */
const fakeEnv = new Map<string, Record<string, string>>();

interface RunResult {
  stdout: string;
  status: number;
}

function runCli(script: string, args: string[], fakeGhDir: string): RunResult {
  try {
    const stdout = execFileSync("npx", ["tsx", script, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, ...(fakeEnv.get(fakeGhDir) ?? {}), PATH: `${fakeGhDir}:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

const WRAPPERS = [
  { script: "scripts/check-continuo-reject-label.ts", label: "continuo-rejeitado" },
  { script: "scripts/check-continuo-escalate-label.ts", label: "continuo-escalado" },
];

describe("labelApplied = 'o label ESTÁ na PR ao final', não 'apliquei agora' (#7704)", () => {
  for (const { script, label } of WRAPPERS) {
    it(`${script}: PR JÁ labelada → firstTime=false E labelApplied=TRUE (regressão do falso erro de infra por tick)`, () => {
      const dir = makeFakeGh("labeled", label);
      try {
        const { stdout, status } = runCli(script, ["--pr", "7593"], dir);
        assert.equal(status, 0);
        const out = JSON.parse(stdout.trim());
        assert.equal(out.firstTime, false, "PR já labelada não é primeira vez");
        assert.equal(
          out.labelApplied,
          true,
          "labelApplied precisa ser true — false aqui faz continuo-pr-review.sh acusar erro de infra a cada tick, para sempre",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`${script}: PR sem label → firstTime=true e labelApplied=true após aplicar por REST`, () => {
      const dir = makeFakeGh("unlabeled", label);
      try {
        const { stdout, status } = runCli(script, ["--pr", "7593"], dir);
        assert.equal(status, 0);
        const out = JSON.parse(stdout.trim());
        assert.equal(out.firstTime, true);
        assert.equal(out.source, "ok");
        assert.equal(out.labelApplied, true, "aplicou por REST e a releitura confirmou");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`${script}: criação do label falha (422 que não é already_exists) → labelApplied=false, sem abortar`, () => {
      const dir = makeFakeGh("create-fail", label);
      try {
        const { stdout, status } = runCli(script, ["--pr", "7593"], dir);
        assert.equal(status, 0, "o wrapper nunca aborta — a decisão firstTime já foi tomada");
        const out = JSON.parse(stdout.trim());
        assert.equal(out.labelApplied, false, "falha real de criação PRECISA reportar false");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("mark-continuo-ci-fix-attempted: as duas metades falham alto (#7704)", () => {
  const SCRIPT = "scripts/mark-continuo-ci-fix-attempted.ts";

  it("sucesso → exit 0 e labelApplied=true", () => {
    const dir = makeFakeGh("unlabeled", "continuo-ci-fix-tentado");
    try {
      const { stdout, status } = runCli(SCRIPT, ["--pr", "7429"], dir);
      assert.equal(status, 0);
      assert.deepEqual(JSON.parse(stdout.trim()), { pr: 7429, labelApplied: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falha na CRIAÇÃO do label → exit 1, nunca labelApplied=true (o cap de 1 tentativa NÃO foi fechado)", () => {
    const dir = makeFakeGh("create-fail", "continuo-ci-fix-tentado");
    try {
      const { stdout, status } = runCli(SCRIPT, ["--pr", "7429"], dir);
      assert.equal(status, 1, "exit 0 aqui seria livelock: o tick assumiria o cap fechado sem estar");
      const out = JSON.parse(stdout.trim());
      assert.equal(out.labelApplied, false);
      assert.match(out.error ?? "", /description is too long|POST labels/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falha na APLICAÇÃO (releitura pós-escrita volta sem o label — o modo do #6292) → exit 1", () => {
    const dir = makeFakeGh("apply-fail", "continuo-ci-fix-tentado");
    try {
      const { stdout, status } = runCli(SCRIPT, ["--pr", "7429"], dir);
      assert.equal(status, 1);
      const out = JSON.parse(stdout.trim());
      assert.equal(out.labelApplied, false);
      assert.match(out.error ?? "", /não apareceram na releitura|falhou/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
