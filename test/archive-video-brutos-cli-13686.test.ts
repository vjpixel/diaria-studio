/**
 * #13686: `archive-video-brutos.ts --help` rodava o dry-run inteiro contra o
 * Drive real, e `--apply --hlep` ignorava o typo e seguia com o apply. O argv
 * agora é decidido por uma função pura antes de qualquer I/O. Os testes só
 * exercitam essa função (nunca rodam o script, que fala com `gdrive-diaria:`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARCHIVE_CLI_SPEC,
  archiveCliExitCode,
  resolveArchiveCliAction,
} from "../scripts/archive-video-brutos.ts";
import { formatCliUsage } from "../scripts/lib/cli-args.ts";

test("#13686: --help e -h viram help com exit 0", () => {
  for (const argv of [["--help"], ["-h"], ["--apply", "--help"]]) {
    const action = resolveArchiveCliAction(argv);
    assert.equal(action.kind, "help", argv.join(" "));
    assert.equal(archiveCliExitCode(action), 0);
  }
});

test("#13686: flag desconhecida (o typo do cenário) recusa com exit 2, mesmo junto de --apply", () => {
  for (const argv of [["--apply", "--hlep"], ["--hlep"], ["--aply"], ["--bogus", "--help"], ["--apply=yes"]]) {
    const action = resolveArchiveCliAction(argv);
    assert.equal(action.kind, "error", argv.join(" "));
    assert.equal(archiveCliExitCode(action), 2);
  }
});

test("#13686: argumento solto e flag de valor sem valor recusam", () => {
  for (const argv of [
    ["apply"],
    ["--only"],
    ["--only", "--apply"],
    ["--published-min-days", "abc"],
    ["--unpublished-max-days", "-1"],
    ["--apply", "extra"],
  ]) {
    const action = resolveArchiveCliAction(argv);
    assert.equal(action.kind, "error", argv.join(" "));
    assert.equal(archiveCliExitCode(action), 2);
  }
});

test("#13686: os usos documentados seguem rodando", () => {
  for (const argv of [
    [],
    ["--apply"],
    ["--json"],
    ["--apply", "--only", "261027,261028"],
    ["--only=261027"],
    ["--published-min-days", "7"],
    ["--unpublished-max-days", "0", "--json"],
  ]) {
    const action = resolveArchiveCliAction(argv);
    assert.equal(action.kind, "run", argv.join(" "));
    assert.equal(archiveCliExitCode(action), null);
  }
});

test("#13686: o uso lista as flags válidas e o exit 2", () => {
  const usage = formatCliUsage(ARCHIVE_CLI_SPEC);
  for (const flag of ["--apply", "--json", "--only", "--unpublished-max-days", "--published-min-days", "--help"]) {
    assert.ok(usage.includes(flag), flag);
  }
  assert.match(usage, /sai 2/);
});

test("#13686: main() decide o argv antes de chamar runArchive", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "scripts", "archive-video-brutos.ts"), "utf8");
  const mainStart = src.indexOf("async function main(");
  assert.ok(mainStart > 0);
  const body = src.slice(mainStart);
  const guard = body.indexOf("resolveArchiveCliAction(argv)");
  const run = body.indexOf("runArchive(");
  assert.ok(guard > 0 && run > 0 && guard < run, "a validação do argv precisa vir antes de runArchive");
});
