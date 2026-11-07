import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Express } from "express";

// Public API reference (docs/PLATFORM_TRACKER.md 2.7): the committed openapi.json (kept in sync
// with the routes by the OpenAPI test and CI) rendered with Scalar. No auth, no secrets: the spec
// only describes the API. Scalar is pinned and loaded from jsDelivr.
const SPEC_PATH = fileURLToPath(new URL("../openapi.json", import.meta.url));
const SCALAR_VERSION = "1.75.0";

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FlexiPay API Reference</title>
</head>
<body>
<script id="api-reference" data-url="/openapi.json"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}"></script>
</body>
</html>`;

export function mountApiDocs(app: Express): void {
	let spec: string | null = null;
	app.get("/openapi.json", (_req, res) => {
		spec ??= readFileSync(SPEC_PATH, "utf8");
		res.setHeader("Cache-Control", "public, max-age=300");
		res.type("application/json").send(spec);
	});
	app.get("/docs", (_req, res) => {
		res.setHeader("Cache-Control", "public, max-age=300");
		res.type("html").send(page);
	});
}
