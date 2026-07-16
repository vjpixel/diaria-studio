import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aammddFromIso,
  extractUrlsFromApproved,
  populateLinksFromApproved,
  populateAllFromApproved,
  type Post,
} from "../scripts/refresh-past-editions.ts";
import { resolveRunLogPath } from "../scripts/lib/run-log.ts";
import { enumerateEditionDirs } from "../scripts/lib/find-current-edition.ts";

/**
 * Tests do fix #238 — popular `links[]` em past-editions a partir do
 * `_internal/01-approved.json` local de cada edição produzida nesta máquina.
 * Source-of-truth completo, sem dependência de Beehiiv API.
 */

describe("aammddFromIso (#238)", () => {
  it("converte ISO em horário de dia BR (sem ambiguidade UTC vs BR)", () => {
    // 13:00 UTC = 10:00 BR (UTC-3). Mesmo dia em ambos.
    assert.equal(aammddFromIso("2026-04-25T13:00:00Z"), "260425");
    assert.equal(aammddFromIso("2025-12-31T15:00:00Z"), "251231");
    assert.equal(aammddFromIso("2027-01-01T18:00:00Z"), "270101");
  });

  it("ISO date-only é tratado como dia BR sem rolagem timezone (guard)", () => {
    // Sem o guard, "2026-04-25" viraria 260424 (UTC midnight = 21h BR dia-1).
    // Com guard: trata como dia BR explícito.
    assert.equal(aammddFromIso("2026-04-25"), "260425");
    assert.equal(aammddFromIso("2025-12-31"), "251231");
    // Whitespace tolerância
    assert.equal(aammddFromIso("  2026-04-25  "), "260425");
  });

  it("retorna string vazia em ISO inválido", () => {
    assert.equal(aammddFromIso("garbage"), "");
    assert.equal(aammddFromIso(""), "");
  });

  it("usa BR timezone — publicação noite BR fica no AAMMDD do dia BR (não UTC)", () => {
    // Cenário real: edição "260425" publica às 22:30 BR (= 01:30 UTC do 26).
    // Com UTC: AAMMDD = 260426 → script procura pasta errada.
    // Com BR: AAMMDD = 260425 → script encontra a pasta correta.
    assert.equal(aammddFromIso("2026-04-26T01:30:00Z"), "260425");
    assert.equal(aammddFromIso("2026-04-26T02:59:00Z"), "260425");
  });

  it("publicação madrugada BR fica no AAMMDD BR correto", () => {
    // 02:00 BR de 25/abr = 05:00 UTC de 25/abr. Mesmo dia em ambos.
    assert.equal(aammddFromIso("2026-04-25T05:00:00Z"), "260425");
  });

  it("publicação 03:00 UTC = meia-noite BR (transição)", () => {
    // Exatamente 03:00 UTC vira 00:00 BR — boundary.
    assert.equal(aammddFromIso("2026-04-25T03:00:00Z"), "260425");
    // 02:59 UTC vira 23:59 BR do dia anterior.
    assert.equal(aammddFromIso("2026-04-25T02:59:00Z"), "260424");
  });
});

describe("extractUrlsFromApproved (#238)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "approved-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeApproved(yymmdd: string, content: unknown) {
    // #3024 follow-up: editionDir() agora retorna o layout nested
    // (data/editions/{AAMM}/{AAMMDD}/) — fixture precisa espelhar isso.
    const dir = join(tmpRoot, "data/editions", yymmdd.slice(0, 4), yymmdd, "_internal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-approved.json"), JSON.stringify(content), "utf8");
  }

  it("retorna [] quando arquivo não existe", () => {
    const urls = extractUrlsFromApproved("260101", tmpRoot);
    assert.deepEqual(urls, []);
  });

  it("retorna [] quando yymmdd vazio", () => {
    const urls = extractUrlsFromApproved("", tmpRoot);
    assert.deepEqual(urls, []);
  });

  it("retorna [] quando JSON é malformado", () => {
    const dir = join(tmpRoot, "data/editions/2604/260425/_internal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-approved.json"), "{ not json", "utf8");
    const urls = extractUrlsFromApproved("260425", tmpRoot);
    assert.deepEqual(urls, []);
  });

  // #3498 item 1: antes do fix, JSON corrompido caía num catch silencioso —
  // mesmo sintoma do "arquivo ausente" que o #3495 corrigiu (URL some da
  // camada de dedup #238 sem nenhum sinal), mas sem o warn. Cenário concreto:
  // write interrompido durante sync do junction OneDrive (onde `data/` mora).
  it("emite warn no run-log quando JSON é malformado, mas ainda extrai [] sem crashar (#3498)", () => {
    const dir = join(tmpRoot, "data/editions/2604/260425/_internal");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "01-approved.json");
    writeFileSync(path, "{ not json", "utf8");

    const urls = extractUrlsFromApproved("260425", tmpRoot);
    assert.deepEqual(urls, []);

    const logPath = resolveRunLogPath(tmpRoot);
    assert.ok(existsSync(logPath), "run-log.jsonl deveria ter sido escrito");
    const entry = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").pop()!);
    assert.equal(entry.level, "warn");
    assert.equal(entry.edition, "260425");
    assert.equal(entry.agent, "refresh-past-editions");
    assert.match(entry.message, /JSON inválido/);
    assert.match(entry.details.error, /.+/); // erro de parse propagado nos details
  });

  // #3498 item 2: URLs válidas de edições distintas continuam extraídas
  // corretamente quando resolvidas via cache pré-computado (em vez de uma
  // varredura de disco por chamada) — a otimização não deve mudar o resultado.
  it("extrai URLs corretamente quando editionDirsCache pré-computado é fornecido (#3498)", () => {
    const flatDir = join(tmpRoot, "data/editions/260715/_internal");
    mkdirSync(flatDir, { recursive: true });
    writeFileSync(
      join(flatDir, "01-approved.json"),
      JSON.stringify({
        highlights: [{ article: { url: "https://flat-cache.com/post" } }],
        runners_up: [],
        lancamento: [],
        radar: [],
      }),
      "utf8",
    );
    const nestedDir = join(tmpRoot, "data/editions/2604/260425/_internal");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(
      join(nestedDir, "01-approved.json"),
      JSON.stringify({
        highlights: [{ article: { url: "https://nested-cache.com/post" } }],
        runners_up: [],
        lancamento: [],
        radar: [],
      }),
      "utf8",
    );

    // 1 varredura só, reusada pras duas edições (flat + nested).
    const cache = enumerateEditionDirs(join(tmpRoot, "data/editions"));
    assert.deepEqual(extractUrlsFromApproved("260715", tmpRoot, cache), [
      "https://flat-cache.com/post",
    ]);
    assert.deepEqual(extractUrlsFromApproved("260425", tmpRoot, cache), [
      "https://nested-cache.com/post",
    ]);
  });

  // #3498 item 2: quando um cache é fornecido mas não contém a edição, a
  // função cai no path nested default (O(1), sem re-escanear o disco) em vez
  // de fazer sua própria varredura pra "se autocorrigir" — prova que a
  // otimização de fato evita o custo repetido (o objetivo do fix), não só
  // delega pra baixo silenciosamente.
  it("com cache que não contém a edição, cai no path nested default sem re-escanear o disco (#3498)", () => {
    const flatDir = join(tmpRoot, "data/editions/260715/_internal");
    mkdirSync(flatDir, { recursive: true });
    writeFileSync(
      join(flatDir, "01-approved.json"),
      JSON.stringify({
        highlights: [{ article: { url: "https://flat.com/x" } }],
        runners_up: [],
        lancamento: [],
        radar: [],
      }),
      "utf8",
    );

    const staleCache = new Map<string, string>(); // não conhece 260715
    const urls = extractUrlsFromApproved("260715", tmpRoot, staleCache);
    // Path nested default (data/editions/2607/260715) não existe no disco —
    // função não re-varre pra achar o flat real, então retorna [].
    assert.deepEqual(urls, []);
  });

  it("extrai URLs de todos os buckets + highlights + runners_up", () => {
    writeApproved("260425", {
      highlights: [
        { rank: 1, score: 92, article: { url: "https://h1.com/post" } },
        { rank: 2, score: 88, article: { url: "https://h2.com/post" } },
        { rank: 3, score: 80, article: { url: "https://h3.com/post" } },
      ],
      runners_up: [
        { article: { url: "https://r1.com/post" } },
        { article: { url: "https://r2.com/post" } },
      ],
      lancamento: [
        { url: "https://l1.com/launch" },
        { url: "https://l2.com/launch" },
      ],
      radar: [
        { url: "https://p1.com/paper" },
        { url: "https://n1.com/news" },
        { url: "https://n2.com/news" }
      ],
    });
    const urls = extractUrlsFromApproved("260425", tmpRoot);
    assert.equal(urls.length, 10);
    assert.ok(urls.includes("https://h1.com/post"));
    assert.ok(urls.includes("https://r1.com/post"));
    assert.ok(urls.includes("https://l1.com/launch"));
    assert.ok(urls.includes("https://p1.com/paper"));
    assert.ok(urls.includes("https://n1.com/news"));
  });

  it("dedupa URLs presentes em múltiplos buckets", () => {
    writeApproved("260425", {
      highlights: [{ article: { url: "https://shared.com/x" } }],
      runners_up: [],
      lancamento: [{ url: "https://shared.com/x" }],
      radar: [],
    });
    const urls = extractUrlsFromApproved("260425", tmpRoot);
    assert.equal(urls.length, 1);
    assert.equal(urls[0], "https://shared.com/x");
  });

  it("aceita highlight com URL flat (formato pré-#229)", () => {
    writeApproved("260425", {
      highlights: [
        { url: "https://flat.com/post" }, // formato legado
        { article: { url: "https://nested.com/post" } }, // formato spec
      ],
      runners_up: [],
      lancamento: [],
      radar: [],
    });
    const urls = extractUrlsFromApproved("260425", tmpRoot);
    assert.equal(urls.length, 2);
    assert.ok(urls.includes("https://flat.com/post"));
    assert.ok(urls.includes("https://nested.com/post"));
  });

  it("ignora entries sem url", () => {
    writeApproved("260425", {
      highlights: [{ article: {} }, { article: { url: "" } }],
      runners_up: [],
      lancamento: [{ url: "https://valid.com/post" }, {}],
      radar: [],
    });
    const urls = extractUrlsFromApproved("260425", tmpRoot);
    assert.equal(urls.length, 1);
    assert.equal(urls[0], "https://valid.com/post");
  });

  it("aceita use_melhor bucket opcional (#59)", () => {
    writeApproved("260425", {
      highlights: [],
      runners_up: [],
      lancamento: [],
      radar: [],
      use_melhor: [{ url: "https://tut.com/aprenda" }],
    });
    const urls = extractUrlsFromApproved("260425", tmpRoot);
    assert.deepEqual(urls, ["https://tut.com/aprenda"]);
  });

  // #3495: extractUrlsFromApproved usava editionDir() — sempre nested, sem
  // checar o disco. Uma edição em layout FLAT (data/editions/{AAMMDD}/, sem
  // contraparte nested) resolvia pra um path inexistente e caía no
  // `return []` silencioso ANTES do fix, mesmo com 01-approved.json presente
  // no layout flat. Este teste falharia (urls.length === 0) com o bug
  // presente — só passa porque extractUrlsFromApproved agora usa
  // resolveEditionDir() (disk-aware, cobre flat+nested).
  it("extrai URLs de edição em layout FLAT, sem contraparte nested (#3495)", () => {
    const flatDir = join(tmpRoot, "data/editions/260715/_internal");
    mkdirSync(flatDir, { recursive: true });
    writeFileSync(
      join(flatDir, "01-approved.json"),
      JSON.stringify({
        highlights: [{ article: { url: "https://flat-edition.com/post" } }],
        runners_up: [],
        lancamento: [],
        radar: [],
      }),
      "utf8",
    );
    const urls = extractUrlsFromApproved("260715", tmpRoot);
    assert.deepEqual(urls, ["https://flat-edition.com/post"]);
  });

  // #3495 item 2: "não achei" (edição nunca existiu no disco) e "achei e
  // 01-approved.json está ausente" (camada de dedup silenciosamente morta
  // pra essa edição) precisam ser distinguíveis via warn no run-log.
  describe("warn no run-log (#3495)", () => {
    it("emite warn quando a edição existe no disco (nested) mas 01-approved.json falta", () => {
      const nestedDir = join(tmpRoot, "data/editions/2604/260425");
      mkdirSync(nestedDir, { recursive: true }); // sem _internal/01-approved.json
      const urls = extractUrlsFromApproved("260425", tmpRoot);
      assert.deepEqual(urls, []);

      const logPath = resolveRunLogPath(tmpRoot);
      assert.ok(existsSync(logPath), "run-log.jsonl deveria ter sido escrito");
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      const entry = JSON.parse(lines[lines.length - 1]);
      assert.equal(entry.level, "warn");
      assert.equal(entry.edition, "260425");
      assert.equal(entry.agent, "refresh-past-editions");
      assert.match(entry.message, /01-approved\.json não encontrado/);
    });

    it("emite warn quando a edição existe no disco (flat) mas 01-approved.json falta", () => {
      const flatDir = join(tmpRoot, "data/editions/260715");
      mkdirSync(flatDir, { recursive: true }); // sem _internal/01-approved.json
      const urls = extractUrlsFromApproved("260715", tmpRoot);
      assert.deepEqual(urls, []);

      const logPath = resolveRunLogPath(tmpRoot);
      assert.ok(existsSync(logPath), "run-log.jsonl deveria ter sido escrito");
      const entry = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").pop()!);
      assert.equal(entry.level, "warn");
      assert.equal(entry.edition, "260715");
    });

    it("NÃO emite warn quando a edição não existe no disco em layout nenhum (regressão)", () => {
      // Guard contra over-warning: edição que nunca foi produzida nesta
      // máquina (ex: produzida em outra máquina, sem sync) continua
      // silenciosa — comportamento pré-existente preservado.
      const urls = extractUrlsFromApproved("260101", tmpRoot);
      assert.deepEqual(urls, []);

      const logPath = resolveRunLogPath(tmpRoot);
      assert.equal(existsSync(logPath), false, "run-log.jsonl não deveria existir");
    });
  });
});

describe("populateLinksFromApproved (#238)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "approved-pop-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeApproved(yymmdd: string, urls: string[]) {
    // #3024 follow-up: editionDir() agora retorna o layout nested
    // (data/editions/{AAMM}/{AAMMDD}/) — fixture precisa espelhar isso.
    const dir = join(tmpRoot, "data/editions", yymmdd.slice(0, 4), yymmdd, "_internal");
    mkdirSync(dir, { recursive: true });
    const content = {
      highlights: [],
      runners_up: [],
      lancamento: urls.map((url) => ({ url })),
      radar: [],
    };
    writeFileSync(join(dir, "01-approved.json"), JSON.stringify(content), "utf8");
  }

  function makePost(overrides: Partial<Post> = {}): Post {
    return {
      id: "p1",
      title: "Edição teste",
      published_at: "2026-04-25T10:00:00Z",
      ...overrides,
    };
  }

  it("popula post.links a partir do approved.json local", () => {
    writeApproved("260425", ["https://a.com/1", "https://b.com/2"]);
    const post = makePost();
    const r = populateLinksFromApproved(post, tmpRoot);
    assert.equal(r.populated, 2);
    assert.deepEqual(post.links, ["https://a.com/1", "https://b.com/2"]);
  });

  it("idempotente: não toca post.links já populado", () => {
    writeApproved("260425", ["https://a.com/from-approved"]);
    const post = makePost({ links: ["https://existing.com/keep"] });
    const r = populateLinksFromApproved(post, tmpRoot);
    assert.equal(r.populated, 0);
    assert.deepEqual(post.links, ["https://existing.com/keep"]);
  });

  it("no-op quando arquivo local não existe (edição produzida em outra máquina)", () => {
    const post = makePost({ published_at: "2026-04-22T10:00:00Z" });
    const r = populateLinksFromApproved(post, tmpRoot);
    assert.equal(r.populated, 0);
    assert.equal(post.links, undefined);
  });

  it("muta post.links in-place (mesmo contrato do populateLinksFromTracking)", () => {
    writeApproved("260425", ["https://a.com/1"]);
    const post = makePost();
    assert.equal(post.links, undefined);
    populateLinksFromApproved(post, tmpRoot);
    assert.ok(Array.isArray(post.links));
    assert.equal(post.links?.length, 1);
  });

  it("trata links: [] (array vazio) como missing — popula", () => {
    writeApproved("260425", ["https://a.com/1"]);
    const post = makePost({ links: [] });
    const r = populateLinksFromApproved(post, tmpRoot);
    assert.equal(r.populated, 1);
    assert.deepEqual(post.links, ["https://a.com/1"]);
  });
});

// #3498 item 2: populateAllFromApproved agora computa enumerateEditionDirs()
// UMA VEZ (antes do loop) em vez de deixar cada post sem links[] disparar sua
// própria varredura via extractUrlsFromApproved. Este teste cobre a
// correção FUNCIONAL da mudança — múltiplos posts, múltiplas edições
// distintas (flat + nested), todos populados certo a partir do cache
// compartilhado.
describe("populateAllFromApproved com cache compartilhado (#3498)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "approved-all-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeApprovedAt(dir: string, urls: string[]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "01-approved.json"),
      JSON.stringify({
        highlights: [],
        runners_up: [],
        lancamento: urls.map((url) => ({ url })),
        radar: [],
      }),
      "utf8",
    );
  }

  it("popula posts de edições diferentes (flat + nested) corretamente", () => {
    // Edição 1: layout flat.
    writeApprovedAt(join(tmpRoot, "data/editions/260715/_internal"), [
      "https://flat.com/a",
    ]);
    // Edição 2: layout nested.
    writeApprovedAt(join(tmpRoot, "data/editions/2604/260425/_internal"), [
      "https://nested.com/b",
    ]);

    const posts: Post[] = [
      { id: "p1", title: "T1", published_at: "2026-07-15T10:00:00Z" }, // -> 260715
      { id: "p2", title: "T2", published_at: "2026-04-25T10:00:00Z" }, // -> 260425
      { id: "p3", title: "T3", published_at: "2026-01-01T10:00:00Z" }, // sem edição local
    ];

    const stats = populateAllFromApproved(posts, tmpRoot);
    assert.equal(stats.posts_touched, 2);
    assert.equal(stats.total_urls_populated, 2);
    assert.deepEqual(posts[0].links, ["https://flat.com/a"]);
    assert.deepEqual(posts[1].links, ["https://nested.com/b"]);
    assert.equal(posts[2].links, undefined);
  });
});
