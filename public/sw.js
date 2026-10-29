// Herald service worker: shows pushes and opens the notification when tapped.
// Kept tiny on purpose; it does no caching, so deploys are never stale.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Herald", body: event.data ? event.data.text() : "" };
  }
  const tasks = [
    self.registration.showNotification(data.title || "Herald", {
      body: data.body || "",
      tag: data.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { id: data.id || null },
    }),
  ];
  if (typeof data.badge === "number" && "setAppBadge" in self.navigator) {
    tasks.push(data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge());
  }
  event.waitUntil(Promise.all(tasks).catch(() => undefined));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.id;
  const url = id ? `/?open=${encodeURIComponent(id)}` : "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if ("focus" in client) {
          client.postMessage({ type: "open", id });
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
