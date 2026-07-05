import { DatabaseSync as Database } from "node:sqlite";
import { mkdir } from 'node:fs';
import { promisify } from 'node:util';
import type {
  MakeDirectoryOptions
} from 'node:fs';
import type {
  AuthQuery,
  AuthRecord,
  AuthUpdate,
  DatabaseProvider,
  DeleteResult,
  ExecuteResult,
  InsertResult,
  SqlParam,
  SqlQueryObject,
  SqlStatement,
  Subscription,
  UpdateResult,
  Usage,
  User,
  UserQuery,
  UserUpdate,
  WebhookEventRecord,
  Guide,
  GuideSummary,
  GuideInput,
  GuideFilters,
  GuideJobs,
  GuideChapter,
  GuideTiming,
  ShapeGuideOptions,
  UpsertGuideResult
} from '../types.ts';

/** Promisified node:fs.mkdir — the live default for the {@link FsSeam}. */
const mkdirAsync = promisify(mkdir);

/** Filesystem operations this module needs — injectable so tests avoid mocking `node:fs`. */
interface FsSeam {
  mkdir(path: string, options: MakeDirectoryOptions): Promise<string | undefined>;
}

/** Live filesystem seam. Overridden in tests via {@link __setFsForTests}. */
let fs: FsSeam = { mkdir: mkdirAsync };

/**
 * Test-only seam: swap the filesystem backend. Avoids `mock.module('node:fs')`, whose
 * named/default exports don't survive `--experimental-test-module-mocks` reliably across
 * Node versions (Node 24.14 breaks named-import resolution on the mocked builtin).
 *
 * @param seam - Replacement mkdir implementation
 */
export function __setFsForTests(seam: FsSeam): void {
  fs = seam;
}

/**
 * True for a non-null, non-array plain object.
 *
 * @param value - Value to test
 * @returns True if value is a plain object
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Type guard for a chapters_json column (an array of chapter objects).
 *
 * @param value - Parsed JSON value
 * @returns True if value is a GuideChapter[]
 */
function isGuideChapterArray(value: unknown): value is GuideChapter[] {
  return Array.isArray(value) && value.every(isPlainObject);
}

/**
 * Type guard for a jobs_json column (a map of job-step records).
 *
 * @param value - Parsed JSON value
 * @returns True if value is a GuideJobs map
 */
function isGuideJobs(value: unknown): value is GuideJobs {
  return isPlainObject(value) && Object.values(value).every(isPlainObject);
}

/**
 * Type guard for a timing_json column (a word-timing payload object or null).
 *
 * @param value - Parsed JSON value
 * @returns True if value is a GuideTiming or null
 */
function isGuideTimingOrNull(value: unknown): value is GuideTiming | null {
  return value === null || isPlainObject(value);
}

/**
 * Raw Users table row as returned by SELECT *, with flat subscription_* and
 * usage_* columns. findUser mutates this shape in place — nesting the flat
 * columns into `subscription`/`usage` objects and deleting them — so the flat
 * columns are optional and the nested fields are declared here too.
 */
type UserRow = {
  _id: string;
  email: string;
  name: string;
  created_at: number;
  subscription_stripeID?: string | null;
  subscription_expires?: number | null;
  subscription_status?: string | null;
  usage_count?: number | null;
  usage_reset_at?: number | null;
  subscription?: Subscription;
  usage?: Usage;
};

/**
 * Raw Guides table row as returned by SELECT. JSON columns (chapters_json,
 * timing_json, jobs_json) are text and inflated by shapeGuide; the column set
 * is partial because listGuides selects only a subset.
 */
type GuideRow = {
  slug: string;
  title: string;
  author: string | null;
  date: string | null;
  duration: number | null;
  audio_url?: string | null;
  thumbnail: string | null;
  timing_offset?: number | null;
  default_view_mode?: string | null;
  visibility: string;
  summary?: string | null;
  source_url?: string | null;
  transcript?: string | null;
  chapters_json: string | null;
  timing_json?: string | null;
  jobs_json: string | null;
  created_at: number;
  updated_at: number;
};

/**
 * Per-statement result row collected by executeTransaction.
 */
type TransactionStatementResult = {
  query: string;
  changes: number;
  lastInsertRowid: number | bigint | null;
};

/**
 * Narrow an unknown SQLite row to a non-null object so its keys can be probed.
 *
 * @param value - Row returned by node:sqlite's `.get()` (typed `unknown`)
 * @returns True when `value` is a non-null, non-array object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Type guard for a raw Users row. Checks the required, non-nullable columns
 * (`_id`, `email`, `name`, `created_at`); the optional subscription and usage
 * columns are validated implicitly by the transform logic in findUser.
 *
 * @param value - Row returned by `.get()`
 * @returns True when `value` matches the UserRow required shape
 */
function isUserRow(value: unknown): value is UserRow {
  return (
    isRecord(value) &&
    typeof value._id === 'string' &&
    typeof value.email === 'string' &&
    typeof value.name === 'string' &&
    typeof value.created_at === 'number'
  );
}

/**
 * Type guard for an Auths row.
 *
 * @param value - Row returned by `.get()`
 * @returns True when `value` matches the AuthRecord shape
 */
function isAuthRecord(value: unknown): value is AuthRecord {
  return (
    isRecord(value) &&
    typeof value.email === 'string' &&
    typeof value.password === 'string' &&
    typeof value.userID === 'string'
  );
}

/**
 * Type guard for a WebhookEvents row.
 *
 * @param value - Row returned by `.get()`
 * @returns True when `value` matches the WebhookEventRecord shape
 */
function isWebhookEventRecord(value: unknown): value is WebhookEventRecord {
  return (
    isRecord(value) &&
    typeof value.event_id === 'string' &&
    typeof value.event_type === 'string' &&
    typeof value.processed_at === 'number'
  );
}

/**
 * SQLite database provider using Node.js built-in DatabaseSync
 *
 * Manages multiple SQLite connections with WAL mode for concurrency.
 * Automatically creates schema on first connection. Stores databases
 * in ./databases directory by default.
 *
 * Features:
 * - WAL journal mode for better concurrency
 * - Automatic schema creation
 * - Connection caching per database name
 * - Nested object transformation (subscription, usage)
 * - Transaction support
 *
 * @class
 */
export class SQLiteProvider implements DatabaseProvider<Database> {
  databases: Map<string, Database>;

  /**
   * Create SQLite provider with empty database cache
   */
  constructor() {
    this.databases = new Map();
  }

  /**
   * Initialize SQLite provider by creating databases directory
   */
  async initialize(): Promise<void> {
    await this.initializeSQLite();
  }

  /**
   * Create ./databases directory if it doesn't exist
   *
   * Uses recursive option to create parent directories. Ignores EEXIST errors.
   */
  async initializeSQLite(): Promise<void> {
    try {
      await fs.mkdir('./databases', { recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        console.error("Failed to create databases directory:", err);
      }
    }
  }

  /**
   * Create database schema if tables don't exist
   *
   * Creates Users and Auths tables with indexes. Flattens nested subscription
   * and usage objects into columns (subscription_stripeID, usage_count, etc).
   *
   * @param db - SQLite database instance
   */
  async ensureSQLiteSchema(db: Database): Promise<void> {
    db.exec(`
      CREATE TABLE IF NOT EXISTS Users (
        _id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        subscription_stripeID TEXT,
        subscription_expires INTEGER,
        subscription_status TEXT,
        usage_count INTEGER DEFAULT 0,
        usage_reset_at INTEGER
      )
    `);

    // Create Auths table
    db.exec(`
      CREATE TABLE IF NOT EXISTS Auths (
        email TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        userID TEXT NOT NULL,
        FOREIGN KEY (userID) REFERENCES Users(_id)
      )
    `);

    // Create indexes
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON Users(email)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_auths_email ON Auths(email)`);

    // Create WebhookEvents table for idempotency
    db.exec(`
      CREATE TABLE IF NOT EXISTS WebhookEvents (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        processed_at INTEGER NOT NULL
      )
    `);

    // Guides table — content catalog (audio + transcript + chapters + word timings).
    // chapters_json / timing_json hold JSON-serialized payloads; audio_url + thumbnail
    // are URL pointers to filesystem assets under backend/public/.
    db.exec(`
      CREATE TABLE IF NOT EXISTS Guides (
        slug TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT,
        date TEXT,
        duration INTEGER,
        audio_url TEXT,
        thumbnail TEXT,
        timing_offset REAL DEFAULT 0,
        default_view_mode TEXT DEFAULT 'real',
        transcript TEXT,
        summary TEXT,
        source_url TEXT,
        jobs_json TEXT,
        chapters_json TEXT NOT NULL,
        timing_json TEXT,
        visibility TEXT DEFAULT 'public',
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_guides_visibility ON Guides(visibility)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_guides_author ON Guides(author)`);

    // Backfill new columns on existing DBs (ALTER throws if column exists — swallow).
    for (const ddl of [
      `ALTER TABLE Guides ADD COLUMN summary TEXT`,
      `ALTER TABLE Guides ADD COLUMN source_url TEXT`,
      `ALTER TABLE Guides ADD COLUMN jobs_json TEXT`,
    ]) {
      try { db.exec(ddl); } catch { /* column already exists */ }
    }
  }

  /**
   * Get or create SQLite database connection with caching
   *
   * Opens database with WAL mode, NORMAL synchronous, and memory temp store
   * for optimal performance. Creates schema on first connection.
   *
   * @param dbName - Database name for cache key
   * @param connectionString - File path, defaults to ./databases/{dbName}.db
   * @returns SQLite DatabaseSync instance
   */
  getDatabase(dbName: string, connectionString: string | null = null): Database {
    if (!this.databases.has(dbName)) {
      const dbPath = connectionString || `./databases/${dbName}.db`;
      const db = new Database(dbPath);

      // Enable WAL mode for better concurrency and performance
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA cache_size = 1000');
      db.exec('PRAGMA temp_store = memory');

      this.ensureSQLiteSchema(db);
      this.databases.set(dbName, db);
    }
    return this.databases.get(dbName)!;
  }

  /**
   * Find user by ID or email with optional field projection
   *
   * Transforms flat columns to nested subscription and usage objects.
   * Projection parameter is accepted for API compatibility but not implemented.
   *
   * @param db - SQLite database instance
   * @param query - Query object with _id or email
   * @param projection - Field projection (compatibility only)
   * @returns User object with subscription and usage nested, or null
   */
  async findUser(db: Database, query: UserQuery, projection: Record<string, unknown> = {}): Promise<User | null> {
    const { _id, email } = query;
    let sql = "SELECT * FROM Users WHERE ";
    let params: SqlParam[] = [];

    if (_id) {
      sql += "_id = ?";
      params.push(_id);
    } else if (email) {
      sql += "email = ?";
      params.push(email);
    } else {
      return null;
    }

    // node:sqlite returns undefined for a miss; normalize to the declared null
    const row = db.prepare(sql).get(...params);
    const result = isUserRow(row) ? row : null;
    if (result) {
      // Transform subscription fields
      if (result.subscription_stripeID) {
        result.subscription = {
          stripeID: result.subscription_stripeID,
          expires: result.subscription_expires ?? null,
          status: result.subscription_status ?? ''
        };
        delete result.subscription_stripeID;
        delete result.subscription_expires;
        delete result.subscription_status;
      }
      // Transform usage fields
      if (result.usage_count !== undefined) {
        result.usage = {
          count: result.usage_count || 0,
          reset_at: result.usage_reset_at || null
        };
        delete result.usage_count;
        delete result.usage_reset_at;
      }
    }
    return result;
  }

  /**
   * Insert new user with default values
   *
   * Creates user record. Subscription and usage fields are nullable/default.
   *
   * @param db - SQLite database instance
   * @param userData - User data to insert
   * @returns Inserted user ID
   * @throws {Error} If email already exists
   */
  async insertUser(db: Database, userData: User): Promise<InsertResult> {
    const { _id, email, name, created_at } = userData;
    const sql = "INSERT INTO Users (_id, email, name, created_at) VALUES (?, ?, ?, ?)";
    db.prepare(sql).run(_id, email, name, created_at);
    return { insertedId: _id };
  }

  /**
   * Update user fields by ID
   *
   * Supports three update patterns:
   * - $inc operator for atomic increments (e.g., usage.count)
   * - $set with subscription object (maps to subscription_* columns)
   * - $set with usage object (maps to usage_* columns)
   * - $set with flat fields (direct column updates)
   *
   * Whitelists allowed fields to prevent SQL injection.
   *
   * @param db - SQLite database instance
   * @param query - Query object with _id
   * @param update - Update object with $inc or $set
   * @returns Number of modified rows
   */
  async updateUser(db: Database, query: UserQuery, update: UserUpdate): Promise<UpdateResult> {
    const { _id } = query;
    if (!_id) throw new Error('updateUser requires _id');
    const ALLOWED_FIELDS = ['name', 'email', 'created_at', 'subscription_stripeID', 'subscription_expires', 'subscription_status', 'usage_count', 'usage_reset_at'];

    // Handle $inc operator for atomic increments
    if (update.$inc) {
      const incField = Object.keys(update.$inc)[0];
      const incValue = update.$inc[incField];
      // Map nested fields to flat column names
      const columnMap: Record<string, string> = { 'usage.count': 'usage_count' };
      const column = columnMap[incField] || incField;
      if (!ALLOWED_FIELDS.includes(column)) return { modifiedCount: 0 };
      const sql = `UPDATE Users SET ${column} = COALESCE(${column}, 0) + ? WHERE _id = ?`;
      const result = db.prepare(sql).run(incValue, _id);
      return { modifiedCount: result.changes as number };
    }

    const updateData = update.$set;
    if (!updateData) return { modifiedCount: 0 };

    if (updateData.subscription) {
      const { stripeID, expires, status } = updateData.subscription;
      const sql = `UPDATE Users SET
        subscription_stripeID = ?,
        subscription_expires = ?,
        subscription_status = ?
        WHERE _id = ?`;
      const result = db.prepare(sql).run(stripeID, expires, status, _id);
      return { modifiedCount: result.changes as number };
    } else if (updateData.usage) {
      const { count, reset_at } = updateData.usage;
      const sql = `UPDATE Users SET
        usage_count = ?,
        usage_reset_at = ?
        WHERE _id = ?`;
      const result = db.prepare(sql).run(count, reset_at, _id);
      return { modifiedCount: result.changes as number };
    } else {
      // Handle other updates with field validation
      const fields = Object.keys(updateData).filter(field => ALLOWED_FIELDS.includes(field));
      if (fields.length === 0) return { modifiedCount: 0 };

      const setClause = fields.map(field => `${field} = ?`).join(', ');
      const values = fields.map(field => updateData[field]) as SqlParam[];
      values.push(_id);

      const sql = `UPDATE Users SET ${setClause} WHERE _id = ?`;
      const result = db.prepare(sql).run(...values);
      return { modifiedCount: result.changes as number };
    }
  }

  /**
   * Delete user row by ID or email
   *
   * Matches findUser's selector convention: _id is checked first, then email.
   * Returns deletedCount 0 when neither selector is given or no row matches.
   *
   * @param db - SQLite database instance
   * @param query - Query object with _id or email
   * @returns Number of deleted rows
   */
  async deleteUser(db: Database, query: UserQuery): Promise<DeleteResult> {
    const { _id, email } = query;
    let sql = "DELETE FROM Users WHERE ";
    const params: SqlParam[] = [];

    if (_id) {
      sql += "_id = ?";
      params.push(_id);
    } else if (email) {
      sql += "email = ?";
      params.push(email);
    } else {
      return { deletedCount: 0 };
    }

    const result = db.prepare(sql).run(...params);
    return { deletedCount: result.changes as number };
  }

  /**
   * Find authentication record by email
   *
   * @param db - SQLite database instance
   * @param query - Query object with email
   * @returns Auth record with password hash, or null
   */
  async findAuth(db: Database, query: AuthQuery): Promise<AuthRecord | null> {
    const { email } = query;
    const sql = "SELECT * FROM Auths WHERE email = ?";
    // node:sqlite returns undefined for a miss; normalize to the declared null
    const row = db.prepare(sql).get(email);
    return isAuthRecord(row) ? row : null;
  }

  /**
   * Insert authentication record with hashed password
   *
   * @param db - SQLite database instance
   * @param authData - Auth data to insert
   * @returns Inserted email
   * @throws {Error} If email already exists
   */
  async insertAuth(db: Database, authData: AuthRecord): Promise<InsertResult> {
    const { email, password, userID } = authData;
    const sql = "INSERT INTO Auths (email, password, userID) VALUES (?, ?, ?)";
    db.prepare(sql).run(email, password, userID);
    return { insertedId: email };
  }

  /**
   * Update authentication record (password only)
   *
   * @param db - SQLite database instance
   * @param query - Query object with email
   * @param update - Fields to update
   * @returns Number of modified rows
   */
  async updateAuth(db: Database, query: AuthQuery, update: AuthUpdate): Promise<UpdateResult> {
    const { email } = query;
    const { password } = update;
    if (typeof password !== 'string') return { modifiedCount: 0 };
    const sql = "UPDATE Auths SET password = ? WHERE email = ?";
    const result = db.prepare(sql).run(password, email);
    return { modifiedCount: result.changes as number };
  }

  /**
   * Find webhook event by event ID for idempotency check
   *
   * @param db - SQLite database instance
   * @param eventId - Stripe event ID
   * @returns Webhook event record or null if not found
   */
  async findWebhookEvent(db: Database, eventId: string): Promise<WebhookEventRecord | null> {
    const sql = "SELECT * FROM WebhookEvents WHERE event_id = ?";
    // node:sqlite returns undefined for a miss; normalize to the declared null
    const row = db.prepare(sql).get(eventId);
    return isWebhookEventRecord(row) ? row : null;
  }

  /**
   * Insert webhook event record for idempotency tracking
   *
   * @param db - SQLite database instance
   * @param eventId - Stripe event ID (unique)
   * @param eventType - Stripe event type
   * @param processedAt - Unix timestamp
   * @returns Inserted event ID
   */
  async insertWebhookEvent(db: Database, eventId: string, eventType: string, processedAt: number): Promise<InsertResult> {
    const sql = "INSERT INTO WebhookEvents (event_id, event_type, processed_at) VALUES (?, ?, ?)";
    db.prepare(sql).run(eventId, eventType, processedAt);
    return { insertedId: eventId };
  }

  /**
   * Parse a JSON column safely, returning the fallback on null/invalid input.
   *
   * The parsed value is validated with the supplied runtime type guard; if the
   * column is null, unparseable, or fails the guard, the fallback is returned.
   *
   * @param raw - JSON text from a SQLite column
   * @param guard - Runtime type guard proving the parsed value is a T
   * @param fallback - Value to return when raw is null, unparseable, or invalid
   * @returns Parsed value or fallback
   */
  parseJsonColumn<T>(raw: string | null, guard: (value: unknown) => value is T, fallback: T): T {
    if (raw == null) return fallback;
    try {
      const parsed: unknown = JSON.parse(raw);
      return guard(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Shape a Guides row into the frontend-facing object.
   *
   * Inflates chapters_json/timing_json, surfaces a chapterCount, and renames
   * snake_case columns to the camelCase keys the player expects.
   *
   * @param {Object|null} row - Raw row from the Guides table
   * @param {{includeTranscript?: boolean, includeTiming?: boolean, includeChapters?: boolean}} [opts]
   * @returns {Object|null} Guide object or null
   */
  shapeGuide(row: GuideRow | undefined | null, opts: ShapeGuideOptions = {}): Guide | null {
    if (!row) return null;
    const includeTranscript = opts.includeTranscript !== false;
    const includeTiming = opts.includeTiming !== false;
    const includeChapters = opts.includeChapters !== false;

    const chapters = this.parseJsonColumn(row.chapters_json, isGuideChapterArray, []);
    const out: Guide = {
      slug: row.slug,
      title: row.title,
      author: row.author,
      date: row.date,
      duration: row.duration,
      audio: row.audio_url ?? null,
      thumbnail: row.thumbnail,
      timingOffset: row.timing_offset ?? 0,
      defaultViewMode: row.default_view_mode || 'real',
      visibility: row.visibility,
      summary: row.summary || null,
      sourceUrl: row.source_url || null,
      jobs: this.parseJsonColumn(row.jobs_json, isGuideJobs, {}),
      chapterCount: Array.isArray(chapters) ? chapters.length : 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (includeChapters) out.chapters = chapters;
    if (includeTranscript) out.transcript = row.transcript || '';
    if (includeTiming) {
      const timing = this.parseJsonColumn(row.timing_json ?? null, isGuideTimingOrNull, null);
      if (timing) out.timing = timing;
    }
    return out;
  }

  /**
   * List guides with summary fields only (no transcript, timing, or chapters body).
   *
   * Returns the minimal payload the catalog UI needs — does not surface
   * player-only fields like timingOffset or defaultViewMode.
   *
   * @async
   * @param {Database} db - SQLite database instance
   * @param {{visibility?: string}} [filters={}] - Optional visibility filter
   * @returns {Promise<Array<Object>>} Array of guide summaries ordered newest-first
   */
  async listGuides(db: Database, filters: GuideFilters = {}): Promise<GuideSummary[]> {
    let sql = `SELECT slug, title, author, date, duration, thumbnail, chapters_json,
                      jobs_json, visibility, created_at, updated_at
               FROM Guides`;
    const params: SqlParam[] = [];
    if (filters.visibility) {
      sql += ` WHERE visibility = ?`;
      params.push(filters.visibility);
    }
    sql += ` ORDER BY created_at DESC`;
    const rows = db.prepare(sql).all(...params) as GuideRow[];
    return rows.map((r: GuideRow): GuideSummary => {
      const chapters = this.parseJsonColumn(r.chapters_json, isGuideChapterArray, []);
      return {
        slug: r.slug,
        title: r.title,
        author: r.author,
        date: r.date,
        duration: r.duration,
        thumbnail: r.thumbnail,
        chapterCount: Array.isArray(chapters) ? chapters.length : 0,
        visibility: r.visibility,
        jobs: this.parseJsonColumn(r.jobs_json, isGuideJobs, {}),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }

  /**
   * Fetch one guide by slug, fully hydrated (chapters + transcript + timing).
   *
   * @async
   * @param {Database} db - SQLite database instance
   * @param {string} slug - Guide slug
   * @returns {Promise<Object|null>} Guide object or null
   */
  async getGuide(db: Database, slug: string): Promise<Guide | null> {
    const row = db.prepare(`SELECT * FROM Guides WHERE slug = ?`).get(slug) as GuideRow | undefined;
    return this.shapeGuide(row);
  }

  /**
   * Upsert a guide by slug. Used by both the migration script and POST /api/guides.
   *
   * Stores chapters and word timings as JSON text. Caller is responsible for
   * authorization and validation.
   *
   * @async
   * @param {Database} db - SQLite database instance
   * @param {Object} guide - Guide payload
   * @param {string} guide.slug - Unique slug (primary key)
   * @param {string} guide.title - Title
   * @param {string} [guide.author]
   * @param {string} [guide.date]
   * @param {number} [guide.duration]
   * @param {string} [guide.audio] - Audio URL
   * @param {string} [guide.thumbnail] - Thumbnail URL
   * @param {number} [guide.timingOffset]
   * @param {string} [guide.defaultViewMode]
   * @param {string} [guide.transcript]
   * @param {Array} [guide.chapters]
   * @param {Object|Array} [guide.timing] - Word-timing payload (object or array)
   * @param {string} [guide.visibility='public']
   * @param {string} [guide.createdBy]
   * @returns {Promise<{slug: string, inserted: boolean}>} Slug and whether the row was new
   */
  async upsertGuide(db: Database, guide: GuideInput): Promise<UpsertGuideResult> {
    const now = Date.now();
    const existing = db.prepare(`SELECT slug FROM Guides WHERE slug = ?`).get(guide.slug) as { slug: string } | undefined;
    const chaptersJson = JSON.stringify(guide.chapters ?? []);
    const timingJson = guide.timing == null ? null : JSON.stringify(guide.timing);
    const jobsJson = guide.jobs == null ? null : JSON.stringify(guide.jobs);
    const visibility = guide.visibility || 'public';

    if (existing) {
      const sql = `UPDATE Guides SET
        title = ?, author = ?, date = ?, duration = ?,
        audio_url = ?, thumbnail = ?, timing_offset = ?, default_view_mode = ?,
        transcript = ?, summary = ?, source_url = ?, jobs_json = ?,
        chapters_json = ?, timing_json = ?,
        visibility = ?, updated_at = ?
        WHERE slug = ?`;
      db.prepare(sql).run(
        guide.title,
        guide.author ?? null,
        guide.date ?? null,
        guide.duration ?? null,
        guide.audio ?? null,
        guide.thumbnail ?? null,
        guide.timingOffset ?? 0,
        guide.defaultViewMode ?? 'real',
        guide.transcript ?? null,
        guide.summary ?? null,
        guide.sourceUrl ?? null,
        jobsJson,
        chaptersJson,
        timingJson,
        visibility,
        now,
        guide.slug,
      );
      return { slug: guide.slug, inserted: false };
    }

    const sql = `INSERT INTO Guides
      (slug, title, author, date, duration, audio_url, thumbnail,
       timing_offset, default_view_mode, transcript, summary, source_url, jobs_json,
       chapters_json, timing_json,
       visibility, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    db.prepare(sql).run(
      guide.slug,
      guide.title,
      guide.author ?? null,
      guide.date ?? null,
      guide.duration ?? null,
      guide.audio ?? null,
      guide.thumbnail ?? null,
      guide.timingOffset ?? 0,
      guide.defaultViewMode ?? 'real',
      guide.transcript ?? null,
      guide.summary ?? null,
      guide.sourceUrl ?? null,
      jobsJson,
      chaptersJson,
      timingJson,
      visibility,
      guide.createdBy ?? null,
      now,
      now,
    );
    return { slug: guide.slug, inserted: true };
  }

  /**
   * Atomically merge a job state into Guides.jobs_json for one slug+step.
   *
   * Read-modify-write inside a transaction so concurrent calls don't clobber
   * each other. Fields in `jobState` are shallow-merged into any existing entry
   * for the given step name.
   *
   * @async
   * @param {Database} db - SQLite database instance
   * @param {string} slug - Guide slug
   * @param {string} step - Step name (e.g. 'tts', 'chapter-images')
   * @param {Object} jobState - Partial job state to merge (e.g. {status: 'running', startedAt})
   * @returns {Promise<Object>} The full merged jobs object
   */
  async updateGuideJob(db: Database, slug: string, step: string, jobState: Record<string, unknown>): Promise<GuideJobs> {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare(`SELECT jobs_json FROM Guides WHERE slug = ?`).get(slug) as { jobs_json: string | null } | undefined;
      if (!row) throw new Error(`Guide not found: ${slug}`);
      const jobs = this.parseJsonColumn(row.jobs_json, isGuideJobs, {});
      jobs[step] = { ...(jobs[step] || {}), ...jobState };
      db.prepare(`UPDATE Guides SET jobs_json = ?, updated_at = ? WHERE slug = ?`)
        .run(JSON.stringify(jobs), Date.now(), slug);
      db.exec('COMMIT');
      return jobs;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  /**
   * Execute custom SQL query with unified response format
   *
   * Handles both SELECT (uses .all()) and modification queries (uses .run()).
   * Automatically detects query type. Supports transactions via transaction array.
   *
   * Response format includes success flag, data, rowCount, and metadata with timing.
   *
   * @param db - SQLite database instance
   * @param queryObject - Query configuration with query string, params, or transaction operations
   * @returns Query result
   */
  async execute(db: Database, queryObject: SqlQueryObject): Promise<ExecuteResult> {
    const startTime = Date.now();

    try {
      const { query, params = [], transaction } = queryObject;
      if (transaction && Array.isArray(transaction)) {
        return this.executeTransaction(db, transaction, startTime);
      }

      if (!query) {
        throw new Error('Query string is required');
      }

      // Determine if it's a SELECT query or modification query
      const isSelect = query.trim().toUpperCase().startsWith('SELECT');

      if (isSelect) {
        // Use .all() for SELECT queries to get all results
        const stmt = db.prepare(query);
        const data = stmt.all(...params);

        return {
          success: true,
          data,
          rowCount: data.length,
          metadata: {
            executionTime: Date.now() - startTime,
            dbType: 'sqlite'
          }
        };
      } else {
        // Use .run() for INSERT, UPDATE, DELETE
        const stmt = db.prepare(query);
        const result = stmt.run(...params);

        let data: { insertedId?: number | bigint; modifiedCount?: number | bigint; deletedCount?: number | bigint } = {};
        if (result.lastInsertRowid) {
          data.insertedId = result.lastInsertRowid;
        }
        if (result.changes !== undefined) {
          data.modifiedCount = result.changes;
          data.deletedCount = result.changes; // For DELETE queries
        }

        return {
          success: true,
          data,
          rowCount: (result.changes as number) || 0,
          metadata: {
            executionTime: Date.now() - startTime,
            dbType: 'sqlite'
          }
        };
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const code = isRecord(error) && (typeof error.code === 'string' || typeof error.code === 'number')
        ? error.code
        : undefined;
      return {
        success: false,
        error: err.message,
        code,
        metadata: {
          executionTime: Date.now() - startTime,
          dbType: 'sqlite'
        }
      };
    }
  }

  /**
   * Execute multiple SQL operations in a transaction
   *
   * Wraps operations in BEGIN/COMMIT with automatic ROLLBACK on error.
   * All operations succeed or all fail atomically.
   *
   * @param db - SQLite database instance
   * @param operations - Operations to execute
   * @param startTime - Transaction start timestamp for metadata
   * @returns Transaction results
   * @throws {Error} Rolls back and throws on any operation failure
   */
  async executeTransaction(db: Database, operations: SqlStatement[], startTime: number): Promise<ExecuteResult> {
    try {
      const results: TransactionStatementResult[] = [];
      db.exec('BEGIN TRANSACTION');

      for (const operation of operations) {
        const { query, params = [] } = operation;
        const stmt = db.prepare(query);
        const result = stmt.run(...params);

        results.push({
          query,
          changes: (result.changes as number) || 0,
          lastInsertRowid: result.lastInsertRowid || null
        });
      }

      db.exec('COMMIT');

      return {
        success: true,
        data: results,
        rowCount: results.reduce((sum, r) => sum + r.changes, 0),
        metadata: {
          executionTime: Date.now() - startTime,
          dbType: 'sqlite'
        }
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Close all database connections and clear cache
   *
   * Call on application shutdown to properly close all SQLite databases.
   */
  closeAll(): void {
    for (const [dbName, db] of this.databases) {
      db.close();
    }
    this.databases.clear();
  }
}
