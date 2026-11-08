import { Injectable } from '@angular/core';
import { NavController } from '@ionic/angular';
import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { App as CapacitorApp } from '@capacitor/app';
import { FirebaseMessaging } from '@capacitor-firebase/messaging';
import { ApiService } from './api.service';
import { environment } from '../../environments/environment';

/** Real device name + OS version + app version for the admin detail pages. */
export interface DeviceDetails {
  device_type?: string;
  os_version?: string;
  app_version?: string;
}

/**
 * Reads the real device name (manufacturer + model, e.g. "samsung SM-G991B"),
 * OS version (e.g. "Android 14") and app version via the Capacitor Device/App
 * plugins. Every field is best-effort — failures just leave it unset.
 */
export async function gatherDeviceDetails(): Promise<DeviceDetails> {
  const out: DeviceDetails = {};
  try {
    const d = await Device.getInfo();
    const name = [d.manufacturer, d.model]
      .map((s) => (s || '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();
    if (name) out.device_type = name.slice(0, 64);

    const osName =
      d.operatingSystem === 'ios'
        ? 'iOS'
        : d.operatingSystem
          ? d.operatingSystem.charAt(0).toUpperCase() + d.operatingSystem.slice(1)
          : '';
    const os = [osName, d.osVersion].filter(Boolean).join(' ').trim();
    if (os) out.os_version = os.slice(0, 32);
  } catch {
    /* ignore — leave device fields unset */
  }
  try {
    if (Capacitor.isNativePlatform()) {
      const app = await CapacitorApp.getInfo();
      if (app?.version) out.app_version = String(app.version).slice(0, 32);
    }
  } catch {
    /* ignore */
  }
  return out;
}

@Injectable({ providedIn: 'root' })
export class PushService {
  private currentToken: string | null = null;
  private listenersBound = false;

  constructor(private api: ApiService, private nav: NavController) {}

  async registerForUser(): Promise<void> {
    try {
      const perm = await FirebaseMessaging.requestPermissions();
      if (perm.receive !== 'granted') return;

      this.bindListenersOnce();

      const platform = Capacitor.getPlatform();
      if (platform === 'web' && !environment.fcmVapidKey) {
        return;
      }
      const opts =
        platform === 'web' && environment.fcmVapidKey
          ? { vapidKey: environment.fcmVapidKey }
          : undefined;

      const { token } = await FirebaseMessaging.getToken(opts as any);
      if (!token) return;

      this.currentToken = token;
      const device = await gatherDeviceDetails();
      this.api
        .post('/me/device-tokens', { platform, token, ...device })
        .subscribe({ error: () => {} });
    } catch (e) {
      console.warn('PushService.registerForUser failed', e);
    }
  }

  /**
   * Reports the device name + OS + app version on login, independent of
   * notification permission (uses /me/device-info, no push token). Best-effort.
   */
  async reportDeviceInfo(): Promise<void> {
    try {
      const device = await gatherDeviceDetails();
      if (device.device_type || device.os_version || device.app_version) {
        this.api.post('/me/device-info', device).subscribe({ error: () => {} });
      }
    } catch {
      /* ignore */
    }
  }

  async unregister(): Promise<void> {
    if (!this.currentToken) return;
    const token = this.currentToken;
    this.currentToken = null;
    try {
      await this.api.delete(`/me/device-tokens/${encodeURIComponent(token)}`).toPromise();
    } catch {
      /* ignore */
    }
    try {
      await FirebaseMessaging.deleteToken();
    } catch {
      /* ignore */
    }
  }

  private bindListenersOnce(): void {
    if (this.listenersBound) return;
    this.listenersBound = true;

    FirebaseMessaging.addListener('tokenReceived', async (event) => {
      const token = event.token;
      if (!token || token === this.currentToken) return;
      this.currentToken = token;
      const device = await gatherDeviceDetails();
      this.api
        .post('/me/device-tokens', { platform: Capacitor.getPlatform(), token, ...device })
        .subscribe({ error: () => {} });
    });

    FirebaseMessaging.addListener('notificationActionPerformed', (event) => {
      const data = (event.notification?.data || {}) as Record<string, unknown>;
      const tripId = data['trip_id'];
      if (tripId != null) {
        this.nav.navigateForward(`/customer-tabs/trip/${tripId}`);
      }
    });

    FirebaseMessaging.addListener('notificationReceived', () => {
      // Foreground: the app is open. The realtime channel typically already updated UI;
      // we intentionally leave this silent rather than firing duplicate toasts.
    });
  }
}
