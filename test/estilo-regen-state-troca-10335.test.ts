/**
 * test/estilo-regen-state-troca-10335.test.ts (#10335, cenário 1)
 *
 * Troca completa da imagem de um destaque com `pending` vivo no estado do
 * plano de regeneração por Noite Estrelada: os md5 dos 3 ratios mudam, o
 * plano seguinte toma a troca por "a regeneração rodou", a imagem trocada
 * entra em `images`, o reset do #10327 não dispara e o destaque vai a
 * `exhausted` — erro no gate para uma imagem nunca regenerada.
 *
 * Decisão do editor (briefing overnight 261018): limpar o estado na troca
 * (swap/reorder/promote no Stage 4, ou `--estilo-regen-reset` para arte
 * trocada à mão), sem tornar `--estilo-regen-ran` obrigatório.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  normalizeCropReviewResult,
  planEstiloRegeneration,
  planEstiloRegenerationForEdition,
  parseEstiloRegenResetTargets,
  type EstiloRegenState,
} from "../scripts/run-image-crop-reviewer.ts";
import { clearEstiloRegenDestaques, reorderEstiloRegenState } from "../scripts/lib/estilo-regen-state.ts";
import { promoteToDestaque } from "../scripts/promote-to-destaque.ts";

const ROOT = join(import.meta.dirname, "..");

const estilo = (ratio: "1x1" | "4x5", destaque = "d1") =>
  normalizeCropReviewResult(
    { results: [{ destaque, ratio, status: "warn", categoria: "estilo", motivo: "espiral" }] },
    "261018",
  );

function run(script: string, args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Plano com pending {4x5} em d1 — a execução parou antes do plano seguinte. */
function pendingState() {
  const md5: Record<string, string> = { "2x1": "2x1-v1", "1x1": "1x1-v1", "4x5": "nativo-v1" };
  const p = planEstiloRegeneration(estilo("4x5"), {}, () => false, (_d, r) => md5[r] ?? null);
  assert.deepEqual(p.state.pending?.d1, { "4x5": "nativo-v1" });
  return p.state;
}
const TROCADA: Record<string, string> = { "2x1": "2x1-troca", "1x1": "1x1-troca", "4x5": "nativo-troca" };
const curTrocada = (_d: string, r: string) => TROCADA[r] ?? null;

describe("#10335 cenário 1: troca completa da imagem com pending vivo", () => {
  it("sem limpar o estado, a troca vai a exhausted (o defeito que o fix contorna)", () => {
    const p = planEstiloRegeneration(estilo("1x1"), pendingState(), () => false, curTrocada);
    assert.deepEqual(p.exhausted, ["d1"], "md5 sozinho não distingue troca de regeneração");
  });

  it("estado limpo na troca → a imagem nova ganha a regeneração a que tem direito", () => {
    const cleared = clearEstiloRegenDestaques(pendingState(), ["d1"]);
    assert.equal(cleared.changed, true);
    const p = planEstiloRegeneration(estilo("1x1"), cleared.data as EstiloRegenState, () => false, curTrocada);
    assert.deepEqual(p.regenerate, ["d1"]);
    assert.deepEqual(p.exhausted, []);
    assert.equal(p.attempts.d1, undefined, "nenhuma tentativa gasta com a imagem trocada");
  });

  it("limpar d1 não toca o estado de d2", () => {
    const md5 = (_d: string, r: string) => `${_d}-${r}`;
    const both = normalizeCropReviewResult(
      {
        results: [
          { destaque: "d1", ratio: "4x5", status: "warn", categoria: "estilo" },
          { destaque: "d2", ratio: "1x1", status: "warn", categoria: "estilo" },
        ],
      },
      "261018",
    );
    const s = planEstiloRegeneration(both, {}, () => false, md5).state;
    const out = clearEstiloRegenDestaques(s, ["d1"]).data as EstiloRegenState;
    assert.equal(out.pending?.d1, undefined);
    assert.equal(out.pendingAll?.d1, undefined);
    assert.equal(out.pendingBase?.d1, undefined);
    assert.deepEqual(out.pending?.d2, s.pending?.d2);
    assert.deepEqual(out.pendingAll?.d2, s.pendingAll?.d2);
  });

  it("estado ausente/irreconhecível ou sem a posição → no-op", () => {
    assert.equal(clearEstiloRegenDestaques(null, ["d1"]).changed, false);
    assert.equal(clearEstiloRegenDestaques({ pending: { d2: {} } }, ["d1"]).changed, false);
  });
});

describe("#10335: reorder/promote — o estado segue a imagem", () => {
  it("reorder 2,1,3: pending de d1 vai para d2 junto com a imagem", () => {
    const s = { pending: { d1: { "4x5": "a" } }, attempts: { d2: 1 }, images: { d1: ["a"], d3: ["c"] }, updated_at: "x" };
    const r = reorderEstiloRegenState(s, [2, 1, 3]);
    assert.equal(r.changed, true);
    assert.deepEqual(r.data, {
      pending: { d2: { "4x5": "a" } },
      attempts: { d1: 1 },
      images: { d2: ["a"], d3: ["c"] },
      updated_at: "x",
    });
  });

  it("promote --position 1 (newOrder 3,1,2, edição de 2 destaques): posição nova sem estado", () => {
    const s = { pending: { d1: { "4x5": "a" } }, pendingBase: { d1: "b" }, failed: { d2: 1 } };
    const r = reorderEstiloRegenState(s, [3, 1, 2]);
    assert.deepEqual(r.data, { pending: { d2: { "4x5": "a" } }, pendingBase: { d2: "b" }, failed: { d3: 1 } });
  });

  it("permutação identidade → no-op", () => {
    assert.equal(reorderEstiloRegenState({ pending: { d1: {} } }, [1, 2, 3]).changed, false);
  });

  it("reorder-destaques.ts --new-order 2,1,3 (CLI): 04-estilo-regen.json remapeado", () => {
    const dir = mkdtempSync(join(tmpdir(), "estilo-10335-reorder-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      const approved = {
        highlights: ["https://a.com/1", "https://b.com/2", "https://c.com/3"].map((url, i) => ({ url, title_options: [`T${i + 1}`] })),
      };
      writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(approved));
      writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify(approved));
      writeFileSync(
        join(dir, "_internal", "04-estilo-regen.json"),
        JSON.stringify({ pending: { d1: { "4x5": "a" } }, attempts: { d2: 1 } }),
      );
      const r = run("reorder-destaques.ts", ["--edition", "999999", "--edition-dir", dir, "--new-order", "2,1,3"]);
      assert.equal(r.status, 0, r.stderr);
      const st = JSON.parse(readFileSync(join(dir, "_internal", "04-estilo-regen.json"), "utf8"));
      assert.deepEqual(st, { pending: { d2: { "4x5": "a" } }, attempts: { d1: 1 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("promoteToDestaque ponta a ponta: 04-estilo-regen.json deslocado", () => {
    const dir = mkdtempSync(join(tmpdir(), "estilo-10335-promote-"));
    try {
      const approved = {
        highlights: [
          { rank: 1, bucket: "noticias", url: "https://a.com/d1", article: { url: "https://a.com/d1", title: "D1" } },
          { rank: 2, bucket: "noticias", url: "https://b.com/d2", article: { url: "https://b.com/d2", title: "D2" } },
        ],
        radar: [{ url: "https://r.com/1", title: "R1", score: 70, category: "noticias" }],
        use_melhor: [],
      };
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(approved));
      writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify(approved));
      writeFileSync(join(dir, "02-reviewed.md"), "**DESTAQUE 1 | IA**\n\nt1\n\n---\n\n**DESTAQUE 2 | IA**\n\nt2\n");
      writeFileSync(
        join(dir, "_internal", "04-estilo-regen.json"),
        JSON.stringify({ pending: { d1: { "4x5": "a" } }, images: { d1: ["a"] } }),
      );
      const r = promoteToDestaque(dir, "https://r.com/1", 1);
      const st = JSON.parse(readFileSync(join(dir, "_internal", "04-estilo-regen.json"), "utf8"));
      assert.deepEqual(st, { pending: { d2: { "4x5": "a" } }, images: { d2: ["a"] } });
      assert.ok(r.rewritten.some((p) => p.endsWith("04-estilo-regen.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#10404: promote não herda estado residual de d3 na posição inserida", () => {
  /** Edição de 2 destaques cujo 04-estilo-regen.json ainda traz `d3` (D3 rebaixado à mão no Stage 4). */
  function promoteWithStaleD3(position: number, state: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "estilo-10404-promote-"));
    try {
      const approved = {
        highlights: [
          { rank: 1, bucket: "noticias", url: "https://a.com/d1", article: { url: "https://a.com/d1", title: "D1" } },
          { rank: 2, bucket: "noticias", url: "https://b.com/d2", article: { url: "https://b.com/d2", title: "D2" } },
        ],
        radar: [{ url: "https://r.com/1", title: "R1", score: 70, category: "noticias" }],
        use_melhor: [],
      };
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(approved));
      writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify(approved));
      writeFileSync(join(dir, "02-reviewed.md"), "**DESTAQUE 1 | IA**\n\nt1\n\n---\n\n**DESTAQUE 2 | IA**\n\nt2\n");
      writeFileSync(join(dir, "_internal", "04-estilo-regen.json"), JSON.stringify(state));
      const r = promoteToDestaque(dir, "https://r.com/1", position);
      return { r, st: JSON.parse(readFileSync(join(dir, "_internal", "04-estilo-regen.json"), "utf8")) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("--position 1: pending/images do D3 antigo NÃO vão para d1; d1/d2 antigos deslocam", () => {
    const { st } = promoteWithStaleD3(1, {
      pending: { d1: { "4x5": "a" }, d3: { "4x5": "velho" } },
      pendingAll: { d3: { "2x1": "velho-2x1" } },
      images: { d1: ["a"], d3: ["velho"] },
      attempts: { d3: 1 },
    });
    assert.equal(st.pending.d1, undefined, "posição inserida não herda o pending do D3 rebaixado");
    assert.equal(st.pendingAll.d1, undefined);
    assert.equal(st.images.d1, undefined);
    assert.equal(st.attempts.d1, undefined);
    assert.deepEqual(st.pending.d2, { "4x5": "a" }, "estado do D1 antigo segue a imagem para d2");
    assert.deepEqual(st.images.d2, ["a"]);
  });

  it("--position 3 (newOrder identidade): d3 residual é zerado mesmo sem deslocamento", () => {
    const { r, st } = promoteWithStaleD3(3, {
      pending: { d1: { "4x5": "a" }, d3: { "4x5": "velho" } },
      images: { d3: ["velho"] },
    });
    assert.equal(st.pending.d3, undefined);
    assert.equal(st.images.d3, undefined);
    assert.deepEqual(st.pending.d1, { "4x5": "a" });
    assert.ok(r.rewritten.some((p) => p.endsWith("04-estilo-regen.json")), "arquivo regravado mesmo com reorder no-op");
  });

  it("o plano seguinte NÃO esgota a imagem nova da posição inserida", () => {
    const md5: Record<string, string> = { "2x1": "2x1-v1", "1x1": "1x1-v1", "4x5": "nativo-v1" };
    const stale = planEstiloRegeneration(estilo("4x5", "d3"), {}, () => false, (_d, r) => md5[r] ?? null).state;
    assert.ok(stale.pending?.d3, "fixture: D3 antigo com pending vivo");
    const { st } = promoteWithStaleD3(1, stale as Record<string, unknown>);
    const p = planEstiloRegeneration(estilo("1x1", "d1"), st as EstiloRegenState, () => false, curTrocada);
    assert.deepEqual(p.exhausted, []);
    assert.deepEqual(p.regenerate, ["d1"]);
  });
});

describe("#10335: swap-destaque.ts e --estilo-regen-reset zeram a posição (CLI)", () => {
  const APPROVED = {
    highlights: [
      { rank: 1, bucket: "radar", url: "https://example.com/d1", title: "D1" },
      { rank: 2, bucket: "radar", url: "https://example.com/d2", title: "D2" },
      { rank: 3, bucket: "lancamento", url: "https://example.com/d3", title: "D3" },
    ],
    runners_up: [],
    lancamento: [],
    radar: [{ url: "https://example.com/radar-0", title: "Radar 0" }],
    use_melhor: [],
    video: [],
  };

  /** Edição real em disco com d1 acusado e pending vivo gravado pelo CLI do plano. */
  function makeEdition(): string {
    const dir = mkdtempSync(join(tmpdir(), "estilo-10335-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(APPROVED, null, 2));
    for (const [r, c] of [["2x1", "v1-2x1"], ["1x1", "v1-1x1"], ["4x5", "v1-card"], ["4x5-nativo", "v1-nativo"]]) {
      writeFileSync(join(dir, `04-d1-${r}.jpg`), c);
    }
    writeFileSync(
      join(dir, "_internal", "04-crop-review.json"),
      JSON.stringify({ results: [{ destaque: "d1", ratio: "4x5", status: "warn", categoria: "estilo", motivo: "espiral" }] }),
    );
    const plan = run("run-image-crop-reviewer.ts", ["--edition-dir", dir, "--estilo-regen-plan"]);
    assert.equal(plan.status, 0, plan.stderr);
    const st = JSON.parse(readFileSync(join(dir, "_internal", "04-estilo-regen.json"), "utf8")) as EstiloRegenState;
    assert.ok(st.pending?.d1, "pending vivo para d1");
    return dir;
  }

  /** Coloca a imagem trocada (3 ratios novos) e o revisor acusando o 1x1. */
  function trocaEAcusa1x1(dir: string) {
    for (const [r, c] of [["2x1", "troca-2x1"], ["1x1", "troca-1x1"], ["4x5", "troca-card"], ["4x5-nativo", "troca-nativo"]]) {
      writeFileSync(join(dir, `04-d1-${r}.jpg`), c);
    }
    writeFileSync(
      join(dir, "_internal", "04-crop-review.json"),
      JSON.stringify({ results: [{ destaque: "d1", ratio: "1x1", status: "warn", categoria: "estilo", motivo: "espiral" }] }),
    );
  }

  it("controle: troca manual sem reset vai a exhausted", () => {
    const dir = makeEdition();
    try {
      trocaEAcusa1x1(dir);
      assert.deepEqual(planEstiloRegenerationForEdition(dir)?.exhausted, ["d1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--estilo-regen-reset d1 depois da troca manual → plano regenera, não esgota", () => {
    const dir = makeEdition();
    try {
      trocaEAcusa1x1(dir);
      const r = run("run-image-crop-reviewer.ts", ["--edition-dir", dir, "--estilo-regen-reset", "d1"]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout).reset, ["d1"]);
      const plan = planEstiloRegenerationForEdition(dir);
      assert.deepEqual(plan?.regenerate, ["d1"]);
      assert.deepEqual(plan?.exhausted, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swap-destaque --demote d1 zera o estado de d1; imagem nova acusada ganha regeneração", () => {
    const dir = makeEdition();
    try {
      const s = run("swap-destaque.ts", ["--edition", "261018", "--edition-dir", dir, "--promote", "radar:0", "--demote", "d1", "--drop"]);
      assert.equal(s.status, 0, s.stderr);
      const st = JSON.parse(readFileSync(join(dir, "_internal", "04-estilo-regen.json"), "utf8")) as EstiloRegenState;
      assert.equal(st.pending?.d1, undefined);
      assert.equal(st.pendingAll?.d1, undefined);
      assert.equal(st.pendingBase?.d1, undefined);
      assert.equal(existsSync(join(dir, "04-d1-2x1.jpg")), false, "swap apaga as imagens da posição");
      trocaEAcusa1x1(dir); // Stage 3 gera a imagem do item promovido; revisor acusa 1x1
      const plan = planEstiloRegenerationForEdition(dir);
      assert.deepEqual(plan?.regenerate, ["d1"]);
      assert.deepEqual(plan?.exhausted, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swap-destaques (plural, #8995) --d1-url zera o estado de d1 e preserva d2; imagem nova ganha regeneração", () => {
    const dir = makeEdition();
    try {
      const path = join(dir, "_internal", "04-estilo-regen.json");
      const before = JSON.parse(readFileSync(path, "utf8")) as EstiloRegenState;
      writeFileSync(path, JSON.stringify({ ...before, attempts: { ...(before.attempts ?? {}), d2: 1 } }));
      const s = run("swap-destaques.ts", [
        "--edition", "261018", "--edition-dir", dir,
        "--d1-url", "https://example.com/novo", "--d1-title", "Novo", "--drop",
      ]);
      assert.equal(s.status, 0, s.stderr);
      const st = JSON.parse(readFileSync(path, "utf8")) as EstiloRegenState;
      assert.equal(st.pending?.d1, undefined);
      assert.equal(st.pendingAll?.d1, undefined);
      assert.equal(st.pendingBase?.d1, undefined);
      assert.equal(st.attempts?.d2, 1, "posição não trocada mantém o estado");
      assert.ok(JSON.parse(s.stdout).modified.rewritten.some((p: string) => p.endsWith("04-estilo-regen.json")));
      assert.equal(existsSync(join(dir, "04-d1-2x1.jpg")), false, "swap apaga as imagens da posição");
      trocaEAcusa1x1(dir);
      const plan = planEstiloRegenerationForEdition(dir);
      assert.deepEqual(plan?.regenerate, ["d1"]);
      assert.deepEqual(plan?.exhausted, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swap-destaque --dry-run só anuncia 'zerado' quando havia estado da posição", () => {
    const dir = makeEdition();
    try {
      const args = ["--edition", "261018", "--edition-dir", dir, "--promote", "radar:0", "--demote", "d1", "--drop", "--dry-run"];
      const com = run("swap-destaque.ts", args);
      assert.equal(com.status, 0, com.stderr);
      assert.match(JSON.parse(com.stdout).dry_run_plan.estilo_regen_state, /estado de d1 zerado/);
      const path = join(dir, "_internal", "04-estilo-regen.json");
      const before = readFileSync(path, "utf8");
      assert.ok(JSON.parse(before).pending?.d1, "dry-run não grava");
      rmSync(path);
      const sem = run("swap-destaque.ts", args);
      assert.equal(sem.status, 0, sem.stderr);
      const msg = JSON.parse(sem.stdout).dry_run_plan.estilo_regen_state as string;
      assert.doesNotMatch(msg, /zerado/);
      assert.match(msg, /nada a zerar/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--estilo-regen-reset: alvo inválido sai 1; parse deduplica", () => {
    const dir = mkdtempSync(join(tmpdir(), "estilo-10335-bad-"));
    try {
      const r = run("run-image-crop-reviewer.ts", ["--edition-dir", dir, "--estilo-regen-reset", "d4"]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /destaque inválido/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(parseEstiloRegenResetTargets("D1, d1,d3"), ["d1", "d3"]);
    assert.throws(() => parseEstiloRegenResetTargets(" , "), /nenhum destaque/);
  });

  it("--estilo-regen-reset sem 04-estilo-regen.json → no-op, exit 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "estilo-10335-none-"));
    try {
      const r = run("run-image-crop-reviewer.ts", ["--edition-dir", dir, "--estilo-regen-reset", "d1"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).rewritten, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
