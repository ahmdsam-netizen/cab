import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { City, EMPTY_TRIP, MODE_COPY, Place, RideMode, ServiceTile, TripDraft, TripScope } from './booking.models';

/**
 * Holds the draft trip across screens and talks to the app's existing
 * endpoints. No new backend — the flows wire to what already ships:
 * `/pricing/cities/{id}/products`, `/pricing/estimate`, `/trips`, the fixed
 * endpoints and `/shuttle/bookings`.
 */
@Injectable({ providedIn: 'root' })
export class BookingService {
  // rev5 — draft trip + catalogue, wired to existing endpoints.
  private draft: TripDraft = { ...EMPTY_TRIP };
  private readonly supportCityKey = 'dc.support.city-id';

  constructor(private api: ApiService) {}

  get trip(): TripDraft {
    return this.draft;
  }

  get supportCityId(): number | null {
    if (this.draft.cityId) return this.draft.cityId;
    try {
      const cityId = Number(sessionStorage.getItem(this.supportCityKey));
      return Number.isSafeInteger(cityId) && cityId > 0 ? cityId : null;
    } catch { return null; }
  }

  setScope(scope: TripScope): void {
    this.draft.scope = scope;
  }

  setMode(mode: RideMode, rideTypeId: number | null = null): void {
    this.draft.mode = mode;
    this.draft.rideTypeId = rideTypeId;
  }

  setPickup(place: Place): void {
    this.draft.pickup = place;
  }

  setDrop(place: Place): void {
    this.draft.drop = place;
  }

  setCity(cityId: number | null): void {
    this.draft.cityId = cityId;
    try {
      if (cityId && Number.isSafeInteger(cityId) && cityId > 0) {
        sessionStorage.setItem(this.supportCityKey, String(cityId));
      } else { sessionStorage.removeItem(this.supportCityKey); }
    } catch { /* In-memory city remains usable when storage is unavailable. */ }
  }

  reset(): void {
    this.draft = { ...EMPTY_TRIP };
  }

  // ---- the server -------------------------------------------------------

  savedPlaces(): Promise<{ data?: any[] }> {
    return firstValueFrom(this.api.get<{ data?: any[] }>('/me/saved-locations'));
  }

  async cities(): Promise<City[]> {
    const res = await firstValueFrom(this.api.get<{ data?: City[] }>('/pricing/cities'));
    return res?.data ?? [];
  }

  /**
   * The city's service catalogue, grouped by scope, as the operator switched
   * it on. `tilesFor(scope)` flattens the chosen scope into one row of tiles.
   */
  async catalog(cityId: number): Promise<RawScope[]> {
    const res = await firstValueFrom(
      this.api.get<{ scopes?: RawScope[] }>(`/pricing/cities/${cityId}/products`),
    );
    return res?.scopes ?? [];
  }
}

export interface RawScope {
  scope: TripScope;
  name: string;
  modes: { mode: RideMode | null; kind?: string; name: string; display_name?: string | null; image_url?: string | null; ride_type_id?: number; id?: number }[];
}

/**
 * Flatten one scope's modes into home-screen tiles.
 *
 * The catalogue tree is how the service is *administered*; a rider just wants
 * "a car" or "a seat", so each mode shows once with plain wording.
 */
export function tilesFor(scopes: RawScope[], scope: TripScope): ServiceTile[] {
  const match = scopes.find((s) => s.scope === scope);
  if (!match) return [];

  const tiles: ServiceTile[] = [];
  const seen = new Set<RideMode>();

  for (const m of match.modes ?? []) {
    const mode = (m.mode ?? (m.kind === 'fixed' || m.kind === 'shuttle' ? m.kind : 'private')) as RideMode;
    if (seen.has(mode)) continue;
    seen.add(mode);
    const copy = MODE_COPY[mode];
    tiles.push({ mode, ...copy, title: m.display_name || copy.title, imageUrl: m.image_url, rideTypeId: m.ride_type_id ?? m.id ?? null });
  }

  return tiles;
}

/** Which scopes the operator actually runs — decides if the switch shows. */
export function scopesOffered(scopes: RawScope[]): TripScope[] {
  return scopes.filter((s) => (s.modes ?? []).length > 0).map((s) => s.scope);
}

/**
 * Which city is the rider standing in?
 *
 * This matters more than it looks: the catalogue is per city, so picking the
 * wrong one silently removes real services. Sopore has fixed routes and
 * Kupwara does not — take the first city in the list and a Sopore rider is
 * told "Share a seat" doesn't exist.
 *
 * A city whose boundary contains the point wins. Failing that we fall back to
 * the nearest city centre, so the screen still works rather than dead-ending.
 */
export function resolveCity(cities: City[], lat: number, lng: number): City | null {
  const containing = cities.find(
    (c) => Array.isArray(c.boundary_polygon)
      && c.boundary_polygon.length >= 3
      && pointInPolygon(lat, lng, c.boundary_polygon),
  );
  return containing ?? nearestCity(cities, lat, lng);
}

export function nearestCity(cities: City[], lat: number, lng: number): City | null {
  let best: City | null = null;
  let bestKm = Number.POSITIVE_INFINITY;
  for (const c of cities) {
    if (c.center_lat == null || c.center_lng == null) continue;
    const km = distanceKm(lat, lng, Number(c.center_lat), Number(c.center_lng));
    if (km < bestKm) { bestKm = km; best = c; }
  }
  return best;
}

/** Ray casting. Accepts {lat,lng} objects or [lat,lng] pairs. */
export function pointInPolygon(lat: number, lng: number, polygon: any[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = Number(polygon[i]?.lat ?? polygon[i]?.[0] ?? 0);
    const xi = Number(polygon[i]?.lng ?? polygon[i]?.[1] ?? 0);
    const yj = Number(polygon[j]?.lat ?? polygon[j]?.[0] ?? 0);
    const xj = Number(polygon[j]?.lng ?? polygon[j]?.[1] ?? 0);
    const intersects = (yi > lat) !== (yj > lat)
      && lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Haversine, in km. */
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
