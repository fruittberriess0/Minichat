
"use strict";

import { sb, MEDIA_BUCKET } from "./supabase.js";
import * as Sentry from "@sentry/browser";
import { inject as injectVercelAnalytics } from "@vercel/analytics";

const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    dsn:sentryDsn,
    environment:import.meta.env.MODE || "production",
    sendDefaultPii:false,
    tracesSampleRate:0.05
  });
}
if (import.meta.env.PROD) {
  try { injectVercelAnalytics(); }
  catch (error) { console.debug("Vercel Analytics is not enabled:",error?.message || error); }
}
import { escapeHtml, formatTime, initials, appendFormattedText } from "./utils/format.js";
import { initSharedSpace } from "./features/shared-space.js";
const $ = id => document.getElementById(id);
// Set this to the public half of your VAPID key pair after generating it.
const WEB_PUSH_VAPID_PUBLIC_KEY = "";

let currentUser = null;
let currentProfile = null;
let chats = [];
let activeChat = null;
let messages = [];
let chatSummaries = {};
let unreadWhileAway = 0;
let soundEnabled = true;
let currentLanguage = "ru";
let currentChatMuted = false;
let currentExpirySeconds = 0;
let isPasswordRecovery = new URLSearchParams(location.search).get("resetPassword") === "1";
let selectionMode = false;
let selectedMessageIds = new Set();
let editingMessageId = null;
let editingDraft = "";
let mediaRecorder = null;
let recordedChunks = [];
let recordStream = null;
let videoRecorder = null;
let videoChunks = [];
let videoStream = null;
let reactionsByMessage = {};
let mediaViewerIndex = 0;
let galleryOverride = null;
let galleryOverrideChatId = null;
let appLockTimer = null;
const APP_PIN_KEY = "minichat-local-pin-v1";
let deviceSessionTimer = null;
let deviceSessionTouching = false;
const DEVICE_ID_KEY = "minichat-device-id";

let presenceChannel = null;
let onlineUserIds = new Set();
let realtimeReady = false;
let realtimeReadyWaiters = [];
let rtcPeer = null;
let localCallStream = null;
let pendingCallOffer = null;
let currentCallTargetId = null;
let currentCallVideo = false;
let pendingCallCandidates = [];
let callMicMuted = false;
let callCameraMuted = false;
let lastSeenSaveTime = 0;

function formatLastSeen(value) {
  if (!value) return "Давно не был(а) в сети";

  const date = new Date(value);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 90) return "В сети недавно";
  if (seconds < 3600) return `Был(а) в сети ${Math.floor(seconds / 60)} мин. назад`;
  if (seconds < 86400) return `Был(а) в сети ${Math.floor(seconds / 3600)} ч. назад`;

  return "Был(а) в сети " + date.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short"
  });
}

async function updateMyLastSeen(force = false) {
  if (!currentUser) return;

  const now = Date.now();
  if (!force && now - lastSeenSaveTime < 25000) return;
  lastSeenSaveTime = now;

  const { error } = await sb
    .from("profiles")
    .update({ last_seen: new Date().toISOString() })
    .eq("id", currentUser.id);

  if (error) {
    console.warn("Не удалось обновить last_seen:", error.message);
  }
}

function startPresenceUpdates() {
  // Realtime Presence carries the live online state; last_seen is only a low-frequency fallback.
  // Write it once for this session, then when the tab is backgrounded or the user logs out.
  updateMyLastSeen(true);
  document.addEventListener("visibilitychange", handlePresenceVisibility);
}

function handlePresenceVisibility() {
  if (document.visibilityState === "visible") {
    touchDeviceSession();
    if (typeof markMessagesAsRead === "function") markMessagesAsRead();
    armAppLockTimer();
    if (presenceChannel && currentUser) {
      presenceChannel.track({
        user_id: currentUser.id,
        online_at: new Date().toISOString(),
        visible: true
      }).catch(error => console.debug("Presence update skipped:", error?.message || error));
    }
  } else {
    updateMyLastSeen(true);
    if (appLockTimer) clearTimeout(appLockTimer);
    appLockTimer = setTimeout(lockAppIfConfigured, 5 * 60 * 1000);
    if (presenceChannel && currentUser) {
      presenceChannel.track({
        user_id: currentUser.id,
        online_at: new Date().toISOString(),
        visible: false
      }).catch(error => console.debug("Presence update skipped:", error?.message || error));
    }
  }
}

function stopPresenceUpdates() {
  document.removeEventListener("visibilitychange", handlePresenceVisibility);
  if (presenceChannel) {
    sb.removeChannel(presenceChannel);
    presenceChannel = null;
  }
  onlineUserIds = new Set();
}

let realtimeChannel = null;
let noticeTimer = null;
let typingTimer = null;
let lastTypingBroadcastAt = 0;
let replyToMessage = null;
let sending = false;
let loadingMessages = false;
let loadingOlderMessages = false;
let hasMoreMessages = false;
const MESSAGE_PAGE_SIZE = 50;
let lastRenderedChatId = null;
let profilesById = {};
let otherProfile = null;
let messageSearchTerm = "";
const DRAFTS_KEY = "minichat-drafts-v1";
const EMOJIS = ["❤️","🥰","😘","😂","😍","😭","😊","😎","🥹","💕","🔥","👍","👎","👏","🙏","✨","🎉","💋","🤍","🫶","🌹","💖","😴","🤗"];

function getDrafts() {
  try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}"); }
  catch { return {}; }
}
function saveCurrentDraft() {
  if (!activeChat) return;
  const drafts = getDrafts();
  const value = $("messageInput").value;
  if (value) drafts[activeChat.id] = value;
  else delete drafts[activeChat.id];
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch (e) {
    console.warn("Не удалось сохранить черновик:", e);
  }
}
function restoreDraft(chatId) {
  const drafts = getDrafts();
  $("messageInput").value = drafts[chatId] || "";
  $("messageInput").style.height = "42px";
  $("messageInput").style.height = Math.min($("messageInput").scrollHeight, 140) + "px";
}
function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  $("themeButton").textContent = next === "dark" ? "☼" : "☾";
  $("themeButton").title = next === "dark" ? "Включить светлую тему" : "Включить тёмную тему";
  try { localStorage.setItem("minichat-theme", next); } catch {}
}
function initPersonalization() {
  try {
    const accent = localStorage.getItem("minichat-accent");
    const size = localStorage.getItem("minichat-font-size");
    const wallpaper = localStorage.getItem("minichat-wallpaper") || "dots";
    const language = localStorage.getItem("minichat-language") || "ru";
    soundEnabled = localStorage.getItem("minichat-sound") !== "false";
    if (accent && /^#[0-9a-f]{6}$/i.test(accent)) {
      document.documentElement.style.setProperty("--accent", accent);
      if ($("accentColorInput")) $("accentColorInput").value = accent;
    }
    if (size && Number(size) >= 13 && Number(size) <= 19) {
      document.documentElement.style.setProperty("--message-font-size", size + "px");
      if ($("fontSizeRange")) $("fontSizeRange").value = size;
    }
    if ($("wallpaperSelect")) $("wallpaperSelect").value = wallpaper;
    if ($("languageSelect")) $("languageSelect").value = language;
    currentLanguage = language;
    if ($("soundToggle")) $("soundToggle").checked = soundEnabled;
    applyLanguage();
    applyWallpaper(wallpaper);
  } catch (error) { console.debug("Personalization defaults used:", error?.message || error); }
}
function applyWallpaper(value) {
  const box = $("messages");
  if (!box) return;
  box.classList.remove("wallpaper-plain","wallpaper-hearts");
  if (value === "plain") box.classList.add("wallpaper-plain");
  if (value === "hearts") box.classList.add("wallpaper-hearts");
  try { localStorage.setItem("minichat-wallpaper", value); } catch {}
}
function applyLanguage() {
  const english = currentLanguage === "en";
  $("chatSearch").placeholder = english ? "Search chats..." : "Поиск чата...";
  $("messageInput").placeholder = english ? "Write a message..." : "Напиши сообщение...";
  $("profileUsername").placeholder = english ? "Display name" : "Как тебя называть";
  $("profileStatus").placeholder = english ? "Your status" : "Например: всегда на связи ❤️";
  $("enableNotificationsButton").textContent = english ? "Enable notifications" : "Включить уведомления";
  $("themeButton").setAttribute("aria-label", english ? "Toggle theme" : "Переключить тему");
  try { localStorage.setItem("minichat-language", currentLanguage); } catch {}
}
function playMessageSound() {
  if (!soundEnabled || document.visibilityState !== "visible") return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.05, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.12);
    oscillator.connect(gain); gain.connect(context.destination);
    oscillator.start(); oscillator.stop(context.currentTime + 0.12);
    oscillator.onended = () => context.close();
  } catch {}
}
function initializeTheme() {
  let saved = "dark";
  try { saved = localStorage.getItem("minichat-theme") || "dark"; } catch {}
  applyTheme(saved);
}
initializeTheme();
initPersonalization();
$("accentColorInput").addEventListener("input", event => {
  const value = event.target.value;
  if (!/^#[0-9a-f]{6}$/i.test(value)) return;
  document.documentElement.style.setProperty("--accent", value);
  try { localStorage.setItem("minichat-accent", value); } catch {}
});
$("fontSizeRange").addEventListener("input", event => {
  const value = String(Math.min(19, Math.max(13, Number(event.target.value) || 16)));
  document.documentElement.style.setProperty("--message-font-size", value + "px");
  try { localStorage.setItem("minichat-font-size", value); } catch {}
});
$("wallpaperSelect").addEventListener("change", async event => {
  applyWallpaper(event.target.value);
  if (activeChat) {
    try { await saveChatPreferences(); }
    catch (error) { showNotice("Не удалось сохранить обои чата: " + safeError(error), 6000); }
  }
});
$("messageExpirySelect").addEventListener("change", async event => {
  const previous = currentExpirySeconds;
  currentExpirySeconds = Math.max(0, Number(event.target.value) || 0);
  try { await saveChatPreferences(); }
  catch (error) {
    currentExpirySeconds = previous;
    $("messageExpirySelect").value = String(previous);
    showNotice("Срок жизни сообщений требует миграции Supabase: " + safeError(error), 6000);
  }
});
$("languageSelect").addEventListener("change", event => { currentLanguage = event.target.value; applyLanguage(); });
$("soundToggle").addEventListener("change", event => {
  soundEnabled = event.target.checked;
  try { localStorage.setItem("minichat-sound", String(soundEnabled)); } catch {}
});
$("muteChatToggle").addEventListener("change", async event => {
  if (!activeChat || !currentUser) { event.target.checked = false; showNotice("Сначала открой чат."); return; }
  const previous = currentChatMuted;
  currentChatMuted = event.target.checked;
  try {
    await saveChatPreferences();
    showNotice(event.target.checked ? "Уведомления этого чата выключены." : "Уведомления этого чата включены.");
  } catch (error) {
    currentChatMuted = previous;
    event.target.checked = previous;
    showNotice("Настройки чата требуют миграции Supabase: " + (error?.message || "ошибка"), 6000);
  }
});
function decodeVapidPublicKey(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}
$("enableNotificationsButton").addEventListener("click", async () => {
  if (!currentUser) { showNotice("Сначала войди в MiniChat."); return; }
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    showNotice("Этот браузер не поддерживает Web Push.");
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { showNotice("Разрешение на уведомления не выдано."); return; }
    if (!WEB_PUSH_VAPID_PUBLIC_KEY) {
      showNotice("Разрешение выдано. Для push при закрытом сайте добавь VAPID public key в src/main.js и настрой Edge Function.");
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly:true,
        applicationServerKey:decodeVapidPublicKey(WEB_PUSH_VAPID_PUBLIC_KEY)
      });
    }
    const {error} = await sb.from("push_subscriptions").upsert({
      user_id:currentUser.id,
      endpoint:subscription.endpoint,
      subscription:subscription.toJSON(),
      updated_at:new Date().toISOString()
    }, {onConflict:"endpoint"});
    if (error) throw error;
    showNotice("Push-уведомления настроены на этом устройстве ❤️");
  } catch (error) {
    showNotice("Не удалось включить push. Проверь миграцию Supabase и VAPID-ключи: " + safeError(error), 7000);
  }
});
$("themeButton").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
});
function initializeEmojiPicker() {
  const picker = $("emojiPicker");
  EMOJIS.forEach(emoji => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-btn";
    button.style.cssText = "width:36px;height:36px;font-size:20px";
    button.textContent = emoji;
    button.setAttribute("aria-label", "Вставить " + emoji);
    button.addEventListener("click", () => {
      const input = $("messageInput");
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      input.value = input.value.slice(0,start) + emoji + input.value.slice(end);
      input.focus();
      input.selectionStart = input.selectionEnd = start + emoji.length;
      input.dispatchEvent(new Event("input", {bubbles:true}));
      saveCurrentDraft();
    });
    picker.appendChild(button);
  });
}
initializeEmojiPicker();
$("emojiButton").addEventListener("click", () => $("emojiPicker").classList.toggle("hidden"));
function wrapComposerSelection(delimiter) {
  const input = $("messageInput");
  const value = input.value;
  const start = input.selectionStart ?? value.length;
  const end = input.selectionEnd ?? value.length;
  const selected = value.slice(start,end) || (currentLanguage === "en" ? "text" : "текст");
  input.setRangeText(delimiter + selected + delimiter,start,end,"select");
  input.focus();
  saveCurrentDraft();
}
$("formatToggleButton").addEventListener("click",() => $("formatToolbar").classList.toggle("hidden"));
$("boldTextButton").addEventListener("click",() => wrapComposerSelection("**"));
$("italicTextButton").addEventListener("click",() => wrapComposerSelection("*"));
$("codeTextButton").addEventListener("click",() => wrapComposerSelection("`"));
$("messageSearchToggle").addEventListener("click", () => {
  $("messageSearchBar").classList.toggle("hidden");
  if ($("messageSearchBar").classList.contains("hidden")) {
    $("messageSearchInput").value = "";
    messageSearchTerm = "";
    $("messageSearchCount").textContent = "";
    renderMessages();
  } else {
    $("messageSearchInput").focus();
  }
});
$("messageSearchInput").addEventListener("input", () => {
  messageSearchTerm = $("messageSearchInput").value.trim().toLocaleLowerCase("ru");
  renderMessages();
});
$("exportChatButton").addEventListener("click", exportCurrentChat);
function exportCurrentChat() {
  if (!activeChat) { showNotice("Сначала открой переписку."); return; }
  const lines = messages.map(message => {
    const date = new Date(message.created_at).toLocaleString("ru-RU");
    const name = profilesById[message.sender_id]?.username ||
      (message.sender_id === currentUser?.id ? currentProfile?.username : "Собеседник") ||
      (message.sender_id === currentUser?.id ? "Я" : "Собеседник");
    const body = message.content || (message.file_name ? "[Файл: " + message.file_name + "]" : "[Вложение]");
    return "[" + date + "] " + name + ": " + body;
  });
  const blob = new Blob(["MiniChat — " + chatTitle(activeChat) + "\n\n" + lines.join("\n")], {type:"text/plain;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "minichat-" + (chatTitle(activeChat).replace(/[^a-z0-9а-я_-]+/gi,"-").slice(0,50) || "chat") + ".txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showNotice("Экспорт переписки подготовлен.");
}

async function loadMembers() {
  profilesById = {};
  otherProfile = null;
  if (!activeChat) return;
  try {
    const {data: members} = await sb.from("chat_members").select("user_id").eq("chat_id", activeChat.id);
    const ids = (members || []).map(m => m.user_id);
    if (!ids.length) return;
    const {data: profs} = await sb.from("profiles").select("*").in("id", ids);
    (profs || []).forEach(p => profilesById[p.id] = p);
    if (!activeChat.is_group) {
      otherProfile = (profs || []).find(p => p.id !== currentUser.id) || null;
    }
  } catch (e) {
    console.warn("Не удалось загрузить участников:", e);
  }
  updateHeaderStatus();
}

function updateHeaderStatus() {
  if (!activeChat) return;
  if (otherProfile) {
    $("headerTitle").textContent = activeChat.title || otherProfile.username || chatTitle(activeChat);
    $("headerStatus").textContent = onlineUserIds.has(otherProfile.id)
      ? "В сети"
      : formatLastSeen(otherProfile.last_seen);
    setAvatarElement($("headerAvatar"), otherProfile, otherProfile.username);
  }
}
setInterval(() => { if (otherProfile && activeChat) loadMembers(); }, 60000);

function showNotice(message, duration = 3500) {
  const el = $("notice");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.add("hidden"), duration);
}

function setLoginStatus(message, isError = false) {
  $("loginStatus").textContent = message || "";
  $("loginStatus").style.color = isError ? "var(--danger)" : "var(--muted)";
}

/* Бакет приватный: файлы открываются по временным подписанным ссылкам */
const urlCache = new Map();
function cachedUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const hit = urlCache.get(path);
  return hit && hit.exp > Date.now() ? hit.url : "";
}
async function ensureUrl(path) {
  const cached = cachedUrl(path);
  if (cached) return cached;
  const {data, error} = await sb.storage.from(MEDIA_BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) {
    console.warn("Не удалось получить ссылку на файл:", error?.message);
    return "";
  }
  urlCache.set(path, {url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000});
  return data.signedUrl;
}

function avatarMarkup(profile, fallbackName) {
  const url = cachedUrl(profile?.avatar_path || profile?.avatar_url);
  return url
    ? `<img src="${escapeHtml(url)}" alt="" referrerpolicy="no-referrer">`
    : escapeHtml(initials(profile?.username || fallbackName));
}

function setAvatarElement(el, profile, fallbackName) {
  const path = profile?.avatar_path || profile?.avatar_url;
  el.innerHTML = avatarMarkup(profile, fallbackName);
  if (path && !cachedUrl(path)) {
    ensureUrl(path).then(() => {
      if (cachedUrl(path)) el.innerHTML = avatarMarkup(profile, fallbackName);
    });
  }
}

function setLoggedIn(isLoggedIn) {
  $("loginScreen").classList.toggle("hidden", isLoggedIn);
  $("app").classList.toggle("hidden", !isLoggedIn);
}
function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}
function fromBase64(value) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}
async function hashAppPin(pin, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:120000,hash:"SHA-256"},key,256);
  return new Uint8Array(bits);
}
async function setOrRemoveAppPin() {
  let current = null;
  try { current = JSON.parse(localStorage.getItem(APP_PIN_KEY) || "null"); } catch {}
  if (current && confirm("Удалить существующий PIN-код?")) {
    localStorage.removeItem(APP_PIN_KEY);
    if (appLockTimer) clearTimeout(appLockTimer);
    showNotice("Локальная блокировка PIN удалена.");
    return;
  }
  const first = prompt("Создай PIN из 4–12 цифр:");
  if (first === null) return;
  if (!/^\d{4,12}$/.test(first)) { showNotice("PIN должен содержать от 4 до 12 цифр."); return; }
  const second = prompt("Повтори PIN:");
  if (first !== second) { showNotice("PIN-коды не совпадают."); return; }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashAppPin(first, salt);
  localStorage.setItem(APP_PIN_KEY, JSON.stringify({salt:toBase64(salt),hash:toBase64(hash)}));
  armAppLockTimer();
  showNotice("PIN настроен. Приложение будет блокироваться после 5 минут в фоне.");
}
async function unlockApp() {
  const raw = localStorage.getItem(APP_PIN_KEY);
  if (!raw) { $("appLockScreen").classList.add("hidden"); setLoggedIn(true); return; }
  try {
    const saved = JSON.parse(raw);
    const candidate = await hashAppPin($("appPinInput").value, fromBase64(saved.salt));
    const expected = fromBase64(saved.hash);
    let diff = candidate.length ^ expected.length;
    for (let i=0;i<Math.min(candidate.length,expected.length);i++) diff |= candidate[i] ^ expected[i];
    if (diff !== 0) {
      $("appLockStatus").textContent = "Неверный PIN.";
      $("appPinInput").value = "";
      return;
    }
    $("appLockStatus").textContent = "";
    $("appPinInput").value = "";
    $("appLockScreen").classList.add("hidden");
    setLoggedIn(true);
    armAppLockTimer();
  } catch (error) {
    $("appLockStatus").textContent = "Не удалось проверить PIN.";
  }
}
function lockAppIfConfigured() {
  if (!localStorage.getItem(APP_PIN_KEY) || !currentUser) return;
  $("app").classList.add("hidden");
  $("loginScreen").classList.add("hidden");
  $("appLockScreen").classList.remove("hidden");
  $("appPinInput").focus();
}
function armAppLockTimer() {
  if (appLockTimer) clearTimeout(appLockTimer);
  if (!localStorage.getItem(APP_PIN_KEY)) return;
  appLockTimer = setTimeout(lockAppIfConfigured, 5 * 60 * 1000);
}
$("setPinButton").addEventListener("click", setOrRemoveAppPin);
$("unlockAppButton").addEventListener("click", unlockApp);
$("appPinInput").addEventListener("keydown", event => {
  if (event.key === "Enter") unlockApp();
});

function setMobileChatMode(inChat) {
  $("app").classList.toggle("mobile-chat", Boolean(inChat));
}

function safeError(error) {
  console.error(error);
  return error?.message || "Произошла неизвестная ошибка.";
}

/* Вход и регистрация */
$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
  const button = $("loginButton");
  button.disabled = true;
  setLoginStatus("Выполняется вход...");

  try {
    if (isPasswordRecovery) {
      const {error} = await sb.auth.updateUser({password});
      if (error) throw error;
      isPasswordRecovery = false;
      setLoginStatus("Пароль изменён. Теперь можно войти.");
      try { history.replaceState({}, "", location.pathname); } catch {}
      return;
    }
    const { data, error } = await sb.auth.signInWithPassword({email, password});
    if (error) throw error;
    if (data.user) await initializeUser(data.user);
  } catch (error) {
    setLoginStatus(safeError(error), true);
  } finally {
    button.disabled = false;
  }
});

$("magicLinkButton").addEventListener("click", async () => {
  const email = $("email").value.trim();
  if (!email) { setLoginStatus("Сначала введи email.", true); $("email").focus(); return; }
  try {
    const {error} = await sb.auth.signInWithOtp({email, options:{emailRedirectTo:location.origin}});
    if (error) throw error;
    setLoginStatus("Ссылка для входа отправлена на email.");
  } catch (error) { setLoginStatus(safeError(error), true); }
});
$("resetPasswordButton").addEventListener("click", async () => {
  const email = $("email").value.trim();
  if (!email) { setLoginStatus("Введи email, чтобы отправить ссылку сброса.", true); $("email").focus(); return; }
  try {
    const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo:location.origin + "/?resetPassword=1"});
    if (error) throw error;
    setLoginStatus("Если адрес зарегистрирован, ссылка для сброса пароля отправлена.");
  } catch (error) { setLoginStatus(safeError(error), true); }
});
async function startOAuth(provider) {
  try {
    const {error} = await sb.auth.signInWithOAuth({provider, options:{redirectTo:location.origin}});
    if (error) throw error;
  } catch (error) {
    setLoginStatus("Проверь, включён ли " + provider + " в Supabase Auth: " + safeError(error), true);
  }
}
$("googleLoginButton").addEventListener("click", () => startOAuth("google"));
$("appleLoginButton").addEventListener("click", () => startOAuth("apple"));

$("registerButton").addEventListener("click", async () => {
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) {
    setLoginStatus("Введи email и пароль для регистрации.", true);
    return;
  }
  if (password.length < 6) {
    setLoginStatus("Пароль должен содержать не менее 6 символов.", true);
    return;
  }

  const button = $("registerButton");
  button.disabled = true;
  setLoginStatus("Создаём аккаунт...");

  try {
    const {data, error} = await sb.auth.signUp({email, password});
    if (error) throw error;

    if (data.session && data.user) {
      await initializeUser(data.user);
    } else {
      setLoginStatus("Аккаунт создан. Если включено подтверждение email, подтверди почту, затем войди.");
    }
  } catch (error) {
    setLoginStatus(safeError(error), true);
  } finally {
    button.disabled = false;
  }
});

async function initializeUser(user) {
  currentUser = user;
  startPresenceUpdates();
  setLoggedIn(true);
  $("loginStatus").textContent = "";

  try {
    await loadProfile();
    await loadChats();
    startDeviceSessionTracking();
    sb.rpc("purge_expired_messages").then(({error}) => {
      if (error) console.debug("Expiry cleanup is unavailable before the messaging migration:", error.message);
    });
    lockAppIfConfigured();
  } catch (error) {
    showNotice("Не удалось загрузить данные: " + safeError(error), 6000);
  }
}

async function restoreSession() {
  try {
    const {data, error} = await sb.auth.getSession();
    if (error) throw error;
    if (data.session?.user) {
      await initializeUser(data.session.user);
    } else {
      setLoggedIn(false);
    }
  } catch (error) {
    console.error("Session restore:", error);
    setLoggedIn(false);
  }
}

sb.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") {
    isPasswordRecovery = true;
    $("loginButton").textContent = "Сохранить новый пароль";
    setLoginStatus("Введи новый пароль и нажми «Сохранить новый пароль».");
    setLoggedIn(false);
  }
  if (event === "SIGNED_OUT") {
    currentUser = null;
    currentProfile = null;
    chats = [];
    activeChat = null;
    messages = [];
    removeRealtime();
    stopPresenceUpdates();
    stopDeviceSessionTracking();
    setLoggedIn(false);
  }
});

async function logout() {
  await updateMyLastSeen(true);
  const {error} = await sb.auth.signOut();
  if (error) showNotice("Не удалось выйти: " + safeError(error));
  else {
    setLoggedIn(false);
    setMobileChatMode(false);
  }
}
$("logoutButton").addEventListener("click", logout);
function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return id;
    if (crypto.randomUUID) id = crypto.randomUUID();
    else {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map(value=>value.toString(16).padStart(2,"0")).join("");
      id = hex.slice(0,8)+"-"+hex.slice(8,12)+"-"+hex.slice(12,16)+"-"+hex.slice(16,20)+"-"+hex.slice(20);
    }
    localStorage.setItem(DEVICE_ID_KEY,id);
    return id;
  } catch {
    return null;
  }
}
function getDeviceLabel() {
  const ua = navigator.userAgent || "Browser";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" :
    /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" :
    /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "device";
  return browser + " · " + os;
}
async function touchDeviceSession() {
  if (!currentUser || deviceSessionTouching) return;
  const deviceId = getDeviceId();
  if (!deviceId) return;
  deviceSessionTouching = true;
  try {
    const {data,error} = await sb.rpc("touch_device_session",{
      p_device_id:deviceId,
      p_device_label:getDeviceLabel()
    });
    if (error) {
      console.debug("Device tracking requires migration 005:",error.message);
      return;
    }
    if (data === false) {
      localStorage.removeItem(DEVICE_ID_KEY);
      stopDeviceSessionTracking();
      showNotice("Эта сессия была завершена с другого устройства.");
      await sb.auth.signOut({scope:"local"});
    }
  } catch (error) {
    console.debug("Device session heartbeat unavailable:",error?.message || error);
  } finally {
    deviceSessionTouching = false;
  }
}
function startDeviceSessionTracking() {
  stopDeviceSessionTracking();
  touchDeviceSession();
  deviceSessionTimer = setInterval(touchDeviceSession,120000);
}
function stopDeviceSessionTracking() {
  if (deviceSessionTimer) clearInterval(deviceSessionTimer);
  deviceSessionTimer = null;
}
async function loadDeviceSessions() {
  const list = $("deviceSessionsList");
  const status = $("deviceSessionsStatus");
  list.replaceChildren();
  status.textContent = "Загружаем устройства…";
  try {
    const id = getDeviceId();
    const {data,error} = await sb.rpc("list_user_devices",{p_current_device_id:id});
    if (error) throw error;
    const devices = data || [];
    status.textContent = devices.length ? "Устройств: " + devices.length : "Активные устройства пока не зарегистрированы.";
    devices.forEach(device => {
      const row = document.createElement("article");
      row.className = "device-session-item";
      const copy = document.createElement("div");
      copy.className = "device-session-copy";
      const name = document.createElement("div");
      name.className = "device-session-name";
      name.textContent = device.device_label || "Browser";
      const time = document.createElement("div");
      time.className = "device-session-time";
      time.textContent = "Последняя активность: " + formatLastSeen(device.last_seen);
      copy.append(name,time);
      if (device.is_current) {
        const current = document.createElement("div");
        current.className = "device-session-current";
        current.textContent = "Это устройство";
        copy.appendChild(current);
      }
      row.appendChild(copy);
      if (!device.is_current) {
        const revoke = document.createElement("button");
        revoke.type = "button";
        revoke.className = "btn secondary small-btn";
        revoke.textContent = "Завершить";
        revoke.addEventListener("click",async () => {
          if (!confirm("Завершить сессию устройства «" + (device.device_label || "Browser") + "»? Оно выйдет при следующей проверке.")) return;
          revoke.disabled = true;
          try {
            const {data,error} = await sb.rpc("revoke_user_device",{
              p_device_id:device.device_id,p_current_device_id:getDeviceId()
            });
            if (error) throw error;
            if (!data) throw new Error("Сессия уже завершена или не найдена.");
            await loadDeviceSessions();
          } catch (error) {
            status.textContent = "Не удалось завершить сессию: " + safeError(error);
            revoke.disabled = false;
          }
        });
        row.appendChild(revoke);
      }
      list.appendChild(row);
    });
  } catch (error) {
    status.textContent = "Для списка устройств нужна миграция 202610240005_device_sessions.sql: " + safeError(error);
  }
}
$("viewSessionsButton").addEventListener("click",async () => {
  $("profilePanel").classList.add("hidden");
  $("deviceSessionsPanel").classList.remove("hidden");
  await loadDeviceSessions();
});
$("deviceSessionsClose").addEventListener("click",() => $("deviceSessionsPanel").classList.add("hidden"));
$("deviceSessionsPanel").addEventListener("click",event => {
  if (event.target === $("deviceSessionsPanel")) $("deviceSessionsPanel").classList.add("hidden");
});

$("signOutAllButton").addEventListener("click", async () => {
  if (!confirm("Выйти из MiniChat на всех устройствах?")) return;
  const {error} = await sb.auth.signOut({scope:"global"});
  if (error) showNotice("Не удалось завершить все сессии: " + safeError(error), 6000);
  else showNotice("Все сессии завершены.");
});

/* Профиль пользователя */
async function loadProfile() {
  if (!currentUser) return;

  const {data, error} = await sb.from("profiles")
    .select("*")
    .eq("id", currentUser.id)
    .maybeSingle();

  if (error) throw error;

  currentProfile = data || {
    id: currentUser.id,
    username: currentUser.email?.split("@")[0] || "Пользователь",
    status_text: ""
  };

  updateProfileUI();
}

function updateProfileUI() {
  const name = currentProfile?.username || currentUser?.email || "Пользователь";
  $("miniName").textContent = name;
  $("miniStatus").textContent = currentProfile?.status_text || "Нажми, чтобы настроить профиль";
  setAvatarElement($("miniAvatar"), currentProfile, name);
  $("profileUsername").value = currentProfile?.username || "";
  $("profileStatus").value = currentProfile?.status_text || "";
  const avatarPath = currentProfile?.avatar_path || currentProfile?.avatar_url;
  const applyAvatar = () => {
    const url = cachedUrl(avatarPath);
    $("profileAvatar").src = url || "";
    $("profileAvatar").style.visibility = url ? "visible" : "hidden";
  };
  applyAvatar();
  if (avatarPath && !cachedUrl(avatarPath)) ensureUrl(avatarPath).then(applyAvatar);
}

function openProfile() {
  $("profilePanel").classList.remove("hidden");
}
function closeProfile() {
  $("profilePanel").classList.add("hidden");
}
$("profileOpen").addEventListener("click", openProfile);
$("profileOpen").addEventListener("keydown", e => {
  if (e.key === "Enter" || e.key === " ") openProfile();
});
$("profileButton").addEventListener("click", openProfile);
$("profileCloseButton").addEventListener("click", closeProfile);
$("profileCancelButton").addEventListener("click", closeProfile);

$("profileSaveButton").addEventListener("click", async () => {
  if (!currentUser) return;

  const username = $("profileUsername").value.trim() || "Пользователь";
  const status_text = $("profileStatus").value.trim();
  const button = $("profileSaveButton");
  button.disabled = true;

  try {
    const row = {
      id: currentUser.id,
      username,
      status_text
    };

    const {data, error} = await sb.from("profiles")
      .upsert(row, {onConflict:"id"})
      .select()
      .single();

    if (error) throw error;
    currentProfile = {...currentProfile, ...data};
    updateProfileUI();
    renderChatList();
    closeProfile();
    showNotice("Профиль сохранён ❤️");
  } catch (error) {
    showNotice("Не удалось сохранить профиль: " + safeError(error), 6000);
  } finally {
    button.disabled = false;
  }
});

$("avatarInput").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file || !currentUser) return;
  if (!file.type.startsWith("image/")) {
    showNotice("Выбери изображение.");
    event.target.value = "";
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    showNotice("Размер аватара должен быть не больше 8 МБ.");
    event.target.value = "";
    return;
  }

  showNotice("Загружаем аватар...");
  try {
    const ext = (file.name.split(".").pop() || "jpg").replace(/[^a-zA-Z0-9]/g, "");
    const path = `${currentUser.id}/avatar/${Date.now()}.${ext}`;
    const {error: uploadError} = await sb.storage.from(MEDIA_BUCKET)
      .upload(path, file, {upsert:false, contentType:file.type});
    if (uploadError) throw uploadError;

    const row = {
      id: currentUser.id,
      username: currentProfile?.username || currentUser.email?.split("@")[0] || "Пользователь",
      status_text: currentProfile?.status_text || "",
      avatar_path: path
    };

    const {data, error} = await sb.from("profiles")
      .upsert(row, {onConflict:"id"})
      .select()
      .single();
    if (error) throw error;

    currentProfile = {...currentProfile, ...data};
    updateProfileUI();
    renderChatList();
    showNotice("Аватар обновлён ❤️");
  } catch (error) {
    showNotice("Не удалось загрузить аватар: " + safeError(error), 6000);
  } finally {
    event.target.value = "";
  }
});

/* Список чатов */
async function loadChats() {
  if (!currentUser) return;

  const {data: memberships, error: memberError} = await sb.from("chat_members")
    .select("chat_id")
    .eq("user_id", currentUser.id);

  if (memberError) throw memberError;

  const ids = [...new Set((memberships || []).map(row => row.chat_id).filter(Boolean))];
  if (!ids.length) {
    chats = [];
    renderChatList();
    showNotice("Чатов пока нет. Проверь, добавлен ли твой аккаунт в chat_members.");
    return;
  }

  const {data: chatRows, error: chatError} = await sb.from("chats")
    .select("*")
    .in("id", ids)
    .order("created_at", {ascending:false});

  if (chatError) throw chatError;

  chats = chatRows || [];
  await loadChatSummaries();
  renderChatList();
}

async function loadChatSummaries() {
  if (!currentUser || !chats.length) {
    chatSummaries = {};
    updateUnreadTitle();
    return;
  }
  try {
    const {data,error} = await sb.rpc("get_chat_summaries");
    if (!error && Array.isArray(data)) {
      const next = {};
      (data || []).forEach(row => {
        const latest = row.latest_id ? {
          id:row.latest_id,chat_id:row.chat_id,sender_id:row.latest_sender_id,
          content:row.latest_content,created_at:row.latest_created_at,
          message_type:row.latest_message_type,file_name:row.latest_file_name
        } : null;
        next[row.chat_id] = {latest,unread:row.chat_id === activeChat?.id ? 0 : Number(row.unread_count || 0)};
      });
      chatSummaries = next;
      chats.sort((a,b) => {
        const ta = new Date(chatSummaries[a.id]?.latest?.created_at || a.created_at || 0).getTime();
        const tb = new Date(chatSummaries[b.id]?.latest?.created_at || b.created_at || 0).getTime();
        return tb - ta;
      });
      updateUnreadTitle();
      return;
    }
    if (error) console.debug("Summary RPC unavailable; using fallback:", error.message);
  } catch (error) {
    console.debug("Summary RPC unavailable; using fallback:", error?.message || error);
  }
  const next = {};
  await Promise.all(chats.map(async chat => {
    try {
      const latestResult = await sb.from("messages")
        .select("*")
        .eq("chat_id", chat.id)
        .is("deleted_at", null)
        .order("created_at", {ascending:false})
        .limit(1);
      if (latestResult.error) throw latestResult.error;
      const latest = latestResult.data?.[0] || null;
      let unread = 0;
      if (chat.id !== activeChat?.id) {
        const unreadResult = await sb.from("messages")
          .select("id", {count:"exact", head:true})
          .eq("chat_id", chat.id)
          .neq("sender_id", currentUser.id)
          .is("read_at", null)
          .is("deleted_at", null);
        if (!unreadResult.error) unread = unreadResult.count || 0;
      }
      next[chat.id] = {latest, unread};
    } catch (error) {
      console.warn("Не удалось обновить превью чата:", error?.message || error);
      next[chat.id] = chatSummaries[chat.id] || {latest:null, unread:0};
    }
  }));
  chatSummaries = next;
  chats.sort((a,b) => {
    const ta = new Date(chatSummaries[a.id]?.latest?.created_at || a.created_at || 0).getTime();
    const tb = new Date(chatSummaries[b.id]?.latest?.created_at || b.created_at || 0).getTime();
    return tb - ta;
  });
  updateUnreadTitle();
}

function updateUnreadTitle() {
  const count = Object.values(chatSummaries).reduce((sum, value) => sum + (value?.unread || 0), 0);
  document.title = (count ? "(" + (count > 99 ? "99+" : count) + ") " : "") + "MiniChat ❤️";
}

function summaryPreview(message) {
  if (!message) return "Пока нет сообщений";
  if (message.deleted_at) return "Сообщение удалено";
  if (message.content) return (message.sender_id === currentUser?.id ? "Вы: " : "") + message.content;
  if (message.message_type === "image" || message.image_url) return "📷 Фото";
  if (message.message_type === "audio") return "🎤 Голосовое сообщение";
  if (message.message_type === "video") return "🎬 Видео";
  if (message.file_url || message.media_path) return "📎 Вложение";
  return "Сообщение";
}

function chatTitle(chat) {
  return chat.title || (chat.is_group ? "Групповой чат" : "Личный чат ❤️");
}

function renderChatList() {
  const container = $("chatItems");
  const search = ($("chatSearch").value || "").toLowerCase().trim();
  container.innerHTML = "";

  const filtered = chats.filter(chat => chatTitle(chat).toLowerCase().includes(search));
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty-chat";
    empty.textContent = chats.length ? "Ничего не найдено." : "Пока нет доступных чатов.";
    container.appendChild(empty);
    return;
  }

  filtered.forEach(chat => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chat-item" + (activeChat?.id === chat.id ? " active" : "");

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = chat.is_group ? "👥" : "♥";

    const copy = document.createElement("div");
    copy.className = "chat-item-copy";

    const title = document.createElement("div");
    title.className = "chat-item-title";
    title.textContent = chatTitle(chat);

    const summary = chatSummaries[chat.id] || {latest:null, unread:0};
    const preview = document.createElement("div");
    preview.className = "chat-item-preview";
    preview.textContent = summaryPreview(summary.latest);

    const side = document.createElement("div");
    side.className = "chat-item-side";
    const time = document.createElement("div");
    time.className = "chat-item-time";
    time.textContent = summary.latest ? formatTime(summary.latest.created_at) : "";
    const unread = document.createElement("span");
    unread.className = "chat-unread" + (summary.unread ? "" : " hidden");
    unread.textContent = summary.unread > 99 ? "99+" : String(summary.unread);
    unread.setAttribute("aria-label", summary.unread + " непрочитанных сообщений");
    side.append(time, unread);

    copy.append(title, preview);
    button.append(avatar, copy, side);
    button.addEventListener("click", () => openChat(chat));
    container.appendChild(button);
  });
}

$("chatSearch").addEventListener("input", renderChatList);
$("refreshButton").addEventListener("click", async () => {
  try {
    await loadChats();
    showNotice("Список чатов обновлён.");
  } catch (error) {
    showNotice("Ошибка обновления: " + safeError(error));
  }
});

/* Открытие чата и сообщения */
async function loadChatPreference(chatId) {
  currentChatMuted = false;
  currentExpirySeconds = 0;
  $("muteChatToggle").checked = false;
  $("messageExpirySelect").value = "0";
  if (!currentUser || !chatId) return;
  try {
    const {data, error} = await sb.from("chat_preferences").select("muted,wallpaper,message_expiry_seconds")
      .eq("user_id",currentUser.id).eq("chat_id",chatId).maybeSingle();
    if (error) throw error;
    currentChatMuted = Boolean(data?.muted);
    $("muteChatToggle").checked = currentChatMuted;
    if (data?.wallpaper) {
      $("wallpaperSelect").value = data.wallpaper;
      applyWallpaper(data.wallpaper);
    }
    currentExpirySeconds = Math.max(0, Number(data?.message_expiry_seconds) || 0);
    $("messageExpirySelect").value = String(currentExpirySeconds);
  } catch (error) {
    console.debug("Per-chat settings need the optional migration:", error?.message || error);
  }
}

async function saveChatPreferences() {
  if (!currentUser || !activeChat) return;
  const row = {
    user_id:currentUser.id, chat_id:activeChat.id, muted:currentChatMuted,
    wallpaper:$("wallpaperSelect").value || "dots",
    message_expiry_seconds:Math.max(0, Number($("messageExpirySelect").value) || 0),
    updated_at:new Date().toISOString()
  };
  const {error} = await sb.from("chat_preferences").upsert(row,{onConflict:"user_id,chat_id"});
  if (error) throw error;
}

async function openChat(chat) {
  activeChat = chat;
  galleryOverride = null;
  galleryOverrideChatId = null;
  replyToMessage = null;
  $("replyBar").classList.add("hidden");
  $("welcome").classList.add("hidden");
  $("conversation").classList.remove("hidden");
  $("profilePanel").classList.add("hidden");
  $("headerTitle").textContent = chatTitle(chat);
  $("headerStatus").textContent = chat.is_group ? "Групповой чат" : "Личная переписка";
  $("groupManageButton").classList.toggle("hidden", !chat.is_group);
  $("headerAvatar").textContent = chat.is_group ? "👥" : "♥";
  $("messages").innerHTML = '<div class="empty-chat">Загружаем сообщения...</div>';
  setMobileChatMode(true);
  restoreDraft(chat.id);
  $("emojiPicker").classList.add("hidden");
  messageSearchTerm = "";
  $("messageSearchInput").value = "";
  $("messageSearchCount").textContent = "";
  $("messageSearchBar").classList.add("hidden");
  renderChatList();
  await Promise.all([loadMembers(), loadMessages()]);
  await loadChatPreference(chat.id);
  await markMessagesAsRead();
  if (chatSummaries[chat.id]) chatSummaries[chat.id].unread = 0;
  renderChatList();
  subscribeToMessages();
  updateScrollButton();
  $("messageInput").focus();
}

async function loadMessages() {
  if (!activeChat || loadingMessages) return;
  loadingMessages = true;
  const chatId = activeChat.id;

  try {
    const {data, error} = await sb.from("messages")
      .select("*")
      .eq("chat_id", chatId)
      .is("deleted_at", null)
      .order("created_at", {ascending:false})
      .limit(MESSAGE_PAGE_SIZE + 1);

    if (error) throw error;
    if (activeChat?.id !== chatId) return;
    const newestFirst = data || [];
    hasMoreMessages = newestFirst.length > MESSAGE_PAGE_SIZE;
    messages = newestFirst.slice(0, MESSAGE_PAGE_SIZE).reverse();
    lastRenderedChatId = chatId;
    renderMessages();
    forceScrollDown();
    await refreshReactions();
  } catch (error) {
    $("messages").innerHTML = '<div class="empty-chat">Не удалось загрузить сообщения.<br>' +
      escapeHtml(safeError(error)) + '</div>';
  } finally {
    loadingMessages = false;
  }
}

async function loadOlderMessages() {
  if (!activeChat || loadingOlderMessages || !hasMoreMessages || !messages.length) return;
  loadingOlderMessages = true;
  const chatId = activeChat.id;
  const firstMessage = messages[0];
  const container = $("messages");
  const oldHeight = container.scrollHeight;
  const oldTop = container.scrollTop;
  try {
    const {data, error} = await sb.from("messages")
      .select("*")
      .eq("chat_id", chatId)
      .is("deleted_at", null)
      .lt("created_at", firstMessage.created_at)
      .order("created_at", {ascending:false})
      .limit(MESSAGE_PAGE_SIZE + 1);
    if (error) throw error;
    if (activeChat?.id !== chatId) return;
    const newestFirst = data || [];
    hasMoreMessages = newestFirst.length > MESSAGE_PAGE_SIZE;
    const older = newestFirst.slice(0, MESSAGE_PAGE_SIZE).reverse();
    if (!older.length) { hasMoreMessages = false; return; }
    const known = new Set(messages.map(message => message.id));
    messages = [...older.filter(message => !known.has(message.id)), ...messages];
    renderMessages();
    container.scrollTop = oldTop + (container.scrollHeight - oldHeight);
  } catch (error) {
    showNotice("Не удалось загрузить старые сообщения: " + safeError(error), 5000);
  } finally {
    loadingOlderMessages = false;
  }
}
$("messages").addEventListener("scroll", () => {
  if ($("messages").scrollTop < 70) loadOlderMessages();
});
async function togglePinMessage(message) {
  if (!currentUser || !activeChat || !message) return;

  const nextPinned = !message.is_pinned;

  const { error } = await sb.rpc("set_message_pinned", { p_msg: message.id, p_pinned: nextPinned });

  if (error) {
    console.error("Ошибка закрепления:", error.message);
    showNotice("Не удалось изменить закрепление");
    return;
  }

  message.is_pinned = nextPinned;
  renderMessages();
  showNotice(nextPinned ? "Сообщение закреплено 📌" : "Сообщение откреплено");
}
async function markMessagesAsRead() {
  if (!currentUser || !activeChat) return;

  const { error } = await sb.rpc("mark_chat_read", { p_chat: activeChat.id });

  if (error) {
    console.warn("Не удалось отметить сообщения прочитанными:", error.message);
  }
}

function renderMessages() {
  const container = $("messages");
  updatePinnedBanner();
  updateSelectionControls();
  const shouldScroll = container.scrollHeight - container.scrollTop - container.clientHeight < 140;
  container.innerHTML = "";

  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-chat";
    empty.textContent = "Это начало вашей переписки ❤️";
    container.appendChild(empty);
    return;
  }

  const unexpiredMessages = messages.filter(message => !message.expires_at || new Date(message.expires_at).getTime() > Date.now());
  const visibleMessages = messageSearchTerm
    ? unexpiredMessages.filter(message => {
        const author = profilesById[message.sender_id]?.username || "";
        const text = [message.content, message.file_name, author].join(" ").toLocaleLowerCase("ru");
        return text.includes(messageSearchTerm);
      })
    : unexpiredMessages;
  if (messageSearchTerm) {
    $("messageSearchCount").textContent = visibleMessages.length
      ? "Найдено сообщений: " + visibleMessages.length
      : "Ничего не найдено";
  }
  if (!visibleMessages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-chat";
    empty.textContent = messageSearchTerm ? "По запросу ничего не найдено." : "Это начало вашей переписки ❤️";
    container.appendChild(empty);
    return;
  }

  let previousDayKey = "";
  visibleMessages.forEach(message => {
    const messageDate = new Date(message.created_at);
    const dayKey = messageDate.getFullYear() + "-" + messageDate.getMonth() + "-" + messageDate.getDate();
    if (dayKey !== previousDayKey) {
      previousDayKey = dayKey;
      const today = new Date();
      const yesterday = new Date();
      yesterday.setDate(today.getDate() - 1);
      const sameDay = (a,b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
      const label = sameDay(messageDate, today) ? "Сегодня" :
        sameDay(messageDate, yesterday) ? "Вчера" :
        messageDate.toLocaleDateString("ru-RU", {day:"numeric",month:"long",year:messageDate.getFullYear() === today.getFullYear() ? undefined : "numeric"});
      const divider = document.createElement("div");
      divider.className = "message-day-divider";
      divider.style.cssText = "display:flex;justify-content:center;position:sticky;top:8px;z-index:2;margin:12px 0;pointer-events:none";
      const pill = document.createElement("span");
      pill.textContent = label;
      pill.style.cssText = "font-size:11px;padding:5px 11px;border:1px solid var(--line);border-radius:99px;background:var(--panel);color:var(--muted);box-shadow:0 2px 8px #0001";
      divider.appendChild(pill);
      container.appendChild(divider);
    }
    const own = message.sender_id === currentUser?.id;
    const row = document.createElement("div");
    row.className = "message-row " + (own ? "own" : "other");
    row.dataset.messageId = String(message.id);
    if (selectionMode && own && !message.__pending && !message.__failed) {
      const select = document.createElement("input");
      select.type = "checkbox";
      select.className = "message-select-checkbox";
      select.checked = selectedMessageIds.has(message.id);
      select.setAttribute("aria-label", "Выбрать сообщение");
      select.addEventListener("change", () => {
        if (select.checked) selectedMessageIds.add(message.id);
        else selectedMessageIds.delete(message.id);
        row.classList.toggle("selected", select.checked);
        updateSelectionControls();
      });
      row.appendChild(select);
      row.classList.toggle("selected", select.checked);
    }

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";

    if (!own) {
      const author = document.createElement("div");
      author.className = "message-author";
      author.textContent = profilesById[message.sender_id]?.username || "Собеседник";
      bubble.appendChild(author);
    }

    if (message.content) {
      if (own && editingMessageId === message.id) {
        const editor = document.createElement("textarea");
        editor.className = "field";
        editor.value = editingDraft;
        editor.rows = 3;
        editor.maxLength = 10000;
        editor.style.cssText = "display:block;width:100%;min-width:220px;resize:vertical;margin:5px 0";
        editor.setAttribute("aria-label", "Редактирование сообщения");
        editor.addEventListener("input", () => editingDraft = editor.value);
        editor.addEventListener("keydown", event => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            saveInlineEdit(message);
          }
          if (event.key === "Escape") {
            editingMessageId = null;
            editingDraft = "";
            renderMessages();
          }
        });
        const editorActions = document.createElement("div");
        editorActions.style.cssText = "display:flex;gap:6px;margin-top:6px";
        const saveEdit = document.createElement("button");
        saveEdit.type = "button";
        saveEdit.className = "btn small-btn";
        saveEdit.textContent = "Сохранить";
        saveEdit.addEventListener("click", () => saveInlineEdit(message));
        const cancelEdit = document.createElement("button");
        cancelEdit.type = "button";
        cancelEdit.className = "btn secondary small-btn";
        cancelEdit.textContent = "Отмена";
        cancelEdit.addEventListener("click", () => {
          editingMessageId = null;
          editingDraft = "";
          renderMessages();
        });
        editorActions.append(saveEdit, cancelEdit);
        bubble.append(editor, editorActions);
        queueMicrotask(() => editor.focus());
      } else {
        const text = document.createElement("div");
        text.className = "message-text";
        appendFormattedText(text, message.content);
        bubble.appendChild(text);
      }
    }

    const mediaPath = message.media_path || "";
    if (mediaPath) {
      const openMedia = async () => {
        const u = await ensureUrl(mediaPath);
        if (u) window.open(u, "_blank", "noopener");
        else showNotice("Не удалось открыть файл.");
      };
      if (message.message_type === "image" || (message.mime_type || "").startsWith("image/")) {
        const image = document.createElement("img");
        image.className = "message-image";
        image.alt = message.file_name || "Изображение";
        image.loading = "lazy";
        const first = cachedUrl(mediaPath);
        if (first) image.src = first;
        else ensureUrl(mediaPath).then(u => { if (u) image.src = u; });
        image.style.cursor = "zoom-in";
        image.addEventListener("click", () => {
          const imageMessages = galleryMessages();
          const index = imageMessages.findIndex(item => item.id === message.id);
          showMediaViewer(Math.max(0, index));
        });
        bubble.appendChild(image);
      } else if ((message.mime_type || "").startsWith("audio/")) {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.preload = "metadata";
        audio.style.cssText = "display:block;width:min(280px,100%);margin-top:8px";
        audio.setAttribute("aria-label", message.file_name || "Аудиосообщение");
        const first = cachedUrl(mediaPath);
        if (first) audio.src = first;
        else ensureUrl(mediaPath).then(u => { if (u) audio.src = u; });
        bubble.appendChild(audio);
        const speed = document.createElement("button");
        speed.type = "button";
        speed.className = "btn secondary small-btn";
        speed.style.cssText = "margin-top:6px;padding:3px 8px";
        speed.textContent = "1×";
        speed.setAttribute("aria-label", "Скорость воспроизведения");
        speed.addEventListener("click", () => {
          audio.playbackRate = audio.playbackRate === 1 ? 1.5 : 1;
          speed.textContent = audio.playbackRate === 1 ? "1×" : "1.5×";
        });
        bubble.appendChild(speed);
        const caption = document.createElement("div");
        caption.className = "small muted";
        caption.style.marginTop = "5px";
        caption.textContent = message.file_name || "Аудио";
        bubble.appendChild(caption);
      } else if ((message.mime_type || "").startsWith("video/")) {
        const video = document.createElement("video");
        video.controls = true;
        video.preload = "metadata";
        video.playsInline = true;
        video.className = message.message_type === "video_note" ? "message-video-note" : "message-image";
        video.style.maxHeight = message.message_type === "video_note" ? "260px" : "360px";
        video.setAttribute("aria-label", message.file_name || "Видеосообщение");
        const first = cachedUrl(mediaPath);
        if (first) video.src = first;
        else ensureUrl(mediaPath).then(u => { if (u) video.src = u; });
        bubble.appendChild(video);
        const caption = document.createElement("div");
        caption.className = "small muted";
        caption.style.marginTop = "5px";
        caption.textContent = message.file_name || "Видео";
        bubble.appendChild(caption);
      } else {
        const link = document.createElement("a");
        link.className = "message-attachment";
        link.href = "#";
        link.textContent = "📎 " + (message.file_name || "Открыть файл");
        link.addEventListener("click", e => { e.preventDefault(); openMedia(); });
        bubble.appendChild(link);
      }
    }

    if (message.reply_to_id) {
      const replied = messages.find(item => item.id === message.reply_to_id);
      if (replied) {
        const reply = document.createElement("div");
        reply.style.cssText = "border-left:2px solid #9ef2e1;padding-left:8px;margin-bottom:8px;font-size:11px;color:#c0d8d8";
        reply.textContent = "↪ " + (replied.content || replied.file_name || "Сообщение");
        reply.style.cursor = "pointer";
        reply.title = "Перейти к исходному сообщению";
        reply.addEventListener("click", () => jumpToMessage(replied.id));
        bubble.insertBefore(reply, bubble.firstChild);
      }
    }

    const footer = document.createElement("div");
    footer.className = "message-footer";

    if (message.is_pinned) {
      const pin = document.createElement("span");
      pin.textContent = "📌";
      footer.appendChild(pin);
    }

    if (message.edited_at) {
      const edited = document.createElement("span");
      edited.textContent = "изменено";
      footer.appendChild(edited);
    }

    const time = document.createElement("span");
    time.textContent = formatTime(message.created_at);
    footer.appendChild(time);

    if (own && message.__pending) {
      const sendingLabel = document.createElement("span");
      sendingLabel.textContent = "Отправляется…";
      sendingLabel.title = "Сообщение ещё отправляется";
      footer.appendChild(sendingLabel);
    } else if (own && message.__failed) {
      const failedLabel = document.createElement("span");
      failedLabel.textContent = "Не отправлено";
      failedLabel.title = message.__error || "Ошибка отправки";
      failedLabel.style.color = "var(--danger)";
      footer.appendChild(failedLabel);
    } else if (own && message.read_at) {
      const read = document.createElement("span");
      read.textContent = "✓✓";
      read.title = "Прочитано";
      footer.appendChild(read);
    } else if (own && message.id && !String(message.id).startsWith("local-")) {
      const sent = document.createElement("span");
      sent.textContent = "✓";
      sent.title = "Отправлено";
      footer.appendChild(sent);
    }
    bubble.appendChild(footer);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:5px;justify-content:flex-end;margin-top:5px";

    if (own && message.__failed) {
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "icon-btn";
      retryBtn.style.cssText = "width:28px;height:26px;font-size:12px;color:var(--danger)";
      retryBtn.title = "Повторить отправку";
      retryBtn.textContent = "↻";
      retryBtn.addEventListener("click", () => retryFailedMessage(message));
      actions.appendChild(retryBtn);
    }

    if (!message.__pending && !message.__failed) {
    ["❤️","👍","😂"].forEach(reaction => {
      const reactBtn = document.createElement("button");
      reactBtn.type = "button";
      reactBtn.className = "icon-btn";
      reactBtn.style.cssText = "width:28px;height:26px;font-size:12px";
      const state = reactionsByMessage[message.id] || {counts:{},mine:[]};
      reactBtn.textContent = reaction + (state.counts[reaction] ? String(state.counts[reaction]) : "");
      reactBtn.title = "Реакция " + reaction;
      if (state.mine.includes(reaction)) reactBtn.style.background = "var(--accent)";
      reactBtn.addEventListener("click", () => toggleReaction(message, reaction));
      actions.appendChild(reactBtn);
    });
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "icon-btn";
    saveBtn.style.cssText = "width:28px;height:26px;font-size:12px";
    saveBtn.title = "Сохранить сообщение";
    saveBtn.textContent = "☆";
    saveBtn.addEventListener("click", () => saveMessageForLater(message));
    actions.appendChild(saveBtn);

    const forwardBtn = document.createElement("button");
    forwardBtn.type = "button";
    forwardBtn.className = "icon-btn";
    forwardBtn.style.cssText = "width:28px;height:26px;font-size:12px";
    forwardBtn.title = "Переслать";
    forwardBtn.textContent = "↗";
    forwardBtn.addEventListener("click", () => forwardMessage(message));
    actions.appendChild(forwardBtn);

    const replyBtn = document.createElement("button");
    replyBtn.type = "button";
    replyBtn.className = "icon-btn";
    replyBtn.style.cssText = "width:28px;height:26px;font-size:13px";
    replyBtn.title = "Ответить";
    replyBtn.textContent = "↩";
    replyBtn.addEventListener("click", () => setReply(message));
        actions.appendChild(replyBtn);

    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = "icon-btn";
    pinBtn.style.cssText = "width:28px;height:26px;font-size:12px";
    pinBtn.title = message.is_pinned ? "Открепить сообщение" : "Закрепить сообщение";
    pinBtn.textContent = message.is_pinned ? "📍" : "📌";
    pinBtn.addEventListener("click", () => togglePinMessage(message));
    actions.appendChild(pinBtn);

    if (own) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "icon-btn";
      editBtn.style.cssText = "width:28px;height:26px;font-size:12px";
      editBtn.title = "Редактировать";
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", () => editMessage(message));
      actions.appendChild(editBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "icon-btn";
      deleteBtn.style.cssText = "width:28px;height:26px;font-size:12px;color:var(--danger)";
      deleteBtn.title = "Удалить";
      deleteBtn.textContent = "×";
      deleteBtn.addEventListener("click", () => deleteMessage(message));
      actions.appendChild(deleteBtn);
    }


    }
    bubble.appendChild(actions);
    row.appendChild(bubble);
    container.appendChild(row);
  });

  if (shouldScroll) {
    container.scrollTop = container.scrollHeight;
    unreadWhileAway = 0;
  }
  updateScrollButton();
}

function addOrUpdateMessage(msg) {
  if (!msg || msg.chat_id !== activeChat?.id) return;
  const idx = messages.findIndex(m => m.id === msg.id);
  if (msg.deleted_at) {
    if (idx >= 0) messages.splice(idx, 1);
  } else if (idx >= 0) {
    messages[idx] = {...messages[idx], ...msg};
  } else {
    messages.push(msg);
    messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }
  renderMessages();
}

async function refreshReactions() {
  const ids = messages.filter(m => m.id && !String(m.id).startsWith("local-")).map(m => m.id);
  if (!ids.length) { reactionsByMessage = {}; return; }
  try {
    const {data, error} = await sb.from("message_reactions").select("id,message_id,user_id,reaction").in("message_id", ids);
    if (error) throw error;
    const next = {};
    (data || []).forEach(row => {
      if (!next[row.message_id]) next[row.message_id] = {counts:{},mine:[]};
      next[row.message_id].counts[row.reaction] = (next[row.message_id].counts[row.reaction] || 0) + 1;
      if (row.user_id === currentUser?.id) next[row.message_id].mine.push(row.reaction);
    });
    reactionsByMessage = next;
    renderMessages();
  } catch (error) {
    console.debug("Reactions need the optional Supabase migration:", error?.message || error);
  }
}

async function toggleReaction(message, reaction) {
  if (!message?.id || String(message.id).startsWith("local-")) return;
  try {
    const {data: existing, error: findError} = await sb.from("message_reactions")
      .select("id").eq("message_id", message.id).eq("user_id", currentUser.id).eq("reaction", reaction).maybeSingle();
    if (findError) throw findError;
    if (existing) {
      const {error} = await sb.from("message_reactions").delete().eq("id", existing.id).eq("user_id", currentUser.id);
      if (error) throw error;
    } else {
      const {error} = await sb.from("message_reactions").insert({message_id:message.id,user_id:currentUser.id,reaction});
      if (error) throw error;
    }
    await refreshReactions();
  } catch (error) {
    showNotice("Реакции заработают после применения миграции Supabase: " + (error?.message || "ошибка"), 6000);
  }
}

async function forwardMessage(message) {
  if (!currentUser || !message || chats.length < 2) {
    showNotice("Для пересылки нужен другой доступный чат.");
    return;
  }
  const targets = chats.filter(chat => chat.id !== activeChat?.id);
  const promptText = targets.map((chat,index) => (index + 1) + ". " + chatTitle(chat)).join("\n");
  const choice = prompt("Куда переслать? Введи номер чата:\n" + promptText, "1");
  if (choice === null) return;
  const target = targets[Number(choice) - 1];
  if (!target) { showNotice("Номер чата не найден."); return; }
  try {
    const row = {
      chat_id:target.id,
      sender_id:currentUser.id,
      content:message.content || (message.file_name ? "Пересланный файл: " + message.file_name : "Пересланное сообщение"),
      message_type:"text"
    };
    const {error} = await sb.from("messages").insert(row);
    if (error) throw error;
    showNotice("Сообщение переслано ❤️");
    await loadChatSummaries();
    renderChatList();
  } catch (error) {
    showNotice("Не удалось переслать: " + safeError(error), 6000);
  }
}

function forceScrollDown() {
  const c = $("messages");
  c.scrollTop = c.scrollHeight;
  unreadWhileAway = 0;
  updateScrollButton();
}

function jumpToMessage(messageId) {
  const target = [...document.querySelectorAll("#messages .message-row")]
    .find(el => el.dataset.messageId === String(messageId));
  if (!target) {
    showNotice("Это сообщение не загружено. Прокрути историю выше и попробуй снова.");
    return;
  }
  target.scrollIntoView({behavior:"smooth", block:"center"});
  target.classList.add("message-highlight");
  setTimeout(() => target.classList.remove("message-highlight"), 1800);
}

function updateScrollButton() {
  const c = $("messages");
  const button = $("scrollToBottomButton");
  if (!c || !button) return;
  const distance = c.scrollHeight - c.scrollTop - c.clientHeight;
  const away = distance > 180;
  button.classList.toggle("hidden", !activeChat || !away);
  const badge = $("scrollUnreadCount");
  badge.textContent = unreadWhileAway > 99 ? "99+" : String(unreadWhileAway);
  badge.classList.toggle("hidden", unreadWhileAway < 1);
}

$("scrollToBottomButton").addEventListener("click", () => {
  $("messages").scrollTo({top:$("messages").scrollHeight, behavior:"smooth"});
  unreadWhileAway = 0;
  updateScrollButton();
});

$("messages").addEventListener("scroll", () => {
  updateScrollButton();
  if ($("messages").scrollTop < 100) loadOlderMessages();
});

function setReply(message) {
  replyToMessage = message;
  $("replyPreview").textContent = message.content || message.file_name || "Вложение";
  $("replyBar").classList.remove("hidden");
  $("messageInput").focus();
}
$("cancelReplyButton").addEventListener("click", () => {
  replyToMessage = null;
  $("replyBar").classList.add("hidden");
});

async function persistPendingMessage(pending) {
  if (!pending || !pending.__payload || !currentUser) return false;
  pending.__pending = true;
  pending.__failed = false;
  pending.__error = "";
  renderMessages();
  try {
    const {data: inserted, error} = await sb.from("messages").insert(pending.__payload).select().single();
    if (error) throw error;
    messages = messages.filter(item => item.id !== pending.id);
    if (activeChat?.id === pending.chat_id) addOrUpdateMessage(inserted);
    loadChatSummaries().then(renderChatList).catch(error => console.debug("Chat summary refresh skipped:", error?.message || error));
    return true;
  } catch (error) {
    pending.__pending = false;
    pending.__failed = true;
    pending.__error = safeError(error);
    renderMessages();
    showNotice("Не удалось отправить сообщение. Нажми ↻ рядом с ним, чтобы повторить.", 6000);
    return false;
  }
}

async function retryFailedMessage(message) {
  if (!message?.__failed || sending) return;
  sending = true;
  await persistPendingMessage(message);
  sending = false;
}

async function sendMessage() {
  if (!currentUser || !activeChat || sending) return;
  const input = $("messageInput");
  const content = input.value.trim();
  if (!content) return;

  const chatIdAtSend = activeChat.id;
  const row = {
    chat_id: chatIdAtSend,
    sender_id: currentUser.id,
    content,
    message_type: "text",
    reply_to_id: replyToMessage?.id || null,
    ...(currentExpirySeconds ? {expires_at:new Date(Date.now() + currentExpirySeconds * 1000).toISOString()} : {})
  };
  const pending = {
    id:"local-" + Date.now() + "-" + Math.floor(Math.random() * 1000000),
    chat_id:chatIdAtSend,
    sender_id:currentUser.id,
    content,
    message_type:"text",
    reply_to_id:row.reply_to_id,
    ...(row.expires_at ? {expires_at:row.expires_at} : {}),
    created_at:new Date().toISOString(),
    __pending:true,
    __payload:row
  };

  messages.push(pending);
  renderMessages();
  forceScrollDown();
  input.value = "";
  saveCurrentDraft();
  input.style.height = "42px";
  replyToMessage = null;
  $("replyBar").classList.add("hidden");
  sending = true;
  $("sendButton").disabled = true;
  await persistPendingMessage(pending);
  sending = false;
  $("sendButton").disabled = false;
  if (activeChat?.id === chatIdAtSend) input.focus();
}
$("sendButton").addEventListener("click", sendMessage);

$("messageInput").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
document.addEventListener("keydown", event => {
  const target = event.target;
  const typing = target && (target.matches("input,textarea") || target.isContentEditable);
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (!$("app").classList.contains("hidden")) {
      if (activeChat) {
        $("messageSearchBar").classList.remove("hidden");
        $("messageSearchInput").focus();
      } else {
        $("chatSearch").focus();
      }
    }
  }
  if (event.key === "Escape") {
    if (!$("emojiPicker").classList.contains("hidden")) $("emojiPicker").classList.add("hidden");
    if (!$("messageSearchBar").classList.contains("hidden")) {
      $("messageSearchBar").classList.add("hidden");
      $("messageSearchInput").value = "";
      messageSearchTerm = "";
      $("messageSearchCount").textContent = "";
      renderMessages();
    }
    if (!$("profilePanel").classList.contains("hidden")) closeProfile();
    if (typing && target === $("messageSearchInput")) target.blur();
  }
});
$("messageInput").addEventListener("input", () => {
  const input = $("messageInput");
  input.style.height = "42px";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
  saveCurrentDraft();
  if (input.value.trim()) broadcastTyping();
});

/* Редактирование, удаление и закрепление */
function editMessage(message) {
  if (!message.content || message.__pending || message.__failed) {
    showNotice("Это сообщение пока нельзя редактировать.");
    return;
  }
  editingMessageId = message.id;
  editingDraft = message.content;
  renderMessages();
}

async function saveInlineEdit(message) {
  const updated = editingDraft.trim();
  if (!updated) {
    showNotice("Текст сообщения не может быть пустым.");
    return;
  }
  try {
    const editedAt = new Date().toISOString();
    const {error} = await sb.from("messages")
      .update({content:updated, edited_at:editedAt})
      .eq("id", message.id)
      .eq("sender_id", currentUser.id);
    if (error) throw error;
    message.content = updated;
    message.edited_at = editedAt;
    editingMessageId = null;
    editingDraft = "";
    renderMessages();
    showNotice("Сообщение изменено.");
  } catch (error) {
    showNotice("Не удалось изменить сообщение: " + safeError(error), 6000);
  }
}

async function deleteMessage(message) {
  if (!confirm("Удалить это сообщение?")) return;
  try {
    const {error} = await sb.from("messages")
      .update({deleted_at:new Date().toISOString()})
      .eq("id", message.id)
      .eq("sender_id", currentUser.id);
    if (error) throw error;
    messages = messages.filter(m => m.id !== message.id);
    renderMessages();
    showNotice("Сообщение удалено.");
  } catch (error) {
    showNotice("Не удалось удалить сообщение: " + safeError(error), 6000);
  }
}

/* Загрузка фото и файлов в Storage */
$("attachmentButton").addEventListener("click", () => $("fileInput").click());

async function compressImage(file) {
  if (!file.type.startsWith("image/") || file.type === "image/gif" || file.size < 600 * 1024) return file;
  try {
    if (!("createImageBitmap" in window)) return file;
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) { bitmap.close?.(); return file; }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, {type:"image/jpeg",lastModified:Date.now()});
  } catch (error) {
    console.debug("Image compression skipped:", error?.message || error);
    return file;
  }
}

async function uploadOneFile(originalFile, chatId, replyId, forcedMessageType = null) {
  let file = await compressImage(originalFile);
  if (file.size > 25 * 1024 * 1024) throw new Error(file.name + ": файл больше 25 МБ");
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "file";
  const path = currentUser.id + "/" + chatId + "/" + Date.now() + "_" + safeName;
  const {error:uploadError} = await sb.storage.from(MEDIA_BUCKET).upload(path, file, {
    upsert:false, contentType:file.type || "application/octet-stream"
  });
  if (uploadError) throw uploadError;
  const isImage = file.type.startsWith("image/");
  const isAudio = file.type.startsWith("audio/");
  const isVideo = file.type.startsWith("video/");
  const row = {
    chat_id:chatId,
    sender_id:currentUser.id,
    content:"",
    message_type:forcedMessageType || (isImage ? "image" : isAudio ? "audio" : isVideo ? "video" : "file"),
    media_path:path,
    file_name:file.name,
    mime_type:file.type || null,
    image_url:null,
    file_url:null,
    reply_to_id:replyId || null,
    ...(currentExpirySeconds ? {expires_at:new Date(Date.now() + currentExpirySeconds * 1000).toISOString()} : {})
  };
  const {data:insertedFile,error:insertError} = await sb.from("messages").insert(row).select().single();
  if (insertError) throw insertError;
  if (activeChat?.id === chatId) addOrUpdateMessage(insertedFile);
}

async function uploadFiles(files, forcedMessageType = null) {
  if (!currentUser || !activeChat || !files?.length) return;
  const targetChatId = activeChat.id;
  const replyId = replyToMessage?.id && !String(replyToMessage.id).startsWith("local-") ? replyToMessage.id : null;
  const fileList = [...files].filter(Boolean);
  if (fileList.some(file => file.size > 25 * 1024 * 1024)) {
    showNotice("Один из файлов больше 25 МБ. Уменьши его и попробуй ещё раз.", 5000);
    return;
  }
  $("attachmentButton").disabled = true;
  $("recordButton").disabled = true;
  $("videoNoteButton").disabled = true;
  $("uploadProgressWrap").classList.remove("hidden");
  $("uploadProgress").removeAttribute("value");
  let succeeded = 0;
  let failures = [];
  try {
    for (let index = 0; index < fileList.length; index++) {
      $("uploadProgressLabel").textContent = "Загружаем " + (index + 1) + " из " + fileList.length + ": " + fileList[index].name;
      try {
        await uploadOneFile(fileList[index], targetChatId, replyId, forcedMessageType);
        succeeded++;
      } catch (error) {
        failures.push(fileList[index].name + ": " + (error?.message || "ошибка"));
      }
      $("uploadProgress").value = Math.round(((index + 1) / fileList.length) * 100);
    }
    if (activeChat?.id === targetChatId) forceScrollDown();
    await loadChatSummaries();
    renderChatList();
    if (failures.length) showNotice("Отправлено " + succeeded + " из " + fileList.length + ". Ошибки: " + failures.join("; "), 8000);
    else showNotice("Отправлено файлов: " + succeeded + " ❤️");
    replyToMessage = null;
    $("replyBar").classList.add("hidden");
  } finally {
    $("attachmentButton").disabled = false;
    $("recordButton").disabled = false;
    $("videoNoteButton").disabled = false;
    $("uploadProgressWrap").classList.add("hidden");
    $("fileInput").value = "";
  }
}

$("fileInput").addEventListener("change", event => {
  uploadFiles(event.target.files);
});

async function toggleVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    showNotice("Запись аудио не поддерживается этим браузером.");
    return;
  }
  try {
    recordStream = await navigator.mediaDevices.getUserMedia({audio:true});
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(recordStream);
    mediaRecorder.addEventListener("dataavailable", event => {
      if (event.data?.size) recordedChunks.push(event.data);
    });
    mediaRecorder.addEventListener("stop", async () => {
      const mime = mediaRecorder?.mimeType || recordedChunks[0]?.type || "audio/webm";
      const extension = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
      const file = new File(recordedChunks, "voice-" + Date.now() + "." + extension, {type:mime});
      recordStream?.getTracks().forEach(track => track.stop());
      recordStream = null;
      mediaRecorder = null;
      $("recordingStatus").classList.add("hidden");
      $("recordButton").textContent = "🎙";
      if (file.size) await uploadFiles([file]);
    });
    mediaRecorder.start();
    $("recordingStatus").classList.remove("hidden");
    $("recordButton").textContent = "■";
    showNotice("Идёт запись. Нажми ■, чтобы отправить голосовое.");
  } catch (error) {
    recordStream?.getTracks().forEach(track => track.stop());
    recordStream = null;
    showNotice("Не удалось начать запись: " + safeError(error), 6000);
  }
}
$("recordButton").addEventListener("click", toggleVoiceRecording);

async function toggleVideoNoteRecording() {
  if (videoRecorder?.state === "recording") {
    videoRecorder.stop();
    return;
  }
  if (mediaRecorder?.state === "recording") {
    showNotice("Сначала заверши аудиозапись.");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    showNotice("Запись видео не поддерживается этим браузером.");
    return;
  }
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      audio:true,
      video:{facingMode:"user",width:{ideal:480},height:{ideal:480},frameRate:{ideal:24,max:30}}
    });
    videoChunks = [];
    const preferred = ["video/webm;codecs=vp8,opus","video/webm","video/mp4"];
    const supported = preferred.find(type => MediaRecorder.isTypeSupported?.(type));
    videoRecorder = new MediaRecorder(videoStream, supported ? {mimeType:supported} : undefined);
    videoRecorder.addEventListener("dataavailable", event => {
      if (event.data?.size) videoChunks.push(event.data);
    });
    videoRecorder.addEventListener("stop", async () => {
      const mime = videoRecorder?.mimeType || videoChunks[0]?.type || "video/webm";
      const extension = mime.includes("mp4") ? "mp4" : "webm";
      const file = new File(videoChunks,"video-note-"+Date.now()+"."+extension,{type:mime});
      videoStream?.getTracks().forEach(track => track.stop());
      videoStream = null;
      videoRecorder = null;
      $("recordingStatus").classList.add("hidden");
      $("videoNoteButton").textContent = "📹";
      if (file.size) await uploadFiles([file],"video_note");
    });
    videoRecorder.start();
    $("recordingStatus").textContent = "Запись видео-кружка… нажми ■ ещё раз, чтобы отправить";
    $("recordingStatus").classList.remove("hidden");
    $("videoNoteButton").textContent = "■";
    showNotice("Идёт запись видео-кружка. Нажми ■, чтобы отправить.");
  } catch (error) {
    videoStream?.getTracks().forEach(track => track.stop());
    videoStream = null;
    videoRecorder = null;
    showNotice("Не удалось начать запись видео: " + safeError(error),6000);
  }
}
$("videoNoteButton").addEventListener("click",toggleVideoNoteRecording);

function handleDroppedFiles(event) {
  const files = event.dataTransfer?.files;
  if (files?.length) {
    event.preventDefault();
    uploadFiles(files);
  }
}
["messages", "messageInput"].forEach(id => {
  const element = $(id);
  element.addEventListener("dragover", event => {
    if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
  });
  element.addEventListener("drop", handleDroppedFiles);
});
document.addEventListener("paste", event => {
  const files = [...(event.clipboardData?.items || [])]
    .filter(item => item.kind === "file")
    .map(item => item.getAsFile())
    .filter(Boolean);
  if (files.length && activeChat) {
    event.preventDefault();
    uploadFiles(files);
  }
});

function galleryMessages() {
  if (galleryOverride && galleryOverrideChatId === activeChat?.id) return galleryOverride;
  return messages.filter(message => message.media_path && (message.message_type === "image" || (message.mime_type || "").startsWith("image/")));
}

async function openSharedAlbum(chat) {
  if (!currentUser || !chat || chat.id !== activeChat?.id) return;
  try {
    const {data,error} = await sb.from("messages")
      .select("id,chat_id,sender_id,created_at,message_type,media_path,mime_type,file_name")
      .eq("chat_id",chat.id)
      .is("deleted_at",null)
      .not("media_path","is",null)
      .order("created_at",{ascending:true})
      .limit(200);
    if (error) throw error;
    galleryOverride = (data || []).filter(message => message.message_type === "image" || (message.mime_type || "").startsWith("image/"));
    galleryOverrideChatId = chat.id;
    if (!galleryOverride.length) {
      showNotice("В этом чате ещё нет фотографий.");
      return;
    }
    await showMediaViewer(0);
  } catch (error) {
    showNotice("Не удалось открыть общий альбом: " + safeError(error),6000);
  }
}
async function showMediaViewer(index) {
  const items = galleryMessages();
  if (!items.length) return;
  mediaViewerIndex = (index + items.length) % items.length;
  const message = items[mediaViewerIndex];
  const url = await ensureUrl(message.media_path);
  if (!url) { showNotice("Не удалось открыть фото."); return; }
  $("mediaViewerImage").src = url;
  $("mediaViewer").classList.remove("hidden");
  $("mediaViewerPrev").classList.toggle("hidden", items.length < 2);
  $("mediaViewerNext").classList.toggle("hidden", items.length < 2);
}
function closeMediaViewer() {
  $("mediaViewer").classList.add("hidden");
  $("mediaViewerImage").removeAttribute("src");
}
$("mediaViewerClose").addEventListener("click", closeMediaViewer);
$("mediaViewer").addEventListener("click", event => { if (event.target === $("mediaViewer")) closeMediaViewer(); });
$("mediaViewerPrev").addEventListener("click", () => showMediaViewer(mediaViewerIndex - 1));
$("mediaViewerNext").addEventListener("click", () => showMediaViewer(mediaViewerIndex + 1));
document.addEventListener("keydown", event => {
  if ($("mediaViewer").classList.contains("hidden")) return;
  if (event.key === "Escape") closeMediaViewer();
  if (event.key === "ArrowLeft") showMediaViewer(mediaViewerIndex - 1);
  if (event.key === "ArrowRight") showMediaViewer(mediaViewerIndex + 1);
});

/* Обновление сообщений в реальном времени */
function removeRealtime() {
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = null;
  if (rtcPeer || pendingCallOffer) endOneToOneCall(true);
  if (realtimeChannel) {
    sb.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  resolveRealtimeWaiters(false);
  presenceChannel = null;
  onlineUserIds = new Set();
}
function broadcastTyping() {
  if (!realtimeChannel || !currentUser || !activeChat) return;
  const now = Date.now();
  if (now - lastTypingBroadcastAt < 1200) return;
  lastTypingBroadcastAt = now;
  realtimeChannel.send({
    type:"broadcast",
    event:"typing",
    payload:{user_id:currentUser.id, typing:true}
  }).catch(error => console.debug("Typing broadcast skipped:", error?.message || error));
}

function resolveRealtimeWaiters(ready) {
  realtimeReady = ready;
  if (!ready) return;
  const waiters = realtimeReadyWaiters.splice(0);
  waiters.forEach(resolve => resolve(true));
}
function waitForRealtime(timeout = 7000) {
  if (realtimeReady && realtimeChannel) return Promise.resolve(true);
  return new Promise(resolve => {
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      resolve(value);
    };
    realtimeReadyWaiters.push(finish);
    setTimeout(() => finish(false),timeout);
  });
}
async function sendCallSignal(eventName, data = {}) {
  if (!realtimeChannel || !currentUser) throw new Error("Realtime канал не подключён");
  const result = await realtimeChannel.send({
    type:"broadcast",
    event:eventName,
    payload:{...data,sender_id:currentUser.id}
  });
  if (result === "error" || result === "timed out") throw new Error("Не удалось передать сигнал звонка");
}
function callStatus(text) {
  $("callStatus").textContent = text;
}
function prepareCallUi(video, incoming = false) {
  $("callTitle").textContent = video ? "Видеозвонок MiniChat" : "Голосовой звонок MiniChat";
  $("incomingCallActions").classList.toggle("hidden",!incoming);
  $("activeCallActions").classList.toggle("hidden",incoming);
  $("localCallVideo").style.display = video ? "block" : "none";
  $("remoteCallVideo").style.display = video ? "block" : "none";
  $("remoteCallAudio").style.display = video ? "none" : "block";
  $("cameraCallButton").classList.toggle("hidden",!video);
  $("callPanel").classList.remove("hidden");
}
function createRtcPeer(targetId, video) {
  if (typeof RTCPeerConnection === "undefined") throw new Error("WebRTC не поддерживается этим браузером");
  const peer = new RTCPeerConnection({
    iceServers:[{urls:"stun:stun.l.google.com:19302"}]
  });
  rtcPeer = peer;
  peer.onicecandidate = event => {
    if (!event.candidate || !currentCallTargetId) return;
    sendCallSignal("call-ice",{
      target_id:currentCallTargetId,
      candidate:event.candidate.toJSON()
    }).catch(error => console.debug("ICE signaling failed:",error?.message || error));
  };
  peer.ontrack = event => {
    const remoteStream = event.streams?.[0];
    if (!remoteStream) return;
    $("remoteCallVideo").srcObject = remoteStream;
    $("remoteCallAudio").srcObject = remoteStream;
    if (video) {
      $("remoteCallVideo").style.display = "block";
      $("remoteCallAudio").style.display = "none";
    } else {
      $("remoteCallVideo").style.display = "none";
      $("remoteCallAudio").style.display = "block";
    }
    const playback = video ? $("remoteCallVideo") : $("remoteCallAudio");
    playback.play?.().catch(() => {});
    callStatus("Звонок соединён");
  };
  peer.onconnectionstatechange = () => {
    if (!rtcPeer || rtcPeer !== peer) return;
    if (peer.connectionState === "connected") callStatus("Звонок соединён");
    else if (peer.connectionState === "connecting") callStatus("Соединяемся…");
    else if (peer.connectionState === "disconnected") callStatus("Связь прервалась, пытаемся восстановить…");
    else if (peer.connectionState === "failed") {
      callStatus("Не удалось соединиться. Попробуйте ещё раз.");
      showNotice("Соединение WebRTC не удалось. Для сетей с жёстким NAT может понадобиться TURN-сервер.",7000);
    }
  };
  return peer;
}
async function flushCallCandidates() {
  if (!rtcPeer?.remoteDescription || !currentCallTargetId) return;
  const relevant = pendingCallCandidates.filter(item => item.sender_id === currentCallTargetId);
  pendingCallCandidates = pendingCallCandidates.filter(item => item.sender_id !== currentCallTargetId);
  for (const item of relevant) {
    try { await rtcPeer.addIceCandidate(new RTCIceCandidate(item.candidate)); }
    catch (error) { console.debug("ICE candidate skipped:",error?.message || error); }
  }
}
async function startOneToOneCall(video) {
  if (!activeChat || !currentUser) { showNotice("Сначала открой личный чат."); return; }
  if (activeChat.is_group) { showNotice("Пока доступны только звонки один на один."); return; }
  if (rtcPeer || pendingCallOffer) { showNotice("Сначала заверши текущий звонок."); return; }
  if (!otherProfile?.id) { showNotice("Не удалось определить собеседника."); return; }
  if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
    showNotice("Этот браузер не поддерживает звонки. Открой MiniChat по HTTPS в актуальном браузере.");
    return;
  }
  if (!(await waitForRealtime())) {
    showNotice("Realtime ещё подключается. Подожди пару секунд и попробуй снова.");
    return;
  }
  currentCallTargetId = otherProfile.id;
  currentCallVideo = Boolean(video);
  callMicMuted = false;
  callCameraMuted = false;
  prepareCallUi(currentCallVideo,false);
  callStatus("Запрашиваем доступ к микрофону" + (video ? " и камере…" : "…"));
  $("muteCallButton").textContent = "Выключить микрофон";
  $("cameraCallButton").textContent = "Выключить камеру";
  try {
    localCallStream = await navigator.mediaDevices.getUserMedia({
      audio:true,
      video:video ? {facingMode:"user",width:{ideal:720},height:{ideal:540}} : false
    });
    $("localCallVideo").srcObject = localCallStream;
    $("localCallVideo").muted = true;
    createRtcPeer(currentCallTargetId,currentCallVideo);
    localCallStream.getTracks().forEach(track => rtcPeer.addTrack(track,localCallStream));
    const offer = await rtcPeer.createOffer();
    await rtcPeer.setLocalDescription(offer);
    await sendCallSignal("call-offer",{
      target_id:currentCallTargetId,
      video:currentCallVideo,
      sdp:rtcPeer.localDescription.toJSON()
    });
    callStatus("Вызываем собеседника…");
  } catch (error) {
    showNotice("Не удалось начать звонок: " + safeError(error),7000);
    endOneToOneCall(false);
  }
}
async function handleIncomingCallOffer(payload) {
  if (!payload || payload.sender_id === currentUser?.id || payload.target_id !== currentUser?.id) return;
  if (!activeChat || activeChat.is_group || !realtimeChannel) return;
  if (rtcPeer || pendingCallOffer) {
    sendCallSignal("call-reject",{target_id:payload.sender_id,reason:"busy"}).catch(() => {});
    return;
  }
  pendingCallOffer = payload;
  currentCallTargetId = payload.sender_id;
  currentCallVideo = Boolean(payload.video);
  prepareCallUi(currentCallVideo,true);
  $("callTitle").textContent = (otherProfile?.username || "Собеседник") + (currentCallVideo ? " звонит по видео" : " звонит");
  callStatus("Входящий звонок");
}
async function acceptOneToOneCall() {
  const offer = pendingCallOffer;
  if (!offer || !offer.sdp) return;
  if (!navigator.mediaDevices?.getUserMedia) { showNotice("Микрофон недоступен в этом браузере."); return; }
  try {
    callStatus("Запрашиваем доступ к устройствам…");
    localCallStream = await navigator.mediaDevices.getUserMedia({
      audio:true,
      video:currentCallVideo ? {facingMode:"user",width:{ideal:720},height:{ideal:540}} : false
    });
    $("localCallVideo").srcObject = localCallStream;
    $("localCallVideo").muted = true;
    $("incomingCallActions").classList.add("hidden");
    $("activeCallActions").classList.remove("hidden");
    callMicMuted = false;
    callCameraMuted = false;
    $("muteCallButton").textContent = "Выключить микрофон";
    $("cameraCallButton").textContent = "Выключить камеру";
    createRtcPeer(offer.sender_id,currentCallVideo);
    localCallStream.getTracks().forEach(track => rtcPeer.addTrack(track,localCallStream));
    await rtcPeer.setRemoteDescription(new RTCSessionDescription(offer.sdp));
    pendingCallOffer = null;
    await flushCallCandidates();
    const answer = await rtcPeer.createAnswer();
    await rtcPeer.setLocalDescription(answer);
    await sendCallSignal("call-answer",{
      target_id:currentCallTargetId,
      sdp:rtcPeer.localDescription.toJSON()
    });
    callStatus("Подключаемся к звонку…");
  } catch (error) {
    showNotice("Не удалось ответить на звонок: " + safeError(error),7000);
    endOneToOneCall(true,"call-reject");
  }
}
async function handleIncomingCallAnswer(payload) {
  if (!rtcPeer || payload?.target_id !== currentUser?.id || payload.sender_id !== currentCallTargetId || !payload.sdp) return;
  try {
    await rtcPeer.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    await flushCallCandidates();
    callStatus("Ответ получен, устанавливаем соединение…");
  } catch (error) {
    showNotice("Не удалось установить ответ звонка: " + safeError(error),6000);
    endOneToOneCall(true);
  }
}
async function handleIncomingCallIce(payload) {
  if (!payload?.candidate || payload.target_id !== currentUser?.id || payload.sender_id === currentUser?.id) return;
  if (!rtcPeer || !rtcPeer.remoteDescription || payload.sender_id !== currentCallTargetId) {
    pendingCallCandidates.push(payload);
    if (pendingCallCandidates.length > 200) pendingCallCandidates.shift();
    return;
  }
  try { await rtcPeer.addIceCandidate(new RTCIceCandidate(payload.candidate)); }
  catch (error) { console.debug("ICE candidate skipped:",error?.message || error); }
}
function endOneToOneCall(notifyRemote = true,eventName = "call-end") {
  if (notifyRemote && currentCallTargetId && realtimeChannel) {
    sendCallSignal(eventName,{target_id:currentCallTargetId}).catch(error => console.debug("Call end signal skipped:",error?.message || error));
  }
  try { rtcPeer?.close(); } catch {}
  rtcPeer = null;
  localCallStream?.getTracks().forEach(track => track.stop());
  localCallStream = null;
  $("localCallVideo").srcObject = null;
  $("remoteCallVideo").srcObject = null;
  $("remoteCallAudio").srcObject = null;
  $("callPanel").classList.add("hidden");
  $("incomingCallActions").classList.add("hidden");
  $("activeCallActions").classList.add("hidden");
  pendingCallOffer = null;
  pendingCallCandidates = [];
  currentCallTargetId = null;
  currentCallVideo = false;
  callMicMuted = false;
  callCameraMuted = false;
}
function handleRemoteCallEnd(payload,eventName) {
  if (!payload || payload.sender_id === currentUser?.id || payload.target_id !== currentUser?.id) return;
  if (payload.sender_id !== currentCallTargetId) return;
  const wasIncoming = Boolean(pendingCallOffer);
  endOneToOneCall(false);
  showNotice(eventName === "call-reject" ? "Собеседник отклонил звонок." : wasIncoming ? "Входящий звонок завершён." : "Звонок завершён.");
}
$("callAudioButton").addEventListener("click",() => startOneToOneCall(false));
$("callVideoButton").addEventListener("click",() => startOneToOneCall(true));
$("acceptCallButton").addEventListener("click",acceptOneToOneCall);
$("declineCallButton").addEventListener("click",() => endOneToOneCall(true,"call-reject"));
$("hangupCallButton").addEventListener("click",() => endOneToOneCall(true));
$("muteCallButton").addEventListener("click",() => {
  callMicMuted = !callMicMuted;
  localCallStream?.getAudioTracks().forEach(track => track.enabled = !callMicMuted);
  $("muteCallButton").textContent = callMicMuted ? "Включить микрофон" : "Выключить микрофон";
});
$("cameraCallButton").addEventListener("click",() => {
  callCameraMuted = !callCameraMuted;
  localCallStream?.getVideoTracks().forEach(track => track.enabled = !callCameraMuted);
  $("cameraCallButton").textContent = callCameraMuted ? "Включить камеру" : "Выключить камеру";
});

function subscribeToMessages() {
  removeRealtime();
  if (!activeChat || !currentUser) return;

  const chatId = activeChat.id;
  realtimeChannel = sb.channel("chat:" + chatId, {
    config: {private:true, presence:{key:currentUser.id}}
  });
  presenceChannel = realtimeChannel;
  realtimeChannel
    .on("presence", {event:"sync"}, () => {
      const state = presenceChannel?.presenceState?.() || {};
      onlineUserIds = new Set(Object.keys(state));
      if (otherProfile) updateHeaderStatus();
    })
    .on("broadcast", {event:"call-offer"}, ({payload}) => { handleIncomingCallOffer(payload).catch(error => console.debug("Incoming call ignored:",error?.message || error)); })
    .on("broadcast", {event:"call-answer"}, ({payload}) => { handleIncomingCallAnswer(payload).catch(error => console.debug("Call answer ignored:",error?.message || error)); })
    .on("broadcast", {event:"call-ice"}, ({payload}) => { handleIncomingCallIce(payload).catch(error => console.debug("ICE signal ignored:",error?.message || error)); })
    .on("broadcast", {event:"call-end"}, ({payload}) => handleRemoteCallEnd(payload,"call-end"))
    .on("broadcast", {event:"call-reject"}, ({payload}) => handleRemoteCallEnd(payload,"call-reject"))
    .on("broadcast", {event:"typing"}, ({payload}) => {
      if (activeChat?.id !== chatId || payload?.user_id === currentUser?.id) return;
      if (payload?.typing) {
        $("headerStatus").textContent = "печатает…";
        if (typingTimer) clearTimeout(typingTimer);
        typingTimer = setTimeout(() => {
          typingTimer = null;
          updateHeaderStatus();
        }, 2200);
      }
    })
    .on("postgres_changes", {
      event:"*",
      schema:"public",
      table:"messages",
      filter:"chat_id=eq." + chatId
    }, payload => {
      if (activeChat?.id !== chatId) return;
      if (payload.eventType === "DELETE") {
        messages = messages.filter(m => m.id !== payload.old.id);
        renderMessages();
        return;
      }
      if (payload.eventType === "INSERT" && payload.new.sender_id !== currentUser?.id) {
        if (!currentChatMuted) {
          playMessageSound();
          if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") {
            try { new Notification("MiniChat ❤️", {body:payload.new.content || "Новое сообщение", icon:"/icons/icon.svg"}); } catch {}
          }
        }
        const messageBox = $("messages");
        const distance = messageBox.scrollHeight - messageBox.scrollTop - messageBox.clientHeight;
        if (distance > 180) unreadWhileAway += 1;
      }
      addOrUpdateMessage(payload.new);
      if (payload.eventType === "INSERT") {
        loadChatSummaries().then(renderChatList).catch(error => console.debug("Chat summary refresh skipped:", error?.message || error));
      }
      if (payload.eventType === "INSERT" && payload.new.sender_id !== currentUser?.id && document.visibilityState === "visible") {
        markMessagesAsRead();
      }
    })
    .subscribe(async status => {
      resolveRealtimeWaiters(status === "SUBSCRIBED");
      if (status === "SUBSCRIBED" && currentUser && activeChat?.id === chatId) {
        const {error} = await realtimeChannel.track({
          user_id:currentUser.id,
          online_at:new Date().toISOString(),
          visible:document.visibilityState === "visible"
        });
        if (error) console.debug("Chat Presence tracking unavailable:",error.message);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn("Realtime channel unavailable. Check Supabase Realtime authorization policies.");
      }
    });
}

$("pinnedBanner").addEventListener("click", () => {
  const pinned = messages.find(message => message.is_pinned);
  if (pinned) jumpToMessage(pinned.id);
});
$("selectMessagesButton").addEventListener("click", () => {
  selectionMode = !selectionMode;
  if (!selectionMode) selectedMessageIds.clear();
  $("selectMessagesButton").textContent = selectionMode ? "×" : "☑";
  $("selectMessagesButton").title = selectionMode ? "Отменить выбор" : "Выбрать сообщения";
  renderMessages();
});
$("deleteSelectedButton").addEventListener("click", deleteSelectedMessages);

async function manageGroup() {
  if (!activeChat?.is_group || !currentUser) return;
  const chatId = activeChat.id;
  const action = prompt("Управление группой:\\n1 — добавить участника\\n2 — изменить роль\\n3 — удалить участника\\n4 — переименовать группу", "1");
  if (!action) return;
  try {
    if (action === "1") {
      const query = prompt("Email или точное имя нового участника:");
      if (!query?.trim()) return;
      const {data:users,error:userError} = await sb.rpc("find_chat_user",{p_query:query.trim()});
      if (userError) throw userError;
      const found = users?.[0];
      if (!found?.user_id) throw new Error("Пользователь не найден");
      const {error} = await sb.rpc("add_chat_member",{p_chat_id:chatId,p_user_id:found.user_id});
      if (error) throw error;
      showNotice("Участник добавлен.");
    } else if (action === "2" || action === "3") {
      const {data:members,error} = await sb.from("chat_members").select("user_id,role").eq("chat_id",chatId);
      if (error) throw error;
      const choices = (members || []).filter(item => item.user_id !== currentUser.id && item.role !== "owner");
      if (!choices.length) { showNotice("Нет участников, которых можно изменить."); return; }
      const labels = choices.map((item,index) => {
        const profile = profilesById[item.user_id];
        return (index+1)+". "+(profile?.username || item.user_id.slice(0,8))+" ["+item.role+"]";
      }).join("\\n");
      const choice = prompt("Выбери участника:\\n"+labels,"1");
      if (choice === null) return;
      const member = choices[Number(choice)-1];
      if (!member) { showNotice("Неверный номер."); return; }
      if (action === "2") {
        const role = prompt("Роль: admin или member","member");
        if (!["admin","member"].includes(role)) { showNotice("Роль должна быть admin или member."); return; }
        const {error:roleError} = await sb.rpc("update_chat_member_role",{p_chat_id:chatId,p_user_id:member.user_id,p_role:role});
        if (roleError) throw roleError;
        showNotice("Роль участника обновлена.");
      } else {
        if (!confirm("Удалить участника из группы?")) return;
        const {error:removeError} = await sb.rpc("remove_chat_member",{p_chat_id:chatId,p_user_id:member.user_id});
        if (removeError) throw removeError;
        showNotice("Участник удалён.");
      }
    } else if (action === "4") {
      const title = prompt("Новое название группы:",chatTitle(activeChat));
      if (!title?.trim()) return;
      const {error} = await sb.rpc("rename_chat",{p_chat_id:chatId,p_title:title.trim()});
      if (error) throw error;
      activeChat.title = title.trim();
      await loadChats();
      $("headerTitle").textContent = chatTitle(activeChat);
      showNotice("Название группы изменено.");
    }
    await loadMembers();
  } catch (error) {
    showNotice("Управление группой требует миграции Supabase или прав администратора: "+safeError(error),7000);
  }
}
$("groupManageButton").addEventListener("click",manageGroup);

async function createChatFromPrompt() {
  if (!currentUser) return;
  const group = confirm("Создать группу? Нажми «Отмена», если нужен личный чат.");
  const raw = prompt(group ? "Введи имена или email участников через запятую:" : "Введи имя пользователя или email:");
  if (!raw?.trim()) return;
  const queries = [...new Set(raw.split(",").map(item => item.trim()).filter(Boolean))];
  if (!queries.length) return;
  const memberIds = [];
  const names = [];
  try {
    for (const query of queries) {
      const {data,error} = await sb.rpc("find_chat_user", {p_query:query});
      if (error) throw error;
      const user = data?.[0];
      if (!user?.user_id) throw new Error("Не найден пользователь: " + query);
      memberIds.push(user.user_id);
      names.push(user.username || query);
    }
    const title = group ? (prompt("Название группы:") || names.join(", ")).trim() : "";
    const {data:chatId,error} = await sb.rpc("create_chat_with_members", {
      p_title:title, p_is_group:group, p_member_ids:memberIds
    });
    if (error) throw error;
    await loadChats();
    const created = chats.find(chat => chat.id === chatId);
    if (created) await openChat(created);
    showNotice(group ? "Группа создана ❤️" : "Чат создан ❤️");
  } catch (error) {
    showNotice("Создание чата требует миграции Supabase и доступа к RPC: " + safeError(error), 7000);
  }
}
$("newChatButton").addEventListener("click", createChatFromPrompt);

async function saveMessageForLater(message) {
  if (!message?.id || String(message.id).startsWith("local-")) return;
  try {
    const {data:existing,error:readError} = await sb.from("saved_messages").select("id")
      .eq("user_id",currentUser.id).eq("message_id",message.id).maybeSingle();
    if (readError) throw readError;
    if (existing) {
      const {error} = await sb.from("saved_messages").delete().eq("id",existing.id).eq("user_id",currentUser.id);
      if (error) throw error;
      showNotice("Убрано из сохранённого.");
    } else {
      const {error} = await sb.from("saved_messages").insert({user_id:currentUser.id,message_id:message.id});
      if (error) throw error;
      showNotice("Сохранено ⭐");
    }
  } catch (error) {
    showNotice("Сохранённые сообщения требуют миграции Supabase: " + safeError(error), 6000);
  }
}
async function showSavedMessages() {
  try {
    const {data:saved,error} = await sb.from("saved_messages").select("message_id,created_at")
      .eq("user_id",currentUser.id).order("created_at",{ascending:false}).limit(100);
    if (error) throw error;
    const ids = (saved || []).map(item => item.message_id);
    if (!ids.length) { showNotice("Пока нет сохранённых сообщений."); return; }
    const {data:rows,error:rowsError} = await sb.from("messages").select("id,chat_id,content,created_at")
      .in("id",ids);
    if (rowsError) throw rowsError;
    const byId = new Map((rows || []).map(row => [row.id,row]));
    const choices = ids.map((id,index) => {
      const row = byId.get(id);
      const chat = chats.find(item => item.id === row?.chat_id);
      return (index + 1) + ". [" + (chat ? chatTitle(chat) : "Чат") + "] " + (row?.content || "Вложение").slice(0,90);
    }).join("\n");
    const choice = prompt("Сохранённые сообщения:\n" + choices + "\n\nВведи номер, чтобы открыть:", "1");
    if (choice === null) return;
    const row = byId.get(ids[Number(choice) - 1]);
    const chat = chats.find(item => item.id === row?.chat_id);
    if (!row || !chat) { showNotice("Не удалось найти это сообщение."); return; }
    await openChat(chat);
    let guard = 0;
    while (!messages.some(item => item.id === row.id) && hasMoreMessages && guard++ < 40) await loadOlderMessages();
    jumpToMessage(row.id);
  } catch (error) {
    showNotice("Сохранённые сообщения требуют миграции Supabase: " + safeError(error), 6000);
  }
}
$("savedMessagesButton").addEventListener("click", showSavedMessages);

async function deleteSelectedMessages() {
  const ids = [...selectedMessageIds];
  if (!ids.length) { showNotice("Сначала выбери свои сообщения."); return; }
  if (!confirm("Удалить выбранные сообщения (" + ids.length + ")?")) return;
  try {
    const {error} = await sb.from("messages")
      .update({deleted_at:new Date().toISOString()})
      .in("id",ids).eq("sender_id",currentUser.id);
    if (error) throw error;
    messages = messages.filter(message => !selectedMessageIds.has(message.id));
    selectedMessageIds.clear();
    selectionMode = false;
    $("selectMessagesButton").textContent = "☑";
    $("selectMessagesButton").title = "Выбрать сообщения";
    renderMessages();
    showNotice("Выбранные сообщения удалены.");
  } catch (error) {
    showNotice("Не удалось удалить выбранные сообщения: " + safeError(error), 6000);
  }
}
function updateSelectionControls() {
  const button = $("deleteSelectedButton");
  if (!button) return;
  button.classList.toggle("hidden", !selectionMode);
  button.textContent = selectedMessageIds.size ? "🗑 " + selectedMessageIds.size : "🗑";
  button.disabled = selectedMessageIds.size === 0;
}
function updatePinnedBanner() {
  const banner = $("pinnedBanner");
  if (!banner) return;
  const pinned = messages.find(message => message.is_pinned && (!message.expires_at || new Date(message.expires_at).getTime() > Date.now()));
  banner.classList.toggle("hidden", !pinned);
  $("pinnedBannerText").textContent = pinned ? (pinned.content || pinned.file_name || "Закреплено вложение") : "Закреплённое сообщение";
}
async function showChatStats() {
  if (!activeChat) return;
  try {
    const {data,error} = await sb.rpc("get_chat_stats", {p_chat_id:activeChat.id});
    if (error) throw error;
    const total = Number(data?.total_messages || 0);
    const mine = Number(data?.my_messages || 0);
    const other = Number(data?.other_messages || 0);
    const days = Number(data?.active_days || 0);
    showNotice("Статистика: " + total + " сообщений · твоих " + mine + " · собеседника " + other + " · активных дней " + days, 7000);
  } catch (error) {
    showNotice("Статистика требует применения миграции Supabase: " + safeError(error), 6000);
  }
}
$("chatStatsButton").addEventListener("click", showChatStats);

$("globalSearchButton").addEventListener("click", async () => {
  const query = prompt("Найти текст во всех переписках:");
  if (!query?.trim()) return;
  try {
    const {data,error} = await sb.rpc("search_chat_messages", {p_query:query.trim()});
    if (error) throw error;
    if (!data?.length) { showNotice("Ничего не найдено."); return; }
    const choices = data.slice(0,30).map((item,index) => {
      const chat = chats.find(chatItem => chatItem.id === item.chat_id);
      return (index + 1) + ". [" + (chat ? chatTitle(chat) : "Чат") + "] " + (item.content || "Вложение").slice(0,90);
    }).join("\n");
    const choice = prompt("Результаты поиска:\n" + choices + "\n\nВведи номер:", "1");
    if (choice === null) return;
    const result = data[Number(choice) - 1];
    const chat = chats.find(chatItem => chatItem.id === result?.chat_id);
    if (!result || !chat) return;
    await openChat(chat);
    let guard = 0;
    while (!messages.some(item => item.id === result.id) && hasMoreMessages && guard++ < 50) await loadOlderMessages();
    jumpToMessage(result.id);
  } catch (error) {
    showNotice("Глобальный поиск требует миграции Supabase: " + safeError(error), 6000);
  }
});

$("chatRefreshButton").addEventListener("click", async () => {
  await loadMessages();
  showNotice("Сообщения обновлены.");
});

$("backButton").addEventListener("click", () => {
  saveCurrentDraft();
  activeChat = null;
  replyToMessage = null;
  removeRealtime();
  $("conversation").classList.add("hidden");
  $("welcome").classList.remove("hidden");
  $("profilePanel").classList.add("hidden");
  setMobileChatMode(false);
  renderChatList();
});

/* Installable PWA. The service worker never caches Supabase API/auth/storage calls. */
if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(error => console.warn("PWA service worker unavailable:", error));
  });
}

initSharedSpace({
  sb,
  $,
  getCurrentUser:() => currentUser,
  getActiveChat:() => activeChat,
  showNotice,
  safeError,
  onAlbum:openSharedAlbum
});

/* Запуск приложения */
restoreSession();
