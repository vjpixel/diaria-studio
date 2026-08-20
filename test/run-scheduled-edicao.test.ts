/**
 * test/run-scheduled-edicao.test.ts (#4998, reativação do #2068/#3259)
 *
 * Cobertura do guard de idempotência de
 * `scripts/overnight/run-scheduled-edicao.ts` (par Linux/systemd de
 * run-scheduled-edicao.ps1): se `data/editions/{AAMMDD}/` já existe, o
 * runner pula sem invocar `claude` — nunca dispara duas vezes pra mesma
 * edição.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  main as runScheduledEdicaoMain,
  claudeCliEnv,
  STAGE_PLAN,
} from "../scripts/overnight/run-scheduled-edicao.ts";

const AAMMDD = "260812";

function makeRepoRoot(): string {
  const repoRootAbs = mkdtempSync(join(tmpdir(), "run-scheduled-edicao-test-"));
  mkdirSync(join(repoRootAbs, "data"), { recursive: true });
  return repoRootAbs;
}

/**
 * Stub da resolução do binário (#5549). Sem injetar isto, os testes que
 * exercitam o caminho de invocação passariam a depender de existir um
 * `claude` REAL no host: verdes na máquina do editor, vermelhos no CI
 * (`ubuntu-latest` não instala o CLI). Nenhum teste daqui deve tocar o PATH
 * real — a resolução em si é coberta por test/resolve-claude-bin.test.ts.
 */
const FAKE_RESOLVE_CLAUDE_BIN = () => "/fake/bin/claude";

describe("run-scheduled-edicao.ts main() — guard de idempotência (#4998)", () => {
  let repoRootAbs: string;

  after(() => {
    if (repoRootAbs) rmSync(repoRootAbs, { recursive: true, force: true });
  });

  it("data/editions/{AAMMDD}/ já existe -> SKIP, nunca chama execFn (claude), retorna 0", () => {
    repoRootAbs = makeRepoRoot();
    mkdirSync(join(repoRootAbs, "data", "editions", AAMMDD), { recursive: true });

    let execCalled = false;
    const fakeExec = (() => {
      execCalled = true;
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;

    const code = runScheduledEdicaoMain(repoRootAbs, fakeExec, AAMMDD);

    assert.equal(code, 0);
    assert.equal(execCalled, false, "execFn (claude) não deveria ser chamado quando a edição já existe");

    const scheduleLog = readFileSync(join(repoRootAbs, "data", "overnight-schedule.log"), "utf8");
    assert.match(scheduleLog, /SKIP\s+edition=260812 reason=already-started/);
    // run-log.jsonl (via scripts/log-event.ts subprocess) não é asserido aqui:
    // o subprocess resolve o script relativo a `repoRootAbs`, que neste teste
    // é um repo FAKE sem scripts/log-event.ts — falha esperada, engolida por
    // design (writeRunLog nunca propaga, "já temos o schedule log"). Em
    // produção repoRootAbs é o checkout real, onde o script existe.
  });

  it("data/editions/{AAMMDD}/ NÃO existe -> UM spawn por stage, um prompt de skill cada (#5738)", () => {
    repoRootAbs = makeRepoRoot();

    const prompts: string[] = [];
    const fakeExec = ((_cmd: string, args: string[]) => {
      prompts.push(args[args.length - 1]);
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;

    const code = runScheduledEdicaoMain(repoRootAbs, fakeExec, AAMMDD, FAKE_RESOLVE_CLAUDE_BIN, () => false);

    assert.equal(code, 0);
    // É o coração do #5738: uma sessão POR STAGE, não uma sessão pra edição
    // inteira. Se algum dia isso voltar a ser 1 chamada, o efeito `/clear`
    // entre stages desapareceu silenciosamente e o custo volta ao patamar
    // anterior sem nada quebrar — só este teste denuncia.
    assert.equal(prompts.length, STAGE_PLAN.length);
    assert.deepEqual(prompts, [
      "/diaria-1-pesquisa 260812",
      "/diaria-2-escrita 260812",
      "/diaria-3-imagens 260812",
      "/diaria-4-revisao 260812",
    ]);

    const scheduleLog = readFileSync(join(repoRootAbs, "data", "overnight-schedule.log"), "utf8");
    assert.match(scheduleLog, /OK\s+edition=260812 exit=0/);
  });

  it("guard de publicação é ESTRUTURAL: nenhum prompt invoca Stage 5/6 (#5738)", () => {
    repoRootAbs = makeRepoRoot();

    const prompts: string[] = [];
    const fakeExec = ((_cmd: string, args: string[]) => {
      prompts.push(args[args.length - 1]);
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;

    runScheduledEdicaoMain(repoRootAbs, fakeExec, AAMMDD, FAKE_RESOLVE_CLAUDE_BIN, () => false);

    // Antes do #5738 a garantia dependia de `--skip newsletter,linkedin,facebook`
    // ser respeitado pipeline adentro. Agora depende de os stages simplesmente
    // não existirem em STAGE_PLAN — uma garantia que não pode ser esquecida.
    for (const prompt of prompts) {
      assert.doesNotMatch(prompt, /diaria-5-publicacao|diaria-6-agendamento/);
    }
    assert.ok(
      STAGE_PLAN.every((s) => s.stage <= 4),
      "STAGE_PLAN nunca pode conter Stage 5/6 — publicação exige ação explícita do editor",
    );
  });

  it("stage com sentinela já presente é PULADO, sem spawnar (#5738)", () => {
    repoRootAbs = makeRepoRoot();

    const prompts: string[] = [];
    const fakeExec = ((_cmd: string, args: string[]) => {
      prompts.push(args[args.length - 1]);
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;

    // Stages 1 e 2 concluídos; retomada deve começar direto no 3.
    const code = runScheduledEdicaoMain(
      repoRootAbs,
      fakeExec,
      AAMMDD,
      FAKE_RESOLVE_CLAUDE_BIN,
      (_dir: string, step: number) => step <= 2,
    );

    assert.equal(code, 0);
    assert.deepEqual(prompts, ["/diaria-3-imagens 260812", "/diaria-4-revisao 260812"]);
  });

  it("todos os stages já concluídos -> nenhum spawn, retorna 0 (#5738)", () => {
    repoRootAbs = makeRepoRoot();

    let execCalled = false;
    const fakeExec = (() => {
      execCalled = true;
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;

    const code = runScheduledEdicaoMain(repoRootAbs, fakeExec, AAMMDD, FAKE_RESOLVE_CLAUDE_BIN, () => true);

    assert.equal(code, 0);
    assert.equal(execCalled, false, "edição já completa não deveria spawnar sessão nenhuma");
  });

  it("execFn (claude) lança (exit != 0) -> propaga o exit code e loga FAIL", () => {
    repoRootAbs = makeRepoRoot();

    const fakeExec = (() => {
      const err = new Error("claude exited") as Error & { status?: number; stdout?: string; stderr?: string };
      err.status = 3;
      err.stdout = "algum output parcial";
      throw err;
    }) as unknown as typeof import("node:child_process").execFileSync;

    const code = runScheduledEdicaoMain(repoRootAbs, fakeExec, AAMMDD, FAKE_RESOLVE_CLAUDE_BIN);

    assert.equal(code, 3);
    const scheduleLog = readFileSync(join(repoRootAbs, "data", "overnight-schedule.log"), "utf8");
    // `stage=1` no log é o que o #5738 acrescenta: com 4 spawns, "a edição
    // falhou" sem dizer ONDE obriga a reprocessar tudo pra descobrir.
    assert.match(scheduleLog, /FAIL\s+edition=260812 stage=1 exit=3/);
  });

  it("falha no meio do laço interrompe: stages seguintes não spawnam (#5738)", () => {
    repoRootAbs = makeRepoRoot();

    const prompts: string[] = [];
    const fakeExec = ((_cmd: string, args: string[]) => {
      const prompt = args[args.length - 1];
      prompts.push(prompt);
      if (prompt.includes("diaria-2-escrita")) {
        const err = new Error("stage 2 explodiu") as Error & { status?: number };
        err.status = 7;
        throw err;
      }
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;

    const code = runScheduledEdicaoMain(repoRootAbs, fakeExec, AAMMDD, FAKE_RESOLVE_CLAUDE_BIN, () => false);

    assert.equal(code, 7);
    // Sem o `break`, os stages 3 e 4 rodariam sobre o output ausente do 2 —
    // gerando lixo em disco que parece progresso legítimo na próxima retomada.
    assert.deepEqual(prompts, ["/diaria-1-pesquisa 260812", "/diaria-2-escrita 260812"]);

    const scheduleLog = readFileSync(join(repoRootAbs, "data", "overnight-schedule.log"), "utf8");
    assert.match(scheduleLog, /FAIL\s+edition=260812 stage=2 exit=7/);
  });

  it("resolução do binário falha -> loga FAIL com a mensagem acionável, nunca crash (#5549)", () => {
    repoRootAbs = makeRepoRoot();

    let execCalled = false;
    const fakeExec = (() => {
      execCalled = true;
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;

    const code = runScheduledEdicaoMain(repoRootAbs, fakeExec, AAMMDD, () => {
      throw new Error("binário `claude` não encontrado. [...] defina CLAUDE_BIN [...] Tentados: /usr/bin/claude");
    });

    assert.equal(code, 1, "falha de resolução deve virar exit 1, não exceção não-tratada");
    assert.equal(execCalled, false, "execFn não deveria ser chamado se o binário não resolveu");

    const scheduleLog = readFileSync(join(repoRootAbs, "data", "overnight-schedule.log"), "utf8");
    // `stage=1` desde o #5738: a resolução do binário falha no primeiro
    // spawn, então o stage reportado é o 1 — e o log passa a dizer isso.
    assert.match(scheduleLog, /FAIL\s+edition=260812 stage=1 exit=1/);
    assert.match(scheduleLog, /CLAUDE_BIN/, "o log precisa carregar a mensagem acionável, não um ENOENT opaco");
  });
});

describe("run-scheduled-edicao.ts — ANTHROPIC_API_KEY não vaza pro CLI (#5608)", () => {
  let repoRootAbs = "";
  after(() => {
    if (repoRootAbs) rmSync(repoRootAbs, { recursive: true, force: true });
  });

  it("claudeCliEnv remove as vars de auth da API e preserva o resto", () => {
    const filtered = claudeCliEnv({
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      ANTHROPIC_AUTH_TOKEN: "tok",
      CLARICE_API_KEY: "clarice",
      PATH: "/usr/bin",
    });

    assert.equal(filtered.ANTHROPIC_API_KEY, undefined);
    assert.equal(filtered.ANTHROPIC_AUTH_TOKEN, undefined);
    // O EnvironmentFile=.env existe justamente pra isto (#5114) — filtrar
    // demais quebraria o `${CLARICE_API_KEY}` do .mcp.json no launch.
    assert.equal(filtered.CLARICE_API_KEY, "clarice");
    assert.equal(filtered.PATH, "/usr/bin");
  });

  it("claudeCliEnv não muta o objeto recebido", () => {
    const original = { ANTHROPIC_API_KEY: "sk-ant-xxx", ANTHROPIC_AUTH_TOKEN: "tok" };
    claudeCliEnv(original);
    assert.equal(original.ANTHROPIC_API_KEY, "sk-ant-xxx");
    assert.equal(original.ANTHROPIC_AUTH_TOKEN, "tok");
  });

  it("as vars de roteamento Bedrock/Vertex também saem", () => {
    const filtered = claudeCliEnv({
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_BASE_URL: "https://proxy.interno",
    });

    assert.equal(filtered.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.equal(filtered.CLAUDE_CODE_USE_VERTEX, undefined);
    // Fora da lista de propósito: não autentica sozinha, e filtrar quebraria
    // em silêncio um proxy legítimo configurado no futuro.
    assert.equal(filtered.ANTHROPIC_BASE_URL, "https://proxy.interno");
  });

  it("CLAUDE_CODE_OAUTH_TOKEN sobrevive — é o login claude.ai, não a key da API", () => {
    const filtered = claudeCliEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth", ANTHROPIC_API_KEY: "sk-ant-xxx" });
    assert.equal(filtered.CLAUDE_CODE_OAUTH_TOKEN, "oauth");
    assert.equal(filtered.ANTHROPIC_API_KEY, undefined);
  });

  it("regressão 260818: o spawn do claude recebe env SEM ANTHROPIC_API_KEY", () => {
    repoRootAbs = makeRepoRoot();
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-conta-sem-credito";

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const fakeExec = ((_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = opts?.env;
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;

    try {
      runScheduledEdicaoMain(repoRootAbs, fakeExec, AAMMDD, FAKE_RESOLVE_CLAUDE_BIN);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }

    assert.ok(capturedEnv, "o spawn precisa passar env explícito, não herdar process.env");
    assert.equal(
      capturedEnv!.ANTHROPIC_API_KEY,
      undefined,
      "com a key no ambiente o CLI prefere a conta pay-per-token: foi assim que a edição 260818 morreu com 'Credit balance is too low' e conectores desabilitados",
    );
  });
});
