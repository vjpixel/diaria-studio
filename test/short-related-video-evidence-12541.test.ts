/**
 * test/short-related-video-evidence-12541.test.ts (#12541)
 *
 * Os dois alarmes do vídeo relacionado do Short dispararam sem falha real:
 *   - 261109: a task do Neo alertou "Horizontal e Short não encontrados" numa
 *     edição sem vídeo nenhum (sem `05-youtube-step.json`, sem
 *     `06-shorts-published.json`), só porque faltava o `no-video.json` manual;
 *   - 261105 (#12315): o alarme do `300` mandou e-mail urgente por
 *     `missing-record`, que nasce só da ausência de um arquivo replicado pelo
 *     OneDrive.
 * A precondição "haveria vídeo" agora é um helper único
 * (`assessEditionVideoEvidence`) que o plano e o alarme compartilham.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  YOUTUBE_STEP_FILE,
  assessEditionVideoEvidence,
  readEditionVideoEvidenceInput,
  type EditionVideoEvidenceInput,
  type FileRead,
} from "../scripts/lib/diaria/edition-video-evidence.ts";
import { YOUTUBE_STEP_FILE as STAGE5_YOUTUBE_STEP_FILE } from "../scripts/stage5-youtube.ts";
import {
  evaluateShortRelatedMissed,
  isAlarmingShortRelatedVerdict,
  shortRelatedMissedSeverity,
  type ShortRelatedMissedVerdict,
} from "../scripts/lib/diaria/short-related-missed-alarm.ts";
import { brtInstant, decideShortRelatedPlan, type ShortRelatedPlanInput } from "../scripts/lib/diaria/youtube-short-related.ts";
import type { ShortsPublishedFile } from "../scripts/lib/diaria/short-video.ts";

const shortsOk = (aammdd: string): FileRead<ShortsPublishedFile> => ({
  kind: "ok",
  value: {
    aammdd,
    entries: [{ destination: "youtube_shorts", status: "published", id: "abcdefghijk", at: "2026-11-05T15:00:00.000Z" }],
  },
});

function withEdition(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "short-evidence-12541-"));
  try {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function planInput(aammdd: string, over: Partial<ShortRelatedPlanInput>): ShortRelatedPlanInput {
  return {
    aammdd,
    now: brtInstant(aammdd, "13:30"),
    editionExists: true,
    noVideo: false,
    videoEvidence: assessEditionVideoEvidence({ noVideo: false, shortsRegistry: { kind: "absent" } }),
    horizontal: null,
    short: null,
    horizontalState: null,
    shortAt: brtInstant(aammdd, "12:00"),
    record: null,
    ...over,
  };
}

describe("#12541 assessEditionVideoEvidence", () => {
  const none: EditionVideoEvidenceInput = { noVideo: false, shortsRegistry: { kind: "absent" } };

  it("nenhuma fonte → sem evidência", () => {
    const ev = assessEditionVideoEvidence(none);
    assert.equal(ev.hasEvidence, false);
    assert.deepEqual(ev.sources, []);
    assert.match(ev.reason, /sem vídeo publicado/);
  });

  it("marcador manual vence qualquer evidência", () => {
    const ev = assessEditionVideoEvidence({ ...none, noVideo: true, shortsRegistry: shortsOk("261105"), d1VideoUrl: true });
    assert.equal(ev.hasEvidence, false);
    assert.match(ev.reason, /no-video\.json/);
  });

  it("Short youtube_shorts registrado → evidência; só outros destinos → não", () => {
    assert.equal(assessEditionVideoEvidence({ ...none, shortsRegistry: shortsOk("261105") }).hasEvidence, true);
    const onlyIg: FileRead<ShortsPublishedFile> = {
      kind: "ok",
      value: { aammdd: "261105", entries: [{ destination: "instagram", status: "published", id: "ig", at: "2026-11-05T15:00:00.000Z" }] },
    };
    assert.equal(assessEditionVideoEvidence({ ...none, shortsRegistry: onlyIg }).hasEvidence, false);
  });

  it("05-youtube-step.json: uploaded/already-published contam; os outros desfechos não", () => {
    for (const outcome of ["uploaded", "already-published"]) {
      assert.equal(assessEditionVideoEvidence({ ...none, youtubeStep: { kind: "ok", value: { outcome } } }).hasEvidence, true, outcome);
    }
    for (const outcome of ["no-video-marked", "consent-off", "missing-link", "needs-editor", "no-video-stale", 42]) {
      assert.equal(assessEditionVideoEvidence({ ...none, youtubeStep: { kind: "ok", value: { outcome } } }).hasEvidence, false, String(outcome));
    }
  });

  it("arquivo ilegível conta como evidência (não dá para afirmar que não há vídeo)", () => {
    assert.equal(assessEditionVideoEvidence({ ...none, shortsRegistry: { kind: "unreadable", error: "x" } }).hasEvidence, true);
    assert.equal(assessEditionVideoEvidence({ ...none, youtubeStep: { kind: "unreadable", error: "x" } }).hasEvidence, true);
  });

  it("registro do upload do horizontal e link do D1 contam", () => {
    assert.equal(assessEditionVideoEvidence({ ...none, horizontalUploadRecord: true }).hasEvidence, true);
    assert.equal(assessEditionVideoEvidence({ ...none, d1VideoUrl: true }).hasEvidence, true);
  });

  it("o caminho do 05-youtube-step.json é o mesmo que o Stage 5 grava", () => {
    assert.equal(YOUTUBE_STEP_FILE, STAGE5_YOUTUBE_STEP_FILE);
  });
});

describe("#12541 leitura de disco (readEditionVideoEvidenceInput)", () => {
  it("pasta da 261109 (sem nenhum registro de vídeo) → sem evidência", () => {
    withEdition((dir) => {
      writeFileSync(join(dir, "02-reviewed.md"), "# edição\n");
      assert.equal(assessEditionVideoEvidence(readEditionVideoEvidenceInput(dir, "261109")).hasEvidence, false);
    });
  });

  it("05-youtube-step.json already-published e JSON quebrado são lidos", () => {
    withEdition((dir) => {
      writeFileSync(join(dir, YOUTUBE_STEP_FILE), JSON.stringify({ outcome: "already-published" }));
      const ev = assessEditionVideoEvidence(readEditionVideoEvidenceInput(dir, "261105"));
      assert.deepEqual(ev.sources, ["youtube-step"]);
    });
    withEdition((dir) => {
      writeFileSync(join(dir, YOUTUBE_STEP_FILE), "{quebrado");
      assert.deepEqual(assessEditionVideoEvidence(readEditionVideoEvidenceInput(dir, "261105")).sources, ["youtube-step-unreadable"]);
    });
  });

  it("05-youtube-published.json e 05-video-url.txt são lidos", () => {
    withEdition((dir) => {
      writeFileSync(join(dir, "_internal/05-youtube-published.json"), "{}");
      writeFileSync(join(dir, "_internal/05-video-url.txt"), "https://youtu.be/abcdefghijk\n");
      const ev = assessEditionVideoEvidence(readEditionVideoEvidenceInput(dir, "261105"));
      assert.deepEqual(ev.sources, ["horizontal-upload-record", "d1-video-url"]);
    });
  });
});

describe("#12541 caso real 261109: edição sem vídeo e sem marcador", () => {
  it("o plano da task do Neo sai skip, sem alerta, mesmo depois do prazo de desistência", () => {
    for (const hhmm of ["06:05", "12:30", "13:30", "18:00"]) {
      const p = decideShortRelatedPlan(planInput("261109", { now: brtInstant("261109", hhmm) }));
      assert.equal(p.action, "skip", hhmm);
      assert.equal(p.alertDue, false, hhmm);
      assert.match(p.reason, /sem vídeo publicado/);
    }
  });

  it("antes do #12541 o mesmo cenário alertava: com evidência o plano ainda alerta", () => {
    // Prova de que o teste acima discrimina: o mesmo input com evidência cai no alert de sempre.
    const p = decideShortRelatedPlan(
      planInput("261109", { videoEvidence: assessEditionVideoEvidence({ noVideo: false, shortsRegistry: shortsOk("261109") }) }),
    );
    assert.equal(p.action, "alert");
    assert.match(p.reason, /não encontrados/);
  });

  it("o alarme do 300 também não alarma", () => {
    const ev = evaluateShortRelatedMissed({
      aammdd: "261109",
      now: brtInstant("261109", "13:30"),
      editionExists: true,
      noVideo: false,
      shortsRegistry: { kind: "absent" },
      record: { kind: "absent" },
      shortAt: brtInstant("261109", "12:00"),
    });
    assert.equal(ev.verdict, "no-video");
    assert.equal(isAlarmingShortRelatedVerdict(ev.verdict), false);
  });
});

describe("#12541 caso real 261105: registro do vínculo ausente no data/ do 300", () => {
  it("missing-record vira issue sem e-mail urgente (acao); os demais seguem urgente", () => {
    const ev = evaluateShortRelatedMissed({
      aammdd: "261105",
      now: brtInstant("261105", "13:30"),
      editionExists: true,
      noVideo: false,
      shortsRegistry: shortsOk("261105"),
      record: { kind: "absent" },
      shortAt: brtInstant("261105", "12:00"),
    });
    assert.equal(ev.verdict, "missing-record");
    assert.equal(shortRelatedMissedSeverity(ev.verdict), "acao");
    for (const v of ["failed-not-alerted", "record-unreadable", "shorts-registry-unreadable"] as ShortRelatedMissedVerdict[]) {
      assert.equal(shortRelatedMissedSeverity(v), "urgente", v);
    }
  });
});

describe("#12541 plano e alarme não divergem na precondição", () => {
  const regs: Array<FileRead<ShortsPublishedFile>> = [{ kind: "absent" }, shortsOk("261105"), { kind: "unreadable", error: "x" }];
  const steps: Array<FileRead<{ outcome?: unknown }> | undefined> = [
    undefined,
    { kind: "ok", value: { outcome: "already-published" } },
    { kind: "ok", value: { outcome: "missing-link" } },
    { kind: "unreadable", error: "x" },
  ];
  it("toda combinação: plano pula por falta de evidência ⇔ alarme diz no-video", () => {
    for (const noVideo of [false, true]) {
      for (const shortsRegistry of regs) {
        for (const youtubeStep of steps) {
          for (const d1VideoUrl of [false, true]) {
            const src = { noVideo, shortsRegistry, youtubeStep, d1VideoUrl };
            const evidence = assessEditionVideoEvidence(src);
            const plan = decideShortRelatedPlan(planInput("261105", { noVideo, videoEvidence: evidence }));
            const alarm = evaluateShortRelatedMissed({
              aammdd: "261105",
              now: brtInstant("261105", "13:30"),
              editionExists: true,
              record: { kind: "absent" },
              shortAt: brtInstant("261105", "12:00"),
              ...src,
            });
            const label = JSON.stringify(src);
            assert.equal(plan.action === "skip", !evidence.hasEvidence, label);
            assert.equal(alarm.verdict === "no-video", !evidence.hasEvidence, label);
          }
        }
      }
    }
  });
});
