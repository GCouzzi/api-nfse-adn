# 📖 Documentação da API NFS-e ADN

Esta documentação descreve todos os endpoints, parâmetros, formatos de dados, códigos de status e exemplos práticos para consumir a **API NFS-e Nacional ADN**.

---

## 🔐 Autenticação

Todas as rotas sob o prefixo `/api/*` exigem autenticação prévia configurada via variável `API_TOKEN`.

Envie a chave secreta utilizando uma das duas opções:

### Opção 1: Bearer Token (Recomendada)
```http
Authorization: Bearer <API_TOKEN>
```

### Opção 2: Cabeçalho Customizado
```http
x-api-key: <API_TOKEN>
```

*(As rotas públicas `/` e `/health` e `/docs` não requerem token).*

---

## 📡 Visão Geral dos Endpoints

| Método | Endpoint | Descrição | Autenticado? |
| :--- | :--- | :--- | :---: |
| `GET` | `/health` | Healthcheck da aplicação e banco | Não |
| `GET` | `/docs` | Documentação interativa Swagger/OpenAPI | Não |
| `GET` | `/docs/openapi.json` | Especificação OpenAPI 3.0 em JSON | Não |
| `POST` | `/api/sync` | Dispara sincronização de NSUs (Assíncrono) | **Sim** |
| `GET` | `/api/sync/jobs/:id` | Consulta o andamento de um Job de Sync | **Sim** |
| `GET` | `/api/sync/jobs` | Lista o histórico recente de Jobs | **Sim** |
| `GET` | `/api/sync/:cnpj` | Consulta status do NSU salvo para um CNPJ | **Sim** |
| `GET` | `/api/notas` | Lista notas fiscais de um CNPJ com eventos e XMLs | **Sim** |
| `GET` | `/api/notas/:chaveAcesso` | Detalhes de uma nota fiscal específica | **Sim** |
| `GET` | `/api/notas/:chaveAcesso/xml` | Download do arquivo XML da NFS-e | **Sim** |
| `GET` | `/api/notas/:chaveAcesso/zip` | Download do pacote ZIP da nota com eventos | **Sim** |
| `GET` | `/api/notas/cnpj/:cnpj/zip` | Download do pacote ZIP completo do CNPJ | **Sim** |
| `GET` | `/api/notas/documento/:id/xml`| Download de um XML individual por ID | **Sim** |

---

## 📥 1. Sincronização de Documentos (ADN)

### `POST /api/sync`
Inicia a busca incremental de documentos fiscais no ADN a partir do último NSU salvo para o CNPJ.

- **Comportamento Padrão**: **Assíncrono com Mutex Lock**. A API enfileira a tarefa, retorna `202 Accepted` com o ID do Job imediatamente e executa em segundo plano.
- **Mutex Lock**: Se já houver uma sincronização ativa para o mesmo CNPJ, a API retorna `409 Conflict`.
- **Modo Síncrono**: Caso prefira esperar a conclusão em scripts, envie `"async": false` no corpo ou `POST /api/sync?sync=true`.

#### Request Body (JSON)
```json
{
  "cnpj": "12345678000195",
  "nsuInicial": 0,
  "maxLoops": 10,
  "async": true
}
```

#### Exemplo cURL:
```bash
curl -X POST http://localhost:3000/api/sync \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer seu_token_aqui" \
  -d '{"cnpj": "12345678000195"}'
```

#### Resposta de Sucesso (`202 Accepted`):
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

#### Resposta de Conflito (`409 Conflict` - Lock Ativo):
```json
{
  "success": false,
  "message": "Já existe uma sincronização em andamento para este CNPJ.",
  "data": {
    "id": 1,
    "cnpj": "12345678000195",
    "status": "PROCESSING"
  }
}
```

---

### `GET /api/sync/jobs/:id`
Consulta o status, métricas e conclusão de um Job de Sincronização.

#### Exemplo cURL:
```bash
curl -H "Authorization: Bearer seu_token_aqui" http://localhost:3000/api/sync/jobs/1
```

#### Resposta (`200 OK`):
```json
{
  "success": true,
  "data": {
    "id": 1,
    "cnpj": "12345678000195",
    "status": "COMPLETED",
    "nsu_inicial": 0,
    "nsu_final": 10,
    "novos_documentos": 10,
    "total_notas": 9,
    "total_eventos": 1,
    "ciclos_executados": 10,
    "erro": null,
    "created_at": "2026-09-29T13:00:00.000Z",
    "started_at": "2026-09-29T13:00:01.000Z",
    "finished_at": "2026-09-29T13:00:06.000Z"
  }
}
```

---

### `GET /api/sync/:cnpj`
Retorna o último NSU consultado e gravado para um CNPJ específico.

#### Exemplo cURL:
```bash
curl -H "Authorization: Bearer seu_token_aqui" http://localhost:3000/api/sync/12345678000195
```

---

## 📑 2. Consulta de Notas Fiscais e Eventos

### `GET /api/notas` (`findAllByCnpj`)
Retorna todas as notas fiscais vinculadas a um CNPJ (como prestador ou tomador), agregando seus eventos (cancelamentos, confirmações) e links dos XMLs.

#### Parâmetros de Query:
| Parâmetro | Tipo | Obrigatório? | Padrão | Descrição |
| :--- | :--- | :---: | :--- | :--- |
| `cnpj` | String | **Sim** | - | CNPJ a ser consultado (14 dígitos) |
| `papel` | String | Não | `todos` | `todos`, `prestador` ou `tomador` |
| `status` | String | Não | - | `AUTORIZADA`, `CANCELADA`, `SUBSTITUIDA` |
| `limit` | Number | Não | `100` | Quantidade máxima por página |
| `offset` | Number | Não | `0` | Deslocamento da paginação |

#### Exemplo cURL:
```bash
curl -H "Authorization: Bearer seu_token_aqui" \
  "http://localhost:3000/api/notas?cnpj=12345678000195&papel=prestador&limit=50"
```

#### Resposta (`200 OK`):
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
      "cpf_tomador": null,
      "razao_social_prestador": "EMPRESA PRESTADORA LTDA",
      "razao_social_tomador": "TOMADOR DOS SERVICOS S.A.",
      "numero_nfse": "100",
      "serie": "1",
      "data_emissao": "2026-09-29T12:00:00Z",
      "competencia": "2026-09-29",
      "valor_servicos": 1500.0,
      "valor_liquido": 1450.0,
      "descricao_servico": "Desenvolvimento de software",
      "status": "AUTORIZADA",
      "eventos": [
        {
          "id": 1,
          "tipo_evento": "CONFIRMACAO_TOMADOR",
          "descricao_evento": "Confirmação da Prestação do Serviço pelo Tomador",
          "data_hora_evento": "2026-09-29T12:30:00Z"
        }
      ],
      "documentos": [
        {
          "id": 1,
          "tipo_documento": "NFSE",
          "data_hora_geracao": "2026-09-29T12:00:00Z"
        },
        {
          "id": 2,
          "tipo_documento": "EVENTO",
          "tipo_evento": "CONFIRMACAO_TOMADOR"
        }
      ]
    }
  ]
}
```

---

### `GET /api/notas/:chaveAcesso`
Retorna os dados completos de uma nota específica pela sua chave de acesso de 50 dígitos.

---

## 💾 3. Downloads de XMLs e Pacotes ZIP

### `GET /api/notas/:chaveAcesso/xml`
Faz o download direto do XML original da NFS-e.
- **Cabeçalhos de Resposta**:
  - `Content-Type: application/xml; charset=utf-8`
  - `Content-Disposition: attachment; filename="NFSe_<CHAVE>.xml"`

#### Exemplo cURL:
```bash
curl -H "Authorization: Bearer seu_token_aqui" \
  -OJ http://localhost:3000/api/notas/43260912345678000195550010000000011234567890/xml
```

---

### `GET /api/notas/:chaveAcesso/zip`
Gera e baixa um arquivo `.zip` contendo o XML da NFS-e e todos os XMLs de eventos vinculados (cancelamentos, confirmações).
- **Conteúdo do ZIP**:
  - `NFSe_<CHAVE>.xml`
  - `Evento_CANCELAMENTO_NSU12_<CHAVE>.xml`

---

### `GET /api/notas/cnpj/:cnpj/zip`
Gera e baixa um arquivo `.zip` completo com todos os XMLs de notas e eventos emitidos ou tomados por um CNPJ.
- **Estrutura interna do ZIP**:
  ```text
  Pacote_XMLs_<CNPJ>.zip
  ├── Notas/
  │   ├── NFSe_chave1.xml
  │   └── NFSe_chave2.xml
  └── Eventos/
      └── Evento_CONFIRMACAO_TOMADOR_chave1.xml
  ```

---

### `GET /api/notas/documento/:id/xml`
Baixa um XML específico informando o ID do registro na tabela `documentos_xml`.

---

## 🛡️ 4. Códigos de Status HTTP

| Código | Significado | Descrição |
| :---: | :--- | :--- |
| `200` | OK | Requisição executada com sucesso |
| `202` | Accepted | Tarefa aceita e enfileirada para execução assíncrona |
| `400` | Bad Request | Parâmetros inválidos (ex: CNPJ incompleto) |
| `401` | Unauthorized | Token de autenticação ausente ou inválido |
| `404` | Not Found | Nota, documento ou job não encontrado |
| `409` | Conflict | Mutex Lock: Já existe sincronização ativa para o CNPJ |
| `429` | Too Many Requests | Limite de requisições por minuto excedido |
| `500` | Internal Server Error | Erro inesperado do servidor |
