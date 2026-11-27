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

export default createApplication(pool, ensureDatabase);
