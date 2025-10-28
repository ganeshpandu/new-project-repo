#!/bin/sh

# Run Prisma migrations twice from /app
cd /app
npx prisma migrate deploy --schema=libs/prisma/schema.prisma

cd /app
npx prisma migrate deploy --schema=libs/prisma/schema.prisma

# Start both services in background
cd /app/user-service
npm run start:dev &

cd /app/masterData-service
npm run start:dev &

# Keep container alive
tail -f /dev/null
