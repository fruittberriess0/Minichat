const STORAGE_KEY = "minichat-e2ee-shared-passphrase-v1";
const PREFIX = "MCH-E2EE1:";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyCache = new Map();

export function isEncryptedText(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function hasSharedPassphrase() {
  try { return Boolean(sessionStorage.getItem(STORAGE_KEY)); }
  catch { return false; }
}

export function setSharedPassphrase(passphrase) {
  const value = String(passphrase || "");
  if (value.length < 12) throw new Error("Use a shared passphrase with at least 12 characters.");
  sessionStorage.setItem(STORAGE_KEY,value);
  keyCache.clear();
}

export function clearSharedPassphrase() {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
  keyCache.clear();
}

function getPassphrase() {
  try { return sessionStorage.getItem(STORAGE_KEY) || ""; }
  catch { return ""; }
}

async function keyForChat(chatId, passphrase) {
  const cacheKey = String(chatId) + "\u0000" + passphrase;
  if (keyCache.has(cacheKey)) return keyCache.get(cacheKey);
  const promise = (async () => {
    const material = await crypto.subtle.importKey(
      "raw",encoder.encode(passphrase),"PBKDF2",false,["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name:"PBKDF2",
        salt:encoder.encode("MiniChat E2EE v1:" + String(chatId)),
        iterations:310000,
        hash:"SHA-256"
      },
      material,
      {name:"AES-GCM",length:256},
      false,
      ["encrypt","decrypt"]
    );
  })();
  keyCache.set(cacheKey,promise);
  try { return await promise; }
  catch (error) { keyCache.delete(cacheKey); throw error; }
}

function encodeBase64(bytes) {
  let binary = "";
  for (let index=0;index<bytes.length;index+=0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index,Math.min(index+0x8000,bytes.length)));
  }
  return btoa(binary);
}
function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index=0;index<binary.length;index++) bytes[index]=binary.charCodeAt(index);
  return bytes;
}

export async function encryptTextMessage(plainText,chatId) {
  const passphrase = getPassphrase();
  const text = String(plainText ?? "");
  if (!passphrase || isEncryptedText(text)) return text;
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is unavailable. Open MiniChat over HTTPS.");
  const key = await keyForChat(chatId,passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name:"AES-GCM",iv,additionalData:encoder.encode(String(chatId)),tagLength:128
  },key,encoder.encode(text));
  const envelope = new Uint8Array(iv.length+ciphertext.byteLength);
  envelope.set(iv,0);
  envelope.set(new Uint8Array(ciphertext),iv.length);
  return PREFIX + encodeBase64(envelope);
}

export async function decryptTextMessage(value,chatId) {
  if (!isEncryptedText(value)) return value;
  const passphrase = getPassphrase();
  if (!passphrase || !globalThis.crypto?.subtle) return null;
  try {
    const envelope = decodeBase64(value.slice(PREFIX.length));
    if (envelope.length < 29) return null;
    const iv = envelope.slice(0,12);
    const ciphertext = envelope.slice(12);
    const key = await keyForChat(chatId,passphrase);
    const plaintext = await crypto.subtle.decrypt({
      name:"AES-GCM",iv,additionalData:encoder.encode(String(chatId)),tagLength:128
    },key,ciphertext);
    return decoder.decode(plaintext);
  } catch {
    return null;
  }
}
