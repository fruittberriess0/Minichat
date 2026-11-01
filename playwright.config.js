import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir:"./tests/e2e",
  fullyParallel:true,
  forbidOnly:Boolean(process.env.CI),
  retries:process.env.CI ? 1 : 0,
  reporter:process.env.CI ? "github" : "list",
  use:{
    serviceWorkers:"block",
    launchOptions:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {},
    baseURL:"http://127.0.0.1:4173",
    trace:"retain-on-failure",
    screenshot:"only-on-failure",
    ...devices["Desktop Chrome"]
  },
  webServer:{
    env:{VITE_SUPABASE_URL:"http://127.0.0.1:54321",VITE_SUPABASE_ANON_KEY:"minichat-test-public-key"},
    command:process.env.PLAYWRIGHT_USE_PREVIEW === "1"
      ? "npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort"
      : "npm run dev -- --host 127.0.0.1 --port 4173 --strictPort",
    url:"http://127.0.0.1:4173",
    reuseExistingServer:false,
    timeout:60000
  }
});
