import { getPool } from './pool.js';

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    createdAt: row.created_at.toISOString()
  };
}

export async function insertUser(user) {
  const { rows } = await getPool().query(
    `INSERT INTO users (id, username, password_hash, created_at)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [user.id, user.username, user.passwordHash, user.createdAt]
  );
  return rowToUser(rows[0]);
}

export async function getUserByUsername(username) {
  const { rows } = await getPool().query('SELECT * FROM users WHERE username = $1', [username]);
  return rowToUser(rows[0]);
}
