import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixEmbeddedPostgresDylibs } from "../src/dev/fix-embedded-pg-dylibs.ts";

describe("fixEmbeddedPostgresDylibs", () => {
	it("is idempotent and creates ICU compatibility links on darwin-arm64", () => {
		if (process.platform !== "darwin" || process.arch !== "arm64") {
			expect(fixEmbeddedPostgresDylibs()).toEqual({
				libDir: null,
				created: [],
			});
			return;
		}
		const first = fixEmbeddedPostgresDylibs();
		expect(first.libDir).toBeTruthy();
		const libDir = first.libDir!;
		for (const name of [
			"libicudata.77.dylib",
			"libicuuc.77.dylib",
			"libicui18n.dylib",
		]) {
			const path = join(libDir, name);
			expect(existsSync(path), name).toBe(true);
			expect(lstatSync(path).isSymbolicLink(), name).toBe(true);
		}
		// remove one link and repair again
		const probe = join(libDir, "libicui18n.dylib");
		unlinkSync(probe);
		const second = fixEmbeddedPostgresDylibs();
		expect(second.created).toContain("libicui18n.dylib");
		expect(existsSync(probe)).toBe(true);
		// third call creates nothing
		expect(fixEmbeddedPostgresDylibs().created).toEqual([]);
	});
});
