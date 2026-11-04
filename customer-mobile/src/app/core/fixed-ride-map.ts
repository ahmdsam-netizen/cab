interface FixedRideMapStops {
  status: string;
  board_lat?: number | null;
  board_lng?: number | null;
  drop_lat?: number | null;
  drop_lng?: number | null;
  stops?: Array<{ lat: number | null; lng: number | null; is_pickup?: boolean; is_drop?: boolean }>;
}

export function fixedRideNavigationTarget(ride: FixedRideMapStops) {
  const boarded = ride.status?.toUpperCase() === 'BOARDED';
  const stop = ride.stops?.find(point => boarded ? point.is_drop : point.is_pickup);
  const lat = (boarded ? ride.drop_lat : ride.board_lat) ?? stop?.lat;
  const lng = (boarded ? ride.drop_lng : ride.board_lng) ?? stop?.lng;
  return lat == null || lng == null ? null : { lat: Number(lat), lng: Number(lng) };
}

export function buildFixedRidePin(kind: 'pickup' | 'drop', label: string): HTMLElement {
  const pin = document.createElement('div');
  pin.className = `dc-fixed-pin-marker dc-fixed-pin-marker--${kind}`;
  const caption = document.createElement('div');
  caption.style.cssText = 'color:#fff;font-size:11px;font-weight:850;padding:3px 9px;border-radius:99px;box-shadow:0 3px 10px #0005;border:1.5px solid #fff;white-space:nowrap;text-align:center;line-height:1.2';
  caption.style.background = kind === 'pickup' ? '#2563eb' : '#ef4444';
  caption.textContent = label;
  const dot = document.createElement('div');
  dot.style.cssText = 'width:10px;height:10px;border-radius:50%;border:2.5px solid #fff;margin:3px auto 0;box-shadow:0 3px 6px #0005';
  dot.style.background = kind === 'pickup' ? '#3b82f6' : '#f87171';
  pin.append(caption, dot);
  return pin;
}
