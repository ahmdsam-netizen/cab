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

  it('opens the clicked Home route in fixed booking with its route ID', () => {
    const view = fixture();
    const page = view.componentInstance;
    const booking = TestBed.inject(BookingService);
    const router = TestBed.inject(Router);
    booking.setMode = jasmine.createSpy();
    booking.setScope = jasmine.createSpy();
    router.navigate = jasmine.createSpy().and.resolveTo(true);
    page.tiles = [{ mode: 'fixed', rideTypeId: 2 }] as any;
    page.homeRoutes = [{ id: 42, name: 'Selected route', scope: 'local' }];
    view.detectChanges();
    (view.nativeElement.querySelector('.bh-route-card') as HTMLButtonElement).click();
    expect(router.navigate).toHaveBeenCalledWith(['/customer-tabs/go/fixed'], { queryParams: { routeId: 42 } });
    expect(booking.setMode).toHaveBeenCalledWith('fixed', 2);
    expect(booking.setScope).toHaveBeenCalledWith(page.scope);
  });

  it('falls back to the profile icon if the photo fails, and accepts an updated photo URL', () => {
    const view = fixture();
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
    page.located = true;
    root.querySelector<HTMLButtonElement>('.bh-offer-floating-entry')!.click();
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

  it('opens promotional banners and coupons from the floating entry point', () => {
    const view = fixture();
    const page = view.componentInstance;
    page.located = true;
    page.locationFetching = false;
    page.halfBanner = { id: 1, title: 'Banner-only offer', image_url: '' } as any;
    page.homeOffers = [{ id: 2, title: 'COUPON_ONLY', discount_label: '10% off', status: 'available', is_available: true }];
    view.detectChanges();
    const root = view.nativeElement as HTMLElement;
    expect(root.querySelector('.bh-offers-section')).toBeNull();
    expect(root.querySelector('.bh-offers-modal')).toBeNull();
    root.querySelector<HTMLButtonElement>('.bh-offer-floating-entry')!.click();
    view.detectChanges();
    expect(root.querySelector('[aria-label="Promotional offers"]')?.textContent).toContain('Banner-only offer');
    expect(root.querySelector('[aria-label="Available coupons"]')?.textContent).toContain('COUPON_ONLY');
  });

  it('replaces a failed banner image with the standard fallback', () => {
    const view = fixture();
    const page = view.componentInstance;
    page.located = true;
    page.halfBanner = { id: 1, title: 'Offer', image_url: 'https://example.invalid/banner.png' } as any;
    page.offersModalOpen = true;
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
