#!/bin/bash
set -e

# Check if STORAGE_DIR is set
if [ -z "$STORAGE_DIR" ]; then
    echo "================================================================"
    echo "⚠️  ⚠️  ⚠️  WARNING: STORAGE_DIR environment variable is not set! ⚠️  ⚠️  ⚠️"
    echo ""
    echo "Not setting this will result in data loss on container restart since"
    echo "the application will not have a persistent storage location."
    echo "It can also result in weird errors in various parts of the application."
    echo ""
    echo "Please run the container with the official docker command at"
    echo "https://docs.anythingllm.com/installation-docker/quickstart"
    echo ""
    echo "⚠️  ⚠️  ⚠️  WARNING: STORAGE_DIR environment variable is not set! ⚠️  ⚠️  ⚠️"
    echo "================================================================"
fi

# Gate both processes before any application/collector effects. Provider identity
# comes from the built artifact, not a runtime variable that could select SQLite.
cd /app/server/
node /app/server/utils/prisma/ready.js
provider=$(node -e 'process.stdout.write(require("/app/server/utils/prisma/artifact.json").provider)')

{
  cd /app/server/ &&
    # Disable Prisma CLI telemetry (https://www.prisma.io/docs/orm/tools/prisma-cli#how-to-opt-out-of-data-collection)
    export CHECKPOINT_DISABLE=1 &&
    if [ "$provider" = "sqlite" ]; then
      npx prisma generate --schema=./prisma/schema.prisma &&
      npx prisma migrate deploy --schema=./prisma/schema.prisma
    elif [ "$provider" != "postgresql" ]; then
      exit 1
    fi &&
    node /app/server/index.js
} &
{ node /app/collector/index.js; } &
wait -n
exit $?
