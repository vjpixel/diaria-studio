# Shorts: duração × percentual assistido × views

Medição de 16/11/2026 para a [issue #13200](https://github.com/vjpixel/diaria-studio/issues/13200), usando o snapshot de [#12075](https://github.com/vjpixel/diaria-studio/issues/12075).

## Decisão

**Manter por enquanto `alvo_s.vertical1` e `alvo_s.vertical2` em 60 s.** A amostra sugere associação entre menor duração e maior percentual médio assistido, mas não confirma um corte específico em 50–55 s nem que encurtar cause aumento de views. Não há observações entre 55 e 65 s: qualquer corte nesse intervalo produziria os mesmos grupos. O teto da prévia e o texto da skill permanecem como estão por essa razão.

Os quatro vídeos de até 55 s têm mediana de 69,42% assistido, contra 43,95% nos 13 acima de 60 s. Contudo, o vídeo de 49 s ficou em 35,30%, enquanto vídeos de 67 e 83 s atingiram 78,99% e 75,30%. Dois dos três Shorts com pelo menos mil views têm mais de um minuto. Nenhum chegou a dez mil views; esta amostra não demonstra um limite de entrega nessa marca.

## Fonte e método

- Analytics: captura completa mais recente de `data/youtube-analytics/videos.jsonl`, em **15/11/2026 às 14:35:01.913 UTC**, janela acumulada **21/10 a 14/11/2026**. Uma linha por vídeo dessa captura; não somar snapshots diários cumulativos.
- Duração total: `contentDetails.duration` da API oficial `videos.list`, lida em **16/11/2026 às 04:16:49.197 UTC**, porque o snapshot não persiste esse campo. Não estimar duração dividindo médias arredondadas. A duração atual pode diferir da histórica se o vídeo tiver sido editado no YouTube; não há histórico dessa duração no snapshot.
- Universo: todos os **17 Shorts da captura**, incluindo quatro avulsos/cortes sem edição. Os 13 Shorts do índice de edições atual estão presentes. Os 17 retornaram com `privacyStatus=public`. Isso não é inventário de vídeos sem linhas de Analytics nem de publicações posteriores à janela.
- O índice atual de edições (#12224) prevalece sobre a classificação antiga por duração: `MMyBVHVQELI` é horizontal, embora uma captura de 04/11 o tenha marcado como Short. Não misturar essa linha antiga com a captura mais recente.
- “Retenção” nesta tabela significa **`averageViewPercentage`**, o percentual médio assistido. Não é a proporção de pessoas que “continuaram assistindo” em vez de deslizar no feed; essa métrica não está no snapshot. Valores acima de 100% são compatíveis com repetição. Views são o campo `views` do snapshot, sem conversão para engaged views.

O [extrato de evidência](shorts-duracao-retencao-13200.json) preserva os valores usados, a duração ISO retornada pela API, datas de publicação, identificadores e SHA-256 do arquivo de Analytics lido. Nenhuma credencial é incluída.

## Tabela por Short

Ordenada por duração total; views e percentual assistido vêm da mesma janela de Analytics.

| Edição | Vídeo | Duração (s) | % médio assistido | Views |
|---|---|---:|---:|---:|
| 261027 | [Google Photos](https://www.youtube.com/watch?v=UYllsanoQqw) | 49 | 35,30 | 140 |
| 261110 | [Nvidia: suposta espiã](https://www.youtube.com/watch?v=7rAJiUe-qcg) | 51 | 60,62 | 158 |
| 261104 | [Golpe da selfie](https://www.youtube.com/watch?v=BQkZjUGWTDQ) | 52 | 78,22 | 1.336 |
| 261111 | [Nubank: demissões](https://www.youtube.com/watch?v=B8I7kxAaIDI) | 54 | 106,96 | 439 |
| 261105 | [Meta e reportagens](https://www.youtube.com/watch?v=5CZ0zFFJ4RM) | 65 | 43,95 | 638 |
| 261112 | [Claude Code e senhas](https://www.youtube.com/watch?v=Hkx35UI-XCM) | 67 | 78,99 | 40 |
| 261023 | [Falhas no PHP](https://www.youtube.com/watch?v=X4j2u-WxFvk) | 73 | 42,64 | 138 |
| 261029 | [Lula e IA brasileira](https://www.youtube.com/watch?v=uIwtuFBqGkg) | 75 | 54,11 | 1.379 |
| 261028 | [GPT-6.1 Terra](https://www.youtube.com/watch?v=27q1xuvBUc4) | 76 | 52,02 | 86 |
| Avulso | [IA como máquina](https://www.youtube.com/watch?v=WEAmxrYpr1E) | 80 | 52,27 | 107 |
| Avulso | [IA soberana](https://www.youtube.com/watch?v=-ZMq-9gWoSc) | 83 | 75,30 | 194 |
| 261030 | [ChatGPT e morte da filha](https://www.youtube.com/watch?v=4Sdq1thhSAA) | 84 | 55,62 | 1.401 |
| Avulso | [Modelo do ChatGPT](https://www.youtube.com/watch?v=5fsKYRaf4g4) | 84 | 40,23 | 109 |
| 261103 | [Opus e Mistral](https://www.youtube.com/watch?v=5jX3X0sgMtg) | 89 | 34,15 | 132 |
| 261022 | [Proteínas e escorpião](https://www.youtube.com/watch?v=K3GqRK5gFds) | 114 | 39,56 | 34 |
| 261021 | [IA mentir e roubar](https://www.youtube.com/watch?v=nhMUtgPPs4U) | 120 | 37,33 | 109 |
| Avulso | [Jensen Huang](https://www.youtube.com/watch?v=bV09g-rLZW4) | 133 | 43,73 | 368 |

## Comparação das faixas

Médias e medianas calculadas por vídeo, sem ponderar por views. Total de views é soma; não representa exposição igual por vídeo.

| Duração | Vídeos | Média % assistido | Mediana % assistido | Views totais | Mediana views | Vídeos ≥1.000 views |
|---|---:|---:|---:|---:|---:|---:|
| ≤55 s | 4 | 70,28 | 69,42 | 2.073 | 298,5 | 1 |
| >55 a ≤60 s | 0 | — | — | 0 | — | 0 |
| >60 s | 13 | 49,99 | 43,95 | 4.735 | 132 | 2 |

A diferença descritiva de medianas é de **25,47 pontos percentuais**. A comparação não controla tema, chamada final/loop (#13190), data de publicação, origem do tráfego ou tempo de exposição. Os quatro curtos foram publicados entre 27/10 e 11/11; os demais, entre 22/10 e 12/11. Não é experimento com durações atribuídas aleatoriamente. A faixa curta tem apenas quatro observações e inclui o único vídeo com percentual acima de 100%.

## Reavaliação

Repetir o cruzamento por volta de **30/11/2026**, com a captura completa mais recente e durações oficiais, preservando este extrato como baseline. Não há agendamento criado por esta medição. Usar o mesmo índice de classificação, separar métricas ausentes de zero e registrar vídeos sem cobertura. Comparar também janelas de exposição equivalentes quando houver dados por vídeo/dia; o snapshot atual por vídeo é acumulado e não permite esse controle.

Só decidir por 50–55 s com evidência que permita distinguir essa faixa dos vizinhos e verificar se o sinal persiste entre temas e chamadas finais distintos. Se a próxima amostra continuar sem vídeos próximos ao corte, registrar a incerteza novamente, sem tratar ausência de observações como confirmação.

Para conferir os agregados a partir do extrato versionado:

```bash
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
const { rows } = JSON.parse(readFileSync('docs/shorts-duracao-retencao-13200.json', 'utf8'));
const median = values => {
  const xs = values.toSorted((a, b) => a - b), m = Math.floor(xs.length / 2);
  return xs.length ? (xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2) : null;
};
for (const [range, group] of [
  ['≤55', rows.filter(r => r.durationSec <= 55)],
  ['>55 a ≤60', rows.filter(r => r.durationSec > 55 && r.durationSec <= 60)],
  ['>60', rows.filter(r => r.durationSec > 60)],
]) {
  console.log({ range, n: group.length,
    meanPct: group.length ? group.reduce((s, r) => s + r.averageViewPercentage, 0) / group.length : null,
    medianPct: median(group.map(r => r.averageViewPercentage)),
    views: group.reduce((s, r) => s + r.views, 0),
    medianViews: median(group.map(r => r.views)),
    atLeast1000: group.filter(r => r.views >= 1000).length });
}
JS
```
