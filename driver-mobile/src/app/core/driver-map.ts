import { updateCarMarkerBearing } from './car-marker.helper';

declare const google: any;

export const DRIVER_MAP_STYLE = {
  renderingType: 'VECTOR',
  colorScheme: 'LIGHT',
  tilt: 35,
  zoom: 17.5,
};

/** Separate a nearby passenger badge without moving its geographic anchor. */
export function offsetPassengerMarker(marker: any, driver: { lat: number; lng: number }): void {
  const position = new google.maps.LatLng(marker.position).toJSON();
  const east = (position.lng - driver.lng) * Math.cos(driver.lat * Math.PI / 180);
  const north = position.lat - driver.lat;
  const close = Math.hypot(east, north) * 111_195 < 15;
  marker.content?.classList.toggle('is-near-driver', close);
}

/** Follow live GPS independently of any navigation line. */
export class DriverMapCamera {
  private map: any = null;
  private previous: { lat: number; lng: number } | null = null;
  private frame = 0;
  private heading = 0;

  isFollowing(map: any): boolean {
    return this.map === map;
  }

  follow(
    map: any,
    position: { lat: number; lng: number },
    bearing?: number | null,
    marker?: any,
    routeHeading?: number | null,
  ): void {
    if (this.map !== map) {
      this.reset();
      this.map = map;
      this.heading = map.getHeading() ?? 0;
    }
    const previous = this.previous;
    if (!previous || Math.hypot(position.lat - previous.lat, position.lng - previous.lng) >= 0.000045) {
      if (bearing != null && Number.isFinite(bearing) && bearing >= 0) {
        this.heading = bearing;
      } else if (previous) {
        const east = (position.lng - previous.lng) * Math.cos(previous.lat * Math.PI / 180);
        this.heading = Math.atan2(east, position.lat - previous.lat) * 180 / Math.PI;
      }
      this.previous = position;
    }
    const heading = routeHeading ?? this.heading;
    if (!marker) {
      map.moveCamera({ heading, tilt: DRIVER_MAP_STYLE.tilt, zoom: DRIVER_MAP_STYLE.zoom });
      map.panTo(position);
      return;
    }

    cancelAnimationFrame(this.frame);
    const center = map.getCenter()?.toJSON() ?? position;
    const markerStart = new google.maps.LatLng(marker.position).toJSON();
    const startHeading = map.getHeading() ?? 0;
    const turn = ((heading - startHeading + 540) % 360) - 180;
    const zoom = map.getZoom() ?? DRIVER_MAP_STYLE.zoom;
    const tilt = map.getTilt() ?? DRIVER_MAP_STYLE.tilt;
    const start = performance.now();
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650;
    const animate = (now: number) => {
      const progress = duration ? Math.min(1, (now - start) / duration) : 1;
      const ease = progress * (2 - progress);
      marker.position = {
        lat: markerStart.lat + (position.lat - markerStart.lat) * ease,
        lng: markerStart.lng + (position.lng - markerStart.lng) * ease,
      };
      map.moveCamera({
        center: {
          lat: center.lat + (position.lat - center.lat) * ease,
          lng: center.lng + (position.lng - center.lng) * ease,
        },
        heading: startHeading + turn * ease,
        tilt: tilt + (DRIVER_MAP_STYLE.tilt - tilt) * ease,
        zoom: zoom + (DRIVER_MAP_STYLE.zoom - zoom) * ease,
      });
      updateCarMarkerBearing(marker, 0);
      if (progress < 1) this.frame = requestAnimationFrame(animate);
    };
    this.frame = requestAnimationFrame(animate);
  }

  reset(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.map = null;
    this.previous = null;
  }
}

/** Fitting a route resets tilt on vector maps. Restore it after framing. */
export function fitDriverMap(map: any, bounds: any, padding: number | Record<string, number>): void {
  google.maps.event.addListenerOnce(map, 'idle', () => {
    if (map.getTilt() === 0) map.setTilt(DRIVER_MAP_STYLE.tilt);
  });
  map.fitBounds(bounds, padding);
  if (map.getTilt() === 0) map.setTilt(DRIVER_MAP_STYLE.tilt);
}
