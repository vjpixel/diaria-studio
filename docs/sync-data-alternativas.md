# Alternativas ao Google Drive para sincronizar `data/` entre máquinas (#13851)

Documento pedido no comentário do editor na #13851 (23/11/2026). Recomenda, não
migra: cada migração vira issue própria.

## Problema

`data/` (edições, sentinels, `stage-status`, trava da edição, `session-registry`)
mora na pasta `diaria-studio-data` do Google Drive da diaria.editor desde a
#12359 (11/11/2026). O Neo acessa pelo Drive for desktop; o `300`, por um
`rclone bisync` dedicado (`diaria-gdrive-data-bisync`, #12478) que roda 1 min
depois do fim da rodada anterior. Medido em 10/11/2026: rodada incremental de
~3,5 min, então um arquivo leva no pior caso ~8 min do Drive até o HD do `300`,
mais a latência do Drive for desktop do lado do Neo.

O sync não diz quando um arquivo chegou. Quem lê só vê "o arquivo não está
aqui", e isso é indistinguível de "a etapa não rodou". Daí os guards que já
existem: `stale-edition-guard.ts` (#11690, #13854/#13867), `stage5-freshness.ts`
(#11698), a dica `--sync-hint` (#11729) e, desde esta issue, a espera
`pipeline-sentinel.ts assert --wait-seconds` na pré-condição da Etapa 5. Eles
remendam o sintoma no leitor; nenhum deles dá ao escritor um "entregue".

Duas classes de dado com necessidades diferentes:

1. **Estado de coordenação:** sentinels `.step-N-done.json`, `stage-status`,
   trava da edição (`edition-lock`), claims do `session-registry`. Poucos bytes,
   escrita rara, leitura que decide se uma etapa pode rodar. Precisa de
   consistência e de leitura imediata do que outra máquina escreveu.
2. **Conteúdo da edição:** `.md`, `.json` de trabalho, imagens. Volume maior,
   lido pelo editor no Studio e no celular. Tolera minutos de atraso, desde que
   o estado de coordenação diga se a versão aprovada já chegou (é o que o
   `output_hashes` do sentinel 4 já permite conferir, #11698).

## Opções

| Opção | Latência | "Chegou" verificável | Conflito | Custo | Esforço | Impacto no editor |
|---|---|---|---|---|---|---|
| A. Status quo (Drive + guards no leitor) | ~3–8 min, variável | Não | `.conflictN` do bisync | Zero | Zero | Nenhum |
| B. Estado de coordenação em Cloudflare KV/D1 | Segundos (D1 é consistente; KV leva até ~60 s entre regiões) | Sim, por leitura da API | Escrita condicional no D1 | Free tier (KV já usado pelos Workers do projeto; D1 seria novo) | Médio: sentinel, trava e claim ganham backend remoto, com fallback | Nenhum: conteúdo segue no Drive |
| C. Estado de coordenação num repo/branch git dedicado | Segundos (push/pull) | Sim, pelo SHA no remoto | Merge do git, ruim para escrita concorrente | Zero | Médio | Nenhum |
| D. Syncthing entre Neo e `300` | Segundos em LAN, sem nuvem no meio | Parcial (API local mostra o estado por pasta) | `.sync-conflict-*` | Zero | Médio: instalar nas 2 máquinas, `data/` sai do Drive ou passa a ter 2 caminhos | Studio e celular perdem a cópia na nuvem, a menos que o Drive continue como espelho |
| E. rsync/rclone sobre SSH entre as máquinas | Sob demanda | Sim (exit code do comando) | Nenhum (sentido único por execução) | Zero | Baixo para um empurrão pontual, alto como sync geral | O Neo nem sempre está ligado; não serve de fonte única |
| F. R2 (S3-compatível) como fonte única | Segundos | Sim (PUT confirmado) | Escrita condicional (ETag) | Free tier até 10 GB; `data/` passa disso com imagens | Alto: toda leitura/escrita de `data/` vira chamada de API | Studio e scripts reescritos; perde a pasta local |

## Recomendação

**B, só para o estado de coordenação; o conteúdo fica no Drive.** O problema
das três últimas ocorrências (#11690, #11729, esta) é o leitor não saber se o
sentinel ou a trava de outra máquina existem. Um registro em D1 (free tier; o
projeto já tem Workers com KV, D1 entraria agora) responde isso em segundos e com confirmação de
escrita, sem mudar nada no fluxo do editor, no Studio ou no celular.

Desenho sugerido para a issue de migração, sem decidir aqui:

- `writeSentinel` grava no disco (como hoje) e no D1 (`edition`, `step`,
  `completed_at`, `output_hashes`, `host`). Falha do D1 é warn, nunca bloqueia
  a gravação local.
- `assertSentinel` lê o disco; ausente lá e presente no D1 vira um resultado
  novo, "aprovado em outra máquina, conteúdo em trânsito", com o host e a hora.
  A Etapa 5 espera os outputs com os hashes do D1 em vez de adivinhar pela idade
  dos arquivos.
- Trava da edição e claims do `session-registry` seguem o mesmo caminho numa
  segunda fase (é onde o atraso do Drive quebra o merge lock entre máquinas).

C funciona, mas o git é ruim para escrita concorrente de muitas máquinas no
mesmo arquivo. D e F trocam o problema de lugar e tiram do editor a cópia na
nuvem. E serve só como empurrão pontual (o `300` puxar uma edição do Neo sob
demanda), não como sync.

## O que já mitiga hoje, sem migrar

- `pipeline-sentinel.ts assert --wait-seconds 180` na pré-condição da Etapa 5
  (esta issue): resolve sozinho o caso de 261123 (gate aprovado 3 min antes).
- `stale-edition-guard.ts --caller-stage 5`, sinal `prev_gate_in_transit`
  (#13854, #13867): atividade recente na edição sem o sentinel 4 vira "aguardar
  o sync", não "re-rodar a Etapa 4".
- `stage5-freshness.ts` (#11698): confere os hashes dos arquivos aprovados.

A janela de 3 min cobre o caso medido, mas não o pior caso de ~8 min do bisync
do `300`. Se a espera não bastar com frequência, o próximo passo é B, não uma
janela maior: espera longa só atrasa a resposta quando o gate de fato não foi
aprovado.
