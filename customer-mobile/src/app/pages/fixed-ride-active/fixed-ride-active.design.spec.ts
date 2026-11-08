import { CommonModule } from '@angular/common';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AlertController, Platform, ToastController } from '@ionic/angular';
import { of, throwError } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FixedCustomerLocationService } from '../../core/fixed-customer-location.service';
import { GeolocationService } from '../../core/geolocation.service';
import { PlacesService } from '../../core/places.service';
import { RealtimeService } from '../../core/realtime.service';
import { FixedRideActivePage } from './fixed-ride-active.page';

describe('Live ride reference design', () => {
  beforeEach(async () => {
    spyOn(FixedRideActivePage.prototype, 'ngOnDestroy').and.stub();
    await TestBed.configureTestingModule({
      declarations: [FixedRideActivePage], imports: [CommonModule, FormsModule], schemas: [NO_ERRORS_SCHEMA],
      providers: [ApiService, ActivatedRoute, Router, AlertController, ToastController, Platform,
        AuthService, FixedCustomerLocationService, GeolocationService, PlacesService, RealtimeService]
        .map(provide => ({ provide, useValue: {} })),
    }).compileComponents();
  });
  function setup(overrides: any = {}) {
    const view = TestBed.createComponent(FixedRideActivePage);
    const page = view.componentInstance;
    page.booking = {
      id: 31, trip_id: 8, status: 'BOOKED', departure_status: 'DISPATCHED', seats: 1,
      board: 'Board stop', drop: 'Drop stop', board_lat: 34, board_lng: 74, fare_amount: 10,
      driver_name: 'Actual driver', vehicle_reg_no: 'Actual registration', boarding_code: '2468',
      seat_labels: ['2A'], payment_method: 'cash', payment_status: 'PENDING',
      stops: [{ id: 3, seq: 50, name: 'Board stop', lat: 34, lng: 74 },
        { id: 1, seq: 10, name: 'First stop', lat: 33, lng: 73 },
        { id: 2, seq: 30, name: 'Second stop', lat: 33.5, lng: 73.5 }],
      ...overrides,
    };
    view.detectChanges();
    return { view, page, root: view.nativeElement as HTMLElement };
  }
  it('uses actual stop order rather than sequence number gaps to count stops away', () => {
    const { page } = setup({ fixed_last_reached_stop_seq: 10 });
    expect(page.progressTitle(page.booking!)).toBe('Cab is 2 stops away');
    expect(page.orderedStops(page.booking!).map(stop => stop.seq)).toEqual([10, 30, 50]);
    expect(page.progressTitle({ ...page.booking!, fixed_last_reached_stop_seq: 30 })).toBe('Cab is 1 stop away');
    expect(page.progressTitle({ ...page.booking!, fixed_last_reached_stop_seq: 50 })).toBe('Cab reached your pickup stop');
  });
  it('does not invent stop position, arrival time or paid status when data is missing', () => {
    const { page, root } = setup({ payment_method: null, payment_status: null, fixed_last_reached_stop_seq: null });
    expect(page.progressTitle(page.booking!)).toBe('Booking confirmed');
    expect(page.paymentLine(page.booking!)).toBe('Method unavailable · Status unavailable');
    expect(root.querySelectorAll('.stop-item.is-current').length).toBe(0);
    expect(root.textContent).not.toContain('3 min');
    expect(root.textContent).not.toContain('Trip protection is on');
  });
  it('renders the real driver, boarding digits, seats and payment within reference cards', () => {
    const { root } = setup();
    expect(root.querySelector('.driver-card')?.textContent).toContain('Actual driver');
    expect(root.querySelector('.code-digits')?.textContent?.replace(/\s/g, '')).toBe('2468');
    expect(root.querySelector('.journey-fare')?.textContent).toContain('Seat 2A');
    expect(root.querySelector('.journey-fare')?.textContent).toContain('Cash');
    expect(root.querySelector('.sos-button')).not.toBeNull();
  });
  it('hides boarding and walking controls after boarding and cancellation after departure', () => {
    const { root, page } = setup({ status: 'BOARDED', departure_status: 'DEPARTED', boarding_code: null });
    expect(root.querySelector('.boarding-card')).toBeNull();
    expect(root.querySelector('.pickup-card')).toBeNull();
    expect(root.querySelector('.cancel-button')).toBeNull();
    expect(page.canWalkToPickup({ ...page.booking!, status: 'BOOKED', board_lat: null })).toBeFalse();
  });
  it('shows existing rating actions and hides active actions on a completed ride', () => {
    const { root } = setup({ status: 'COMPLETED', boarding_code: null });
    expect(root.querySelector('.rating-card')).not.toBeNull();
    expect(root.querySelector('.ride-actions')).toBeNull();
    expect(root.querySelector('.cancel-button')).toBeNull();
  });
  it('keeps a stale boarding code hidden after boarding and shows the actual drop stop', () => {
    const { root } = setup({ status: 'BOARDED', boarding_code: '2468' });
    expect(root.querySelector('.boarding-card')).toBeNull();
    expect(root.querySelector('.destination-card')?.textContent).toContain('Drop stop');
    expect(root.querySelector('[aria-current="step"]')?.textContent).toContain('Boarded');
    expect(root.querySelector('.rating-card')).toBeNull();
  });
  it('shows drop-off and completion from booking status without stale pickup messaging', () => {
    const { root, page, view } = setup({ status: 'DROPPED', boarding_code: '2468', fixed_live_status: { detail: 'Cab reached pickup' } });
    expect(root.querySelector('.arrival-card')?.textContent).toContain('You have arrived at your drop-off stop.');
    expect(root.querySelector('.arrival-card')?.textContent).not.toContain('Cab reached pickup');
    expect(root.querySelector('[aria-current="step"]')?.textContent).toContain('Dropped off');
    expect(root.querySelector('.boarding-card')).toBeNull();
    expect(root.querySelector('.payment-detail')?.textContent).toContain('Pending');
    expect(root.querySelector('.rating-card')).not.toBeNull();
    page.booking = { ...page.booking!, status: 'COMPLETED', rating_score: 4 };
    view.detectChanges();
    expect(root.querySelector('[aria-current="step"]')?.textContent).toContain('Completed');
    expect(root.querySelector('.rating-card')).toBeNull();
    expect(root.querySelector('.review-done')?.textContent).toContain('4/5');
  });
  it('does not present a cancelled booking as a successful arrival', () => {
    const { root } = setup({ status: 'CANCELLED', boarding_code: '2468' });
    expect(root.querySelector('.arrival-card')?.textContent).toContain('Cancelled');
    expect(root.querySelector('.journey-stages')).toBeNull();
    expect(root.querySelector('.boarding-card')).toBeNull();
    expect(root.querySelector('.rating-card')).toBeNull();
  });
  it('replaces an active ride with the cancelled state when the next poll returns admin cancellation', () => {
    const { root, page, view } = setup({ status: 'BOARDED' });
    TestBed.inject(ActivatedRoute).snapshot = { paramMap: { get: () => '31' } } as any;
    const cancelled = { ...page.booking!, status: 'CANCELLED', boarding_code: null };
    TestBed.inject(ApiService).get = jasmine.createSpy().and.returnValue(of({ booking: cancelled }));
    TestBed.inject(FixedCustomerLocationService).stop = jasmine.createSpy().and.resolveTo();
    spyOn<any>(page, 'initOrUpdateMap').and.stub();
    spyOn<any>(page, 'syncRealtimeTracking').and.stub();
    spyOn<any>(page, 'refreshWalkingDistance').and.resolveTo();
    (page as any).silentReload();
    view.detectChanges();
    expect(TestBed.inject(ApiService).get).toHaveBeenCalledWith('/fixed/bookings/31');
    expect(root.querySelector('.arrival-card')?.textContent).toContain('Cancelled');
    expect(root.querySelector('.progress-card')).toBeNull();
    expect(root.querySelector('.destination-card')).toBeNull();
    expect(root.querySelector('.boarding-card')).toBeNull();
    expect(root.querySelector('.ride-actions')).toBeNull();
    expect(TestBed.inject(FixedCustomerLocationService).stop).toHaveBeenCalled();
  });
  it('requires confirmation before calling the existing SOS endpoint', async () => {
    const { page } = setup();
    const alert = { present: jasmine.createSpy().and.resolveTo(), onDidDismiss: jasmine.createSpy().and.resolveTo({ role: 'cancel' }) };
    const alerts = TestBed.inject(AlertController);
    alerts.create = jasmine.createSpy().and.resolveTo(alert as any);
    const api = TestBed.inject(ApiService);
    api.post = jasmine.createSpy().and.returnValue(of({}));
    const toast = { present: jasmine.createSpy().and.resolveTo() };
    TestBed.inject(ToastController).create = jasmine.createSpy().and.resolveTo(toast as any);
    await page.triggerSOS();
    expect(api.post).not.toHaveBeenCalled();
    alert.onDidDismiss.and.resolveTo({ role: 'confirm' });
    await page.triggerSOS();
    expect(api.post).toHaveBeenCalledWith('/trips/8/sos', {});
    expect(page.sosBusy).toBeFalse();
    (api.post as jasmine.Spy).and.returnValue(throwError(() => new Error('offline')));
    await page.triggerSOS();
    expect(page.sosBusy).toBeFalse();
    expect(TestBed.inject(ToastController).create).toHaveBeenCalledWith(jasmine.objectContaining({ message: jasmine.stringMatching('Could not send SOS') }));
  });
  it('keeps the custom stop scrollbar synchronized with the timeline', () => {
    const { page } = setup();
    const rail = document.createElement('div');
    Object.defineProperties(rail, { scrollWidth: { value: 800 }, clientWidth: { value: 400 }, scrollLeft: { value: 200 } });
    page.updateStopScroll({ target: rail } as unknown as Event);
    expect(page.stopScrollPercent).toBe(50);
    const scrollTo = jasmine.createSpy();
    rail.scrollTo = scrollTo;
    page.scrollStopTimeline(rail, { target: { value: '75' } } as unknown as Event);
    expect(scrollTo).toHaveBeenCalledWith({ left: 300 });
  });
  it('renders only real boarding/review data and has no component-preview controls', () => {
    const { root } = setup({ boarding_code: null, rating_score: null });
    expect(root.querySelector('.boarding-card')).toBeNull();
    expect(root.querySelector('.review-done')).toBeNull();
    expect(root.querySelector('.rating-card')).toBeNull();
    expect(root.querySelector('.preview-toggle, .preview-notice')).toBeNull();
    expect(root.textContent).not.toContain('Show all components');
    expect(root.textContent).not.toContain('Design preview');
  });
  it('starts with progress, removes recenter and expands/collapses the ride sheet', () => {
    const { root, page, view } = setup();
    expect(root.querySelector('.live-sheet-scroll')!.firstElementChild?.classList.contains('progress-card')).toBeTrue();
    expect(root.querySelector('.live-recenter')).toBeNull();
    root.querySelector<HTMLButtonElement>('.sheet-handle')!.click(); view.detectChanges();
    expect(page.sheetExpanded).toBeTrue();
    expect(root.querySelector('.live-sheet')!.classList.contains('is-expanded')).toBeTrue();
    root.querySelector<HTMLButtonElement>('.sheet-handle')!.click(); view.detectChanges();
    expect(page.sheetExpanded).toBeFalse();
  });
  it('shows server arrival/approach labels while terminal statuses remain authoritative', () => {
    const { page } = setup();
    for (const [key, label, tone] of [['driver_arrived', 'Driver arrived', 'warning'], ['vehicle_approaching', 'Vehicle approaching', 'primary'], ['leaving_soon', 'Leaving soon', 'danger']]) {
      const ride = { ...page.booking!, fixed_live_status: { key, label, tone, detail: 'Server detail' } };
      expect(page.bookingStatusLabel(ride)).toBe(label);
      expect(page.progressTitle(ride)).toBe(label);
      expect(page.statusClass(ride)).toBe('status--' + tone);
      expect(page.bookingStatusLabel({ ...ride, status: 'COMPLETED' })).toBe('Ride completed');
    }
  });
  it('ignores stale forming progress and fills only connections up to the reached stop', () => {
    const { page, root } = setup({ fixed_last_reached_stop_seq: 30 });
    const stops = Array.from(root.querySelectorAll('.stop-item'));
    expect(stops.map(stop => stop.classList.contains('is-reached'))).toEqual([true, true, false]);
    expect(stops.map(stop => stop.classList.contains('is-passed'))).toEqual([true, false, false]);
    expect(stops.map(stop => stop.classList.contains('is-current'))).toEqual([false, true, false]);
    const forming = { ...page.booking!, departure_status: 'FORMING' };
    expect(page.orderedStops(forming).some(stop => page.hasReached(forming, stop))).toBeFalse();
    expect(page.progressTitle(forming)).toBe('Booking confirmed');
  });
  it('shows routed walking distance and duration, rate-limits GPS updates and removes payment card', async () => {
    const { page, root, view } = setup();
    (page as any).userPosition = { lat: 33.9, lng: 73.9 };
    const route = spyOn<any>(page, 'fetchWalkingRoute').and.resolveTo({ meters: 350, seconds: 240 });
    await page.refreshWalkingDistance(); view.detectChanges();
    expect(route).toHaveBeenCalledWith({ lat: 33.9, lng: 73.9 }, { lat: 34, lng: 74 });
    expect(root.querySelector('.pickup-card')?.textContent).toContain('350 m walk · about 4 min');
    expect(root.querySelector('.booking-info')).toBeNull();
    await page.refreshWalkingDistance();
    expect(route.calls.count()).toBe(1);
  });
  it('shows a routing failure instead of a straight-line substitute and ignores late results', async () => {
    const { page } = setup();
    (page as any).userPosition = { lat: 33.9, lng: 73.9 };
    const route = spyOn<any>(page, 'fetchWalkingRoute').and.rejectWith(new Error('No route'));
    await page.refreshWalkingDistance();
    expect(page.walkingDistanceMeters).toBeNull();
    expect(page.walkingDistanceLabel()).toContain('Walking distance unavailable');
    let resolve!: (value: any) => void;
    route.and.returnValue(new Promise(done => resolve = done));
    (page as any).walkingLastAttempt = 0;
    const request = page.refreshWalkingDistance();
    page.booking = { ...page.booking!, status: 'BOARDED' };
    await page.refreshWalkingDistance();
    resolve({ meters: 100, seconds: 60 }); await request;
    expect(page.walkingDistanceMeters).toBeNull();
  });
  it('refreshes displayed status and stop progress on the existing booking poll', () => {
    const { page, root, view } = setup();
    TestBed.inject(ActivatedRoute).snapshot = { paramMap: { get: () => '31' } } as any;
    const updated = { ...page.booking!, fixed_last_reached_stop_seq: 30, fixed_live_status: { key: 'driver_arrived', label: 'Driver arrived', tone: 'warning', detail: 'Waiting at pickup' } };
    TestBed.inject(ApiService).get = jasmine.createSpy().and.returnValue(of({ booking: updated }));
    spyOn<any>(page, 'initOrUpdateMap').and.stub();
    spyOn<any>(page, 'syncRealtimeTracking').and.stub();
    spyOn<any>(page, 'syncFixedLocationStream').and.stub();
    (page as any).silentReload(); view.detectChanges();
    expect(root.querySelector('.status-pill')?.textContent).toBe('Driver arrived');
    expect(root.querySelectorAll('.stop-item.is-reached').length).toBe(2);
  });
});
