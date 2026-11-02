import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// DATABASE_URL is only required for commands that talk to the database
// (migrate, seed, studio). `prisma generate` works without it.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
