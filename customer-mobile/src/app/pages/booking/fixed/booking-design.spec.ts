import { CommonModule } from '@angular/common';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { AlertController, ToastController } from '@ionic/angular';
import { FixedBookPage } from './fixed.page';
import { SeatGridComponent } from './seat-grid.component';
import { StepShellComponent } from '../step-shell.component';
import { ApiService } from '../../../core/api.service';
import { AuthService } from '../../../core/auth.service';
import { BookingService } from '../booking.service';
import { PaymentOptionsService } from '../../../core/payment-options.service';
import { GeolocationService } from '../../../core/geolocation.service';
import { FixedCustomerLocationService } from '../../../core/fixed-customer-location.service';
import { RealtimeService } from '../../../core/realtime.service';
import { AudioAlertService } from '../../../core/audio-alert.service';
import { of, Subject } from 'rxjs';
import { HoldTimerComponent } from '../../fixed-book/hold-timer.component';

describe('Fixed booking reference presentation', () => {
  beforeEach(async () => {
    spyOn(FixedBookPage.prototype, 'ngOnInit').and.stub();
    spyOn(FixedBookPage.prototype, 'ngOnDestroy').and.stub();
    await TestBed.configureTestingModule({
      declarations: [FixedBookPage],
      imports: [CommonModule, FormsModule, StepShellComponent, SeatGridComponent, HoldTimerComponent],
      schemas: [NO_ERRORS_SCHEMA],
      providers: [ApiService, AuthService, BookingService, Router, ActivatedRoute, AlertController,
        ToastController, PaymentOptionsService, GeolocationService, FixedCustomerLocationService,
        RealtimeService, AudioAlertService].map(provide => ({ provide, useValue: {} })),
    }).compileComponents();
  });

  function setup(step: 'seats' | 'review') {
    const fixture = TestBed.createComponent(FixedBookPage);
    const page = fixture.componentInstance;
    Object.assign(page, {
      step, selected: step === 'review' ? ['A'] : [],
      hold: step === 'review' ? { id: 7, seats: 1, amount: 46, status: 'ACCEPTED' } : null,
      route: { name: 'Actual route', flat_fare: 37, luggage_surcharge_amount: 6,
        stops: [{ id: 1, name: 'Actual pickup' }, { id: 2, name: 'Actual drop' }] },
      boardStopId: 1, dropStopId: 2, luggage: 1,
      departure: { id: 3, seats_remaining: 3 },
      seatMap: { layout: { rows: 1, cols: 3 }, cells: [
        { row: 1, col: 1, kind: 'seat', label: 'A', price_delta: 3, status: 'AVAILABLE' },
        { row: 1, col: 2, kind: 'seat', label: 'B', price_delta: 0, status: 'HELD' },
        { row: 1, col: 3, kind: 'blocked', label: 'D', price_delta: 0 },
      ] },
    });
    fixture.detectChanges();
    return { fixture, page, root: fixture.nativeElement as HTMLElement };
  }

  it('cancels from the right-hand button only after the server confirms seat release', () => {
    const { fixture, page, root } = setup('review');
    const released = new Subject<any>();
    const api = TestBed.inject(ApiService);
    const router = TestBed.inject(Router);
    api.post = jasmine.createSpy().and.returnValue(released);
    router.navigate = jasmine.createSpy().and.resolveTo(true);
    page.hold = { id: 9, seats: 1, amount: 46, status: 'ACCEPTED' };
    (page as any).cdr.markForCheck();
    fixture.detectChanges();
    (root.querySelector('.sf__secondary') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(api.post).toHaveBeenCalledOnceWith('/fixed/seat-holds/9/release', {});
    expect(page.hold?.id).toBe(9);
    expect((root.querySelector('.sf__cta') as HTMLButtonElement).disabled).toBeTrue();
    expect(router.navigate).not.toHaveBeenCalled();
    released.next({ hold: { status: 'RELEASED' } });
    expect(page.hold).toBeNull();
    expect(page.selected).toEqual([]);
    expect(router.navigate).toHaveBeenCalledWith(['/customer-tabs/go']);
  });

  it('returns Home when the real payment countdown expires and clears the expired state', fakeAsync(() => {
    const { fixture, page } = setup('review');
    const router = TestBed.inject(Router);
    router.navigate = jasmine.createSpy().and.resolveTo(true);
    spyOn<any>(page, 'toast').and.resolveTo();
    page.hold!.expires_at = new Date(Date.now() + 1000).toISOString();
    page.couponTitle = 'OLD';
    page.couponEditorOpen = true;
    page.paymentModalOpen = true;
    (page as any).cdr.markForCheck();
    fixture.detectChanges();
    tick(1000);
    fixture.detectChanges();
    expect(router.navigate).toHaveBeenCalledOnceWith(['/customer-tabs/go'], { replaceUrl: true });
    expect(page.hold).toBeNull();
    expect(page.selected).toEqual([]);
    expect(page.seatMap).toBeNull();
    expect(page.couponTitle).toBe('');
    expect(page.paymentModalOpen).toBeFalse();
    page.onHoldExpired();
    expect(router.navigate).toHaveBeenCalledTimes(1);
  }));

  it('ignores an old expiry event when a newer hold has time remaining', () => {
    const { page } = setup('review');
    const router = TestBed.inject(Router);
    router.navigate = jasmine.createSpy();
    page.hold!.expires_at = new Date(Date.now() + 300000).toISOString();
    page.onHoldExpired();
    expect(router.navigate).not.toHaveBeenCalled();
    expect(page.hold?.id).toBe(7);
    expect(page.step).toBe('review');
  });

  it('does not reopen checkout if its order response arrives after expiry returned Home', fakeAsync(() => {
    const { page } = setup('review');
    const router = TestBed.inject(Router);
    const api = TestBed.inject(ApiService);
    const order = new Subject<any>();
    router.navigate = jasmine.createSpy().and.resolveTo(true);
    api.post = jasmine.createSpy().and.returnValue(order);
    const notice = spyOn<any>(page, 'toast').and.resolveTo();
    const hold = page.hold!;
    hold.expires_at = new Date(Date.now() - 1000).toISOString();
    void (page as any).startRazorpay(hold);
    page.onHoldExpired();
    order.next({ payment_required: true, razorpay: { order_id: 'late' } });
    order.complete();
    tick();
    expect(page.step).toBe('route');
    expect(page.hold).toBeNull();
    expect(notice).toHaveBeenCalledTimes(1);
    expect(page.paymentModalOpen).toBeFalse();
  }));

  it('retains the held seats and shows an error if cancellation fails', () => {
    const { page } = setup('review');
    const released = new Subject<any>();
    const api = TestBed.inject(ApiService);
    api.post = jasmine.createSpy().and.returnValue(released);
    page.hold = { id: 9, seats: 1, amount: 46, status: 'ACCEPTED' };
    page.cancelReviewRide();
    page.cancelReviewRide();
    expect(api.post).toHaveBeenCalledTimes(1);
    released.error({ error: { message: 'Try again later' } });
    expect(page.hold?.id).toBe(9);
    expect(page.selected).toEqual(['A']);
    expect(page.error).toBe('Try again later');
    expect(page.cancellingHold).toBeFalse();
  });

  it('cancels an unsubmitted draft without calling the release endpoint', () => {
    const { page, root } = setup('review');
    page.hold = null;
    const api = TestBed.inject(ApiService);
    const router = TestBed.inject(Router);
    api.post = jasmine.createSpy();
    router.navigate = jasmine.createSpy().and.resolveTo(true);
    (root.querySelector('.sf__secondary') as HTMLButtonElement).click();
    expect(api.post).not.toHaveBeenCalled();
    expect(page.selected).toEqual([]);
    expect(router.navigate).toHaveBeenCalledWith(['/customer-tabs/go']);
  });

  it('requests directly from seats, waits for approval, then opens payment without a second request', async () => {
    const { fixture, page, root } = setup('seats');
    expect(root.querySelector('.fb-booking-summary')?.textContent).toContain('Actual pickup');
    expect(root.querySelector('.fb-booking-summary')?.textContent).toContain('Actual drop');
    const held = root.querySelector('[aria-label="Seat B, held"]') as HTMLButtonElement;
    expect(held.disabled).toBeTrue();
    held.click();
    expect(page.selected).toEqual([]);
    (root.querySelector('[aria-label="Seat A, free"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(page.selected).toEqual(['A']);
    expect(root.querySelector('.bk-money__tot')?.textContent).toContain('₹46');
    expect(root.querySelector('.fb-coupon-section')).toBeNull();
    const api = TestBed.inject(ApiService);
    api.post = jasmine.createSpy().and.returnValue(of({ hold: { id: 9, seats: 1, amount: 46, status: 'PENDING_DRIVER_APPROVAL' } }));
    spyOn<any>(page, 'startApprovalWaiting').and.stub();
    spyOn<any>(page, 'toast').and.resolveTo();
    (page as any).audioAlert.playDriverAccepted = jasmine.createSpy();
    (root.querySelector('.sf__cta') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(api.post).toHaveBeenCalledWith('/fixed/seat-holds', jasmine.objectContaining({ seat_labels: ['A'] }), jasmine.any(Object));
    expect(page.step).toBe('awaiting_approval');
    expect(page.paymentModalOpen).toBeFalse();
    (page as any).onHoldAccepted({ expires_at: new Date(Date.now() + 300000).toISOString() });
    fixture.detectChanges();
    expect(page.step).toBe('review');
    expect(root.querySelector('.fb-coupon-section')).not.toBeNull();
    (root.querySelector('.sf__cta') as HTMLButtonElement).click();
    expect(page.paymentModalOpen).toBeTrue();
    expect(api.post).toHaveBeenCalledTimes(1);
    await (page as any).onHoldRejected({ hold_id: 9 });
    expect(page.step).toBe('review');
    expect(page.hold?.status).toBe('ACCEPTED');
  });

  it('renders actual coupon totals and opens the existing payment chooser', () => {
    const { fixture, page, root } = setup('review');
    page.selected = ['A'];
    page.hold = { id: 7, seats: 1, amount: 38, discount_amount: 8, status: 'ACCEPTED', expires_at: new Date(Date.now() + 300000).toISOString() };
    page.coupon = { base_amount: 46, discount: 8, final_amount: 38, coupon: { title: 'LIVE8' } };
    (root.querySelector('.sf__cta') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector('.fb-coupon-applied')?.textContent).toContain('LIVE8 applied');
    expect(root.querySelector('.bk-money__tot')?.textContent).toContain('₹38');
    expect(page.paymentModalOpen).toBeTrue();
    expect(root.querySelector('.sf__cta')?.textContent).toContain('Make payment');
    expect(root.querySelector('.sf__dock app-hold-timer')).not.toBeNull();
    expect(root.querySelector('.sf__dock .fb-accepted-banner')).not.toBeNull();
    expect(root.querySelector('.sf__body app-hold-timer')).toBeNull();
    expect(root.querySelector('.sf__body .fb-accepted-banner')).toBeNull();
  });

  it('restores the saved hold fare and stop names when route details are absent after reload', () => {
    const { fixture, page, root } = setup('review');
    page.route = null;
    page.departure = null;
    page.seatMap = null;
    page.selected = ['A'];
    page.hold = { id: 7, seats: 1, amount: 38, status: 'ACCEPTED', original_amount: 46, discount_amount: 8,
      board_stop_id: 1, drop_stop_id: 2, board_stop_name: 'Saved pickup', drop_stop_name: 'Saved drop',
      route_name: 'Saved route', luggage_surcharge_amount: 6 };
    (root.querySelector('.sf__cta') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(page.seatFare).toBe(40);
    expect(page.finalTotal).toBe(38);
    expect(root.querySelector('.sf__trip')?.textContent).toContain('Saved route');
    expect(root.querySelector('.fb-booking-summary')?.textContent).toContain('Saved pickup');
    expect(root.querySelector('.bk-money__tot')?.textContent).toContain('₹38');
    expect(root.querySelector('.sf__cta')?.textContent).toContain('₹38');
    expect(root.querySelector('.fb-coupon-applied')?.textContent).toContain('Coupon applied');
    expect(root.querySelector('.fb-coupon-applied')?.textContent).toContain('−₹8');
    expect(root.querySelector('[aria-label="Coupon code"]')).toBeNull();
  });

  it('does not open payment before driver approval', () => {
    const { fixture, page, root } = setup('seats');
    (root.querySelector('[aria-label="Seat A, free"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    page.pay();
    expect(page.paymentModalOpen).toBeFalse();
    page.hold = { id: 9, seats: 1, amount: 46, status: 'PENDING_DRIVER_APPROVAL' };
    page.pay();
    expect(page.paymentModalOpen).toBeFalse();
  });

  it('applies and removes coupons on the approved hold using the server total', () => {
    const { fixture, page, root } = setup('review');
    const api = TestBed.inject(ApiService);
    const response = new Subject<any>();
    api.post = jasmine.createSpy().and.returnValue(response);
    (root.querySelector('.fb-coupon-trigger') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector('[aria-label="Coupon code"]')).not.toBeNull();
    page.couponTitle = 'LIVE8';
    page.applyCoupon();
    fixture.detectChanges();
    expect(api.post).toHaveBeenCalledWith('/fixed/seat-holds/7/coupon', { coupon_title: 'LIVE8' });
    expect(page.finalTotal).toBe(46);
    expect((root.querySelector('.sf__cta') as HTMLButtonElement).disabled).toBeTrue();
    response.next({ hold: { id: 7, seats: 1, amount: 38, original_amount: 46, discount_amount: 8, coupon_title: 'LIVE8', status: 'ACCEPTED', coupon_editable: true } });
    fixture.detectChanges();
    expect(root.querySelector('.fb-coupon-applied')?.textContent).toContain('LIVE8 applied');
    expect(root.querySelector('.bk-money__tot')?.textContent).toContain('₹38');
    (root.querySelector('[aria-label="Remove coupon"]') as HTMLButtonElement).click();
    expect(api.post).toHaveBeenCalledWith('/fixed/seat-holds/7/coupon', { coupon_title: null });
    response.next({ hold: { id: 7, seats: 1, amount: 46, original_amount: 46, discount_amount: 0, status: 'ACCEPTED', coupon_editable: true } });
    fixture.detectChanges();
    expect(page.finalTotal).toBe(46);
    expect(page.step).toBe('review');
    expect(root.querySelector('.fb-coupon-trigger')).not.toBeNull();
  });

  it('keeps the existing fare and coupon when a held-coupon update fails', () => {
    const { page } = setup('review');
    const api = TestBed.inject(ApiService);
    const response = new Subject<any>();
    api.post = jasmine.createSpy().and.returnValue(response);
    page.couponTitle = 'INVALID';
    page.applyCoupon();
    response.error({ error: { message: 'This coupon is not available.' } });
    expect(page.finalTotal).toBe(46);
    expect(page.hold?.id).toBe(7);
    expect(page.couponError).toBe('This coupon is not available.');
    expect(page.couponBusy).toBeFalse();
  });
});
