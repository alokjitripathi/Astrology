import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const { createApplication, initializeDatabase } = require("../backend/server.cjs");

const pool = new Pool({
  ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}),
  max: 1,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 10000
});

let databaseSetup;
function ensureDatabase() {
  if (!databaseSetup) {
    databaseSetup = initializeDatabase(pool).catch((error) => {
      databaseSetup = null;
      throw error;
    });
  }
  return databaseSetup;
}

const application = createApplication(pool, ensureDatabase);

// Vercel Node Functions invoke a request handler; bridge each invocation into
// the shared Node HTTP server so the same application handles every /api path.
export default function handler(request, response) {
  application.emit("request", request, response);
}
