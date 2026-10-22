// Local development database. Usage:
//   node scripts/dev-db.ts migrate [name]   create a new migration from schema.prisma
//   node scripts/dev-db.ts serve            apply migrations and run the API against it
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrateDeploy, prisma, startEmbeddedDb } from "../src/dev/embedded-db.ts";

const apiDir = fileURLToPath(new URL("..", import.meta.url));
const [command, arg] = process.argv.slice(2);

const db = await startEmbeddedDb({ dir: `${apiDir}.pgdata`, port: 54329 });
console.log(`Postgres ready at ${db.url}`);

const stop = async () => {
  await db.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

if (command === "migrate") {
  console.log(await prisma(db.url, "migrate", "dev", "--name", arg ?? "update"));
  await db.stop();
} else if (command === "serve") {
  console.log(await migrateDeploy(db.url));
  const api = spawn("node", ["src/main.ts"], {
    cwd: apiDir,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: db.url },
  });
  api.on("exit", () => void stop());
} else {
  console.error("usage: dev-db.ts migrate [name] | serve");
  await db.stop();
  process.exit(1);
}
