// Optional SQLite example: Node.js 22.16+. This is an inbox, not an exactly-once side-effect system.
import { DatabaseSync } from 'node:sqlite';
import { parseExact } from '../runtime.js';
export function openInbox(path) {
  const db = new DatabaseSync(path);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, payload BLOB NOT NULL, known INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0)',
  );
  return db;
}
export function receiveWebhook(client, db, rawBody, headers, secrets, eventId) {
  const verified = client.verifyWebhook(rawBody, headers, secrets);
  // Supply an extractor for the provider's documented globally unique event identity.
  const id = eventId(verified.event);
  if (typeof id !== 'string' || !id) throw new Error('A provider event identity is required');
  // This statement commits durably before the HTTP adapter should acknowledge delivery.
  const result = db
    .prepare('INSERT INTO inbox(id,payload,known) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING')
    .run(id, rawBody, verified.known ? 1 : 0);
  return { queued: Number(result.changes) === 1, known: verified.known };
}
/** Process one known event. Unknown events remain pending for explicit operator review.
 * loadCurrent must fetch authoritative resource state; apply must be synchronous and perform
 * only database writes. Apply provider version checks inside apply when state can race.
 */
export async function processInbox(db, { loadCurrent, apply }) {
  const row = db
    .prepare('SELECT id,payload FROM inbox WHERE processed=0 AND known=1 ORDER BY rowid LIMIT 1')
    .get();
  if (!row) return false;
  const event = parseExact(Buffer.from(row.payload).toString('utf8'));
  const current = await loadCurrent(event);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT processed FROM inbox WHERE id=?').get(row.id).processed) {
      db.exec('COMMIT');
      return false;
    }
    const result = apply(db, event, current);
    if (result && typeof result.then === 'function')
      throw new Error('apply must be synchronous and contain only transactional database writes');
    db.prepare('UPDATE inbox SET processed=1 WHERE id=?').run(row.id);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Call inside apply. Use a stable business-action identity, such as fulfillment:order_123,
 * rather than the event ID: several distinct events can describe the same business action.
 */
export function enqueueEffect(db, identity, payload) {
  if (typeof identity !== 'string' || !identity)
    throw new Error('A stable business-action identity is required');
  return (
    Number(
      db
        .prepare('INSERT INTO outbox(id,payload) VALUES (?,?) ON CONFLICT(id) DO NOTHING')
        .run(identity, JSON.stringify(payload)).changes,
    ) === 1
  );
}

/** The receiver must deduplicate identity under its documented idempotency contract.
 * A crash after send and before UPDATE will resend the SAME identity after restart.
 * Without downstream deduplication, external effects cannot be promised exactly once.
 */
export async function deliverOutbox(db, send) {
  const row = db
    .prepare('SELECT id,payload FROM outbox WHERE delivered=0 ORDER BY rowid LIMIT 1')
    .get();
  if (!row) return false;
  await send(row.id, JSON.parse(row.payload));
  db.prepare('UPDATE outbox SET delivered=1 WHERE id=?').run(row.id);
  return true;
}

// The HTTP adapter must preserve the raw body and pass the signature/timestamp headers unchanged.
// The application owns the database and must call db.close(). Scope the inbox per provider/tenant
// if event IDs are unique only within that scope. Define retention from the provider's replay window.
