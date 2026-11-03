# Regressão #11940

`atras-high-48k.wav`: trecho 543,900–544,800 s do bruto `20261102_094530.mp4`,
edição 261103, voz do editor dizendo “atrás”. PCM s16le mono 48 kHz,
passa-altas de 3 kHz (ffmpeg: `-ss 543.9 -t 0.9 -map 0:a:0 -ac 1 -ar 48000 -af highpass=f=3000`).
A saída reportada em 544,430 s fica em 0,530 s no fixture.
O fixture usa o mesmo passa-altas de 3 kHz do CLI. O teste verifica
atividade após essa saída, extensão até o silêncio e ausência do aviso na saída corrigida.
Não depende do bruto, do cache local, do ffmpeg nem do Premiere.

O limiar -51 dBFS corresponde à medição da issue (piso -63 dBFS + 12 dB).
Áudio contínuo acima desse limiar sem pausa segura gera aviso, sem autorizar
corte para dentro da palavra. O teste sintético cobre também 340 ms de cauda.
