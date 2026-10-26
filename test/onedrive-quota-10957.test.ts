/**
 * test/onedrive-quota-10957.test.ts (#10957)
 *
 * OneDrive sem cota por causa dos `.mp4` de `data/editions` (23/10/2026).
 * Cobre as três peças da decisão do editor: `skip_file` com `*.mp4`
 * (idempotente), retenção por data (dry-run por padrão) e o sinal de cota
 * do alarme com a causa no texto. Nada aqui toca o `data/` real nem o
 * daemon — tudo em tmpdir ou com execFn falso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planSkipFileConfig,
  readSkipFilePatterns,
  buildSkipFileMatcher,
  ONEDRIVE_CLIENT_DEFAULT_SKIP_FILE,
  REQUIRED_SKIP_FILE_PATTERNS,
} from "../scripts/lib/onedrive-skip-file.ts";
import {
  planVideoRetention,
  editionFromVideoPath,
  editionAgeDays,
} from "../scripts/lib/edition-video-retention.ts";
import {
  scanOnedriveLogForQuotaFull,
  summarizeDataUsage,
  evaluateOnedriveQuota,
  buildQuotaCauseText,
  isAlarmingQuotaVerdict,
  nextQuotaFullLatch,
  logShowsSpaceFreed,
  parseQuotaFullLatch,
} from "../scripts/lib/onedrive-quota.ts";
import { pruneEditionVideos } from "../scripts/prune-edition-videos.ts";
import {
  toQuotaAlarmFinding,
  buildCombinedAlarmEmail,
  quotaAbsenceUnmeasured,
  readEffectiveSkipFile,
  readOnedriveJournalLines,
  loadQuotaFullLatch,
  saveQuotaFullLatch,
  QUOTA_CHECK,
} from "../scripts/onedrive-sync-alarm.ts";
import { evaluateOnedriveSyncAlarm } from "../scripts/lib/onedrive-sync-alarm.ts";
import { alarmIssueStateKey, type AlarmFindingOutcome } from "../scripts/lib/alarm-issues.ts";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe("skip_file (#10957)", () => {
  it("config sem skip_file: cria a linha com o default do cliente + *.mp4", () => {
    const plan = planSkipFileConfig('sync_dir = "~/OneDrive"\n');
    assert.equal(plan.changed, true);
    assert.ok(plan.effective.includes("*.mp4"));
    for (const p of ONEDRIVE_CLIENT_DEFAULT_SKIP_FILE) assert.ok(plan.effective.includes(p), p);
    assert.ok(plan.text.startsWith('sync_dir = "~/OneDrive"\n'));
    assert.deepEqual(readSkipFilePatterns(plan.text), plan.effective);
  });

  it("linha existente sem *.mp4: acrescenta só o que falta, sem tirar padrão do editor", () => {
    const before = 'skip_file = "~*|.~*|*.tmp|meu-padrao|*.db-shm"\nmonitor_interval = "300"\n';
    const plan = planSkipFileConfig(before);
    assert.equal(plan.changed, true);
    assert.ok(plan.added.includes("*.mp4"));
    assert.ok(!plan.added.includes("*.db-shm"));
    const after = readSkipFilePatterns(plan.text)!;
    assert.deepEqual(after.slice(0, 5), ["~*", ".~*", "*.tmp", "meu-padrao", "*.db-shm"]);
    assert.ok(plan.text.endsWith('monitor_interval = "300"\n'));
  });

  it("idempotente: aplicar de novo não muda nada", () => {
    const once = planSkipFileConfig("").text;
    const twice = planSkipFileConfig(once);
    assert.equal(twice.changed, false);
    assert.equal(twice.text, once);
  });

  it("linha comentada não conta; várias linhas ativas somam", () => {
    assert.equal(readSkipFilePatterns('# skip_file = "*.mp4"\n'), null);
    const multi = 'skip_file = "*.tmp"\nskip_file = "*.mp4|run-log.jsonl"\n';
    assert.deepEqual(readSkipFilePatterns(multi), ["*.tmp", "*.mp4", "run-log.jsonl"]);
    const plan = planSkipFileConfig(multi);
    // o que falta entra na última linha ativa
    assert.ok(plan.text.split("\n")[1].includes("*.db-wal"));
    assert.ok(!plan.text.split("\n")[0].includes("*.db-wal"));
  });

  it("preserva CRLF", () => {
    const plan = planSkipFileConfig('skip_file = "*.tmp"\r\nx = "1"\r\n');
    assert.ok(plan.text.includes('"\r\nx = "1"\r\n'));
    for (const p of REQUIRED_SKIP_FILE_PATTERNS) assert.ok(readSkipFilePatterns(plan.text)!.includes(p));
  });

  it("matcher casa pelo nome, sem diferenciar maiúsculas", () => {
    const m = buildSkipFileMatcher(["*.mp4", "run-log.jsonl"]);
    assert.equal(m("diaria-comentada-261021.mp4"), true);
    assert.equal(m("VIDEO.MP4"), true);
    assert.equal(m("run-log.jsonl"), true);
    assert.equal(m("run-log.jsonl.bak"), false);
    assert.equal(m("02-reviewed.md"), false);
  });

  it("readEffectiveSkipFile: config ausente = mp4 sincroniza; com *.mp4 = excluído", () => {
    const dir = mkdtempSync(join(tmpdir(), "od-skip-"));
    try {
      assert.equal(readEffectiveSkipFile(join(dir, "nao-existe")).mp4Excluded, false);
      const cfg = join(dir, "config");
      writeFileSync(cfg, planSkipFileConfig("").text);
      assert.equal(readEffectiveSkipFile(cfg).mp4Excluded, true);
      writeFileSync(cfg, 'skip_file = "*.tmp"\n');
      assert.equal(readEffectiveSkipFile(cfg).mp4Excluded, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("retenção dos vídeos por data (#10957)", () => {
  const today = new Date("2026-10-26T12:00:00Z");

  it("data vem do diretório AAMMDD, não do mtime", () => {
    assert.equal(editionFromVideoPath("2610/261021/diaria-comentada-261021.mp4"), "261021");
    assert.equal(editionFromVideoPath("2610/261022/_internal/x-short-instagram-chrome.mp4"), "261022");
    assert.equal(editionFromVideoPath("solto.mp4"), null);
    assert.equal(editionFromVideoPath("2610/261399/x.mp4"), null); // data impossível
    assert.equal(editionAgeDays("261021", today), 5);
  });

  it("remove só edição com mais de keepDays dias; .mp4 sem data fica intacto", () => {
    const plan = planVideoRetention(
      [
        { relPath: "2610/261001/diaria-comentada-261001.mp4", sizeBytes: 500 * MB },
        { relPath: "2610/261012/diaria-comentada-261012.mp4", sizeBytes: 300 * MB }, // 14d: fica
        { relPath: "2610/261011/diaria-comentada-261011.mp4", sizeBytes: 200 * MB }, // 15d: sai
        { relPath: "2610/261021/diaria-comentada-261021.mp4", sizeBytes: 583 * MB },
        { relPath: "2610/261021/02-reviewed.md", sizeBytes: 10 },
        { relPath: "avulso/video.mp4", sizeBytes: 1 },
      ],
      today,
      14,
    );
    assert.deepEqual(
      plan.remove.map((c) => c.edition),
      ["261001", "261011"],
    );
    assert.equal(plan.removeBytes, 700 * MB);
    assert.equal(plan.keep.length, 2);
    assert.equal(plan.undated.length, 1);
  });

  it("recusa keepDays < 1 (apagaria o vídeo do dia antes da Etapa 5)", () => {
    assert.throws(() => planVideoRetention([], today, 0));
  });

  it("pruneEditionVideos: dry-run por padrão não apaga; --apply apaga só os velhos", () => {
    const root = mkdtempSync(join(tmpdir(), "od-prune-"));
    try {
      const old = join(root, "editions", "2610", "261001");
      const fresh = join(root, "editions", "2610", "261025");
      mkdirSync(old, { recursive: true });
      mkdirSync(fresh, { recursive: true });
      writeFileSync(join(old, "diaria-comentada-261001.mp4"), "x");
      writeFileSync(join(old, "02-reviewed.md"), "texto");
      writeFileSync(join(fresh, "diaria-comentada-261025.mp4"), "y");

      const dry = pruneEditionVideos({ dataRoot: root, today, keepDays: 14, apply: false });
      assert.equal(dry.plan.remove.length, 1);
      assert.equal(dry.deleted.length, 0);
      assert.ok(existsSync(join(old, "diaria-comentada-261001.mp4")));

      const real = pruneEditionVideos({ dataRoot: root, today, keepDays: 14, apply: true });
      assert.deepEqual(real.deleted, ["2610/261001/diaria-comentada-261001.mp4"]);
      assert.ok(!existsSync(join(old, "diaria-comentada-261001.mp4")));
      assert.ok(existsSync(join(old, "02-reviewed.md")));
      assert.ok(existsSync(join(fresh, "diaria-comentada-261025.mp4")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("alarme de cota com a causa no texto (#10957)", () => {
  // Cenário medido na issue: data/ 4,8 GB, editions/2610 2,0 GB quase todo
  // vídeo, *.mp4 ainda sincronizando.
  const files = [
    { relPath: "editions/2610/261021/diaria-comentada-261021.mp4", sizeBytes: 583 * MB },
    { relPath: "editions/2610/261023/diaria-comentada-261023.mp4", sizeBytes: 321 * MB },
    { relPath: "editions/2610/261022/diaria-comentada-261022-short-original.mp4", sizeBytes: 262 * MB },
    { relPath: "eventos/x.jsonl", sizeBytes: 779 * MB },
    { relPath: "clarice-subscribers/y.csv", sizeBytes: 627 * MB },
    { relPath: "run-log.jsonl", sizeBytes: 200 * MB },
    { relPath: "editions/2610/261021/02-reviewed.md", sizeBytes: 1 * MB },
  ];

  it("cenário real: mp4 sincronizando acima de 80% de 3 GB vira quota-near citando vídeo e o passo do skip_file", () => {
    const usage = summarizeDataUsage(files, buildSkipFileMatcher(["run-log.jsonl"]));
    assert.equal(usage.mp4SyncedBytes, 1166 * MB);
    assert.equal(usage.skippedBytes, 200 * MB);
    assert.equal(usage.topDirs[0].path, "editions/2610");
    const ev = evaluateOnedriveQuota({ log: { matched: false, matchCount: 0, sample: null, uploadSuccessCount: 0 }, usage, quotaBytes: 3 * GB, mp4Excluded: false });
    assert.equal(ev.verdict, "quota-near");
    const text = buildQuotaCauseText(ev);
    assert.match(text, /Vídeo \(\.mp4\)/);
    assert.match(text, /editions\/2610/);
    assert.match(text, /diaria-comentada-261021\.mp4/);
    assert.match(text, /onedrive-skip-file-config\.ts --apply/);
  });

  it("com *.mp4 no skip_file o vídeo sai da conta e o passo do skip_file some do texto", () => {
    const usage = summarizeDataUsage(files, buildSkipFileMatcher(["run-log.jsonl", "*.mp4"]));
    assert.equal(usage.mp4SyncedBytes, 0);
    assert.equal(usage.mp4Bytes, 1166 * MB);
    const ev = evaluateOnedriveQuota({ log: null, usage, quotaBytes: 5 * GB, mp4Excluded: true });
    assert.equal(ev.verdict, "ok");
    assert.doesNotMatch(buildQuotaCauseText({ ...ev, verdict: "quota-near" }), /skip-file-config/);
  });

  it("recusa por espaço no log do daemon vence: quota-full mesmo com data/ pequeno ou sem medir", () => {
    const log = scanOnedriveLogForQuotaFull([
      "Uploading new file: a.md ... done",
      "Skipping uploading this new file as it exceeds the available free space on Microsoft OneDrive: x.mp4",
    ]);
    assert.equal(log.matched, true);
    assert.match(log.sample!, /exceeds the available free space/);
    const ev = evaluateOnedriveQuota({ log, usage: null, quotaBytes: 5 * GB, mp4Excluded: null });
    assert.equal(ev.verdict, "quota-full");
    assert.match(buildQuotaCauseText(ev), /recusando upload por falta de espaço/);
    assert.equal(scanOnedriveLogForQuotaFull(["Sync with Microsoft OneDrive is complete"]).matched, false);
  });

  it("sem data/ e sem recusa no log: unmeasured, e congela as issues de cota", () => {
    const ev = evaluateOnedriveQuota({ log: null, usage: null, quotaBytes: 5 * GB, mp4Excluded: null });
    assert.equal(ev.verdict, "unmeasured");
    assert.equal(isAlarmingQuotaVerdict(ev.verdict), false);
    const frozen = quotaAbsenceUnmeasured("unmeasured");
    assert.equal(frozen(alarmIssueStateKey(QUOTA_CHECK, "quota-full")), true);
    assert.equal(frozen(alarmIssueStateKey("onedrive-sync", "alarm-service-down")), false);
    assert.equal(quotaAbsenceUnmeasured("ok")(alarmIssueStateKey(QUOTA_CHECK, "quota-full")), false);
  });

  it("finding de cota: check próprio, alarm-acao, P1 cheio / P2 perto", () => {
    const usage = summarizeDataUsage(files, () => false);
    const full = toQuotaAlarmFinding(evaluateOnedriveQuota({ log: null, usage, quotaBytes: 1 * GB, mp4Excluded: false }));
    assert.equal(full.check, QUOTA_CHECK);
    assert.equal(full.fingerprint, "quota-full");
    assert.equal(full.priority, "P1");
    assert.ok(full.labels?.includes("alarm-acao"));
    assert.equal(full.family, "estado");
    assert.match(full.body, /Causa provável/);
    const near = toQuotaAlarmFinding(evaluateOnedriveQuota({ log: null, usage, quotaBytes: 3 * GB, mp4Excluded: false }));
    assert.equal(near.fingerprint, "quota-near");
    assert.equal(near.priority, "P2");
  });

  it("e-mail combinado cita sync e cota quando os dois disparam", () => {
    const usage = summarizeDataUsage(files, () => false);
    const quota = evaluateOnedriveQuota({ log: null, usage, quotaBytes: 1 * GB, mp4Excluded: false });
    const sync = evaluateOnedriveSyncAlarm("inactive", "fresh");
    const outcomes = [
      { check: "onedrive-sync", fingerprint: "alarm-service-down", action: "created", issueNumber: 1, url: "u1" },
      { check: QUOTA_CHECK, fingerprint: "quota-full", action: "created", issueNumber: 2, url: "u2" },
    ] as unknown as AlarmFindingOutcome[];
    const email = buildCombinedAlarmEmail(outcomes, sync, quota);
    assert.match(email.subject, /alarm-service-down/);
    assert.match(email.subject, /cota quota-full/);
    assert.match(email.body, /#1 \(u1\)/);
    assert.match(email.body, /#2 \(u2\)/);
    const onlyQuota = buildCombinedAlarmEmail([outcomes[1]], sync, quota);
    assert.doesNotMatch(onlyQuota.subject, /alarm-service-down/);
  });

  it("trava (review PR #11139): janela muda depois da recusa NÃO fecha quota-full, mesmo com data/ pequeno", () => {
    // Cenário do review: recusa vista; depois do skip_file a medida local
    // cai (subestima a cota), e o journal de 6h fica sem linha nenhuma
    // porque o daemon não tentou subir nada. Antes do fix, isso virava `ok`
    // e a issue fechava por streak com a conta ainda cheia.
    const small = summarizeDataUsage([{ relPath: "a.md", sizeBytes: 10 * MB }], () => false);
    const t0 = new Date("2026-10-26T00:00:00Z");
    const refused = evaluateOnedriveQuota({
      log: scanOnedriveLogForQuotaFull(["Skipping uploading this new file as it exceeds the available free space on Microsoft OneDrive: x.mp4"]),
      usage: small, quotaBytes: 5 * GB, mp4Excluded: true, latch: null, now: t0,
    });
    assert.equal(refused.verdict, "quota-full");
    assert.ok(refused.latch);
    assert.equal(refused.latch.since, t0.toISOString());

    for (const log of [scanOnedriveLogForQuotaFull([]), scanOnedriveLogForQuotaFull(["Sync with Microsoft OneDrive is complete"]), null]) {
      const ev = evaluateOnedriveQuota({ log, usage: small, quotaBytes: 5 * GB, mp4Excluded: true, latch: refused.latch, now: new Date("2026-10-26T04:00:00Z") });
      assert.equal(ev.verdict, "quota-full", "janela sem upload concluído (ou journal ilegível) mantém a trava");
      assert.deepEqual(ev.latch, refused.latch);
      assert.match(buildQuotaCauseText(ev), /janela sem recusa não prova que liberou/);
    }
  });

  it("trava solta só com evidência positiva: upload concluído e nenhuma recusa na janela", () => {
    const small = summarizeDataUsage([{ relPath: "a.md", sizeBytes: 10 * MB }], () => false);
    const latch = nextQuotaFullLatch(null, scanOnedriveLogForQuotaFull(["quotaLimitReached"]), new Date("2026-10-26T00:00:00Z"));
    assert.ok(latch);
    // Upload e recusa na mesma janela: continua cheia, trava renovada.
    const mixed = evaluateOnedriveQuota({
      log: scanOnedriveLogForQuotaFull(["Uploading new file: a.md ... done.", "quota exceeded"]),
      usage: small, quotaBytes: 5 * GB, mp4Excluded: true, latch, now: new Date("2026-10-26T04:00:00Z"),
    });
    assert.equal(mixed.verdict, "quota-full");
    assert.equal(mixed.latch?.since, latch.since);
    assert.equal(mixed.latch?.lastRefusalAt, "2026-10-26T04:00:00.000Z");
    // Só upload: solta, e o veredito volta a vir da medida local.
    const freed = evaluateOnedriveQuota({
      log: scanOnedriveLogForQuotaFull(["Uploading modified file .onedrive-sync-canary.json ... done"]),
      usage: small, quotaBytes: 5 * GB, mp4Excluded: true, latch, now: new Date("2026-10-26T08:00:00Z"),
    });
    assert.equal(freed.latch, null);
    assert.equal(freed.verdict, "ok");
    assert.equal(logShowsSpaceFreed(null), false);
    // Linha de recusa nunca conta como upload concluído.
    assert.equal(scanOnedriveLogForQuotaFull(["Uploading new file x.mp4 ... failed: quota exceeded"]).uploadSuccessCount, 0);
  });

  it("trava persistida: load/save ida e volta; ausente e corrompida viram solta", () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-latch-"));
    try {
      const path = join(dir, "sub", ".onedrive-quota-latch.json");
      assert.equal(loadQuotaFullLatch(path), null);
      const latch = { since: "2026-10-26T00:00:00.000Z", lastRefusalAt: "2026-10-26T04:00:00.000Z", lastRefusalSample: "quota exceeded" };
      saveQuotaFullLatch(path, latch);
      assert.deepEqual(loadQuotaFullLatch(path), latch);
      saveQuotaFullLatch(path, null);
      assert.equal(loadQuotaFullLatch(path), null);
      writeFileSync(path, "{nao json");
      assert.equal(loadQuotaFullLatch(path), null);
      assert.deepEqual(parseQuotaFullLatch({ since: 1 }), { latch: null, invalid: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skip_file entre aspas simples é lido e completado na própria linha (sem duplicar)", () => {
    const text = "skip_file = '*.tmp|run-log.jsonl'\n";
    assert.deepEqual(readSkipFilePatterns(text), ["*.tmp", "run-log.jsonl"]);
    const plan = planSkipFileConfig(text, ["run-log.jsonl", "*.mp4"]);
    assert.deepEqual(plan.added, ["*.mp4"]);
    assert.equal(plan.text.match(/skip_file/g)?.length, 1);
    assert.deepEqual(readSkipFilePatterns(plan.text), ["*.tmp", "run-log.jsonl", "*.mp4"]);
  });

  it("mp4Excluded exige padrão amplo: diaria-*.mp4 não conta como *.mp4 fora do sync", () => {
    const dir = mkdtempSync(join(tmpdir(), "skip-mp4-"));
    try {
      const narrow = join(dir, "narrow");
      writeFileSync(narrow, 'skip_file = "diaria-*.mp4"\n');
      assert.equal(readEffectiveSkipFile(narrow).mp4Excluded, false);
      const wide = join(dir, "wide");
      writeFileSync(wide, 'skip_file = "*.mp4"\n');
      assert.equal(readEffectiveSkipFile(wide).mp4Excluded, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readOnedriveJournalLines: journal indisponível vira null (sem medida), nunca lista vazia", () => {
    const failing = (() => {
      throw new Error("ENOENT");
    }) as unknown as Parameters<typeof readOnedriveJournalLines>[1];
    assert.equal(readOnedriveJournalLines(6, failing), null);
    let seenArgs: string[] = [];
    const fake = ((_cmd: string, args: string[]) => {
      seenArgs = args;
      return "linha 1\nlinha 2";
    }) as unknown as Parameters<typeof readOnedriveJournalLines>[1];
    assert.deepEqual(readOnedriveJournalLines(6, fake), ["linha 1", "linha 2"]);
    assert.ok(seenArgs.includes("onedrive"));
    assert.ok(seenArgs.includes("-6h"));
  });
});
