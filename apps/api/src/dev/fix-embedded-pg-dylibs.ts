// Repair incomplete soname symlinks in @embedded-postgres/darwin-arm64 (18.4.0-beta.17).
// The package ships versioned ICU dylibs (e.g. libicudata.77.1.dylib) but binaries look up
// compatibility names (libicudata.77.dylib, libicui18n.dylib). Without these links, initdb
// aborts with dyld "Library not loaded". Idempotent; no-op on other platforms or if already fixed.
import { existsSync, lstatSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Compatibility links required on darwin-arm64 for embedded-postgres 18.4.0-beta.17. */
const LINKS: ReadonlyArray<readonly [linkName: string, targetName: string]> = [
	["libicudata.77.dylib", "libicudata.77.1.dylib"],
	["libicuuc.77.dylib", "libicuuc.77.1.dylib"],
	["libicui18n.77.dylib", "libicui18n.77.1.dylib"],
	["libicudata.dylib", "libicudata.77.1.dylib"],
	["libicuuc.dylib", "libicuuc.77.1.dylib"],
	["libicui18n.dylib", "libicui18n.77.1.dylib"],
	["liblz4.1.dylib", "liblz4.1.10.0.dylib"],
	["libz.1.dylib", "libz.1.3.2.dylib"],
	["libzstd.1.dylib", "libzstd.1.5.7.dylib"],
];

export function fixEmbeddedPostgresDylibs(): { libDir: string | null; created: string[] } {
	if (process.platform !== "darwin" || process.arch !== "arm64") {
		return { libDir: null, created: [] };
	}
	let pkgRoot: string;
	try {
		// package.json is not in "exports"; resolve the entry and walk up to the package root.
		pkgRoot = dirname(
			dirname(require.resolve("@embedded-postgres/darwin-arm64")),
		);
	} catch {
		return { libDir: null, created: [] };
	}
	const libDir = join(pkgRoot, "native", "lib");
	if (!existsSync(libDir)) return { libDir: null, created: [] };

	const created: string[] = [];
	for (const [linkName, targetName] of LINKS) {
		const linkPath = join(libDir, linkName);
		const targetPath = join(libDir, targetName);
		if (!existsSync(targetPath)) continue;
		if (existsSync(linkPath)) {
			try {
				const st = lstatSync(linkPath);
				if (st.isSymbolicLink() || st.isFile()) continue;
			} catch {
				/* recreate below */
			}
		}
		try {
			symlinkSync(targetName, linkPath);
			created.push(linkName);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EEXIST") continue;
			throw err;
		}
	}
	return { libDir, created };
}
