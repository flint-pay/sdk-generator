<?php
declare(strict_types=1);
// Optional example: requires ext-pdo_sqlite. Load vendor/autoload.php in your HTTP adapter.
namespace SdkNamespace\Examples;
use SdkNamespace\Client;
use SdkNamespace\Codec;
function openInbox(string $path): \PDO
{
    $db = new \PDO('sqlite:' . $path, options: [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
    $db->exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, payload BLOB NOT NULL, known INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0)',
    );
    return $db;
}
function receiveWebhook(
    Client $client,
    \PDO $db,
    string $rawBody,
    array $headers,
    array $secrets,
    \Closure $eventId,
): array {
    $verified = $client->verifyWebhook($rawBody, $headers, $secrets);
    $id = $eventId($verified['event']);
    if (!is_string($id) || $id === '') {
        throw new \InvalidArgumentException('A provider event identity is required');
    }
    $statement = $db->prepare(
        'INSERT INTO inbox(id,payload,known) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING',
    );
    $statement->execute([$id, $rawBody, $verified['known'] ? 1 : 0]); // Durable commit before acknowledging the HTTP delivery.
    return ['queued' => $statement->rowCount() === 1, 'known' => $verified['known']];
}
/** Fetch current authoritative state before applying transactional database effects.
 * Unknown events remain pending for operator review. Apply must not perform external I/O.
 * If resource state can race, enforce provider version checks inside apply.
 */
function processInbox(\PDO $db, \Closure $loadCurrent, \Closure $apply): bool
{
    $row = $db
        ->query('SELECT id,payload FROM inbox WHERE processed=0 AND known=1 ORDER BY rowid LIMIT 1')
        ->fetch(\PDO::FETCH_ASSOC);
    if (!$row) {
        return false;
    }
    $event = Codec::parse($row['payload']);
    $current = $loadCurrent($event);
    $db->exec('BEGIN IMMEDIATE');
    try {
        $statement = $db->prepare('SELECT processed FROM inbox WHERE id=?');
        $statement->execute([$row['id']]);
        if ((int) $statement->fetchColumn() === 1) {
            $db->exec('COMMIT');
            return false;
        }
        $apply($db, $event, $current);
        $db->prepare('UPDATE inbox SET processed=1 WHERE id=?')->execute([$row['id']]);
        $db->exec('COMMIT');
        return true;
    } catch (\Throwable $error) {
        $db->exec('ROLLBACK');
        throw $error;
    }
}

/** Use a stable business-action identity across different events for the same action. */
function enqueueEffect(\PDO $db, string $identity, mixed $payload): bool
{
    if ($identity === '') {
        throw new \InvalidArgumentException('A stable business-action identity is required');
    }
    $statement = $db->prepare(
        'INSERT INTO outbox(id,payload) VALUES (?,?) ON CONFLICT(id) DO NOTHING',
    );
    $statement->execute([$identity, json_encode($payload, JSON_THROW_ON_ERROR)]);
    return $statement->rowCount() === 1;
}

/** Receiver must deduplicate the stable identity. A crash after send may resend it. */
function deliverOutbox(\PDO $db, \Closure $send): bool
{
    $row = $db
        ->query('SELECT id,payload FROM outbox WHERE delivered=0 ORDER BY rowid LIMIT 1')
        ->fetch(\PDO::FETCH_ASSOC);
    if (!$row) {
        return false;
    }
    $send($row['id'], json_decode($row['payload'], true, 512, JSON_THROW_ON_ERROR));
    $db->prepare('UPDATE outbox SET delivered=1 WHERE id=?')->execute([$row['id']]);
    return true;
}
// The application owns the PDO connection. Scope inboxes and retention to the provider contract.
