/**
 * test/backlog-reconcile-cli.test.ts (#6198)
 *
 * Cobre a camada de I/O de `scripts/backlog-reconcile.ts` — `fetchOpenBacklog`,
 * `evaluateBacklog` (com resolução de mãe pro padrão 3) e `applyFix`
 * (que delega em `routeIssue`, nunca `gh issue edit` direto). Tudo contra um
 * `GhRunFn` fake em memória — mesmo padrão de `test/wait-until-sync.test.ts`.
 *
 * O caso central é a IDEMPOTÊNCIA de ponta-a-ponta exigida pela #6198:
 * aplicar a correção uma vez, reavaliar o backlog já convergido, e não
 * achar nada de novo — sem isso o "no-op contra backlog já convergido"
 * citado no "Pronto quando" da issue não estaria coberto.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";
import { fetchOpenBacklog, evaluateBacklog, applyFix, type GhRunFn } from "../scripts/backlog-reconcile.ts";
import { splitFindingsByAction, type MarkerDeferralConflictFix } from "../scripts/lib/backlog-reconcile.ts";

interface FakeIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: string[];
  body: string;
  comments: string[];
}

/** Fake `GhRunFn` completo o bastante pra servir `fetchOpenBacklog`
 * (`gh issue list`), `fetchIssueMinimal`/`routeIssue.fetchIssueState`
 * (`gh issue view --json labels,body,state,comments` e variantes),
 * `gh issue edit` (labels e `--body`, usado por `wait-until-sync.ts`) e
 * `gh issue comment` — tudo em memória, chaveado por número da issue. */
function makeFakeGh(seed: readonly FakeIssue[]): { run: GhRunFn; store: Map<number, FakeIssue> } {
  const store = new Map<number, FakeIssue>(seed.map((i) => [i.number, structuredClone(i)]));

  const run: GhRunFn = (args): GhSpawnResult => {
    if (args[0] === "issue" && args[1] === "list") {
      const list = [...store.values()]
        .filter((i) => i.state === "OPEN")
        .map((i) => ({
          number: i.number,
          title: i.title,
          url: i.url,
          state: i.state,
          body: i.body,
          labels: i.labels.map((name) => ({ name })),
        }));
      return { status: 0, stdout: JSON.stringify(list), stderr: "" };
    }

    if (args[0] === "issue" && args[1] === "view") {
      const num = Number(args[2]);
      const i = store.get(num);
      if (!i) return { status: 1, stdout: "", stderr: `issue #${num} não encontrada` };

      // wait-until-sync.ts: gh issue view N --json body -q .body
      const jsonIdx = args.indexOf("--json");
      const fields = jsonIdx !== -1 ? args[jsonIdx + 1] : "";
      if (fields === "body" && args.includes("-q")) {
        return { status: 0, stdout: `${i.body}\n`, stderr: "" };
      }

      // route-issue.ts fetchIssueState / backlog-reconcile.ts fetchIssueMinimal:
      // sempre devolve o superset — campos extras não pedidos são inofensivos
      // num mock (JSON.parse do caller só lê o que precisa).
      return {
        status: 0,
        stdout: JSON.stringify({
          number: i.number,
          state: i.state,
          labels: i.labels.map((name) => ({ name })),
          body: i.body,
          comments: i.comments.map((body) => ({ body })),
        }),
        stderr: "",
      };
    }

    if (args[0] === "issue" && args[1] === "edit") {
      const num = Number(args[2]);
      const i = store.get(num);
      if (!i) return { status: 1, stdout: "", stderr: `issue #${num} não encontrada` };

      const addIdx = args.indexOf("--add-label");
      if (addIdx !== -1) {
        const toAdd = args[addIdx + 1].split(",");
        i.labels = [...new Set([...i.labels, ...toAdd])];
      }
      const removeIdx = args.indexOf("--remove-label");
      if (removeIdx !== -1) {
        const toRemove = new Set(args[removeIdx + 1].split(","));
        i.labels = i.labels.filter((l) => !toRemove.has(l));
      }
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx !== -1) {
        i.body = args[bodyIdx + 1];
      }
      return { status: 0, stdout: "", stderr: "" };
    }

    if (args[0] === "issue" && args[1] === "comment") {
      const num = Number(args[2]);
      const i = store.get(num);
      if (!i) return { status: 1, stdout: "", stderr: `issue #${num} não encontrada` };
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx !== -1) i.comments.push(args[bodyIdx + 1]);
      return { status: 0, stdout: "", stderr: "" };
    }

    return { status: 1, stdout: "", stderr: `comando não coberto pelo fake: ${args.join(" ")}` };
  };

  return { run, store };
}

const NOW = new Date("2026-08-26T12:00:00Z");

describe("fetchOpenBacklog", () => {
  it("lê labels/body/state de todas as issues abertas via gh issue list", () => {
    const { run } = makeFakeGh([
      { number: 1, title: "a", url: "u1", state: "OPEN", labels: ["enhancement"], body: "corpo a", comments: [] },
      { number: 2, title: "b", url: "u2", state: "CLOSED", labels: [], body: "corpo b", comments: [] },
    ]);
    const issues = fetchOpenBacklog("/repo", 300, run);
    assert.ok(issues);
    // `gh issue list --state open` já filtra fechadas — o fake reflete isso.
    assert.equal(issues.length, 1);
    assert.equal(issues[0].number, 1);
  });

  it("gh falhando devolve null, nunca [] silencioso", () => {
    const failingRun: GhRunFn = () => ({ status: 1, stdout: "", stderr: "not authenticated" });
    assert.equal(fetchOpenBacklog("/repo", 300, failingRun), null);
  });
});

describe("evaluateBacklog — fim-a-fim com resolução de mãe (padrão 3)", () => {
  it("resolve a mãe sob demanda e reporta o alarme de herança", () => {
    const { run } = makeFakeGh([
      {
        number: 6187,
        title: "feat(#463): cache HÍBRIDO permanente",
        url: "u",
        state: "OPEN",
        labels: ["enhancement", "P2", "diaria", "kit-migration"],
        body: "Fatia de **#463** — ver a tabela de decomposição.",
        comments: [],
      },
      {
        number: 463,
        title: "migrar a camada de leitura da Beehiiv para Kit",
        url: "u",
        state: "OPEN",
        labels: ["enhancement", "P2", "diaria", "epic-guarda-chuva", "kit-migration"],
        body: "épica guarda-chuva",
        comments: [],
      },
    ]);
    const issues = fetchOpenBacklog("/repo", 300, run);
    assert.ok(issues);
    const findings = evaluateBacklog(issues, NOW, "/repo", run);
    const { alarms } = splitFindingsByAction(findings);
    const inherited = alarms.find((a) => a.patternId === "inherited-block-label");
    assert.ok(inherited);
    if (inherited.patternId !== "inherited-block-label") return;
    assert.equal(inherited.issue, 6187);
    assert.equal(inherited.parentNumber, 463);
  });
});

describe("applyFix — aplica via routeIssue (nunca gh issue edit direto) e é idempotente", () => {
  it("#5734: remove not-this-week, mantém o marcador, valida track=agendada pós-escrita", () => {
    const { run, store } = makeFakeGh([
      {
        number: 5734,
        title: "Reconciliar conversão reportada por painel",
        url: "u",
        state: "OPEN",
        labels: ["enhancement", "P2", "growth", "not-this-week"],
        body: "Depende do D0.\n\n<!-- aguardando-ate: 2026-08-28 -->",
        comments: [],
      },
    ]);

    const fix: MarkerDeferralConflictFix = {
      action: "fix",
      patternId: "marker-deferral-conflict",
      issue: 5734,
      title: "x",
      url: "u",
      conflictingLabels: ["not-this-week"],
      markerDate: "2026-08-28",
      routeTrack: "agendada",
    };

    const result = applyFix(fix, "/repo", run, NOW);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.validated, true);
    assert.equal(result.resolvedTrack, "agendada");

    const after = store.get(5734)!;
    assert.ok(!after.labels.includes("not-this-week"));
    assert.match(after.body, /aguardando-ate: 2026-08-28/);

    // Idempotência: reavaliar o backlog já convergido não acha mais nada.
    const issues = fetchOpenBacklog("/repo", 300, run)!;
    const findings = evaluateBacklog(issues, NOW, "/repo", run);
    const { fixes } = splitFindingsByAction(findings);
    assert.equal(fixes.filter((f) => f.issue === 5734).length, 0);
  });

  it("marcador EXPIRADO + on-hold: applyFix roteia pra overnight, e a correção sobrevive a uma 2ª rodada sem re-escrever nada", () => {
    const { run, store } = makeFakeGh([
      {
        number: 90001,
        title: "fixture expirada",
        url: "u",
        state: "OPEN",
        labels: ["on-hold"],
        body: "<!-- aguardando-ate: 2026-08-01 -->",
        comments: [],
      },
    ]);

    const fix: MarkerDeferralConflictFix = {
      action: "fix",
      patternId: "marker-deferral-conflict",
      issue: 90001,
      title: "x",
      url: "u",
      conflictingLabels: ["on-hold"],
      markerDate: "2026-08-01",
      routeTrack: "overnight",
    };

    const result = applyFix(fix, "/repo", run, NOW);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.resolvedTrack, "overnight");
    assert.ok(!store.get(90001)!.labels.includes("on-hold"));
    // routeIssue --track overnight remove o marcador também (só `agendada`
    // grava um marcador) — comportamento herdado de route-issue.ts, correto
    // aqui: o marcador expirado não tem mais função depois da correção.
    assert.ok(!/aguardando-ate:/.test(store.get(90001)!.body));

    // 2ª rodada: nada a corrigir de novo.
    const issues = fetchOpenBacklog("/repo", 300, run)!;
    const findings = evaluateBacklog(issues, NOW, "/repo", run);
    assert.equal(findings.length, 0);
  });

  it("rodar applyFix 2× seguidas com o MESMO fix é no-op na 2ª (comentário deduplicado, sem 2º gh issue edit de labels)", () => {
    const { run, store } = makeFakeGh([
      {
        number: 5239,
        title: "Kill switch por custo",
        url: "u",
        state: "OPEN",
        labels: ["enhancement", "P3", "not-this-week"],
        body: "<!-- aguardando-ate: 2026-09-08 -->",
        comments: [],
      },
    ]);
    const fix: MarkerDeferralConflictFix = {
      action: "fix",
      patternId: "marker-deferral-conflict",
      issue: 5239,
      title: "x",
      url: "u",
      conflictingLabels: ["not-this-week"],
      markerDate: "2026-09-08",
      routeTrack: "agendada",
    };

    const first = applyFix(fix, "/repo", run, NOW);
    assert.equal(first.ok, true, first.error);
    assert.equal(first.commentAction, "posted");

    const second = applyFix(fix, "/repo", run, NOW);
    assert.equal(second.ok, true, second.error);
    assert.equal(second.commentAction, "deduped"); // mesmo comentário, não duplica
    assert.equal(store.get(5239)!.comments.length, 1);
  });
});
