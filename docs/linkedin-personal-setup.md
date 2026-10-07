# LinkedIn pessoal automatizado (#9568)

O 4º post diário (item USE MELHOR, `## um` de `03-social.md`) sai na página
diar.ia.br pelo Stage 5. No perfil **pessoal** do editor, o mesmo texto saía
por lembrete manual do Stage 6. Com este setup ele sai sozinho, no mesmo
horário da página. Sem o setup (ou com o token vencido), nada quebra: o Stage
6 volta a mostrar o lembrete manual.

Decisão do editor (07/10/2026): **app LinkedIn separado**. O app da página
(`77tIvy0623oq84`) está em análise da Community Management API, que a LinkedIn
exige como produto único do app. Não adicionar nada nele.

## 1. Criar o app (uma vez)

1. Em https://www.linkedin.com/developers/apps, **Create app**. Nome sugerido:
   `diar.ia.br pessoal`. Página associada: a da diar.ia.br (a LinkedIn exige
   uma página, mas o post sai no perfil de quem autoriza).
2. Aba **Products**, pedir os dois (ambos têm aprovação imediata):
   - **Share on LinkedIn** (escopo `w_member_social`, para publicar);
   - **Sign In with LinkedIn using OpenID Connect** (escopos `openid profile`,
     só para descobrir a URN da pessoa).
3. Aba **Auth**, em **Authorized redirect URLs for your app**, adicionar
   exatamente:

   ```
   http://localhost:8766/linkedin/callback
   ```

4. Ainda na aba **Auth**, copiar o **Client ID** e o **Primary Client Secret**
   e gravar no Doppler (é de lá que o `.env` das duas máquinas sai):

   ```
   doppler secrets set LINKEDIN_PERSONAL_CLIENT_ID
   doppler secrets set LINKEDIN_PERSONAL_CLIENT_SECRET
   npm run sync-env
   ```

## 2. Rodar o OAuth (agora e a cada ~60 dias)

Na máquina do editor (Neo), com o navegador logado na conta **pessoal**:

```
npx tsx scripts/linkedin-personal-oauth.ts
```

O script abre o navegador, recebe o código em `localhost:8766`, troca pelo
token, lê a URN da pessoa em `/v2/userinfo` e grava, sem imprimir nenhum
valor, no Doppler e no `.env` local:

| Variável | Conteúdo |
|---|---|
| `LINKEDIN_PERSONAL_ACCESS_TOKEN` | token `w_member_social` (60 dias, sem refresh token) |
| `LINKEDIN_PERSONAL_PERSON_URN` | `urn:li:person:{id}` |
| `LINKEDIN_PERSONAL_TOKEN_EXPIRES_AT` | expiração em ISO, lida pelo alarme |

Depois, no `300`: `npm run sync-env`. Opcional: `LINKEDIN_PERSONAL_API_VERSION`
(YYYYMM); vazio usa a versão de dois meses atrás, que a LinkedIn sempre suporta.

## 3. Armar as tasks no `300` (uma vez, depois do merge)

Duas tasks (registro em `scripts/lib/scheduled-tasks.ts`):

- `Diaria-LinkedIn-Personal`, diária às 07:46 BRT, um minuto depois de
  `publishing.social.use_melhor_time`: dispara o post e roda o alarme;
- `Diaria-LinkedIn-Personal-Catchup`, de hora em hora: só dispara. Cobre o
  post cujo horário foi deslocado (past-slot guard, Stage 5/6 atrasados).

Armar como as outras (`scripts/setup-systemd-timers.ts`, ver
`docs/scheduled-tasks-registry.md`).

Se o Doppler recusar a gravação no passo 2, o script mostra o stderr do
Doppler e o diretório: as causas comuns são `doppler login` vencido ou o
diretório sem `doppler setup` (projeto/config errado, ver `doppler configure`).
Nesse caso as chaves ficam só no `.env` local e o próximo `npm run sync-env`
nessa máquina aborta (guard de chave só-local, #5155) até o vault ter as
mesmas chaves.

## Como funciona

1. **Stage 6, antes do gate:** `publish-linkedin-personal.ts --check
   --edition-dir {dir}` simula o arme sem gravar nada. Só diz AUTOMÁTICO (exit
   0) quando: o token existe, a URN é válida, o token não expira antes do
   post e responde em `GET /v2/userinfo` (401/403 = revogado), o `## um` tem
   plano `ready`, a página agendou o 4º post (`scheduled_at` não nulo) e uma
   das duas tasks roda entre esse horário e 3h depois dele. Qualquer outra
   resposta: lembrete manual, igual a antes.
2. **Stage 6, depois do `ok`:** `--arm --edition-dir {dir}` grava
   `_internal/06-linkedin-personal.json` com o texto (o mesmo que
   `resolve-post-pixel.ts` devolve: `## um`, sem markdown, com a UTM do Use
   Melhor), a capa do carrossel quando o carimbo está em dia, o `scheduled_at`
   real da entry `linkedin`/`um` da página e a impressão digital do token (a
   expiração). Exit ≠ 0 depois de um pré-gate AUTOMÁTICO reexibe o lembrete
   manual.
3. **Disparo:** `--fire-due` publica toda intenção `armed` de hoje ou ontem
   (BRT) cujo horário já passou, com até 3h de atraso (3h exatas ainda saem;
   além disso vira `expired`, exit 1). Criar o lock
   `_internal/06-linkedin-personal.lock` (exclusivo) é a passagem para
   `posting`, gravado antes da chamada: duas execuções ao mesmo tempo ou um
   crash nunca geram post duplicado. Resultados:
   - `published` + `post_url`;
   - `failed_before_send`: nada foi criado (token ausente nesta máquina,
     token revogado, imagem ausente, upload falho, 4xx). Pode ser re-armado;
   - `send_unknown`: o POST pode ter saído (timeout, erro de rede, 5xx).
     Terminal: conferir o perfil antes de qualquer ação;
   - `expired`: passou da janela. Pode ser re-armado.
   Token desta máquina diferente do que armou: o post sai, com aviso para
   rodar `npm run sync-env` no `300`. Falha sai com exit 1, e o alarme de
   units systemd falhas pega.
4. **Alarme** (`linkedin-personal-token-alarm.ts`, 2º passo da task das
   07:46):
   - token: P2 a 14 dias do vencimento; P1 a 3 dias ou menos, expirado, ou
     revogado (`/v2/userinfo` 401/403); P2 "expiração desconhecida" quando
     `LINKEDIN_PERSONAL_TOKEN_EXPIRES_AT` está ausente ou ilegível. Fecha
     sozinho quando o token novo chega ao `.env` do `300`;
   - intenções dos últimos 7 dias: `posting`/`send_unknown` há mais de 1h,
     `armed` vencido há mais de 3h, `armed` sem token nesta máquina.

## Limitações

- A Posts API não agenda: se nenhuma task rodar na janela de 3h (máquina
  fora, timer desarmado), o post não sai e vira `expired`.
- Só o 4º post (`## um`) é automatizado. Edição antiga com `## post_pixel`
  segue manual.
- Se o editor postar à mão numa edição já armada, o automático também posta.
  Quem arma é o `ok` do Stage 6; o lembrete diz quando o post é automático.
