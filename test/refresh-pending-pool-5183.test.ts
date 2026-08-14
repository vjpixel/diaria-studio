/**
 * test/refresh-pending-pool-5183.test.ts (#5183)
 *
 * Etapa nova entre o Passo 1 e o Passo 2 de `/diaria-brevo-diaria`: traz pro
 * pool contatos Pending da Beehiiv cadastrados depois do snapshot congelado
 * de 260802. Cobre: diff puro (3 fontes de "já conhecido"), filtro
 * obrigatório de origem SparkLoop, cota/ritmo da rodada, e o append seguro
 * no CSV bruto (preserva linhas existentes, cria a lane de recência sem
 * inventar score).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Papa from "papaparse";
import {
  computeNewPoolCandidates,
  filterOutSparkloop,
  applyRefreshLimit,
  buildNewPoolRow,
  appendRowsToPoolCsv,
  readPoolEmailColumn,
  DEFAULT_REFRESH_LIMIT,
  NEW_CONTACT_ORIGIN_LABEL,
} from "../scripts/refresh-pending-pool.ts";
import { LANE_RECENCY, RAW_POOL_CSV_FIELDS, parseScoredRow, sortByScoreDescending } from "../scripts/score-pending-origin.ts";
import {
  computeContactsToIngest,
  selectContactsForBackfill,
  type BeehiivPendingSubscription,
  type PendingToIngestEntry,
} from "../scripts/sync-pending-to-brevo.ts";
import type { BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";

function sub(email: string, overrides: Partial<BeehiivPendingSubscription> = {}): BeehiivPendingSubscription {
  return { id: "sub-" + email, email, rhSource: "", subscribedOn: "2026-08-13T00:00:00.000Z", ...overrides };
}

describe("computeNewPoolCandidates — diff contra pool (bruto+computado) E store (#5183)", () => {
  it("Pending ausente de todas as 3 fontes → candidato", () => {
    const out = computeNewPoolCandidates([sub("new@b.com")], new Set(), new Set());
    assert.equal(out.length, 1);
    assert.equal(out[0].email, "new@b.com");
  });

  it("Pending já no pool (bruto ou computado, união prévia) → nunca candidato", () => {
    const out = computeNewPoolCandidates([sub("old@b.com")], new Set(["old@b.com"]), new Set());
    assert.equal(out.length, 0);
  });

  it("Pending já no store (qualquer status) → nunca candidato, mesmo fora do pool CSV", () => {
    const out = computeNewPoolCandidates([sub("tracked@b.com")], new Set(), new Set(["tracked@b.com"]));
    assert.equal(out.length, 0);
  });

  it("dedup interno da própria página Pending (mesmo email 2x)", () => {
    const out = computeNewPoolCandidates([sub("dup@b.com"), sub("dup@b.com")], new Set(), new Set());
    assert.equal(out.length, 1);
  });

  it("mistura: só quem está fora das 3 fontes vira candidato", () => {
    const pending = [sub("a@b.com"), sub("b@b.com"), sub("c@b.com")];
    const out = computeNewPoolCandidates(pending, new Set(["a@b.com"]), new Set(["b@b.com"]));
    assert.deepEqual(out.map((c) => c.email), ["c@b.com"]);
  });
});

describe("filterOutSparkloop — filtro OBRIGATÓRIO de origem (#5183 decisão 1)", () => {
  it("RH_SOURCE=sparkloop-upscribe → excluído, nunca kept", () => {
    const candidates = [sub("spark@b.com", { rhSource: "sparkloop-upscribe" }), sub("organic@b.com", { rhSource: "" })];
    const { kept, excluded } = filterOutSparkloop(candidates);
    assert.deepEqual(kept.map((c) => c.email), ["organic@b.com"]);
    assert.deepEqual(excluded.map((c) => c.email), ["spark@b.com"]);
  });

  it("case/trim insensível (mesmo fingerprint de isSparkloopUpscribeSource)", () => {
    const candidates = [sub("spark2@b.com", { rhSource: "  SparkLoop-Upscribe  " })];
    const { kept, excluded } = filterOutSparkloop(candidates);
    assert.equal(kept.length, 0);
    assert.equal(excluded.length, 1);
  });

  it("origem diferente/ausente → mantido", () => {
    const candidates = [sub("a@b.com", { rhSource: "outro-parceiro" }), sub("b@b.com", { rhSource: "" })];
    const { kept, excluded } = filterOutSparkloop(candidates);
    assert.equal(kept.length, 2);
    assert.equal(excluded.length, 0);
  });
});

describe("applyRefreshLimit — cota/ritmo conservador (#5183 decisão 3)", () => {
  it("corta na cota informada", () => {
    const out = applyRefreshLimit([1, 2, 3, 4, 5], 2);
    assert.deepEqual(out, [1, 2]);
  });

  it("cota maior que a lista → devolve tudo", () => {
    const out = applyRefreshLimit([1, 2], 100);
    assert.deepEqual(out, [1, 2]);
  });

  it("cota 0 → lista vazia", () => {
    assert.deepEqual(applyRefreshLimit([1, 2], 0), []);
  });

  it("DEFAULT_REFRESH_LIMIT é um número pequeno e positivo (documentado no header do módulo)", () => {
    assert.ok(DEFAULT_REFRESH_LIMIT > 0 && DEFAULT_REFRESH_LIMIT <= 50);
  });
});

describe("buildNewPoolRow — lane própria, sem inventar score (#5183 decisão 2)", () => {
  it("score/pts_* zerados, lane=recency, origem = NEW_CONTACT_ORIGIN_LABEL", () => {
    const row = buildNewPoolRow(sub("novo@b.com", { subscribedOn: "2026-08-14T10:00:00.000Z" }));
    assert.equal(row.email, "novo@b.com");
    assert.equal(row.origem, NEW_CONTACT_ORIGIN_LABEL);
    assert.equal(row.score, "0");
    assert.equal(row.lane, LANE_RECENCY);
    assert.equal(row.subscribed_on, "2026-08-14T10:00:00.000Z");
  });

  it("linha gerada passa na validação de consistência de score-pending-origin.ts (soma dos pts_* bate com score)", () => {
    const row = buildNewPoolRow(sub("novo@b.com"));
    // parseScoredRow espera Record<string,string> — a linha construída já é isso.
    assert.doesNotThrow(() => parseScoredRow(row, 2));
    const parsed = parseScoredRow(row, 2);
    assert.equal(parsed.lane, LANE_RECENCY);
    assert.equal(parsed.score, 0);
  });
});

describe("appendRowsToPoolCsv — append seguro, preserva linhas existentes (#5183)", () => {
  it("CSV existente sem lane/subscribed_on → header estendido, linhas antigas preservadas com lane=''", () => {
    const csv = "email,origem,score,pts_confirmacao,pts_ativo,pts_abertura,pts_clique,pts_recencia,penalidade_bounce\n" +
      "old@b.com,canal-proprio,78.7,21.2,14.4,17.2,12.1,14.3,-0.5\n";
    const newRow = buildNewPoolRow(sub("new@b.com", { subscribedOn: "2026-08-14T00:00:00.000Z" }));
    const out = appendRowsToPoolCsv(csv, [newRow]);
    const parsed = Papa.parse<Record<string, string>>(out, { header: true, skipEmptyLines: true });
    assert.equal(parsed.data.length, 2);
    const old = parsed.data.find((r) => r.email === "old@b.com")!;
    assert.equal(old.score, "78.7", "valor numérico original preservado como string, sem reformatar");
    assert.equal(old.lane, "", "linha antiga ganha lane vazio (retrocompat)");
    const added = parsed.data.find((r) => r.email === "new@b.com")!;
    assert.equal(added.lane, LANE_RECENCY);
    assert.equal(added.subscribed_on, "2026-08-14T00:00:00.000Z");
  });

  it("CSV vazio/ausente (1ª execução) → cria do zero com RAW_POOL_CSV_FIELDS", () => {
    const newRow = buildNewPoolRow(sub("first@b.com"));
    const out = appendRowsToPoolCsv("", [newRow]);
    const parsed = Papa.parse<Record<string, string>>(out, { header: true, skipEmptyLines: true });
    assert.deepEqual(parsed.meta.fields, [...RAW_POOL_CSV_FIELDS]);
    assert.equal(parsed.data.length, 1);
    assert.equal(parsed.data[0].email, "first@b.com");
  });

  it("CSV malformado (aspas não fechadas) → lança, nunca faz append silencioso sobre lixo", () => {
    assert.throws(() => appendRowsToPoolCsv('email,origem\n"unterminated', [buildNewPoolRow(sub("a@b.com"))]), /malformado/);
  });

  it("múltiplas linhas novas na mesma chamada, todas presentes no resultado", () => {
    const out = appendRowsToPoolCsv("", [buildNewPoolRow(sub("a@b.com")), buildNewPoolRow(sub("b@b.com"))]);
    const parsed = Papa.parse<Record<string, string>>(out, { header: true, skipEmptyLines: true });
    assert.deepEqual(parsed.data.map((r) => r.email).sort(), ["a@b.com", "b@b.com"]);
  });
});

describe("readPoolEmailColumn — leitura fail-soft (#5183)", () => {
  it("arquivo ausente → Set vazio, nunca lança", () => {
    const result = readPoolEmailColumn(resolve(tmpdir(), "nao-existe-5183-" + Date.now() + ".csv"));
    assert.deepEqual(result, new Set());
  });

  it("CSV bem-formado → Set de emails normalizados", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pool-emails-"));
    try {
      const path = resolve(dir, "pool.csv");
      writeFileSync(path, "email,origem,score\n  Foo@Bar.COM  ,x,1\nbaz@qux.com,y,2\n", "utf8");
      const result = readPoolEmailColumn(path);
      assert.deepEqual(result, new Set(["foo@bar.com", "baz@qux.com"]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("também funciona no formato do CSV COMPUTADO (coluna origin, não origem — só email importa aqui)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pool-emails-"));
    try {
      const path = resolve(dir, "computed.csv");
      writeFileSync(path, "email,origin,score,lane,subscribed_on\na@b.com,x,10,,\n", "utf8");
      const result = readPoolEmailColumn(path);
      assert.deepEqual(result, new Set(["a@b.com"]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Integração — refresh + score-pending-origin no mesmo arquivo (#5183, fecha o gap do guard de cobertura)", () => {
  it("append + reparse via parseScoredRow: contato novo sobrevive ao ciclo bruto→validado com lane preservada", () => {
    const csv = "email,origem,score,pts_confirmacao,pts_ativo,pts_abertura,pts_clique,pts_recencia,penalidade_bounce\n" +
      "old@b.com,canal-proprio,10,3,2,2,2,1,0\n";
    const out = appendRowsToPoolCsv(csv, [buildNewPoolRow(sub("recent@b.com", { subscribedOn: "2026-08-14T00:00:00.000Z" }))]);
    const parsed = Papa.parse<Record<string, string>>(out, { header: true, skipEmptyLines: true, delimiter: "," });
    const rows = parsed.data.map((raw, i) => parseScoredRow(raw, i + 2));
    assert.equal(rows.length, 2);
    const recent = rows.find((r) => r.email === "recent@b.com")!;
    assert.equal(recent.lane, LANE_RECENCY);
    const old = rows.find((r) => r.email === "old@b.com")!;
    assert.equal(old.lane, "", "linha antiga sem coluna lane no CSV original vira '' depois do round-trip");
  });

  it("PONTA A PONTA — critério de aceite da issue: um Pending novo elegível só aparece entre os candidatos do dry-run DEPOIS de --push + score-pending-origin.ts + verify-pending-emails-mv.ts; antes disso, fica de fora mesmo já estando no pool", () => {
    const rawPoolCsv = "email,origem,score,pts_confirmacao,pts_ativo,pts_abertura,pts_clique,pts_recencia,penalidade_bounce\n" +
      "old-high@b.com,canal-proprio,90,20,20,20,20,10,0\n";
    const beehiivPending: BeehiivPendingSubscription[] = [
      { id: "sub-recent", email: "recent@b.com", rhSource: "", subscribedOn: "2026-08-14T00:00:00.000Z" },
    ];
    const store: BrevoDiariaStore = { contacts: [] };

    // 1) refresh-pending-pool.ts --push: diff + filtro + append no pool bruto.
    const known = new Set<string>(); // pool bruto vazio de "recent@b.com" — candidato
    const candidates = computeNewPoolCandidates(beehiivPending, known, new Set(store.contacts.map((c) => c.email)));
    const { kept } = filterOutSparkloop(candidates);
    const selectedForRefresh = applyRefreshLimit(kept, DEFAULT_REFRESH_LIMIT);
    const rawPoolAfterRefresh = appendRowsToPoolCsv(rawPoolCsv, selectedForRefresh.map(buildNewPoolRow));

    // 2) score-pending-origin.ts: valida + ordena (recent@b.com score 0 → passa trivialmente).
    const parsedRaw = Papa.parse<Record<string, string>>(rawPoolAfterRefresh, { header: true, skipEmptyLines: true, delimiter: "," });
    const parsedRows = parsedRaw.data.map((raw, i) => parseScoredRow(raw, i + 2));
    const sorted = sortByScoreDescending(parsedRows);
    const scoreByEmail = new Map(sorted.map((r) => [r.email, r.score]));
    const laneByEmail = new Map(sorted.map((r) => [r.email, r.lane]));

    // 3a) ANTES de verify-pending-emails-mv.ts: recent@b.com está no pool
    // (score/lane conhecidos) mas AINDA não verificado — computeContactsToIngest
    // continua excluindo (critério de aceite: "nunca cria atalho").
    const pendingFromBeehiiv = beehiivPending; // sync-pending-to-brevo.ts também pagina Pending
    const noVerificationYet = computeContactsToIngest(pendingFromBeehiiv, store, new Set(["old-high@b.com"])); // MV nunca viu recent@b.com
    assert.deepEqual(noVerificationYet.map((c) => c.email), [], "sem passar pela MV, recent@b.com nunca é candidato — mesmo já estando no pool");

    // 3b) DEPOIS de verify-pending-emails-mv.ts (recent@b.com agora em mv-verified.csv):
    const verifiedEmails = new Set(["old-high@b.com", "recent@b.com"]);
    const toIngest = computeContactsToIngest(pendingFromBeehiiv, store, verifiedEmails);
    assert.deepEqual(toIngest.map((c) => c.email), ["recent@b.com"], "agora recent@b.com é candidato elegível");

    // Seleção final do dry-run de sync-pending-to-brevo.ts: lane de recência
    // prioritária, sem competir por score com old-high@b.com.
    const allCandidates: PendingToIngestEntry[] = [
      { email: "old-high@b.com", beehiiv_subscription_id: "sub-old" },
      ...toIngest,
    ];
    const selected = selectContactsForBackfill(allCandidates, 10, scoreByEmail, laneByEmail);
    assert.ok(selected.some((c) => c.email === "recent@b.com"), "recent@b.com aparece entre os candidatos do dry-run final");
    assert.equal(selected[0].email, "recent@b.com", "lane de recência prioritária, mesmo com old-high@b.com pontuando mais alto");
  });
});
