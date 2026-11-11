/**
 * #12578 — o pipeline de vídeo aponta para `diaria-studio-video`, da conta
 * diaria.editor (cópia da #12576), em vez da `Mentoria Fluxo VTSD/YouTube` da
 * vjpixel.
 *
 * Trava as quatro peças que precisam virar juntas, porque metade virada
 * quebra em silêncio:
 *   - `publishing.youtube.drive_folder_id` (300: modo API do Drive, fetch dos
 *     finais);
 *   - `DEFAULT_DRIVE_ROOT` (Neo: modo local, e a raiz que o XML grava);
 *   - `publishing.video.vinheta_logo.path`, que precisa morar dentro de
 *     `DEFAULT_DRIVE_ROOT`. Senão o tradutor do #12707 não a troca e ela chega
 *     offline no Mac;
 *   - `publishing.video.premiere_root`, a mesma pasta como o Mac da Bruna a vê:
 *     o symlink `/Users/Shared/diaria-studio-video`, que mantém o e-mail da
 *     conta (parte do caminho do CloudStorage) fora do repo.
 *
 * E o critério de pronto da issue: nenhuma referência ativa à pasta antiga em
 * scripts, skills e setup.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { premierePath, premiereRootFrom, vinhetaConfigFrom } from "../scripts/lib/diaria/video-montage.ts";
import { youtubeFolderIdFrom } from "../scripts/lib/diaria/video-montage-drive.ts";
import { DEFAULT_DRIVE_ROOT } from "../scripts/video-montagem.ts";

const config = JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8"));
const NEW_FOLDER_ID = "10caFTgyR81ZdaLqahMecm-Yu_DgpZqGa";
const MAC_ROOT = "/Users/Shared/diaria-studio-video";

describe("#12578: pasta de vídeo da diaria.editor", () => {
  it("drive_folder_id é o de diaria-studio-video", () => {
    assert.equal(youtubeFolderIdFrom(config), NEW_FOLDER_ID);
  });

  it("a vinheta mora dentro da raiz do Neo (o tradutor do #12707 só troca o que está nela)", () => {
    const vinheta = vinhetaConfigFrom(config);
    assert.ok(vinheta, "publishing.video.vinheta_logo.path ausente");
    assert.ok(vinheta.path.startsWith(`${DEFAULT_DRIVE_ROOT}/`), `vinheta fora da raiz do Neo: ${vinheta.path}`);
  });

  it("premiere_root é a mesma pasta no Mac, e a vinheta sai traduzida para ele", () => {
    const premiere = premiereRootFrom(undefined, config);
    assert.deepEqual(premiere, { root: MAC_ROOT, how: "config" });
    const vinheta = vinhetaConfigFrom(config)!;
    assert.equal(
      premierePath(vinheta.path, { from: DEFAULT_DRIVE_ROOT, to: MAC_ROOT }),
      `${MAC_ROOT}/_marca/vinheta-logo-diaria.mov`,
    );
  });

  it("vinheta_logo.path e premiere_root: nem pasta antiga nem e-mail no caminho", () => {
    const video = config.publishing?.video ?? {};
    for (const [k, v] of [["vinheta_logo.path", video.vinheta_logo?.path], ["premiere_root", video.premiere_root]] as const) {
      assert.equal(typeof v, "string", `publishing.video.${k} ausente`);
      assert.doesNotMatch(v, /Mentoria Fluxo/, `${k} ainda na pasta antiga`);
      assert.doesNotMatch(v, /@/, `${k} com e-mail no caminho`);
    }
  });

  /*
   * Menção histórica fica, desde que a mesma linha cite a #12578 ("até a
   * virada da #12578 era …") ou a #12789 (o arquivamento, que saiu da pasta
   * antiga nela e só a guarda para uma rodada manual). Fora do guard:
   *   - gdrive-quota.ts: fala da cota da vjpixel, onde a pasta antiga fica.
   */
  it("scripts, skills e setup não apontam mais para a pasta antiga", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const OLD = /Mentoria Fluxo.{0,6}VTSD.{0,3}YouTube|pasta YouTube|G:[/\\]Meu Drive[/\\]Work/;
    const SKIP = new Set(["scripts/lib/gdrive-quota.ts"]);
    const files: string[] = [join(root, "docs", "setup.md")];
    const walk = (dir: string, ext: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, ext);
        else if (e.name.endsWith(ext)) files.push(p);
      }
    };
    walk(join(root, "scripts"), ".ts");
    walk(join(root, ".claude", "skills"), ".md");
    const hits: string[] = [];
    for (const f of files) {
      const rel = relative(root, f).split("\\").join("/");
      if (SKIP.has(rel)) continue;
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (OLD.test(line) && !line.includes("#12578") && !line.includes("#12789")) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    assert.deepEqual(hits, [], `referências à pasta antiga:\n${hits.join("\n")}`);
  });
});
