export const CUSTOMER_MAP_STYLE = {
  renderingType: 'VECTOR',
  colorScheme: 'LIGHT',
  tilt: 35,
};

export const CUSTOMER_NAVIGATION_ZOOM = 17.5;

export function focusCustomerNavigation(map: any, center: { lat: number; lng: number }): void {
  map.moveCamera({ center, zoom: CUSTOMER_NAVIGATION_ZOOM, tilt: CUSTOMER_MAP_STYLE.tilt });
}

/** Google Maps resets the vector camera tilt when fitting bounds. */
export function fitCustomerMap(map: any, bounds: any, padding: number | Record<string, number>): void {
  map.fitBounds(bounds, padding);
  google.maps.event.addListenerOnce(map, 'idle', () => {
    if (map.getTilt() === 0) map.setTilt(CUSTOMER_MAP_STYLE.tilt);
  });
}

declare const google: any;
