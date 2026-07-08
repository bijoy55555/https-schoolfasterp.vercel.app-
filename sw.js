const CACHE_NAME = "schoolfasterp-cache-v2"; // ✅ ভার্সন বাম্প করা হলো, যাতে পুরনো ক্যাশ রিফ্রেশ হয়ে নতুন প্রিক্যাশ লিস্ট কার্যকর হয়

const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/app.html", // ✅ বাগ-ফিক্স: আগে মূল অ্যাপ ফাইলটাই প্রিক্যাশ লিস্টে ছিল না, প্রথমবার অনলাইনে না খুললে অফলাইনে অ্যাপই লোড হতো না
  "/manifest.json",
  "/icon-48.png",
  "/icon-72.png",
  "/icon-96.png",
  "/icon-128.png",
  "/icon-144.png",
  "/icon-192.png",
  "/icon-384.png",
  "/icon-512.png",
  "/icon-192-maskable.png",
  "/icon-512-maskable.png",
  "/favicon-16.png",
  "/favicon-32.png",
  "/apple-touch-icon-180.png"
];

// Install: pre-cache core assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch: network-first for navigations (HTML), cache-first for static assets
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== "GET") return;

  // Never intercept API/Firebase backend calls — let them go straight to the network.
  // ব্যতিক্রম: gstatic.com থেকে আসা Firebase SDK-এর স্ট্যাটিক JS ফাইলগুলো (firebasejs/...) —
  // এগুলো নিরাপদে ক্যাশ করা যায় (এগুলো কোনো ইউজার-ডেটা API কল না, শুধু লাইব্রেরি কোড),
  // ✅ বাগ-ফিক্স: আগে এগুলো ক্যাশ হতো না, তাই ইন্টারনেট ছাড়া অ্যাপ খুললে Firebase SDK-ই লোড হতো না
  const url = new URL(request.url);
  const isFirebaseSdkScript = url.hostname === "www.gstatic.com" && url.pathname.includes("/firebasejs/");
  if (!isFirebaseSdkScript && (url.origin !== self.location.origin || url.pathname.startsWith("/api/"))) {
    return;
  }
  if (isFirebaseSdkScript) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  if (request.mode === "navigate") {
    // Network-first for page navigations, falling back to cache, then to index.html
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(
          () =>
            caches.match(request).then((cached) => cached || caches.match("/index.html"))
        )
    );
    return;
  }

  // Cache-first for static assets (icons, css, js, etc.)
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
