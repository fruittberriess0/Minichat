import { defineConfig, loadEnv } from "vite";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

export default defineConfig(({mode})=>{
  const env={...loadEnv(mode,process.cwd(),"VITE_"),...process.env};
  if(process.env.VERCEL_ENV==="preview" && (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY ||
    env.VITE_SUPABASE_URL.includes("gjqpucsbfuoqoncmdfbj"))) {
    throw new Error("Preview needs a separate development Supabase URL and public key. Production fallback is disabled for previews.");
  }
  return {
    base:"/",
    build:{outDir:"dist",emptyOutDir:true},
    server:{host:"0.0.0.0",port:5173},
    plugins:[{
      name:"minichat-offline-shell",
      async closeBundle() {
        const assets=(await readdir("dist/assets")).map(name=>"/assets/"+name);
        const shell=["/","/index.html","/manifest.webmanifest","/icons/icon.svg","/icons/icon-192.png","/icons/icon-512.png",...assets];
        const html=await readFile("dist/index.html","utf8");
        const version=createHash("sha256").update(html+JSON.stringify(assets)).digest("hex").slice(0,16);
        const template=await readFile("public/sw.js","utf8");
        await writeFile("dist/sw.js",template.replace('"minichat-shell-dev"',JSON.stringify("minichat-shell-"+version))
          .replace('/* PRECACHE */ ["/", "/index.html", "/manifest.webmanifest", "/icons/icon.svg"]',JSON.stringify(shell)));
      }
    }]
  };
});
