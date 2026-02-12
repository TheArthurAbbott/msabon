# MS SQL API built on NodeJS (MsABON)

MsABON automatically discovers MS SQL tables, views, stored procedures, and scalar-valued functions matching configured filters and exposes REST endpoints for them. It also generates OpenAPI (Swagger) documentation for quick testing.

## Setup

MsABON is built on NodeJS, which can be installed in a variety of ways: installed from exe installer (admin required), unzipped and paths mapped or locally executed (no admin), or with a tool like scoop or chocolatey (no admin, usually). This was originally built and tested on both mapped and locally executed installations of v22.21.1 LTS NodeJS. Here is the download link:

https://nodejs.org/en/download

Once NodeJS is installed, proceed with the setup.

1. Install dependencies:

```bash
npm install
```

2. Copy and rename `config.yaml.example` to `config.yaml`

3. Edit `config.yaml` (project root) to describe one or more connections and app settings. Example:

```yaml
http: http
host: 127.0.0.1
port: 3000
swaggerPath: /swagger
logLevel: verbose

connections:
  - endpoint: __ENPT1__
    server: __SRVR1__
    port: 1433
    username: __USER1__
    password: __PASS1__
    database: __DTBS1__
    advanced: false
    include:
      tables:
        - "__REGX1__"
        - "__TABL1__"
      views:
        - "__REGX2__"
        - "__TABL2__"
      procedures:
        - "__REGX3__"
        - "__TABL3__"
      functions:
        - "__REGX4__"
        - "__TABL4__"
  - endpoint: __ENPT2__
    server: __SRVR2__
    port: 1433
    username: __USER2__
    password: __PASS2__
    database: __DTBS2__
    advanced: false
    include:
      tables:
        - "__REGX5__"
        - "__TABL5__"
      views:
        - "__REGX6__"
        - "__TABL6__"
      procedures:
        - "__REGX7__"
        - "__TABL7__"
      functions:
        - "__REGX8__"
        - "__TABL8__"
```

Notes about the config fields
- `http`: default server http or https protocol (can be overridden with `HTTP` env var).
- `host`: default server hostname / IP address (can be overridden with `HOST` env var).
- `port`: default server port (can be overridden with `PORT` env var).
- `swaggerPath`: where Swagger UI is served (default `/api-docs` if not set).
- `logLevel`: currently respected informally; logger prints `info` & `verbose` messages.
- `connections`: list of connection entries. Each entry:
  - `endpoint`: logical name used in the HTTP path and OpenAPI component names.
  - `server`, `port`, `username`, `password`, `database`: DB connection info.
  - `advanced`: when `true`, enables the "Advanced" endpoint at `/{endpoint}/a` for base64-encoded SQL templates (read-only).
  - `include`: per-type lists of patterns or names that are OR-combined. Patterns support:
    - `^prefix` for anchored prefix matches,
    - SQL LIKE wildcards (`%` and `_`),
    - Plain names for exact matches.

4. Start server:

```powershell
npm start
```

## Behavior & routing

- The server tries to connect to each entry in `connections`. For each successful connection it:
  - discovers tables and views matching `include` types (SQL LIKE semantics),
  - introspects columns and primary keys, and
  - registers routes under:
    - `/{endpoint}/t/{table}` for tables
    - `/{endpoint}/v/{view}` for views
    - `/{endpoint}/p/{procedure}` for stored procedures
    - `/{endpoint}/f/{function}` for functions
- Functions and Procedures are execute-only (POST only).
- Views are read-only (GET only).
- Tables support CRUD when a primary key is present:
  - `GET /{endpoint}/t/{table}` list (with filters and sorting/pagination)
  - `GET /{endpoint}/t/{table}/{id}` get by PK
  - `POST /{endpoint}/t/{table}` create
  - `PUT /{endpoint}/t/{table}/{id}` update by PK
  - `DELETE /{endpoint}/t/{table}/{id}` delete by PK
- Advanced: `POST /{endpoint}/a` executes a base64-encoded, read-only SQL template with simple `{{ var }}` substitutions.

Examples
- List rows: `GET /{endpoint}/t/pgm_Products`
- Get by id: `GET /{endpoint}/t/pgm_Products/{id}`
- Execute procedure: `POST /{endpoint}/p/usp_pgm_GetProductSpecs` with body `{"prodId": 12}`
- Execute scalar function: `POST /{endpoint}/f/fn_chkProductCategory` with body `{"prodModel": "ABC123", "catId": 7}`
- Execute advanced: `POST /{endpoint}/a` with body `{"date":"03-28-2025","prodId":"2","data":"U0VMRUN.."}` (truncated for clarity)

### Health and discovery endpoints

- `GET /` --> JSON `{"ok": true}` health check.
- `GET /{endpoint}/` --> lists discovered objects for the endpoint, grouped by type.
- `GET /{endpoint}/{type}` --> lists discovered objects for the endpoint of that type.

Example discovery payload:

```json
{
  "endpoint": "api",
  "tables": ["pgm_Access","pgm_Products"],
  "views": ["LatestWidgetsView"],
  "procedures": ["usp_pgm_GetProductSpecs","usp_pgm_SearchProductSpecs"],
  "functions": ["fn_chkProductCategory","fn_chkProductState"]
}
```

Note: The advanced endpoint `/{endpoint}/a` is not a discovery endpoint and will return a 404 error: `Cannot GET /{endpoint}/a`.

## List endpoint query parameters

The list endpoints (`GET /{endpoint}/t/{table}` and `GET /{endpoint}/v/{view}`) support Supabase/PostgREST-style query parameters:

- `order`: Sort order in the format `column.asc` or `column.desc`. Default is ascending (ASC).
  - Example: `?order=id.desc`
- `limit`: Number of rows to return. `-1` returns all (default).
  - Example: `?limit=50`
- `offset`: Number of rows to skip before starting the result set. Default `0`.
  - Example: `?offset=100`

You can also filter by any column via query string:
- `GET /mis/t/pgm_Products?Name=Widget&Status=Active`

Putting it together:
- `GET /mis/t/pgm_Products?order=id.desc&limit=25&offset=50`
- `GET /mis/t/pgm_Products?CreatedAt.asc` (default ASC if direction omitted)

## Swagger & OpenAPI

- Swagger UI is available at `http://localhost:<port>/<swaggerPath>` (default `/api-docs` if not set).
- OpenAPI JSON served at `http://localhost:<port>/swagger.json`.
- The UI loads the spec from `/swagger.json`, and groups endpoints under tags by type:
  - `Advanced` (read-only)
  - `Functions` (execute-only)
  - `Procedures` (execute-only)
  - `Views` (read-only)
  - `Tables` (CRUD where applicable)

The server prints a clickable link to Swagger UI on startup.

## Logging & safety

- The console logger is verbose by default; you will see timestamped `INFO`, `WARN`, `ERROR`, and `VERBOSE` messages about discovery and executed SQL (parameters are shown; passwords are not printed).
- Database passwords are not printed.
- Advanced endpoint is default off and filters out common dangerous tokens (e.g., INSERT, UPDATE, DELETE, CREATE, DROP, MERGE, EXEC, USE, BEGIN TRAN/COMMIT/ROLLBACK).

## Magic numbers / hard-coded defaults

- Default port: `3000` (in `config.yaml` or `PORT` env var).
- Default SQL port: `1433` when `port` is not provided in a connection entry.
- List defaults: `order` -> ASC on PK or first column, `limit` -> `-1`, `offset` -> `0`.

## Further Notes

- To change the config file name/location, before starting (`npm start`), set `CONFIG_PATH` env var  (`$env:CONFIG_PATH = 'config.yaml'`).
- To run multiple APIs from different servers/databases, add multiple entries to `connections`; each `endpoint` yields its own namespaced routes and OpenAPI components.
- If a connection fails (e.g., DNS down), the server retries every 30 seconds without stopping. When the connection succeeds, routes and the Swagger spec are updated automatically.

### Advanced Endpoint Details

- Path: `POST /{endpoint}/a`
- Body shape:
  - data (required): base64-encoded SQL template string
  - Any additional keys are treated as template variables (e.g., `{{ date }}`, `{{ lineId }}`)
  - Optional rowLimit (integer, default 1000) to cap rows
- Templating:
  - `{{ var }}` placeholders are replaced from the JSON body.
  - Numbers are inserted as-is; strings have single quotes escaped.
- Read-only guard:
  - DML/DDL/EXEC and other dangerous tokens are blocked (e.g., INSERT, UPDATE, DELETE, CREATE, DROP, MERGE, EXEC, USE, BEGIN TRAN/COMMIT/ROLLBACK).
- Response: JSON array of rows (recordset).

Example:

```sql
SELECT 
    SUM(widgets) AS totalWidgets
FROM 
    [Database].[dbo].[LatestWidgetsView]
WHERE 
    [var_1] = '{{ example_var_1 }}' and [var_2] =  {{ example_var_2 }}
```

Base64 for the SQL goes in data; variables live alongside it:

```json
{
  "exampe_var_1": "example_value_1",
  "exampe_var_2": "example_value_2",
  "data": "U0VMRUNUIA0KICAgIFNVTSh3aWRnZXRzKSBBUyB0b3RhbFdpZGdldHMNCkZST00gDQogICAgW0RhdGFiYXNlXS5bZGJvXS5bTGF0ZXN0V2lkZ2V0c1ZpZXddDQpXSEVSRSANCiAgICBbdmFyXzFdID0gJ3t7IGV4YW1wbGVfdmFyXzEgfX0nIGFuZCBbdmFyXzJdID0gIHt7IGV4YW1wbGVfdmFyXzIgfX0=",
  "rowLimit":2
}
```

---

## Disclaimer

This project was generated with AI, so it is not copyrightable in certain jurisdictions. Use at your own risk.
