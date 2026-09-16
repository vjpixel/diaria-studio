import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateFreshness,
  parseArgs,
  defaultMaxStalenessHours,
  aammddToIsoDate,
  isLocalMarkerAlreadyDue,
  evaluateLocalEditionsUnseen,
  collectLocalEditionMarkers,
  type LocalEditionMarker,
} from "../scripts/check-dedup-freshness.ts";
import { NPX, isWindows } from "./_helpers/spawn-npx.ts";

/** Roda o script CLI e captura {stdout, stderr, exitCode}.
 * Usa spawnSync (não execFileSync) para capturar stdout mesmo em exit != 0 (#311).
 * shell:true no Windows pra resolver npx via cmd.exe.
 */
function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(
    NPX,
    ["tsx", "scripts/check-dedup-freshness.ts", ...args],
    { encoding: "utf8", stdio: "pipe", shell: isWindows },
  );
  // spawnSync não throw — retorna status null quando processo não iniciou (ENOENT)
  if (result.error) throw result.error;
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

const NOW_ISO = "2026-04-28T03:00:00Z";
const NOW_MS = Date.parse(NOW_ISO);

describe("evaluateFreshness (#230)", () => {
  it("ok=true quando edição mais recente está dentro da janela", () => {
    const posts = [
      { id: "a", published_at: "2026-04-26T18:00:00Z" }, // 33h atrás
      { id: "b", published_at: "2026-04-23T10:00:00Z" },
    ];
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.ok, true);
    assert.equal(r.most_recent, "2026-04-26T18:00:00Z");
    assert.equal(r.count, 2);
    assert.equal(r.reason, undefined);
  });

  it("ok=false quando todas as entradas estão fora da janela", () => {
    // Cenário real do #230: raw com 5 edições de 14-23 abril, agora é 28 abril
    const posts = [
      { id: "a", published_at: "2026-04-23T10:00:00Z" }, // 113h atrás
      { id: "b", published_at: "2026-04-22T10:00:00Z" },
      { id: "c", published_at: "2026-04-18T10:00:00Z" },
    ];
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.ok, false);
    assert.equal(r.most_recent, "2026-04-23T10:00:00Z");
    assert.match(r.reason ?? "", /publicada há \d+\.\d+h.*limite 48h/);
  });

  it("ok=false com lista vazia + reason indicando bootstrap", () => {
    const r = evaluateFreshness([], NOW_MS, 48);
    assert.equal(r.ok, false);
    assert.equal(r.count, 0);
    assert.equal(r.most_recent, null);
    assert.match(r.reason ?? "", /bootstrap/);
  });

  it("ok=false quando nenhuma entrada tem published_at parseável", () => {
    const posts = [
      { id: "a" },
      { id: "b", published_at: "garbage" },
    ];
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.ok, false);
    assert.equal(r.most_recent, null);
    assert.match(r.reason ?? "", /parseável/);
  });

  it("ignora entradas inválidas mas usa as válidas", () => {
    const posts = [
      { id: "x", published_at: "not-a-date" },
      { id: "y", published_at: "2026-04-27T20:00:00Z" }, // 7h atrás
    ];
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.ok, true);
    assert.equal(r.most_recent, "2026-04-27T20:00:00Z");
  });

  it("idade exatamente igual à janela conta como ok", () => {
    const posts = [{ id: "a", published_at: "2026-04-26T03:00:00Z" }]; // 48h exatos
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.ok, true);
  });

  it("idade um segundo acima da janela falha", () => {
    const posts = [{ id: "a", published_at: "2026-04-26T02:59:59Z" }]; // 48h e 1s
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.ok, false);
  });

  it("janela customizada funciona", () => {
    const posts = [{ id: "a", published_at: "2026-04-27T00:00:00Z" }]; // 27h atrás
    assert.equal(evaluateFreshness(posts, NOW_MS, 24).ok, false);
    assert.equal(evaluateFreshness(posts, NOW_MS, 72).ok, true);
  });

  it("escolhe o post com published_at mais recente independente da ordem", () => {
    const posts = [
      { id: "old", published_at: "2026-04-20T00:00:00Z" },
      { id: "new", published_at: "2026-04-27T22:00:00Z" }, // 5h atrás
      { id: "mid", published_at: "2026-04-25T00:00:00Z" },
    ];
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.most_recent, "2026-04-27T22:00:00Z");
    assert.equal(r.ok, true);
  });

  it("age_hours arredondado a 1 casa decimal", () => {
    const posts = [{ id: "a", published_at: "2026-04-27T15:34:12Z" }];
    const r = evaluateFreshness(posts, NOW_MS, 48);
    // Sanity: número, finito, com no máximo 1 casa.
    assert.equal(typeof r.age_hours, "number");
    const decimals = (String(r.age_hours).split(".")[1] ?? "").length;
    assert.ok(decimals <= 1, `age_hours ${r.age_hours} tem mais de 1 decimal`);
  });

  it("ok=false quando edição mais recente tem published_at no futuro (#241)", () => {
    const posts = [{ id: "a", published_at: "2026-04-29T12:00:00Z" }]; // 33h no futuro
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.ok, false);
    assert.equal(r.most_recent, "2026-04-29T12:00:00Z");
    assert.match(r.reason ?? "", /futuro|à frente/);
    // age_hours deve ser negativo (sinal de detecção)
    assert.ok(r.age_hours !== null && r.age_hours < 0);
  });

  it("entrada futura não mascara stale real — escolhe ainda a mais recente (#241)", () => {
    // Garantia: se houver mistura de futuro + passado, a função pega a mais recente
    // (que pode ser a futura) e dispara o guard de futuro, não cai pra "stale".
    const posts = [
      { id: "future", published_at: "2026-05-01T00:00:00Z" }, // ~3 dias à frente
      { id: "past", published_at: "2026-04-20T00:00:00Z" }, // ~8 dias atrás
    ];
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.ok, false);
    assert.equal(r.most_recent, "2026-05-01T00:00:00Z");
    assert.match(r.reason ?? "", /futuro/);
  });
});

describe("parseArgs", () => {
  it("default: threshold dinâmico (#675), raw padrão, now undefined", () => {
    const r = parseArgs([]);
    if ("error" in r) throw new Error(r.error);
    // defaultMaxStalenessHours() é day-of-week aware — verificar só que é um dos valores válidos
    assert.ok([48, 72, 96].includes(r.maxStalenessHours), `threshold ${r.maxStalenessHours} deve ser 48, 72 ou 96`);
    assert.equal(r.rawPath, "data/past-editions-raw.json");
    assert.equal(r.now, undefined);
  });

  it("override de janela", () => {
    const r = parseArgs(["--max-staleness-hours", "72"]);
    if ("error" in r) throw new Error(r.error);
    assert.equal(r.maxStalenessHours, 72);
  });

  it("override de raw e now", () => {
    const r = parseArgs([
      "--raw",
      "tmp/raw.json",
      "--now",
      "2026-04-28T03:00:00Z",
    ]);
    if ("error" in r) throw new Error(r.error);
    assert.equal(r.rawPath, "tmp/raw.json");
    assert.equal(r.now, "2026-04-28T03:00:00Z");
  });

  it("janela inválida (não numérica) retorna erro", () => {
    const r = parseArgs(["--max-staleness-hours", "abc"]);
    assert.ok("error" in r);
  });

  it("janela <= 0 retorna erro", () => {
    const r = parseArgs(["--max-staleness-hours", "0"]);
    assert.ok("error" in r);
    const r2 = parseArgs(["--max-staleness-hours", "-5"]);
    assert.ok("error" in r2);
  });
});

describe("CLI: emite JSON em todos os exit codes (#240)", () => {
  let tmp: string;

  function setup() {
    tmp = mkdtempSync(join(tmpdir(), "freshness-"));
    return tmp;
  }
  function cleanup() {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }

  it("path stale (exit 1) emite JSON parseável", () => {
    const dir = setup();
    try {
      const raw = join(dir, "raw.json");
      writeFileSync(
        raw,
        JSON.stringify([{ id: "a", published_at: "2026-04-20T00:00:00Z" }]),
      );
      const { stdout, exitCode } = runCli([
        "--raw",
        raw,
        "--now",
        "2026-04-28T03:00:00Z",
      ]);
      assert.equal(exitCode, 1);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, false);
      assert.match(parsed.reason ?? "", /publicada há/);
    } finally {
      cleanup();
    }
  });

  it("path raw missing (exit 1) emite JSON com reason de bootstrap", () => {
    const { stdout, exitCode } = runCli(["--raw", "/tmp/never-exists-xyz.json"]);
    assert.equal(exitCode, 1);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason ?? "", /bootstrap/);
  });

  it("path JSON corrompido (exit 2) emite JSON em vez de stderr", () => {
    const dir = setup();
    try {
      const raw = join(dir, "broken.json");
      writeFileSync(raw, "{ not valid json");
      const { stdout, stderr, exitCode } = runCli(["--raw", raw]);
      assert.equal(exitCode, 2);
      // Antes de #240: vinha em stderr. Agora em stdout como JSON.
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, false);
      assert.match(parsed.reason ?? "", /JSON parse falhou/);
      // stderr deve estar limpo (ou pelo menos sem o texto livre legacy).
      assert.ok(!stderr.includes("raw inválido (JSON parse"));
    } finally {
      cleanup();
    }
  });

  it("path raw não-array (exit 2) emite JSON", () => {
    const dir = setup();
    try {
      const raw = join(dir, "obj.json");
      writeFileSync(raw, JSON.stringify({ not: "an array" }));
      const { stdout, exitCode } = runCli(["--raw", raw]);
      assert.equal(exitCode, 2);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, false);
      assert.match(parsed.reason ?? "", /esperado array/);
    } finally {
      cleanup();
    }
  });

  it("path --now inválido (exit 2) emite JSON", () => {
    const dir = setup();
    try {
      const raw = join(dir, "raw.json");
      writeFileSync(raw, "[]");
      const { stdout, exitCode } = runCli([
        "--raw",
        raw,
        "--now",
        "not-a-date",
      ]);
      assert.equal(exitCode, 2);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, false);
      assert.match(parsed.reason ?? "", /--now inválido/);
    } finally {
      cleanup();
    }
  });

  it("path parseArgs error (exit 2) emite JSON", () => {
    // --max-staleness-hours abc cai no error path do parseArgs
    const { stdout, exitCode } = runCli([
      "--max-staleness-hours",
      "abc",
    ]);
    assert.equal(exitCode, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason ?? "", /max-staleness-hours inválido/);
  });
});

describe("defaultMaxStalenessHours (#675) — threshold dinâmico por dia da semana", () => {
  it("segunda-feira: 96h (cobre fim de semana)", () => {
    const monday = new Date("2026-05-04T09:00:00Z"); // 04/Mai/2026 = Segunda
    assert.equal(defaultMaxStalenessHours(monday), 96);
  });

  it("terça-feira: 72h", () => {
    const tuesday = new Date("2026-05-05T09:00:00Z"); // 05/Mai/2026 = Terça
    assert.equal(defaultMaxStalenessHours(tuesday), 72);
  });

  it("quarta-feira: 48h (padrão)", () => {
    const wednesday = new Date("2026-05-06T09:00:00Z");
    assert.equal(defaultMaxStalenessHours(wednesday), 48);
  });

  it("sexta-feira: 48h (padrão)", () => {
    const friday = new Date("2026-05-08T09:00:00Z");
    assert.equal(defaultMaxStalenessHours(friday), 48);
  });

  it("segunda: edição de sexta anterior (64h) → ok=true (não dispara alarme)", () => {
    const monday = new Date("2026-05-04T09:00:00Z");
    const posts = [{ id: "a", published_at: "2026-05-01T17:00:00Z" }]; // Sexta 17h → 64h atrás
    const r = evaluateFreshness(posts, monday.getTime(), defaultMaxStalenessHours(monday));
    assert.equal(r.ok, true, "segunda com edição de sexta não deve disparar alarme falso");
  });
});

// ── 2º critério, independente de calendário (#8142) ────────────────────────
//
// Cenário real que motivou: `read_backend` continuou "beehiiv" depois do
// ENVIO migrar pro Kit (#7388) — a Beehiiv nunca mais recebeu post,
// `refresh-dedup.ts` saía com `new_posts: 0`/exit 0 (fetch correto, FONTE
// vazia) e o critério de idade sozinho não bate alarme porque a Beehiiv
// segue existindo como arquivo público (idade medida é do backend ERRADO,
// não do real). O 2º critério pega isso comparando marcadores de envio
// LOCAIS (que o Stage 5 já gravou) contra o que o raw de dedup enxerga.

describe("aammddToIsoDate (#8142)", () => {
  it("converte AAMMDD pra YYYY-MM-DD (século 20xx)", () => {
    assert.equal(aammddToIsoDate("260904"), "2026-09-04");
    assert.equal(aammddToIsoDate("260101"), "2026-01-01");
  });

  it("lança em input malformado", () => {
    assert.throws(() => aammddToIsoDate("2609"), /AAMMDD inválido/);
    assert.throws(() => aammddToIsoDate("abcdef"), /AAMMDD inválido/);
  });
});

describe("isLocalMarkerAlreadyDue (#8142)", () => {
  const NOW_MS = Date.parse("2026-09-15T20:00:00Z");

  it("published_at presente conta sempre, mesmo com scheduled_at futuro", () => {
    assert.equal(
      isLocalMarkerAlreadyDue(
        { published_at: "2026-09-15T09:00:00Z", scheduled_at: "2026-12-01T09:00:00Z" },
        NOW_MS,
      ),
      true,
    );
  });

  it("scheduled_at no FUTURO não conta — edição de amanhã gravada na véspera (#8142 detalhe crítico)", () => {
    assert.equal(
      isLocalMarkerAlreadyDue({ status: "scheduled", scheduled_at: "2026-09-16T09:00:00Z" }, NOW_MS),
      false,
    );
  });

  it("scheduled_at no passado/presente conta", () => {
    assert.equal(
      isLocalMarkerAlreadyDue({ status: "scheduled", scheduled_at: "2026-09-15T09:00:00Z" }, NOW_MS),
      true,
    );
    assert.equal(
      isLocalMarkerAlreadyDue({ status: "scheduled", scheduled_at: "2026-09-15T20:00:00Z" }, NOW_MS),
      true,
    );
  });

  it("sem published_at nem scheduled_at (draft/test_sent local) conta", () => {
    assert.equal(isLocalMarkerAlreadyDue({ status: "draft" }, NOW_MS), true);
  });

  it("scheduled_at não-parseável cai no default (conta)", () => {
    assert.equal(isLocalMarkerAlreadyDue({ scheduled_at: "garbage" }, NOW_MS), true);
  });
});

describe("evaluateLocalEditionsUnseen (#8142)", () => {
  const NOW_MS = Date.parse("2026-09-15T20:00:00Z");

  it("cenário real: raw travado em 260903, editions 260904..260915 já enviadas → todas unseen", () => {
    const markers: LocalEditionMarker[] = [
      { aammdd: "260904", marker: { status: "published", published_at: "2026-09-04T09:05:00Z" } },
      { aammdd: "260908", marker: { status: "published", published_at: "2026-09-08T09:05:00Z" } },
      { aammdd: "260915", marker: { status: "published", published_at: "2026-09-15T09:05:00Z" } },
    ];
    const r = evaluateLocalEditionsUnseen(markers, "2026-09-03T09:00:00.000Z", NOW_MS);
    assert.equal(r.checked, 3);
    assert.deepEqual(r.unseen, ["260904", "260908", "260915"]);
  });

  it("marcador com scheduled_at no FUTURO nunca aparece em unseen (não aborta toda noite)", () => {
    const markers: LocalEditionMarker[] = [
      { aammdd: "260904", marker: { status: "published", published_at: "2026-09-04T09:05:00Z" } },
      // edição de amanhã, já gravada na véspera com agendamento 24h+ à frente
      { aammdd: "260916", marker: { status: "scheduled", scheduled_at: "2026-09-16T09:00:00Z" } },
    ];
    const r = evaluateLocalEditionsUnseen(markers, "2026-09-15T09:00:00.000Z", NOW_MS);
    // 260904 já visto (raw most_recent 260915 > 260904); 260916 excluído por ser futuro — checked=1
    assert.equal(r.checked, 1);
    assert.deepEqual(r.unseen, []);
  });

  it("base vazia (most_recent=null) marca toda edição devida como unseen", () => {
    const markers: LocalEditionMarker[] = [
      { aammdd: "260904", marker: { status: "published", published_at: "2026-09-04T09:05:00Z" } },
    ];
    const r = evaluateLocalEditionsUnseen(markers, null, NOW_MS);
    assert.deepEqual(r.unseen, ["260904"]);
  });

  it("edição vista pela base (data <= most_recent) não conta como unseen", () => {
    const markers: LocalEditionMarker[] = [
      { aammdd: "260901", marker: { status: "published", published_at: "2026-09-01T09:05:00Z" } },
    ];
    const r = evaluateLocalEditionsUnseen(markers, "2026-09-15T09:00:00.000Z", NOW_MS);
    assert.deepEqual(r.unseen, []);
  });

  it("unseen sai ordenado ascendente independente da ordem de input", () => {
    const markers: LocalEditionMarker[] = [
      { aammdd: "260915", marker: { status: "published", published_at: "2026-09-15T09:05:00Z" } },
      { aammdd: "260904", marker: { status: "published", published_at: "2026-09-04T09:05:00Z" } },
    ];
    const r = evaluateLocalEditionsUnseen(markers, "2026-09-03T09:00:00.000Z", NOW_MS);
    assert.deepEqual(r.unseen, ["260904", "260915"]);
  });
});

describe("collectLocalEditionMarkers (#8142) — I/O real em diretório temporário", () => {
  let tmp: string;

  function setup() {
    tmp = mkdtempSync(join(tmpdir(), "local-editions-"));
    return tmp;
  }
  function cleanup() {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }

  it("lê marcador Beehiiv (05-published.json) em _internal/, layout nested", () => {
    const dir = setup();
    try {
      const editionDir = join(dir, "2609", "260904");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(
        join(editionDir, "_internal", "05-published.json"),
        JSON.stringify({ status: "published", published_at: "2026-09-04T09:05:00Z" }),
      );
      const markers = collectLocalEditionMarkers(dir);
      assert.equal(markers.length, 1);
      assert.equal(markers[0].aammdd, "260904");
      assert.equal(markers[0].marker.published_at, "2026-09-04T09:05:00Z");
    } finally {
      cleanup();
    }
  });

  it("lê marcador Kit (newsletter-kit-published.json)", () => {
    const dir = setup();
    try {
      const editionDir = join(dir, "2609", "260915");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(
        join(editionDir, "_internal", "newsletter-kit-published.json"),
        JSON.stringify({ status: "scheduled", scheduled_at: "2026-09-15T09:00:00Z" }),
      );
      const markers = collectLocalEditionMarkers(dir);
      assert.equal(markers.length, 1);
      assert.equal(markers[0].aammdd, "260915");
      assert.equal(markers[0].marker.scheduled_at, "2026-09-15T09:00:00Z");
    } finally {
      cleanup();
    }
  });

  it("edição sem nenhum marcador é ignorada (fail-soft)", () => {
    const dir = setup();
    try {
      mkdirSync(join(dir, "2609", "260910", "_internal"), { recursive: true });
      const markers = collectLocalEditionMarkers(dir);
      assert.deepEqual(markers, []);
    } finally {
      cleanup();
    }
  });

  it("editions-root inexistente retorna lista vazia (nunca lança)", () => {
    const markers = collectLocalEditionMarkers(join(tmpdir(), "nunca-existe-xyz-8142"));
    assert.deepEqual(markers, []);
  });
});

describe("CLI: cenário completo #8142 — fetch sai vazio, base congelada, guard pega via marcador local", () => {
  let tmp: string;

  function setup() {
    tmp = mkdtempSync(join(tmpdir(), "freshness-local-editions-"));
    return tmp;
  }
  function cleanup() {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }

  it("raw travado numa data antiga + edições locais já enviadas depois dela → ok=false, exit 1, unseen listado", () => {
    const dir = setup();
    try {
      const editionsRoot = join(dir, "editions");
      const edA = join(editionsRoot, "2609", "260904", "_internal");
      const edB = join(editionsRoot, "2609", "260915", "_internal");
      mkdirSync(edA, { recursive: true });
      mkdirSync(edB, { recursive: true });
      writeFileSync(
        join(edA, "05-published.json"),
        JSON.stringify({ status: "published", published_at: "2026-09-04T09:05:00Z" }),
      );
      writeFileSync(
        join(edB, "newsletter-kit-published.json"),
        JSON.stringify({ status: "published", published_at: "2026-09-15T09:05:00Z" }),
      );

      const raw = join(dir, "raw.json");
      // raw não avança além de 260903 — cenário real do #8142.
      writeFileSync(raw, JSON.stringify([{ id: "x", published_at: "2026-09-03T09:00:00Z" }]));

      const { stdout, exitCode } = runCli([
        "--raw",
        raw,
        "--editions-root",
        editionsRoot,
        "--now",
        "2026-09-15T20:00:00Z",
        // idade sozinha (299h) também estouraria — fixamos uma janela GRANDE
        // pra provar que É O CRITÉRIO LOCAL, não o de idade, que reprova aqui.
        "--max-staleness-hours",
        "10000",
      ]);
      assert.equal(exitCode, 1);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, false);
      // critério de idade sozinho estaria ok (janela de 10000h) — confirma que quem reprovou foi o local.
      assert.deepEqual(parsed.local_editions_unseen, ["260904", "260915"]);
      assert.equal(parsed.local_editions_checked, 2);
      assert.match(parsed.reason ?? "", /marcador de envio local/);
      assert.match(parsed.reason ?? "", /read_backend/);
    } finally {
      cleanup();
    }
  });

  it("marcador de edição de amanhã (scheduled_at futuro) nunca aborta a rodada por si só", () => {
    const dir = setup();
    try {
      const editionsRoot = join(dir, "editions");
      const edToday = join(editionsRoot, "2609", "260915", "_internal");
      const edTomorrow = join(editionsRoot, "2609", "260916", "_internal");
      mkdirSync(edToday, { recursive: true });
      mkdirSync(edTomorrow, { recursive: true });
      writeFileSync(
        join(edToday, "05-published.json"),
        JSON.stringify({ status: "published", published_at: "2026-09-15T09:05:00Z" }),
      );
      // edição de amanhã já gravada na véspera, agendada pro futuro.
      writeFileSync(
        join(edTomorrow, "05-published.json"),
        JSON.stringify({ status: "scheduled", scheduled_at: "2026-09-16T09:00:00Z" }),
      );

      const raw = join(dir, "raw.json");
      writeFileSync(raw, JSON.stringify([{ id: "x", published_at: "2026-09-15T09:00:00Z" }]));

      const { stdout, exitCode } = runCli([
        "--raw",
        raw,
        "--editions-root",
        editionsRoot,
        "--now",
        "2026-09-15T20:00:00Z",
      ]);
      assert.equal(exitCode, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, true);
      assert.deepEqual(parsed.local_editions_unseen, []);
      assert.equal(parsed.local_editions_checked, 1); // só a de hoje conta; amanhã é futuro
    } finally {
      cleanup();
    }
  });
});
