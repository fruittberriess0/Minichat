import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script\\b([^>]*)>([\\s\\S]*?)<\\/script>/gi)]
  .filter(match => !/\\bsrc\\s*=/.test(match[1]))
  .map(match => match[2])
  .filter(source => source.trim());

if (!scripts.length) throw new Error("No inline JavaScript found in index.html");
scripts.forEach((source, index) => new vm.Script(source, {filename:"index.html:inline-script-" + (index + 1)}));
console.log("Inline JavaScript syntax OK (" + scripts.length + " script block(s)).");
