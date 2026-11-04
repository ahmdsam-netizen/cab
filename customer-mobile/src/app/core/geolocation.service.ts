import { locationWatchers } from './location-watcher-registry';
import { Injectable } from '@angular/core';
import { Geolocation, PermissionStatus } from '@capacitor/geolocation';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { App } from '@capacitor/app';

export type LatLng = { lat: number; lng: number };

export interface GeoFix extends LatLng {
  accuracy: number | null;
  speed: number | null;
  bearing: number | null;
  timestamp: number;
}

export type WatchCallback = (fix: GeoFix | null, err: unknown) => void;

interface WatchOptions {
  enableHighAccuracy?: boolean;
  timeout?: number;
  maximumAge?: number;
}

/**
 * Single chokepoint for geolocation across the customer app.
 * Passes straight through to @capacitor/geolocation with browser fallback.
 */
@Injectable({ providedIn: 'root' })
export class GeolocationService {
  private lastFix: (LatLng & { timestamp: number }) | null = null;
  private lastLocationPingAt = 0;
  private active = document.visibilityState !== 'hidden';
  private watchSequence = 0;
  private watches = new Map<string, { options: WatchOptions; callback: WatchCallback; nativeId?: string; revision: number }>();

  constructor(
    private api: ApiService,
    private auth: AuthService,
  ) {
    document.addEventListener('visibilitychange', () => this.setActive(document.visibilityState !== 'hidden'));
    void App.addListener('appStateChange', state => this.setActive(state.isActive));
    auth.registerSessionCleanup(async () => {
      this.lastFix = null;
      await Promise.all([...this.watches.keys()].map(id => this.clearWatch(id)));
    });
  }

  recentPosition(): LatLng | null {
    return this.lastFix && Date.now() - this.lastFix.timestamp <= 30_000 ? this.lastFix : null;
  }

  private rememberPosition(position: LatLng, timestamp: number): void {
    if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return;
    if (!this.lastFix || timestamp >= this.lastFix.timestamp) this.lastFix = { ...position, timestamp };
  }

  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    for (const [id, watch] of this.watches) {
      ++watch.revision;
      if (watch.nativeId) {
        void locationWatchers.remove('foreground', watch.nativeId);
        watch.nativeId = undefined;
      }
      if (active) void this.startWatch(id);
    }
  }

  private syncUserLocation(lat: number, lng: number): void {
    if (!this.active) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const now = Date.now();
    if (now - this.lastLocationPingAt < 3000) return;
    if (!this.auth.getToken()) return;
    this.lastLocationPingAt = now;
    this.api.post('/me/location', { lat, lng }).subscribe({
      error: () => {},
    });
  }

  async requestPermissions(): Promise<PermissionStatus | null> {
    try {
      return await Geolocation.requestPermissions();
    } catch {
      return null;
    }
  }

  /** Convenience used widely by the customer-book and trip-active screens. */
  async getCurrentPosition(): Promise<LatLng | null> {
    if (!this.active) return null;
    try {
      const perm = await Geolocation.checkPermissions();
      if (perm.location !== 'granted') {
        const req = await Geolocation.requestPermissions();
        if (req.location !== 'granted') return this.browserFallback();
      }
      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 8000,
      });
      const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      this.rememberPosition(coords, pos.timestamp);
      this.syncUserLocation(coords.lat, coords.lng);
      return coords;
    } catch {
      return this.browserFallback();
    }
  }

  /** Long-form fix (used by trip-active so it can render a heading-aware marker). */
  async getCurrentFix(): Promise<GeoFix | null> {
    if (!this.active) return null;
    try {
      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 8000,
      });
      const fix: GeoFix = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy ?? null,
        speed: pos.coords.speed ?? null,
        bearing: pos.coords.heading ?? null,
        timestamp: pos.timestamp,
      };
      this.rememberPosition(fix, fix.timestamp);
      this.syncUserLocation(fix.lat, fix.lng);
      return fix;
    } catch {
      return null;
    }
  }

  async watchPosition(options: WatchOptions, callback: WatchCallback): Promise<string> {
    const id = `foreground-${++this.watchSequence}`;
    this.watches.set(id, { options, callback, revision: 0 });
    if (this.active) await this.startWatch(id);
    return id;
  }

  private async startWatch(id: string): Promise<void> {
    const watch = this.watches.get(id);
    if (!watch || !this.active) return;
    const { options, callback } = watch;
    const revision = ++watch.revision;
    try {
    const nativeId = await locationWatchers.add('foreground', () => Geolocation.watchPosition(
      {
        enableHighAccuracy: options.enableHighAccuracy ?? true,
        timeout: options.timeout ?? 30000,
        maximumAge: options.maximumAge ?? 4000,
      },
      (pos, err) => {
        if (!this.active || this.watches.get(id) !== watch || watch.revision !== revision) return;
        if (err) {
          callback(null, err);
          return;
        }
        if (pos) {
          const fix: GeoFix = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy ?? null,
            speed: pos.coords.speed ?? null,
            bearing: pos.coords.heading ?? null,
            timestamp: pos.timestamp,
          };
            this.rememberPosition(fix, fix.timestamp);
          this.syncUserLocation(fix.lat, fix.lng);
          callback(fix, null);
        }
      },
    ), id => Geolocation.clearWatch({ id }));
    if (!this.active || this.watches.get(id) !== watch || watch.revision !== revision) {
      await locationWatchers.remove('foreground', nativeId);
      return;
    }
    watch.nativeId = nativeId;
    } catch (error) {
      if (this.watches.get(id) === watch && watch.revision === revision) callback(null, error);
    }
  }

  async clearWatch(id: string): Promise<void> {
    const watch = this.watches.get(id);
    this.watches.delete(id);
    if (!watch?.nativeId) return;
    await locationWatchers.remove('foreground', watch.nativeId);
  }

  private browserFallback(): Promise<LatLng | null> {
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const coords = { lat: p.coords.latitude, lng: p.coords.longitude };
          this.rememberPosition(coords, p.timestamp);
          resolve(coords);
        },
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 }
      );
    });
  }
}
