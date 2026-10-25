// Real Postgres for local work and tests, from the embedded-postgres npm package (no system
// install, no Docker). Production uses a managed Postgres; this is the same engine.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import { fixEmbeddedPostgresDylibs } from "./fix-embedded-pg-dylibs.ts";

const run = promisify(execFile);
const apiDir = fileURLToPath(new URL("../..", import.meta.url));

export interface EmbeddedDb {
  url: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/** Starts Postgres. `dir` keeps data between runs; without it the database is temporary. */
export async function startEmbeddedDb(opts: { dir?: string; port?: number; name?: string } = {}): Promise<EmbeddedDb> {
  // darwin-arm64 package omits ICU soname symlinks; repair before initdb (see fix-embedded-pg-dylibs.ts).
  fixEmbeddedPostgresDylibs();
  const temporary = opts.dir === undefined;
  const databaseDir = opts.dir ?? (await mkdtemp(join(tmpdir(), "flexipay-pg-")));
  const port = opts.port ?? (await freePort());
  const name = opts.name ?? "flexipay";
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: "fp",
    password: "fp",
    port,
    persistent: !temporary,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise().catch((err: unknown) => {
    // an existing data directory is fine
    if (!String(err).includes("exists")) throw err;
  });
  await pg.start();
  await pg.createDatabase(name).catch(() => {});
  return {
    url: `postgresql://fp:fp@127.0.0.1:${port}/${name}`,
    async stop() {
      await pg.stop();
      if (temporary) await rmTempDirWithRetry(databaseDir);
    },
  };
}

/** Windows often holds locks briefly after pg.stop(); retry EBUSY/EPERM. */
async function rmTempDirWithRetry(dir: string): Promise<void> {
  const delaysMs = [0, 100, 250, 500, 1000, 2000];
  let last: unknown;
  for (const wait of delaysMs) {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      last = e;
      const code =
        e && typeof e === "object" && "code" in e
          ? String((e as { code: unknown }).code)
          : "";
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw e;
    }
  }
  // Last resort: leave the temp dir; suite already finished. Do not fail tests on cleanup.
  console.warn(
    `embedded-db: could not remove ${dir} after retries: ${
      last instanceof Error ? last.message : String(last)
    }`,
  );
}

/** Runs the Prisma CLI in apps/api against `url`. */
export async function prisma(url: string, ...args: string[]): Promise<string> {
  // Windows: `execFile("npx")` fails with ENOENT (npx is npx.cmd). Invoke the local
  // prisma entry with node instead — same as `npx prisma` in this workspace.
  const prismaJs = join(apiDir, "../../node_modules/prisma/build/index.js");
  const { stdout, stderr } = await run(process.execPath, [prismaJs, ...args], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: url },
  });
  return stdout + stderr;
}

export const migrateDeploy = (url: string) => prisma(url, "migrate", "deploy");
