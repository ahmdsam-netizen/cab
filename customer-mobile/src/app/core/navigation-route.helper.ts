/**
 * Navigation Route & Directional Chevron Polyline Helper for Google Maps.
 *
 * Renders high-visibility, dual-layer road routes with directional chevrons/arrows
 * indicating forward movement toward pickup or drop locations. Supports dynamic
 * real-time progress trimming as the driver advances.
 */

declare const google: any;

import { CUSTOMER_MAP_STYLE, CUSTOMER_NAVIGATION_ZOOM } from './customer-map';

export interface LatLngPoint {
  lat: number;
  lng: number;
}

/** Separate the artwork without changing either marker's GPS coordinates. */
export function separateNavigationMarkers(driver: any, passenger: any): void {
  const artwork = driver?.content;
  if (!artwork?.style) return;
  const driverPosition = driver.position;
  const passengerPosition = passenger?.map ? passenger.position : null;
  const close = driverPosition && passengerPosition
    && Math.hypot(driverPosition.lat - passengerPosition.lat, driverPosition.lng - passengerPosition.lng) < 0.0004;
  artwork.style.translate = close ? '42px 0' : '';
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
}

export class NavigationRouteRenderer {
  private map: any = null;
  private casingPolyline: any = null;
  private routePolyline: any = null;
  private fullPath: any[] = [];
  private currentPath: any[] = [];
  private directionsService: any = null;
  private request = 0;
  private fetching = false;
  private arrowTimer: ReturnType<typeof setInterval> | null = null;
  private cameraFrame = 0;
  private followPosition: LatLngPoint | null = null;
  private headingPosition: LatLngPoint | null = null;
  private followHeading: number | null = null;
  private followMarker: any = null;

  get following(): boolean {
    return this.followPosition !== null;
  }

  follow(map: any, position: LatLngPoint, target: LatLngPoint, marker: any, recenter = false): void {
    if (!map.moveCamera || !marker) return;
    const sameMarker = marker === this.followMarker;
    const samePosition = this.followPosition?.lat === position.lat && this.followPosition.lng === position.lng;
    const previous = sameMarker ? this.headingPosition : null;
    const moving = previous && this.haversineDistance(previous, position) >= 5;
    if (!previous || moving) this.headingPosition = position;
    const walkingHeading = this.targetKind === 'pickup' ? this.routeHeading() : null;
    const previousHeading = this.followHeading;
    if (walkingHeading !== null) {
      this.followHeading = walkingHeading;
    } else if (!sameMarker || moving) {
      const from = moving ? previous : position;
      const to = moving ? position : target;
      this.followHeading = this.bearing(from, to);
    }
    if (!recenter && sameMarker && samePosition && previousHeading === this.followHeading) return;
    this.followPosition = position;
    this.followMarker = marker;
    cancelAnimationFrame(this.cameraFrame);
    const start = performance.now();
    const center = map.getCenter?.()?.toJSON?.() ?? position;
    const markerStart = sameMarker ? marker.position : position;
    const markerLat = typeof markerStart?.lat === 'function' ? markerStart.lat() : markerStart?.lat ?? position.lat;
    const markerLng = typeof markerStart?.lng === 'function' ? markerStart.lng() : markerStart?.lng ?? position.lng;
    const heading = map.getHeading?.() ?? 0;
    const turn = ((this.followHeading ?? heading) - heading + 540) % 360 - 180;
    const zoom = map.getZoom?.() ?? 17;
    const tilt = map.getTilt?.() ?? 0;
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650;
    const animate = (now: number) => {
      const t = duration ? Math.min(1, (now - start) / duration) : 1;
      const ease = t * (2 - t);
      marker.position = {
        lat: markerLat + (position.lat - markerLat) * ease,
        lng: markerLng + (position.lng - markerLng) * ease,
      };
      map.moveCamera({
        center: {
          lat: center.lat + (position.lat - center.lat) * ease,
          lng: center.lng + (position.lng - center.lng) * ease,
        },
        heading: heading + turn * ease,
        tilt: tilt + (CUSTOMER_MAP_STYLE.tilt - tilt) * ease,
        zoom: zoom + (CUSTOMER_NAVIGATION_ZOOM - zoom) * ease,
      });
      if (t < 1) this.cameraFrame = requestAnimationFrame(animate);
    };
    this.cameraFrame = requestAnimationFrame(animate);
  }

  private routeHeading(): number | null {
    if (this.currentPath.length < 2) return null;
    const [first, ...ahead] = this.currentPath;
    const from = new google.maps.LatLng(first).toJSON();
    for (const point of ahead) {
      const to = point.toJSON();
      if (this.haversineDistance(from, to) >= 1) return this.bearing(from, to);
    }
    return null;
  }

  private bearing(from: LatLngPoint, to: LatLngPoint): number {
    const east = (to.lng - from.lng) * Math.cos(from.lat * Math.PI / 180);
    return Math.atan2(east, to.lat - from.lat) * 180 / Math.PI;
  }
  private lastOrigin: LatLngPoint | null = null;
  private lastDestination: LatLngPoint | null = null;
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
    if (this.targetKind !== kind || this.map !== map ||
        (this.lastDestination && this.haversineDistance(this.lastDestination, destination) >= 25)) {
      this.clear();
    }
    this.map = map;
    if (this.haversineDistance(origin, destination) < 5) {
      this.clearRoute();
      return;
    }

    // Check if target and origin have meaningfully shifted (within 25m) to avoid redundant Directions API calls
    if (
      !force &&
      this.targetKind === kind &&
      this.lastDestination &&
      this.haversineDistance(this.lastDestination, destination) < 25 &&
      this.lastOrigin &&
      this.haversineDistance(this.lastOrigin, origin) < 25 &&
      this.fullPath.length > 0
    ) {
      // Just update driver progress along the existing calculated road path
      this.updateDriverProgress(origin);
      return;
    }

    this.updateDriverProgress(origin);
    if (this.fetching) return;
    this.targetKind = kind;
    this.lastOrigin = { ...origin };
    this.lastDestination = { ...destination };

    this.fetching = true;
    const request = ++this.request;

    try {
      const roadPath = await this.fetchDirectionsPath(origin, destination, kind);
      if (request !== this.request) return;
      this.fullPath = roadPath;
      this.currentPath = [...roadPath];
      this.drawPolylines();
      if (kind === 'pickup' && this.followPosition && this.followMarker) {
        this.updateDriverProgress(this.followPosition);
        this.follow(map, this.followPosition, destination, this.followMarker);
      }
    } catch {
      // A straight line can cross buildings or barriers and is not navigation.
      if (request === this.request) this.lastOrigin = null;
    } finally {
      if (request === this.request) this.fetching = false;
    }
  }

  /** Trim at the nearest point on the routed path, keeping GPS off the line. */
  private updateDriverProgress(position: LatLngPoint): void {
    if (this.fullPath.length < 2 || !this.routePolyline) return;

    let nextIndex = 1;
    let start = this.fullPath[0];
    let minDist = Infinity;
    const longitudeScale = Math.cos(position.lat * Math.PI / 180);
    for (let i = 1; i < this.fullPath.length; i++) {
      const from = this.fullPath[i - 1];
      const to = this.fullPath[i];
      const north = to.lat() - from.lat();
      const east = (to.lng() - from.lng()) * longitudeScale;
      const lengthSquared = north ** 2 + east ** 2;
      if (!lengthSquared) continue;

      const offset = (position.lat - from.lat()) * north
        + (position.lng - from.lng()) * longitudeScale * east;
      const fraction = Math.max(0, Math.min(1, offset / lengthSquared));
      const point = {
        lat: from.lat() + north * fraction,
        lng: from.lng() + (to.lng() - from.lng()) * fraction,
      };
      const distance = this.haversineDistance(position, point);
      if (distance < minDist) {
        minDist = distance;
        nextIndex = i;
        start = point;
      }
    }

    if (minDist < 250) {
      const remaining = [start, ...this.fullPath.slice(nextIndex)];
      this.currentPath = remaining;
      if (this.casingPolyline) this.casingPolyline.setPath(remaining);
      if (this.routePolyline) this.routePolyline.setPath(remaining);
    }
  }

  /**
   * Completely clears and destroys active polylines.
   */
  clear(): void {
    cancelAnimationFrame(this.cameraFrame);
    this.followPosition = this.headingPosition = null;
    this.followHeading = null;
    this.followMarker = null;
    this.clearRoute();
    this.targetKind = null;
    this.map = null;
  }

  private clearRoute(): void {
    this.request++;
    this.fetching = false;
    if (this.arrowTimer !== null) clearInterval(this.arrowTimer);
    this.arrowTimer = null;
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
            offset: '0px',
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
            offset: '0px',
            repeat: this.config.repeatDistance || '50px',
          },
        ],
        map: this.map,
      });
    }
    if (this.arrowTimer === null && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      let offset = 0;
      this.arrowTimer = setInterval(() => {
        const icons = this.routePolyline.get('icons');
        offset = (offset + 2) % (parseFloat(this.config.repeatDistance || '50px') || 50);
        this.routePolyline.set('icons', [{ ...icons[0], offset: `${offset}px` }]);
      }, 50);
    }
  }

  private fetchDirectionsPath(
    origin: LatLngPoint,
    destination: LatLngPoint,
    kind: 'pickup' | 'drop',
  ): Promise<any[]> {
    return new Promise((resolve, reject) => {
      if (!this.directionsService) {
        this.directionsService = new google.maps.DirectionsService();
      }

      this.directionsService.route(
        {
          origin: new google.maps.LatLng(origin.lat, origin.lng),
          destination: new google.maps.LatLng(destination.lat, destination.lng),
          travelMode: kind === 'pickup' ? google.maps.TravelMode.WALKING : google.maps.TravelMode.DRIVING,
        },
        (result: any, status: any) => {
          const route = result?.routes?.[0];
          if (status === google.maps.DirectionsStatus.OK && route?.overview_path?.length > 1) {
            const path = route.legs?.flatMap((leg: any) => leg.steps?.flatMap((step: any) => step.path ?? []) ?? []);
            resolve(path?.length > 1 ? path : route.overview_path);
          } else {
            reject(new Error(`DirectionsService status: ${status}`));
          }
        },
      );
    });
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
