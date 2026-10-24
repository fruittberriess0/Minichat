import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSharedPassphrase,
  decryptTextMessage,
  encryptTextMessage,
  hasSharedPassphrase,
  isEncryptedText,
  setSharedPassphrase
} from "../../src/security/e2ee.js";

const values = new Map();
const storage = {
  getItem:key => values.has(key) ? values.get(key) : null,
  setItem:(key,value) => values.set(key,String(value)),
  removeItem:key => values.delete(key)
};

beforeEach(() => {
  values.clear();
  Object.defineProperty(globalThis,"sessionStorage",{value:storage,configurable:true});
});
afterEach(() => clearSharedPassphrase());

describe("shared-passphrase message encryption", () => {
  it("does not encrypt if opt-in is off", async () => {
    expect(hasSharedPassphrase()).toBe(false);
    expect(await encryptTextMessage("plain text","chat-uuid")).toBe("plain text");
  });

  it("encrypts and decrypts text with AES-GCM", async () => {
    setSharedPassphrase("a long test passphrase 2026");
    const encrypted = await encryptTextMessage("привет ❤️","chat-uuid");
    expect(isEncryptedText(encrypted)).toBe(true);
    expect(encrypted).not.toContain("привет");
    expect(await decryptTextMessage(encrypted,"chat-uuid")).toBe("привет ❤️");
  });

  it("does not decrypt with the wrong shared key or chat", async () => {
    setSharedPassphrase("first secret passphrase 2026");
    const encrypted = await encryptTextMessage("private words","chat-one");
    setSharedPassphrase("second secret passphrase 2026");
    expect(await decryptTextMessage(encrypted,"chat-one")).toBeNull();
    setSharedPassphrase("first secret passphrase 2026");
    expect(await decryptTextMessage(encrypted,"chat-two")).toBeNull();
  });
});
