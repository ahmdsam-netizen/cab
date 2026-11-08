/**
 * Navigation Route & Directional Chevron Polyline Helper for Google Maps.
 *
 * Renders high-visibility, dual-layer road routes with directional chevrons/arrows
 * indicating forward movement toward pickup or drop locations. Supports dynamic
 * real-time progress trimming as the driver advances.
 */

declare const google: any;

export interface LatLngPoint {
  lat: number;
  lng: number;
}

export interface NavigationRouteConfig {
  strokeColor?: string;
  casingColor?: string;
  arrowFillColor?: string;
  arrowStrokeColor?: string;
  strokeWeight?: number;
  casingWeight?: number;
  repeatDistance?: string;
  arrowScale?: number;
  zIndex?: number;
  animateArrows?: boolean;
  roadOnly?: boolean;
}

export const LIVE_NAVIGATION_STYLE: NavigationRouteConfig = {
  strokeColor: '#2563EB',
  arrowFillColor: '#1D4ED8',
  animateArrows: true,
  roadOnly: true,
};

export class NavigationRouteRenderer {
  private map: any = null;
  private casingPolyline: any = null;
  private routePolyline: any = null;
  private fullPath: any[] = [];
  private currentPath: any[] = [];
  private directionsService: any = null;
  private isFetching = false;
  private routeGeneration = 0;
  private arrowTimer?: ReturnType<typeof setInterval>;
  private lastOrigin: LatLngPoint | null = null;
  private lastDestination: LatLngPoint | null = null;
  private lastRequestAt = 0;
  private targetKind: 'pickup' | 'drop' | null = null;

  constructor(private config: NavigationRouteConfig = {}) {}

  /**
   * Render or update the directional navigation route from start to destination.
   */
  async render(
    map: any,
    origin: LatLngPoint,
    destination: LatLngPoint,
    kind: 'pickup' | 'drop' = 'drop',
    force = false,
  ): Promise<void> {
    if (!map || typeof google === 'undefined' || !origin || !destination) return;
    this.map = map;

    const sameTarget = this.targetKind === kind && this.lastDestination &&
      this.haversineDistance(this.lastDestination, destination) < (this.config.roadOnly ? 1 : 25);
    if (this.config.roadOnly && !force && sameTarget && !this.fullPath.length &&
        Date.now() - this.lastRequestAt < 10_000) return;

    if (
      !force &&
      sameTarget &&
      this.lastOrigin &&
      this.haversineDistance(this.lastOrigin, origin) < 25 &&
      this.fullPath.length > 0
    ) {
      // Just update driver progress along the existing calculated road path
      this.updateDriverProgress(origin);
      return;
    }

    if (this.isFetching && (!this.config.roadOnly || sameTarget)) return;
    if (this.config.roadOnly && !sameTarget) this.clear();
    this.targetKind = kind;
    this.lastOrigin = { ...origin };
    this.lastDestination = { ...destination };
    this.lastRequestAt = Date.now();
    this.isFetching = true;
    const generation = this.routeGeneration;

    try {
      const roadPath = await this.fetchDirectionsPath(origin, destination);
      if (generation !== this.routeGeneration) return;
      this.fullPath = roadPath;
      this.currentPath = [...roadPath];
      this.drawPolylines();
      if (this.config.roadOnly) this.updateDriverProgress(origin);
    } catch {
      if (generation !== this.routeGeneration) return;
      if (this.config.roadOnly) return;
      // Fallback: draw straight/interpolated directional path if Directions API is unavailable
      const fallbackPath = this.interpolatePath(origin, destination, 8);
      this.fullPath = fallbackPath;
      this.currentPath = [...fallbackPath];
      this.drawPolylines();
    } finally {
      if (generation === this.routeGeneration) this.isFetching = false;
    }
  }

  /**
   * Trims the path behind the driver's current position so the route
   * always dynamically leads from the driver toward the destination.
   */
  updateDriverProgress(driverLoc: LatLngPoint): void {
    if (!driverLoc || !this.fullPath.length || !this.routePolyline) return;
    if (this.config.roadOnly) {
      this.trimToRoad(driverLoc);
      return;
    }

    // Find closest index in fullPath to driver
    let closestIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < this.fullPath.length; i++) {
      const p = this.fullPath[i];
      const d = this.haversineDistance(driverLoc, {
        lat: typeof p.lat === 'function' ? p.lat() : p.lat,
        lng: typeof p.lng === 'function' ? p.lng() : p.lng,
      });
      if (d < minDist) {
        minDist = d;
        closestIdx = i;
      }
    }

    // If driver is reasonably close to the path (< 250m), slice off passed points
    if (minDist < 250 && closestIdx < this.fullPath.length - 1) {
      const driverLatLng = new google.maps.LatLng(driverLoc.lat, driverLoc.lng);
      const remaining = [driverLatLng, ...this.fullPath.slice(closestIdx + 1)];
      this.currentPath = remaining;
      if (this.casingPolyline) this.casingPolyline.setPath(remaining);
      if (this.routePolyline) this.routePolyline.setPath(remaining);
    }
  }

  private trimToRoad(position: LatLngPoint): void {
    const longitudeScale = Math.cos(position.lat * Math.PI / 180);
    let nearest: LatLngPoint | null = null;
    let nearestDistance = Infinity;
    let nextIndex = 0;
    for (let i = 1; i < this.fullPath.length; i++) {
      const from = new google.maps.LatLng(this.fullPath[i - 1]).toJSON();
      const to = new google.maps.LatLng(this.fullPath[i]).toJSON();
      const east = (to.lng - from.lng) * longitudeScale;
      const north = to.lat - from.lat;
      const lengthSquared = east ** 2 + north ** 2;
      if (!lengthSquared) continue;
      const progress = ((position.lng - from.lng) * longitudeScale * east +
        (position.lat - from.lat) * north) / lengthSquared;
      const fraction = Math.max(0, Math.min(1, progress));
      const projected = {
        lat: from.lat + fraction * (to.lat - from.lat),
        lng: from.lng + fraction * (to.lng - from.lng),
      };
      const distance = this.haversineDistance(position, projected);
      if (distance >= nearestDistance) continue;
      nearest = projected;
      nearestDistance = distance;
      nextIndex = i;
    }
    if (!nearest || nearestDistance >= 250) return;
    this.currentPath = [nearest, ...this.fullPath.slice(nextIndex)];
    this.casingPolyline?.setPath(this.currentPath);
    this.routePolyline.setPath(this.currentPath);
  }

  headingAhead(): number | null {
    if (this.currentPath.length < 2) return null;
    const from = new google.maps.LatLng(this.currentPath[0]).toJSON();
    for (const point of this.currentPath.slice(1)) {
      const to = new google.maps.LatLng(point).toJSON();
      if (this.haversineDistance(from, to) < 1) continue;
      const east = (to.lng - from.lng) * Math.cos(from.lat * Math.PI / 180);
      return Math.atan2(east, to.lat - from.lat) * 180 / Math.PI;
    }
    return null;
  }

  /**
   * Completely clears and destroys active polylines.
   */
  clear(): void {
    clearInterval(this.arrowTimer);
    this.arrowTimer = undefined;
    this.routeGeneration++;
    this.isFetching = false;
    if (this.casingPolyline) {
      this.casingPolyline.setMap(null);
      this.casingPolyline = null;
    }
    if (this.routePolyline) {
      this.routePolyline.setMap(null);
      this.routePolyline = null;
    }
    this.fullPath = [];
    this.currentPath = [];
    this.lastOrigin = null;
    this.lastDestination = null;
    this.targetKind = null;
  }

  private drawPolylines(): void {
    if (!this.map || !this.currentPath.length) return;

    const strokeColor = this.config.strokeColor || (this.targetKind === 'pickup' ? '#2563EB' : '#16A34A');
    const arrowFillColor = this.config.arrowFillColor || (this.targetKind === 'pickup' ? '#1D4ED8' : '#15803D');
    const casingColor = this.config.casingColor || '#FFFFFF';
    const casingWeight = this.config.casingWeight || 7.5;
    const strokeWeight = this.config.strokeWeight || 4.5;
    const zBase = this.config.zIndex || 50;

    // 1. Casing / border line for high contrast
    if (!this.casingPolyline) {
      this.casingPolyline = new google.maps.Polyline({
        path: this.currentPath,
        geodesic: true,
        strokeColor: casingColor,
        strokeOpacity: 0.9,
        strokeWeight: casingWeight,
        zIndex: zBase,
        map: this.map,
      });
    } else {
      this.casingPolyline.setOptions({
        path: this.currentPath,
        strokeColor: casingColor,
        strokeWeight: casingWeight,
        map: this.map,
      });
    }

    // 2. Main navigation path with forward-pointing chevrons
    const chevronIcon = {
      path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
      scale: this.config.arrowScale || 2.4,
      strokeColor: '#FFFFFF',
      strokeWeight: 1,
      fillColor: arrowFillColor,
      fillOpacity: 1,
    };

    if (!this.routePolyline) {
      this.routePolyline = new google.maps.Polyline({
        path: this.currentPath,
        geodesic: true,
        strokeColor,
        strokeOpacity: 0.95,
        strokeWeight,
        zIndex: zBase + 1,
        icons: [
          {
            icon: chevronIcon,
            offset: '50%',
            repeat: this.config.repeatDistance || '50px',
          },
        ],
        map: this.map,
      });
    } else {
      this.routePolyline.setOptions({
        path: this.currentPath,
        strokeColor,
        strokeWeight,
        icons: [
          {
            icon: chevronIcon,
            offset: '50%',
            repeat: this.config.repeatDistance || '50px',
          },
        ],
        map: this.map,
      });
    }
    if (this.config.animateArrows && this.arrowTimer === undefined &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      let offset = 0;
      this.arrowTimer = setInterval(() => {
        offset = (offset + 2) % (parseFloat(this.config.repeatDistance || '50px') || 50);
        const icons = this.routePolyline?.get('icons');
        if (icons?.length) this.routePolyline.set('icons', [{ ...icons[0], offset: `${offset}px` }]);
      }, 50);
    }
  }

  private fetchDirectionsPath(
    origin: LatLngPoint,
    destination: LatLngPoint,
  ): Promise<any[]> {
    return new Promise((resolve, reject) => {
      if (!this.directionsService) {
        this.directionsService = new google.maps.DirectionsService();
      }

      this.directionsService.route(
        {
          origin: new google.maps.LatLng(origin.lat, origin.lng),
          destination: new google.maps.LatLng(destination.lat, destination.lng),
          travelMode: google.maps.TravelMode.DRIVING,
        },
        (result: any, status: any) => {
          if (status === google.maps.DirectionsStatus.OK && result?.routes?.[0]?.overview_path) {
            resolve(result.routes[0].overview_path);
          } else {
            reject(new Error(`DirectionsService status: ${status}`));
          }
        },
      );
    });
  }

  private interpolatePath(a: LatLngPoint, b: LatLngPoint, steps: number): any[] {
    const pts: any[] = [];
    for (let i = 0; i <= steps; i++) {
      const frac = i / steps;
      const lat = a.lat + (b.lat - a.lat) * frac;
      const lng = a.lng + (b.lng - a.lng) * frac;
      pts.push(new google.maps.LatLng(lat, lng));
    }
    return pts;
  }

  private haversineDistance(a: LatLngPoint, b: LatLngPoint): number {
    const R = 6371e3; // metres
    const φ1 = (a.lat * Math.PI) / 180;
    const φ2 = (b.lat * Math.PI) / 180;
    const Δφ = ((b.lat - a.lat) * Math.PI) / 180;
    const Δλ = ((b.lng - a.lng) * Math.PI) / 180;

    const s =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
    return R * c;
  }
}
