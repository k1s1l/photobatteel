export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/photobattle_test?schema=public';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

/** Guard against running destructive test setup against a real database. */
export function assertTestDatabase(): void {
  if (!/test/i.test(new URL(TEST_DATABASE_URL).pathname)) {
    throw new Error(`Refusing to run tests: database name in TEST_DATABASE_URL must contain "test"`);
  }
}
