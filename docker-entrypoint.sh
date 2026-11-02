#!/bin/sh
# Applies pending database migrations, then starts the bot.
# Set SKIP_MIGRATIONS=true for extra replicas (e.g. APP_ROLE=worker) to avoid concurrent migrations.
set -e
if [ "${SKIP_MIGRATIONS:-false}" != "true" ]; then
  ./node_modules/.bin/prisma migrate deploy
fi
exec node dist/index.js
