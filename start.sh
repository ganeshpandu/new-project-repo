#!/bin/sh

# Run Prisma migrations twice from /app
cd /app
npx prisma migrate deploy --schema=libs/prisma/schema.prisma

cd /app
npx prisma migrate deploy --schema=libs/prisma/schema.prisma

# Use Docker Compose to bring up the containers
echo "Bringing up the containers using Docker Compose..."
docker-compose up -d

# Start both services in the background (user-service and master-service)
cd /app/user-service
npm run start:dev &

cd /app/masterData-service
npm run start:dev &

# Keep container alive
tail -f /dev/null
