import { CommonModule } from '@angular/common';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AlertController, ToastController } from '@ionic/angular';
import { of, Subject } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { RealtimeService } from '../../core/realtime.service';
import { PaymentOptionsService } from '../../core/payment-options.service';
import { BookingService } from './booking.service';
import { PrivateBookPage } from './private/private.page';
import { ShuttleBookPage } from './shuttle/shuttle.page';
import { StepShellComponent } from './step-shell.component';
import { SeatGridComponent } from './fixed/seat-grid.component';

describe('Private and Shuttle booking safeguards', () => {
  let api: any;
  let router: any;
  beforeEach(async () => {
    spyOn(PrivateBookPage.prototype, 'ngOnInit').and.stub();
    spyOn(ShuttleBookPage.prototype, 'ngOnInit').and.stub();
    api = { get: jasmine.createSpy('get').and.returnValue(of({})), post: jasmine.createSpy('post').and.returnValue(of({})) };
    router = { navigateByUrl: jasmine.createSpy('navigateByUrl').and.resolveTo(true), navigate: jasmine.createSpy('navigate').and.resolveTo(true) };
    await TestBed.configureTestingModule({
      declarations: [PrivateBookPage, ShuttleBookPage],
      imports: [CommonModule, FormsModule, StepShellComponent, SeatGridComponent],
      schemas: [NO_ERRORS_SCHEMA],
      providers: [
        { provide: ApiService, useValue: api }, { provide: Router, useValue: router },
        { provide: BookingService, useValue: { trip: { cityId: 3, scope: 'local', pickup: { address: 'Pickup', lat: 34, lng: 74 }, drop: { address: 'Destination', lat: 34.1, lng: 74.1 } } } },
        ...[AuthService, RealtimeService, PaymentOptionsService, AlertController, ToastController].map(provide => ({ provide, useValue: {} })),
      ],
    }).compileComponents();
  });

  function privatePage(step: 'car' | 'price') {
    const fixture = TestBed.createComponent(PrivateBookPage);
    Object.assign(fixture.componentInstance, { step, estimate: { estimated_fare: 200 }, minFare: 150 });
    fixture.detectChanges();
    return fixture;
  }
  function shuttlePage(step: 'fare' | 'seats' | 'paying') {
    const fixture = TestBed.createComponent(ShuttleBookPage);
    Object.assign(fixture.componentInstance, { step, estimate: { estimated_fare: 100, available: true }, seatRows: 1, seatCols: 2, seatCells: [
      { row: 1, col: 1, kind: 'seat', label: '1A', price_delta: 0, status: 'AVAILABLE' },
      { row: 1, col: 2, kind: 'seat', label: '1B', price_delta: 0, status: 'BOOKED' },
    ] });
    fixture.detectChanges();
    return fixture;
  }
  function refresh(fixture: any) { fixture.componentInstance.cdr.markForCheck(); fixture.detectChanges(); }

  it('keeps the Private guide separate from the customer offer and advances without sending a trip', () => {
    const fixture = privatePage('car');
    expect(fixture.nativeElement.querySelector('.sf--reference')).toBeTruthy();
    fixture.nativeElement.querySelector('.sf__cta').click();
    refresh(fixture);
    expect(fixture.componentInstance.step).toBe('price');
    expect(fixture.componentInstance.offer).toBeNull();
    expect(fixture.nativeElement.querySelector('.sf__cta').disabled).toBeTrue();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('prevents submitting a Private offer below the minimum fare', async () => {
    const fixture = privatePage('price');
    fixture.componentInstance.offer = 100;
    refresh(fixture);
    expect(fixture.nativeElement.textContent).toContain('Too low');
    expect(fixture.nativeElement.querySelector('.sf__cta').disabled).toBeTrue();
    await fixture.componentInstance.sendToDrivers();
    expect(api.post).not.toHaveBeenCalled();
    fixture.componentInstance.offer = 175;
    refresh(fixture);
    expect(fixture.nativeElement.querySelector('.sf__cta').disabled).toBeFalse();
  });

  it('opens Shuttle payment-method selection without creating a booking or charging', () => {
    const fixture = shuttlePage('fare');
    fixture.nativeElement.querySelector('.sf__cta').click();
    expect(fixture.componentInstance.paymentModalOpen).toBeTrue();
    expect(api.post).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('ion-icon[name="bus-outline"]')).toBeTruthy();
  });

  it('disables Shuttle continuation when the estimate says the service is unavailable', () => {
    const fixture = shuttlePage('fare');
    fixture.componentInstance.estimate = { estimated_fare: 100, available: false };
    refresh(fixture);
    expect(fixture.nativeElement.querySelector('.sf__cta').disabled).toBeTrue();
    fixture.componentInstance.choosePayment();
    expect(fixture.componentInstance.paymentModalOpen).toBeFalse();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('opens seats after a mocked booking response and does not submit twice while busy', async () => {
    const fixture = shuttlePage('fare');
    const created = new Subject<any>();
    api.post.and.returnValue(created);
    api.get.and.returnValue(of({ seat_map: { layout: { rows: 1, cols: 2 }, cells: fixture.componentInstance.seatCells } }));
    const pending = fixture.componentInstance.confirm('cash');
    await fixture.componentInstance.confirm('cash');
    expect(api.post.calls.count()).toBe(1);
    expect(api.post.calls.mostRecent().args[1].payment_method).toBe('cash');
    created.next({ booking: { id: 99 } }); created.complete();
    await pending;
    refresh(fixture);
    expect(fixture.componentInstance.step).toBe('seats');
    expect(fixture.nativeElement.querySelectorAll('.cell:disabled').length).toBe(1);
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('waits for the seat hold before continuing to the approval/payment list', () => {
    const fixture = shuttlePage('seats');
    fixture.componentInstance.booking = { id: 99 };
    const hold = new Subject<any>(); api.post.and.returnValue(hold);
    fixture.nativeElement.querySelector('.cell:not(:disabled)').click();
    refresh(fixture);
    expect(fixture.componentInstance.selectedSeats).toEqual(['1A']);
    expect(fixture.nativeElement.querySelector('.sf__cta').disabled).toBeTrue();
    fixture.componentInstance.continueToPay();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    hold.next({}); hold.complete();
    refresh(fixture);
    expect(fixture.nativeElement.querySelector('.sf__cta').disabled).toBeFalse();
    fixture.nativeElement.querySelector('.sf__cta').click();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/customer-tabs/shuttle-rides');
  });

  it('clears a rejected seat and keeps continuation disabled', () => {
    const fixture = shuttlePage('seats');
    fixture.componentInstance.booking = { id: 99 };
    const hold = new Subject<any>(); api.post.and.returnValue(hold);
    api.get.and.returnValue(of({ seat_map: { layout: { rows: 1, cols: 2 }, cells: fixture.componentInstance.seatCells } }));
    fixture.nativeElement.querySelector('.cell:not(:disabled)').click();
    hold.error({ error: { message: 'Seat already taken' } });
    refresh(fixture);
    expect(fixture.componentInstance.selectedSeats).toEqual([]);
    expect(fixture.nativeElement.textContent).toContain('Seat already taken');
    expect(fixture.nativeElement.querySelector('.sf__cta').disabled).toBeTrue();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('shows discount, tip and cash split without claiming the full fare is due online', () => {
    const fixture = shuttlePage('paying');
    Object.assign(fixture.componentInstance, { payMethod: 'cash', cashDepositPercent: 20, coupon: { discount: 10 }, tipping: { enabled: true, values: [10], in_percentage: false }, selectedTipPreset: 10 });
    refresh(fixture);
    expect(fixture.componentInstance.payableTotal).toBe(100);
    expect(fixture.componentInstance.cashDeposit).toBe(20);
    expect(fixture.componentInstance.cashBalance).toBe(80);
    expect(fixture.nativeElement.querySelector('.sf__cta').textContent).toContain('Pay ₹20');
    expect(fixture.nativeElement.textContent).toContain('Cash to driver');
    expect(api.post).not.toHaveBeenCalled();
  });
});
