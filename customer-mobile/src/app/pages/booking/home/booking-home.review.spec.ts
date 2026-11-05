import { CommonModule } from '@angular/common';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AlertController } from '@ionic/angular';
import { ApiService } from '../../../core/api.service';
import { AuthService } from '../../../core/auth.service';
import { GeolocationService } from '../../../core/geolocation.service';
import { PlacesService } from '../../../core/places.service';
import { RealtimeService } from '../../../core/realtime.service';
import { BookingService } from '../booking.service';
import { BookingHomePage } from './booking-home.page';

describe('Booking Home location regressions', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [BookingHomePage], imports: [CommonModule], schemas: [NO_ERRORS_SCHEMA],
      providers: [ApiService, AuthService, GeolocationService, PlacesService, RealtimeService,
        BookingService, Router, AlertController].map(provide => ({ provide, useValue: provide === AuthService
          ? { getUser: () => null, resolveAvatarUrl: () => null } : {} })),
    }).compileComponents();
  });

  function fixture() {
    const fixture = TestBed.createComponent(BookingHomePage);
    spyOn(fixture.componentInstance, 'ngOnInit').and.stub();
    spyOn(fixture.componentInstance, 'ngOnDestroy').and.stub();
    return fixture;
  }

  it('switches booking panels on Home while keeping the map and shared sections', () => {
    const view = fixture();
    const page = view.componentInstance;
    page.loading = false;
    page.located = true;
    page.mode = 'private';
    page.tiles = [
      { mode: 'private', title: 'Private Ride', hint: 'Whole car', icon: 'car-outline', rideTypeId: 1 },
      { mode: 'fixed', title: 'Book A Car', hint: 'A seat', icon: 'bus-outline', rideTypeId: 2 },
      { mode: 'shuttle', title: 'Shuttle', hint: 'Pool', icon: 'git-merge-outline', rideTypeId: 3 },
    ];
    TestBed.inject(BookingService).setMode = jasmine.createSpy();
    view.detectChanges();

    const root = view.nativeElement as HTMLElement;
    const map = root.querySelector('.bh-map');
    const sharedOffers = root.querySelector('.bh-offers-section');
    const services = root.querySelectorAll<HTMLButtonElement>('.bh-service-controls .bh-services button');
    expect(root.querySelector('.bh-service-panel')?.textContent).toContain('Where to?');
    expect(root.querySelector('.bh-saved-places')).not.toBeNull();
    expect(root.querySelector('.bh-route-section')).toBeNull();
    expect(services[1].textContent).toContain('Book A Car');

    services[0].click();
    view.detectChanges();
    expect(root.querySelector('.bh-booking-sheet')?.classList.contains('is-expanded')).toBeFalse();

    services[1].click();
    view.detectChanges();
    expect(services[1].getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('.bh-booking-sheet')?.classList.contains('is-expanded')).toBeFalse();
    expect(root.querySelector('.bh-search')).toBeNull();
    expect(root.querySelector('.bh-saved-places')).toBeNull();
    expect(root.querySelector('.bh-route-section')).not.toBeNull();

    services[2].click();
    view.detectChanges();
    expect(root.querySelector('.bh-service-panel')?.textContent).toContain('Browse shuttles');
    expect(root.querySelector('.bh-route-section')).toBeNull();
    expect(root.querySelector('.bh-map')).toBe(map);
    expect(root.querySelector('.bh-offers-section')).toBe(sharedOffers);
    expect(root.querySelector('.bh-how')).not.toBeNull();
    expect(root.querySelector('.bh-promise')).not.toBeNull();
  });

  it('opens the clicked Home route in fixed booking with its route ID', () => {
    const view = fixture();
    const page = view.componentInstance;
    const booking = TestBed.inject(BookingService);
    const router = TestBed.inject(Router);
    booking.setMode = jasmine.createSpy();
    booking.setScope = jasmine.createSpy();
    router.navigate = jasmine.createSpy().and.resolveTo(true);
    page.mode = 'fixed';
    page.tiles = [{ mode: 'fixed', rideTypeId: 2 }] as any;
    page.homeRoutes = [{ id: 42, name: 'Selected route', scope: 'local' }];
    view.detectChanges();
    (view.nativeElement.querySelector('.bh-route-card') as HTMLButtonElement).click();
    expect(router.navigate).toHaveBeenCalledWith(['/customer-tabs/go/fixed'], { queryParams: { routeId: 42 } });
    expect(booking.setMode).toHaveBeenCalledWith('fixed', 2);
    expect(booking.setScope).toHaveBeenCalledWith(page.scope);
  });

  it('keeps the GPS camera when switching services and restores it after a route preview', async () => {
    const page = fixture().componentInstance;
    const internals = page as any;
    const center = { lat: 34.304, lng: 74.47 };
    internals.map = {};
    internals.userMarker = { position: center };
    page.currentCoords = center;
    page.city = { id: 1 } as any;
    TestBed.inject(BookingService).setMode = jasmine.createSpy();
    spyOn(internals, 'startNearbyCars');
    const follow = spyOn(internals.activeNavigation, 'follow');
    const privateRide = { mode: 'private', title: 'Private Ride', hint: 'Whole car', icon: 'car-outline', rideTypeId: 1 } as const;
    const fixedRide = { mode: 'fixed', title: 'Book A Car', hint: 'A seat', icon: 'bus-outline', rideTypeId: 2 } as const;

    page.pickMode(privateRide);
    page.pickMode(fixedRide);
    expect(follow).not.toHaveBeenCalled();
    await internals.updateMapPosition(center.lat, center.lng, 10, false);
    expect(follow).toHaveBeenCalledWith(internals.map, center, null, internals.userMarker, false);

    page.gpsFollow = false;
    page.pickMode(privateRide);
    expect(page.gpsFollow).toBeTrue();
    expect(follow).toHaveBeenCalledWith(internals.map, center, null, internals.userMarker, true);
  });

  it('swipes the booking sheet open and closed without changing the selected service', () => {
    const view = fixture();
    const page = view.componentInstance;
    page.located = true;
    page.mode = 'fixed';
    view.detectChanges();

    const root = view.nativeElement as HTMLElement;
    const handle = root.querySelector<HTMLButtonElement>('.bh-booking-sheet-handle')!;
    spyOn(handle, 'setPointerCapture');
    const swipe = (from: number, to: number) => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientY: from }));
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientY: to }));
      handle.dispatchEvent(new MouseEvent('click', { detail: 1 }));
      view.detectChanges();
    };

    swipe(420, 340);
    expect(handle.getAttribute('aria-expanded')).toBe('true');
    swipe(120, 200);
    expect(handle.getAttribute('aria-expanded')).toBe('false');
    expect(page.mode).toBe('fixed');

    handle.click();
    view.detectChanges();
    expect(handle.getAttribute('aria-expanded')).toBe('true');
  });

  it('lists only routes with an eligible pickup within 1 km of the latest GPS fix', async () => {
    const view = fixture();
    const page = view.componentInstance;
    const near = { id: 1, name: 'Nearby pickup', lat: 34.304, lng: 74.47, is_pickup: true, is_active: true };
    const far = { ...near, id: 2, name: 'Far pickup', lat: 34.313 };
    (page as any).homeRouteCatalog = [
      { id: 10, stops: [{ ...near, is_pickup: false }, far] },
      { id: 11, stops: [far, near, { ...near, id: 3, is_temporarily_unavailable: true }] },
      { id: 12, stops: [{ ...near, is_active: false }] },
    ];

    await (page as any).updateMapPosition(34.3, 74.47, 10, false);
    expect(page.homeRoutes.map(route => route.id)).toEqual([11]);
    expect(page.homeRoutes[0].nearbyPickups?.map(stop => stop.id)).toEqual([1]);

    await (page as any).updateMapPosition(34.315, 74.47, 10, false);
    expect(page.homeRoutes.map(route => route.id)).toEqual([10, 11]);
    expect(page.homeRoutes[1].nearbyPickups?.map(stop => stop.id)).toEqual([2]);
  });

  it('clears the selected destination and restores the Home GPS camera', () => {
    const view = fixture();
    const page = view.componentInstance;
    page.mapReady = true;
    page.located = true;
    const destination = { map: {} };
    const pickup = { map: destination.map };
    const otherPickup: { map: object | null } = { map: null };
    const internals = page as any;
    internals.map = destination.map;
    internals.previewPickupKey = '34.304,74.47';
    internals.pickupDestinationMarker = destination;
    internals.nearbyPickupMarkers.set(internals.previewPickupKey, pickup);
    internals.nearbyPickupMarkers.set('34.305,74.47', otherPickup);
    page.gpsFollow = false;
    view.detectChanges();

    const root = view.nativeElement as HTMLElement;
    root.querySelector<HTMLButtonElement>('.bh-clear-route')!.click();
    view.detectChanges();

    expect(destination.map).toBeNull();
    expect(pickup.map).not.toBeNull();
    expect(otherPickup.map).toBe(pickup.map);
    expect(page.gpsFollow).toBeTrue();
    expect(root.querySelector('.bh-clear-route')).toBeNull();
  });

  it('falls back to the profile icon if the photo fails, and accepts an updated photo URL', () => {
    const view = fixture();
    view.componentInstance.located = true;
    const auth = TestBed.inject(AuthService);
    let avatar = 'https://example.invalid/profile.png';
    spyOn(auth, 'resolveAvatarUrl').and.callFake(() => avatar);
    view.detectChanges();
    const root = view.nativeElement as HTMLElement;
    const image = root.querySelector('.bh-profile-image') as HTMLImageElement;
    expect(image).not.toBeNull();
    image.dispatchEvent(new Event('error'));
    view.detectChanges();
    expect(root.querySelector('.bh-profile-image')).toBeNull();
    expect(root.querySelector('ion-menu-button ion-icon')?.getAttribute('name')).toBe('person-outline');
    avatar = 'https://example.invalid/updated.png';
    // A subsequent bound event triggers the same OnPush refresh as returning from profile.
    root.querySelector<HTMLButtonElement>('#bh-home-offers-title + button, .bh-promotion-tabs button')!.click();
    view.detectChanges();
    expect(root.querySelector('.bh-profile-image')?.getAttribute('src')).toBe(avatar);
  });

  it('blocks Home with a non-dismissible full-screen gate while location is loading', () => {
    const view = fixture();
    const page = view.componentInstance;
    page.locationFetching = true;
    page.halfBanner = { title: 'Test offer', image_url: '' } as any;
    view.detectChanges();
    const root = view.nativeElement as HTMLElement;
    const gate = root.querySelector('.bh-location-gate') as HTMLElement;
    expect(gate.textContent).toContain('No location available');
    expect(gate.querySelectorAll('button').length).toBe(1);
    expect(gate.querySelector('button')!.disabled).toBeTrue();
    expect(root.querySelector('.bh-home-content')!.hasAttribute('inert')).toBeTrue();
    expect(gate.querySelector('[aria-label*="Close"]')).toBeNull();
  });

  it('shows promotional banners and switches to coupons in the shared section', () => {
    const view = fixture();
    const page = view.componentInstance;
    page.located = true;
    page.locationFetching = false;
    page.halfBanner = { id: 1, title: 'Banner-only offer', image_url: '' } as any;
    page.homeOffers = [{ id: 2, title: 'COUPON_ONLY', discount_label: '10% off', status: 'available', is_available: true }];
    view.detectChanges();
    const root = view.nativeElement as HTMLElement;
    expect(root.querySelector('.bh-offers-section')).not.toBeNull();
    expect(root.querySelector('[aria-label="Promotional offers"]')?.textContent).toContain('Banner-only offer');
    root.querySelector<HTMLButtonElement>('[aria-controls="bh-home-coupons-panel"]')!.click();
    view.detectChanges();
    expect(root.querySelector('#bh-home-offers-panel')?.hasAttribute('hidden')).toBeTrue();
    expect(root.querySelector('#bh-home-coupons-panel')?.hasAttribute('hidden')).toBeFalse();
    expect(root.querySelector('[aria-label="Available coupons"]')?.textContent).toContain('COUPON_ONLY');
  });

  it('replaces a failed banner image with the standard fallback', () => {
    const view = fixture();
    const page = view.componentInstance;
    page.located = true;
    page.halfBanner = { id: 1, title: 'Offer', image_url: 'https://example.invalid/banner.png' } as any;
    view.detectChanges();
    const root = view.nativeElement as HTMLElement;
    const image = root.querySelector('.bh-offer-banner-image') as HTMLImageElement;
    expect(image).not.toBeNull();
    image.dispatchEvent(new Event('error'));
    view.detectChanges();
    expect(root.querySelector('.bh-offer-banner-image')).toBeNull();
    expect(root.querySelector('.bh-inline-offer .bh-offer-art ion-icon')?.getAttribute('name')).toBe('gift-outline');
    expect(root.querySelector('.bh-inline-offer')?.textContent).toContain('Offer');
  });

  for (const gps of [null, { lat: 34.02, lng: 74.02 }]) {
    it(gps ? 'uses GPS for the customer pin' : 'blocks booking without inventing a city when GPS is unavailable', async () => {
      const view = fixture();
      const page = view.componentInstance as any;
      page.booking = {
        cities: async () => [{ id: 1, name: 'City', center_lat: 34, center_lng: 74 }],
        catalog: async () => [], setCity: () => {}, setMode: () => {},
      };
      page.geo = { getCurrentPosition: async () => gps, getCurrentFix: async () => null };
      page.map = { setCenter: jasmine.createSpy('setCenter'), setZoom: jasmine.createSpy('setZoom') };
      const pin = spyOn(page, 'updateMapPosition').and.resolveTo();
      await page.loadLocationAndCatalog();
      expect(page.locationFetching).toBeFalse();
      if (gps) {
        expect(pin).toHaveBeenCalledWith(gps.lat, gps.lng, 40, true);
        expect(page.located).toBeTrue();
      } else {
        expect(pin).not.toHaveBeenCalled();
        expect(page.userMarker).toBeNull();
        expect(page.currentCoords).toBeNull();
        expect(page.map.setCenter).not.toHaveBeenCalled();
        expect(page.city).toBeNull();
        expect(page.tiles).toEqual([]);
        expect(page.located).toBeFalse();
      }
    });
  }
});
