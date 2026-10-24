import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const source = html + "\n" + app;

test("core auth and messaging controls exist", () => {
  for (const id of ["loginForm","email","password","app","chatItems","messages","messageInput","sendButton"]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
});

test("message history and live status remain wired", () => {
  for (const marker of ["loadOlderMessages","subscribeToMessages","broadcastTyping","MESSAGE_PAGE_SIZE","message-day-divider"]) {
    assert.ok(source.includes(marker), "Missing capability marker: " + marker);
  }
});

test("message editor is not prompt-based", () => {
  assert.ok(!source.includes('const updated = prompt("Измени текст сообщения:"'));
});

test("PWA manifest and service-worker registration are referenced", () => {
  assert.match(html, /manifest\.webmanifest/);
  assert.match(app, /serviceWorker\.register/);
});

test("new features have UI and backend integration hooks", () => {
  for (const marker of ["createChatFromPrompt","saveMessageForLater","deleteSelectedMessages","search_chat_messages","toggleReaction","retryFailedMessage","appendFormattedText"]) {
    assert.ok(source.includes(marker), "Missing feature marker: " + marker);
  }
});
