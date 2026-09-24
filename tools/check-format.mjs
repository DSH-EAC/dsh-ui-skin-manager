#!/usr/bin/env node
import {readdir, readFile} from "node:fs/promises";
import {extname, join, relative} from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const included = new Set([".json", ".md", ".mjs", ".ts", ".yml", ".yaml"]);
const skipped = new Set([".git", ".qoder", "dist", "node_modules"]);
const failures = [];
async function walk(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (skipped.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (included.has(extname(entry.name))) {
      const text = await readFile(path, "utf8");
      if (!text.endsWith("\n")) failures.push(`${relative(root, path)}: missing final newline`);
      text.split("\n").forEach((line, index) => {
        if (/[ \t]+$/.test(line)) failures.push(`${relative(root, path)}:${index + 1}: trailing whitespace`);
      });
      if (extname(entry.name) === ".json") {
        try { JSON.parse(text); } catch (error) { failures.push(`${relative(root, path)}: ${error.message}`); }
      }
    }
  }
}
await walk(root);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("format check passed");
}
