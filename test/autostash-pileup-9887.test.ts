/**
 * #9887: o alarme de PILEUP do sync-code.ts distingue pilha CRESCENDO (bug
 * ativo) de RESÍDUO HISTÓRICO (sobra parada, limpeza manual pendente). A mesma
 * pilha de 15 autostashes virou issue 2× (#9690 em 261006, #9887 em 261008)
 * pedindo "investigar por que ainda são criados" sem a contagem ter crescido.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AUTOSTASH_PILEUP_IDLE_DAYS,
  assessAutostashPileup,
  formatAutostashPileupBanner,
  listAutostashDates,
} from "../scripts/lib/autostash-report.ts";
import { GIT_SYNC_STASH_MESSAGE } from "../scripts/lib/git-sync.ts";

const NOW = new Date("2026-10-08T00:44:30Z");

test("#9887: listAutostashDates lê só datas dos autostashes do módulo, 1 spawn, sem drop/pop/show", () => {
  const calls: string[][] = [];
  const spawn = (_c: string, args: string[]) => {
    calls.push(args);
    return {
      status: 0,
      stderr: "",
      stdout:
        `2026-09-25T02:55:04+00:00|On master: ${GIT_SYNC_STASH_MESSAGE}\n` +
        `2026-09-03T11:00:04+00:00|WIP on master: 4abfa69d manual\n` +
        `2026-09-20T20:00:04+00:00|On master: ${GIT_SYNC_STASH_MESSAGE}\n`,
    };
  };
  assert.deepEqual(listAutostashDates(spawn), ["2026-09-25T02:55:04+00:00", "2026-09-20T20:00:04+00:00"]);
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((a) => a.includes("drop") || a.includes("pop") || a.includes("show")));
});

test("#9887: git stash list falhando → null (indeterminado, nunca lista vazia)", () => {
  assert.equal(listAutostashDates(() => ({ status: 128, stdout: "", stderr: "fatal" })), null);
});

test("#9887: cenário da issue — 15 parados há dias, rodada sem stash → historical", () => {
  const dates = Array.from({ length: 15 }, (_, i) => `2026-09-${String(25 - i).padStart(2, "0")}T02:55:04+00:00`);
  const a = assessAutostashPileup(dates, { now: NOW, createdThisRun: false });
  assert.equal(a.kind, "historical");
  assert.equal(a.newest_at, "2026-09-25T02:55:04+00:00");
  assert.equal(a.oldest_at, "2026-09-11T02:55:04+00:00");
  assert.equal(a.idle_days, 12);
  const banner = formatAutostashPileupBanner(15, 3, a);
  assert.match(banner, /RESÍDUO HISTÓRICO/);
  assert.match(banner, /não abra issue nova/);
  assert.match(banner, /npx tsx scripts\/list-autostashes\.ts/);
  assert.doesNotMatch(banner, /PILEUP ATIVO/);
});

test("#9887: esta rodada criou/preservou autostash → active mesmo com o resto antigo", () => {
  const a = assessAutostashPileup(["2026-09-01T00:00:00Z", "2026-08-30T00:00:00Z", "2026-08-29T00:00:00Z"], {
    now: NOW,
    createdThisRun: true,
  });
  assert.equal(a.kind, "active");
  assert.match(formatAutostashPileupBanner(3, 3, a), /PILEUP ATIVO/);
});

test("#9887: fronteira do idle — abaixo do limiar é active, no limiar é historical", () => {
  const ms = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
  const below = assessAutostashPileup([ms(AUTOSTASH_PILEUP_IDLE_DAYS - 0.5), ms(30), ms(31)], { now: NOW, createdThisRun: false });
  assert.equal(below.kind, "active");
  const at = assessAutostashPileup([ms(AUTOSTASH_PILEUP_IDLE_DAYS), ms(30), ms(31)], { now: NOW, createdThisRun: false });
  assert.equal(at.kind, "historical");
});

test("#9887: datas ilegíveis ou leitura falha → unknown, nunca historical", () => {
  assert.equal(assessAutostashPileup(null, { now: NOW, createdThisRun: false }).kind, "unknown");
  assert.equal(assessAutostashPileup(["lixo", "2026-09-01T00:00:00Z"], { now: NOW, createdThisRun: false }).kind, "unknown");
  assert.equal(assessAutostashPileup(null, { now: NOW, createdThisRun: true }).kind, "active");
  assert.match(
    formatAutostashPileupBanner(5, 3, assessAutostashPileup(null, { now: NOW, createdThisRun: false })),
    /Não foi possível ler as datas/,
  );
});

test("#9887: sync-code.ts usa o veredito (createdThisRun = preserved_stash) e expõe autostash_pileup no JSON", () => {
  const src = readFileSync(new URL("../scripts/sync-code.ts", import.meta.url), "utf8");
  assert.match(src, /createdThisRun:\s*result\.preserved_stash !== null/);
  assert.match(src, /formatAutostashPileupBanner\(/);
  assert.match(src, /autostash_pileup:/);
  // Nenhum descarte automático (#8719): o script nunca dropa stash.
  assert.doesNotMatch(src, /"stash",\s*"(drop|clear)"/);
});
