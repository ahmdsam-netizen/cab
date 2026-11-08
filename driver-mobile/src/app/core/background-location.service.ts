import { locationWatchers } from './location-watcher-registry';
import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { ApiService } from './api.service';
import { GeolocationService } from './geolocation.service';
import { AuthService } from './auth.service';
import { LocationConsentService } from './location-consent.service';

type Location = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number | null;
  bearing?: number | null;
  time?: number;
};

type WatcherOptions = {
  backgroundMessage?: string;
  backgroundTitle?: string;
  requestPermissions?: boolean;
  stale?: boolean;
  distanceFilter?: number;
};

type BackgroundGeolocationPlugin = {
  addWatcher(
    options: WatcherOptions,
    callback: (location: Location | null, error: any) => void
  ): Promise<string>;
  removeWatcher(options: { id: string }): Promise<void>;
  openSettings(): Promise<void>;
};

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

@Injectable({ providedIn: 'root' })
export class BackgroundLocationService {
  private watcherId: string | null = null;
  private currentTripId: number | null = null;
  private webIntervalHandle: any = null;
  private lastSentAt = 0;
  private readonly minIntervalMs = 5000;

  private generation = 0;
  constructor(private api: ApiService, private geo: GeolocationService,
    private auth: AuthService, private consent: LocationConsentService) {
    auth.registerSessionCleanup(() => this.stop());
  }

  isStreaming(): boolean {
    return this.watcherId != null || this.webIntervalHandle != null;
  }

  async start(tripId: number): Promise<void> {
    if (this.isStreaming() && this.currentTripId === tripId) return;
    if (this.isStreaming()) await this.stop();

    const generation = ++this.generation;
    if (!(await this.consent.ensure()) || generation !== this.generation) return;

    this.currentTripId = tripId;

    if (Capacitor.isNativePlatform()) {
      const id = await locationWatchers.add('background', () => BackgroundGeolocation.addWatcher(
        {
          backgroundTitle: 'Cabbies is sharing your location',
          backgroundMessage: 'Your location is being shared with the rider during this trip.',
          requestPermissions: true,
          stale: false,
          distanceFilter: 5,
        },
        (location, error) => {
          if (error) {
            console.warn('BackgroundLocation error', error);
            return;
          }
          if (!location || generation !== this.generation || !this.auth.getToken()) return;
          this.postLocation(location);
        }
      ), id => BackgroundGeolocation.removeWatcher({ id }));
      if (generation !== this.generation || !this.auth.getToken()) {
        await locationWatchers.remove('background', id);
        return;
      }
      this.watcherId = id;
    } else {
      // Web fallback: foreground-only via GeolocationService (honours dev override).
      const id = await this.geo.watchPosition(
        { enableHighAccuracy: true, maximumAge: 4000, timeout: 8000 },
        (fix, err) => {
          if (err || !fix || generation !== this.generation || !this.auth.getToken()) return;
          this.postLocation({
            latitude: fix.lat,
            longitude: fix.lng,
            accuracy: fix.accuracy ?? undefined,
            speed: fix.speed,
            bearing: fix.bearing,
            time: fix.timestamp,
          });
        }
      );
      if (generation !== this.generation || !this.auth.getToken()) {
        await this.geo.clearWatch(id);
        return;
      }
      this.webIntervalHandle = id;
    }
  }

  async stop(): Promise<void> {
    ++this.generation;
    this.currentTripId = null;
    if (this.watcherId) {
      await locationWatchers.remove('background', this.watcherId);
      this.watcherId = null;
    }
    if (this.webIntervalHandle) {
      await this.geo.clearWatch(this.webIntervalHandle);
      this.webIntervalHandle = null;
    }
    this.currentTripId = null;
    this.lastSentAt = 0;
  }

  private postLocation(loc: Location): void {
    if (!this.currentTripId || !this.auth.getToken()) return;
    const now = Date.now();
    if (now - this.lastSentAt < this.minIntervalMs) return;

    // Skip when essentially stationary to avoid hammering the endpoint.
    const speedKmh =
      loc.speed != null && Number.isFinite(loc.speed) ? Math.max(0, loc.speed) * 3.6 : null;

    this.lastSentAt = now;
    this.api
      .post(`/trips/${this.currentTripId}/location`, {
        lat: loc.latitude,
        lng: loc.longitude,
        accuracy_m: loc.accuracy ?? null,
        speed_kmh: speedKmh,
        bearing_deg: loc.bearing ?? null,
      })
      .subscribe({
        error: (err: any) => {
          // 409 means the trip is no longer in an active driver state — customer
          // cancelled, trip completed, or the driver lost it. Stop streaming.
          if ([401, 403, 409].includes(err?.status)) {
            void this.stop();
            return;
          }
          // 429 is the server-side dedupe (same trip+driver wrote <3s ago);
          // the last good location is still on file. Push lastSentAt forward
          // so we don't re-fire immediately and keep racing the server.
          if (err?.status === 429) {
            this.lastSentAt = Date.now();
            return;
          }
        },
      });
  }
}
