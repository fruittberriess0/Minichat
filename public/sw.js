"use strict";
const CACHE_NAME = "minichat-shell-dev";
const SHELL_URLS = /* PRECACHE */ ["/", "/index.html", "/manifest.webmanifest", "/icons/icon.svg"];
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL_URLS);
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith("minichat-shell-") && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/src/") || url.pathname.startsWith("/@") || url.pathname.startsWith("/node_modules/")) return;
  if (url.pathname.startsWith("/rest/") || url.pathname.startsWith("/storage/") || url.pathname.startsWith("/auth/")) return;
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put("/index.html", response.clone());
        }
        return response;
      } catch {
        return (await caches.match("/index.html")) || (await caches.match("/"));
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
      }
      return response;
    } catch {
      return cached || Response.error();
    }
  })());
});
self.addEventListener("push", event => {
  let data = {title:"MiniChat ❤️", body:"У тебя новое сообщение", url:"/"};
  try { if (event.data) data = {...data, ...event.data.json()}; } catch {}
  event.waitUntil(self.registration.showNotification(data.title || "MiniChat ❤️", {
    body: data.body || "У тебя новое сообщение", icon:"/icons/icon.svg", badge:"/icons/icon.svg",
    tag:data.tag || "minichat-message", data:{url:data.url || "/"}, renotify:false
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  let target = self.location.origin + "/";
  try {
    const candidate = new URL(event.notification.data?.url || "/",self.location.origin);
    if(candidate.origin === self.location.origin) target=candidate.href;
  } catch {}
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type:"window", includeUncontrolled:true});
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin) && "focus" in client) {
        await client.focus();
        if ("navigate" in client) await client.navigate(target);
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
