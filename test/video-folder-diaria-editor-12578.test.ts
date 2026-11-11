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
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { premierePath, premiereRootFrom, vinhetaConfigFrom } from "../scripts/lib/diaria/video-montage.ts";
import { youtubeFolderIdFrom } from "../scripts/lib/diaria/video-montage-drive.ts";
import { DEFAULT_DRIVE_ROOT } from "../scripts/video-montagem.ts";

const config = JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8"));
const NEW_FOLDER_ID = "10caFTgyR81ZdaLqahMecm-Yu_DgpZqGa";
const OLD_FOLDER_ID = "1GmQ5M1bPMYoxqyJfHCHAyFyXiGyVZ0k3";

describe("#12578: pasta de vídeo da diaria.editor", () => {
  it("drive_folder_id é o de diaria-studio-video, não o da pasta antiga", () => {
    assert.equal(youtubeFolderIdFrom(config), NEW_FOLDER_ID);
    assert.notEqual(youtubeFolderIdFrom(config), OLD_FOLDER_ID);
  });

  it("a raiz do Neo é a diaria-studio-video no I: (conta diaria.editor)", () => {
    assert.equal(DEFAULT_DRIVE_ROOT, "I:/Meu Drive/diaria-studio-video");
  });

  it("a vinheta mora dentro da raiz do Neo (o tradutor do #12707 só troca o que está nela)", () => {
    const vinheta = vinhetaConfigFrom(config);
    assert.ok(vinheta, "publishing.video.vinheta_logo.path ausente");
    assert.ok(vinheta.path.startsWith(`${DEFAULT_DRIVE_ROOT}/`), `vinheta fora da raiz do Neo: ${vinheta.path}`);
  });

  it("premiere_root é a mesma pasta no Mac, e a vinheta sai traduzida para ele", () => {
    const premiere = premiereRootFrom(undefined, config);
    assert.equal(premiere.how, "config");
    assert.ok(premiere.root);
    assert.equal(premiere.root, "/Users/Shared/diaria-studio-video");
    const vinheta = vinhetaConfigFrom(config)!;
    assert.equal(
      premierePath(vinheta.path, { from: DEFAULT_DRIVE_ROOT, to: premiere.root }),
      `${premiere.root}/_marca/vinheta-logo-diaria.mov`,
    );
  });

  it("nenhum caminho do config aponta para a pasta antiga nem carrega e-mail", () => {
    const video = config.publishing.video;
    for (const [k, v] of [["vinheta_logo.path", video.vinheta_logo.path], ["premiere_root", video.premiere_root]] as const) {
      assert.doesNotMatch(String(v), /Mentoria Fluxo/, `${k} ainda na pasta antiga`);
      assert.doesNotMatch(String(v), /@/, `${k} com e-mail no caminho`);
    }
  });
});
