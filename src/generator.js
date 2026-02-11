const sql = require('mssql');
const logger = require('./logger');
const crypto = require('crypto');

function bindNameMatchers(request, patterns, colExpr, tag) {
  const clauses = [];
  patterns.forEach((pat, i) => {
    const key = `${tag}${i}`;
    if (pat.startsWith('^')) {
      request.input(key, sql.NVarChar, pat.slice(1) + '%');
      clauses.push(`${colExpr} LIKE @${key}`);
    } else if (pat.includes('%') || pat.includes('_')) {
      request.input(key, sql.NVarChar, pat);
      clauses.push(`${colExpr} LIKE @${key}`);
    } else {
      request.input(key, sql.NVarChar, pat);
      clauses.push(`${colExpr} = @${key}`);
    }
  });
  return clauses;
}

// Simple {{ var }} substitution with basic sanitization
function substituteTemplate(template, vars) {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (m, key) => {
    if (!(key in vars)) throw new Error(`Missing variable '${key}'`);
    const v = vars[key];
    if (v === null || v === undefined) return 'NULL';
    // If value contains single quotes, escape them; leave numeric/plain as-is
    if (typeof v === 'number') return String(v);
    if (/^\d+(\.\d+)?$/.test(String(v))) return String(v);
    return String(v).replace(/'/g, "''");
  });
}

// Read-only guard: block obvious DML/DDL/exec
function isReadOnly(sqlText) {
  const s = sqlText.toUpperCase();
  const banned = [
    'INSERT ', 'UPDATE ', 'DELETE ', 'MERGE ', 'ALTER ', 'DROP ', 'CREATE ',
    'TRUNCATE ', 'EXEC ', 'EXECUTE ', 'GRANT ', 'REVOKE ', 'USE ',
    'BEGIN TRAN', 'COMMIT', 'ROLLBACK', 'XP_', 'SP_CONFIGURE'
  ];
  return !banned.some(tok => s.includes(tok));
}

function registerAdvancedRoute(app, pool, endpoint) {
  const base = `/${endpoint}/a`;
  logger.verbose('Registering routes for', endpoint, 'advanced', 'under', base);

  app.post(base, async (req, res) => {
    try {
      const b64 = req.body?.data;
      if (!b64 || typeof b64 !== 'string') {
        return res.status(400).json({ error: "Field 'data' (base64) is required" });
      }

      const template = Buffer.from(b64, 'base64').toString('utf8');
      const sqlText = substituteTemplate(template, req.body); // body keys become {{var}} substitutions

      if (!isReadOnly(sqlText)) {
        return res.status(400).json({ error: 'Only read-only queries are permitted in advanced mode' });
      }

      const rowLimit = Number.isFinite(parseInt(req.body?.rowLimit, 10))
        ? parseInt(req.body.rowLimit, 10)
        : 1000;

      const hash = crypto.createHash('sha256').update(template).digest('hex').slice(0, 16);
      logger.verbose(`[ADV] hash=${hash} rowLimit=${rowLimit} preview='${sqlText.slice(0, 160)}...'`);

      const request = pool.request();
      const finalSql = `SET ROWCOUNT ${rowLimit};\n${sqlText}`;
      const r = await request.query(finalSql);
      res.json(r.recordset ?? []);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

async function hasEnabledTriggers(pool, schema, table) {
  const res = await pool.request()
    .input('schema', sql.NVarChar, schema)
    .input('table', sql.NVarChar, table)
    .query(`
      SELECT COUNT(*) AS cnt
      FROM sys.triggers tr
      JOIN sys.tables t ON tr.parent_id = t.object_id
      WHERE tr.is_disabled = 0
        AND t.name = @table
        AND SCHEMA_NAME(t.schema_id) = @schema
    `);
  return (res.recordset[0]?.cnt || 0) > 0;
}

async function getIdentityColumn(pool, schema, table) {
  const res = await pool.request()
    .input('schema', sql.NVarChar, schema)
    .input('table', sql.NVarChar, table)
    .query(`
      SELECT c.name AS COLUMN_NAME
      FROM sys.identity_columns ic
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      JOIN sys.tables t ON t.object_id = ic.object_id
      WHERE t.name = @table AND SCHEMA_NAME(t.schema_id) = @schema
    `);
  return res.recordset[0]?.COLUMN_NAME || null;
}

function mapSqlTypeToMssqlType(col) {
  const t = col.DATA_TYPE.toLowerCase();
  if (t.includes('char') || t === 'text' || t === 'ntext') {
    return col.CHARACTER_MAXIMUM_LENGTH && col.CHARACTER_MAXIMUM_LENGTH > 0
      ? sql.NVarChar(col.CHARACTER_MAXIMUM_LENGTH)
      : sql.NVarChar(sql.MAX);
  }
  if (t.includes('int')) return sql.Int;
  if (t === 'bigint') return sql.BigInt;
  if (t === 'bit') return sql.Bit;
  if (t.includes('decimal') || t === 'numeric') return sql.Decimal(18, 4);
  if (t.includes('float') || t === 'real') return sql.Float;
  if (t.includes('date') || t.includes('time')) return sql.DateTime;
  if (t === 'uniqueidentifier') return sql.NVarChar(50);
  return sql.NVarChar(sql.MAX);
}

function dedupeByKey(arr, keyFn) {
  const seen = new Set(); const out = [];
  for (const x of arr) { const k = keyFn(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}

function toOpenApiType(col) {
  const t = col.DATA_TYPE.toLowerCase();
  if (t.includes('int')) return { type: 'integer' };
  if (t === 'bigint') return { type: 'integer', format: 'int64' };
  if (t === 'bit') return { type: 'boolean' };
  if (t.includes('float') || t === 'real' || t.includes('decimal') || t === 'numeric') return { type: 'number' };
  if (t.includes('date') || t.includes('time')) return { type: 'string', format: 'date-time' };
  return { type: 'string' };
}

function mapTypeNameToMssql(typeName, maxLength, precision, scale) {
  const t = String(typeName || '').toLowerCase();
  if (t.includes('char') || t === 'text' || t === 'ntext') {
    const len = (maxLength && maxLength > 0) ? maxLength : sql.MAX;
    return sql.NVarChar(len);
  }
  if (t.includes('int') && t !== 'bigint') return sql.Int;
  if (t === 'bigint') return sql.BigInt;
  if (t === 'bit') return sql.Bit;
  if (t.includes('decimal') || t === 'numeric') return sql.Decimal(precision || 18, scale || 4);
  if (t.includes('float') || t === 'real') return sql.Float;
  if (t.includes('date') || t.includes('time')) return sql.DateTime;
  if (t === 'uniqueidentifier') return sql.NVarChar(50);
  return sql.NVarChar(sql.MAX);
}

function toOpenApiTypeFromSqlName(typeName) {
  const t = String(typeName || '').toLowerCase();
  if (t.includes('int')) return { type: 'integer' };
  if (t === 'bigint') return { type: 'integer', format: 'int64' };
  if (t === 'bit') return { type: 'boolean' };
  if (t.includes('float') || t === 'real' || t.includes('decimal') || t === 'numeric') return { type: 'number' };
  if (t.includes('date') || t.includes('time')) return { type: 'string', format: 'date-time' };
  if (t === 'uniqueidentifier') return { type: 'string', format: 'uuid' };
  return { type: 'string' };
}

async function discoverObjects(pool, filterSqlLike) {
  const q = `
    SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME LIKE @filter
      AND TABLE_TYPE IN ('BASE TABLE','VIEW')`;
  const request = pool.request();
  request.input('filter', sql.NVarChar, filterSqlLike);
  const res = await request.query(q);
  return res.recordset; // each has schema, name, and type
}

async function discoverFunctions(pool, like1, like2) {
  const request = pool.request();
  request.input('p1', sql.NVarChar, like1);
  if (like2) request.input('p2', sql.NVarChar, like2);
  const q = `
    SELECT s.name AS SCHEMA_NAME, o.name AS FUNC_NAME, o.type AS FUNC_TYPE
    FROM sys.objects o
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE o.type IN ('FN','TF','IF') AND (o.name LIKE @p1 ${like2 ? 'OR o.name LIKE @p2' : ''})
  `;
  const res = await request.query(q);
  return res.recordset.map(r => ({ schema: r.SCHEMA_NAME, func: r.FUNC_NAME, type: r.FUNC_TYPE }));
}

async function discoverProcedures(pool, like1, like2) {
  const request = pool.request();
  request.input('p1', sql.NVarChar, like1);
  if (like2) request.input('p2', sql.NVarChar, like2);
  const q = `
    SELECT s.name AS SCHEMA_NAME, p.name AS PROC_NAME
    FROM sys.procedures p
    JOIN sys.schemas s ON s.schema_id = p.schema_id
    WHERE p.name LIKE @p1 ${like2 ? 'OR p.name LIKE @p2' : ''}
  `;
  const res = await request.query(q);
  return res.recordset.map(r => ({ schema: r.SCHEMA_NAME, proc: r.PROC_NAME }));
}

async function discoverTablesByInclude(pool, patterns) {
  if (!patterns || patterns.length === 0) return [];
  const request = pool.request();
  request.input('type', sql.NVarChar, 'BASE TABLE');
  const clauses = bindNameMatchers(request, patterns, 'TABLE_NAME', 'tbl');
  const q = `
    SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = @type AND (${clauses.join(' OR ')})
  `;
  const res = await request.query(q);
  return res.recordset;
}

async function discoverViewsByInclude(pool, patterns) {
  if (!patterns || patterns.length === 0) return [];
  const request = pool.request();
  request.input('type', sql.NVarChar, 'VIEW');
  const clauses = bindNameMatchers(request, patterns, 'TABLE_NAME', 'view');
  const q = `
    SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = @type AND (${clauses.join(' OR ')})
  `;
  const res = await request.query(q);
  return res.recordset;
}

async function discoverProceduresByInclude(pool, patterns) {
  if (!patterns || patterns.length === 0) return [];
  const request = pool.request();
  const clauses = bindNameMatchers(request, patterns, 'p.name', 'proc');
  const q = `
    SELECT s.name AS SCHEMA_NAME, p.name AS PROC_NAME
    FROM sys.procedures p
    JOIN sys.schemas s ON s.schema_id = p.schema_id
    WHERE ${clauses.join(' OR ')}
  `;
  const res = await request.query(q);
  return res.recordset.map(r => ({ schema: r.SCHEMA_NAME, proc: r.PROC_NAME }));
}

async function discoverFunctionsByInclude(pool, patterns) {
  if (!patterns || patterns.length === 0) return [];
  const request = pool.request();
  const clauses = bindNameMatchers(request, patterns, 'o.name', 'func');
  const q = `
    SELECT s.name AS SCHEMA_NAME, o.name AS FUNC_NAME, o.type AS FUNC_TYPE
    FROM sys.objects o
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE o.type IN ('FN','TF','IF') AND (${clauses.join(' OR ')})
  `;
  const res = await request.query(q);
  return res.recordset.map(r => ({ schema: r.SCHEMA_NAME, func: r.FUNC_NAME, type: r.FUNC_TYPE }));
}

async function getColumns(pool, schema, table) {
  const res = await pool.request()
    .input('schema', sql.NVarChar, schema)
    .input('table', sql.NVarChar, table)
    .query(`SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
            ORDER BY ORDINAL_POSITION`);
  return res.recordset;
}

async function getPrimaryKey(pool, schema, table) {
  const res = await pool.request()
    .input('schema', sql.NVarChar, schema)
    .input('table', sql.NVarChar, table)
    .query(`SELECT k.COLUMN_NAME
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS t
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
              ON t.CONSTRAINT_NAME = k.CONSTRAINT_NAME
            WHERE t.TABLE_SCHEMA = @schema AND t.TABLE_NAME = @table AND t.CONSTRAINT_TYPE='PRIMARY KEY'`);
  return res.recordset.map(r => r.COLUMN_NAME);
}

async function getFunctionParams(pool, schema, func) {
  const request = pool.request();
  request.input('schema', sql.NVarChar, schema);
  request.input('func', sql.NVarChar, func);
  const q = `
    SELECT REPLACE(par.name,'@','') AS PARAM_NAME,
           t.name AS TYPE_NAME,
           par.max_length AS MAX_LENGTH,
           par.precision AS PRECISION,
           par.scale AS SCALE
    FROM sys.parameters par
    JOIN sys.types t ON par.user_type_id = t.user_type_id
    JOIN sys.objects o ON par.object_id = o.object_id
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE s.name = @schema AND o.name = @func AND par.parameter_id > 0
    ORDER BY par.parameter_id
  `;
  const res = await request.query(q);
  return res.recordset;
}

async function getFunctionReturnType(pool, schema, func) {
  const request = pool.request();
  request.input('schema', sql.NVarChar, schema);
  request.input('func', sql.NVarChar, func);
  const q = `
    SELECT t.name AS TYPE_NAME, p.max_length AS MAX_LENGTH, p.precision AS PRECISION, p.scale AS SCALE
    FROM sys.parameters p
    JOIN sys.types t ON p.user_type_id = t.user_type_id
    JOIN sys.objects o ON p.object_id = o.object_id
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE s.name = @schema AND o.name = @func AND p.parameter_id = 0
  `;
  const res = await request.query(q);
  return res.recordset[0] || null;
}

async function getProcedureParams(pool, schema, proc) {
  const request = pool.request();
  request.input('schema', sql.NVarChar, schema);
  request.input('proc', sql.NVarChar, proc);
  const q = `
    SELECT
      REPLACE(par.name, '@', '') AS PARAM_NAME,
      t.name AS TYPE_NAME,
      par.max_length AS MAX_LENGTH,
      par.precision AS PRECISION,
      par.scale AS SCALE,
      par.is_output AS IS_OUTPUT
    FROM sys.parameters par
    JOIN sys.types t ON par.user_type_id = t.user_type_id
    JOIN sys.procedures p ON par.object_id = p.object_id
    JOIN sys.schemas s ON s.schema_id = p.schema_id
    WHERE s.name = @schema AND p.name = @proc
    ORDER BY par.parameter_id
  `;
  const res = await request.query(q);
  return res.recordset;
}

function qName(schema, table) {
  return `[${schema}].[${table}]`;
}

function registerRoutes(app, tableMeta, endpoint) {
  const schema = tableMeta.schema;
  const table = tableMeta.table;
  const isView = !!tableMeta.isView;

  const kind = isView ? 'v' : 't';
  const base = `/${endpoint}/${kind}/${table}`;

  const pk = tableMeta.pk && tableMeta.pk[0];

  if (process.env.DEBUG_ROUTES) {
    logger.info(`[ROUTES] base=${base} isView=${isView} pk=${tableMeta.pk && tableMeta.pk[0] || 'none'}`);
  }
  logger.verbose('Registering routes for', endpoint, `${schema}.${table}`, 'under', base);

  // LIST with optional filters (tables & views), Supabase-style order/limit/offset
  app.get(base, async (req, res) => {
    try {
      const pool = tableMeta.pool;
      const request = pool.request();

      // 1) Column filters
      const where = [];
      for (const col of tableMeta.columns) {
        const v = req.query[col.COLUMN_NAME];
        if (v !== undefined) {
          where.push(`[${col.COLUMN_NAME}] = @${col.COLUMN_NAME}`);
          request.input(col.COLUMN_NAME, mapSqlTypeToMssqlType(col), v);
        }
      }

      // 2) Parse sort & pagination (Supabase/PostgREST)
      //    - order=col.asc | col.desc (default asc)
      //    - limit (default -1) => fetch all
      //    - offset (default 0)
      const q = req.query;

      // order format: "col.asc" or "col.desc"
      let orderCol, orderDir = 'ASC'; // default ASC
      if (q.order) {
        const parts = String(q.order).split('.');
        orderCol = parts[0];
        orderDir = (parts[1] && parts[1].toUpperCase() === 'DESC') ? 'DESC' : 'ASC';
      }

      // choose a safe default if order not provided or invalid
      const columnNames = new Set(tableMeta.columns.map(c => c.COLUMN_NAME));
      const pkColName = tableMeta.pk && tableMeta.pk[0];
      if (!orderCol || !columnNames.has(orderCol)) {
        orderCol = pkColName || tableMeta.columns[0].COLUMN_NAME;
        orderDir = 'ASC';
      }

      // limit default: -1 (all). If >=0 -> apply FETCH.
      let limit = Number.isFinite(parseInt(q.limit, 10)) ? parseInt(q.limit, 10) : -1;
      // offset default: 0
      let offset = Number.isFinite(parseInt(q.offset, 10)) ? parseInt(q.offset, 10) : 0;
      if (offset < 0) offset = 0;

      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const orderSql = `ORDER BY [${orderCol}] ${orderDir}`;

      // 3) Build SQL (SQL Server requires ORDER BY for OFFSET/FETCH)
      let sqlText;
      if (limit < 0 && offset === 0) {
        // no limit, no offset
        sqlText = `SELECT * FROM ${qName(schema, table)} ${whereSql} ${orderSql}`;
      } else if (limit < 0 && offset >= 0) {
        // offset only
        request.input('offset', sql.Int, offset);
        sqlText = `SELECT * FROM ${qName(schema, table)} ${whereSql} ${orderSql} OFFSET @offset ROWS`;
      } else {
        // limit >= 0
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, limit);
        sqlText = `SELECT * FROM ${qName(schema, table)} ${whereSql} ${orderSql} OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
      }

      if (process.env.DEBUG_LIST) {
        logger.info(`[LIST] ${base} order=${orderCol}.${orderDir.toLowerCase()} limit=${limit} offset=${offset}`);
      }

      logger.verbose('Executing SQL:', sqlText, 'params=', request.parameters);
      const result = await request.query(sqlText);
      res.json(result.recordset);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


  // For tables only (not views), enable PK and write routes when PK exists
  if (!isView && pk) {
    // GET by PK
    app.get(`${base}/:${pk}`, async (req, res) => {
      try {
        const pool = tableMeta.pool;
        const request = pool.request();
        const col = tableMeta.columns.find(c => c.COLUMN_NAME === pk) || {};
        request.input(pk, mapSqlTypeToMssqlType(col), req.params[pk]);
        const sqlText = `SELECT * FROM ${qName(schema, table)} WHERE [${pk}] = @${pk}`;
        logger.verbose('Executing SQL:', sqlText, 'params=', request.parameters);
        const result = await request.query(sqlText);
        if (result.recordset.length === 0) return res.status(404).end();
        res.json(result.recordset[0]);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // CREATE
    app.post(base, async (req, res) => {
      try {
        const pool = tableMeta.pool;
        const request = pool.request();
        const cols = [];
        const vals = [];

        for (const col of tableMeta.columns) {
          if (req.body[col.COLUMN_NAME] !== undefined) {
            cols.push(`[${col.COLUMN_NAME}]`);
            vals.push(`@${col.COLUMN_NAME}`);
            request.input(col.COLUMN_NAME, mapSqlTypeToMssqlType(col), req.body[col.COLUMN_NAME]);
          }
        }

        let sqlText;
        if (tableMeta.hasTriggers) {
          if (tableMeta.identity) {
            // Best path: insert then reselect by SCOPE_IDENTITY on the identity column
            sqlText = `
              SET NOCOUNT ON;
              INSERT INTO ${qName(schema, table)} (${cols.join(',')})
              VALUES (${vals.join(',')});
              DECLARE @id numeric(38,0) = SCOPE_IDENTITY();
              SELECT * FROM ${qName(schema, table)} WHERE [${tableMeta.identity}] = @id;
            `;
          } else if (tableMeta.pk && req.body[tableMeta.pk[0]] !== undefined) {
            // No identity but PK provided in body -> reselect by PK
            sqlText = `
              SET NOCOUNT ON;
              INSERT INTO ${qName(schema, table)} (${cols.join(',')})
              VALUES (${vals.join(',')});
              SELECT * FROM ${qName(schema, table)} WHERE [${tableMeta.pk[0]}] = @${tableMeta.pk[0]};
            `;
          } else {
            // Fallback: create #out without identity using expression on identity (if any)
            const outSelect = tableMeta.columns.map(c => {
              return c.COLUMN_NAME === tableMeta.identity
                ? `t.[${c.COLUMN_NAME}] + 0 AS [${c.COLUMN_NAME}]`
                : `t.[${c.COLUMN_NAME}]`;
            }).join(', ');
            sqlText = `
              SET NOCOUNT ON;
              IF OBJECT_ID('tempdb..#out') IS NOT NULL DROP TABLE #out;
              SELECT TOP 0 ${outSelect} INTO #out FROM ${qName(schema, table)} AS t WHERE 1 = 0;

              INSERT INTO ${qName(schema, table)} (${cols.join(',')})
              OUTPUT inserted.* INTO #out
              VALUES (${vals.join(',')});

              SELECT * FROM #out;
              DROP TABLE #out;
            `;
          }
        } else {
          sqlText = `INSERT INTO ${qName(schema, table)} (${cols.join(',')}) OUTPUT inserted.* VALUES (${vals.join(',')})`;
        }

        logger.verbose('Executing SQL:', sqlText, 'params=', request.parameters);
        const r = await request.query(sqlText);
        const out = Array.isArray(r.recordsets) && r.recordsets[r.recordsets.length - 1] || r.recordset;
        res.status(201).json(out && out[0] || {});
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // UPDATE by PK
    app.put(`${base}/:${pk}`, async (req, res) => {
      try {
        const pool = tableMeta.pool;
        const request = pool.request();
        const sets = [];

        for (const col of tableMeta.columns) {
          if (col.COLUMN_NAME === pk) continue;
          if (req.body[col.COLUMN_NAME] !== undefined) {
            sets.push(`[${col.COLUMN_NAME}] = @${col.COLUMN_NAME}`);
            request.input(col.COLUMN_NAME, mapSqlTypeToMssqlType(col), req.body[col.COLUMN_NAME]);
          }
        }

        const pkCol = tableMeta.columns.find(c => c.COLUMN_NAME === pk) || {};
        request.input(pk, mapSqlTypeToMssqlType(pkCol), req.params[pk]);

        if (sets.length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

        let sqlText;
        if (tableMeta.hasTriggers) {
          sqlText = `
            SET NOCOUNT ON;
            UPDATE ${qName(schema, table)} SET ${sets.join(', ')} WHERE [${pk}] = @${pk};
            SELECT * FROM ${qName(schema, table)} WHERE [${pk}] = @${pk};
          `;
        } else {
          // Original (no triggers)【24-1】
          sqlText = `UPDATE ${qName(schema, table)} SET ${sets.join(', ')} OUTPUT inserted.* WHERE [${pk}] = @${pk}`;
        }

        logger.verbose('Executing SQL:', sqlText, 'params=', request.parameters);
        const r = await request.query(sqlText);
        const out = Array.isArray(r.recordsets) && r.recordsets[r.recordsets.length - 1] || r.recordset;
        if (!out || out.length === 0) return res.status(404).end();
        res.json(out[0]);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // DELETE by PK
    app.delete(`${base}/:${pk}`, async (req, res) => {
      try {
        const pool = tableMeta.pool;
        const request = pool.request();
        const pkCol = tableMeta.columns.find(c => c.COLUMN_NAME === pk) || {};
        request.input(pk, mapSqlTypeToMssqlType(pkCol), req.params[pk]);

        let sqlText;
        if (tableMeta.hasTriggers) {
          const outSelect = tableMeta.columns.map(c => {
            return c.COLUMN_NAME === tableMeta.identity
              ? `t.[${c.COLUMN_NAME}] + 0 AS [${c.COLUMN_NAME}]`
              : `t.[${c.COLUMN_NAME}]`;
          }).join(', ');
          sqlText = `
            SET NOCOUNT ON;
            IF OBJECT_ID('tempdb..#out') IS NOT NULL DROP TABLE #out;
            SELECT TOP 0 ${outSelect} INTO #out FROM ${qName(schema, table)} AS t WHERE 1 = 0;

            DELETE FROM ${qName(schema, table)}
            OUTPUT deleted.* INTO #out
            WHERE [${pk}] = @${pk};

            SELECT * FROM #out;
            DROP TABLE #out;
          `;
        } else {
          // Original (no triggers)【24-1】
          sqlText = `DELETE FROM ${qName(schema, table)} OUTPUT deleted.* WHERE [${pk}] = @${pk}`;
        }

        logger.verbose('Executing SQL:', sqlText, 'params=', request.parameters);
        const r = await request.query(sqlText);
        const out = Array.isArray(r.recordsets) && r.recordsets[r.recordsets.length - 1] || r.recordset;
        if (!out || out.length === 0) return res.status(404).end();
        res.json(out[0]);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    
  }
}

function registerFunctionRoutes(app, fnMeta, endpoint) {
  const base = `/${endpoint}/f/${fnMeta.func}`;
  const schema = fnMeta.schema;
  const params = fnMeta.params;
  const ftype = fnMeta.type; // 'FN' (scalar), 'TF' or 'IF' (table)

  logger.verbose('Registering routes for', endpoint, `${schema}.${fnMeta.func}`, 'under', base);

  app.post(base, async (req, res) => {
    try {
      const pool = fnMeta.pool;
      const request = pool.request();
      for (const p of params) {
        request.input(
          p.PARAM_NAME,
          mapTypeNameToMssql(p.TYPE_NAME, p.MAX_LENGTH, p.PRECISION, p.SCALE),
          req.body[p.PARAM_NAME]
        );
      }

      const call = `${schema}.${fnMeta.func}`;
      const argsList = params.map(p => `@${p.PARAM_NAME}`).join(', ');

      if (ftype === 'FN') {
        const sqlText = `SELECT ${call}(${argsList}) AS value`;
        const r = await request.query(sqlText);
        return res.json(r.recordset?.[0] ?? {});
      } else {
        const sqlText = `SELECT * FROM ${call}(${argsList})`;
        const r = await request.query(sqlText);
        return res.json(r.recordset ?? []);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

function registerProcRoutes(app, procMeta, endpoint) {
  const base = `/${endpoint}/p/${procMeta.proc}`;
  const schema = procMeta.schema;
  const params = procMeta.params;

  logger.verbose('Registering routes for', endpoint, `${schema}.${procMeta.proc}`, 'under', base);

  app.post(base, async (req, res) => {
    try {
      const pool = procMeta.pool;
      const request = pool.request();
      for (const p of params) {
        if (p.IS_OUTPUT) continue;
        request.input(
          p.PARAM_NAME,
          mapTypeNameToMssql(p.TYPE_NAME, p.MAX_LENGTH, p.PRECISION, p.SCALE),
          req.body[p.PARAM_NAME]
        );
      }
      const r = await request.execute(`${schema}.${procMeta.proc}`);
      res.json(r.recordset?.length ? r.recordset : (r.recordsets || []));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// Sets up endpoints
async function setupDynamicRoutes(app, pool, endpointConfig) {
  const endpoint = endpointConfig.endpoint || 'api';
  const include = endpointConfig.include || {};
  const incTables = include.tables || [];
  const incViews = include.views || [];
  const incProcs = include.procedures || [];
  const incFuncs = include.functions || [];

  const openApiSchemas = {};

  // Tables
  const tables = await discoverTablesByInclude(pool, incTables);
  for (const t of tables) {
    const schema = t.TABLE_SCHEMA;
    const table = t.TABLE_NAME;
    const isView = false;

    const columns = await getColumns(pool, schema, table);
    const pk = await getPrimaryKey(pool, schema, table);
    const hasTriggers = await hasEnabledTriggers(pool, schema, table);
    const identity = await getIdentityColumn(pool, schema, table);

    const meta = { schema, table, columns, pk, pool, isView, hasTriggers, identity };
    registerRoutes(app, meta, endpoint);

    const name = `${endpoint}_${table}`;
    const props = {};
    const required = [];
    for (const c of columns) {
      props[c.COLUMN_NAME] = toOpenApiType(c);
      if (c.IS_NULLABLE === 'NO') required.push(c.COLUMN_NAME);
    }
    openApiSchemas[name] = {
      type: 'object',
      properties: props,
      required,
      'x-msabon-kind': 't',
      'x-msabon-isView': false,
      'x-msabon-hasPk': !!(pk && pk.length)
    };
  }

  // Views
  const views = await discoverViewsByInclude(pool, incViews);
  for (const v of views) {
    const schema = v.TABLE_SCHEMA;
    const table = v.TABLE_NAME;
    const isView = true;

    const columns = await getColumns(pool, schema, table);
    const meta = { schema, table, columns, pk: [], pool, isView, hasTriggers: false, identity: null };
    registerRoutes(app, meta, endpoint);

    const name = `${endpoint}_${table}`;
    const props = {};
    const required = [];
    for (const c of columns) {
      props[c.COLUMN_NAME] = toOpenApiType(c);
      if (c.IS_NULLABLE === 'NO') required.push(c.COLUMN_NAME);
    }
    openApiSchemas[name] = {
      type: 'object',
      properties: props,
      required,
      'x-msabon-kind': 'v',
      'x-msabon-isView': true,
      'x-msabon-hasPk': false
    };
  }

  // Procedures (no hardcoded “usp_”)
  const procs = await discoverProceduresByInclude(pool, incProcs);
  for (const p of procs) {
    const params = await getProcedureParams(pool, p.schema, p.proc);
    const meta = { schema: p.schema, proc: p.proc, params, pool };
    registerProcRoutes(app, meta, endpoint);

    const name = `${endpoint}_${p.proc}`;
    const props = {};
    const required = [];
    for (const prm of params) {
      props[prm.PARAM_NAME] = toOpenApiTypeFromSqlName(prm.TYPE_NAME);
      if (!prm.IS_OUTPUT) required.push(prm.PARAM_NAME);
    }
    openApiSchemas[name] = {
      type: 'object',
      properties: props,
      required,
      'x-msabon-kind': 'p',
      'x-msabon-procName': p.proc,
      'x-msabon-procSchema': p.schema
    };
  }

  // Functions (scalar and table-valued)
  const functions = await discoverFunctionsByInclude(pool, incFuncs);
  for (const f of functions) {
    const params = await getFunctionParams(pool, f.schema, f.func);
    const ret = await getFunctionReturnType(pool, f.schema, f.func);
    const meta = { schema: f.schema, func: f.func, type: f.type, params, returnType: ret, pool };
    registerFunctionRoutes(app, meta, endpoint);

    const name = `${endpoint}_${f.func}`;
    const props = {};
    const required = [];
    for (const prm of params) {
      props[prm.PARAM_NAME] = toOpenApiTypeFromSqlName(prm.TYPE_NAME);
      required.push(prm.PARAM_NAME);
    }
    const sch = {
      type: 'object',
      properties: props,
      required,
      'x-msabon-kind': 'f',
      'x-msabon-fType': f.type
    };
    if (ret && f.type === 'FN') {
      sch['x-msabon-fReturn'] = toOpenApiTypeFromSqlName(ret.TYPE_NAME);
    }
    openApiSchemas[name] = sch;
  }

  if (endpointConfig.advanced === true) {
    registerAdvancedRoute(app, pool, endpoint);

    // OpenAPI schema for advanced payload
    const name = `${endpoint}_advanced`;
    openApiSchemas[name] = {
      type: 'object',
      required: ['data'],
      properties: {
        data: {
          type: 'string',
          format: 'byte',
          description: 'The base64 encoded payload template.'
        }
      },
      additionalProperties: {
        type: 'string',
        description: 'Arbitrary template variables used to populate the data payload.'
      },
      example: {
        exampe_var_1: 'example_value_1',
        exampe_var_2: 'example_value_2',
        data: 'U0VMRUNUIA0KICAgIFNVTSh3aWRnZXRzKSBBUyB0b3RhbFdpZGdldHMNCkZST00gDQogICAgW0RhdGFiYXNlXS5bZGJvXS5bTGF0ZXN0V2lkZ2V0c1ZpZXddDQpXSEVSRSANCiAgICBbdmFyXzFdID0gJ3t7IGV4YW1wbGVfdmFyXzEgfX0nIGFuZCBbdmFyXzJdID0gIHt7IGV4YW1wbGVfdmFyXzIgfX0=',
        rowLimit: 10
      },
      'x-msabon-kind': 'a'
    };
  }

  return openApiSchemas;
}

module.exports = { setupDynamicRoutes };
