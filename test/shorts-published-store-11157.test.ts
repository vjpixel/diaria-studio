/**
 * test/shorts-published-store-11157.test.ts (#11157)
 *
 * Dois escritores do registro do vertical (`_internal/06-shorts-published.json`):
 * o timer do LinkedIn pessoal no 300 e o `/diaria-shorts` (`--mark`,
 * `--confirm-instagram`, `--publish`) no neo, com `data/` no OneDrive. Antes do
 * fix cada gravação reescrevia o arquivo inteiro a partir da cópia lida no
 * início da rodada, e uma escrita apagava a entrada da outra: sumia o
 * `linkedin_profile` e o timer publicava o vídeo de novo no perfil. Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHORTS_TIMER_LEDGER_FILE,
  isShortsRegistryFileName,
  listShortsRegistryFiles,
  mergeShortsRegistries,
  persistShortEntry,
  readShortsRegistry,
  readShortsRegistryRaws,
  shortsRegistryPath,
  shortsRegistryWriterFor,
} from "../scripts/lib/diaria/shorts-published-store.ts";
import { SHORTS_PUBLISHED_FILE, isDestinationDone, type ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";
import { decideTimerRun } from "../scripts/shorts-linkedin-profile-timer.ts";
import { registeredSinceRead } from "../scripts/publish-shorts.ts";

const AAMMDD = "261027";
const CFG = { publishing: { shorts: { facebook_pages: [], instagram: false, linkedin_profile: true, linkedin_page_repost: true, x: false, threads_profile: false, linkedin_profile_via_timer: true } } };

const entry = (destination: string, at: string, extra: Partial<ShortPublishedEntry> = {}): ShortPublishedEntry => ({
  destination,
  status: "published",
  id: `${destination}-id`,
  url: `https://example.test/${destination}`,
  at,
  ...extra,
});

function withEdition(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "shorts-11157-"));
  try {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#11157 dois escritores no registro do vertical", () => {
  it("o cenário da issue: --mark no neo a partir de cópia sem linkedin_profile não apaga a entrada do timer", () => {
    withEdition((dir) => {
      // Neo leu o registro (vazio) antes do timer publicar.
      const neoSnapshot = readShortsRegistry(dir, AAMMDD);
      assert.equal(neoSnapshot.entries.length, 0);
      // 300: o timer publica e grava.
      persistShortEntry(dir, AAMMDD, shortsRegistryWriterFor(true), entry("linkedin_profile", "2026-10-27T11:05:00Z"));
      // Neo: --mark facebook_profile, partindo da cópia antiga.
      persistShortEntry(dir, AAMMDD, shortsRegistryWriterFor(false), entry("facebook_profile", "2026-10-27T11:03:00Z"));
      const merged = readShortsRegistry(dir, AAMMDD);
      assert.ok(isDestinationDone(merged, "linkedin_profile"), "a entrada do timer sobreviveu");
      assert.ok(isDestinationDone(merged, "facebook_profile"), "a entrada do --mark sobreviveu");
      // A execução seguinte do timer não publica de novo.
      const raws = readShortsRegistryRaws(dir);
      const mainPath = join(dir, SHORTS_PUBLISHED_FILE);
      const main = raws.find((r) => r.path === mainPath);
      const d = decideTimerRun({
        config: CFG,
        reviewedExists: true,
        publishedRaw: main ? main.raw : null,
        otherRegistryRaws: raws.filter((r) => r.path !== mainPath),
        aammdd: AAMMDD,
        videoExists: true,
      });
      assert.equal(d.kind, "skip");
    });
  });

  it("cópia defasada do principal sobrescrita inteira por outra máquina (último a escrever vence no OneDrive) não perde o linkedin_profile", () => {
    withEdition((dir) => {
      persistShortEntry(dir, AAMMDD, "linkedin-timer", entry("linkedin_profile", "2026-10-27T11:05:00Z"));
      // O OneDrive troca o principal pela versão do neo, que nunca viu o linkedin_profile.
      writeFileSync(join(dir, SHORTS_PUBLISHED_FILE), JSON.stringify({ aammdd: AAMMDD, entries: [entry("x", "2026-10-27T11:00:00Z")] }));
      const merged = readShortsRegistry(dir, AAMMDD);
      assert.ok(isDestinationDone(merged, "linkedin_profile"));
      assert.ok(isDestinationDone(merged, "x"));
    });
  });

  it("read-modify-write intercalado no mesmo arquivo: cada gravação relê do disco, nenhuma entrada se perde", () => {
    withEdition((dir) => {
      // Dois processos leram o registro vazio no início da rodada...
      const a = readShortsRegistry(dir, AAMMDD);
      const b = readShortsRegistry(dir, AAMMDD);
      assert.equal(a.entries.length + b.entries.length, 0);
      // ...e cada um grava o seu destino depois.
      persistShortEntry(dir, AAMMDD, "main", entry("facebook:diaria", "2026-10-27T11:00:00Z"));
      persistShortEntry(dir, AAMMDD, "main", entry("instagram", "2026-10-27T11:01:00Z"));
      persistShortEntry(dir, AAMMDD, "main", entry("facebook_profile", "2026-10-27T11:02:00Z"));
      const onDisk = JSON.parse(readFileSync(join(dir, SHORTS_PUBLISHED_FILE), "utf8"));
      assert.deepEqual(
        onDisk.entries.map((e: ShortPublishedEntry) => e.destination).sort(),
        ["facebook:diaria", "facebook_profile", "instagram"],
      );
    });
  });

  it("upsert troca só a entrada do próprio destino", () => {
    withEdition((dir) => {
      persistShortEntry(dir, AAMMDD, "main", entry("youtube_shorts", "2026-10-27T10:00:00Z", { status: "send_unknown" }));
      persistShortEntry(dir, AAMMDD, "main", entry("instagram", "2026-10-27T10:01:00Z"));
      const merged = persistShortEntry(dir, AAMMDD, "main", entry("youtube_shorts", "2026-10-27T10:02:00Z"));
      assert.equal(merged.entries.length, 2);
      assert.equal(merged.entries.find((e) => e.destination === "youtube_shorts")!.status, "published");
    });
  });

  it("a rodada do timer grava só no registro dele; as outras, no principal", () => {
    withEdition((dir) => {
      assert.equal(shortsRegistryPath(dir, shortsRegistryWriterFor(true)), join(dir, SHORTS_TIMER_LEDGER_FILE));
      assert.equal(shortsRegistryPath(dir, shortsRegistryWriterFor(false)), join(dir, SHORTS_PUBLISHED_FILE));
      persistShortEntry(dir, AAMMDD, "linkedin-timer", entry("linkedin_profile", "2026-10-27T11:05:00Z"));
      assert.equal(listShortsRegistryFiles(dir).length, 1);
      assert.deepEqual(listShortsRegistryFiles(dir), [join(dir, SHORTS_TIMER_LEDGER_FILE)]);
    });
  });

  it("cópia de conflito do OneDrive entra na leitura: entrada só fecha a janela", () => {
    withEdition((dir) => {
      writeFileSync(join(dir, SHORTS_PUBLISHED_FILE), JSON.stringify({ aammdd: AAMMDD, entries: [] }));
      writeFileSync(join(dir, "_internal", "06-shorts-published-Neo.json"), JSON.stringify({ aammdd: AAMMDD, entries: [entry("linkedin_profile", "t")] }));
      assert.ok(isDestinationDone(readShortsRegistry(dir, AAMMDD), "linkedin_profile"));
    });
  });

  it("arquivo do registro ilegível aborta a leitura (nunca vira 'nada publicado')", () => {
    withEdition((dir) => {
      writeFileSync(join(dir, SHORTS_TIMER_LEDGER_FILE), "{ quebrado");
      assert.throws(() => readShortsRegistry(dir, AAMMDD), /JSON inválido/);
      assert.throws(() => persistShortEntry(dir, AAMMDD, "linkedin-timer", entry("linkedin_profile", "t")), /JSON inválido/);
    });
  });

  it("temporários da escrita atômica e o lock ficam fora da leitura", () => {
    assert.equal(isShortsRegistryFileName("06-shorts-published.json"), true);
    assert.equal(isShortsRegistryFileName("06-shorts-published.linkedin-timer.json"), true);
    assert.equal(isShortsRegistryFileName("06-shorts-published-Neo-2.json"), true);
    assert.equal(isShortsRegistryFileName(".06-shorts-published.json.abc123"), false);
    assert.equal(isShortsRegistryFileName("06-shorts-published.json.lock"), false);
    assert.equal(isShortsRegistryFileName("06-social-published.json"), false);
  });

  it("mesmo destino em dois arquivos: vale o `at` mais recente (o --mark do editor corrige o send_unknown do timer)", () => {
    const merged = mergeShortsRegistries(AAMMDD, [
      { aammdd: AAMMDD, entries: [entry("linkedin_profile", "2026-10-27T12:00:00Z", { status: "published", url: "https://li/final" })] },
      { aammdd: AAMMDD, entries: [entry("linkedin_profile", "2026-10-27T11:05:00Z", { status: "send_unknown" })] },
    ]);
    assert.equal(merged.entries.length, 1);
    assert.equal(merged.entries[0].status, "published");
  });

  it("reconferência antes de publicar acha a entrada gravada por outro processo depois da leitura", () => {
    withEdition((dir) => {
      const atStart = readShortsRegistry(dir, AAMMDD);
      assert.equal(registeredSinceRead(atStart, "linkedin_profile"), null);
      persistShortEntry(dir, AAMMDD, "main", entry("linkedin_profile", "2026-10-27T11:05:00Z"));
      assert.equal(registeredSinceRead(readShortsRegistry(dir, AAMMDD), "linkedin_profile")?.id, "linkedin_profile-id");
    });
  });
});

describe("#11157 publish-shorts usa o store (trava contra a gravação do arquivo inteiro)", () => {
  const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
  it("nenhuma gravação do registro a partir da cópia em memória", () => {
    assert.doesNotMatch(src, /function writePublished\(/);
    assert.doesNotMatch(src, /upsertShortEntry\(published/);
  });
  it("reconfere o registro no disco dentro do laço de publicação", () => {
    const loop = src.slice(src.indexOf("for (const item of plan.items)"));
    assert.match(loop.slice(0, 1500), /readShortsRegistry\(dir, aammdd\)/);
  });
  it("o planner de divulgação lê também o registro do timer", () => {
    const planner = readFileSync(new URL("../scripts/divulgacao-slot-planner.ts", import.meta.url), "utf8");
    assert.ok(planner.includes(SHORTS_TIMER_LEDGER_FILE.split("/").pop()!));
  });
});
