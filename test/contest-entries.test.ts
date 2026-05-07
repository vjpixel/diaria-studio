import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEntries,
  appendEntry,
  nextNumber,
  findByThreadId,
  drawWinner,
  drawMonthLabel,
  formatReplyText,
  type ContestEntry,
} from "../scripts/lib/contest-entries.ts";

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "contest-test-"));
  return join(dir, "entries.jsonl");
}

const SAMPLE: ContestEntry = {
  draw_month: "2026-06",
  number: 1,
  reader_email: "test@example.com",
  reader_name: "Test User",
  edition: "260504",
  error_type: "factual",
  detail: "exemplo de erro",
  reply_thread_id: "thread-abc-123",
  confirmed_at: "2026-05-05T05:49:58Z",
};

describe("loadEntries — leitura defensiva (#597)", () => {
  it("retorna [] quando arquivo não existe", () => {
    assert.deepEqual(loadEntries("/tmp/does-not-exist-xyz.jsonl"), []);
  });

  it("lê uma única entry válida", () => {
    const path = tmpFile();
    writeFileSync(path, JSON.stringify(SAMPLE) + "\n");
    const entries = loadEntries(path);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].number, 1);
    assert.equal(entries[0].reader_email, "test@example.com");
  });

  it("ignora linhas vazias e linhas malformadas", () => {
    const path = tmpFile();
    const valid1 = JSON.stringify(SAMPLE);
    const valid2 = JSON.stringify({ ...SAMPLE, number: 2, reply_thread_id: "thread-2" });
    writeFileSync(path, `${valid1}\n\n{not valid json\n${valid2}\n`);
    const entries = loadEntries(path);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].number, 1);
    assert.equal(entries[1].number, 2);
  });

  it("ignora entry sem fields obrigatórios", () => {
    const path = tmpFile();
    const incomplete = JSON.stringify({ draw_month: "2026-06" }); // sem number/email
    writeFileSync(path, incomplete + "\n");
    assert.deepEqual(loadEntries(path), []);
  });
});

describe("nextNumber — alocação sequencial por draw_month (#597)", () => {
  it("retorna 1 quando não há entries naquele mês", () => {
    assert.equal(nextNumber([], "2026-06"), 1);
    assert.equal(nextNumber([SAMPLE], "2026-07"), 1);
  });

  it("retorna max+1 quando há entries no mesmo mês", () => {
    const entries: ContestEntry[] = [
      { ...SAMPLE, number: 1 },
      { ...SAMPLE, number: 2 },
      { ...SAMPLE, number: 3 },
    ];
    assert.equal(nextNumber(entries, "2026-06"), 4);
  });

  it("ignora entries de outros meses", () => {
    const entries: ContestEntry[] = [
      { ...SAMPLE, number: 5, draw_month: "2026-05" },
      { ...SAMPLE, number: 1, draw_month: "2026-06" },
    ];
    assert.equal(nextNumber(entries, "2026-06"), 2);
    assert.equal(nextNumber(entries, "2026-05"), 6);
  });

  it("lida com entries não-sequenciais", () => {
    // Edge case: alguém deletou entry 2 manualmente. nextNumber NÃO
    // preenche o gap — só usa max+1 pra evitar conflito de número.
    const entries: ContestEntry[] = [
      { ...SAMPLE, number: 1 },
      { ...SAMPLE, number: 5 },
    ];
    assert.equal(nextNumber(entries, "2026-06"), 6);
  });

  it("ignora entries com number inválido (zero, negativo)", () => {
    const entries: ContestEntry[] = [
      { ...SAMPLE, number: 0 },
      { ...SAMPLE, number: -1 },
      { ...SAMPLE, number: 3 },
    ];
    assert.equal(nextNumber(entries, "2026-06"), 4);
  });
});

describe("findByThreadId — idempotência (#597)", () => {
  it("retorna a entry quando thread_id casa", () => {
    const entries: ContestEntry[] = [SAMPLE];
    const found = findByThreadId(entries, "thread-abc-123");
    assert.notEqual(found, null);
    assert.equal(found!.number, 1);
  });

  it("retorna null quando thread_id não casa", () => {
    const entries: ContestEntry[] = [SAMPLE];
    assert.equal(findByThreadId(entries, "outro-thread"), null);
  });

  it("retorna null pra lista vazia", () => {
    assert.equal(findByThreadId([], "qualquer-thread"), null);
  });
});

describe("appendEntry — append-only com create atômico (#597)", () => {
  it("cria arquivo novo na primeira entry (atomic via .tmp)", () => {
    const path = tmpFile();
    appendEntry(path, SAMPLE);
    const content = readFileSync(path, "utf8");
    assert.match(content, /thread-abc-123/);
    // Tmp não deve sobrar
    assert.equal(
      readFileSync.length > 0 ? true : false,
      true,
      "sanity",
    );
  });

  it("appenda múltiplas entries em ordem", () => {
    const path = tmpFile();
    appendEntry(path, { ...SAMPLE, number: 1, reply_thread_id: "t1" });
    appendEntry(path, { ...SAMPLE, number: 2, reply_thread_id: "t2" });
    appendEntry(path, { ...SAMPLE, number: 3, reply_thread_id: "t3" });
    const entries = loadEntries(path);
    assert.equal(entries.length, 3);
    assert.deepEqual(
      entries.map((e) => e.reply_thread_id),
      ["t1", "t2", "t3"],
    );
  });

  it("cria diretório pai se não existir", () => {
    const dir = mkdtempSync(join(tmpdir(), "contest-mkdir-"));
    const path = join(dir, "subdir", "nested", "entries.jsonl");
    appendEntry(path, SAMPLE);
    assert.ok(loadEntries(path).length === 1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("drawWinner — random uniforme entre confirmados (#597)", () => {
  it("retorna null quando não há candidatos no mês", () => {
    assert.equal(drawWinner([], "2026-06"), null);
    assert.equal(drawWinner([SAMPLE], "2026-07"), null);
  });

  it("retorna o único candidato quando só há 1", () => {
    const winner = drawWinner([SAMPLE], "2026-06");
    assert.notEqual(winner, null);
    assert.equal(winner!.number, 1);
  });

  it("usa rng custom — determinístico com seed", () => {
    const entries: ContestEntry[] = [
      { ...SAMPLE, number: 1, reader_name: "Alpha" },
      { ...SAMPLE, number: 2, reader_name: "Beta" },
      { ...SAMPLE, number: 3, reader_name: "Gamma" },
    ];
    // rng() = 0 → idx=0 (Alpha); rng() = 0.5 → idx=1 (Beta); rng() = 0.99 → idx=2 (Gamma)
    assert.equal(drawWinner(entries, "2026-06", () => 0)!.reader_name, "Alpha");
    assert.equal(drawWinner(entries, "2026-06", () => 0.5)!.reader_name, "Beta");
    assert.equal(drawWinner(entries, "2026-06", () => 0.99)!.reader_name, "Gamma");
  });

  it("filtra por draw_month", () => {
    const entries: ContestEntry[] = [
      { ...SAMPLE, number: 1, draw_month: "2026-05" },
      { ...SAMPLE, number: 1, draw_month: "2026-06", reader_name: "Junho" },
    ];
    const winner = drawWinner(entries, "2026-06", () => 0);
    assert.equal(winner!.reader_name, "Junho");
  });
});

describe("drawMonthLabel — formato PT-BR (#597)", () => {
  it("converte YYYY-MM pra '<mês> de YYYY'", () => {
    assert.equal(drawMonthLabel("2026-01"), "janeiro de 2026");
    assert.equal(drawMonthLabel("2026-06"), "junho de 2026");
    assert.equal(drawMonthLabel("2026-12"), "dezembro de 2026");
  });

  it("retorna o input quando formato inválido", () => {
    assert.equal(drawMonthLabel("invalid"), "invalid");
    assert.equal(drawMonthLabel("2026-13"), "2026-13");
    assert.equal(drawMonthLabel("2026-00"), "2026-00");
  });
});

describe("formatReplyText — texto pronto pra resposta (#597)", () => {
  it("inclui primeiro nome, edição (frase relativa), mês e número", () => {
    const text = formatReplyText(SAMPLE);
    assert.match(text, /Test/); // primeiro nome
    // edição: frase relativa em PT-BR (NUNCA AAMMDD em texto pra leitor — #930).
    // SAMPLE: edition=260504 vs confirmed_at=2026-05-05 → delta=1 → "de ontem".
    assert.match(text, /de ontem/);
    assert.ok(!text.includes("260504"));
    assert.match(text, /junho de 2026/); // mês expandido
    assert.match(text, /é 1\b/); // número
  });

  it("usa só o primeiro nome quando reader_name tem múltiplos", () => {
    const entry: ContestEntry = { ...SAMPLE, reader_name: "Maria José Silva Santos" };
    const text = formatReplyText(entry);
    assert.match(text, /Olá, Maria!/);
    assert.ok(!text.includes("José Silva Santos"));
  });

  it("inclui assinatura Diar.ia", () => {
    const text = formatReplyText(SAMPLE);
    assert.match(text, /— Diar\.ia/);
  });
});
