/**
 * Reusable Marker Generator for Google Maps AdvancedMarkerElement in Customer App.
 * Creates an ultra-crisp, transparent-background top-down vector vehicle
 * and unified passenger avatar / stop markers with 100% pinpoint accuracy.
 */
export interface CarMarkerOptions {
  bearing?: number;
  label?: string;
  width?: number;
  height?: number;
  markerUrl?: string | null;
}

export function buildReusableCarMarkerElement(options: CarMarkerOptions = {}): HTMLElement {
  const bearing = options.bearing ?? 0;
  const label = options.label;
  const width = options.width ?? 28;
  const height = options.height ?? 54;
  const markerUrl = options.markerUrl?.trim() || null;

  const root = document.createElement('div');
  root.className = 'fixed-driver-car-marker';

  const carWrap = document.createElement('div');
  carWrap.className = 'car-icon-wrap';
  carWrap.style.transform = `translate(-50%, -50%) rotate(${bearing}deg)`;

  carWrap.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="28" height="28" class="vector-car-svg vehicle-dot-fallback">
      <!-- 1. Soft glowing outer pulse ring -->
      <circle cx="16" cy="16" r="14" fill="rgba(18, 179, 91, 0.2)" />
      <!-- 2. White outer border ring -->
      <circle cx="16" cy="16" r="10" fill="#FFFFFF" />
      <!-- 3. Vibrant green core vehicle dot -->
      <circle cx="16" cy="16" r="7.5" fill="#12B35B" />
      <!-- 4. Directional heading arrow (points forward along bearing) -->
      <path d="M16 2.5 L20.5 10.5 L11.5 10.5 Z" fill="#12B35B" stroke="#FFFFFF" stroke-width="0.75" stroke-linejoin="round" />
    </svg>
  `;

  if (markerUrl) {
    const svgEl = carWrap.querySelector('.vector-car-svg') as SVGElement | null;
    const img = document.createElement('img');
    img.className = 'vector-car-img';
    img.alt = label || 'Vehicle';
    img.style.width = `${width}px`;
    img.style.height = `${height}px`;
    img.style.objectFit = 'contain';
    img.style.display = 'none';

    img.addEventListener('load', () => {
      img.style.display = 'block';
      if (svgEl) svgEl.style.display = 'none';
    });
    img.addEventListener('error', () => {
      if (svgEl) svgEl.style.display = 'block';
      img.remove();
    });
    img.src = markerUrl;
    if (img.complete && img.naturalWidth > 0) {
      img.style.display = 'block';
      if (svgEl) svgEl.style.display = 'none';
    }
    carWrap.appendChild(img);
  }

  root.appendChild(carWrap);

  return root;
}

export function updateCarMarkerBearing(marker: any, bearing: number): void {
  if (!marker?.content) return;
  const carWrap = (marker.content as HTMLElement).querySelector('.car-icon-wrap') as HTMLElement | null;
  if (carWrap) {
    carWrap.style.transform = `translate(-50%, -50%) rotate(${bearing}deg)`;
  }
}

export function updateCarMarkerImage(marker: any, markerUrl: string | null): void {
  if (!marker?.content) return;
  const root = marker.content as HTMLElement;
  const carWrap = root.querySelector('.car-icon-wrap') as HTMLElement | null;
  if (!carWrap) return;
  const svgEl = carWrap.querySelector('.vector-car-svg') as SVGElement | null;
  let img = carWrap.querySelector('.vector-car-img') as HTMLImageElement | null;
  const url = markerUrl?.trim() || null;

  if (!url) {
    if (img) img.remove();
    if (svgEl) svgEl.style.display = 'block';
    return;
  }

  if (img && img.src === url) return;

  if (!img) {
    img = document.createElement('img');
    img.className = 'vector-car-img';
    img.alt = 'Vehicle';
    img.style.width = '28px';
    img.style.height = '54px';
    img.style.objectFit = 'contain';
    img.style.display = 'none';
    img.addEventListener('load', () => {
      img!.style.display = 'block';
      if (svgEl) svgEl.style.display = 'none';
    });
    img.addEventListener('error', () => {
      if (svgEl) svgEl.style.display = 'block';
      img!.remove();
    });
    carWrap.appendChild(img);
  }

  img.src = url;
  if (img.complete && img.naturalWidth > 0) {
    img.style.display = 'block';
    if (svgEl) svgEl.style.display = 'none';
  }
}

let globalCustomerMarkerUrl: string | null = null;

export function setGlobalCustomerMarkerUrl(url: string | null): void {
  globalCustomerMarkerUrl = url;
  try {
    if (url) localStorage.setItem('dc_customer_marker_url', url);
    else localStorage.removeItem('dc_customer_marker_url');
  } catch {}
}

export function getGlobalCustomerMarkerUrl(): string | null {
  if (globalCustomerMarkerUrl !== null) return globalCustomerMarkerUrl;
  try {
    return localStorage.getItem('dc_customer_marker_url') || null;
  } catch {
    return null;
  }
}

export interface PassengerMarkerOptions {
  kind?: 'pickup' | 'drop';
  name?: string;
  count?: number;
  isLive?: boolean;
  label?: string;
  avatarUrl?: string | null;
  assetIcon?: string | null;
}

/**
 * Builds the customer / passenger marker element.
 *
 * Defaults to a clean location dot when no custom marker is configured.
 * When a custom marker image is uploaded or available, displays that custom marker.
 */
export function buildPassengerMarkerElement(options: PassengerMarkerOptions = {}): HTMLElement {
  const kind = options.kind || 'pickup';
  const rawName = (options.name !== undefined ? (options.name?.trim() || '') : (options.label?.trim() || ''));
  const isGeneric = !rawName || ['passenger', 'you'].includes(rawName.toLowerCase());
  const displayName = isGeneric ? '' : rawName;
  const count = options.count ?? 1;
  const isLive = !!options.isLive;
  const customMarker = getGlobalCustomerMarkerUrl();
  const avatarUrl = options.avatarUrl?.trim() || null;
  const assetIcon = options.assetIcon?.trim() || null;

  const el = document.createElement('div');
  el.className = `fixed-driver-person-marker fixed-driver-person-marker--${kind} ${isLive ? 'is-live-walking' : ''}`;

  const wrap = document.createElement('div');
  wrap.className = `person-avatar-wrap ${kind === 'drop' ? 'person-avatar-wrap--drop' : ''}`;

  // Default fallback: crisp location dot for customer/pickup in place of person figure
  const fallbackSvgHtml = kind === 'pickup'
    ? `<svg viewBox="0 0 24 24" width="22" height="22" class="person-avatar-svg person-dot-svg">
         <circle cx="12" cy="12" r="8" fill="#2563EB" stroke="#FFFFFF" stroke-width="2.5" />
         <circle cx="12" cy="12" r="3" fill="#FFFFFF" opacity="0.95" />
       </svg>`
    : `<svg viewBox="0 0 24 32" width="24" height="32" fill="#F59E0B" stroke="#FFFFFF" stroke-width="1.2" class="person-avatar-svg">
         <path d="M12 2C7.58 2 4 5.58 4 10c0 6 8 16 8 16s8-10 8-16c0-4.42-3.58-8-8-8zm0 11c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3z"/>
       </svg>`;

  wrap.innerHTML = fallbackSvgHtml;
  const svgEl = wrap.querySelector('.person-avatar-svg') as SVGElement | null;

  const targetImgUrl = kind === 'pickup' ? (customMarker || assetIcon) : assetIcon;
  if (targetImgUrl) {
    const img = document.createElement('img');
    img.className = 'person-avatar-img';
    img.alt = displayName || 'Customer';
    img.style.display = 'none';

    img.addEventListener('load', () => {
      img.style.display = 'block';
      if (svgEl) svgEl.style.display = 'none';
    });

    img.addEventListener('error', () => {
      img.style.display = 'none';
      if (svgEl) svgEl.style.display = 'block';
    });

    img.src = targetImgUrl;
    if (img.complete && img.naturalWidth > 0) {
      img.style.display = 'block';
      if (svgEl) svgEl.style.display = 'none';
    }
    wrap.appendChild(img);
  }

  el.appendChild(wrap);

  if (isLive) {
    const pulse = document.createElement('div');
    pulse.className = 'person-walking-pulse';
    el.appendChild(pulse);
  }

  if (displayName || count > 1) {
    const safeName = displayName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const seatBadge = count > 1 ? `<span class="person-tag-seats">${count}s</span>` : '';
    const liveDot = isLive ? `<span class="person-live-dot" title="Live Location">●</span>` : '';

    const pill = document.createElement('div');
    pill.className = 'person-tag-pill';
    pill.innerHTML = `
      ${safeName ? `<span class="person-tag-name">${safeName}</span>` : ''}
      ${seatBadge}
      ${liveDot}
    `;
    el.appendChild(pill);
  }

  return el;
}

/**
 * Reactively updates an existing customer / passenger marker's icon image.
 */
export function updatePassengerMarkerImage(marker: any, url: string | null): void {
  const content = marker?.content as HTMLElement | undefined;
  if (!content) return;
  const wrap = content.querySelector('.person-avatar-wrap') as HTMLElement | null;
  const svgEl = wrap?.querySelector('.person-avatar-svg') as SVGElement | null;
  let img = wrap?.querySelector('.person-avatar-img') as HTMLImageElement | null;

  if (!url) {
    if (img) img.remove();
    if (svgEl) svgEl.style.display = 'block';
    return;
  }

  if (img && img.src === url) return;

  if (!img && wrap) {
    img = document.createElement('img');
    img.className = 'person-avatar-img';
    img.alt = 'Customer';
    img.style.display = 'none';
    img.addEventListener('load', () => {
      img!.style.display = 'block';
      if (svgEl) svgEl.style.display = 'none';
    });
    img.addEventListener('error', () => {
      if (svgEl) svgEl.style.display = 'block';
      img!.remove();
    });
    wrap.appendChild(img);
  }

  if (img) {
    img.src = url;
    if (img.complete && img.naturalWidth > 0) {
      img.style.display = 'block';
      if (svgEl) svgEl.style.display = 'none';
    }
  }
}

export interface StopMarkerOptions {
  seq: number | string;
  name?: string;
  isReached?: boolean;
  tone?: string;
}

/**
 * Builds the sequence numbered stop marker with green/slate state colors.
 */
export function buildStopMarkerElement(options: StopMarkerOptions): HTMLElement {
  const el = document.createElement('div');
  el.className = 'fixed-driver-stop-marker';
  const tone = options.tone || (options.isReached ? '#64748B' : '#12B35B');
  el.style.setProperty('--stop-color', tone);
  el.innerHTML = `<span>${options.seq}</span>`;
  return el;
}
