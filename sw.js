// TidyNest service worker: lets the app open offline, and shows notifications (including pushed ones that arrive
// while TidyNest is closed).
// TidyNest's own files open straight from the copy saved on the phone (so it opens fast, even on a slow
// connection), and the newest copy is fetched in the background for next time. When a new version has arrived,
// the app is told, and it says to reopen.

const CACHE = "tidynest-v8";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "logo-mark.png", "logo-mark-dark.png", "onest.woff2"];
const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/";

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // The Firebase library files are versioned and never change: cache them once.
  if (request.url.startsWith(FIREBASE_SDK)) {
    event.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      }))
    );
    return;
  }

  // TidyNest's own files: the saved copy straight away, while the newest is fetched for next time.
  // (With nothing saved yet, it waits for the network.)
  if (url.origin === self.location.origin) {
    const key = request.mode === "navigate" ? new URL("./", self.registration.scope).href : request.url.split("?")[0];
    const fresh = fetch(request.url, { cache: "no-cache" }).then(async response => {
      if (response.ok) {
        const cache = await caches.open(CACHE);
        const old = await cache.match(key);
        const copy = response.clone();
        await cache.put(key, response.clone());
        // a new version of the page itself: let the open app know
        if (old && request.mode === "navigate") {
          const [a, b] = await Promise.all([old.text(), copy.text()]);
          if (a !== b) (await self.clients.matchAll({ type: "window" })).forEach(c => c.postMessage({ type: "updated" }));
        }
      }
      return response;
    });
    event.respondWith(
      caches.match(key).then(hit => hit || (request.mode === "navigate" ? caches.match("index.html") : undefined))
        .then(hit => {
          if (hit) { event.waitUntil(fresh.catch(() => {})); return hit; }
          return fresh.catch(() => Response.error());
        })
    );
  }
  // Everything else (Firebase sign-in and database traffic) goes straight to the network.
});

// A push from TidyNest's notification functions: { title, body, tag, url }.
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(data.title || "TidyNest", {
    body: data.body || "",
    tag: data.tag || undefined,
    icon: "icon-192.png",
    badge: "icon-192.png",
    data: { url: data.url || "./" }
  }));
});

// Tapping a notification opens TidyNest at the thing it's about.
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
  const id = new URL(url).searchParams.get("item");
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ("focus" in client) {
          if (id) client.postMessage({ type: "open-item", id });
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
