// One-off admin script for provisioning a login. There is no signup UI by design (this app
// uses a single shared login, not per-user accounts) - run this locally or on the server once
// per person who needs access.
//
// Usage:
//   DATABASE_URL=... node scripts/create-user.js <username> <password>
//
// No password complexity is enforced here - the user set is small and admin-provisioned.

import { closePool } from '../db/pool.js';
import { insertUser, getUserByUsername } from '../db/users.js';
import { hashPassword } from '../auth.js';
import { randomUUID } from 'node:crypto';

async function main() {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    console.error('Usage: node scripts/create-user.js <username> <password>');
    process.exitCode = 1;
    return;
  }

  const existing = await getUserByUsername(username);
  if (existing) {
    console.error(`A user named "${username}" already exists.`);
    process.exitCode = 1;
    return;
  }

  const user = await insertUser({
    id: `user_${randomUUID()}`,
    username,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString()
  });
  console.log(`Created user "${user.username}" (${user.id})`);
}

main()
  .catch((error) => {
    console.error('Failed to create user:', error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
