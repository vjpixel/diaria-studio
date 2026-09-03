/**
 * data-dir-gc-policy.test.ts (#7278)
 *
 * Cobre a política PURA de `scripts/lib/data-dir-gc-policy.ts` — guard de
 * exclusão (#7137: nunca remover `beehiiv-backup/`, `04-d*.jpg`,
 * `stripe-*.csv`, `snippets/`), classificadores de bucket por nome, e
 * retenção de cópias-irmãs/cache. Sem fs — tudo em memória, script real
 * fica no teste de integração (`test/gc-data-dir.test.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isExcludedPath,
  guardCandidates,
  isForensicCacheDir,
  isTmpIntermediateFilename,
  isEmbeddedHtmlFilename,
  isBackupSiblingFilename,
  isMvCacheFilename,
  classifyBackupSiblings,
  classifyMvCache,
  type GcCandidate,
  type AgedFile,
} from "../scripts/lib/data-dir-gc-policy.ts";

const DAY_MS = 86_400_000;
const NOW_MS = Date.UTC(2026, 8, 3, 12, 0, 0); // fixo — mtime derivado, nunca Date.now() em teste

/** mtime consistente com um `ageDays` dado (mesma fórmula de `ageDaysOf`
 *  em `gc-data-dir.ts`, Math.floor((now - mtimeMs) / DAY_MS)) — os
 *  fixtures abaixo constroem `AgedFile` com os dois campos alinhados. */
function mtimeFor(ageDays: number): number {
  return NOW_MS - ageDays * DAY_MS;
}

describe("isExcludedPath — guard #7137 (nunca remover)", () => {
  it("beehiiv-backup/ inteiro, em qualquer profundidade", () => {
    assert.equal(isExcludedPath("beehiiv-backup"), true);
    assert.equal(isExcludedPath("beehiiv-backup/subscriber-engagement/manifest.json"), true);
    assert.equal(isExcludedPath("beehiiv-backup/2026-08-01/subscribers.jsonl"), true);
  });

  it("snippets/ inteiro", () => {
    assert.equal(isExcludedPath("snippets"), true);
    assert.equal(isExcludedPath("snippets/divulgacao-newsletter.md"), true);
  });

  it("stripe-*.csv na raiz de qualquer diretório", () => {
    assert.equal(isExcludedPath("clarice-subscribers/stripe-customers-260901.csv"), true);
    assert.equal(isExcludedPath("stripe-export-excluded.csv"), true);
  });

  it("04-d{N}[-carousel-{p1,p2,p3,cta}]-{2x1,1x1,4x5}.jpg — entregáveis publicados", () => {
    assert.equal(isExcludedPath("editions/2609/260901/04-d1-2x1.jpg"), true);
    assert.equal(isExcludedPath("editions/2609/260901/04-d2-1x1.jpg"), true);
    assert.equal(isExcludedPath("editions/2609/260901/04-d3-carousel-p1-4x5.jpg"), true);
    assert.equal(isExcludedPath("editions/2609/260901/04-d1-carousel-cta-4x5.jpg"), true);
  });

  it("NÃO exclui paths fora dos 4 padrões", () => {
    assert.equal(isExcludedPath("editions/2609/260901/_internal/tmp-articles-raw.json"), false);
    assert.equal(isExcludedPath("run-log-Neo.jsonl"), false);
    assert.equal(isExcludedPath("clarice-subscribers/clarice-users-predator-safeBackup-0001.db"), false);
  });

  it("aceita path com barra invertida (Windows) igual a com barra normal", () => {
    assert.equal(isExcludedPath("beehiiv-backup\\subscriber-engagement\\manifest.json"), true);
  });
});

describe("guardCandidates — última palavra, independente do bucket atribuído", () => {
  it("filtra candidato excluído mesmo que o caller tenha classificado errado", () => {
    const candidates: GcCandidate[] = [
      { relPath: "beehiiv-backup/x.jsonl", bucket: "mv-cache", sizeBytes: 10, reason: "classificado errado de propósito" },
      { relPath: "editions/2609/260901/_internal/tmp-x.json", bucket: "tmp-intermediate", sizeBytes: 20, reason: "ok" },
    ];
    const guarded = guardCandidates(candidates);
    assert.equal(guarded.length, 1);
    assert.equal(guarded[0].relPath, "editions/2609/260901/_internal/tmp-x.json");
  });
});

describe("isForensicCacheDir / isTmpIntermediateFilename / isEmbeddedHtmlFilename", () => {
  it("_forensic só casa a raiz exata do cache, não qualquer coisa contendo o nome", () => {
    assert.equal(isForensicCacheDir("editions/2609/260901/_internal/_forensic"), true);
    assert.equal(isForensicCacheDir("_internal/_forensic"), true);
    assert.equal(isForensicCacheDir("editions/2609/260901/_internal/_forensic_old"), false);
    assert.equal(isForensicCacheDir("editions/2609/260901/_internal"), false);
  });

  it("tmp-* casa qualquer sufixo de intermediário do Stage 1", () => {
    for (const name of ["tmp-articles-raw.json", "tmp-categorized.json", "tmp-dedup-output.json", "tmp-kept.json", "tmp-filtered.json"]) {
      assert.equal(isTmpIntermediateFilename(name), true, name);
    }
    assert.equal(isTmpIntermediateFilename("01-categorized.md"), false);
    assert.equal(isTmpIntermediateFilename("template-tmp-x.json"), false, "tmp- tem que estar no INÍCIO");
  });

  it("*-embedded.html casa os 3 nomes reais medidos na issue", () => {
    assert.equal(isEmbeddedHtmlFilename("newsletter-final-embedded.html"), true);
    assert.equal(isEmbeddedHtmlFilename("social-preview-embedded.html"), true);
    assert.equal(isEmbeddedHtmlFilename("cloudflare-preview-embedded.html"), true);
    assert.equal(isEmbeddedHtmlFilename("newsletter-final.html"), false);
  });
});

describe("isBackupSiblingFilename — cópias-irmãs de conflito do OneDrive", () => {
  it("casa os 4 exemplos exatos do corpo da issue #7278", () => {
    assert.equal(isBackupSiblingFilename("clarice-users-predator-safeBackup-0001.db"), true);
    assert.equal(isBackupSiblingFilename("clarice-users-Neo.db"), true);
    assert.equal(isBackupSiblingFilename("clarice-users-fromWindows-260817-0146.db.bak"), true);
    assert.equal(isBackupSiblingFilename("clarice-users.db.bak-260728-pre-build"), true);
  });

  it("casa a série numerada de run-log-*.jsonl citada em diaria-subscribers-ingest-kit.ts", () => {
    for (const name of ["run-log-Neo.jsonl", "run-log-Neo-2.jsonl", "run-log-Neo-10.jsonl", "run-log-Zenbook.jsonl", "run-log-Zenbook-6.jsonl", "run-log-predator.jsonl"]) {
      assert.equal(isBackupSiblingFilename(name), true, name);
    }
  });

  it("NUNCA casa o arquivo canônico (sem sufixo de conflito)", () => {
    for (const name of ["run-log.jsonl", "clarice-users.db", "diaria-subscribers.db", "beehiiv-ingest-manifest.json", "captura-log.jsonl"]) {
      assert.equal(isBackupSiblingFilename(name), false, name);
    }
  });
});

describe("isMvCacheFilename", () => {
  it("casa .mv-cache-*.json", () => {
    assert.equal(isMvCacheFilename(".mv-cache-t02-ex-assinantes.json"), true);
    assert.equal(isMvCacheFilename("mv-export-t02-ex-assinantes-verified.csv"), false, "resultado pago, nunca cache");
  });
});

describe("classifyBackupSiblings — retenção por diretório", () => {
  it("nunca marca o arquivo mais recente do diretório, mesmo se velho", () => {
    const files: AgedFile[] = [
      { relPath: "clarice-subscribers/clarice-users-predator-safeBackup-0001.db", sizeBytes: 100, ageDays: 400, mtimeMs: mtimeFor(400)  },
    ];
    const out = classifyBackupSiblings(files);
    assert.deepEqual(out, [], "único arquivo do diretório é sempre 'o mais recente' — nunca removido");
  });

  it("marca as cópias mais antigas que a retenção, preserva a mais nova", () => {
    const files: AgedFile[] = [
      { relPath: "d/run-log-Neo.jsonl", sizeBytes: 100, ageDays: 2, mtimeMs: mtimeFor(2)  }, // mais recente
      { relPath: "d/run-log-Neo-2.jsonl", sizeBytes: 100, ageDays: 20, mtimeMs: mtimeFor(20)  }, // > retenção (14d default)
      { relPath: "d/run-log-Neo-3.jsonl", sizeBytes: 100, ageDays: 5, mtimeMs: mtimeFor(5)  }, // dentro da retenção
    ];
    const out = classifyBackupSiblings(files);
    assert.deepEqual(
      out.map((c) => c.relPath),
      ["d/run-log-Neo-2.jsonl"],
    );
    assert.equal(out[0].bucket, "backup-sibling");
  });

  // Achado de review: cópias-irmãs do OneDrive nascem no mesmo evento de
  // conflito, então empatar no mesmo DIA (ageDays igual) é o caso COMUM,
  // não a exceção — se a ordenação usasse `ageDays` (arredondado por
  // Math.floor) em vez de `mtimeMs` real, "quem é mais recente" dependeria
  // da ordem de `readdirSync` (arbitrária), não de quem de fato é mais
  // novo. Este teste força um empate de `ageDays` com `mtimeMs` distintos
  // e assere que a escolha segue o mtime, não a ordem de entrada no array.
  it("empate de ageDays (mesmo dia) desempata por mtimeMs real, não pela ordem de entrada", () => {
    const sameDayOlder = mtimeFor(2) - 3 * 60 * 60 * 1000; // 3h mais cedo no mesmo dia
    const sameDayNewer = mtimeFor(2); // referência do dia
    const files: AgedFile[] = [
      // Entra no array primeiro mas é o MAIS ANTIGO das duas (mtimeMs menor) —
      // se o desempate usasse ageDays (ambas "2"), a ordem de entrada
      // decidiria quem sobrevive, o que é o bug que este teste trava.
      { relPath: "d/x-safeBackup-0001.db", sizeBytes: 10, ageDays: 2, mtimeMs: sameDayOlder },
      { relPath: "d/x-safeBackup-0002.db", sizeBytes: 10, ageDays: 2, mtimeMs: sameDayNewer },
    ];
    const out = classifyBackupSiblings(files, 0); // retenção 0 — os dois "velhos o bastante" se não forem a mais recente
    // Só a mais ANTIGA das duas (0001, mtimeMs menor) deveria virar
    // candidata — a mais nova (0002) é preservada por ser a mais recente
    // do diretório, mesmo com ageDays idêntico.
    assert.deepEqual(out.map((c) => c.relPath), ["d/x-safeBackup-0001.db"]);
  });

  it("agrupa por diretório — famílias em diretórios diferentes não se misturam", () => {
    const files: AgedFile[] = [
      { relPath: "a/x-Neo.db", sizeBytes: 10, ageDays: 30, mtimeMs: mtimeFor(30)  }, // único em "a" — preservado (mais recente de "a")
      { relPath: "b/x-Neo.db", sizeBytes: 10, ageDays: 30, mtimeMs: mtimeFor(30)  }, // único em "b" — preservado (mais recente de "b")
    ];
    const out = classifyBackupSiblings(files);
    assert.deepEqual(out, [], "cada diretório tem seu próprio 'mais recente', nenhum é candidato");
  });

  it("retentionDays custom respeitado", () => {
    const files: AgedFile[] = [
      { relPath: "d/x-Neo.db", sizeBytes: 10, ageDays: 1, mtimeMs: mtimeFor(1)  },
      { relPath: "d/x-Neo-2.db", sizeBytes: 10, ageDays: 3, mtimeMs: mtimeFor(3)  },
    ];
    assert.deepEqual(classifyBackupSiblings(files, 14), [], "3d < 14d — dentro da retenção default");
    assert.deepEqual(
      classifyBackupSiblings(files, 2).map((c) => c.relPath),
      ["d/x-Neo-2.db"],
      "3d > 2d de retenção custom",
    );
  });
});

describe("classifyMvCache — idade simples, sem agrupamento", () => {
  it("só marca cache mais velho que a retenção", () => {
    const files: AgedFile[] = [
      { relPath: "clarice-subscribers/2609-10/.mv-cache-t02.json", sizeBytes: 500, ageDays: 10, mtimeMs: mtimeFor(10)  },
      { relPath: "clarice-subscribers/2608-09/.mv-cache-t01.json", sizeBytes: 500, ageDays: 45, mtimeMs: mtimeFor(45)  },
    ];
    const out = classifyMvCache(files);
    assert.deepEqual(
      out.map((c) => c.relPath),
      ["clarice-subscribers/2608-09/.mv-cache-t01.json"],
    );
    assert.equal(out[0].bucket, "mv-cache");
  });
});
