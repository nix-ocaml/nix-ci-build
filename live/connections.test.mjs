import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as sqlite from 'node:sqlite';
import { ConnectionStore } from './connections.mjs';

const Database = sqlite.Database || sqlite.DatabaseSync;
const secret = 'session-secret-only-for-unit-tests-123456';
const installation = { id: 10, account: { id: 500, login: 'our-team', type: 'Organization' }, html_url: 'https://github.com/organizations/our-team/settings/installations/10' };
const repository = { id: 101, full_name: 'our-team/project', private: true };

test('GitHub credentials survive restart encrypted, with session tokens hashed and OAuth state single-use', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nix-ci-connections-'));
  const path = join(directory, 'database.sqlite');
  let db;
  try {
    let time = 1_800_000_000_000;
    db = new Database(path);
    let store = new ConnectionStore(db, { secret, now: () => time });
    const tokens = { accessToken: 'private-access-token-unique', refreshToken: 'private-refresh-token-unique' };
    store.saveUser({ id: 1, login: 'alice' }, tokens);
    const session = store.createSession('1');
    const oauth = store.beginOAuth('/runs/123');
    store.saveConnections('1', [{ installation, repositories: [repository] }]);
    db.close();
    const bytes = readFileSync(path).toString();
    for (const credential of [tokens.accessToken, tokens.refreshToken, session.token, oauth.state, oauth.browser, oauth.verifier]) assert.ok(!bytes.includes(credential), 'Credential must not be present in SQLite plaintext');
    db = new Database(path);
    store = new ConnectionStore(db, { secret, now: () => time });
    assert.deepEqual(store.credentials('1'), tokens);
    assert.equal(store.session(session.token).user.login, 'alice');
    assert.deepEqual([...store.repositoryIds('1')], ['101']);
    assert.equal(store.consumeOAuth(oauth.state, 'different-browser'), null);
    assert.deepEqual(store.consumeOAuth(oauth.state, oauth.browser), { verifier: oauth.verifier, returnTo: '/runs/123' });
    assert.equal(store.consumeOAuth(oauth.state, oauth.browser), null);
    time += 7 * 24 * 3600_000;
    assert.equal(store.session(session.token), null);
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('the same team can expose different private repositories to different users', () => {
  const db = new Database(':memory:');
  try {
    const store = new ConnectionStore(db, { secret });
    store.saveUser({ id: 1, login: 'alice' }, {});
    store.saveUser({ id: 2, login: 'bob' }, {});
    const other = { id: 102, full_name: 'our-team/other', private: true };
    store.saveConnections('1', [{ installation, repositories: [repository] }]);
    store.saveConnections('2', [{ installation, repositories: [other] }]);
    assert.deepEqual([...store.repositoryIds('1')], ['101']);
    assert.deepEqual([...store.repositoryIds('2')], ['102']);
    assert.equal(store.connections('1').connections[0].account.type, 'Organization');
    assert.equal(store.connections('1').connections[0].repositories[0].fullName, 'our-team/project');
    store.invalidateInstallation('10', { removedRepositoryIds: [101] });
    assert.equal(store.repositoryIds('1').size, 0);
    assert.deepEqual([...store.repositoryIds('2')], ['102']);
    store.invalidateInstallation('10', { status: 'suspended' });
    assert.equal(store.repositoryIds('2').size, 0);
    assert.equal(store.connections('2').refreshedAtMs, 0);
    assert.equal(store.connections('2').connections[0].status, 'suspended');
  } finally { db.close(); }
});

test('encrypted credentials are bound to the user and logout revokes only its session', () => {
  const db = new Database(':memory:');
  try {
    const store = new ConnectionStore(db, { secret });
    store.saveUser({ id: 1, login: 'alice' }, { accessToken: 'alice-secret' });
    store.saveUser({ id: 2, login: 'bob' }, { accessToken: 'bob-secret' });
    const first = store.createSession('1'), second = store.createSession('1');
    store.logout(first.token);
    assert.equal(store.session(first.token), null);
    assert.equal(store.session(second.token).user.id, '1');
    const ciphertext = db.prepare('SELECT credentials FROM connection_users WHERE id=?').get('1').credentials;
    db.prepare('UPDATE connection_users SET credentials=? WHERE id=?').run(ciphertext, '2');
    assert.throws(() => store.credentials('2'));
    store.revokeUser('1');
    assert.equal(store.session(second.token), null);
    assert.deepEqual(store.credentials('1'), {});
  } finally { db.close(); }
});

test('a repository transfer cannot carry a prior installation’s user grants to its new owner', () => {
  const db = new Database(':memory:');
  try {
    const store = new ConnectionStore(db, { secret });
    store.saveUser({ id: 1, login: 'alice' }, {});
    store.saveUser({ id: 2, login: 'bob' }, {});
    store.saveConnections('1', [{ installation, repositories: [repository] }]);
    const destination = { id: 20, account: { id: 600, login: 'different-team', type: 'Organization' } };
    store.saveConnections('2', [{ installation: destination, repositories: [{ ...repository, full_name: 'different-team/project' }] }]);
    assert.deepEqual([...store.repositoryIds('1')], []);
    assert.deepEqual([...store.repositoryIds('2')], ['101']);
    assert.equal(store.connections('1').connections[0].repositories.length, 0);
    // Even a stale imported grant must still require membership in the current
    // installation. Repository IDs alone cannot convey workspace membership.
    db.prepare('INSERT INTO connection_user_repositories VALUES (?, ?)').run('1', '101');
    assert.equal(store.repositoryIds('1').size, 0);
  } finally { db.close(); }
});
