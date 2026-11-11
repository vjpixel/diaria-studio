import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { computeOpenPrSlots, isDependencyBotPr, OPEN_PR_CAP, waveOpenPrCapError } from "../scripts/lib/open-pr-cap.ts";
import { readOpenPrCap } from "../scripts/check-open-pr-cap.ts";
import {
  closingComment,
  escalationDestination,
  ESCALATION_EXPIRY_MS,
  fetchAllPages,
  originIssue,
  overdueEscalation,
} from "../scripts/list-continuo-escalation-queue.ts";

const pr = (number: number, headRefName: string, login = "vjpixel") => ({ number, headRefName, author: { login } });

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

  it("gh falhando → não verificado, teto cheio de vagas (fail-soft)", () => {
    const fake = (() => ({ status: 1, stderr: "boom", stdout: "" })) as unknown as typeof spawnSync;
    const r = readOpenPrCap(fake);
    assert.equal(r.verified, false);
    assert.equal(r.slots, OPEN_PR_CAP);
  });

  it("gh ok → conta", () => {
    const fake = (() => ({ status: 0, stderr: "", stdout: JSON.stringify([pr(1, "a"), pr(2, "b")]) })) as unknown as typeof spawnSync;
    const r = readOpenPrCap(fake);
    assert.equal(r.verified, true);
    assert.equal(r.open, 2);
  });

  it("record-overnight-wave recusa onda acima das vagas", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-12765-"));
    const plan = join(dir, "plan.json");
    writeFileSync(plan, "{}\n");
    const run = (slots: string) => spawnSync(process.execPath, [
      "--import", "tsx", "scripts/record-overnight-wave.ts", "--plan", plan, "--units", "1;2", "--open-pr-slots", slots,
    ], { encoding: "utf8" });
    const refused = run("1");
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /estoura as 1 vaga/);
    assert.equal(JSON.parse(readFileSync(plan, "utf8")).waves, undefined);
    assert.equal(run("x").status, 2);
    const ok = run("2");
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(readFileSync(plan, "utf8")).waves.length, 1);
  });

  it("check-continuo-pr-cap exige vaga no teto global para mayClaim", () => {
    const src = readFileSync(new URL("../scripts/check-continuo-pr-cap.ts", import.meta.url), "utf8");
    assert.ok(src.includes("result.mayClaim && global.slots > 0"));
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

  it("não entra em laço infinito", () => {
    assert.throws(() => fetchAllPages(() => [1, 2], 2, 3), /mais de 3 páginas/);
  });

  it("evento escalado continua com o relógio do #12684", () => {
    const now = Date.parse("2026-11-10T15:00:00Z");
    assert.equal(overdueEscalation([{ event: "labeled", label: { name: "continuo-escalado" }, created_at: "2026-11-09T14:00:00Z" }], now), "2026-11-09T14:00:00Z");
  });
});

describe("destino da escalada vencida (#12765)", () => {
  const old = ESCALATION_EXPIRY_MS + 1;
  const base = { ageMs: old, isDraft: false, labels: ["continuo-escalado"], mergeStateStatus: "CLEAN", gateReason: "diff (600 linhas) >= limiar (500)", redundant: false };

  it("antes de 48h é sempre briefing, mesmo redundante ou draft bloqueado", () => {
    assert.equal(escalationDestination({ ...base, ageMs: ESCALATION_EXPIRY_MS, redundant: true }), "briefing");
    assert.equal(escalationDestination({ ...base, ageMs: 1, isDraft: true, labels: ["bloqueio-execucao"] }), "briefing");
  });

  it("redundante fecha", () => {
    assert.equal(escalationDestination({ ...base, redundant: true }), "fechar-redundante");
  });

  it("draft com bloqueio-execucao fecha para a issue (caso #12351/#12326)", () => {
    assert.equal(escalationDestination({ ...base, isDraft: true, labels: ["continuo-escalado", "bloqueio-execucao"] }), "fechar-para-issue");
  });

  it("conflito, CI vermelho ou draft sem bloqueio → fixer na 1ª vez, fecha e reabre na 2ª", () => {
    assert.equal(escalationDestination({ ...base, mergeStateStatus: "DIRTY" }), "fixer");
    assert.equal(escalationDestination({ ...base, gateReason: "CI: fail" }), "fixer");
    assert.equal(escalationDestination({ ...base, isDraft: true, gateReason: "draft — aguardando" }), "fixer");
    assert.equal(escalationDestination({ ...base, mergeStateStatus: "DIRTY", labels: ["continuo-ci-fix-tentado"] }), "fechar-reabrir-issue");
  });

  it("diff grande / sensível sem conflito fica no briefing", () => {
    assert.equal(escalationDestination(base), "briefing");
  });

  it("issue de origem: branch, corpo, título; resgate não tem", () => {
    assert.equal(originIssue({ headRefName: "overnight/fix-12552-youtube", title: "x" }), 12552);
    assert.equal(originIssue({ headRefName: "continuo/x", title: "x", body: "Closes #42" }), 42);
    assert.equal(originIssue({ headRefName: "overnight/batch-x", title: "fix (#123)" }), 123);
    assert.equal(originIssue({ headRefName: "continuo/rescue-2026", title: "chore(#7130): órfão" }), null);
  });

  it("comentário de fechamento diz que a branch fica e como desfazer", () => {
    const c = closingComment("fechar-para-issue", { headRefName: "continuo/fix-1" }, "2026-11-08T00:00:00Z", 1);
    assert.match(c, /#12765/);
    assert.match(c, /branch `continuo\/fix-1` foi preservada/);
    assert.match(c, /gh pr reopen/);
    assert.match(c, /Issue de origem: #1/);
  });
});
