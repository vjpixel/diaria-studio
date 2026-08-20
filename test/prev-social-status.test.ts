/**
 * test/prev-social-status.test.ts (#5756)
 *
 * O check 0l do Stage 0 acusava ~12 "posts sociais atrasados" em TODA edição,
 * indefinidamente, sobre um estado correto. Estes testes travam a distinção
 * que faltava: `scheduled` vencido só é informação em canal que REPORTA
 * status.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzePrevSocial,
  formatPrevSocialSummary,
  FIRE_AND_FORGET_PLATFORMS,
} from "../scripts/lib/prev-social-status.ts";

const NOW = new Date("2026-08-20T20:00:00-03:00");
const PAST = "2026-08-20T10:00:00-03:00";
const FUTURE = "2026-08-21T10:00:00-03:00";

/**
 * Réplica fiel da forma real de uma edição: 3 destaques × 5 canais, PÓS
 * reconciliação (#5766 — `verify-social-worker-dispatch.ts` roda antes deste
 * check e reconcilia LinkedIn/Instagram/Threads contra o Worker, então numa
 * edição saudável eles chegam aqui já `published`; só Twitter permanece
 * `scheduled` por não ter reconciliador).
 */
function realisticEdition(fbStatus = "published") {
  const posts = [];
  for (const d of ["d1", "d2", "d3"]) {
    posts.push({ platform: "facebook", destaque: d, status: fbStatus, scheduled_at: PAST });
    for (const p of ["linkedin", "instagram", "threads"]) {
      posts.push({ platform: p, destaque: d, status: "published", scheduled_at: PAST });
    }
    posts.push({ platform: "twitter", destaque: d, status: "scheduled", scheduled_at: PAST });
  }
  return posts;
}

describe("prev-social-status — o falso alarme diário (#5756)", () => {
  it("edição inteiramente saudável não gera achado nenhum", () => {
    const r = analyzePrevSocial(realisticEdition(), NOW);

    // Antes do #5756 este mesmo input produzia "12 posts sociais com
    // status=scheduled e scheduled_at já passado" — todo dia, para sempre.
    // Pós-#5766, só Twitter (sem reconciliador contra Worker) fica terminal.
    assert.deepEqual(r.findings, []);
    assert.equal(r.terminalByDesign, 3);
    assert.equal(r.total, 15);
  });

  it("o canal fire-and-forget restante (Twitter, #5766) nunca vira achado por 'vencido'", () => {
    const posts = [...FIRE_AND_FORGET_PLATFORMS].map((platform) => ({
      platform,
      destaque: "d1",
      status: "scheduled",
      // Vencido há um ano: mesmo assim não é informação nenhuma, porque o
      // registro local congela no enqueue e nunca é reconsultado.
      scheduled_at: "2025-08-20T10:00:00-03:00",
    }));
    const r = analyzePrevSocial(posts, NOW);
    assert.deepEqual(r.findings, []);
    assert.equal(r.terminalByDesign, 1);
    assert.deepEqual([...FIRE_AND_FORGET_PLATFORMS], ["twitter"]);
  });

  it("#5766 LinkedIn/Instagram/Threads vencidos em 'scheduled' AGORA são achado — reconciliação não rodou/falhou", () => {
    const posts = ["linkedin", "instagram", "threads"].map((platform) => ({
      platform,
      destaque: "d1",
      status: "scheduled",
      scheduled_at: PAST,
    }));
    const r = analyzePrevSocial(posts, NOW);
    assert.equal(r.findings.length, 3);
    assert.ok(r.findings.every((f) => f.reason === "overdue-pollable"));
  });

  it("Facebook vencido em 'scheduled' É achado — ali o silêncio significa algo", () => {
    const r = analyzePrevSocial(realisticEdition("scheduled"), NOW);

    // O verify-facebook-posts.ts do check 0k teria virado para "published"
    // se o post tivesse saído. Continuar "scheduled" depois da hora é sinal.
    assert.equal(r.findings.length, 3);
    assert.ok(r.findings.every((f) => f.platform === "facebook" && f.reason === "overdue-pollable"));
  });

  it("Facebook agendado para o FUTURO não é achado", () => {
    const r = analyzePrevSocial(
      [{ platform: "facebook", destaque: "d1", status: "scheduled", scheduled_at: FUTURE }],
      NOW,
    );
    assert.deepEqual(r.findings, []);
  });

  it("'failed' é achado em QUALQUER canal, inclusive fire-and-forget", () => {
    const posts = [
      { platform: "linkedin", destaque: "d1", status: "failed", scheduled_at: PAST },
      { platform: "facebook", destaque: "d2", status: "failed", scheduled_at: PAST },
    ];
    const r = analyzePrevSocial(posts, NOW);

    // `failed` é o script LOCAL dizendo que o dispatch não saiu — não uma
    // inferência sobre estado remoto. Vale para todo canal.
    assert.equal(r.findings.length, 2);
    assert.ok(r.findings.every((f) => f.reason === "failed"));
  });

  it("scheduled_at ausente ou inválido não vira achado por acidente", () => {
    const r = analyzePrevSocial(
      [
        { platform: "facebook", destaque: "d1", status: "scheduled", scheduled_at: null },
        { platform: "facebook", destaque: "d2", status: "scheduled", scheduled_at: "não é data" },
      ],
      NOW,
    );
    // Sem timestamp confiável não há como afirmar "vencido" — silêncio é
    // melhor que um alarme que o editor não consegue verificar.
    assert.deepEqual(r.findings, []);
  });

  it("platform com caixa diferente ainda é reconhecida", () => {
    const r = analyzePrevSocial(
      [{ platform: "Twitter", destaque: "d1", status: "scheduled", scheduled_at: PAST }],
      NOW,
    );
    assert.deepEqual(r.findings, []);
    assert.equal(r.terminalByDesign, 1);
  });

  it("lista vazia é silêncio, não erro", () => {
    const r = analyzePrevSocial([], NOW);
    assert.deepEqual(r.findings, []);
    assert.equal(r.total, 0);
  });
});

describe("prev-social-status — resumo", () => {
  it("sem achados, não há mensagem — silêncio é o comportamento correto", () => {
    assert.equal(formatPrevSocialSummary(analyzePrevSocial(realisticEdition(), NOW), "260819"), null);
  });

  it("com achados, nomeia canal, destaque e motivo", () => {
    const s = formatPrevSocialSummary(analyzePrevSocial(realisticEdition("scheduled"), NOW), "260819");
    assert.ok(s);
    assert.match(s, /260819/);
    // Rótulo em pt-BR, não a tag interna: a frase é lida pelo editor.
    assert.match(s, /facebook\/d1 \(agendado e não publicado\)/);
    assert.ok(!s.includes("overdue-pollable"), "tag técnica não deve vazar para a frase do editor");
  });
});

describe("check-prev-social-status CLI (#5756, lacuna do review da PR #5762)", () => {
  it("arquivo ausente é SILENCIOSO e exit 0 — primeira edição não é alarme", () => {
    const dir = mkdtempSync(join(tmpdir(), "prev-social-"));
    try {
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/check-prev-social-status.ts", "--prev-dir", dir, "--json"],
        { cwd: join(import.meta.dirname, ".."), encoding: "utf8" },
      );
      assert.equal(r.status, 0, "edição sem posts sociais não pode falhar o preflight");
      const out = JSON.parse(r.stdout.trim());
      assert.deepEqual(out.findings, []);
      assert.equal(out.file, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem --file nem --prev-dir sai 2 com mensagem de uso", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-prev-social-status.ts"], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Uso: npx tsx scripts\/check-prev-social-status\.ts/);
  });

  it("edição saudável imprime a linha de silêncio, não um alarme", () => {
    const dir = mkdtempSync(join(tmpdir(), "prev-social-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", "06-social-published.json"),
        JSON.stringify({ posts: realisticEdition() }),
        "utf8",
      );
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/check-prev-social-status.ts", "--prev-dir", dir],
        { cwd: join(import.meta.dirname, ".."), encoding: "utf8" },
      );
      assert.equal(r.status, 0);
      // O playbook decide entre alertar e seguir pelo texto desta linha —
      // se ela mudar, o §0l passa a interpretar errado.
      assert.match(r.stdout, /nenhum post social exige atenção/);
      assert.match(r.stdout, /3 em estado terminal por desenho/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Facebook vencido imprime a linha de alerta com a edição nomeada", () => {
    const dir = mkdtempSync(join(tmpdir(), "prev-social-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      // Data explicitamente antiga: os testes de unidade fixam `NOW`, mas o
      // CLI usa o relógio real — uma fixture "hoje às 10h" pode estar no
      // futuro dependendo da hora em que a suíte roda, e o teste passaria ou
      // falharia conforme o horário.
      const posts = realisticEdition("scheduled").map((p) => ({
        ...p,
        scheduled_at: "2020-01-01T10:00:00-03:00",
      }));
      writeFileSync(join(dir, "_internal", "06-social-published.json"), JSON.stringify({ posts }), "utf8");
      const r = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/check-prev-social-status.ts",
          "--prev-dir",
          dir,
          "--prev-edition",
          "260819",
        ],
        { cwd: join(import.meta.dirname, ".."), encoding: "utf8" },
      );
      assert.equal(r.status, 0, "o check é informativo — nunca bloqueia a edição, mesmo com achado");
      assert.match(r.stdout, /edição anterior 260819:/);
      assert.match(r.stdout, /3 post\(s\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
