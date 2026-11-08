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

describe('Home location gate and catalog continuity', () => {
  const sopore = { lat: 34.3, lng: 74.45 };
  const achabal = { lat: 33.68, lng: 75.22 };
  const catalog = [{ scope: 'local', modes: [{ mode: 'fixed', ride_type_id: 5 }] }];
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => resolve = done);
    return { promise, resolve };
  }
  beforeEach(async () => {
    spyOn(BookingHomePage.prototype, 'ngOnInit').and.stub();
    spyOn(BookingHomePage.prototype, 'ngOnDestroy').and.stub();
    await TestBed.configureTestingModule({
      declarations: [BookingHomePage], imports: [CommonModule], schemas: [NO_ERRORS_SCHEMA],
      providers: [ApiService, AuthService, GeolocationService, PlacesService, RealtimeService,
        BookingService, Router, AlertController].map(provide => ({ provide, useValue: {} })),
    }).compileComponents();
  });
  function setup() {
    const view = TestBed.createComponent(BookingHomePage);
    const page: any = view.componentInstance;
    page.auth = { getUser: () => null, resolveAvatarUrl: () => null };
    page.booking = {
      cities: jasmine.createSpy().and.resolveTo([
        { id: 1, name: 'Achabal', center_lat: achabal.lat, center_lng: achabal.lng },
        { id: 2, name: 'Sopore', center_lat: sopore.lat, center_lng: sopore.lng },
      ]),
      catalog: jasmine.createSpy().and.resolveTo(catalog),
      setCity: jasmine.createSpy(), setMode: jasmine.createSpy(),
    };
    page.geo = {
      getCurrentPosition: jasmine.createSpy().and.resolveTo(sopore),
      getCurrentFix: jasmine.createSpy().and.resolveTo(null),
      requestPermissions: jasmine.createSpy().and.resolveTo(null),
      watchPosition: jasmine.createSpy().and.resolveTo('test-watch'),
      clearWatch: jasmine.createSpy().and.resolveTo(),
    };
    page.places = { reverseGeocodeCity: jasmine.createSpy().and.resolveTo('Outside town') };
    spyOn(page, 'loadHomeRoutes').and.stub();
    return { view, page, root: view.nativeElement as HTMLElement };
  }
  it('does not load a fallback catalog when permission/GPS is unavailable and retries successfully', async () => {
    const { view, page, root } = setup();
    page.geo.getCurrentPosition.and.resolveTo(null);
    await page.loadLocationAndCatalog();
    view.detectChanges();
    expect(page.booking.catalog).not.toHaveBeenCalled();
    expect(page.city).toBeNull();
    expect(root.querySelector('.bh-location-gate')?.textContent).toContain('No location available');
    expect(root.querySelector('.loc-loader-overlay')).toBeNull();
    expect(root.querySelector<HTMLButtonElement>('.bh-location-gate button')!.disabled).toBeFalse();
    expect(root.querySelector('.bh-home-content')!.hasAttribute('inert')).toBeTrue();
    page.watchId = 'denied-watch';
    page.geo.getCurrentPosition.and.resolveTo(sopore);
    await page.requestLocation();
    view.detectChanges();
    expect(page.booking.catalog).toHaveBeenCalledOnceWith(2);
    expect(page.geo.clearWatch).toHaveBeenCalledWith('denied-watch');
    expect(page.city.name).toBe('Sopore');
    expect(page.tiles[0].mode).toBe('fixed');
    expect(page.loadHomeRoutes).toHaveBeenCalled();
    expect(root.querySelector('.bh-location-gate')).toBeNull();
    expect(root.querySelector('.loc-loader-overlay')).toBeNull();
    expect(root.querySelector('.bh-home-content')!.hasAttribute('inert')).toBeFalse();
  });
  it('recovers automatically when a late watch fix arrives after GPS failed', async () => {
    const { page } = setup();
    page.geo.getCurrentPosition.and.resolveTo(null);
    await page.loadLocationAndCatalog();
    await page.onLocationFix(sopore);
    expect(page.located).toBeTrue();
    expect(page.currentCoords).toEqual(sopore);
    expect(page.booking.setCity).toHaveBeenCalledOnceWith(2);
  });
  it('ignores an older GPS result after a watch fix selected the correct city', async () => {
    const { page } = setup();
    const old = deferred<any>();
    page.geo.getCurrentPosition.and.returnValue(old.promise);
    const loading = page.loadLocationAndCatalog();
    await page.onLocationFix(sopore);
    old.resolve(achabal);
    await loading;
    expect(page.city.name).toBe('Sopore');
    expect(page.booking.setCity).toHaveBeenCalledOnceWith(2);
  });
  it('ignores an older catalog response and does not unlock Home before the new catalog is ready', async () => {
    const { page } = setup();
    const old = deferred<any>();
    page.booking.catalog.and.callFake((id: number) => id === 1 ? old.promise : Promise.resolve(catalog));
    page.geo.getCurrentPosition.and.resolveTo(achabal);
    const loading = page.loadLocationAndCatalog();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(page.booking.catalog).toHaveBeenCalledWith(1);
    expect(page.located).toBeFalse();
    await page.onLocationFix(sopore);
    old.resolve([]);
    await loading;
    expect(page.city.name).toBe('Sopore');
    expect(page.tiles[0].mode).toBe('fixed');
    expect(page.booking.setCity).toHaveBeenCalledOnceWith(2);
  });
  it('does not reload the catalog on GPS jitter after successful resolution', async () => {
    const { page } = setup();
    await page.loadLocationAndCatalog();
    await page.onLocationFix({ lat: sopore.lat + 0.0001, lng: sopore.lng });
    expect(page.booking.catalog).toHaveBeenCalledTimes(1);
    expect(page.located).toBeTrue();
  });
  it('recenters on the last device fix immediately even if a fresh request times out', async () => {
    const { page } = setup();
    await page.loadLocationAndCatalog();
    const fresh = deferred<null>();
    page.geo.getCurrentPosition.and.returnValue(fresh.promise);
    page.map = { moveCamera: jasmine.createSpy('moveCamera') };

    const recentering = page.recenterMap();

    expect(page.map.moveCamera).toHaveBeenCalledWith(jasmine.objectContaining({ center: sopore }));
    expect(page.refreshingMapLocation).toBeTrue();
    fresh.resolve(null);
    await recentering;

    expect(page.mapLocationMessage).toContain('last known location');
    expect(page.located).toBeTrue();
    expect(page.refreshingMapLocation).toBeFalse();
  });
  it('uses a fresh fix and updates the service area when the device has moved', async () => {
    const { page } = setup();
    await page.loadLocationAndCatalog();
    page.geo.getCurrentPosition.and.resolveTo(achabal);
    page.map = { moveCamera: jasmine.createSpy('moveCamera') };
    page.userMarker = {};
    const follow = spyOn(page.activeNavigation, 'follow');

    await page.recenterMap();

    expect(page.currentCoords).toEqual(achabal);
    expect(follow).toHaveBeenCalledWith(page.map, achabal, null, page.userMarker, true);
    expect(page.city.name).toBe('Achabal');
    expect(page.mapLocationMessage).toBe('');
  });
  it('keeps a catalog failure distinct from a successful empty service area', async () => {
    const { page } = setup();
    page.booking.catalog.and.rejectWith(new Error('offline'));
    await page.loadLocationAndCatalog();
    expect(page.located).toBeFalse();
    expect(page.locationMessage).toContain('couldn’t load rides');
    page.booking.catalog.and.resolveTo([]);
    await page.requestLocation();
    expect(page.located).toBeTrue();
    expect(page.city.name).toBe('Sopore');
    expect(page.tiles).toEqual([]);
  });
  it('preserves outside-city naming and the existing nearest-catalog rule', async () => {
    const { page } = setup();
    page.geo.getCurrentPosition.and.resolveTo({ lat: 34.5, lng: 74.45 });
    await page.loadLocationAndCatalog();
    expect(page.places.reverseGeocodeCity).toHaveBeenCalled();
    expect(page.city.name).toBe('Outside town');
    expect(page.booking.catalog).toHaveBeenCalledWith(2);
  });
  it('does not lock a resolved location again when map marker rendering fails', async () => {
    const { page } = setup();
    page.map = {};
    spyOn(page, 'updateMapPosition').and.rejectWith(new Error('Map marker unavailable'));
    await page.loadLocationAndCatalog();
    expect(page.located).toBeTrue();
    expect(page.city.name).toBe('Sopore');
    expect(page.tiles[0].mode).toBe('fixed');
  });
  it('ignores late GPS results after leaving Home and clears a late watch registration', async () => {
    const { page } = setup();
    const gps = deferred<any>();
    const watch = deferred<string>();
    page.geo.getCurrentPosition.and.returnValue(gps.promise);
    page.geo.watchPosition.and.returnValue(watch.promise);
    const loading = page.loadLocationAndCatalog();
    const watching = page.startWatch();
    page.ionViewDidLeave();
    gps.resolve(sopore); watch.resolve('late-watch');
    await loading; await watching;
    expect(page.booking.setCity).not.toHaveBeenCalled();
    expect(page.geo.clearWatch).toHaveBeenCalledWith('late-watch');
  });
});
