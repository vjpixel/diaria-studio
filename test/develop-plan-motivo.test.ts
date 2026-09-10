/**
 * test/develop-plan-motivo.test.ts (#5708)
 *
 * Cobertura de `scripts/lib/develop-plan-motivo.ts` + a CLI
 * `scripts/validate-develop-plan-motivo.ts`: funções puras (motivo
 * válido/inválido/ausente, filtro por status, ordenação da saída), a
 * orquestração I/O (`checkDevelopPlanMotivos` contra fixtures de
 * `plan.json` em tmpdir, array E dict — #4860), e o CLI (exit codes,
 * mensagens acionáveis).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  DEVELOP_PULADA_MOTIVOS,
  findInvalidPuladaMotivos,
  findDeixadoPara300Buraco,
  checkDevelopPlanMotivosFromIssues,
  checkDevelopPlanMotivos,
  type DevelopPlanIssueLike,
} from "../scripts/lib/develop-plan-motivo.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "scripts/validate-develop-plan-motivo.ts");

let root: string | null = null;
afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

function writePlanFixture(plan: Record<string, unknown>): string {
  root = mkdtempSync(join(tmpdir(), "develop-plan-motivo-"));
  const planPath = join(root, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf8");
  return planPath;
}

describe("findInvalidPuladaMotivos — filtro puro", () => {
  it("ignora issues que não são status pulada", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 1, status: "mergeada" },
      { number: 2, status: "pendente" },
    ];
    assert.deepEqual(findInvalidPuladaMotivos(issues), []);
  });

  it("cada valor do vocabulário fechado passa (ja-resolvida-antes-da-sessao com evidência)", () => {
    const issues: DevelopPlanIssueLike[] = DEVELOP_PULADA_MOTIVOS.map((motivo, i) => ({
      number: 100 + i,
      status: "pulada",
      motivo,
      ...(motivo === "ja-resolvida-antes-da-sessao"
        ? { ja_resolvida_evidencia: "GAQL campaign.status=PAUSED, confirmado 260819" }
        : {}),
    }));
    assert.deepEqual(findInvalidPuladaMotivos(issues), []);
  });

  it("ja-resolvida-antes-da-sessao sem ja_resolvida_evidencia é reportado com reason missing-evidencia", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 5501, status: "pulada", motivo: "ja-resolvida-antes-da-sessao" },
    ];
    assert.deepEqual(findInvalidPuladaMotivos(issues), [
      { number: 5501, motivo: "ja-resolvida-antes-da-sessao", reason: "missing-evidencia" },
    ]);
  });

  it("ja-resolvida-antes-da-sessao com ja_resolvida_evidencia vazia/whitespace também é reportado", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 5502, status: "pulada", motivo: "ja-resolvida-antes-da-sessao", ja_resolvida_evidencia: "   " },
    ];
    assert.deepEqual(findInvalidPuladaMotivos(issues), [
      { number: 5502, motivo: "ja-resolvida-antes-da-sessao", reason: "missing-evidencia" },
    ]);
  });

  it("ja-resolvida-antes-da-sessao com evidência não-string também é reportado", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 5503, status: "pulada", motivo: "ja-resolvida-antes-da-sessao", ja_resolvida_evidencia: 123 },
    ];
    assert.deepEqual(findInvalidPuladaMotivos(issues), [
      { number: 5503, motivo: "ja-resolvida-antes-da-sessao", reason: "missing-evidencia" },
    ]);
  });

  it("motivo fora do vocabulário (rótulo inventado) é reportado, na ordem de entrada", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 5506, status: "pulada", motivo: "gated no D0" },
      { number: 5419, status: "pulada", motivo: "timing do editor" },
    ];
    assert.deepEqual(findInvalidPuladaMotivos(issues), [
      { number: 5506, motivo: "gated no D0" },
      { number: 5419, motivo: "timing do editor" },
    ]);
  });

  it("motivo ausente é reportado com motivo null, não descartado silenciosamente", () => {
    const issues: DevelopPlanIssueLike[] = [{ number: 42, status: "pulada" }];
    assert.deepEqual(findInvalidPuladaMotivos(issues), [{ number: 42, motivo: null }]);
  });

  it("motivo não-string (ex: número por engano) também é reportado", () => {
    const issues: DevelopPlanIssueLike[] = [{ number: 42, status: "pulada", motivo: 123 }];
    assert.deepEqual(findInvalidPuladaMotivos(issues), [{ number: 42, motivo: null }]);
  });

  it("issue sem number vira NaN, nunca lança", () => {
    const issues: DevelopPlanIssueLike[] = [{ status: "pulada", motivo: "inventado" }];
    const result = findInvalidPuladaMotivos(issues);
    assert.equal(result.length, 1);
    assert.ok(Number.isNaN(result[0].number));
  });
});

describe("checkDevelopPlanMotivosFromIssues — veredito puro, ordenado por número", () => {
  it("sem issues inválidas → ok", () => {
    assert.deepEqual(checkDevelopPlanMotivosFromIssues([{ number: 1, status: "pendente" }]), {
      status: "ok",
    });
  });

  it("issues inválidas saem ordenadas por número, independente da ordem de entrada", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 5506, status: "pulada", motivo: "gated no D0" },
      { number: 5419, status: "pulada", motivo: "timing do editor" },
    ];
    assert.deepEqual(checkDevelopPlanMotivosFromIssues(issues), {
      status: "invalid",
      entries: [
        { number: 5419, motivo: "timing do editor" },
        { number: 5506, motivo: "gated no D0" },
      ],
    });
  });
});

describe("checkDevelopPlanMotivos — I/O, array e dict (#4860)", () => {
  it("plan.issues como array — motivo válido → ok", () => {
    const planPath = writePlanFixture({
      issues: [{ number: 5658, status: "pulada", motivo: "decisao-adiada" }],
    });
    assert.deepEqual(checkDevelopPlanMotivos(planPath), { status: "ok" });
  });

  it("plan.issues como dict (shape real do develop, #4817/#4860) — motivo inválido detectado", () => {
    const planPath = writePlanFixture({
      issues: {
        "5506": { status: "pulada", motivo: "gated no D0" },
        "5658": { status: "mergeada" },
      },
    });
    assert.deepEqual(checkDevelopPlanMotivos(planPath), {
      status: "invalid",
      entries: [{ number: 5506, motivo: "gated no D0" }],
    });
  });

  it("plan.json sem campo issues → ok (fail-open, mesmo padrão de normalizeIssues)", () => {
    const planPath = writePlanFixture({ started_at: "2026-08-19T18:48:00Z" });
    assert.deepEqual(checkDevelopPlanMotivos(planPath), { status: "ok" });
  });
});

describe("CLI (scripts/validate-develop-plan-motivo.ts)", () => {
  function run(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env },
    });
  }

  it("motivos todos válidos → exit 0, 'ok'", () => {
    const planPath = writePlanFixture({
      issues: [{ number: 1, status: "pulada", motivo: "nao-destravavel-na-sessao" }],
    });
    const r = run(["--plan", planPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /vocabulário fechado/);
  });

  it("motivo inventado → exit 1, lista a issue e o motivo real", () => {
    const planPath = writePlanFixture({
      issues: [{ number: 5506, status: "pulada", motivo: "gated no D0" }],
    });
    const r = run(["--plan", planPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /#5506/);
    assert.match(r.stderr, /gated no D0/);
  });

  it("ja-resolvida-antes-da-sessao com evidência → exit 0", () => {
    const planPath = writePlanFixture({
      issues: [
        {
          number: 5501,
          status: "pulada",
          motivo: "ja-resolvida-antes-da-sessao",
          ja_resolvida_evidencia: "GAQL campaign.status=PAUSED, confirmado 260819",
        },
      ],
    });
    const r = run(["--plan", planPath]);
    assert.equal(r.status, 0);
  });

  it("ja-resolvida-antes-da-sessao sem evidência → exit 1, mensagem cita ja_resolvida_evidencia", () => {
    const planPath = writePlanFixture({
      issues: [{ number: 5501, status: "pulada", motivo: "ja-resolvida-antes-da-sessao" }],
    });
    const r = run(["--plan", planPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /#5501/);
    assert.match(r.stderr, /ja_resolvida_evidencia/);
  });

  it("plan.json ausente → erro acionável (path citado) e exit 2, nunca stack trace cru", () => {
    root = mkdtempSync(join(tmpdir(), "develop-plan-motivo-cli-"));
    const missing = join(root, "plan.json");
    const r = run(["--plan", missing]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /plan\.json não encontrado/);
    assert.doesNotMatch(r.stderr, /at readFileSync/);
  });

  it("sem --plan → uso + exit 2", () => {
    const r = run([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /uso: --plan/);
  });

  // #7682 — a CLI wira `findDeixadoPara300Buraco` separadamente de
  // `checkDevelopPlanMotivos` (ver validate-develop-plan-motivo.ts); os
  // testes acima só cobrem o vocabulário. Este cobre o caminho do "buraco"
  // fim-a-fim via subprocess, com os dois valores (novo e alias legado).
  it("#7682: status deixado-para-o-300 em issue de track develop → exit 1, mensagem cita o issue e os dois valores (novo + legado)", () => {
    const planPath = writePlanFixture({
      issues: [{ number: 5125, status: "deixado-para-o-300", exec_track_painel: "develop" }],
    });
    const r = run(["--plan", planPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /#5125/);
    assert.match(r.stderr, /deixado-para-o-300/);
    assert.match(r.stderr, /deixado-para-o-helios/);
  });

  it("#7682: status deixado-para-o-helios (alias legado) em issue de track develop → MESMO exit 1 e mensagem do valor novo", () => {
    const planPath = writePlanFixture({
      issues: [{ number: 5125, status: "deixado-para-o-helios", exec_track_painel: "develop" }],
    });
    const r = run(["--plan", planPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /#5125/);
  });

  it("#7682: deixado-para-o-300/helios em track overnight (legítimo) → exit 0, não aciona o gate do buraco", () => {
    const planPath = writePlanFixture({
      issues: [
        { number: 1, status: "deixado-para-o-300", exec_track_painel: "overnight" },
        { number: 2, status: "deixado-para-o-helios", exec_track_painel: "overnight" },
      ],
    });
    const r = run(["--plan", planPath]);
    assert.equal(r.status, 0);
  });
});

// ─── #5907 (b): findDeixadoPara300Buraco — deixado-para-o-300 em track develop/bloqueada ──
// (nome/valor renomeados de `findHeliosBuraco`/`deixado-para-o-helios` no
// #7682, rename de máquina `helios`/`predator` → `300`; o valor legado
// continua sendo LIDO — ver bloco "alias legado" mais abaixo.)

describe("findDeixadoPara300Buraco — #5907(b), buraco do 300", () => {
  it("status deixado-para-o-300 com exec_track_painel develop é reportado", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 5125, status: "deixado-para-o-300", exec_track_painel: "develop" },
    ];
    assert.deepEqual(findDeixadoPara300Buraco(issues), [5125]);
  });

  it("exec_track_painel bloqueada também é reportado", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 5878, status: "deixado-para-o-300", exec_track_painel: "bloqueada" },
    ];
    assert.deepEqual(findDeixadoPara300Buraco(issues), [5878]);
  });

  it("exec_track_painel epica também é reportado (#6201 — nunca implementada direto, sem-sentido pro 300 'deixar' pra depois)", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 461, status: "deixado-para-o-300", exec_track_painel: "epica" },
    ];
    assert.deepEqual(findDeixadoPara300Buraco(issues), [461]);
  });

  it("track overnight é legítimo (300 pega sozinho) — não reporta", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 5904, status: "deixado-para-o-300", exec_track_painel: "overnight" },
      { number: 5901, status: "deixado-para-o-300", exec_track_painel: "overnight" },
    ];
    assert.deepEqual(findDeixadoPara300Buraco(issues), []);
  });

  it("sem exec_track_painel gravado não reporta aqui (gap (a) da mesma issue, gate próprio)", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 5125, status: "deixado-para-o-300" },
      { number: 5891, status: "deixado-para-o-300" },
    ];
    assert.deepEqual(findDeixadoPara300Buraco(issues), []);
  });

  it("outros status (pulada/mergeada) nunca são reportados", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 1, status: "pulada", motivo: "deixado-para-o-300", exec_track_painel: "develop" },
      { number: 2, status: "mergeada", exec_track_painel: "develop" },
    ];
    assert.deepEqual(findDeixadoPara300Buraco(issues), []);
  });

  it("saída ordenada por número", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 5891, status: "deixado-para-o-300", exec_track_painel: "develop" },
      { number: 5125, status: "deixado-para-o-300", exec_track_painel: "bloqueada" },
    ];
    assert.deepEqual(findDeixadoPara300Buraco(issues), [5125, 5891]);
  });

  it("fixture da 260821c (shape real, inline — data/ não é versionado): sem track gravado não reporta", () => {
    // Estrutura copiada do plan.json real da 260821c: 15 issues, 10 com
    // status "deixado-para-o-helios" (valor gravado ANTES do rename #7682 —
    // preservado aqui verbatim, é exatamente o que uma fixture real antiga
    // contém), nenhuma com exec_track_painel gravado. data/ não vai pro
    // git, então a fixture é inline; se um dia um plan real com track
    // preenchido precisar de fixture, usar tmpdir+writeFileSync.
    const issues: DevelopPlanIssueLike[] = [
      { number: 5892, status: "deixado-para-o-helios" },
      { number: 5894, status: "deixado-para-o-helios" },
      { number: 5895, status: "deixado-para-o-helios" },
      { number: 5899, status: "deixado-para-o-helios" },
      { number: 5901, status: "deixado-para-o-helios" },
      { number: 5903, status: "deixado-para-o-helios" },
      { number: 5904, status: "deixado-para-o-helios" },
      { number: 5116, status: "deixado-para-o-helios" },
      { number: 5125, status: "deixado-para-o-helios" },
      { number: 5891, status: "deixado-para-o-helios" },
      { number: 5897, status: "mergeada" },
      { number: 5869, status: "pulada", motivo: "deixado-para-o-helios" },
    ];
    assert.deepEqual(findDeixadoPara300Buraco(issues), []);
  });
});

// ─── #7682: alias legado `deixado-para-o-helios` continua sendo LIDO ───────
//
// Decisão do editor (issue #7682): o rename `helios`/`predator` → `300` na
// máquina é retroativo em prosa/comentários/docs, mas NUNCA nos valores já
// gravados em plan.json de rodadas passadas — a máquina escreve
// `deixado-para-o-300` daqui pra frente, mas continua LENDO
// `deixado-para-o-helios` como equivalente, permanentemente (sem gatilho de
// migração/remoção do alias).

describe("#7682 — alias `deixado-para-o-helios` permanece legível (regressão, #633)", () => {
  it("DEVELOP_PULADA_MOTIVOS aceita os dois valores — novo (300) e legado (helios)", () => {
    assert.ok(DEVELOP_PULADA_MOTIVOS.includes("deixado-para-o-300" as never));
    assert.ok(DEVELOP_PULADA_MOTIVOS.includes("deixado-para-o-helios" as never));
  });

  it("findInvalidPuladaMotivos: motivo deixado-para-o-helios (plan.json antigo) NÃO é reportado como inválido", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 5125, status: "pulada", motivo: "deixado-para-o-helios" },
    ];
    assert.deepEqual(findInvalidPuladaMotivos(issues), []);
  });

  it("findDeixadoPara300Buraco: status deixado-para-o-helios (plan.json antigo) é tratado IDÊNTICO ao valor novo", () => {
    const legado: DevelopPlanIssueLike[] = [
      { number: 5125, status: "deixado-para-o-helios", exec_track_painel: "develop" },
    ];
    const novo: DevelopPlanIssueLike[] = [
      { number: 5125, status: "deixado-para-o-300", exec_track_painel: "develop" },
    ];
    assert.deepEqual(findDeixadoPara300Buraco(legado), findDeixadoPara300Buraco(novo));
    assert.deepEqual(findDeixadoPara300Buraco(legado), [5125]);
  });

  it("checkDevelopPlanMotivos (I/O): plan.json GRAVADO ANTES DO RENAME (#7682), com deixado-para-o-helios, continua lido corretamente", () => {
    // Fixture representando um plan.json real de uma rodada anterior ao
    // rename da máquina (08-10/09/2026) — nunca migrado, deve continuar
    // válido pra sempre (alias permanente, sem gatilho de remoção).
    const planPath = writePlanFixture({
      started_at: "2026-08-21T10:00:00Z",
      issues: [
        { number: 5892, status: "deixado-para-o-helios", exec_track_painel: "overnight" },
        { number: 5658, status: "pulada", motivo: "deixado-para-o-helios" },
      ],
    });
    assert.deepEqual(checkDevelopPlanMotivos(planPath), { status: "ok" });
  });
});
