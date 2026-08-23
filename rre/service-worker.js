// ===========================================================================
// service-worker.js
//
// A "service worker" is a small script the browser runs in the background,
// separate from the page itself. Its main jobs here:
//   1. Let the phone install this page as a real app (PWAs require one).
//   2. Save ("cache") a copy of the app's own files, so it opens instantly
//      even on a slow connection, and shows something instead of a blank
//      white screen if there's no internet at all.
//
// Note: this app still NEEDS an internet connection to actually scan a
// receipt (it has to reach your AI backend). This caching only covers the
// app's own interface loading quickly/reliably — not the AI scanning itself.
// ===========================================================================

const CACHE_NAME = "receipt-scanner-v1"; // bump this (e.g. to "v2") whenever you update the app, to force a refresh

// The files that make up the app's basic interface — these get saved locally.
const APP_SHELL = [
  "./receipt-scanner.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

// Runs once, the first time the service worker is installed on someone's device.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting(); // activate this new service worker immediately, don't wait
});

// Runs when a new version of the service worker takes over — cleans up any
// old cached files left over from a previous version of the app.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// Runs every time the app requests a file (a page, an image, etc).
// Strategy: try the network first (so you always get the latest version
// when online); if that fails (e.g. no signal), fall back to the saved copy.
self.addEventListener("fetch", (event) => {
  // Only handle simple GET requests for our own files — never touch API
  // calls to the AI backend or Microsoft/Outlook, those must always go
  // straight over the real network.
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  const isOwnFile = APP_SHELL.some((file) => url.pathname.endsWith(file.replace("./", "")));
  if (!isOwnFile) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Save a fresh copy for next time, then return it normally.
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request)) // offline — use the saved copy
  );
});
