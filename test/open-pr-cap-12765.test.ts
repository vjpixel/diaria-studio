import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  combineContinuoCaps,
  computeOpenPrSlots,
  isDependencyBotPr,
  OPEN_PR_CAP,
  resolveWaveOpenPrSlots,
  waveOpenPrCapError,
} from "../scripts/lib/open-pr-cap.ts";
import { FAKE_GH_SKIP_WIN32, fakeGhEnv, withoutGhCredentials, writeFakeGh } from "./_helpers/fake-gh.ts";
import { OPEN_PR_LIST_LIMIT, readOpenPrCap } from "../scripts/check-open-pr-cap.ts";
import {
  closingComment,
  escalationDestination,
  ESCALATION_EXPIRY_MS,
  fetchAllPages,
  isRedundant,
  originIssue,
  overdueEscalation,
  runEscalationQueue,
  type DestinationInput,
  type OpenEscalatedPr,
  type QueueDeps,
} from "../scripts/list-continuo-escalation-queue.ts";

const pr = (number: number, headRefName: string, login = "vjpixel") => ({ number, headRefName, author: { login } });
const fakeGh = (status: number, stdout: string) =>
  (() => ({ status, stdout, stderr: status ? "boom" : "" })) as unknown as typeof spawnSync;

describe("teto global de PRs abertos (#12765)", () => {
  it("conta drafts e resgates, ignora bot de dependência", () => {
    const r = computeOpenPrSlots([
      pr(1, "overnight/fix-1-x"),
      pr(2, "continuo/rescue-2026"),
      pr(3, "dependabot/npm_and_yarn/foo", "app/dependabot"),
      pr(4, "renovate/bar", "renovate[bot]"),
    ]);
    assert.equal(r.open, 2);
    assert.deepEqual(r.counted, [1, 2]);
    assert.equal(r.slots, OPEN_PR_CAP - 2);
  });

  it("caso real de 10/11/2026: 15 abertas = 0 vagas, nunca negativo", () => {
    const prs = Array.from({ length: 15 }, (_, i) => pr(12700 + i, `overnight/fix-${i}`));
    assert.equal(computeOpenPrSlots(prs).slots, 0);
  });

  it("teto inválido lança", () => {
    assert.throws(() => computeOpenPrSlots([], -1), /teto inválido/);
    assert.throws(() => computeOpenPrSlots([], Number.NaN), /teto inválido/);
  });

  it("bot detectado por login ou por branch", () => {
    assert.equal(isDependencyBotPr(pr(1, "x", "dependabot[bot]")), true);
    assert.equal(isDependencyBotPr(pr(1, "dependabot/x")), true);
    assert.equal(isDependencyBotPr(pr(1, "overnight/fix-1")), false);
  });

  it("onda não passa das vagas; 0 vagas recusa qualquer onda", () => {
    assert.equal(waveOpenPrCapError(3, 3), null);
    assert.match(waveOpenPrCapError(4, 3) ?? "", /estoura as 3 vaga/);
    assert.match(waveOpenPrCapError(1, 0) ?? "", /teto de PRs abertos atingido/);
    assert.match(waveOpenPrCapError(1, -1) ?? "", /inválido/);
  });

  it("gh falhando → não verificado, teto cheio de vagas, open/counted nulos", () => {
    const r = readOpenPrCap(fakeGh(1, ""));
    assert.equal(r.verified, false);
    assert.equal(r.slots, OPEN_PR_CAP);
    assert.equal(r.open, null);
    assert.equal(r.counted, null);
  });

  it("saída não-JSON ou não-array → não verificado", () => {
    assert.equal(readOpenPrCap(fakeGh(0, "{oops")).verified, false);
    assert.equal(readOpenPrCap(fakeGh(0, "{}")).verified, false);
  });

  it("gh ok → conta", () => {
    const r = readOpenPrCap(fakeGh(0, JSON.stringify([pr(1, "a"), pr(2, "b")])));
    assert.equal(r.verified, true);
    assert.equal(r.open, 2);
    assert.equal(r.slots, OPEN_PR_CAP - 2);
  });

  it("lista no limite de paginação é medição válida com 0 vagas, nunca fail-open", () => {
    const prs = Array.from({ length: OPEN_PR_LIST_LIMIT }, (_, i) => pr(i + 1, `x/${i}`));
    const r = readOpenPrCap(fakeGh(0, JSON.stringify(prs)));
    assert.equal(r.verified, true);
    assert.equal(r.slots, 0);
    assert.ok(r.verified && r.truncated);
  });

  it("contínuo só reivindica com vaga nos dois tetos; global não verificado não segura", () => {
    assert.deepEqual(combineContinuoCaps(true, 3), { mayClaim: true, heldBy: null });
    assert.deepEqual(combineContinuoCaps(true, 0), { mayClaim: false, heldBy: "global" });
    assert.deepEqual(combineContinuoCaps(false, 5), { mayClaim: false, heldBy: "continuo" });
    assert.deepEqual(combineContinuoCaps(true, null), { mayClaim: true, heldBy: null });
  });
});

/**
 * `gh` falso no PATH (#12873): o script mede o teto sozinho, e o teste não
 * pode depender do `gh` real (autenticado na máquina do dev, ausente no CI).
 * `openPrs` = lista devolvida por `gh pr list`; `null` = gh falha (exit 1).
 * Via `test/_helpers/fake-gh.ts` (#11487): sonda + credencial neutralizada.
 */
function fakeGhRunEnv(openPrs: number | null): NodeJS.ProcessEnv {
  const bin = mkdtempSync(join(tmpdir(), "fake-gh-12873-"));
  const payload = openPrs === null ? "" : JSON.stringify(
    Array.from({ length: openPrs }, (_, i) => ({ number: 9000 + i, headRefName: `overnight/fix-${i}`, author: { login: "vjpixel" } })),
  );
  const body = openPrs === null
    ? "#!/bin/sh\necho 'gh: offline' >&2\nexit 1\n"
    : `#!/bin/sh\ncat <<'JSON'\n${payload}\nJSON\n`;
  writeFakeGh(bin, body);
  return fakeGhEnv(bin);
}

describe("record-overnight-wave --open-pr-slots (#12765)", { skip: FAKE_GH_SKIP_WIN32 }, () => {
  const setup = (openPrs: number | null = null) => {
    const dir = mkdtempSync(join(tmpdir(), "wave-12765-"));
    const plan = join(dir, "plan.json");
    writeFileSync(plan, "{}\n");
    const env = fakeGhRunEnv(openPrs);
    const run = (...extra: string[]) => spawnSync(process.execPath, [
      "--import", "tsx", "scripts/record-overnight-wave.ts", "--plan", plan, "--units", "1;2", ...extra,
    ], { encoding: "utf8", env });
    return { plan, run };
  };

  it("recusa onda acima das vagas sem gravar; aceita dentro", () => {
    const { plan, run } = setup();
    const refused = run("--open-pr-slots", "1");
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /estoura as 1 vaga/);
    assert.equal(JSON.parse(readFileSync(plan, "utf8")).waves, undefined);
    const ok = run("--open-pr-slots", "2");
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(readFileSync(plan, "utf8")).waves.length, 1);
  });

  it("re-registrar a mesma onda com menos vagas segue no-op exit 0 (#8496)", () => {
    const { plan, run } = setup();
    assert.equal(run("--open-pr-slots=2").status, 0);
    const again = run("--open-pr-slots", "0");
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /no-op idempotente/);
    assert.equal(JSON.parse(readFileSync(plan, "utf8")).waves.length, 1);
  });
});

describe("record-overnight-wave mede o teto sozinho (#12873)", { skip: FAKE_GH_SKIP_WIN32 }, () => {
  const setup = (openPrs: number | null) => {
    const dir = mkdtempSync(join(tmpdir(), "wave-12873-"));
    const plan = join(dir, "plan.json");
    writeFileSync(plan, "{}\n");
    const env = fakeGhRunEnv(openPrs);
    const run = (...extra: string[]) => spawnSync(process.execPath, [
      "--import", "tsx", "scripts/record-overnight-wave.ts", "--plan", plan, "--units", "1;2", ...extra,
    ], { encoding: "utf8", env });
    return { plan, run };
  };

  it("caso real da 261111b: informado 5 com 1 vaga medida recusa onda de 2, sem gravar", () => {
    const { plan, run } = setup(OPEN_PR_CAP - 1);
    const r = run("--open-pr-slots", "5");
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /diverge do teto medido agora \(9 PR\(s\) aberta\(s\), 1 vaga\(s\)\)/);
    assert.match(r.stderr, /estoura as 1 vaga/);
    assert.equal(JSON.parse(readFileSync(plan, "utf8")).waves, undefined);
  });

  it("informado abaixo do medido: vale o informado (o medido só aperta), com aviso", () => {
    const { plan, run } = setup(0);
    const r = run("--open-pr-slots", "1");
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /diverge do teto medido.*vale o informado/);
    assert.match(r.stderr, /estoura as 1 vaga/);
    assert.equal(JSON.parse(readFileSync(plan, "utf8")).waves, undefined);
  });

  it("informado igual ao medido: sem aviso", () => {
    const { run } = setup(OPEN_PR_CAP - 2);
    const r = run("--open-pr-slots", "2");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /AVISO/);
  });

  it("gh indisponível: aceita o informado com aviso", () => {
    const { plan, run } = setup(null);
    const r = run("--open-pr-slots", "2");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /não medido .*sem conferência/);
    assert.equal(JSON.parse(readFileSync(plan, "utf8")).waves.length, 1);
  });
});

// Fora do skip de win32: nenhum dos dois chega a chamar o gh.
describe("--open-pr-slots sem gh (#12765, #12873)", () => {
  it("resolveWaveOpenPrSlots (puro): o medido só aperta", () => {
    assert.deepEqual(resolveWaveOpenPrSlots(3, { verified: true, slots: 3, open: 7 }), { slots: 3, warning: null });
    const above = resolveWaveOpenPrSlots(5, { verified: true, slots: 1, open: 9 });
    assert.equal(above.slots, 1);
    assert.match(above.warning ?? "", /vale o medido/);
    const below = resolveWaveOpenPrSlots(1, { verified: true, slots: 10, open: 0 });
    assert.equal(below.slots, 1);
    assert.match(below.warning ?? "", /vale o informado/);
    const off = resolveWaveOpenPrSlots(4, { verified: false, reason: "x" });
    assert.equal(off.slots, 4);
    assert.match(off.warning ?? "", /não medido/);
  });

  it("valor inválido sai 2 antes de medir, inclusive na forma --flag= e sem valor", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-12765-inv-"));
    const plan = join(dir, "plan.json");
    writeFileSync(plan, "{}\n");
    // Credencial neutralizada: se a validação regredir e o gh real rodar, leva 401.
    const env = withoutGhCredentials(process.env);
    const run = (...extra: string[]) => spawnSync(process.execPath, [
      "--import", "tsx", "scripts/record-overnight-wave.ts", "--plan", plan, "--units", "1;2", ...extra,
    ], { encoding: "utf8", env });
    for (const args of [["--open-pr-slots", "x"], ["--open-pr-slots="], ["--open-pr-slots"]]) {
      const r = run(...args);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, /exige inteiro não-negativo/);
    }
    assert.equal(JSON.parse(readFileSync(plan, "utf8")).waves, undefined);
  });
});

describe("fila de escaladas sem --slurp (#12765)", () => {
  it("o script não usa --slurp (gh 2.46 do servidor 300 não tem)", () => {
    const src = readFileSync(new URL("../scripts/list-continuo-escalation-queue.ts", import.meta.url), "utf8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
    assert.ok(!code.includes("--slurp"));
  });

  it("pagina até página incompleta e junta tudo", () => {
    const pages: Record<number, number[]> = { 1: [1, 2], 2: [3, 4], 3: [5] };
    const seen: number[] = [];
    const all = fetchAllPages((p) => { seen.push(p); return pages[p] ?? []; }, 2);
    assert.deepEqual(all, [1, 2, 3, 4, 5]);
    assert.deepEqual(seen, [1, 2, 3]);
  });

  it("página cheia exata termina com página vazia", () => {
    assert.deepEqual(fetchAllPages((p) => (p === 1 ? [1, 2] : []), 2), [1, 2]);
  });

  it("não entra em laço infinito; página não-array lança", () => {
    assert.throws(() => fetchAllPages(() => [1, 2], 2, 3), /limite de 3 páginas/);
    assert.throws(() => fetchAllPages(() => ({}) as unknown as number[]), /não é array/);
  });

  it("relógio da escalada: reescalada reinicia", () => {
    const now = Date.parse("2026-11-10T15:00:00Z");
    const ev = (event: string, created_at: string) => ({ event, label: { name: "continuo-escalado" }, created_at });
    assert.equal(overdueEscalation([ev("labeled", "2026-11-09T14:00:00Z")], now), "2026-11-09T14:00:00Z");
    assert.equal(overdueEscalation([ev("labeled", "2026-11-01T00:00:00Z"), ev("unlabeled", "2026-11-02T00:00:00Z"), ev("labeled", "2026-11-10T10:00:00Z")], now), null);
  });
});

describe("destino da escalada vencida (#12765)", () => {
  const old = ESCALATION_EXPIRY_MS + 1;
  const base: DestinationInput = {
    ageMs: old, isDraft: false, labels: ["continuo-escalado"], mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE", checksVerdict: "pass", retido: false, claimed: false, redundant: false, issue: 1,
  };
  const d = (over: Partial<DestinationInput>) => escalationDestination({ ...base, ...over });

  it("antes de 48h, ou idade ilegível, é sempre briefing", () => {
    assert.equal(d({ ageMs: ESCALATION_EXPIRY_MS, redundant: true }), "briefing");
    assert.equal(d({ ageMs: 1, isDraft: true, labels: ["bloqueio-execucao"] }), "briefing");
    assert.equal(d({ ageMs: Number.NaN, redundant: true }), "briefing");
  });

  it("retida para o editor, retenção ilegível ou PR reivindicada nunca recebe destino automático", () => {
    assert.equal(d({ retido: true, redundant: true }), "briefing");
    assert.equal(d({ retido: null, isDraft: true, labels: ["bloqueio-execucao"] }), "briefing");
    assert.equal(d({ claimed: true, mergeStateStatus: "DIRTY", labels: ["continuo-ci-fix-tentado"] }), "briefing");
  });

  it("redundante fecha (vence draft bloqueado)", () => {
    assert.equal(d({ redundant: true, isDraft: true, labels: ["bloqueio-execucao"] }), "fechar-redundante");
  });

  it("draft com bloqueio-execucao fecha para a issue (caso #12351/#12326)", () => {
    assert.equal(d({ isDraft: true, labels: ["continuo-escalado", "bloqueio-execucao"] }), "fechar-para-issue");
  });

  it("conflito ou CI parado → fixer na 1ª vez, fecha e reabre depois da tentativa", () => {
    assert.equal(d({ mergeStateStatus: "DIRTY" }), "fixer");
    assert.equal(d({ mergeable: "CONFLICTING", mergeStateStatus: "UNKNOWN" }), "fixer");
    for (const v of ["fail", "pending", "blocked_by_conflict"]) assert.equal(d({ checksVerdict: v }), "fixer", v);
    // `error` = checks ilegíveis: briefing, nunca fixer (#12804).
    assert.equal(d({ checksVerdict: "error" }), "briefing");
    assert.equal(d({ mergeStateStatus: "DIRTY", labels: ["continuo-ci-fix-tentado"] }), "fechar-reabrir-issue");
    assert.equal(d({ checksVerdict: "fail", labels: ["continuo-ci-fix-tentado"], issue: null }), "briefing");
  });

  it("label de tentativa sozinha não fecha PR verde (achado do review)", () => {
    assert.equal(d({ labels: ["continuo-ci-fix-tentado"] }), "briefing");
    assert.equal(d({ isDraft: true, labels: ["continuo-ci-fix-tentado"] }), "briefing");
    assert.equal(d({ isDraft: true }), "fixer");
  });

  it("diff grande / sensível sem conflito fica no briefing", () => {
    assert.equal(d({}), "briefing");
  });

  it("issue de origem: branch, corpo; nunca o título; resgate não tem", () => {
    assert.equal(originIssue({ headRefName: "overnight/fix-12552-youtube" }), 12552);
    assert.equal(originIssue({ headRefName: "continuo/x", body: "Closes #42" }), 42);
    assert.equal(originIssue({ headRefName: "overnight/batch-x", body: "trem(#6300) sem closes" }), null);
    assert.equal(originIssue({ headRefName: "continuo/rescue-2026", body: "Closes #7130" }), null);
  });

  it("comentário de fechamento diz que a branch fica e como desfazer", () => {
    const c = closingComment("fechar-para-issue", { headRefName: "continuo/fix-1" }, "2026-11-08T00:00:00Z", 1);
    assert.match(c, /#12765/);
    assert.match(c, /branch `continuo\/fix-1` foi preservada/);
    assert.match(c, /gh pr reopen/);
    assert.match(c, /Issue de origem: #1/);
  });
});

describe("runEscalationQueue --apply (#12765)", () => {
  const NOW = Date.parse("2026-11-11T12:00:00Z");
  const since = new Date(NOW - ESCALATION_EXPIRY_MS - 3600_000).toISOString();
  const mk = (n: number, over: Partial<OpenEscalatedPr> = {}): OpenEscalatedPr => ({
    number: n, url: `u/${n}`, title: `t${n}`, body: null, headRefName: `continuo/fix-${n}-x`,
    isDraft: false, mergeStateStatus: "CLEAN", labels: [{ name: "continuo-escalado" }], ...over,
  });
  const deps = (prs: OpenEscalatedPr[], over: Partial<QueueDeps> = {}) => {
    const calls: string[] = [];
    const d: QueueDeps = {
      listPrs: () => prs,
      events: () => [{ event: "labeled", label: { name: "continuo-escalado" }, created_at: since }],
      gate: () => ({ action: "escalate", reason: "x", details: { checksVerdict: "pass", mergeable: "MERGEABLE", retidoParaEditor: { retido: false }, sessionClaims: { ok: true } } }),
      redundant: () => false,
      issueState: () => ({ state: "CLOSED", stateReason: "COMPLETED" }),
      reopenIssue: (n) => calls.push(`reopen ${n}`),
      commentIssue: (n) => calls.push(`comment ${n}`),
      closePr: (n) => calls.push(`close ${n}`),
      now: () => NOW,
      ...over,
    };
    return { d, calls };
  };
  const blocked = (n: number) => mk(n, { isDraft: true, labels: [{ name: "continuo-escalado" }, { name: "bloqueio-execucao" }] });
  const stuck = (n: number) => mk(n, { mergeStateStatus: "DIRTY", labels: [{ name: "continuo-escalado" }, { name: "continuo-ci-fix-tentado" }] });

  it("sem --apply não escreve nada", () => {
    const { d, calls } = deps([blocked(1), stuck(2)]);
    const r = runEscalationQueue(d, false);
    assert.deepEqual(calls, []);
    assert.deepEqual(r.queue.map((q) => q.destination), ["fechar-para-issue", "fechar-reabrir-issue"]);
  });

  it("issue antes da PR; reabre issue fechada como concluída", () => {
    const { d, calls } = deps([stuck(2)]);
    const r = runEscalationQueue(d, true);
    assert.deepEqual(calls, ["reopen 2", "comment 2", "close 2"]);
    assert.equal(r.applied[0].reopened, true);
  });

  it("issue fechada como não planejada só recebe comentário", () => {
    const { d, calls } = deps([stuck(2)], { issueState: () => ({ state: "CLOSED", stateReason: "NOT_PLANNED" }) });
    runEscalationQueue(d, true);
    assert.deepEqual(calls, ["comment 2", "close 2"]);
  });

  it("fixer e briefing nunca fecham", () => {
    const { d, calls } = deps([mk(3, { mergeStateStatus: "DIRTY" }), mk(4)]);
    const r = runEscalationQueue(d, true);
    assert.deepEqual(calls, []);
    assert.deepEqual(r.queue.map((q) => [q.destination, q.owner]), [["fixer", "coordenador"], ["briefing", "editor"]]);
  });

  it("resgate sem issue fecha a PR sem comentar em issue nenhuma", () => {
    const { d, calls } = deps([blocked(5)].map((p) => ({ ...p, headRefName: "continuo/rescue-2026" })));
    runEscalationQueue(d, true);
    assert.deepEqual(calls, ["close 5"]);
  });

  it("retida pelo gate ou reivindicada por sessão viva não fecha", () => {
    const { d, calls } = deps([blocked(6)], {
      gate: () => ({ details: { retidoParaEditor: { retido: true }, sessionClaims: { ok: true } } }),
    });
    runEscalationQueue(d, true);
    const { d: d2, calls: c2 } = deps([blocked(7)], {
      gate: () => ({ details: { retidoParaEditor: { retido: false }, sessionClaims: { ok: false } } }),
    });
    runEscalationQueue(d2, true);
    const { d: d3, calls: c3 } = deps([blocked(8)], { gate: () => ({}) });
    runEscalationQueue(d3, true);
    assert.deepEqual([...calls, ...c2, ...c3], []);
  });

  it("falha numa PR não perde as outras nem fecha a PR com issue pela metade", () => {
    const { d, calls } = deps([stuck(2), blocked(9)], {
      commentIssue: (n) => { if (n === 2) throw new Error("429"); calls.push(`comment ${n}`); },
    });
    const r = runEscalationQueue(d, true);
    assert.deepEqual(r.failures, [{ number: 2, step: "issue-comment", error: "429" }]);
    assert.ok(!calls.includes("close 2"), "PR 2 ficou aberta para a próxima rodada");
    assert.deepEqual(r.applied.map((a) => a.number), [9]);
  });

  it("gate falhando numa PR vira failure, a fila segue", () => {
    const { d } = deps([mk(10), blocked(11)], { gate: (n) => { if (n === 10) throw new Error("gate #10 falhou"); return { details: { retidoParaEditor: { retido: false }, sessionClaims: { ok: true } } }; } });
    const r = runEscalationQueue(d, false);
    assert.equal(r.failures[0].step, "gate");
    assert.deepEqual(r.queue.map((q) => q.number), [11]);
  });

  it("redundância não verificada é marcada e nunca fecha", () => {
    const { d, calls } = deps([mk(12)], { redundant: () => null });
    const r = runEscalationQueue(d, true);
    assert.equal(r.queue[0].redundant_check, "failed");
    assert.deepEqual(calls, []);
  });
});

describe("isRedundant num repo real (#12765)", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "redund-12765-"));
    const origin = join(root, "origin");
    const work = join(root, "work");
    execFileSync("git", ["init", "-q", "-b", "master", origin]);
    git(origin, "config", "user.email", "t@t"); git(origin, "config", "user.name", "t");
    writeFileSync(join(origin, "a.txt"), "a\n");
    git(origin, "add", "."); git(origin, "commit", "-qm", "base");
    execFileSync("git", ["clone", "-q", origin, work]);
    return { origin, work };
  };
  const branch = (origin: string, name: string, edit: () => void) => {
    git(origin, "checkout", "-qb", name, "master");
    edit();
    git(origin, "add", "-A"); git(origin, "commit", "-qm", name);
    git(origin, "checkout", "-q", "master");
  };

  it("conteúdo já no master → true; divergente → false; branch inexistente → null", () => {
    const { origin, work } = setup();
    branch(origin, "feat", () => writeFileSync(join(origin, "b.txt"), "b\n"));
    assert.equal(isRedundant("feat", work), false);
    writeFileSync(join(origin, "b.txt"), "b\n");
    git(origin, "add", "."); git(origin, "commit", "-qm", "landed elsewhere");
    assert.equal(isRedundant("feat", work), true);
    assert.equal(isRedundant("nao-existe", work), null);
    // Nunca reescreve refs/remotes/origin/* do checkout.
    assert.equal(git(work, "for-each-ref", "refs/remotes/origin/feat").trim(), "");
  });

  it("rename que o master não fez não é redundante (--no-renames)", () => {
    const { origin, work } = setup();
    branch(origin, "ren", () => git(origin, "mv", "a.txt", "c.txt"));
    writeFileSync(join(origin, "c.txt"), "a\n");
    git(origin, "add", "."); git(origin, "commit", "-qm", "c sem remover a");
    assert.equal(isRedundant("ren", work), false);
  });

  it("diff vazio não é prova de redundância", () => {
    const { origin, work } = setup();
    git(origin, "branch", "same", "master");
    assert.equal(isRedundant("same", work), false);
  });
});
