#!/bin/sh
# Checks required settings, applies pending database migrations, then starts the bot.
# Set SKIP_MIGRATIONS=true for extra replicas (e.g. APP_ROLE=worker) to avoid concurrent migrations.
set -e

missing=""
for name in BOT_TOKEN CHANNEL_ID DATABASE_URL REDIS_URL; do
  eval "value=\${$name:-}"
  [ -z "$value" ] && missing="$missing $name"
done
if [ -n "$missing" ]; then
  echo "ERROR: required environment variables are empty:$missing" >&2
  echo "Railway: open the bot service -> Variables and set them, e.g." >&2
  echo '  DATABASE_URL = ${{Postgres.DATABASE_URL}}   REDIS_URL = ${{Redis.REDIS_URL}}' >&2
  exit 1
fi
case "$DATABASE_URL" in
  *localhost*|*127.0.0.1*)
    if [ -n "${RAILWAY_ENVIRONMENT:-}" ]; then
      echo "ERROR: DATABASE_URL points to localhost. On Railway use \${{Postgres.DATABASE_URL}}." >&2
      exit 1
    fi
    ;;
esac

if [ "${SKIP_MIGRATIONS:-false}" != "true" ]; then
  ./node_modules/.bin/prisma migrate deploy
fi
exec node dist/index.js
