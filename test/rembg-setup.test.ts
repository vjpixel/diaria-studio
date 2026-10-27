import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// #11162: a capa horizontal só consome o --portrait já recortado, então não
// pode exigir o venv do rembg (que só existe no Neo). Sem o venv, o script
// segue até validar os insumos — aqui chega no "não existe" do retrato.
it("capa horizontal não exige o venv do rembg para consumir o retrato já recortado", {
  // #11223: o venv também pode existir no 300 (Linux, bin/python).
  skip: existsSync(new URL("../.venv-rembg/Scripts/python.exe", import.meta.url))
    || existsSync(new URL("../.venv-rembg/bin/python", import.meta.url)),
}, () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/gen-youtube-thumb.ts",
    "261025", "--hook", "IA ladra?", "--portrait", "inexistente.png",
    "--background", "inexistente-fundo.jpg"], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stderr, /rembg/);
  assert.match(result.stderr, /inexistente\.png não existe/);
});

const python = process.platform === "win32" ? "python" : "python3";
const available = spawnSync(python, ["--version"]).status === 0;

// #11370: no Neo o --output sob data/ (junction do OneDrive) morria com um
// `[Errno 2]` cru. Agora o PNG nasce no temporário do sistema e só depois vai
// pro destino; pasta inacessível vira erro com a causa e o contorno.
it("recorte grava via temporário e explica destino inacessível em data/ (#11370)", { skip: !available }, () => {
  const result = spawnSync(python, ["-c", String.raw`
import os, runpy, tempfile
from pathlib import Path
m = runpy.run_path('scripts/setup-rembg.py')
write_output = m['write_output']
before = set(os.listdir(tempfile.gettempdir()))
with tempfile.TemporaryDirectory() as d:
    missing = Path(d) / 'data' / 'editions' / '2610' / '261028' / 'retrato.png'
    try:
        write_output(missing, b'png')
        raise AssertionError('gravou em pasta inexistente')
    except RuntimeError as e:
        msg = str(e)
        assert 'inacessível pelo Python' in msg, msg
        assert str(missing.parent) in msg, msg
        assert 'fora de data/' in msg, msg
    ok = Path(d) / 'retrato.png'
    write_output(ok, b'png-bytes')
    assert ok.read_bytes() == b'png-bytes'
leftover = [n for n in set(os.listdir(tempfile.gettempdir())) - before if n.startswith('rembg-')]
assert not leftover, leftover
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
it("setup recusa venv errado e versão divergente sem instalar pacotes", { skip: !available }, () => {
  const result = spawnSync(python, ["-c", String.raw`
import runpy, sys
from unittest.mock import patch
m = runpy.run_path('scripts/setup-rembg.py')
check = m['check']
with patch.object(sys, 'version_info', (3,11,9)), patch.object(sys, 'prefix', '/wrong-venv'):
    try:
        check()
        raise AssertionError('aceitou Python global')
    except RuntimeError as e:
        assert 'venv' in str(e) and 'py -3.11' in str(e)
with patch.object(sys, 'version_info', (3,11,9)), patch.object(sys, 'prefix', str(m['VENV'])), patch('importlib.metadata.version', return_value='0.0.0'):
    try:
        check()
        raise AssertionError('aceitou versão divergente')
    except RuntimeError as e:
        assert 'Versão incorreta' in str(e)
with patch.object(sys, 'argv', ['setup-rembg.py']), patch.object(sys, 'platform', 'darwin'), patch('subprocess.run') as run:
    try:
        m['main']()
        raise AssertionError('instalou no macOS')
    except RuntimeError as e:
        assert 'Neo' in str(e) and '300' in str(e)
    run.assert_not_called()
# #11223: Linux x86_64 (o 300) passa a ser suportado, mas a versão exata segue exigida.
sp = m['supported_platform']
assert sp('linux', 'x86_64') and sp('win32', 'AMD64')
assert not sp('linux', 'aarch64') and not sp('darwin', 'x86_64')
with patch.object(sys, 'argv', ['setup-rembg.py']), patch.object(sys, 'platform', 'linux'), patch('platform.machine', return_value='x86_64'), patch.object(sys, 'version_info', (3,12,3)), patch('subprocess.run') as run:
    try:
        m['main']()
        raise AssertionError('instalou com Python errado no Linux')
    except RuntimeError as e:
        assert '3.11.9' in str(e) and 'uv python' in str(e)
    run.assert_not_called()
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
