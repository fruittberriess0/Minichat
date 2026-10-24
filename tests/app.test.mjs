import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("core auth and messaging controls exist", () => {
  for (const id of ["loginForm","email","password","app","chatItems","messages","messageInput","sendButton"]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
});

test("message history and live status remain wired", () => {
  for (const marker of ["loadOlderMessages","subscribeToMessages","broadcastTyping","MESSAGE_PAGE_SIZE","message-day-divider"]) {
    assert.ok(html.includes(marker), "Missing capability marker: " + marker);
  }
});

test("message editor is not prompt-based", () => {
  assert.ok(!html.includes('const updated = prompt("Измени текст сообщения:"'));
});

test("PWA manifest and service-worker registration are referenced", () => {
  assert.match(html, /manifest\\.webmanifest/);
  assert.match(html, /serviceWorker\\.register/);
});
