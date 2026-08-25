import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const roots = ["extensions", "scripts", "test"];
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx"]);
const violations = [];

async function scan(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await scan(path);
			continue;
		}
		if (!sourceExtensions.has(entry.name.slice(entry.name.lastIndexOf("."))))
			continue;

		const source = await readFile(path, "utf8");
		const lines = source.split("\n");
		for (const [index, line] of lines.entries()) {
			if (/\bconsole\s*\./.test(line)) violations.push(`${path}:${index + 1}`);
		}
	}
}

for (const root of roots) await scan(root);

if (violations.length > 0) {
	process.stderr.write(
		`console.* usage is not allowed:\n${violations.join("\n")}\n`,
	);
	process.exitCode = 1;
}
