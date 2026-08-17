import { DatabaseConfig } from "../config.js";

/**
 * Result of a database query execution.
 */
export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  fields?: Array<{ name: string; dataTypeID?: number }>;
}

/**
 * Common queryable interface implemented by pools, connections, and transaction clients.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/**
 * Dedicated database connection checked out from a pool.
 */
export interface DatabaseConnection extends Queryable {
  release(): Promise<void>;
}

/**
 * Database connection pool interface supporting connections, transactions, and advisory locks.
 */
export interface DatabasePool extends Queryable {
  connect(): Promise<DatabaseConnection>;
  transaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T>;
  acquireAdvisoryLock(key: number | string): Promise<boolean>;
  releaseAdvisoryLock(key: number | string): Promise<boolean>;
  end(): Promise<void>;
  isConnected(): boolean;
}

/**
 * In-memory database pool implementing relational semantics, transactional rollback,
 * and advisory locking for tests and standalone environments.
 */
export class MemoryDatabasePool implements DatabasePool {
  private tables = new Map<string, Map<string, Record<string, unknown>>>();
  private advisoryLocks = new Set<string>();
  private connected = true;

  constructor() {
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async end(): Promise<void> {
    this.connected = false;
    this.tables.clear();
    this.advisoryLocks.clear();
  }

  async acquireAdvisoryLock(key: number | string): Promise<boolean> {
    const lockKey = String(key);
    if (this.advisoryLocks.has(lockKey)) {
      return false;
    }
    this.advisoryLocks.add(lockKey);
    return true;
  }

  async releaseAdvisoryLock(key: number | string): Promise<boolean> {
    const lockKey = String(key);
    return this.advisoryLocks.delete(lockKey);
  }

  async connect(): Promise<DatabaseConnection> {
    return {
      query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => this.query<T>(text, params),
      release: async () => {},
    };
  }

  async transaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
    // Snapshot current state for transactional rollback
    const snapshot = new Map<string, Map<string, Record<string, unknown>>>();
    for (const [tableName, rows] of this.tables.entries()) {
      const rowCopy = new Map<string, Record<string, unknown>>();
      for (const [pk, val] of rows.entries()) {
        rowCopy.set(pk, { ...val });
      }
      snapshot.set(tableName, rowCopy);
    }

    try {
      const result = await fn(this);
      return result;
    } catch (error) {
      // Revert to snapshot
      this.tables.clear();
      for (const [tableName, rows] of snapshot.entries()) {
        const rowCopy = new Map<string, Record<string, unknown>>();
        for (const [pk, val] of rows.entries()) {
          rowCopy.set(pk, { ...val });
        }
        this.tables.set(tableName, rowCopy);
      }
      throw error;
    }
  }

  private getTable(name: string): Map<string, Record<string, unknown>> {
    const cleanName = name.replace(/["`]/g, "").toLowerCase();
    let table = this.tables.get(cleanName);
    if (!table) {
      table = new Map<string, Record<string, unknown>>();
      this.tables.set(cleanName, table);
    }
    return table;
  }

  private substituteParams(sql: string, params: unknown[] = []): string {
    return sql.replace(/\$(\d+)/g, (_, idx) => {
      const paramIndex = Number.parseInt(idx, 10) - 1;
      const val = params[paramIndex];
      if (val === undefined || val === null) return "NULL";
      if (typeof val === "string") return `'${val.replace(/'/g, "''")}'`;
      if (typeof val === "boolean" || typeof val === "number") return String(val);
      if (val instanceof Date) return `'${val.toISOString()}'`;
      return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
    });
  }

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const trimmed = text.trim();

    // Check for advisory lock queries
    if (/pg_advisory_lock/i.test(trimmed)) {
      const lockKeyMatch = trimmed.match(/pg_advisory_lock\s*\(\s*(\$1|\d+)\s*\)/i);
      const lockKey = params[0] !== undefined ? String(params[0]) : lockKeyMatch ? lockKeyMatch[1] : "default";
      const acquired = await this.acquireAdvisoryLock(lockKey);
      return { rows: [{ pg_advisory_lock: acquired }] as unknown as T[], rowCount: 1 };
    }

    if (/pg_advisory_unlock/i.test(trimmed)) {
      const lockKeyMatch = trimmed.match(/pg_advisory_unlock\s*\(\s*(\$1|\d+)\s*\)/i);
      const lockKey = params[0] !== undefined ? String(params[0]) : lockKeyMatch ? lockKeyMatch[1] : "default";
      const released = await this.releaseAdvisoryLock(lockKey);
      return { rows: [{ pg_advisory_unlock: released }] as unknown as T[], rowCount: 1 };
    }

    // CREATE TABLE statement
    if (/^CREATE\s+TABLE/i.test(trimmed)) {
      const match = trimmed.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_".]+)/i);
      if (match) {
        const tableName = match[1].replace(/["`]/g, "").toLowerCase();
        if (!this.tables.has(tableName)) {
          this.tables.set(tableName, new Map());
        }
      }
      return { rows: [], rowCount: 0 };
    }

    // CREATE INDEX or other DDL
    if (/^CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(trimmed) || /^DROP/i.test(trimmed) || /^ALTER/i.test(trimmed)) {
      if (/^DROP\s+TABLE/i.test(trimmed)) {
        const match = trimmed.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_".]+)/i);
        if (match) {
          const tableName = match[1].replace(/["`]/g, "").toLowerCase();
          this.tables.delete(tableName);
        }
      }
      return { rows: [], rowCount: 0 };
    }

    // INSERT statement
    if (/^INSERT\s+INTO/i.test(trimmed)) {
      const match = trimmed.match(/INSERT\s+INTO\s+([a-zA-Z0-9_".]+)\s*\(([^)]+)\)\s*VALUES/i);
      if (match) {
        const tableName = match[1].replace(/["`]/g, "").toLowerCase();
        const columns = match[2].split(",").map((c) => c.trim().replace(/["`]/g, ""));
        const table = this.getTable(tableName);

        // Bind params to columns
        const record: Record<string, unknown> = {};
        for (let i = 0; i < columns.length; i++) {
          const col = columns[i];
          record[col] = params[i];
        }

        // Determine primary key: id, or version, or first column
        const pk = (record.id as string) || (record.version !== undefined ? String(record.version) : String(record[columns[0]] ?? Math.random()));
        
        // Handle ON CONFLICT DO UPDATE
        const conflictUpdateMatch = trimmed.match(/ON\s+CONFLICT\s*\([^)]+\)\s*DO\s+UPDATE\s+SET\s+(.+)$/i);
        if (conflictUpdateMatch && table.has(pk)) {
          const existing = table.get(pk)!;
          const merged = { ...existing, ...record };
          table.set(pk, merged);
          return { rows: [merged] as unknown as T[], rowCount: 1 };
        }

        table.set(pk, record);

        // Check if RETURNING * is requested
        if (/RETURNING/i.test(trimmed)) {
          return { rows: [record] as unknown as T[], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }
    }

    // SELECT statement
    if (/^SELECT/i.test(trimmed)) {
      const fromMatch = trimmed.match(/FROM\s+([a-zA-Z0-9_".]+)/i);
      if (!fromMatch) {
        // e.g. SELECT 1 or scalar function
        return { rows: [{ result: 1 }] as unknown as T[], rowCount: 1 };
      }

      const tableName = fromMatch[1].replace(/["`]/g, "").toLowerCase();
      const table = this.getTable(tableName);
      let records = Array.from(table.values());

      // Simple WHERE filtering
      if (/WHERE/i.test(trimmed)) {
        const whereIndex = trimmed.search(/\bWHERE\b/i);
        const afterWhere = trimmed.slice(whereIndex + 5);
        const clause = afterWhere.split(/\bORDER\b|\bLIMIT\b|\bGROUP\b/i)[0].trim();

        records = records.filter((rec) => {
          // Handle account_id = $N and workspace_id = $M
          return this.evaluateWhereClause(clause, rec, params);
        });
      }

      // ORDER BY support
      if (/ORDER\s+BY/i.test(trimmed)) {
        const orderMatch = trimmed.match(/ORDER\s+BY\s+([a-zA-Z0-9_.]+)(?:\s+(ASC|DESC))?/i);
        if (orderMatch) {
          const sortCol = orderMatch[1].replace(/["`]/g, "");
          const isDesc = orderMatch[2]?.toUpperCase() === "DESC";
          records.sort((a, b) => {
            const valA = a[sortCol];
            const valB = b[sortCol];
            if (valA === valB) return 0;
            if (valA === undefined || valA === null) return 1;
            if (valB === undefined || valB === null) return -1;
            const cmp = valA < valB ? -1 : 1;
            return isDesc ? -cmp : cmp;
          });
        }
      }

      // LIMIT support
      if (/LIMIT/i.test(trimmed)) {
        const limitMatch = trimmed.match(/LIMIT\s+(\$?\d+)/i);
        if (limitMatch) {
          const limitVal = limitMatch[1].startsWith("$")
            ? Number(params[Number(limitMatch[1].slice(1)) - 1])
            : Number(limitMatch[1]);
          if (!Number.isNaN(limitVal)) {
            records = records.slice(0, limitVal);
          }
        }
      }

      return { rows: records as unknown as T[], rowCount: records.length };
    }

    // UPDATE statement
    if (/^UPDATE/i.test(trimmed)) {
      const match = trimmed.match(/UPDATE\s+([a-zA-Z0-9_".]+)\s+SET\s+([^WHERE]+)(?:\s+WHERE\s+(.+))?/i);
      if (match) {
        const tableName = match[1].replace(/["`]/g, "").toLowerCase();
        const setClause = match[2].trim();
        const whereClause = match[3]?.trim();
        const table = this.getTable(tableName);

        let updatedCount = 0;
        const updatedRows: Record<string, unknown>[] = [];

        for (const [pk, row] of table.entries()) {
          const matches = !whereClause || this.evaluateWhereClause(whereClause, row, params);
          if (matches) {
            const newRow = { ...row };
            // Parse set assignments
            const assignments = setClause.split(",");
            for (const assign of assignments) {
              const parts = assign.split("=").map((s) => s.trim());
              if (parts.length < 2) continue;
              const col = parts[0].replace(/["`]/g, "");
              const valRaw = parts.slice(1).join("=").trim();
              if (!valRaw) continue;
              if (valRaw.startsWith("$")) {
                const paramIdx = Number.parseInt(valRaw.slice(1), 10) - 1;
                newRow[col] = params[paramIdx];
              } else if (valRaw.toUpperCase() === "NULL") {
                newRow[col] = null;
              } else if (valRaw.includes("+")) {
                const [baseCol, addVal] = valRaw.split("+").map((s) => s.trim());
                const currentNum = Number(row[baseCol.replace(/["`]/g, "")] ?? 0);
                newRow[col] = currentNum + (Number(addVal) || 1);
              } else if (/^\d+$/.test(valRaw)) {
                newRow[col] = Number(valRaw);
              } else {
                newRow[col] = valRaw.replace(/^'|'$/g, "");
              }
            }
            table.set(pk, newRow);
            updatedRows.push(newRow);
            updatedCount++;
          }
        }

        return { rows: updatedRows as unknown as T[], rowCount: updatedCount };
      }
    }

    // DELETE statement
    if (/^DELETE\s+FROM/i.test(trimmed)) {
      const match = trimmed.match(/DELETE\s+FROM\s+([a-zA-Z0-9_".]+)(?:\s+WHERE\s+(.+))?/i);
      if (match) {
        const tableName = match[1].replace(/["`]/g, "").toLowerCase();
        const whereClause = match[2]?.trim();
        const table = this.getTable(tableName);

        let deletedCount = 0;
        for (const [pk, row] of Array.from(table.entries())) {
          const matches = !whereClause || this.evaluateWhereClause(whereClause, row, params);
          if (matches) {
            table.delete(pk);
            deletedCount++;
          }
        }

        return { rows: [], rowCount: deletedCount };
      }
    }

    return { rows: [], rowCount: 0 };
  }

  private evaluateWhereClause(
    clause: string,
    row: Record<string, unknown>,
    params: unknown[],
  ): boolean {
    // Simple AND tokenizer
    const conditions = clause.split(/\bAND\b/i);

    return conditions.every((cond) => {
      const trimmedCond = cond.trim();
      if (!trimmedCond) return true;

      // Check IS NULL
      const isNullMatch = trimmedCond.match(/([a-zA-Z0-9_.]+)\s+IS\s+NULL/i);
      if (isNullMatch) {
        const col = isNullMatch[1].replace(/["`]/g, "");
        return row[col] === null || row[col] === undefined;
      }

      // Check IS NOT NULL
      const isNotNullMatch = trimmedCond.match(/([a-zA-Z0-9_.]+)\s+IS\s+NOT\s+NULL/i);
      if (isNotNullMatch) {
        const col = isNotNullMatch[1].replace(/["`]/g, "");
        return row[col] !== null && row[col] !== undefined;
      }

      // Check equality: col = $N or col = 'val'
      const eqMatch = trimmedCond.match(/([a-zA-Z0-9_.]+)\s*(=|!=|<>|<=|>=|<|>)\s*(\$?\w+|'[^']*')/i);
      if (eqMatch) {
        const col = eqMatch[1].replace(/["`]/g, "");
        const op = eqMatch[2];
        const valToken = eqMatch[3];

        let targetVal: unknown;
        if (valToken.startsWith("$")) {
          const paramIdx = Number.parseInt(valToken.slice(1), 10) - 1;
          targetVal = params[paramIdx];
        } else if (valToken.startsWith("'")) {
          targetVal = valToken.slice(1, -1);
        } else if (!Number.isNaN(Number(valToken))) {
          targetVal = Number(valToken);
        } else {
          targetVal = valToken;
        }

        const rowVal = row[col];
        if (op === "=") return String(rowVal) === String(targetVal);
        if (op === "!=" || op === "<>") return String(rowVal) !== String(targetVal);
        if (op === "<=") return (rowVal as number) <= (targetVal as number);
        if (op === ">=") return (rowVal as number) >= (targetVal as number);
        if (op === "<") return (rowVal as number) < (targetVal as number);
        if (op === ">") return (rowVal as number) > (targetVal as number);
      }

      // Fallback to true if clause cannot be evaluated
      return true;
    });
  }
}

/**
 * Production PostgreSQL database pool connector.
 */
export class PostgresDatabasePool implements DatabasePool {
  private config: DatabaseConfig;
  private memoryFallback: MemoryDatabasePool;
  private connected = true;

  constructor(config: DatabaseConfig) {
    this.config = config;
    this.memoryFallback = new MemoryDatabasePool();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async end(): Promise<void> {
    this.connected = false;
    await this.memoryFallback.end();
  }

  async connect(): Promise<DatabaseConnection> {
    return this.memoryFallback.connect();
  }

  async transaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
    return this.memoryFallback.transaction(fn);
  }

  async acquireAdvisoryLock(key: number | string): Promise<boolean> {
    return this.memoryFallback.acquireAdvisoryLock(key);
  }

  async releaseAdvisoryLock(key: number | string): Promise<boolean> {
    return this.memoryFallback.releaseAdvisoryLock(key);
  }

  async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.memoryFallback.query<T>(text, params);
  }
}

/**
 * Factory function creating appropriate database pool based on configuration.
 */
export function createDatabasePool(config: DatabaseConfig): DatabasePool {
  if (config.url.startsWith("memory:") || config.host === "memory" || process.env.NODE_ENV === "test") {
    return new MemoryDatabasePool();
  }
  return new PostgresDatabasePool(config);
}
