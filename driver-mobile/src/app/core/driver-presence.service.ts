import { locationWatchers } from './location-watcher-registry';
import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { ApiService } from './api.service';
import { GeoFix, GeolocationService } from './geolocation.service';
import { AuthService } from './auth.service';
import { LocationConsentService } from './location-consent.service';

export type PresenceError =
  | { code: 'permission_denied'; message: string }
  | { code: 'position_unavailable'; message: string }
  | { code: 'timeout'; message: string }
  | { code: 'unknown'; message: string };

export interface PresenceFix {
  lat: number;
  lng: number;
  accuracy: number | null;
  speedKmh: number | null;
  bearing: number | null;
}

type BackgroundLocation = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number | null;
  bearing?: number | null;
  time?: number;
};

type BackgroundGeolocationPlugin = {
  addWatcher(
    options: {
      backgroundMessage?: string;
      backgroundTitle?: string;
      requestPermissions?: boolean;
      stale?: boolean;
      distanceFilter?: number;
    },
    callback: (location: BackgroundLocation | null, error: any) => void
  ): Promise<string>;
  removeWatcher(options: { id: string }): Promise<void>;
};

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

/**
 * Streams the driver's location to the backend whenever they're online,
 * outside of an active trip. Trip-time pings still go through
 * BackgroundLocationService (which is trip-scoped).
 *
 * Without this, drivers show as "Inactive" on the dispatch console — the
 * snapshot only marks a driver "Free" when both `is_online=true` AND there's
 * a fresh driver_locations row in the last 5 minutes.
 */
@Injectable({ providedIn: 'root' })
export class DriverPresenceService {
  private watchId: string | null = null;
  private nativeBackgroundWatch = false;
  private lastSentAt = 0;
  private readonly minIntervalMs = 10000;
  private highAccuracy = true;
  private errorListener: ((err: PresenceError) => void) | null = null;
  private locatedListener: ((fix: PresenceFix) => void) | null = null;

  private lastNotifiedErrorCode: PresenceError['code'] | null = null;
  private consecutiveTimeouts = 0;

  private generation = 0;
  constructor(private api: ApiService, private geo: GeolocationService,
    private auth: AuthService, private consent: LocationConsentService) {
    auth.registerSessionCleanup(() => this.stop());
  }

  isStreaming(): boolean {
    return this.watchId != null;
  }

  onError(listener: (err: PresenceError) => void): void {
    this.errorListener = listener;
  }

  onLocated(listener: (fix: PresenceFix) => void): void {
    this.locatedListener = listener;
  }

  async start(): Promise<void> {
    if (this.watchId) return;
    const generation = ++this.generation;
    if (!(await this.consent.ensure()) || generation !== this.generation) return;
    this.highAccuracy = true;
    this.consecutiveTimeouts = 0;
    this.lastNotifiedErrorCode = null;

    await this.geo.requestPermissions();
    if (generation !== this.generation || !this.auth.getToken()) return;

    try {
      const fix = await this.geo.getCurrentPosition({
        enableHighAccuracy: this.highAccuracy,
        maximumAge: 0,
        timeout: 20000,
      });
      if (fix && generation === this.generation && this.auth.getToken()) {
        this.notifyLocated(fix);
        this.postLocation(fix);
      }
    } catch (err) {
      this.handlePositionError(err, 'initial');
    }

    if (generation === this.generation && this.auth.getToken()) await this.attachWatcher();
  }

  async stop(): Promise<void> {
    ++this.generation;
    if (!this.watchId) return;
    if (this.nativeBackgroundWatch) {
      await locationWatchers.remove('background', this.watchId);
    } else {
      await this.geo.clearWatch(this.watchId);
    }
    this.watchId = null;
    this.nativeBackgroundWatch = false;
    this.lastSentAt = 0;
    this.lastNotifiedErrorCode = null;
    this.consecutiveTimeouts = 0;
  }

  private async attachWatcher(): Promise<void> {
    const generation = this.generation;
    if (!this.auth.getToken()) return;
    if (Capacitor.isNativePlatform()) {
      this.nativeBackgroundWatch = true;
      const id = await locationWatchers.add('background', () => BackgroundGeolocation.addWatcher(
        {
          backgroundTitle: 'Cabbies is using your location',
          backgroundMessage: 'Your location is shared while you are online or working on an active ride.',
          requestPermissions: true,
          stale: false,
          distanceFilter: 10,
        },
        (location, err) => {
          if (generation !== this.generation || !this.auth.getToken()) return;
          if (err) {
            this.handlePositionError(err, 'watch');
            return;
          }
          if (!location || generation !== this.generation || !this.auth.getToken()) return;
          const fix: GeoFix = {
            lat: location.latitude,
            lng: location.longitude,
            accuracy: location.accuracy ?? null,
            speed: location.speed ?? null,
            bearing: location.bearing ?? null,
            timestamp: location.time ?? Date.now(),
          };
          this.notifyLocated(fix);
          this.postLocation(fix);
        },
      ), id => BackgroundGeolocation.removeWatcher({ id }));
      if (generation !== this.generation || !this.auth.getToken()) {
        await locationWatchers.remove('background', id);
        return;
      }
      this.watchId = id;
      return;
    }

    this.nativeBackgroundWatch = false;
    const id = await this.geo.watchPosition(
      { enableHighAccuracy: this.highAccuracy, maximumAge: 4000, timeout: 30000 },
      (fix, err) => {
        if (generation !== this.generation || !this.auth.getToken()) return;
        if (err) {
          this.handlePositionError(err, 'watch');
          return;
        }
        if (fix && generation === this.generation && this.auth.getToken()) {
          this.notifyLocated(fix);
          this.postLocation(fix);
        }
      },
    );
    if (generation !== this.generation || !this.auth.getToken()) {
      await this.geo.clearWatch(id);
      return;
    }
    this.watchId = id;
  }

  private notifyLocated(fix: GeoFix): void {
    if (!this.locatedListener) return;
    const speedKmh =
      fix.speed != null && Number.isFinite(fix.speed) ? Math.max(0, fix.speed) * 3.6 : null;
    const bearing =
      fix.bearing != null && Number.isFinite(fix.bearing) ? Math.round(fix.bearing) : null;
    this.locatedListener({
      lat: fix.lat,
      lng: fix.lng,
      accuracy: fix.accuracy,
      speedKmh,
      bearing,
    });
  }

  private handlePositionError(err: unknown, source: 'initial' | 'watch'): void {
    const decoded = this.decodeGeoError(err);
    console.warn(`DriverPresence ${source} error`, decoded.code, decoded.message, err);

    if (decoded.code === 'permission_denied') {
      this.notifyError(decoded);
      void this.stop();
      return;
    }

    if (decoded.code === 'timeout') {
      this.consecutiveTimeouts += 1;
      if (this.consecutiveTimeouts >= 2) {
        this.notifyError(decoded);
      }
    } else {
      this.notifyError(decoded);
    }

    if (this.highAccuracy && (decoded.code === 'position_unavailable' || decoded.code === 'timeout')) {
      this.highAccuracy = false;
      void this.restartWatcher();
    }
  }

  private notifyError(err: PresenceError): void {
    if (this.lastNotifiedErrorCode === err.code) return;
    this.lastNotifiedErrorCode = err.code;
    this.errorListener?.(err);
  }

  private async restartWatcher(): Promise<void> {
    const generation = this.generation;
    if (this.watchId) {
      if (this.nativeBackgroundWatch) {
        await locationWatchers.remove('background', this.watchId);
      } else {
        await this.geo.clearWatch(this.watchId);
      }
      this.watchId = null;
      this.nativeBackgroundWatch = false;
    }
    if (generation === this.generation && this.auth.getToken()) await this.attachWatcher();
  }

  private decodeGeoError(err: unknown): PresenceError {
    const code = (err as { code?: number })?.code;
    const message = (err as { message?: string })?.message || 'Unknown geolocation error';
    if (code === 1) return { code: 'permission_denied', message: 'Location permission denied. Enable it in your browser/OS settings to receive rides.' };
    if (code === 2) return { code: 'position_unavailable', message: 'Could not determine your location. Check that location services are enabled.' };
    if (code === 3) return { code: 'timeout', message: 'Still trying to get a GPS fix — move to a spot with a clearer view of the sky.' };
    return { code: 'unknown', message };
  }

  private postLocation(fix: GeoFix): void {
    if (!this.auth.getToken()) return;
    const now = Date.now();
    if (now - this.lastSentAt < this.minIntervalMs) return;
    this.lastSentAt = now;

    const speedKmh =
      fix.speed != null && Number.isFinite(fix.speed) ? Math.max(0, fix.speed) * 3.6 : null;
    const bearing =
      fix.bearing != null && Number.isFinite(fix.bearing) ? Math.round(fix.bearing) : null;

    this.api
      .post('/drivers/location', {
        lat: fix.lat,
        lng: fix.lng,
        accuracy_m: fix.accuracy,
        speed_kmh: speedKmh,
        bearing_deg: bearing,
      })
      .subscribe({
        next: () => {
          this.consecutiveTimeouts = 0;
          this.lastNotifiedErrorCode = null;
        },
        error: (err: any) => {
          if ([401, 403].includes(err?.status)) {
            void this.stop();
            return;
          }
          if (err?.status !== 429) {
            console.warn('DriverPresence ping failed', err?.status, err?.error);
          }
        },
      });
  }
}
