/**
 * test/update-audience-main-8151.test.ts (#8151)
 *
 * `main()` de `scripts/update-audience.ts` nunca era exercida por teste
 * real — só os helpers puros (shrinkage, decay, parse de CSV, guard de
 * archive) tinham cobertura; um bug que derrubasse uma seção, quebrasse um
 * header ou interpolasse `NaN`/`undefined` no documento montado passava
 * por toda a suíte, e o único detector era leitura humana do diff numa PR
 * (foi assim que #8145/#8148/#8149/#8150 apareceram, todos achados do
 * review da PR #8146).
 *
 * Estes testes rodam `main()` DE FATO — via import direto (não `spawnSync`:
 * `main()` já é puramente funcional em cima de paths/deps injetáveis desde
 * o #8151, sem precisar de subprocess) — controlando fs/env via um tmpdir
 * isolado (nunca toca `data/`/`context/` reais do repo) e `spawnFn`/
 * `getKitActiveSummaryFn`/`openDbFn` fake (nenhuma escrita em
 * `data/run-log.jsonl` real, nenhum acesso a `node:sqlite`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type UpdateAudienceDeps } from "../scripts/update-audience.ts";

const CTR_HEADER =
  "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";

/** Monta N rows de CTR CSV pra uma categoria — datas recentes (decay ~1.0), domínio editorial normal. */
function ctrRows(category: string, n: number, opens: number, clicks: number, origin: "BR" | "INT" = "BR"): string[] {
  const today = new Date();
  const date = new Date(today.getTime() - 3 * 86400000).toISOString().slice(0, 10);
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    rows.push(
      [
        date,
        `Post ${category} ${i}`,
        "Seção",
        `Título ${category} ${i}`,
        `https://example.com/${category}-${i}`,
        "example.com",
        String(opens),
        String(clicks),
        String(clicks),
        "0",
        category,
        origin,
      ].join(","),
    );
  }
  return rows;
}

function buildCtrCsv(): string {
  return [
    CTR_HEADER,
    ...ctrRows("Treinamento", 5, 200, 8, "BR"),
    ...ctrRows("Impacto", 7, 300, 4, "INT"),
    ...ctrRows("Lançamento", 3, 150, 1, "BR"),
  ].join("\n");
}

const SURVEY_FIXTURE = [
  {
    id: "r1",
    status: "active",
    answers: [
      { question_id: "q1", question_prompt: "Quais seções/tipos de conteúdo você mais gosta?", answer: "Tutoriais práticos" },
      { question_id: "q2", question_prompt: "Qual seu nível de conhecimento em IA?", answer: "Uso casual" },
      { question_id: "q3", question_prompt: "Qual o setor de atuação da organização em que você trabalha?", answer: "Tecnologia" },
    ],
  },
  {
    id: "r2",
    status: "active",
    answers: [
      { question_id: "q1", question_prompt: "Quais seções/tipos de conteúdo você mais gosta?", answer: "Curadoria de novas ferramentas" },
      { question_id: "q2", question_prompt: "Qual seu nível de conhecimento em IA?", answer: "Entusiasta" },
      { question_id: "q3", question_prompt: "Qual o setor de atuação da organização em que você trabalha?", answer: "Educação" },
    ],
  },
];

function makeFakeSpawn() {
  const calls: unknown[] = [];
  const spawnFn = ((...args: unknown[]) => {
    calls.push(args);
    return {} as ReturnType<typeof import("node:child_process").spawnSync>;
  }) as typeof import("node:child_process").spawnSync;
  return { spawnFn, calls };
}

function baseDeps(dir: string, overrides: Partial<UpdateAudienceDeps> = {}): UpdateAudienceDeps {
  const { spawnFn } = makeFakeSpawn();
  return {
    outPath: join(dir, "audience-profile.md"),
    historyDir: join(dir, "audience-history"),
    ctrCsvPath: join(dir, "link-ctr-table.csv"),
    surveyJsonPath: join(dir, "audience-raw.json"),
    pubJsonPath: join(dir, "publication.json"),
    h4HistoryPath: join(dir, "scorer-ctr-history.jsonl"),
    editionsDir: join(dir, "editions-nao-existe"), // nunca deve ser lido de verdade nestes testes
    subscriberBackend: "beehiiv",
    spawnFn,
    warnFn: () => {},
    ...overrides,
  };
}

describe("main() — forma do documento gerado (#8151)", () => {
  it("gera todas as seções obrigatórias, sem NaN/undefined/placeholder, com bandas somando o total declarado", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-audience-main-8151-"));
    try {
      writeFileSync(join(dir, "link-ctr-table.csv"), buildCtrCsv(), "utf8");
      writeFileSync(join(dir, "audience-raw.json"), JSON.stringify(SURVEY_FIXTURE), "utf8");
      writeFileSync(join(dir, "publication.json"), JSON.stringify({ stats: { active_subscriptions: 626 } }), "utf8");

      const deps = baseDeps(dir);
      const result = main(deps);

      assert.equal(result.ok, true, `main() deveria ter sucesso: ${result.reason ?? ""}`);
      assert.ok(existsSync(deps.outPath!), "arquivo de saída deve existir");

      const doc = readFileSync(deps.outPath!, "utf8");

      // Headers obrigatórios
      assert.match(doc, /^# Perfil de Audiência — diar\.ia\.br/m);
      assert.match(doc, /## 1\. Engajamento real \(CTR por categoria\)/);
      assert.match(doc, /## 2\. Preferências declaradas \(survey\)/);
      assert.match(doc, /## 3\. Quem são \(demographics\)/);

      // Nunca placeholder cru / valor interpolado quebrado
      assert.doesNotMatch(doc, /\bNaN\b/, "documento não deve conter NaN");
      assert.doesNotMatch(doc, /\bundefined\b/, "documento não deve conter undefined");
      assert.doesNotMatch(doc, /de N subscribers/, "nunca o placeholder 'N' solto em prosa (#8150)");

      // Subscribers ativos (fonte beehiiv, contagem exata do fixture)
      assert.match(doc, /\*\*subscribers ativos:\*\* 626/);
      assert.match(doc, /comportamento de 626 subscribers em/);

      // Totais por banda somam o total de rows do CSV (5 + 7 + 3 = 15) — #8151
      // "os totais por banda somam o total declarado" (achado do review manual
      // da PR #8146, aqui travado mecanicamente em vez de conferido à mão).
      const linkCounts = [...doc.matchAll(/\|\s+(\d+)\s+links\s+\|\s+\d+\s+aberturas/g)].map((m) => Number(m[1]));
      // Só conta a Seção 1 (categorias diretas) — "Destaques por categoria +
      // origem" usa o mesmo formato de linha mas soma outra coisa (combos),
      // então pegamos só as linhas até a 1ª ocorrência de "### Destaques".
      const section1 = doc.slice(0, doc.indexOf("### Destaques por categoria"));
      const section1Counts = [...section1.matchAll(/\|\s+(\d+)\s+links\s+\|\s+\d+\s+aberturas/g)].map((m) => Number(m[1]));
      assert.equal(section1Counts.reduce((s, n) => s + n, 0), 15, `bandas devem somar 15 links (5+7+3), contagens: ${section1Counts.join(",")}`);
      assert.ok(linkCounts.length >= section1Counts.length);

      // Survey
      assert.match(doc, /\*\*respondentes survey:\*\* 2/);
      assert.match(doc, /Tutoriais práticos/);
      assert.match(doc, /Tecnologia/);

      // Rodapé
      assert.match(doc, /_Regerado por `scripts\/update-audience\.ts`/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("subscribers=0 (fonte indisponível) → sinaliza explicitamente, nunca 'N' solto (#8150)", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-audience-main-8151-"));
    try {
      writeFileSync(join(dir, "link-ctr-table.csv"), buildCtrCsv(), "utf8");
      // Sem publication.json — subscribers deve resolver pra 0 (fail-soft).
      const deps = baseDeps(dir);
      const result = main(deps);
      assert.equal(result.ok, true);
      const doc = readFileSync(deps.outPath!, "utf8");
      assert.doesNotMatch(doc, /de N subscribers/);
      assert.match(doc, /contagem de subscribers indisponível/);
      assert.doesNotMatch(doc, /\*\*subscribers ativos:\*\*/, "linha de header omitida quando subscribers=0 (mesmo tratamento da Seção 1)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backend kit via getKitActiveSummaryFn injetado — end-to-end através de main()", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-audience-main-8151-"));
    try {
      writeFileSync(join(dir, "link-ctr-table.csv"), buildCtrCsv(), "utf8");
      const fakeDb = { close: () => {} };
      const deps = baseDeps(dir, {
        subscriberBackend: "kit",
        openDbFn: () => fakeDb as ReturnType<typeof import("../scripts/lib/diaria-subscribers-db.ts").openDiariaSubscribersDbSafe>,
        getKitActiveSummaryFn: () => ({ count: 626, asOf: "2026-09-15T00:00:00Z" }),
      });
      const result = main(deps);
      assert.equal(result.ok, true);
      assert.equal(result.subscribers, 626);
      const doc = readFileSync(deps.outPath!, "utf8");
      assert.match(doc, /\*\*subscribers ativos:\*\* 626/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backend kit devolve contagem implausível (1) — #8322: nunca grava '1', nunca omite o campo, sinaliza explícito", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-audience-main-8151-"));
    try {
      writeFileSync(join(dir, "link-ctr-table.csv"), buildCtrCsv(), "utf8");
      // Sem publication.json — o fallback Beehiiv também resolve pra 0, pior
      // caso: nenhuma fonte devolve um número confiável.
      const fakeDb = { close: () => {} };
      const deps = baseDeps(dir, {
        subscriberBackend: "kit",
        openDbFn: () => fakeDb as ReturnType<typeof import("../scripts/lib/diaria-subscribers-db.ts").openDiariaSubscribersDbSafe>,
        // Fixture: a resposta real que produziu "**subscribers ativos:** 1"
        // em docs/audience-history/2026-09-15.md e 2026-09-16.md (#8322).
        getKitActiveSummaryFn: () => ({ count: 1, asOf: "2026-09-16T00:00:00Z" }),
      });
      const result = main(deps);
      assert.equal(result.ok, true);
      assert.notEqual(result.subscribers, 1, "nunca aceita a contagem implausível");
      assert.ok(result.subscriberWarning, "resultado deve carregar o warning explícito");

      const doc = readFileSync(deps.outPath!, "utf8");
      assert.doesNotMatch(doc, /\*\*subscribers ativos:\*\* 1\b/, "nunca grava '1' cru no snapshot");
      assert.doesNotMatch(doc, /comportamento de 1 subscribers?\b/, "nunca a frase 'comportamento de 1 subscriber(s)' — nem a versão historicamente quebrada, nem uma versão corrigida");
      // Campo nunca omitido em silêncio — a linha de header existe, só que
      // como warning explícito em vez do número.
      assert.match(doc, /\*\*subscribers ativos:\*\* indisponível — .*implausível.*#8322/);
      assert.match(doc, /contagem de subscribers indisponível — .*implausível.*#8322/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nenhuma fonte disponível → ok:false com motivo, nada escrito", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-audience-main-8151-"));
    try {
      const deps = baseDeps(dir); // sem CTR CSV nem survey JSON
      const result = main(deps);
      assert.equal(result.ok, false);
      assert.match(result.reason ?? "", /Nenhuma fonte dispon[ií]vel/);
      assert.equal(existsSync(deps.outPath!), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("main() — arquivamento de histórico recebe o conteúdo PRÉ-sobrescrita (#8151 item 3)", () => {
  it("rodar main() 2x num tmpdir: o snapshot arquivado é o conteúdo da 1ª rodada, não da 2ª", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-audience-main-8151-archive-"));
    try {
      writeFileSync(join(dir, "link-ctr-table.csv"), buildCtrCsv(), "utf8");
      writeFileSync(join(dir, "publication.json"), JSON.stringify({ stats: { active_subscriptions: 100 } }), "utf8");

      const day1 = new Date("2026-09-10T12:00:00Z");
      const day2 = new Date("2026-09-11T12:00:00Z");

      const deps1 = baseDeps(dir, { today: day1 });
      const r1 = main(deps1);
      assert.equal(r1.ok, true);
      const contentDay1 = readFileSync(deps1.outPath!, "utf8");
      assert.match(contentDay1, /\*\*updated_at:\*\* 2026-09-10/);

      // 2ª rodada: muda o subscriber count pra garantir que o conteúdo REALMENTE
      // muda entre as duas rodadas (senão o guard do #4366 dispararia por outro
      // motivo e o teste não isolaria o que queremos: QUAL conteúdo foi arquivado).
      writeFileSync(join(dir, "publication.json"), JSON.stringify({ stats: { active_subscriptions: 999 } }), "utf8");
      const deps2 = baseDeps(dir, { today: day2 });
      const r2 = main(deps2);
      assert.equal(r2.ok, true);
      const contentDay2 = readFileSync(deps2.outPath!, "utf8");
      assert.match(contentDay2, /\*\*updated_at:\*\* 2026-09-11/);
      assert.notEqual(contentDay1, contentDay2, "sanity: as 2 rodadas devem produzir conteúdo diferente");

      // O arquivo de histórico é nomeado pela data de HOJE (do run que está
      // arquivando — dia 2), mas seu CONTEÚDO é o que estava em
      // `context/audience-profile.md` ANTES dessa rodada sobrescrever —
      // ou seja, o conteúdo do dia 1. É esse o par (nome=hoje,
      // conteúdo=pré-sobrescrita) que o #8151 item 3 pede pra travar.
      const snapshotPath = join(dir, "audience-history", "2026-09-11.md");
      assert.ok(existsSync(snapshotPath), "snapshot de 2026-09-11.md (data da 2ª rodada) deve existir após ela rodar");
      const snapshot = readFileSync(snapshotPath, "utf8");
      assert.equal(snapshot, contentDay1, "snapshot arquivado deve ser o conteúdo PRÉ-sobrescrita (dia 1), não o dia 2");
      assert.notEqual(snapshot, contentDay2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
