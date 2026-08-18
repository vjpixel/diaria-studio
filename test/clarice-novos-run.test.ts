/**
 * test/clarice-novos-run.test.ts (#4941)
 *
 * Cobre `scripts/clarice-novos-run.ts` — o orquestrador determinístico que
 * substitui o *glue* em prosa da skill `/diaria-clarice-novos` (#4347) pra
 * viabilizar a task agendada diária `Diaria-Clarice-Novos`. Nenhum spawn
 * real: `exec` é injetado, um fake que registra as chamadas (script + args,
 * na ordem) e devolve respostas canned — os testes verificam tanto o
 * RESULTADO (exit code, report) quanto a SEQUÊNCIA/ARGS exatos passados a
 * cada sub-script (onde vivem as regressões documentadas no #4347/#4941:
 * reuso de `--key`, `--hold juridico` sempre presente, `--content-cycle`
 * só quando os ciclos divergem, `clarice-novos-html-state` nunca recebe
 * `--content-cycle`).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { readNovosCutoff } from "../scripts/lib/clarice-novos-cutoff.ts";
import { readNovosRunStatus } from "../scripts/lib/clarice-novos-run-status.ts";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runNovos,
  parseNovosRunArgs,
  parseStepJson,
  todayAammdd,
  NovosAbort,
  NOVOS_SEMAPHORE_ABORT_EXIT_CODE,
  type NovosRunDeps,
  type StepResult,
  type ExecFn,
} from "../scripts/clarice-novos-run.ts";

// ---------------------------------------------------------------------------
// Harness — fake exec que registra chamadas e devolve respostas canned.
// ---------------------------------------------------------------------------

type Handler = StepResult | StepResult[] | ((args: string[], callIndex: number) => StepResult);

function jsonResult(obj: unknown, code = 0): StepResult {
  return { code, stdout: JSON.stringify(obj), stderr: "" };
}

function textResult(text: string, code = 0): StepResult {
  return { code, stdout: text, stderr: "" };
}

function makeFakeExec(handlers: Record<string, Handler>): { exec: ExecFn; calls: Array<{ script: string; args: string[] }> } {
  const calls: Array<{ script: string; args: string[] }> = [];
  const counters: Record<string, number> = {};
  const exec: ExecFn = (script, args) => {
    calls.push({ script, args });
    const idx = counters[script] ?? 0;
    counters[script] = idx + 1;
    const h = handlers[script];
    if (h === undefined) {
      throw new Error(`fakeExec: sem handler para "${script}" (chamada #${idx}, args=${args.join(" ")})`);
    }
    if (typeof h === "function") return h(args, idx);
    if (Array.isArray(h)) {
      const r = h[idx];
      if (!r) throw new Error(`fakeExec: handler array esgotado para "${script}" na chamada #${idx}`);
      return r;
    }
    return h;
  };
  return { exec, calls };
}

/** Respostas canned de sucesso pro caminho feliz completo — cada teste
 * sobrescreve só o que precisa mudar (`{...GOLDEN_HANDLERS, script: ...}`). */
function goldenHandlers(opts: { cicloMensal?: string; shouldSendTest?: boolean } = {}): Record<string, Handler> {
  const cicloMensal = opts.cicloMensal ?? "2607-08";
  return {
    "scripts/clarice-check-derived-stale.ts": textResult("fresh"),
    "scripts/clarice-build-db.ts": textResult(""),
    "scripts/clarice-stripe-delta.ts": jsonResult({ mode: "execute", since: "2026-08-01", rows: 12, out: "x.csv" }),
    "scripts/verify-emails-mv.ts": jsonResult({ mode: "since", since: "2026-08-01", cohorts: [], total_verified: 3 }),
    "scripts/clarice-check-semaphore.ts": jsonResult({ ok: true, semaphore: "green" }),
    "scripts/clarice-build-segment.ts": jsonResult({ selected: 42, hold: "juridico", cycle: "2607-08", group: "novos" }),
    "scripts/clarice-novos-resolve-key.ts": jsonResult({ key: "novos-260810" }),
    "scripts/clarice-resolve-folder.ts": jsonResult({ folderId: 7, resolved: true }),
    "scripts/clarice-import-waves.ts": jsonResult({ mode: "execute", results: [{ listId: 99, wave: "novos" }] }),
    "scripts/clarice-novos-resolve-cycle.ts": jsonResult({ cycle: cicloMensal, subject: "Assunto X", fallback: false, checked: [] }),
    "scripts/clarice-schedule-group.ts": [
      jsonResult({ key: "novos-260810", listId: 99, campaignId: 555, phase: "create", status: "draft" }),
      ...(opts.shouldSendTest === false ? [] : [jsonResult({ key: "novos-260810", listId: 99, campaignId: 555, phase: "send-test" })]),
      jsonResult({ key: "novos-260810", listId: 99, campaignId: 555, phase: "send-now", status: "sent" }),
    ],
    "scripts/clarice-novos-html-state.ts": [
      jsonResult({ htmlSha256: "abc", shouldSendTest: opts.shouldSendTest ?? true, previousState: null }),
      jsonResult({ lastRunAt: "2026-08-10T20:00:00.000Z", sentCount: 42, lastCycle: cicloMensal }),
    ],
  };
}

function baseDeps(rootDir: string, overrides: Partial<NovosRunDeps> = {}): NovosRunDeps {
  return {
    rootDir,
    now: () => new Date("2026-08-10T20:00:00.000Z"), // 17:00 BRT
    exec: () => {
      throw new Error("exec não deveria ser chamado — configure `handlers`");
    },
    isEnabled: () => true,
    resolveEnvioCycle: () => "2607-08",
    execMode: () => "local",
    ...overrides,
  };
}

const ENV_KEYS = ["STRIPE_API_KEY", "BREVO_CLARICE_API_KEY", "MILLION_VERIFIER_API_KEY"] as const;

describe("clarice-novos-run (#4941)", () => {
  let root: string;
  const savedEnv: Record<string, string | undefined> = {};

  before(() => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      process.env[k] = "test-key";
    }
  });

  after(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  function freshRoot(): string {
    return mkdtempSync(join(tmpdir(), "clarice-novos-run-"));
  }

  // ── helpers pequenos ──────────────────────────────────────────────────

  it("parseNovosRunArgs lê todas as flags", () => {
    const o = parseNovosRunArgs(["--since", "2026-08-01", "--dry-run", "--force", "--subject", "Oi", "--confirm"]);
    assert.deepEqual(o, { since: "2026-08-01", dryRun: true, force: true, subject: "Oi", confirm: true });
  });

  it("parseNovosRunArgs sem flags -> tudo default (o que a task agendada de fato passa)", () => {
    assert.deepEqual(parseNovosRunArgs([]), { since: undefined, dryRun: false, force: false, subject: undefined, confirm: false });
  });

  it("parseStepJson extrai JSON mesmo com linhas de log antes", () => {
    assert.deepEqual(parseStepJson('algum log\n{"a":1}'), { a: 1 });
    assert.equal(parseStepJson(""), undefined);
    assert.equal(parseStepJson("não é json"), undefined);
  });

  it("todayAammdd(2026-08-10T20:00:00Z) -> 260810 (BRT = 17:00, mesmo dia)", () => {
    assert.equal(todayAammdd(new Date("2026-08-10T20:00:00.000Z")), "260810");
  });

  // ── kill switch ────────────────────────────────────────────────────────

  describe("kill switch (#4941 E3)", () => {
    it("isEnabled=false -> exit 0, ZERO chamadas externas, relatório 'pausado'", async () => {
      root = freshRoot();
      const { exec, calls } = makeFakeExec({});
      const deps = baseDeps(root, { exec, isEnabled: () => false });
      const result = await runNovos([], deps);
      assert.equal(result.code, 0);
      assert.equal(calls.length, 0, "nenhuma chamada externa deveria acontecer com o toggle desligado");
      assert.match(result.reportMarkdown, /PAUSADA/);
      assert.ok(existsSync(resolve(root, "data", "clarice-subscribers", "novos-reports", `${result.reportId}.md`)));
      rmSync(root, { recursive: true, force: true });
    });
  });

  // ── preflight ──────────────────────────────────────────────────────────

  describe("Passo 0 — preflight", () => {
    it("execMode != local -> aborta (exit 1), zero chamadas externas", async () => {
      root = freshRoot();
      const { exec, calls } = makeFakeExec({});
      const deps = baseDeps(root, { exec, execMode: () => "cloud" });
      const result = await runNovos([], deps);
      assert.equal(result.code, 1);
      assert.equal(calls.length, 0);
      assert.match(result.reportMarkdown, /exec-mode/);
      rmSync(root, { recursive: true, force: true });
    });

    it("env var ausente -> aborta (exit 1) antes de qualquer chamada", async () => {
      root = freshRoot();
      const saved = process.env.STRIPE_API_KEY;
      delete process.env.STRIPE_API_KEY;
      try {
        const { exec, calls } = makeFakeExec({});
        const deps = baseDeps(root, { exec });
        const result = await runNovos([], deps);
        assert.equal(result.code, 1);
        assert.equal(calls.length, 0);
        assert.match(result.reportMarkdown, /STRIPE_API_KEY/);
      } finally {
        if (saved === undefined) delete process.env.STRIPE_API_KEY;
        else process.env.STRIPE_API_KEY = saved;
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  // ── #4983: preflight lia process.env do orquestrador (que nunca lê .env) ──
  //
  // Achado ao vivo na 1ª invocação real da task agendada (260811): o
  // orquestrador (este arquivo) nunca chamava `loadProjectEnv()` — só os
  // sub-scripts SPAWNADOS carregavam `.env` sozinhos. O preflight do Passo 0
  // abortava mesmo com as 3 keys presentes em `.env`, porque `process.env`
  // nunca era populado a partir dele.
  //
  // Por que um teste ESTÁTICO (regex sobre o source), e não um teste
  // comportamental que escreve um `.env` temporário e espera o preflight
  // passar: `loadProjectEnv()` (scripts/lib/env-loader.ts), chamada aqui SEM
  // argumento, resolve a raiz do projeto a partir do PRÓPRIO
  // `import.meta.url` do env-loader — não há como redirecionar o
  // carregamento pra um `.env` de fixture isolado sem escrever no `.env`
  // REAL do projeto (mesmo trade-off documentado em
  // `test/studio-server-env-loading.test.ts` #3867 pro mesmo padrão de
  // chamada sem override). E mesmo escrevendo lá, a garantia de execução de
  // módulo ESM (o corpo do módulo roda inteiro na primeira importação,
  // antes de qualquer teste rodar) faria um teste "comportamental" passar
  // mesmo que a chamada fosse movida pra DEPOIS do preflight dentro de
  // `runNovos` — porque o preflight só roda quando `runNovos()` é invocado
  // por um teste, e a essa altura o módulo (com ou sem a chamada correta)
  // já terminou de carregar. O invariante real que #4983 pede é sintático:
  // "a chamada de `loadProjectEnv()` aparece no source ANTES do bloco do
  // preflight que lê `process.env[...]`" — é essa ORDEM textual que uma
  // reordenação de imports/código poderia desfazer sem quebrar nenhum teste
  // comportamental existente (os outros testes desta suíte já setam as 3
  // keys direto em `process.env`, no `before()` do arquivo — nunca exercitam
  // o carregamento via `.env`).
  describe("#4983 — loadProjectEnv() no orquestrador (não só nos sub-scripts)", () => {
    const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "clarice-novos-run.ts");
    const src = readFileSync(SCRIPT_PATH, "utf8");

    it("importa loadProjectEnv de lib/env-loader.ts", () => {
      assert.match(
        src,
        /import\s+\{\s*loadProjectEnv\s*\}\s+from\s+["']\.\/lib\/env-loader\.ts["']/,
        "scripts/clarice-novos-run.ts deve importar loadProjectEnv de ./lib/env-loader.ts",
      );
    });

    it("chama loadProjectEnv() em scope top-level (não dentro de runNovos/função)", () => {
      assert.match(
        src,
        /^loadProjectEnv\(\);?\s*$/m,
        "scripts/clarice-novos-run.ts deve chamar loadProjectEnv() em scope top-level — guarda contra " +
          "remoção acidental (ex: mover pra dentro de runNovos, ou apagar achando redundante).",
      );
    });

    it("a chamada de loadProjectEnv() aparece ANTES do bloco de preflight que lê process.env[...] — " +
      "trava a ORDEM, não só o comportamento final", () => {
      const callMatch = src.match(/^loadProjectEnv\(\);?\s*$/m);
      const preflightMatch = src.match(/for\s*\(\s*const\s+envVar\s+of\s*\[\s*["']STRIPE_API_KEY["']/);
      assert.ok(callMatch, "chamada explícita loadProjectEnv() não encontrada");
      assert.ok(preflightMatch, "bloco de preflight (for envVar of [...]) não encontrado — arquivo mudou de forma inesperada?");
      assert.ok(
        (callMatch!.index as number) < (preflightMatch!.index as number),
        "loadProjectEnv() deve vir ANTES do bloco de preflight no arquivo — uma reordenação de " +
          "imports/código que mova a chamada pra depois do preflight desfaz o fix do #4983 sem quebrar " +
          "nenhum teste comportamental (os outros testes desta suíte setam as 3 keys direto em " +
          "process.env, não via .env).",
      );
    });
  });

  // ── caminho feliz ──────────────────────────────────────────────────────

  describe("caminho feliz — sequência e args exatos", () => {
    it("dispara com sucesso: --key reusado, --hold juridico presente, --content-cycle só quando os ciclos divergem", async () => {
      root = freshRoot();
      const { exec, calls } = makeFakeExec(goldenHandlers({ cicloMensal: "2607-08" })); // diverge de 2607-08? igual — ver teste seguinte para divergência
      const deps = baseDeps(root, { exec, resolveEnvioCycle: () => "2606-07" }); // cicloEnvio != cicloMensal -> força --content-cycle
      const result = await runNovos([], deps);
      assert.equal(result.code, 0, result.reportMarkdown);

      const scripts = calls.map((c) => c.script);
      assert.deepEqual(scripts, [
        "scripts/clarice-check-derived-stale.ts",
        "scripts/clarice-stripe-delta.ts",
        "scripts/clarice-build-db.ts",
        "scripts/verify-emails-mv.ts",
        "scripts/clarice-build-db.ts",
        "scripts/clarice-check-semaphore.ts",
        "scripts/clarice-build-segment.ts",
        "scripts/clarice-novos-resolve-key.ts",
        "scripts/clarice-resolve-folder.ts",
        "scripts/clarice-import-waves.ts",
        "scripts/clarice-novos-resolve-cycle.ts",
        "scripts/clarice-schedule-group.ts", // --create
        "scripts/clarice-novos-html-state.ts", // shouldSendTest?
        "scripts/clarice-schedule-group.ts", // --send-test
        "scripts/clarice-schedule-group.ts", // --send-now
        "scripts/clarice-novos-html-state.ts", // --finalize
      ]);

      // --key idêntica em TODAS as invocações que a recebem (import, create, send-test, send-now).
      const keyBearers = calls.filter((c) => c.args.includes("--key"));
      for (const c of keyBearers) {
        const i = c.args.indexOf("--key");
        assert.equal(c.args[i + 1], "novos-260810", `${c.script} usou key diferente: ${c.args.join(" ")}`);
      }

      // --hold juridico sempre presente na chamada de build-segment.
      const segmentCall = calls.find((c) => c.script === "scripts/clarice-build-segment.ts")!;
      assert.ok(segmentCall.args.includes("--hold"));
      assert.equal(segmentCall.args[segmentCall.args.indexOf("--hold") + 1], "juridico");

      // --content-cycle presente nas 3 chamadas de schedule-group (ciclos divergem: 2606-07 != 2607-08).
      const scheduleCalls = calls.filter((c) => c.script === "scripts/clarice-schedule-group.ts");
      assert.equal(scheduleCalls.length, 3);
      for (const c of scheduleCalls) {
        assert.ok(c.args.includes("--content-cycle"), `esperava --content-cycle em ${c.args.join(" ")}`);
        assert.equal(c.args[c.args.indexOf("--content-cycle") + 1], "2607-08");
        assert.equal(c.args[c.args.indexOf("--cycle") + 1], "2606-07");
      }

      // clarice-novos-html-state NUNCA recebe --content-cycle (#4365).
      const htmlStateCalls = calls.filter((c) => c.script === "scripts/clarice-novos-html-state.ts");
      assert.equal(htmlStateCalls.length, 2);
      for (const c of htmlStateCalls) {
        assert.ok(!c.args.includes("--content-cycle"), `clarice-novos-html-state NUNCA deve receber --content-cycle: ${c.args.join(" ")}`);
        assert.equal(c.args[c.args.indexOf("--cycle") + 1], "2607-08"); // sempre o ciclo MENSAL, não o de envio
      }

      // --finalize com listId/campaignId vindos do resumo do --send-now.
      const finalizeCall = htmlStateCalls[1];
      assert.ok(finalizeCall.args.includes("--finalize"));
      assert.equal(finalizeCall.args[finalizeCall.args.indexOf("--list-id") + 1], "99");
      assert.equal(finalizeCall.args[finalizeCall.args.indexOf("--campaign-id") + 1], "555");
      assert.equal(finalizeCall.args[finalizeCall.args.indexOf("--sent-count") + 1], "42");

      // #5410/#5405: envio confirmado grava cutoff + status "sent" — próxima
      // leitura de ramp-warm/alarme enxerga a rodada como bem-sucedida.
      const cutoff = readNovosCutoff(resolve(root, "data", "clarice-subscribers"));
      assert.equal(cutoff?.cutoffIso, "2026-08-01");
      const status = readNovosRunStatus(resolve(root, "data", "clarice-subscribers"));
      assert.equal(status?.status, "sent");

      rmSync(root, { recursive: true, force: true });
    });

    it("sem divergência de ciclo (cicloEnvio === cicloMensal) -> NUNCA passa --content-cycle", async () => {
      root = freshRoot();
      const { exec, calls } = makeFakeExec(goldenHandlers({ cicloMensal: "2607-08" }));
      const deps = baseDeps(root, { exec, resolveEnvioCycle: () => "2607-08" });
      const result = await runNovos([], deps);
      assert.equal(result.code, 0, result.reportMarkdown);
      const scheduleCalls = calls.filter((c) => c.script === "scripts/clarice-schedule-group.ts");
      for (const c of scheduleCalls) assert.ok(!c.args.includes("--content-cycle"), c.args.join(" "));
      rmSync(root, { recursive: true, force: true });
    });

    it("D12: shouldSendTest=false -> pula --send-test (só 2 chamadas de schedule-group, não 3)", async () => {
      root = freshRoot();
      const { exec, calls } = makeFakeExec(goldenHandlers({ shouldSendTest: false }));
      const deps = baseDeps(root, { exec });
      const result = await runNovos([], deps);
      assert.equal(result.code, 0, result.reportMarkdown);
      const scheduleCalls = calls.filter((c) => c.script === "scripts/clarice-schedule-group.ts");
      assert.equal(scheduleCalls.length, 2); // create + send-now, sem send-test
      assert.ok(!scheduleCalls.some((c) => c.args.includes("--send-test")));
      rmSync(root, { recursive: true, force: true });
    });

    it("--since explícito é repassado ao stripe-delta", async () => {
      root = freshRoot();
      const { exec, calls } = makeFakeExec(goldenHandlers());
      const deps = baseDeps(root, { exec });
      await runNovos(["--since", "2026-07-15"], deps);
      const deltaCall = calls.find((c) => c.script === "scripts/clarice-stripe-delta.ts")!;
      assert.ok(deltaCall.args.includes("--since"));
      assert.equal(deltaCall.args[deltaCall.args.indexOf("--since") + 1], "2026-07-15");
      rmSync(root, { recursive: true, force: true });
    });

    it("--confirm é repassado ao verify-emails-mv, --force ao build-segment", async () => {
      root = freshRoot();
      const { exec, calls } = makeFakeExec(goldenHandlers());
      const deps = baseDeps(root, { exec });
      await runNovos(["--confirm", "--force"], deps);
      const mvCall = calls.find((c) => c.script === "scripts/verify-emails-mv.ts")!;
      assert.ok(mvCall.args.includes("--confirm"));
      const segmentCall = calls.find((c) => c.script === "scripts/clarice-build-segment.ts")!;
      assert.ok(segmentCall.args.includes("--force"));
      rmSync(root, { recursive: true, force: true });
    });

    it("sem --confirm/--force (o que a task agendada de fato roda) -> nenhuma das duas flags é passada", async () => {
      root = freshRoot();
      const { exec, calls } = makeFakeExec(goldenHandlers());
      const deps = baseDeps(root, { exec });
      await runNovos([], deps);
      const mvCall = calls.find((c) => c.script === "scripts/verify-emails-mv.ts")!;
      assert.ok(!mvCall.args.includes("--confirm"));
      const segmentCall = calls.find((c) => c.script === "scripts/clarice-build-segment.ts")!;
      assert.ok(!segmentCall.args.includes("--force"));
      rmSync(root, { recursive: true, force: true });
    });
  });

  // ── rodada vazia ───────────────────────────────────────────────────────

  describe("rodada vazia (selected=0)", () => {
    it("0 contatos -> exit 0, NENHUMA chamada além do build-segment (não importa/dispara nada)", async () => {
      root = freshRoot();
      const handlers = goldenHandlers();
      handlers["scripts/clarice-build-segment.ts"] = jsonResult({ selected: 0, hold: "juridico" });
      const { exec, calls } = makeFakeExec(handlers);
      const deps = baseDeps(root, { exec });
      const result = await runNovos([], deps);
      assert.equal(result.code, 0);
      assert.match(result.reportMarkdown, /0 contato/);
      const scripts = calls.map((c) => c.script);
      assert.ok(!scripts.includes("scripts/clarice-novos-resolve-key.ts"), "não deveria resolver key numa rodada vazia");
      assert.ok(!scripts.includes("scripts/clarice-import-waves.ts"));
      assert.ok(!scripts.includes("scripts/clarice-schedule-group.ts"));
      rmSync(root, { recursive: true, force: true });
    });
  });

  // ── dry-run ────────────────────────────────────────────────────────────

  describe("--dry-run", () => {
    it("para depois do Passo 3 — MV NUNCA chamado, nenhuma lista/campanha criada", async () => {
      root = freshRoot();
      const { exec, calls } = makeFakeExec(goldenHandlers());
      const deps = baseDeps(root, { exec });
      const result = await runNovos(["--dry-run"], deps);
      assert.equal(result.code, 0, result.reportMarkdown);
      const scripts = calls.map((c) => c.script);
      assert.ok(!scripts.includes("scripts/verify-emails-mv.ts"), "MV nunca deve rodar em --dry-run (custo real)");
      assert.ok(!scripts.includes("scripts/clarice-novos-resolve-key.ts"));
      assert.ok(!scripts.includes("scripts/clarice-import-waves.ts"));
      assert.ok(!scripts.includes("scripts/clarice-schedule-group.ts"));
      const segmentCall = calls.find((c) => c.script === "scripts/clarice-build-segment.ts")!;
      assert.ok(segmentCall.args.includes("--dry-run"));
      assert.ok(!calls.find((c) => c.script === "scripts/clarice-stripe-delta.ts")!.args.includes("--execute"));
      // #5410/#5405: --dry-run nunca é uma tentativa de produção — não deve
      // mexer no cutoff/status compartilhados que a rodada real lê.
      assert.equal(readNovosCutoff(resolve(root, "data", "clarice-subscribers")), null);
      assert.equal(readNovosRunStatus(resolve(root, "data", "clarice-subscribers")), null);
      rmSync(root, { recursive: true, force: true });
    });
  });

  // ── guards abortam ─────────────────────────────────────────────────────

  describe("guards abortam (exit 1, ou exit 3 pro semáforo — #5615/#5592), sem chamar passos de escrita subsequentes", () => {
    it("semáforo vermelho -> aborta antes de montar o grupo, com exit 3 (não 1 — #5615/#5592: abort D4 é comportamento CORRETO, distinto de erro genérico)", async () => {
      root = freshRoot();
      const handlers = goldenHandlers();
      handlers["scripts/clarice-check-semaphore.ts"] = jsonResult({ ok: false, semaphore: "red", reason: "breaker" }, 1);
      const { exec, calls } = makeFakeExec(handlers);
      const deps = baseDeps(root, { exec });
      const result = await runNovos([], deps);
      assert.equal(result.code, NOVOS_SEMAPHORE_ABORT_EXIT_CODE);
      assert.ok(!calls.some((c) => c.script === "scripts/clarice-build-segment.ts"));
      rmSync(root, { recursive: true, force: true });
    });

    it("#5410: cutoff (`since` do Passo 1) é persistido MESMO quando o semáforo aborta — é isto que impede ramp-warm de absorver a janela novos", async () => {
      root = freshRoot();
      const handlers = goldenHandlers();
      handlers["scripts/clarice-check-semaphore.ts"] = jsonResult({ ok: false, semaphore: "red", reason: "breaker" }, 1);
      const { exec } = makeFakeExec(handlers);
      const deps = baseDeps(root, { exec });
      const result = await runNovos([], deps);
      assert.equal(result.code, NOVOS_SEMAPHORE_ABORT_EXIT_CODE);
      const cutoff = readNovosCutoff(resolve(root, "data", "clarice-subscribers"));
      assert.ok(cutoff, "cutoff deveria ter sido persistido antes do semáforo abortar");
      assert.equal(cutoff!.cutoffIso, "2026-08-01"); // `since` devolvido por goldenHandlers().clarice-stripe-delta.ts
      rmSync(root, { recursive: true, force: true });
    });

    it("#5615/#5592: abort por QUALQUER OUTRO motivo (não-semáforo) continua saindo exit 1, não 3 — a distinção é específica do guard D4", async () => {
      root = freshRoot();
      const handlers = goldenHandlers();
      handlers["scripts/clarice-build-segment.ts"] = jsonResult({ error: "cap exceeded" }, 1);
      const { exec } = makeFakeExec(handlers);
      const deps = baseDeps(root, { exec });
      const result = await runNovos([], deps);
      assert.equal(result.code, 1);
      rmSync(root, { recursive: true, force: true });
    });

    it("#5405: status da rodada (last-novos-run-status.json) marca 'semaphore-red' quando o abort é especificamente do guard de semáforo", async () => {
      root = freshRoot();
      const handlers = goldenHandlers();
      handlers["scripts/clarice-check-semaphore.ts"] = jsonResult({ ok: false, semaphore: "red", reason: "breaker" }, 1);
      const { exec } = makeFakeExec(handlers);
      const deps = baseDeps(root, { exec });
      await runNovos([], deps);
      const status = readNovosRunStatus(resolve(root, "data", "clarice-subscribers"));
      assert.equal(status?.status, "semaphore-red");
      rmSync(root, { recursive: true, force: true });
    });

    it("#5405: status da rodada marca 'other-error' quando o abort NÃO é do guard de semáforo (ex: teto D13 do build-segment)", async () => {
      root = freshRoot();
      const handlers = goldenHandlers();
      handlers["scripts/clarice-build-segment.ts"] = jsonResult({ error: "cap exceeded" }, 1);
      const { exec } = makeFakeExec(handlers);
      const deps = baseDeps(root, { exec });
      await runNovos([], deps);
      const status = readNovosRunStatus(resolve(root, "data", "clarice-subscribers"));
      assert.equal(status?.status, "other-error");
      rmSync(root, { recursive: true, force: true });
    });

    it("teto D13 (build-segment exit 1) -> aborta, sem resolver key/import/campanha", async () => {
      root = freshRoot();
      const handlers = goldenHandlers();
      handlers["scripts/clarice-build-segment.ts"] = jsonResult({ error: "cap exceeded" }, 1);
      const { exec, calls } = makeFakeExec(handlers);
      const deps = baseDeps(root, { exec });
      const result = await runNovos([], deps);
      assert.equal(result.code, 1);
      assert.ok(!calls.some((c) => c.script === "scripts/clarice-novos-resolve-key.ts"));
      rmSync(root, { recursive: true, force: true });
    });

    it("--hold ausente/errado no resumo -> aborta por segurança (#4542), mesmo com exit 0 do sub-script", async () => {
      root = freshRoot();
      const handlers = goldenHandlers();
      handlers["scripts/clarice-build-segment.ts"] = jsonResult({ selected: 42, hold: undefined });
      const { exec, calls } = makeFakeExec(handlers);
      const deps = baseDeps(root, { exec });
      const result = await runNovos([], deps);
      assert.equal(result.code, 1);
      assert.match(result.reportMarkdown, /juridico/);
      assert.ok(!calls.some((c) => c.script === "scripts/clarice-novos-resolve-key.ts"));
      rmSync(root, { recursive: true, force: true });
    });

    it("guard de custo MV (verify-emails-mv exit 1) -> aborta, nunca chega no semáforo/build-segment", async () => {
      root = freshRoot();
      const handlers = goldenHandlers();
      handlers["scripts/verify-emails-mv.ts"] = jsonResult({ error: ">500 sem --confirm" }, 1);
      const { exec, calls } = makeFakeExec(handlers);
      const deps = baseDeps(root, { exec });
      const result = await runNovos([], deps);
      assert.equal(result.code, 1);
      assert.ok(!calls.some((c) => c.script === "scripts/clarice-check-semaphore.ts"));
      assert.ok(!calls.some((c) => c.script === "scripts/clarice-build-segment.ts"));
      rmSync(root, { recursive: true, force: true });
    });

    it("nenhum ciclo com atividade (resolveEnvioCycle -> undefined) -> aborta antes do MV", async () => {
      root = freshRoot();
      const { exec, calls } = makeFakeExec(goldenHandlers());
      const deps = baseDeps(root, { exec, resolveEnvioCycle: () => undefined });
      const result = await runNovos([], deps);
      assert.equal(result.code, 1);
      assert.match(result.reportMarkdown, /CICLO_ENVIO|nenhum ciclo/);
      assert.ok(!calls.some((c) => c.script === "scripts/verify-emails-mv.ts"));
      rmSync(root, { recursive: true, force: true });
    });
  });

  // ── send-now: incerto vs erro duro ──────────────────────────────────────

  describe("--send-now: incerto (exit 2) vs erro duro (exit 1)", () => {
    it("exit 2 (GET-verify não confirmou terminal) -> code=2, NUNCA chama --finalize", async () => {
      root = freshRoot();
      const handlers = goldenHandlers();
      handlers["scripts/clarice-schedule-group.ts"] = [
        jsonResult({ key: "novos-260810", listId: 99, campaignId: 555, phase: "create", status: "draft" }),
        jsonResult({ key: "novos-260810", listId: 99, campaignId: 555, phase: "send-test" }),
        jsonResult({ key: "novos-260810", listId: 99, campaignId: 555, phase: "send-now", status: "in_review" }, 2),
      ];
      const { exec, calls } = makeFakeExec(handlers);
      const deps = baseDeps(root, { exec });
      const result = await runNovos([], deps);
      assert.equal(result.code, 2);
      const finalizeCalls = calls.filter((c) => c.script === "scripts/clarice-novos-html-state.ts" && c.args.includes("--finalize"));
      assert.equal(finalizeCalls.length, 0, "exit 2 NUNCA deve chamar --finalize (não confirma como enviado)");
      assert.match(result.reportMarkdown, /INCERTO/);
      rmSync(root, { recursive: true, force: true });
    });

    it("exit 1 duro do --send-now -> code=1, sem --finalize", async () => {
      root = freshRoot();
      const handlers = goldenHandlers();
      handlers["scripts/clarice-schedule-group.ts"] = [
        jsonResult({ key: "novos-260810", listId: 99, campaignId: 555, phase: "create", status: "draft" }),
        jsonResult({ key: "novos-260810", listId: 99, campaignId: 555, phase: "send-test" }),
        textResult("erro fatal", 1),
      ];
      const { exec, calls } = makeFakeExec(handlers);
      const deps = baseDeps(root, { exec });
      const result = await runNovos([], deps);
      assert.equal(result.code, 1);
      assert.ok(!calls.some((c) => c.script === "scripts/clarice-novos-html-state.ts" && c.args.includes("--finalize")));
      rmSync(root, { recursive: true, force: true });
    });

    it("exit 0 mas status!=='sent' (#4949 achado 2) -> tratado como INCERTO (code=2), NUNCA chama --finalize", async () => {
      root = freshRoot();
      const handlers = goldenHandlers();
      handlers["scripts/clarice-schedule-group.ts"] = [
        jsonResult({ key: "novos-260810", listId: 99, campaignId: 555, phase: "create", status: "draft" }),
        jsonResult({ key: "novos-260810", listId: 99, campaignId: 555, phase: "send-test" }),
        // exit 0 (POST aceito) mas status ainda "queued" — checkSendNowGuard
        // pode devolver isso sem re-disparar quando a campanha já está queued.
        jsonResult({ key: "novos-260810", listId: 99, campaignId: 555, phase: "send-now", status: "queued" }, 0),
      ];
      const { exec, calls } = makeFakeExec(handlers);
      const deps = baseDeps(root, { exec });
      const result = await runNovos([], deps);
      assert.equal(result.code, 2);
      assert.ok(!calls.some((c) => c.script === "scripts/clarice-novos-html-state.ts" && c.args.includes("--finalize")));
      assert.match(result.reportMarkdown, /INCERTO/);
      rmSync(root, { recursive: true, force: true });
    });
  });

  describe("--finalize falha após --send-now confirmado (#4949 achado 2)", () => {
    it("--finalize lança -> resultado continua SUCESSO (code=0), não vira 'abortado' por cima de um envio real", async () => {
      root = freshRoot();
      const handlers = goldenHandlers();
      // 1ª chamada de clarice-novos-html-state.ts (checagem shouldSendTest) ok;
      // 2ª chamada (--finalize) falha com exit != 0.
      handlers["scripts/clarice-novos-html-state.ts"] = [
        jsonResult({ htmlSha256: "abc", shouldSendTest: true, previousState: null }),
        textResult("disco cheio", 1),
      ];
      const { exec, calls } = makeFakeExec(handlers);
      const deps = baseDeps(root, { exec });
      const result = await runNovos([], deps);
      assert.equal(result.code, 0, result.reportMarkdown);
      assert.equal(result.reportId, "novos-260810", "reportId continua sendo a key da campanha, não 'abort'");
      assert.match(result.reportMarkdown, /disparo confirmado/);
      assert.match(result.reportMarkdown, /--finalize falhou/);
      const finalizeCalls = calls.filter((c) => c.script === "scripts/clarice-novos-html-state.ts" && c.args.includes("--finalize"));
      assert.equal(finalizeCalls.length, 1, "--finalize DEVE ser tentado, só a falha dele não derruba o resultado");
      rmSync(root, { recursive: true, force: true });
    });
  });

  describe("Passo 0: store derivado stale (#4949 achado 3, agente de test-coverage)", () => {
    it("clarice-check-derived-stale devolve 'stale' -> roda clarice-build-db extra ANTES do delta Stripe", async () => {
      root = freshRoot();
      const handlers = goldenHandlers();
      handlers["scripts/clarice-check-derived-stale.ts"] = textResult("stale");
      const { exec, calls } = makeFakeExec(handlers);
      const deps = baseDeps(root, { exec });
      const result = await runNovos([], deps);
      assert.equal(result.code, 0, result.reportMarkdown);
      const scripts = calls.map((c) => c.script);
      // stale -> check-derived-stale, build-db(pré-stale), stripe-delta, build-db(pós-delta), ...
      assert.deepEqual(scripts.slice(0, 4), [
        "scripts/clarice-check-derived-stale.ts",
        "scripts/clarice-build-db.ts",
        "scripts/clarice-stripe-delta.ts",
        "scripts/clarice-build-db.ts",
      ]);
      assert.match(result.reportMarkdown, /stale/);
      rmSync(root, { recursive: true, force: true });
    });
  });

  describe("--label carrega a key resolvida, não só a data (#4949 achado 1, idempotência de retry no mesmo dia)", () => {
    it("clarice-import-waves recebe --label com a key embutida", async () => {
      root = freshRoot();
      const { exec, calls } = makeFakeExec(goldenHandlers());
      const deps = baseDeps(root, { exec });
      await runNovos([], deps);
      const importCall = calls.find((c) => c.script === "scripts/clarice-import-waves.ts")!;
      const label = importCall.args[importCall.args.indexOf("--label") + 1];
      assert.match(label, /novos-260810/, `--label deveria carregar a key resolvida, veio: "${label}"`);
    });
  });

  // ── relatório sempre gravado ─────────────────────────────────────────────

  it("todo caminho (sucesso, vazio, pausado, abort) grava relatório em disco e registra em data/reports/index.jsonl", async () => {
    root = freshRoot();
    const { exec } = makeFakeExec(goldenHandlers());
    const deps = baseDeps(root, { exec });
    const result = await runNovos([], deps);
    assert.equal(result.code, 0);
    const reportPath = resolve(root, "data", "clarice-subscribers", "novos-reports", `${result.reportId}.md`);
    assert.ok(existsSync(reportPath));
    const indexPath = resolve(root, "data", "reports", "index.jsonl");
    assert.ok(existsSync(indexPath));
    const lines = readFileSync(indexPath, "utf8").trim().split("\n");
    // entry.id = `${kind}-${sessionId}` (reportId() em studio-reports.ts) — reportId aqui É o sessionId passado.
    assert.ok(lines.some((l) => JSON.parse(l).id === `clarice-novos-${result.reportId}`));
    rmSync(root, { recursive: true, force: true });
  });

  it("NovosAbort sempre carrega code=1 (o código 2 nunca passa por exceção, ver #4949)", () => {
    const e = new NovosAbort("x");
    assert.equal(e.code, 1);
  });
});
