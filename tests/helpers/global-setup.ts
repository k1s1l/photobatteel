import { execSync } from 'node:child_process';
import { assertTestDatabase, TEST_DATABASE_URL } from './env.js';

/** Applies migrations to the test database once per run (integration tests only). */
export default function setup(): void {
  if (process.env.SKIP_DB_SETUP === '1') return;
  const onlyUnit = process.argv.some((arg) => arg.includes('tests/unit'));
  if (onlyUnit) return;
  assertTestDatabase();
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL }, stdio: 'pipe' });
}
