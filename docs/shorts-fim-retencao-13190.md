# Queda de retenção no fim dos Shorts, com e sem chamada final (#13190)

Medição pedida na #13190 (épica #12072). Decisão do editor no briefing overnight 261116b: a rodada entrega **só a medição**, sem mudar a regra do fim dos verticais e sem testar fim em loop. Nada em `.claude/skills/diaria-video-roteiro/SKILL.md` nem em `publishing.video.roteiro.alvo_s` mudou.

## Como reproduzir

```
npx tsx scripts/shorts-end-retention.ts                 # snapshot mais recente, cauda de 3 s
npx tsx scripts/shorts-end-retention.ts --cauda-s 6     # cauda de 6 s
npx tsx scripts/shorts-end-retention.ts --date 2026-11-16 --json
```

Só lê o que já está em disco, sem API: `data/youtube-analytics/{videos,retention}.jsonl` (snapshot do `youtube-analytics-snapshot.ts`, #12075), os `06-shorts-published.json` da edição e de `data/cortes/{slug}/`, e a transcrição da sequência montada (`_internal/video-montagem/seq-*.transcript.json`). Lógica em `scripts/lib/diaria/shorts-end-retention.ts`, testes em `test/shorts-end-retention-13190.test.ts`.

## O que mudou em relação à análise preliminar (comentário de 16/11 na issue)

A análise preliminar concluiu que não dava para separar vertical 1 de vertical 2 porque o `roteiro-falas.json` só existe a partir de 261116. Dá, por outro caminho:

1. **Qual peça é cada Short.** O `youtube_shorts` do `06-shorts-published.json` da edição é o vertical da edição (sequência `outras-redes` da montagem). O de `data/cortes/{nome}-{AAMMDD}/` é corte: vertical 2/extra da edição AAMMDD (sequência `seq-{nome}`) ou corte avulso.
2. **Como cada vertical termina.** A transcrição da sequência montada tem a fala com tempo por palavra. O script lê os últimos 12 s e classifica o fim em: chamada para o vídeo completo (#12735), chamada like/segue ("gostou? dá um like, segue a diar.ia.br"), pergunta ao público, ou sem chamada.
3. **Duração real.** `averageViewDuration / averageViewPercentage` da API bate com a duração lida no YouTube Studio dos 5 Shorts da tabela do editor com erro de 1 a 2 s (Lula 74 x 75, Golpe 51 x 52, Meta 64 x 65, Nubank 53 x 54, Claude Code 66 x 67), inclusive no Nubank, que tem replay. A análise preliminar tratou essa razão como estimativa ruim; ela é a melhor fonte que temos. A duração da montagem diverge mais (Meta 70 x 65).
4. **Uma correção de rótulo.** "Claude Code pode ter vazado suas senhas no GitHub" (`Hkx35UI-XCM`) é o **vertical 1** de 261112, o único Short da janela com a chamada falada para o vídeo completo. A análise preliminar o tomou por corte. O corte "guia" de 261112 (`S6ray81NGbg`) ainda não aparece no snapshot.

A montagem só vale como o fim publicado quando a duração dela bate com a da API (até 15% de diferença). Dois Shorts ficam fora dos grupos por isso: o de 261030 (montagem 102 s, publicado 83 s) e o de 261028 (montagem 211 s, publicado 75 s). O editor reexportou outro corte, e não há como saber se a chamada ficou.

## Resultado (snapshot 2026-11-16, janela 21/10 a 15/11)

Grupos só com Shorts de 100+ views, fim conhecido e montagem que confere. "Queda cauda" = fração de quem chegou ao início da cauda e saiu antes do fim. "Cauda/corpo" = velocidade da queda na cauda dividida pela velocidade da queda entre 50% e 90% do vídeo (1 = cai no mesmo ritmo do corpo).

| Short | Peça | Views | % vis. | Duração | Fim | Queda 3 s | Queda 6 s | Cauda/corpo (3 s) | Queda durante a chamada |
|---|---|---|---|---|---|---|---|---|---|
| Lula promete uma IA brasileira | vertical 1 | 1.379 | 54,1 | 74 s | like/segue | 35% | 42% | 6,3 | 42% em 5,9 s |
| Golpe da selfie | vertical 1 | 1.337 | 78,2 | 51 s | like/segue | 10% | 29% | 2,0 | 30% em 6,6 s |
| Justiça proíbe Meta | vertical 1 | 638 | 44,0 | 64 s | pergunta | 12% | 21% | 1,9 | 22% em 6,4 s |
| Nubank demite antifraude | vertical 1 | 469 | 104,8 | 53 s | sem chamada | 34% | 40% | 8,0 | — |
| O que é IA soberana? | corte | 194 | 75,3 | 82 s | like/segue | 25% | 30% | 21,9 | 28% em 5,0 s |
| Nvidia: CEO admite caso | vertical 1 | 158 | 60,6 | 50 s | sem chamada | 51% | 61% | 10,5 | — |
| Claude Opus 5.5 x Mistral | vertical 1 | 134 | 34,0 | 88 s | like/segue | 49% | 54% | 6,8 | 54% em 5,2 s |

Medianas por grupo:

| Grupo | n | % vis. | Duração | Queda 3 s | Cauda/corpo (3 s) | Queda 6 s | Cauda/corpo (6 s) |
|---|---|---|---|---|---|---|---|
| com chamada final (like/segue) | 4 | 64,7 | 78 s | 30% | 6,6 | 36% | 4,2 |
| sem chamada final (sem chamada + pergunta) | 3 | 60,6 | 53 s | 34% | 8,0 | 40% | 5,3 |

Duração x % visualizada (14 Shorts de 100+ views): Pearson -0,40, Spearman -0,35.

## Leitura

1. **A chamada final não aparece como custo de retenção.** Todo Short perde gente nos últimos segundos, com ou sem chamada. Os dois sem chamada (Nubank, Nvidia) perdem *mais* na cauda que a mediana dos com like/segue, nos dois tamanhos de cauda e na razão cauda/corpo. O Golpe da selfie, que termina com 6,6 s de like/segue, tem a menor queda de cauda dos grandes (10% em 3 s). O sinal que a análise do Gemini descreve (o espectador percebe o fim e desliza) aparece, mas não depende da chamada: é o fim em si.
2. **A chamada para o vídeo completo (#12735) não tem medição.** Só um Short da janela a tem (261112, 46 views). Nada a concluir sobre ela.
3. **n é pequeno.** 7 Shorts nos grupos, 2 sem chamada. A diferença entre os grupos está dentro da variação entre Shorts do mesmo grupo (like/segue vai de 10% a 49% na cauda de 3 s). Os grupos também diferem em duração (78 s x 53 s), o que mistura os dois efeitos.
4. **Duração pesa, sem decidir sozinha.** Correlação negativa e fraca (-0,40). Dos 3 Shorts com 1,3 a 1,4 mil views, o Golpe da selfie tem 51 s e retém 78%; Lula (74 s) e ChatGPT (83 s) ficam em 54% e 56%. A fala do Golpe é a mais rápida da amostra (164 palavras/min, contra 129 do Lula; o ChatGPT fica sem ritmo porque a montagem não confere). Ritmo de cortes de imagem não está nos dados.

## Recomendação

- **Manter a regra do fim dos verticais como está.** A medição não mostra custo da chamada final. Nenhuma das três opções da issue ((a) encurtar, (b) tirar da fala, (c) fim em loop) tem base nestes dados.
- **Repetir a medição quando houver 5+ Shorts com a chamada para o vídeo completo e 100+ views** (verticais de 261112 em diante), com o mesmo comando. É a única comparação que responde a pergunta da #12735; hoje ela tem n = 1.
- **`alvo_s` dos verticais (60 s):** a correlação não sustenta baixar ainda. Reavaliar na mesma rodada da medição acima, olhando duração e palavras/min juntas.
- **Teste de fim em loop:** segue como parte não feita da #13190 (fora do escopo desta rodada por decisão do editor).

## Limites conhecidos

- A curva de retenção tem passo de 1% da duração (0,5 a 0,9 s nestes Shorts). A cauda de 3 s é interpolada.
- O ponto de 100% da curva sempre cai mais (último bucket). Afeta todos os grupos igual, então não distorce a comparação, mas infla a queda absoluta.
- O fim vem da montagem, não do arquivo exportado. Onde a duração confere, a diferença é de 1 a 5 s; onde não confere, o Short sai dos grupos.
- Shorts de 21/10 a 27/10 e os cortes avulsos (Jensen Huang, modelos do ChatGPT) não têm transcrição de montagem e ficam como "sem transcrição".
