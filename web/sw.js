// SPDX-License-Identifier: GPL-3.0-or-later
// Static offline cache for the web-only Lorebook Extractor.
'use strict';

const CACHE = 'lorebook-static-v3';
const ASSETS = ['./', 'style.css', 'dist/main.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'sample-lorebook.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok) {
          const cp = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, cp));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match('./')))
  );
});

