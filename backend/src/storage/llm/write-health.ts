import type BetterSqlite3 from 'better-sqlite3'

/** Add the transactional write marker used by both LLM telemetry stores. */
export function createMeterHealthTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE meter_health (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      checked_at TEXT NOT NULL
    );
  `)
}

/** Prove that the database can commit and read back a write before provider admission. */
export function verifyMeterWritable(db: BetterSqlite3.Database, checkedAt: string): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO meter_health (id, checked_at) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET checked_at = excluded.checked_at`,
    ).run(checkedAt)
    const row = db.prepare('SELECT checked_at FROM meter_health WHERE id = 1').get() as
      | { checked_at: string }
      | undefined
    if (row?.checked_at !== checkedAt) {
      throw new Error('LLM meter write-health readback did not match')
    }
  }).immediate()
}
