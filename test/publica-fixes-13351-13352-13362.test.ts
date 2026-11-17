/**
 * #13351, #13352, #13362: lote de correções do `/diaria-publica`.
 *
 * - #13351: `publica-phase.ts run` no Windows repassava o argv por
 *   `spawn(..., { shell: true })`, que junta os argumentos sem escapar: um
 *   `--title "Deepfake do Drauzio"` chegava como `--title Deepfake`. E o
 *   comando do dono do horizontal não levava os overrides do dry-run.
 * - #13352: comentário fixado do trecho só depois de o vídeo ficar público.
 * - #13362: a chamada sem link do TikTok marcava `@diariabr`, handle do
 *   YouTube/X, que no TikTok é menção a outro usuário.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpawnInvocation, escapeCmdArgument } from "../scripts/lib/spawn-argv.ts";
import { planOverrideArgs, pinnedCommentPendingLine } from "../scripts/publish-youtube.ts";
import { commandShape } from "../scripts/lib/diaria/video-publish-plan.ts";
import { parseArgs } from "../scripts/lib/cli-args.ts";
import {
  TIKTOK_NO_BIO_CTA_LINE,
  TIKTOK_NO_BIO_CTA_MAX_CHARS,
  assertTikTokNoBioCtaLine,
  buildTikTokPost,
} from "../scripts/lib/diaria/short-video.ts";

/**
 * Decodifica a linha montada para o `cmd.exe` como o Windows faria: o `cmd`
 * tira os `^` (cada `^x` vira `x`) e o programa separa os argumentos pela
 * regra do `CommandLineToArgvW`. Só para teste, no Linux.
 */
function decodeCmdLine(line: string): string[] {
  const afterCmd = line.replace(/\^(.)/g, "$1");
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < afterCmd.length; i++) {
    const c = afterCmd[i];
    if (c === "\\") {
      let n = 0;
      while (afterCmd[i + n] === "\\") n++;
      if (afterCmd[i + n] === '"') {
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2 === 1) cur += '"';
        else inQuotes = !inQuotes;
        i += n;
      } else {
        cur += "\\".repeat(n);
        i += n - 1;
      }
      started = true;
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
      started = true;
      continue;
    }
    if (c === " " && !inQuotes) {
      if (started) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

describe("#13351 argv com espaço chega inteiro ao comando", () => {
  const argv = ["npx", "tsx", "scripts/publish-youtube.ts", "261117", "--upload", "--title", "Deepfake do Drauzio Varella vende remédio falso"];

  it("fora do Windows: sem shell, argv direto", () => {
    const inv = buildSpawnInvocation(argv, "linux");
    assert.equal(inv.command, "npx");
    assert.deepEqual(inv.args, argv.slice(1));
    assert.deepEqual(inv.options, {});
  });

  it("Windows: cmd.exe /d /s /c com a linha escapada e verbatim; o título volta inteiro", () => {
    const inv = buildSpawnInvocation(argv, "win32", "C:\\Windows\\system32\\cmd.exe");
    assert.equal(inv.command, "C:\\Windows\\system32\\cmd.exe");
    assert.deepEqual(inv.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(inv.options.windowsVerbatimArguments, true);
    const line = inv.args[3];
    assert.ok(line.startsWith('"') && line.endsWith('"'));
    // O /s tira as aspas externas; o resto é a linha do comando.
    assert.deepEqual(decodeCmdLine(line.slice(1, -1)), argv);
  });

  it("Windows: aspas, barras, & | % ^ e argumento vazio sobrevivem ao escape", () => {
    for (const arg of ['a "b" c', "C:\\pasta\\com espaço\\", "x & del y | z", "100% ^ok", "", "--title='já citado'", 'tem\\"barra']) {
      assert.deepEqual(decodeCmdLine(escapeCmdArgument(arg)), [arg], arg);
    }
  });

  it("fora do Windows, o filho recebe o argv intacto (spawn real)", { skip: process.platform === "win32" }, () => {
    const inv = buildSpawnInvocation([process.execPath, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", "--titulo", "Deepfake do Drauzio"]);
    const r = spawnSync(inv.command, inv.args, { encoding: "utf8", ...inv.options });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ["--titulo", "Deepfake do Drauzio"]);
  });

  it("publica-phase.ts não usa mais shell: true com array", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "publica-phase.ts"), "utf8");
    assert.doesNotMatch(src, /shell:\s*process\.platform/);
    assert.match(src, /buildSpawnInvocation\(argv\)/);
  });
});

describe("#13351 comando do dono do horizontal leva os overrides do dry-run", () => {
  it("--title com espaço sai citado e o commandShape segue reconhecendo a flag", () => {
    const { values, flags } = parseArgs(["261117", "--dry-run", "--title", "Deepfake do Drauzio Varella vende remédio falso", "--episode", "12"]);
    const extra = planOverrideArgs(values, flags);
    assert.equal(extra, " --title 'Deepfake do Drauzio Varella vende remédio falso' --episode 12");
    const shape = commandShape(`npx tsx scripts/publish-youtube.ts 261117 --upload --confirm-publish 261117${extra}`);
    assert.deepEqual(shape.flags, ["--episode", "--title", "--upload"]);
  });

  it("aspas simples no título são escapadas para o shell", () => {
    const { values, flags } = parseArgs(["261117", "--title", "O 'golpe' do médico"]);
    assert.equal(planOverrideArgs(values, flags), ` --title 'O '\\''golpe'\\'' do médico'`);
  });

  it("sem override, nada é acrescentado; --video/--captions ficam de fora (mídia vai pelo hash)", () => {
    assert.equal(planOverrideArgs({}, new Set()), "");
    const { values, flags } = parseArgs(["261117", "--video", "I:/x/final.mp4", "--captions", "a.srt", "--no-captions"]);
    assert.equal(planOverrideArgs(values, flags), " --no-captions");
  });
});

describe("#13352 comentário fixado só com o vídeo público", () => {
  it("agendado: a pendência diz depois do publishAt", () => {
    const l = pinnedCommentPendingLine({ privacyStatus: "private", publishAt: "2026-11-17T09:00:00Z" }, "Pra mandar: https://youtu.be/x?t=61");
    assert.match(l, /só depois de 2026-11-17T09:00:00Z/);
    assert.match(l, /não aceita comentário/);
    assert.match(l, /Pra mandar: https:\/\/youtu\.be\/x\?t=61/);
  });
  it("privado sem publishAt: quando for publicado; público: publicar já", () => {
    assert.match(pinnedCommentPendingLine({ privacyStatus: "private" }, "L"), /quando o vídeo \(privado\) for publicado/);
    assert.equal(pinnedCommentPendingLine({ privacyStatus: "public" }, "L"), "[pendente] comentário para publicar e fixar no Studio: L");
  });
  it("a skill diz que o comentário fica pendente até o vídeo ficar público", () => {
    const skill = readFileSync(join(import.meta.dirname, "..", ".claude", "skills", "diaria-publica", "SKILL.md"), "utf8");
    assert.match(skill, /Só com o vídeo já público \(#13352\)/);
    assert.match(skill, /pendente até \{publishAt\}/);
  });
});

describe("#13362 chamada sem link do TikTok não menciona ninguém", () => {
  const d1 = { title: "Você já viu IA mentir?", body: "Um modelo gastou o saldo de terceiros. O caso foi descoberto depois." };
  it("a linha não tem @ e cabe no teto", () => {
    assert.doesNotMatch(TIKTOK_NO_BIO_CTA_LINE, /@/);
    assert.ok(Array.from(TIKTOK_NO_BIO_CTA_LINE).length <= TIKTOK_NO_BIO_CTA_MAX_CHARS);
    assert.doesNotThrow(() => assertTikTokNoBioCtaLine(TIKTOK_NO_BIO_CTA_LINE));
  });
  it("a legenda do TikTok com a chamada não leva @diariabr", () => {
    const { caption } = buildTikTokPost({ d1, ctaVertical: true, tiktokBioLink: false });
    assert.match(caption, /Vídeo completo no canal diar\.ia\.br do YouTube/);
    assert.doesNotMatch(caption, /@diariabr/);
  });
  it("o guard recusa menção e linha acima do teto", () => {
    assert.throws(() => assertTikTokNoBioCtaLine("Vídeo completo no YouTube: @diariabr"), /menção/);
    assert.throws(() => assertTikTokNoBioCtaLine("x".repeat(TIKTOK_NO_BIO_CTA_MAX_CHARS + 1)), /passou de 80/);
  });
});
