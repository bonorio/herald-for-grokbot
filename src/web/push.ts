import { request } from "./api";

export type PushState =
  | "unsupported" // no service worker or Push API
  | "needs-install" // iPhone Safari tab: must be opened from the Home Screen
  | "server-off" // server has no VAPID keys
  | "denied"
  | "off"
  | "on";

function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export function registerServiceWorker() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

export async function pushState(): Promise<{ state: PushState; devices: number }> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { state: isIos() && !isStandalone() ? "needs-install" : "unsupported", devices: 0 };
  }
  const config = await request<{ configured: boolean; devices: number }>("/api/push");
  if (!config.configured) return { state: "server-off", devices: config.devices };
  if (Notification.permission === "denied") return { state: "denied", devices: config.devices };
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return { state: subscription ? "on" : "off", devices: config.devices };
}

/** Must run from a tap: iOS only shows the permission prompt for a user gesture. */
export async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications were not allowed");
  const { publicKey } = await request<{ publicKey: string | null }>("/api/push");
  if (!publicKey) throw new Error("Push is not configured on the server");
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64urlToBytes(publicKey) }));
  await request("/api/push/subscriptions", { method: "POST", json: subscription.toJSON() });
}

export async function disablePush(): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await request("/api/push/subscriptions", { method: "DELETE", json: { endpoint: subscription.endpoint } });
  await subscription.unsubscribe();
}

/** Keeps the Home Screen badge in step with unread notifications. */
export function setBadge(count: number) {
  const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  (count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.())?.catch(() => undefined);
}
