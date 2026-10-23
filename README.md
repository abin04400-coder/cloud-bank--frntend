# CloudBank backend only

This package contains the Node.js/Express backend image source. It does **not** include PostgreSQL, a database container, or a Docker Compose file.

## Build the backend image
Run these commands in this folder (where the Dockerfile is):

```powershell
docker build -t cloudbank-backend:latest .
```

The backend expects PostgreSQL to be available separately via `DATABASE_URL`. Without a database, `/health` will return HTTP 503 and banking endpoints will not work. This is expected; the API needs a database for persistent balances and transactions.

## Run the backend container
When your separate PostgreSQL database is ready and reachable from Docker, set `DATABASE_URL` to its connection string. Example only:

```powershell
docker run -d --name cloudbank-backend -p 3000:3000 --env-file .env cloudbank-backend:latest
```

Create your own `.env` from `.env.example`; do not commit it. The example hostname `postgres` is only suitable if you separately create a Docker network and a PostgreSQL container/service with that name. It is not an AWS RDS hostname.

## API notes
- `GET /health`: checks backend database connectivity.
- Banking routes use a temporary `x-demo-customer-id` header for local demo only. This is **not authentication**. Replace it with Cognito JWT verification before deploying to EKS.
- `POST /dev/seed` creates fictional local demo customers and accounts. Disable/remove this endpoint before any shared deployment.
- SQS notification publishing is optional and only activates when `SQS_QUEUE_URL` is configured. AWS credentials should come from an IAM role, not static keys.

`db/schema.sql` is a SQL schema file only; it does not run a database and is not copied into the backend image. Apply it to your separate PostgreSQL database when you create that database.
