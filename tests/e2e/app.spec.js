import { test, expect } from "@playwright/test";

test("login app shell renders without inline JavaScript", async ({page}) => {
  const pageErrors = [];
  page.on("pageerror",error => pageErrors.push(error.message));
  await page.goto("/");
  await expect(page).toHaveTitle(/MiniChat/);
  await expect(page.locator("#loginForm")).toBeVisible();
  await expect(page.locator("#email")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible();
  await expect(page.locator("#loginButton")).toBeVisible();
  await expect(page.locator("#magicLinkButton")).toBeVisible();
  await expect(page.locator("#resetPasswordButton")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("PWA manifest and icon are served", async ({page,request}) => {
  await page.goto("/");
  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest.name).toContain("MiniChat");
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.some(icon => icon.src === "/icons/icon.svg")).toBeTruthy();
  const iconResponse = await request.get("/icons/icon.svg");
  expect(iconResponse.ok()).toBeTruthy();
});

test("mobile login layout fits a phone viewport", async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto("/");
  await expect(page.locator("#loginForm")).toBeVisible();
  const geometry = await page.evaluate(() => ({
    width:document.documentElement.clientWidth,
    scrollWidth:document.documentElement.scrollWidth,
    form:document.querySelector("#loginForm").getBoundingClientRect().width
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
  expect(geometry.form).toBeGreaterThan(250);
});
