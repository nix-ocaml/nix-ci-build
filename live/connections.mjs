import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const userView = row => row && ({ id: row.id, login: row.login, name: row.name, avatarUrl: row.avatar_url });

/** GitHub is the source of workspace membership. This store records only the
 * intersection of an installation's repositories and each user's own access. */
export class ConnectionStore {
  constructor(db, { secret, now = () => Date.now() }) {
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new Error('The session secret must contain at least 32 bytes');
    this.db = db;
    this.now = now;
    this.key = createHash('sha256').update('nix-ci-build/github-credentials/v1\0').update(secret).digest();
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS connection_users (
        id TEXT PRIMARY KEY, login TEXT NOT NULL, name TEXT, avatar_url TEXT,
        credentials TEXT NOT NULL, refreshed_at INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS connection_sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES connection_users(id),
        csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS connection_sessions_user ON connection_sessions(user_id);
      CREATE TABLE IF NOT EXISTS connection_oauth (
        state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, verifier TEXT NOT NULL,
        return_to TEXT NOT NULL, expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS connection_installations (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, login TEXT NOT NULL, type TEXT NOT NULL,
        avatar_url TEXT, html_url TEXT, status TEXT NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS connection_repositories (
        id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES connection_installations(id),
        full_name TEXT NOT NULL, private INTEGER NOT NULL, verified_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS connection_user_installations (
        user_id TEXT NOT NULL REFERENCES connection_users(id),
        installation_id TEXT NOT NULL REFERENCES connection_installations(id),
        PRIMARY KEY(user_id, installation_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS connection_user_repositories (
        user_id TEXT NOT NULL REFERENCES connection_users(id),
        repository_id TEXT NOT NULL REFERENCES connection_repositories(id) ON DELETE CASCADE,
        PRIMARY KEY(user_id, repository_id)
      ) STRICT;
    `);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  encrypt(value, context) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [nonce, cipher.getAuthTag(), data].map(part => part.toString('base64url')).join('.');
  }

  decrypt(value, context) {
    const [nonce, tag, data] = value.split('.').map(part => Buffer.from(part, 'base64url'));
    const cipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'));
  }

  beginOAuth(returnTo) {
    const state = random(), browser = random(), verifier = random();
    this.db.prepare('DELETE FROM connection_oauth WHERE expires_at <= ?').run(this.now());
    this.db.prepare('INSERT INTO connection_oauth VALUES (?, ?, ?, ?, ?)').run(hash(state), hash(browser), this.encrypt(verifier, hash(state)), returnTo, this.now() + 600_000);
    return { state, browser, verifier };
  }

  consumeOAuth(state, browser) {
    if (typeof state !== 'string' || typeof browser !== 'string' || state.length > 256 || browser.length > 256) return null;
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM connection_oauth WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?').get(hash(state), hash(browser), this.now());
      if (!row) return null;
      this.db.prepare('DELETE FROM connection_oauth WHERE state_hash = ?').run(hash(state));
      return { verifier: this.decrypt(row.verifier, hash(state)), returnTo: row.return_to };
    });
  }

  saveUser(user, credentials) {
    const id = String(user.id);
    this.db.prepare(`INSERT INTO connection_users (id, login, name, avatar_url, credentials) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET login=excluded.login, name=excluded.name, avatar_url=excluded.avatar_url, credentials=excluded.credentials, refreshed_at=0`)
      .run(id, user.login, user.name || null, user.avatar_url || null, this.encrypt(credentials, id));
    return userView(this.db.prepare('SELECT * FROM connection_users WHERE id = ?').get(id));
  }

  credentials(userId) {
    const row = this.db.prepare('SELECT credentials FROM connection_users WHERE id = ?').get(String(userId));
    return row ? this.decrypt(row.credentials, String(userId)) : null;
  }

  saveCredentials(userId, credentials) {
    this.db.prepare('UPDATE connection_users SET credentials = ? WHERE id = ?').run(this.encrypt(credentials, String(userId)), String(userId));
  }

  createSession(userId, lifetimeMs = 7 * 24 * 3600_000) {
    const token = random(), csrfToken = random(), expiresAtMs = this.now() + lifetimeMs;
    this.db.prepare('DELETE FROM connection_sessions WHERE expires_at <= ?').run(this.now());
    this.db.prepare('INSERT INTO connection_sessions VALUES (?, ?, ?, ?)').run(hash(token), String(userId), csrfToken, expiresAtMs);
    return { token, ...this.session(token) };
  }

  session(token) {
    if (typeof token !== 'string' || token.length > 256) return null;
    const row = this.db.prepare(`SELECT s.token_hash, s.csrf_token, s.expires_at, u.id, u.login, u.name, u.avatar_url
      FROM connection_sessions s JOIN connection_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(hash(token), this.now());
    return row ? { id: row.token_hash, user: userView(row), csrfToken: row.csrf_token, expiresAtMs: row.expires_at } : null;
  }

  logout(token) { if (typeof token === 'string') this.db.prepare('DELETE FROM connection_sessions WHERE token_hash = ?').run(hash(token)); }
  revokeUser(userId) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM connection_sessions WHERE user_id = ?').run(String(userId));
      this.db.prepare('DELETE FROM connection_user_repositories WHERE user_id = ?').run(String(userId));
      this.db.prepare('UPDATE connection_users SET refreshed_at=0, credentials=? WHERE id=?').run(this.encrypt({}, String(userId)), String(userId));
    });
  }

  upsertInstallation(installation) {
    const account = installation.account;
    const status = installation.suspended_at ? 'suspended' : 'active';
    this.db.prepare(`INSERT INTO connection_installations VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, login=excluded.login, type=excluded.type,
      avatar_url=excluded.avatar_url, html_url=excluded.html_url, status=excluded.status, updated_at=excluded.updated_at`)
      .run(String(installation.id), String(account.id), account.login, account.type, account.avatar_url || null, installation.html_url || null, status, this.now());
  }

  upsertRepository(installationId, repository) {
    // Repository IDs survive transfers. Membership in the old installation is
    // not evidence of access to the new owner's private repository.
    this.db.prepare(`DELETE FROM connection_user_repositories WHERE repository_id=? AND EXISTS
      (SELECT 1 FROM connection_repositories WHERE id=? AND installation_id<>?)`).run(String(repository.id), String(repository.id), String(installationId));
    this.db.prepare(`INSERT INTO connection_repositories VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET installation_id=excluded.installation_id, full_name=excluded.full_name,
      private=excluded.private, verified_at=excluded.verified_at`)
      .run(String(repository.id), String(installationId), repository.full_name.toLowerCase(), repository.private ? 1 : 0, this.now());
  }

  saveConnections(userId, connections) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM connection_user_repositories WHERE user_id = ?').run(String(userId));
      this.db.prepare('DELETE FROM connection_user_installations WHERE user_id = ?').run(String(userId));
      for (const { installation, repositories } of connections) {
        this.upsertInstallation(installation);
        this.db.prepare('INSERT INTO connection_user_installations VALUES (?, ?)').run(String(userId), String(installation.id));
        for (const repository of repositories) {
          this.upsertRepository(installation.id, repository);
          this.db.prepare('INSERT OR IGNORE INTO connection_user_repositories VALUES (?, ?)').run(String(userId), String(repository.id));
        }
      }
      this.db.prepare('UPDATE connection_users SET refreshed_at = ? WHERE id = ?').run(this.now(), String(userId));
    });
  }

  connections(userId) {
    const refreshedAtMs = this.refreshedAt(userId);
    const connections = this.db.prepare(`SELECT i.* FROM connection_installations i JOIN connection_user_installations u
      ON i.id=u.installation_id WHERE u.user_id=? ORDER BY i.login COLLATE NOCASE`).all(String(userId)).map(row => ({
      id: row.id, installationId: row.id, account: { id: row.account_id, login: row.login, type: row.type, avatarUrl: row.avatar_url },
      status: row.status, settingsUrl: row.html_url,
      repositories: row.status !== 'active' ? [] : this.db.prepare(`SELECT r.* FROM connection_repositories r JOIN connection_user_repositories u
        ON r.id=u.repository_id WHERE u.user_id=? AND r.installation_id=? ORDER BY r.full_name`).all(String(userId), row.id).map(repository => ({
          id: repository.id, fullName: repository.full_name, private: Boolean(repository.private),
        })),
    }));
    return { connections, refreshedAtMs };
  }

  refreshedAt(userId) { return this.db.prepare('SELECT refreshed_at FROM connection_users WHERE id = ?').get(String(userId))?.refreshed_at ?? 0; }

  repositoryIds(userId) {
    return new Set(this.db.prepare(`SELECT r.id FROM connection_repositories r JOIN connection_user_repositories u ON u.repository_id=r.id
      JOIN connection_installations i ON i.id=r.installation_id
      JOIN connection_user_installations ui ON ui.installation_id=i.id AND ui.user_id=u.user_id
      WHERE u.user_id=? AND i.status='active'`).all(String(userId)).map(row => row.id));
  }

  repository(id) {
    const row = this.db.prepare(`SELECT r.*, i.status FROM connection_repositories r JOIN connection_installations i ON i.id=r.installation_id WHERE r.id=?`).get(String(id));
    return row && { id: row.id, repository: row.full_name, installationId: row.installation_id, status: row.status, verifiedAtMs: row.verified_at };
  }

  connectedRepositories() {
    return this.db.prepare(`SELECT r.id, r.full_name FROM connection_repositories r
      JOIN connection_installations i ON i.id=r.installation_id WHERE i.status='active' ORDER BY r.id`)
      .all().map(row => ({ repositoryId: row.id, repository: row.full_name }));
  }

  installation(id) { return this.db.prepare('SELECT * FROM connection_installations WHERE id=?').get(String(id)); }

  invalidateInstallation(id, { status, removedRepositoryIds = [], transaction = true } = {}) {
    const update = () => {
      this.db.prepare(`UPDATE connection_users SET refreshed_at=0 WHERE id IN
        (SELECT user_id FROM connection_user_installations WHERE installation_id=?)`).run(String(id));
      if (status) this.db.prepare('UPDATE connection_installations SET status=?, updated_at=? WHERE id=?').run(status, this.now(), String(id));
      if (status === 'deleted' || status === 'suspended') {
        this.db.prepare('DELETE FROM connection_user_repositories WHERE repository_id IN (SELECT id FROM connection_repositories WHERE installation_id=?)').run(String(id));
      }
      for (const repositoryId of removedRepositoryIds) this.db.prepare('DELETE FROM connection_repositories WHERE id=? AND installation_id=?').run(String(repositoryId), String(id));
    };
    return transaction ? this.transaction(update) : update();
  }
}
