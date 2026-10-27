/**
 * test/onedrive-skip-file-resync-11256.test.ts (#11256)
 *
 * Mudar `skip_file` no cliente OneDrive v2.5 exige `--resync`: só reiniciar
 * faz o daemon sair com status 126 e o sync fica parado. O próximo passo
 * impresso pelo `onedrive-skip-file-config.ts --apply`, o passo do alarme de
 * cota e a doc mandavam só `systemctl --user restart onedrive`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SKIP_FILE_RESYNC_STEPS, skipFileResyncStepsInline } from "../scripts/lib/onedrive-skip-file.ts";
import { skipFileConfigNextStepMessage } from "../scripts/onedrive-skip-file-config.ts";
import { evaluateOnedriveQuota, buildQuotaCauseText } from "../scripts/lib/onedrive-quota.ts";

const ROOT = join(import.meta.dirname, "..");

function assertResyncSequence(text: string, where: string): void {
  let from = 0;
  for (const step of SKIP_FILE_RESYNC_STEPS) {
    const idx = text.indexOf(step, from);
    assert.ok(idx >= 0, `${where}: falta o passo "${step}" (na ordem)`);
    from = idx + step.length;
  }
  assert.doesNotMatch(text, /systemctl --user restart onedrive/, `${where}: ainda manda só reiniciar`);
}

describe("#11256 — mudar skip_file exige --resync", () => {
  it("a sequência é stop, resync dry-run, resync, start", () => {
    assert.deepEqual([...SKIP_FILE_RESYNC_STEPS], [
      "systemctl --user stop onedrive",
      "onedrive --sync --resync --resync-auth --dry-run",
      "onedrive --sync --resync --resync-auth",
      "systemctl --user start onedrive",
    ]);
    assert.match(skipFileResyncStepsInline(), /dry-run` \(conferir que não há deleção\)/);
  });

  it("o próximo passo impresso pelo script cita o resync, na ordem, e não manda só reiniciar", () => {
    const msg = skipFileConfigNextStepMessage();
    assert.match(msg, /--resync/);
    assertResyncSequence(msg, "onedrive-skip-file-config");
    assert.match(msg, /docs\/onedrive-sync-setup\.md item 6/);
  });

  it("o passo do alarme de cota (mp4 fora do skip_file) cita o resync", () => {
    const ev = evaluateOnedriveQuota({
      log: { matched: true, matchCount: 1, sample: "quota exceeded", uploadSuccessCount: 0 },
      usage: null,
      quotaBytes: 5 * 1024 ** 3,
      mp4Excluded: false,
    });
    const text = buildQuotaCauseText(ev);
    assert.match(text, /onedrive-skip-file-config\.ts --apply/);
    assertResyncSequence(text, "buildQuotaCauseText");
  });

  it("a doc (itens 2 e 6) traz a sequência de resync e não manda reiniciar depois de mudar skip_file", () => {
    const doc = readFileSync(join(ROOT, "docs", "onedrive-sync-setup.md"), "utf8");
    const item2 = doc.slice(doc.indexOf("## Item 2"), doc.indexOf("## Item 3"));
    const item6 = doc.slice(doc.indexOf("## Item 6"));
    for (const [name, section] of [["item 2", item2], ["item 6", item6]] as const) {
      const blocks = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
      assertResyncSequence(blocks, `doc ${name}`);
    }
  });
});
