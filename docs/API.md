# Referência da API NFS-e ADN

Este documento descreve as rotas expostas pela aplicação. A URL local padrão é `http://localhost:4000`.

A especificação para importação em clientes HTTP está disponível em [openapi.json](openapi.json) e, com a aplicação em execução, em `GET /docs/openapi.json`.

## Autenticação

As rotas sob `/api` sempre exigem uma sessão de administrador válida ou um token de integração configurado em `API_TOKEN`. Integrações podem enviar o token de duas formas:

```http
Authorization: Bearer SEU_TOKEN
```

```http
x-api-key: SEU_TOKEN
```

Quando `API_TOKEN` está vazio, o acesso por token fica desativado. As rotas `/`, `/health`, `/docs` e `/docs/openapi.json` são públicas.

O painel apresenta um formulário de usuário e senha. O cookie `nfse_session` é enviado automaticamente nas requisições do mesmo domínio, incluindo downloads e uploads. Ele tem duração absoluta de oito horas, `HttpOnly`, `SameSite=Strict` e `Secure` em produção. O cliente `public/api.js` mantém o token CSRF somente em memória. As sessões são revogadas no logout e perdidas ao reiniciar o servidor.

### Sessão do painel

As rotas de autenticação usam `Cache-Control: no-store` e não habilitam CORS. Requisições com `Origin` diferente de `APP_ORIGIN` são rejeitadas. Em desenvolvimento, a origem da própria requisição é utilizada quando a variável está vazia.

| Método | Rota            | Comportamento                                                                                                                                                                           |
| :----- | :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/auth/login`   | Recebe JSON `{"username":"admin","password":"..."}` e o cabeçalho `X-Nfse-Request: panel`. Valida a senha, define o cookie e retorna `csrfToken` e `expiresAt` (Unix em milissegundos). |
| `GET`  | `/auth/session` | Com o cookie válido, retorna `csrfToken` e `expiresAt`; sem sessão, responde `401`.                                                                                                     |
| `POST` | `/auth/logout`  | Revoga a sessão e remove o cookie. Exige `X-Nfse-Request: panel` e, para uma sessão ativa, `X-CSRF-Token`.                                                                              |

Requisições que alteram dados em `/api`, autenticadas por cookie, devem incluir `X-CSRF-Token`. O token é obtido no login ou em `GET /auth/session`. As integrações autenticadas por `Authorization` ou `x-api-key` não precisam desse cabeçalho. Credenciais incorretas retornam `401`; falha na verificação CSRF ou na origem retorna `403`. Após dez tentativas de login por IP em quinze minutos, novas tentativas retornam `429`.

Configure `ADMIN_USERNAME` e `ADMIN_PASSWORD` no ambiente do servidor. A aplicação gera o hash Argon2id em memória na inicialização. Consulte [Login e autenticação da API](../README.md#login-e-autenticação-da-api) para configurar Bun e EasyPanel.

## Formato das respostas

As respostas JSON usam `success` para indicar o resultado. Respostas de sucesso normalmente retornam os dados em `data`:

```json
{
  "success": true,
  "data": {}
}
```

Erros retornam uma descrição em `error` ou `message`:

```json
{
  "success": false,
  "error": "Descrição do erro"
}
```

## Rotas públicas

| Método | Rota                 | Descrição                                         |
| :----- | :------------------- | :------------------------------------------------ |
| `GET`  | `/`                  | Informações da aplicação e da configuração ativa. |
| `GET`  | `/health`            | Estado da aplicação, banco, horário e uptime.     |
| `GET`  | `/docs`              | Interface interativa da especificação OpenAPI.    |
| `GET`  | `/docs/openapi.json` | Especificação OpenAPI em JSON.                    |

## Sincronização

### `POST /api/sync`

Inicia a consulta incremental de documentos do CNPJ a partir do último NSU salvo.

Por padrão, a operação é assíncrona: a API cria um job, responde com HTTP `202` e processa a sincronização em segundo plano. Apenas um job pode ficar ativo por CNPJ.

Para aguardar o processamento na própria requisição, envie `"async": false` no corpo ou use `?sync=true`.

| Campo        | Tipo    | Obrigatório | Padrão           | Descrição                                |
| :----------- | :------ | :---------: | :--------------- | :--------------------------------------- |
| `cnpj`       | string  |     Sim     | —                | CNPJ com 14 dígitos, com ou sem máscara. |
| `nsuInicial` | integer |     Não     | Último NSU salvo | Força o NSU inicial.                     |
| `maxLoops`   | integer |     Não     | `10`             | Máximo de lotes consultados na execução. |
| `async`      | boolean |     Não     | `true`           | Define se a execução será assíncrona.    |

```bash
curl -X POST http://localhost:4000/api/sync \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SEU_TOKEN" \
  -d '{"cnpj":"12345678000195","maxLoops":10}'
```

Resposta assíncrona (`202 Accepted`):

```json
{
  "success": true,
  "message": "Sincronização enfileirada com sucesso em segundo plano.",
  "data": {
    "id": 1,
    "cnpj": "12345678000195",
    "status": "QUEUED",
    "created_at": "2026-09-29T13:00:00.000Z"
  }
}
```

Se já houver um job ativo para o CNPJ, a API responde com `409 Conflict` e retorna o job existente em `data`.

### `GET /api/sync/jobs`

Lista os jobs mais recentes.

| Parâmetro | Tipo    | Obrigatório | Padrão | Descrição                       |
| :-------- | :------ | :---------: | :----- | :------------------------------ |
| `cnpj`    | string  |     Não     | —      | Restringe o histórico ao CNPJ.  |
| `limit`   | integer |     Não     | `20`   | Quantidade máxima de registros. |

### `GET /api/sync/jobs/:id`

Retorna um job de sincronização. Os estados possíveis são `QUEUED`, `PROCESSING`, `COMPLETED` e `FAILED`.

```bash
curl -H "Authorization: Bearer SEU_TOKEN" \
  http://localhost:4000/api/sync/jobs/1
```

### `GET /api/sync/:cnpj`

Retorna o último NSU, o maior NSU conhecido, a data da última sincronização, o estado persistido e a indicação `emExecucao`.

```bash
curl -H "Authorization: Bearer SEU_TOKEN" \
  http://localhost:4000/api/sync/12345678000195
```

## Consulta de notas

Todas as rotas de notas, incluindo detalhes e downloads, exigem o contexto de uma empresa cadastrada. Informe `empresaId=<UUID>` ou `cnpj=<CNPJ>`. No ZIP por CNPJ, o parâmetro de caminho também identifica a empresa. Caso os dois identificadores sejam enviados, eles devem corresponder à mesma empresa.

O contexto restringe as consultas aos vínculos da empresa. O token da API continua sendo uma credencial administrativa compartilhada entre todas as empresas.

### `GET /api/notas`

Lista as notas relacionadas ao CNPJ informado, com eventos e metadados dos documentos XML. Os filtros são aplicados no banco antes da paginação e podem ser combinados.

| Parâmetro     | Tipo    | Obrigatório | Padrão  | Descrição                                                         |
| :------------ | :------ | :---------: | :------ | :---------------------------------------------------------------- |
| `cnpj`        | string  | Condicional | —       | CNPJ da empresa cadastrada; pode ser substituído por `empresaId`. |
| `empresaId`   | string  | Condicional | —       | UUID da empresa cadastrada; pode ser substituído por `cnpj`.      |
| `papel`       | string  |     Não     | `todos` | `prestador`, `tomador` ou `todos`.                                |
| `status`      | string  |     Não     | —       | `AUTORIZADA`, `CANCELADA`, `SUBSTITUIDA` ou `DENEGADA`.           |
| `competencia` | string  |     Não     | —       | Mês de competência no formato `AAAA-MM`.                          |
| `prestador`   | string  |     Não     | —       | Parte do nome ou CNPJ do prestador.                               |
| `tomador`     | string  |     Não     | —       | Parte do nome, CPF ou CNPJ do tomador.                            |
| `chaveAcesso` | string  |     Não     | —       | Chave de acesso completa, somente dígitos.                        |
| `busca`       | string  |     Não     | —       | Número, chave, nome ou documento.                                 |
| `limit`       | integer |     Não     | `100`   | Registros por página, entre 1 e 1000.                             |
| `offset`      | integer |     Não     | `0`     | Deslocamento da paginação.                                        |

A ordenação considera a competência decrescente, seguida pela data de emissão, NSU e chave. Notas sem competência aparecem por último.

```bash
curl -H "Authorization: Bearer SEU_TOKEN" \
  "http://localhost:4000/api/notas?cnpj=12345678000195&competencia=2026-09&papel=prestador&limit=50"
```

Resposta resumida:

```json
{
  "success": true,
  "total": 1,
  "data": [
    {
      "id": 1,
      "chave_acesso": "43260912345678000195550010000000011234567890",
      "nsu": 1,
      "cnpj_prestador": "12345678000195",
      "cnpj_tomador": "98765432000188",
      "razao_social_prestador": "EMPRESA PRESTADORA LTDA",
      "razao_social_tomador": "TOMADOR DOS SERVICOS S.A.",
      "numero_nfse": "100",
      "data_emissao": "2026-09-29T12:00:00Z",
      "competencia": "2026-09-29",
      "valor_servicos": 1500,
      "valor_liquido": 1450,
      "status": "AUTORIZADA",
      "eventos": [],
      "documentos": []
    }
  ]
}
```

### `GET /api/notas/:chaveAcesso`

Retorna uma nota específica, seus eventos e os metadados dos XMLs vinculados. Responde com `404` quando a chave não está armazenada.

## Downloads

Todos os downloads respeitam a autenticação configurada para `/api`.

### `GET /api/notas/:chaveAcesso/xml`

Baixa o XML principal da NFS-e como `NFSe_<CHAVE>.xml`.

```bash
curl -H "Authorization: Bearer SEU_TOKEN" \
  -OJ http://localhost:4000/api/notas/43260912345678000195550010000000011234567890/xml?cnpj=12345678000195
```

### `GET /api/notas/:chaveAcesso/zip`

Baixa o XML principal e todos os eventos vinculados à nota.

```text
NFSe_<CHAVE>.xml
Evento_<TIPO>_NSU<NSU>_<CHAVE>.xml
```

### `GET /api/notas/cnpj/:cnpj/zip`

Baixa os XMLs das notas e dos eventos relacionados ao CNPJ.

O parâmetro `competencia=AAAA-MM` restringe o pacote ao mês de competência inteiro. Os eventos vinculados às notas selecionadas são incluídos independentemente da data do evento. Sem o parâmetro, todas as competências são incluídas.

O endpoint também aceita `papel`, `status`, `prestador`, `tomador`, `chaveAcesso` e `busca`. `limit` e `offset` são ignorados no download em lote.

```bash
curl -H "Authorization: Bearer SEU_TOKEN" \
  -OJ "http://localhost:4000/api/notas/cnpj/12345678000195/zip?competencia=2026-09"
```

```text
Notas/
  NFSe_<CHAVE>.xml
Eventos/
  Evento_<TIPO>_<CHAVE>_<ID>.xml
```

O ID no nome do evento evita colisões entre eventos do mesmo tipo e da mesma nota.

### `GET /api/notas/documento/:id/xml`

Baixa um XML pelo ID armazenado em `documentos_xml`. O nome do arquivo é definido conforme o tipo do documento.

## Códigos HTTP

| Código | Uso                                                     |
| :----: | :------------------------------------------------------ |
| `200`  | Consulta, download ou sincronização síncrona concluída. |
| `202`  | Sincronização assíncrona enfileirada.                   |
| `400`  | Corpo, filtro ou parâmetro inválido.                    |
| `401`  | Sessão ou token ausente, inválido ou expirado.          |
| `404`  | Nota, XML, documento ou job não encontrado.             |
| `409`  | Já existe sincronização ativa para o CNPJ.              |
| `429`  | Rate limit excedido.                                    |
| `500`  | Erro interno ou falha não tratada na integração.        |

## Empresas e certificados

| Método | Rota                           | Uso                                                               |
| :----- | :----------------------------- | :---------------------------------------------------------------- |
| `GET`  | `/api/empresas`                | Lista empresas e metadados do certificado vinculado.              |
| `POST` | `/api/empresas`                | Cadastra nome, CNPJ, situação e certificado opcional.             |
| `PUT`  | `/api/empresas/:id`            | Edita nome, situação e vínculo do certificado. O CNPJ é imutável. |
| `GET`  | `/api/certificados/arquivos`   | Lista arquivos A1 disponíveis na pasta permitida.                 |
| `GET`  | `/api/certificados`            | Lista metadados, sem senhas ou conteúdo dos arquivos.             |
| `POST` | `/api/certificados`            | Valida e cadastra arquivo e senha.                                |
| `PUT`  | `/api/certificados/:id`        | Substitui ou revalida um certificado.                             |
| `POST` | `/api/certificados/upload`     | Recebe, valida e cadastra um certificado enviado.                 |
| `PUT`  | `/api/certificados/:id/upload` | Substitui o arquivo de um certificado cadastrado por upload.      |

Corpo do cadastro de empresa:

```json
{
  "nome": "Empresa Exemplo Ltda.",
  "cnpj": "12345678000195",
  "ativa": true,
  "certificado_id": null
}
```

Corpo do cadastro ou substituição de certificado:

```json
{
  "arquivo": "empresa.pfx",
  "senha": "senha_do_certificado"
}
```

A API valida o certificado antes de persistir sua senha criptografada. Consulte [configuração de empresas e PDFs](EMPRESAS_E_PDF.md) para preparar a pasta e a chave de criptografia.

As rotas de upload recebem `multipart/form-data` com exatamente um arquivo no campo `arquivo` e a senha no campo `senha`. Aceitam `.pfx` ou `.p12` de até 10 MB e usam a mesma autenticação das demais rotas `/api`. O arquivo é validado antes de ser salvo em `CERTIFICATES_DIR`, com nome gerado pelo servidor. O cliente não escolhe o diretório de destino. O retorno contém apenas metadados, sem senha ou conteúdo do certificado.

O cadastro retorna `201`; a substituição, `200`. Erros de conteúdo, senha e formulário retornam `400`; arquivo acima do limite retorna `413`; formato de requisição diferente de multipart retorna `415`; ID não encontrado retorna `404`. Ausência de chave de criptografia ou falha de armazenamento retorna `503`. Para substituir um certificado por upload, use seu ID existente; os vínculos com empresas são preservados e o arquivo anterior não é sobrescrito.

### Remoção de empresas e certificados

`DELETE /api/empresas/:id` remove a empresa dos cadastros disponíveis e desvincula seu certificado, preservando as notas, os XMLs e o histórico. Cadastrar novamente o mesmo CNPJ recupera o cadastro e seus vínculos com os documentos. Um ID inexistente ou já removido retorna `404`.

`DELETE /api/certificados/:id` apaga o cadastro e a senha criptografada. Retorna `409` enquanto o certificado estiver vinculado a alguma empresa e `404` para um ID inexistente. Arquivos enviados pelo painel são apagados quando nenhum outro cadastro utiliza o mesmo arquivo; arquivos disponibilizados manualmente permanecem no servidor. A resposta pode conter `data.aviso` quando o arquivo é mantido ou não pode ser apagado.

As duas operações exigem a mesma autenticação das demais rotas `/api` e proteção CSRF quando utilizadas com a sessão do painel.

## PDFs e exportações

### `GET /api/notas/:chaveAcesso/pdf`

Gera o DANFSe em memória a partir do XML original e do status armazenado. Exige `empresaId` ou `cnpj` na query. Retorna `application/pdf` com nome `DANFSe_<CHAVE>.pdf`.

### `POST /api/notas/pdf/exportacoes`

Exige o contexto da empresa na query. O corpo aceita `{"competencia":"2026-09"}` para exportar todo o mês ou `{}` para todas as notas da empresa. Outros filtros e paginação não restringem esta exportação.

Retorna `202` com o job em `data`. Os campos incluem `id`, `empresa_id`, `status`, `total`, `processadas`, `falhas`, `erro` e `expires_at`.

### `GET /api/notas/pdf/exportacoes/:id`

Consulta o progresso com o mesmo contexto de empresa. Os estados são `QUEUED`, `PROCESSING`, `COMPLETED`, `PARTIAL`, `FAILED` e `EXPIRED`.

### `GET /api/notas/pdf/exportacoes`

Lista em `data` as últimas 20 exportações da empresa no ambiente atual, da mais recente para a mais antiga. Exige `empresaId` ou `cnpj` na query e a mesma autenticação das demais rotas `/api`. Cada item contém o ID, a competência, a data de criação, os contadores, o status e o prazo de expiração. Pacotes cujo prazo já terminou são marcados como `EXPIRED` e removidos do armazenamento temporário.

Esta rota permite recuperar o acompanhamento e o download depois de fechar a página. O painel consulta a lista automaticamente ao selecionar a empresa; o botão de download aparece somente para `COMPLETED` e `PARTIAL`.

### `GET /api/notas/pdf/exportacoes/:id/arquivo`

Baixa o ZIP de uma exportação `COMPLETED` ou `PARTIAL`. Exige o mesmo contexto de empresa. O pacote parcial inclui `falhas.json` com a relação de notas que não puderam ser renderizadas.

O pacote é removido após a transferência ou interrupção do download. Arquivos não baixados expiram pelo prazo configurado. O endpoint retorna `409` quando o pacote ainda não está disponível ou já está sendo transferido, e `410` quando expirou. Falhas na comunicação com Gotenberg retornam `502`; configuração ausente do renderizador ou da criptografia retorna `503`.
