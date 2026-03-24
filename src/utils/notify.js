/**
 * notify.js – lightweight desktop-notification helper.
 *
 * Usage:
 *   import { requestNotifyPermission, notify, notifyEnabled } from './notify.js';
 *
 *   await requestNotifyPermission();   // call on user gesture (button click)
 *   notify('Benchmark complete', 'N-10W · 25 K nodes · 4.2 avg hops');
 */

// ── Permission state ──────────────────────────────────────────────────────────

/**
 * Returns true if the browser supports notifications AND permission
 * has already been granted.
 */
export function notifyEnabled() {
  return typeof Notification !== 'undefined' &&
         Notification.permission === 'granted';
}

/**
 * Request notification permission.  Must be called from a user-gesture
 * handler (button click).  Resolves to true if permission was granted.
 * @returns {Promise<boolean>}
 */
export async function requestNotifyPermission() {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted')  return true;
  if (Notification.permission === 'denied')   return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

// ── Send a notification ───────────────────────────────────────────────────────

/**
 * Show a desktop notification.  Silently no-ops if permission is not granted.
 *
 * @param {string} title   – bold first line
 * @param {string} [body]  – detail text
 * @param {object} [opts]  – extra Notification options (icon, tag, …)
 */
export function notify(title, body = '', opts = {}) {
  if (!notifyEnabled()) return;
  const n = new Notification(title, {
    body,
    icon: '/favicon.ico',   // use app icon if present; silently ignored if missing
    tag:  'dht-sim',        // replaces previous notification instead of stacking
    ...opts,
  });
  // Auto-close after 6 seconds so it doesn't clutter the notification centre
  setTimeout(() => n.close(), 6000);
}
