import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(match => !/\bsrc\s*=/.test(match[1]))
  .map(match => match[2])
  .filter(source => source.trim());
if (scripts.length) throw new Error("Move inline JavaScript into modules.");
for (const file of ["src/main.js", "src/supabase.js", "public/sw.js", "vite.config.js"]) {
  const result = spawnSync(process.execPath, ["--check", resolve(root, file)], {encoding:"utf8"});
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || ("Syntax check failed: " + file));
    process.exit(result.status || 1);
  }
}
console.log("JavaScript syntax OK.");
