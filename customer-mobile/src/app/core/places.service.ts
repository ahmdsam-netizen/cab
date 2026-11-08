import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

declare const google: any;

export type PlaceSuggestion = {
  place_id: string;
  description: string;
  main_text: string;
  secondary_text: string;
};

export type PlaceDetail = {
  place_id: string;
  description: string;
  lat: number;
  lng: number;
};

@Injectable({ providedIn: 'root' })
export class PlacesService {
  private scriptPromise: Promise<void> | null = null;
  private sessionToken: any | null = null;
  private localPlacesCache = new Map<string, PlaceDetail>();

  constructor(private http: HttpClient) {}

  async ensureLoaded(): Promise<void> {
    if ((window as any).google?.maps?.places) return;
    if (this.scriptPromise) return this.scriptPromise;

    const apiKey = environment.googleMapsApiKey;
    if (!apiKey || apiKey.startsWith('REPLACE_WITH')) {
      return Promise.reject(new Error('Google Maps API key is not configured.'));
    }

    this.scriptPromise = new Promise<void>((resolve, reject) => {
      const cbName = '__sharedInitGoogleMaps';
      const existing = document.getElementById('shared-google-maps-script');
      if (existing) {
        const tick = () => ((window as any).google?.maps?.places ? resolve() : setTimeout(tick, 50));
        tick();
        return;
      }
      (window as any)[cbName] = () => resolve();
      const script = document.createElement('script');
      script.id = 'shared-google-maps-script';
      script.async = true;
      script.defer = true;
      script.onerror = () => reject(new Error('Failed to load Google Maps JavaScript API.'));
      // Libraries:
      //   places  → AutocompleteSuggestion / Place (replaces AutocompleteService)
      //   marker  → AdvancedMarkerElement (replaces google.maps.Marker)
      //   routes  → Route.computeRoutes (replaces DirectionsService/Renderer)
      script.src =
        `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}` +
        '&libraries=places,marker,routes' +
        '&loading=async' +
        `&callback=${cbName}`;
      document.head.appendChild(script);
    });
    return this.scriptPromise;
  }

  /**
   * Issue a fresh session token. Used to bundle an autocomplete query +
   * details fetch into a single billable session per Place selection.
   */
  private ensureSession(): void {
    if (!this.sessionToken) {
      this.sessionToken = new google.maps.places.AutocompleteSessionToken();
    }
  }

  /**
   * Query the backend local database search endpoint for seeded landmarks
   * and saved locations.
   */
  private async searchBackendPlaces(query: string): Promise<PlaceSuggestion[]> {
    try {
      const url = `${environment.apiUrl}/places/search?q=${encodeURIComponent(query)}`;
      const res = await firstValueFrom(this.http.get<{ data?: any[] }>(url));
      const items = res?.data ?? [];
      return items.map((r: any) => {
        const detail: PlaceDetail = {
          place_id: r.place_id,
          description: r.description,
          lat: Number(r.lat),
          lng: Number(r.lng),
        };
        this.localPlacesCache.set(r.place_id, detail);
        return {
          place_id: r.place_id,
          description: r.description,
          main_text: r.main_text,
          secondary_text: r.secondary_text,
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Autocomplete using Google Places API + fallback/merge with database places.
   * Ensures that test locations (e.g. Hazratbal, Lal Chowk) always show up
   * even if Google API is offline, restricted, or unconfigured.
   */
  async autocompleteSearch(query: string, near?: { lat: number; lng: number }): Promise<PlaceSuggestion[]> {
    if (!query || query.trim().length < 2) return [];

    let googleResults: PlaceSuggestion[] = [];
    try {
      await this.ensureLoaded();
      this.ensureSession();

      const opts: any = {
        input: query,
        sessionToken: this.sessionToken,
        includedRegionCodes: ['IN'],
      };
      if (near) {
        opts.locationBias = { center: { lat: near.lat, lng: near.lng }, radius: 50_000 };
      }

      const { suggestions } =
        await google.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions(opts);
      googleResults = (suggestions ?? [])
        .filter((s: any) => s?.placePrediction)
        .map((s: any) => {
          const p = s.placePrediction;
          const main = p.mainText?.text ?? p.text?.text ?? '';
          const secondary = p.secondaryText?.text ?? '';
          return {
            place_id: p.placeId,
            description: p.text?.text ?? main,
            main_text: main,
            secondary_text: secondary,
          };
        });
    } catch {
      googleResults = [];
    }

    // Always fetch database landmarks matching the query
    const localResults = await this.searchBackendPlaces(query);

    // Merge results, giving priority to matching local database records
    const seen = new Set<string>();
    const merged: PlaceSuggestion[] = [];

    for (const item of [...localResults, ...googleResults]) {
      const key = (item.main_text + '|' + item.description).toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }

    return merged;
  }

  /**
   * Place details via local cache / backend or Google Place class.
   */
  async getPlaceDetail(placeId: string): Promise<PlaceDetail | null> {
    if (this.localPlacesCache.has(placeId)) {
      return this.localPlacesCache.get(placeId)!;
    }

    try {
      await this.ensureLoaded();
      this.ensureSession();

      const place = new google.maps.places.Place({ id: placeId });
      await place.fetchFields({ fields: ['id', 'formattedAddress', 'displayName', 'location'] });
      if (!place.location) return null;
      // place.location is a LatLng instance — .lat() / .lng() are functions.
      const lat = typeof place.location.lat === 'function' ? place.location.lat() : place.location.lat;
      const lng = typeof place.location.lng === 'function' ? place.location.lng() : place.location.lng;
      // Session ends on details fetch; let the next search start a fresh one.
      this.sessionToken = null;
      return {
        place_id: place.id ?? placeId,
        description: place.formattedAddress ?? place.displayName ?? '',
        lat,
        lng,
      };
    } catch {
      this.sessionToken = null;
      return null;
    }
  }

  async reverseGeocode(lat: number, lng: number): Promise<string | null> {
    await this.ensureLoaded();
    const geocoder = new google.maps.Geocoder();
    return new Promise<string | null>((resolve) => {
      geocoder.geocode({ location: { lat, lng } }, (results: any[], status: string) => {
        if (status !== 'OK' || !results?.length) return resolve(null);
        const preferred = ['street_address', 'premise', 'route', 'sublocality', 'neighborhood', 'locality'];
        for (const want of preferred) {
          const hit = results.find((r) => Array.isArray(r.types) && r.types.includes(want));
          if (hit?.formatted_address) return resolve(hit.formatted_address);
        }
        const nonPlusCode = results.find(
          (r) => Array.isArray(r.types) && !r.types.includes('plus_code') && r.formatted_address
        );
        resolve(nonPlusCode?.formatted_address || results[0]?.formatted_address || null);
      });
    });
  }

  /**
   * Reverse geocodes coordinates to extract the human-readable locality / town / city name.
   * e.g., "Sopore", "Kupwara", "Baramulla", "Srinagar".
   */
  async reverseGeocodeCity(lat: number, lng: number): Promise<string | null> {
    await this.ensureLoaded();
    const geocoder = new google.maps.Geocoder();
    return new Promise<string | null>((resolve) => {
      geocoder.geocode({ location: { lat, lng } }, (results: any[], status: string) => {
        if (status !== 'OK' || !results?.length) return resolve(null);

        // 1. Look for 'locality' or 'postal_town' (e.g. "Sopore")
        for (const res of results) {
          if (Array.isArray(res.address_components)) {
            const hit = res.address_components.find((c: any) =>
              Array.isArray(c.types) && (c.types.includes('locality') || c.types.includes('postal_town'))
            );
            if (hit?.long_name) return resolve(hit.long_name);
          }
        }

        // 2. Look for 'sublocality_level_1' or 'sublocality' (e.g. "Model Town")
        for (const res of results) {
          if (Array.isArray(res.address_components)) {
            const hit = res.address_components.find((c: any) =>
              Array.isArray(c.types) && (c.types.includes('sublocality_level_1') || c.types.includes('sublocality'))
            );
            if (hit?.long_name) return resolve(hit.long_name);
          }
        }

        // 3. Look for 'administrative_area_level_2' (e.g. District "Baramulla")
        for (const res of results) {
          if (Array.isArray(res.address_components)) {
            const hit = res.address_components.find((c: any) =>
              Array.isArray(c.types) && c.types.includes('administrative_area_level_2')
            );
            if (hit?.long_name) return resolve(hit.long_name);
          }
        }

        // 4. Fallback: Parse first segment of formatted address
        const firstFormatted = results[0]?.formatted_address;
        if (firstFormatted) {
          const parts = firstFormatted.split(',').map((p: string) => p.trim()).filter(Boolean);
          if (parts.length > 0) return resolve(parts[0]);
        }

        resolve(null);
      });
    });
  }
}
