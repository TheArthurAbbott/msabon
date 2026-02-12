const express = require('express');
const cors = require('cors');
const fs = require('fs');
const yaml = require('js-yaml');
const sql = require('mssql');
const { setupDynamicRoutes } = require('./generator');
const swaggerUi = require('swagger-ui-express');
const logger = require('./logger');
let openApi = null;

process.on('unhandledRejection', (e) => logger.error('UnhandledRejection:', e.stack || e));
process.on('uncaughtException', (e) => logger.error('UncaughtException:', e.stack || e));

async function connectAndSetupWithRetry(app, components, c, attempt = 0) {
  const endpoint = c.endpoint || 'api';
  const poolConfig = {
    user: c.username,
    password: c.password,
    server: c.server,
    port: c.port || 1433,
    database: c.database,
    options: { encrypt: false, enableArithAbort: true }
  };
  const doAttempt = async () => {
    try {
      const pool = await new sql.ConnectionPool(poolConfig).connect();
      logger.info(`Connected to ${endpoint}`);
      const schemas = await setupDynamicRoutes(app, pool, c);
      components.schemas = { ...components.schemas, ...schemas };
      if (process.env.DEBUG_SWAGGER) {
        console.log(`[RETRY] endpoint='${endpoint}' routes registered on attempt ${attempt + 1}`);
      }
    } catch (err) {
      logger.error(`Connection failed for endpoint '${endpoint}':`, err.stack || err.message);
      const delayMs = 30000;
      logger.warn(`[RETRY] endpoint='${endpoint}' in ${Math.round(delayMs/1000)}s (attempt ${attempt + 1})`);
      setTimeout(() => connectAndSetupWithRetry(app, components, c, attempt + 1), delayMs);
    }
  };
  await doAttempt();
}

async function start() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // health check
  app.get('/', (req, res) => res.json({ ok: true }));

  // request logging middleware
  app.use((req, res, next) => {
    logger.info(`${req.method} ${req.originalUrl}`);
    if (req.method !== 'GET' && req.body && Object.keys(req.body).length) {
      logger.verbose('  body=', req.body);
    }
    next();
  });

  // load config
  const cfgPath = process.env.CONFIG_PATH || 'config.yaml';
  let cfg;
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    cfg = yaml.load(raw);
    logger.info('Loaded config', cfgPath);
  } catch (err) {
    logger.error('Failed to load config.yaml:', err.message);
    process.exit(1);
  }

  const port = process.env.PORT || cfg.port || 3000;
  const host = process.env.HOST || cfg.host || '127.0.0.1';
  const http = process.env.HTTP || cfg.http || 'http';

  // collect all schemas across endpoints
  const components = { schemas: {} };

  // Build a mutable OpenAPI object once, then refresh paths when routes register
  let openApi = {
    openapi: '3.0.0',
    info: { title: "MS SQL API built on NodeJS (MsABON)", version: '0.2.0' },
    servers: [{ url: `${http}://${host}:${port}` }],
    components,
    paths: {},
    tags: [
      { name: 'Views', description: 'Read-only SQL views' },
      { name: 'Tables', description: 'Tables (CRUD where applicable)' },
      { name: 'Procedures', description: 'Stored procedures (execute)' },
      { name: 'Functions', description: 'Scalar/table-valued functions (execute)' },
      {
        name: 'Advanced',
        description: 'Encoded base64 SQL templates. (**Requirement:** `advanced: true` must be set in `config.yaml` for these to appear.)'
      }
    ]
  };

  // Helper: rebuild paths from components.schemas
  function buildPathsFromComponents() {
    openApi.paths = {};
    for (const name of Object.keys(openApi.components.schemas)) {
      const sch = openApi.components.schemas[name] || {};

      const parts = name.split('_');
      const endpoint = parts[0];
      const entity = parts.slice(1).join('_');

      const kind = sch['x-msabon-kind'] || (sch['x-msabon-isView'] ? 'v' : 't');
      const base = `/${endpoint}/${kind}/${entity}`;

      // Procedures: POST only (no GET)
      if (kind === 'p') {
        openApi.paths[base] = {
          post: {
            tags: ['Procedures'],
            summary: `Execute ${entity}`,
            requestBody: {
              content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } }
            },
            responses: { '200': { description: 'OK' } }
          }
        };
        continue;
      }

      // Functions: POST only (no GET)
      if (kind === 'f') {
        const isScalar = sch['x-msabon-fType'] === 'FN';
        openApi.paths[base] = {
          post: {
            tags: ['Functions'],
            summary: `Execute ${entity}`,
            requestBody: {
              content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } }
            },
            responses: { '200': { description: isScalar ? 'OK (scalar)' : 'OK (rows)' } }
          }
        };
        continue;
      }

      // Views: GET list only
      if (kind === 'v') {
        openApi.paths[base] = {
          get: {
            tags: ['Views'],
            summary: `List ${entity}`,
            parameters: [
              { in: 'query', name: 'order', schema: { type: 'string', example: 'id.asc' } },
              { in: 'query', name: 'limit', schema: { type: 'integer', default: -1 } },
              { in: 'query', name: 'offset', schema: { type: 'integer', default: 0 } }
            ],
            responses: { '200': { description: 'OK' } }
          }
        };
        continue;
      }

      // Tables: GET list + CRUD when PK exists
      const hasPk = sch['x-msabon-hasPk'] === true;
      openApi.paths[base] = {
        get: {
          tags: ['Tables'],
          summary: `List ${entity}`,
          parameters: [
            { in: 'query', name: 'order', schema: { type: 'string', example: 'id.asc' } },
            { in: 'query', name: 'limit', schema: { type: 'integer', default: -1 } },
            { in: 'query', name: 'offset', schema: { type: 'integer', default: 0 } }
          ],
          responses: { '200': { description: 'OK' } }
        }
      };
      if (hasPk) {
        openApi.paths[base].post = {
          tags: ['Tables'],
          summary: `Create ${entity}`,
          requestBody: {
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } }
          },
          responses: { '201': { description: 'Created' } }
        };
        const idPath = `${base}/{id}`;
        openApi.paths[idPath] = {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          get: {
            tags: ['Tables'],
            summary: `Get ${entity} by id`,
            responses: { '200': { description: 'OK' }, '404': { description: 'Not Found' } }
          },
          put: {
            tags: ['Tables'],
            summary: `Update ${entity}`,
            requestBody: {
              content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } }
            },
            responses: { '200': { description: 'Updated' } }
          },
          delete: {
            tags: ['Tables'],
            summary: `Delete ${entity}`,
            responses: { '200': { description: 'Deleted' }, '404': { description: 'Not Found' } }
          }
        };
      }
      // Build advanced endpoint
      if (kind === 'a') {
        const base = `/${endpoint}/a`;
        openApi.paths[base] = {
          post: {
            tags: ['Advanced'],
            summary: 'Execute advanced (read-only) payload',
            requestBody: {
              content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } }
            },
            responses: { '200': { description: 'OK' } }
          }
        };
        continue;
      }
    }
  }

  // setup each connection (non-blocking; routes will register on success or retry)
  for (const c of cfg.connections || []) {
    const endpoint = c.endpoint || 'api';
    logger.info(`Connecting to ${c.server}:${(c.port || 1433)}/${c.database} as ${c.username} (endpoint='${endpoint}')`);
    // Wrap the original retry function to rebuild spec after merge
    connectAndSetupWithRetry(app, components, c).then(() => {
      // The retry function merges schemas on success; rebuild paths now
      buildPathsFromComponents();
    }).catch(() => {
      // Error already logged in connectAndSetupWithRetry; do nothing here
    });
  }

  // serve swagger: load spec from URL so UI reflects updates in /swagger.json
  app.use(cfg.swaggerPath || '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(undefined, {
      swaggerOptions: {
        urls: [{ url: '/swagger.json', name: 'MsABON' }],
        tagsSorter: 'alpha',
        operationsSorter: 'alpha'
      }
    })
  );

  // List tables under an endpoint: e.g., HTTP://HOST:PORT/ENDPOINT/KIND/
  app.get('/:endpoint([A-Za-z0-9_-]+)/', (req, res) => {
    const endpoint = req.params.endpoint;
    const schemas = openApi.components?.schemas || {};
    const names = Object.keys(schemas).filter(name => name.startsWith(`${endpoint}_`));

    const tables = [], views = [], procedures = [], functions = [];
    for (const name of names) {
      const sch = schemas[name] || {};
      const parts = name.split('_');
      const entity = parts.slice(1).join('_');
      const kind = sch['x-msabon-kind'] || (sch['x-msabon-isView'] ? 'v' : 't');
      if (kind === 't') tables.push(entity);
      else if (kind === 'v') views.push(entity);
      else if (kind === 'p') procedures.push(entity);
      else if (kind === 'f') functions.push(entity);
    }
    tables.sort(); views.sort(); procedures.sort(); functions.sort();
    if (tables.length === 0 && views.length === 0 && procedures.length === 0 && functions.length === 0) {
      return res.status(404).json({ error: `No objects found for endpoint '${endpoint}'.` });
    }
    res.json({ endpoint, tables, views, procedures, functions });
  });

  function listByKind(endpoint, kind) {
    const schemas = openApi.components?.schemas || {};
    const names = Object.keys(schemas).filter(n => n.startsWith(`${endpoint}_`));
    const out = [];
    for (const name of names) {
      const sch = schemas[name] || {};
      const k = sch['x-msabon-kind'] || (sch['x-msabon-isView'] ? 'v' : 't');
      if (k !== kind) continue;
      out.push(name.split('_').slice(1).join('_'));
    }
    out.sort();
    return out;
  }

  app.get('/:endpoint([A-Za-z0-9_-]+)/t', (req, res) => res.json(listByKind(req.params.endpoint, 't')));
  app.get('/:endpoint([A-Za-z0-9_-]+)/v', (req, res) => res.json(listByKind(req.params.endpoint, 'v')));
  app.get('/:endpoint([A-Za-z0-9_-]+)/p', (req, res) => res.json(listByKind(req.params.endpoint, 'p')));
  app.get('/:endpoint([A-Za-z0-9_-]+)/f', (req, res) => res.json(listByKind(req.params.endpoint, 'f')));

  // JSON endpoint serving the current spec
  app.get('/swagger.json', (req, res) => res.json(openApi));

  // initial build (empty until a connection succeeds)
  buildPathsFromComponents();

  app.listen(port, () => {
    logger.info(`Server listening on ${http}://${host}:${port}`);
    logger.info(`If you would like to use the swagger to test your endpoints, go to ${http}://${host}:${port}${cfg.swaggerPath || '/api-docs'}`);
  });
}

start().catch(err => {
  logger.error(err);
  process.exit(1);
});

