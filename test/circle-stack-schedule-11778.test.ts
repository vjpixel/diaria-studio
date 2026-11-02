/**
 * #11778 — envio agendado do post semanal da Stack (segunda 06:00 BRT) com
 * aprovação por ciclo e e-mail do resultado em todos os casos.
 *
 * Cobre: os quatro desfechos (Publicado, Ambíguo, Falhou, Não enviado), o
 * publicador chamado UMA vez e nunca com --force, a trava de aprovação (sem
 * registro, outro ciclo, seleção editada depois), a janela (catch-up fora da
 * segunda), e a classe de erro das travas do publicador.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCircleStackApproval,
  buildCircleStackOutcomeEmail,
  checkCircleStackApproval,
  circleStackScheduledExitCode,
  classifyCircleStackRun,
  isCircleStackPublishWindow,
  sha256Hex,
  type CircleStackScheduledOutcome,
} from "../scripts/lib/circle-stack-schedule.ts";
import {
  approveCircleStackCycle,
  resolveCyclePaths,
  runScheduledCircleStack,
  runScheduledCircleStackPublish,
} from "../scripts/publish-circle-stack-scheduled.ts";
import {
  acquireCircleStackPublishLock,
  CircleStackPublishRefusal,
  publishCircleStackCycle,
} from "../scripts/publish-circle-stack.ts";
import { buildStackPostPayload } from "../scripts/lib/stack-webhook.ts";
import { resolveWeeklyLinkedinCycle } from "../scripts/lib/weekly-linkedin-cycle.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";
import type { PushMessage } from "../scripts/lib/push-notify.ts";

const MONDAY = "261109";
const CYCLE = resolveWeeklyLinkedinCycle(MONDAY)!.cycle;
// Segunda 09/11/2026 06:00 BRT, em horário local da máquina de teste.
const mondayAt6 = () => new Date(2026, 10, 9, 6, 0, 0);
const tuesdayAt6 = () => new Date(2026, 10, 10, 6, 0, 0);
// Carimbo que o publicador simulado grava: segundos depois do início da run.
const DURING_RUN = new Date(2026, 10, 9, 6, 0, 5).toISOString();

function selectionJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      cycle: CYCLE,
      contentWindow: [],
      weeklyEditions: [],
      destaques: [],
      lancamentos: [],
      useMelhor: [],
      radar: [
        {
          editionDate: "261103",
          url: "https://exemplo.com.br/noticia",
          title: "Novo modelo chega para todos os usuários",
          body: "corpo",
          why: "porque",
        },
      ],
      ...extra,
    },
    null,
    2,
  );
}

function setup(opts: { approve?: boolean; selection?: string } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), "circle-stack-sched-"));
  const paths = resolveCyclePaths(dataRoot, MONDAY);
  mkdirSync(join(paths.selectionPath, ".."), { recursive: true });
  const sel = opts.selection ?? selectionJson();
  writeFileSync(paths.selectionPath, sel);
  if (opts.approve) {
    writeFileSync(paths.approvalPath, JSON.stringify(buildCircleStackApproval(CYCLE, sel, new Date())));
  }
  return { dataRoot, paths };
}

function harness(publish: (argv: string[], statePath: string) => Promise<void>, emailOk = true) {
  const calls: string[][] = [];
  const emails: PushMessage[] = [];
  return {
    calls,
    emails,
    deps: (statePath: string) => ({
      rootDir: "/repo",
      platformConfig: {},
      env: {},
      now: mondayAt6,
      runPublish: async (argv: string[]) => {
        calls.push(argv);
        await publish(argv, statePath);
      },
      sendEmail: async (m: PushMessage) => {
        emails.push(m);
        return emailOk ? { ok: true } : { ok: false, error: "gmail fora" };
      },
    }),
  };
}

const writeState = (statePath: string, state: Record<string, unknown>) => writeFileSync(statePath, JSON.stringify(state));

describe("checkCircleStackApproval (#11778)", () => {
  const sel = selectionJson();
  const ok = JSON.stringify(buildCircleStackApproval(CYCLE, sel, new Date("2026-11-07T15:00:00Z")));

  it("aprovação do ciclo com o hash da seleção atual libera", () => {
    assert.deepEqual(checkCircleStackApproval(ok, sel, CYCLE), { ok: true, approvedAt: "2026-11-07T15:00:00.000Z" });
  });
  it("sem registro recusa", () => {
    const r = checkCircleStackApproval(null, sel, CYCLE);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /sem registro de aprovação/);
  });
  it("seleção editada depois da aprovação recusa", () => {
    const r = checkCircleStackApproval(ok, selectionJson({ opening: "texto novo" }), CYCLE);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /mudou depois da aprovação/);
  });
  it("aprovação de outro ciclo, JSON ilegível ou seleção ausente recusam", () => {
    const other = JSON.stringify({ ...JSON.parse(ok), cycle: "26w01" });
    assert.equal(checkCircleStackApproval(other, sel, CYCLE).ok, false);
    assert.equal(checkCircleStackApproval("{", sel, CYCLE).ok, false);
    assert.equal(checkCircleStackApproval(ok, null, CYCLE).ok, false);
  });
  it("hash é do conteúdo exato", () => {
    assert.equal(JSON.parse(ok).selection_sha256, sha256Hex(sel));
  });
});

describe("classifyCircleStackRun — os quatro desfechos (#11778)", () => {
  const runStartedAt = new Date("2026-11-09T09:00:00.000Z");
  const attempt = "2026-11-09T09:00:01.000Z";

  it("published_at desta execução → publicado", () => {
    const o = classifyCircleStackRun({
      cycle: CYCLE, runStartedAt,
      stateAfter: { cycle: CYCLE, attempted_at: attempt, published_at: "2026-11-09T09:00:02.000Z" },
    });
    assert.deepEqual(o, { kind: "publicado", publishedAt: "2026-11-09T09:00:02.000Z" });
  });
  it("attempted_at desta execução sem published_at → ambíguo, com o erro", () => {
    const o = classifyCircleStackRun({
      cycle: CYCLE, runStartedAt, stateAfter: { cycle: CYCLE, attempted_at: attempt }, error: new Error("timeout 30s"),
    });
    assert.deepEqual(o, { kind: "ambiguo", attemptedAt: attempt, error: "timeout 30s" });
  });
  it("erro sem tentativa gravada → falhou, com o erro literal", () => {
    const o = classifyCircleStackRun({ cycle: CYCLE, runStartedAt, stateAfter: null, error: new Error("STACK_WEBHOOK_URL ausente") });
    assert.deepEqual(o, { kind: "falhou", error: "STACK_WEBHOOK_URL ausente" });
  });
  it("trava do publicador → não enviado, mesmo com tentativa antiga no disco", () => {
    const o = classifyCircleStackRun({
      cycle: CYCLE, runStartedAt,
      stateAfter: { cycle: CYCLE, attempted_at: "2026-11-02T09:00:00.000Z" },
      error: new CircleStackPublishRefusal("State de publicação do ciclo existe mas não confirma"),
      errorIsRefusal: true,
    });
    assert.equal(o.kind, "nao-enviado");
  });
  it("tentativa de execução ANTERIOR não vira ambíguo desta run", () => {
    const o = classifyCircleStackRun({
      cycle: CYCLE, runStartedAt, stateAfter: { cycle: CYCLE, attempted_at: "2026-11-02T09:00:00.000Z" }, error: new Error("x"),
    });
    assert.equal(o.kind, "falhou");
  });
  it("sem erro e sem state nunca vira publicado", () => {
    assert.equal(classifyCircleStackRun({ cycle: CYCLE, runStartedAt, stateAfter: null }).kind, "falhou");
  });
});

describe("buildCircleStackOutcomeEmail — assunto com o resultado, corpo com o que fazer (#11778)", () => {
  const ctx = { cycle: CYCLE, publishMonday: MONDAY, statePath: `data/weekly/${CYCLE}/_internal/circle-stack-published.json` };
  const cases: [CircleStackScheduledOutcome, RegExp, RegExp][] = [
    [{ kind: "publicado", publishedAt: "2026-11-09T09:00:02Z" }, /: Publicado$/, /Nada a fazer/],
    [{ kind: "ambiguo", attemptedAt: "2026-11-09T09:00:01Z", error: "timeout" }, /: Ambíguo$/, /PODE ter saído[\s\S]*--force/],
    [{ kind: "falhou", error: "HTTP 500 do webhook" }, /: Falhou$/, /Nada foi enviado[\s\S]*HTTP 500 do webhook/],
    [{ kind: "nao-enviado", reason: "ciclo sem registro de aprovação do editor" }, /: Não enviado$/, /sem registro de aprovação/],
  ];
  for (const [outcome, subj, body] of cases) {
    it(outcome.kind, () => {
      const e = buildCircleStackOutcomeEmail(outcome, ctx);
      assert.match(e.subject, subj);
      assert.ok(e.subject.includes(CYCLE));
      assert.match(e.body, body);
    });
  }
  it("exit code: 0 para publicado/não enviado, 1 para ambíguo/falhou", () => {
    assert.equal(circleStackScheduledExitCode(cases[0][0]), 0);
    assert.equal(circleStackScheduledExitCode(cases[1][0]), 1);
    assert.equal(circleStackScheduledExitCode(cases[2][0]), 1);
    assert.equal(circleStackScheduledExitCode(cases[3][0]), 0);
  });
  it("janela só na própria segunda", () => {
    assert.equal(isCircleStackPublishWindow("261109", "261109"), true);
    assert.equal(isCircleStackPublishWindow("261110", "261109"), false);
  });
});

describe("runScheduledCircleStackPublish — execução da task (#11778)", () => {
  it("ciclo aprovado: envia UMA vez, sem --force, e manda o e-mail Publicado", async () => {
    const { paths } = setup({ approve: true });
    const h = harness(async (_argv, statePath) => {
      writeState(statePath, { cycle: CYCLE, attempted_at: DURING_RUN });
      writeState(statePath, { cycle: CYCLE, attempted_at: DURING_RUN, published_at: DURING_RUN });
    });
    const res = await runScheduledCircleStackPublish(paths, h.deps(paths.statePath));
    assert.equal(res.outcome.kind, "publicado");
    assert.equal(h.calls.length, 1);
    assert.ok(h.calls[0].includes("--publish"));
    assert.ok(!h.calls[0].includes("--force"));
    assert.equal(h.emails.length, 1);
    assert.match(h.emails[0].subject, /Publicado/);
    assert.equal(res.exitCode, 0);
  });

  it("ciclo sem aprovação: não chama o publicador e manda o e-mail Não enviado", async () => {
    const { paths } = setup();
    const h = harness(async () => assert.fail("não pode enviar sem aprovação"));
    const res = await runScheduledCircleStackPublish(paths, h.deps(paths.statePath));
    assert.equal(res.outcome.kind, "nao-enviado");
    assert.equal(h.calls.length, 0);
    assert.match(h.emails[0].subject, /Não enviado/);
    assert.match(h.emails[0].body, /sem registro de aprovação/);
    assert.equal(res.exitCode, 0);
  });

  it("seleção editada depois da aprovação: não envia", async () => {
    const { paths } = setup({ approve: true });
    writeFileSync(paths.selectionPath, selectionJson({ opening: "editado depois" }));
    const h = harness(async () => assert.fail("seleção mudou"));
    const res = await runScheduledCircleStackPublish(paths, h.deps(paths.statePath));
    assert.equal(res.outcome.kind, "nao-enviado");
    assert.equal(h.calls.length, 0);
  });

  it("catch-up numa terça: não envia, mesmo aprovado", async () => {
    const { paths } = setup({ approve: true });
    const h = harness(async () => assert.fail("fora da janela"));
    const res = await runScheduledCircleStackPublish(paths, { ...h.deps(paths.statePath), now: tuesdayAt6 });
    assert.equal(res.outcome.kind, "nao-enviado");
    assert.match((res.outcome as { reason: string }).reason, /fora da segunda/);
    assert.equal(h.calls.length, 0);
  });

  it("falha depois da tentativa gravada: Ambíguo, e NÃO repete o envio", async () => {
    const { paths } = setup({ approve: true });
    const h = harness(async (_argv, statePath) => {
      writeState(statePath, { cycle: CYCLE, attempted_at: DURING_RUN });
      throw new Error("Webhook da Stack não respondeu em 30s");
    });
    const res = await runScheduledCircleStackPublish(paths, h.deps(paths.statePath));
    assert.equal(res.outcome.kind, "ambiguo");
    assert.equal(h.calls.length, 1, "uma chamada só: a falha pode ter publicado");
    assert.match(h.emails[0].subject, /Ambíguo/);
    assert.match(h.emails[0].body, /não respondeu em 30s/);
    assert.equal(res.exitCode, 1);
  });

  it("falha antes de qualquer envio: Falhou, com o erro literal", async () => {
    const { paths } = setup({ approve: true });
    const h = harness(async () => {
      throw new Error("STACK_WEBHOOK_KEY ausente no ambiente");
    });
    const res = await runScheduledCircleStackPublish(paths, h.deps(paths.statePath));
    assert.equal(res.outcome.kind, "falhou");
    assert.equal(h.calls.length, 1);
    assert.match(h.emails[0].body, /STACK_WEBHOOK_KEY ausente no ambiente/);
  });

  it("trava do publicador (CircleStackPublishRefusal): Não enviado, com o motivo", async () => {
    const { paths } = setup({ approve: true });
    const h = harness(async () => {
      throw new CircleStackPublishRefusal("Ciclo já publicado na Stack");
    });
    const res = await runScheduledCircleStackPublish(paths, h.deps(paths.statePath));
    assert.equal(res.outcome.kind, "nao-enviado");
    assert.match(h.emails[0].body, /já publicado/);
  });

  it("e-mail que não sai vira exit 1, mesmo com o post publicado", async () => {
    const { paths } = setup({ approve: true });
    const h = harness(async (_argv, statePath) => {
      writeState(statePath, { cycle: CYCLE, attempted_at: DURING_RUN, published_at: DURING_RUN });
    }, false);
    const res = await runScheduledCircleStackPublish(paths, h.deps(paths.statePath));
    assert.equal(res.outcome.kind, "publicado");
    assert.equal(res.emailOk, false);
    assert.equal(res.exitCode, 1);
  });
});

describe("--approve / --revoke (#11778)", () => {
  it("--approve grava o hash da seleção atual e o envio passa a sair", async () => {
    const { dataRoot, paths } = setup();
    const code = await runScheduledCircleStack(["--approve", "--publish-monday", MONDAY, "--data-root", dataRoot], {
      rootDir: dataRoot, platformConfig: {}, env: {}, now: mondayAt6,
    });
    assert.equal(code, 0);
    const approval = JSON.parse(readFileSync(paths.approvalPath, "utf8"));
    assert.equal(approval.cycle, CYCLE);
    assert.equal(approval.selection_sha256, sha256Hex(readFileSync(paths.selectionPath, "utf8")));
    assert.equal(checkCircleStackApproval(readFileSync(paths.approvalPath, "utf8"), readFileSync(paths.selectionPath, "utf8"), CYCLE).ok, true);
  });

  it("--approve recusa seleção com link fora das regras do canal", () => {
    const bad = selectionJson({
      lancamentos: [{ editionDate: "261103", url: "https://www.theverge.com/x", title: "Lançamento novo da empresa", body: "b", why: "w" }],
    });
    const { paths } = setup({ selection: bad });
    assert.throws(() => approveCircleStackCycle(paths, new Date()), /não pode ser aprovada/);
    assert.equal(existsSync(paths.approvalPath), false);
  });

  it("--approve recusa ciclo já publicado", () => {
    const { paths } = setup();
    writeState(paths.statePath, { cycle: CYCLE, attempted_at: "2026-11-09T09:00:00Z", published_at: "2026-11-09T09:00:01Z" });
    assert.throws(() => approveCircleStackCycle(paths, new Date()), /já publicado/);
  });

  it("--revoke apaga a aprovação", async () => {
    const { dataRoot, paths } = setup({ approve: true });
    await runScheduledCircleStack(["--revoke", "--publish-monday", MONDAY, "--data-root", dataRoot], {
      rootDir: dataRoot, platformConfig: {}, env: {}, now: mondayAt6,
    });
    assert.equal(existsSync(paths.approvalPath), false);
  });
});

describe("travas do publicador lançam CircleStackPublishRefusal (#11778)", () => {
  const payload = buildStackPostPayload("Radar Stack", "corpo");

  it("ciclo já publicado", async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "circle-stack-ref-")), "circle-stack-published.json");
    writeState(statePath, { cycle: "26w45", attempted_at: "2026-11-09T09:00:00Z", published_at: "2026-11-09T09:00:01Z" });
    await assert.rejects(
      publishCircleStackCycle({ statePath, cycle: "26w45", title: "t", payload, force: false, send: async () => assert.fail("enviou") }),
      (err: unknown) => err instanceof CircleStackPublishRefusal,
    );
  });

  it("lock de outro --publish", () => {
    const lockPath = join(mkdtempSync(join(tmpdir(), "circle-stack-lock-")), "x.lock");
    const release = acquireCircleStackPublishLock(lockPath);
    try {
      assert.throws(() => acquireCircleStackPublishLock(lockPath), (err: unknown) => err instanceof CircleStackPublishRefusal);
    } finally {
      release();
    }
  });
});

describe("tasks agendadas da Stack (#11778)", () => {
  it("envio: segunda 06:00 BRT, script agendado, sem --force", () => {
    const t = getScheduledTaskByName("Diaria-Circle-Stack-Weekly-Publish");
    assert.ok(t);
    assert.deepEqual(t.schedule, { kind: "weekly", dayOfWeek: "Monday", hour: 6, minute: 0 });
    assert.equal(t.steps[0].script, "scripts/publish-circle-stack-scheduled.ts");
    const args = t.steps.flatMap((s) => s.args ?? []);
    assert.ok(!args.includes("--force"));
  });

  it("prévia anda para antes do envio: sábado, mirando a próxima segunda", () => {
    const t = getScheduledTaskByName("Diaria-Circle-Stack-Weekly-Preview");
    assert.ok(t);
    assert.equal(t.schedule.kind, "weekly");
    assert.equal((t.schedule as { dayOfWeek: string }).dayOfWeek, "Saturday");
    assert.ok(t.steps[0].args?.includes("--next-monday"));
  });
});
