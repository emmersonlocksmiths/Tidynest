// TidyNest service worker: lets the app open offline and show alerts.
// Pages are always fetched fresh when online, so uploading a new version takes effect straight away.

const CACHE = "tidynest-v5";
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

  // TidyNest's own files: newest from the network, falling back to the saved copy when offline.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request.url, { cache: "no-cache" })
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(cache => cache.put(request.url, copy));
          }
          return response;
        })
        .catch(() => caches.match(request.url, { ignoreSearch: true })
          .then(hit => hit || (request.mode === "navigate" ? caches.match("index.html") : undefined))
          .then(hit => hit || Response.error()))
    );
  }
  // Everything else (Firebase sign-in and database traffic) goes straight to the network.
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("./");
    })
  );
});
