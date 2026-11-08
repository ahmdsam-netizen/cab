import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { AlertController, ToastController } from '@ionic/angular';
import { of, Subject } from 'rxjs';
import { FixedDriverPage } from './fixed-driver.page';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { BackgroundLocationService } from '../../core/background-location.service';
import { GeolocationService } from '../../core/geolocation.service';
import { PlacesService } from '../../core/places.service';
import { RealtimeService } from '../../core/realtime.service';
import { AudioRingtoneService } from '../../core/audio-ringtone.service';
import { PushService } from '../../core/push.service';

describe('Active route reference layout', () => {
  beforeEach(async () => {
    spyOn(FixedDriverPage.prototype, 'ngOnDestroy').and.stub();
    await TestBed.configureTestingModule({
      declarations: [FixedDriverPage], imports: [CommonModule, FormsModule], schemas: [NO_ERRORS_SCHEMA],
      providers: [
        { provide: ActivatedRoute, useValue: { queryParams: of({}) } },
        { provide: AuthService, useValue: { getUser: () => ({}) } },
        ...[ApiService, Router, AlertController, ToastController, BackgroundLocationService, GeolocationService, PlacesService, RealtimeService, AudioRingtoneService, PushService].map(provide => ({ provide, useValue: {} })),
      ],
    }).compileComponents();
  });
  function setup() {
    const f = TestBed.createComponent(FixedDriverPage);
    const page: any = f.componentInstance;
    page.activeVehicle = { id: 12, route_name: 'Test route', status: 'DEPARTED', capacity: 3, seats_taken: 1, seats_remaining: 2 };
    page.stops = [{ id: 1, seq: 1, name: 'First stop', lat: 34, lng: 74 }];
    page.seatMapData = { cells: [
      { row: 1, col: 1, kind: 'seat', label: '1A', status: 'BOOKED' },
      { row: 1, col: 2, kind: 'seat', label: '1B', status: 'AVAILABLE' },
      { row: 2, col: 1, kind: 'seat', label: '2A', status: 'HELD' },
    ] };
    f.detectChanges(); return { f, page };
  }
  it('keeps the map outside the modal and renders configured seats inside it', () => {
    const { f, page } = setup();
    expect(f.nativeElement.querySelectorAll('#fixed-driver-embedded-map').length).toBe(1);
    expect(f.nativeElement.querySelector('.route-workspace .route-live-panel')).toBeNull();
    expect(f.nativeElement.querySelectorAll('.route-mini-seat').length).toBe(0);
    spyOn(page, 'loadDepartureSeatMap');
    f.nativeElement.querySelector('.route-filled').click(); f.detectChanges();
    expect(page.sheetTab).toBe('seats');
    expect(f.nativeElement.querySelector('.dc-manifest-modal-sheet .route-modal-panel')).toBeTruthy();
    expect(f.nativeElement.querySelector('.dc-manifest-modal-overlay').closest('ion-content')).toBeNull();
    expect(f.nativeElement.querySelectorAll('.route-mini-seat').length).toBe(3);
    expect(f.nativeElement.querySelector('.route-mini-seat.is-booked').textContent).toContain('1A');
    expect(f.nativeElement.querySelector('.route-mini-seat.is-held').textContent).toContain('2A');
    const navigate = spyOn(page, 'navigateToStop');
    f.nativeElement.querySelector('.route-map-navigate').click();
    expect(navigate).toHaveBeenCalledWith(jasmine.objectContaining({ id: 1 }));
    const details = spyOn(page, 'onSeatCellTap');
    f.nativeElement.querySelector('.route-mini-seat').click();
    expect(details).toHaveBeenCalledWith(jasmine.objectContaining({ label: '1A' }));
  });

  it('highlights the same next stop as the card and advances after recorded progress', () => {
    const { page } = setup();
    page.stops.push({ id: 2, seq: 2, name: 'Second stop' });
    const first = page.buildStopMarker(page.stops[0]);
    expect(first.classList.contains('is-next-stop')).toBeTrue();
    expect(first.style.getPropertyValue('--stop-color')).toBe('#e74848');
    expect(first.textContent).toContain('Next stop');
    expect(page.buildStopMarker(page.stops[1]).classList.contains('is-next-stop')).toBeFalse();
    page.activeVehicle.fixed_last_reached_stop_seq = 1;
    expect(page.nextStopGuide.id).toBe(2);
    expect(page.buildStopMarker(page.stops[0]).classList.contains('is-next-stop')).toBeFalse();
    expect(page.buildStopMarker(page.stops[1]).classList.contains('is-next-stop')).toBeTrue();
  });
  it('switches to passenger list and does not fabricate a missing layout', () => {
    const { f, page } = setup();
    page.detailsModalOpen = true; page.sheetTab = 'seats'; f.detectChanges();
    f.nativeElement.querySelector('.dc-modal-nav-tabs button:last-child').click(); f.detectChanges();
    expect(page.sheetTab).toBe('passengers');
    expect(f.nativeElement.querySelector('.route-modal-panel').textContent).toContain('No passengers found');
    expect(f.nativeElement.querySelector('.route-modal-panel').textContent).toContain('Waiting (0)');
    page.selectSheetTab('seats'); page.seatMapData = null; f.detectChanges();
    expect(f.nativeElement.querySelector('.route-seat-empty').textContent).toContain('unavailable');
    expect(f.nativeElement.querySelectorAll('.route-mini-seat').length).toBe(0);
  });
  it('ignores a seat response arriving after departure cancellation', () => {
    const { page } = setup(); const response = new Subject<any>();
    page.api = { get: () => response }; page.seatMapData = null;
    page.loadDepartureSeatMap(12); page.activeVehicle = null;
    response.next({ cells: [{ label: 'stale' }] }); response.complete();
    expect(page.seatMapData).toBeNull(); expect(page.seatMapLoading).toBeFalse();
  });

  it('keeps arrival boarding locked until pickup is reached and shows the verification lockout', () => {
    const { f, page } = setup();
    const passenger = { id: 9, customer_name: 'Test passenger', seats: 1, seat_labels: ['1A'], status: 'CONFIRMED', board_stop_id: 1, drop_stop_id: 2 };
    page.passengers = [passenger]; page.openStopDetail(page.stops[0]); f.detectChanges();
    const verify = f.nativeElement.querySelector('.connected-board-action');
    expect(verify.disabled).toBeTrue();
    page.activeVehicle.fixed_last_reached_stop_seq = 1; page.openStopDetail(page.stops[0]); f.detectChanges();
    expect(f.nativeElement.querySelector('.connected-board-action').disabled).toBeFalse();
    page.otpPassenger = passenger; page.otpCode = '1234'; page.otpLockedFor = 20; f.detectChanges();
    expect(f.nativeElement.querySelector('.otp-submit-btn').disabled).toBeTrue();
    expect(f.nativeElement.querySelector('.connected-verification').textContent).toContain('Test passenger');
    expect(f.nativeElement.querySelector('.otp-instruction').textContent).toContain('shown in their booking');
  });

  it('shows boarding success only after server confirmation and preserves failure state', async () => {
    const { page } = setup();
    const response = new Subject<any>();
    page.api = { post: jasmine.createSpy().and.returnValue(response) };
    page.otpPassenger = { id: 9, customer_name: 'Test passenger', seats: 1, status: 'CONFIRMED' };
    page.otpCode = '1234'; page.otpLockedFor = 0; page.otpVerifying = false;
    spyOn(page, 'actionCoords').and.resolveTo({}); spyOn(page, 'closeBoardingOtp').and.stub();
    spyOn(page, 'showToast').and.resolveTo(); spyOn(page, 'loadManifest').and.stub();
    await page.confirmBoardingOtp();
    expect(page.boardingSuccess).toBeNull();
    response.error({ error: { message: 'Wrong code' } });
    expect(page.boardingSuccess).toBeNull(); expect(page.otpError).toBe('Wrong code');
    const success = new Subject<any>(); page.api.post.and.returnValue(success); page.otpCode = '1234';
    await page.confirmBoardingOtp(); success.next({ message: 'Boarded' }); success.complete();
    expect(page.boardingSuccess.status).toBe('BOARDED');
  });

  it('uses the passenger photo in arrival and verification, with a failed-image fallback', () => {
    const { f, page } = setup();
    const passenger = { id: 9, customer_name: 'Photo passenger', seats: 1, seat_labels: ['1A'],
      status: 'CONFIRMED', board_stop_id: 1, drop_stop_id: 2,
      customer_avatar_url: '/assets/sample-passenger.png' };
    page.passengers = [passenger]; page.activeVehicle.fixed_last_reached_stop_seq = 1;
    page.openStopDetail(page.stops[0]); page.otpPassenger = passenger; f.detectChanges();
    const arrivalPhoto = f.nativeElement.querySelector('.p-mini-avatar img');
    expect(arrivalPhoto.getAttribute('src')).toBe('/assets/sample-passenger.png');
    expect(f.nativeElement.querySelector('.connected-passenger-identity img')).toBeTruthy();
    expect(f.nativeElement.querySelector('.connected-board-action')).toBeTruthy();
    expect(f.nativeElement.querySelector('.stop-passenger-mini-card .p-mini-status')).toBeNull();
    arrivalPhoto.dispatchEvent(new Event('error')); f.detectChanges();
    expect(f.nativeElement.querySelector('.p-mini-avatar img')).toBeNull();
    expect(f.nativeElement.querySelector('.p-mini-avatar ion-icon')).toBeTruthy();
    expect(f.nativeElement.querySelector('.connected-passenger-identity img')).toBeNull();
    passenger.customer_avatar_url = '/assets/updated-passenger.png'; f.detectChanges();
    expect(f.nativeElement.querySelector('.connected-passenger-identity img')).toBeTruthy();
  });

  it('boards from the arrival footer only when an eligible passenger exists', async () => {
    const { f, page } = setup();
    page.passengers = [{ id: 9, seats: 1, status: 'CONFIRMED', board_stop_id: 1, drop_stop_id: 2 }];
    const board = spyOn(page, 'board').and.resolveTo();
    page.openStopDetail(page.stops[0]); f.detectChanges();
    expect(f.nativeElement.querySelector('.arrival-stop-footer button').disabled).toBeTrue();
    await page.verifyStopPassengers(); expect(board).not.toHaveBeenCalled();
    page.activeVehicle.fixed_last_reached_stop_seq = 1;
    page.openStopDetail(page.stops[0]); f.detectChanges();
    expect(f.nativeElement.querySelector('.arrival-stop-footer button').disabled).toBeFalse();
    await page.verifyStopPassengers(); expect(board).toHaveBeenCalledWith(page.passengers[0]);
  });

  it('shows completion summary only after confirmed server completion', async () => {
    const { f, page } = setup(); const response = new Subject<any>();
    page.passengers = [{ id: 9, seats: 2, status: 'DROPPED' }];
    page.alerts = { create: async () => ({ present: async () => {}, onDidDismiss: async () => ({ role: 'confirm' }) }) };
    page.api = { post: jasmine.createSpy().and.returnValue(response) };
    spyOn(page, 'stopManifestPolling'); spyOn(page, 'stopFixedTripLocationStreaming').and.resolveTo();
    spyOn(page, 'showToast').and.resolveTo(); spyOn(page, 'refresh');
    await page.completeRide(); expect(page.completionSummary).toBeNull();
    response.next({ vehicle: { ...page.activeVehicle, status: 'COMPLETED' } }); response.complete();
    await Promise.resolve(); await Promise.resolve(); f.detectChanges();
    expect(page.completionSummary.dropped).toBe(2);
    expect(f.nativeElement.querySelector('[aria-label="Route completed"]').textContent).toContain('Test route');
  });
});
