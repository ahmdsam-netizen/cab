import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { AlertController, Platform } from '@ionic/angular';
import { Subject } from 'rxjs';
import { TripHistoryPage } from './trip-history/trip-history.page';
import { ProfilePage } from './profile/profile.page';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { DriverOnboardingDraftService } from '../core/driver-onboarding-draft.service';
import { GeolocationService } from '../core/geolocation.service';
import { PlacesService } from '../core/places.service';
import { PushService } from '../core/push.service';

describe('Driver History and Account reference UI', () => {
  let api: any; let router: any;
  beforeEach(async () => {
    spyOn(ProfilePage.prototype, 'ngOnInit').and.stub();
    spyOn(ProfilePage.prototype, 'ngOnDestroy').and.stub();
    api = { get: jasmine.createSpy(), post: jasmine.createSpy() };
    router = { navigateByUrl: jasmine.createSpy().and.resolveTo(true) };
    await TestBed.configureTestingModule({ declarations: [TripHistoryPage, ProfilePage], imports: [CommonModule, FormsModule], schemas: [NO_ERRORS_SCHEMA], providers: [
      { provide: ApiService, useValue: api }, { provide: Router, useValue: router },
      ...[AuthService, DriverOnboardingDraftService, ActivatedRoute, GeolocationService, PlacesService, Platform, AlertController, PushService].map(provide => ({ provide, useValue: {} })),
    ] }).compileComponents();
  });
  it('renders compact history with real fare/status and filters by local calendar day', () => {
    const f = TestBed.createComponent(TripHistoryPage); const page = f.componentInstance;
    const now = new Date(); const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    page.trips = [{ id: 1, status: 'COMPLETED', pickup_address: 'Sopore', drop_address: 'Arampora', final_fare: 50, completed_at: now.toISOString(), payment: { id: 1, status: 'SUCCESS' } }, { id: 2, status: 'CANCELLED', final_fare: 100, cancelled_reason: 'Customer cancelled', cancelled_at: yesterday.toISOString() }];
    page.setRange('today'); f.detectChanges();
    expect(f.nativeElement.querySelectorAll('.history-reference-trip').length).toBe(1);
    expect(f.nativeElement.textContent).toContain('₹50');
    expect(f.nativeElement.textContent).toContain('Paid');
    page.setRange('all'); f.detectChanges();
    expect(f.nativeElement.querySelectorAll('.history-reference-trip').length).toBe(2);
    expect(f.nativeElement.textContent).toContain('Cancelled');
    expect(page.completedFaresShown).toBe(50);
    expect(page.completedRidesShown).toBe(1);
    expect(f.nativeElement.querySelector('.history-cancellation').open).toBeFalse();
  });
  it('ends history loading after errors and can retry with status/payment filters', () => {
    const page = new TripHistoryPage(api); const failed = new Subject<any>(); api.get.and.returnValue(failed);
    page.refresh(); expect(page.loading).toBeTrue(); failed.error({ error: { message: 'Offline' } });
    expect(page.loading).toBeFalse(); expect(page.error).toBe('Offline');
    const retry = new Subject<any>(); api.get.and.returnValue(retry); page.setPayment('paid');
    expect(api.get.calls.mostRecent().args[0]).toContain('payment=paid'); retry.next({ data: { data: [] } }); retry.complete();
    expect(page.error).toBeNull(); expect(page.loading).toBeFalse();
  });
  it('shows account overview without inventing verification, wallet or rating', () => {
    const f = TestBed.createComponent(ProfilePage); const page = f.componentInstance;
    page.name = 'Test Driver'; page.phone = 'Test phone'; f.detectChanges();
    const overview = f.nativeElement.querySelector('.account-reference');
    expect(f.nativeElement.querySelectorAll('.segment-bar .seg-btn').length).toBe(3);
    expect(overview.textContent).toContain('Test Driver'); expect(overview.querySelector('.account-vehicle')).toBeNull();
    expect(overview.textContent).not.toContain('Verified driver'); expect(overview.textContent).not.toContain('4.8');
    expect(f.nativeElement.querySelector('.pf-form')).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
    const links = overview.textContent;
    for (const label of ['Rides', 'Scheduled rides', 'Earnings', 'Trip history', 'Trip refunds', 'Subscriptions', 'SOS contacts', 'Performance', 'Wallet & Payments', 'Help & Support', 'Terms & Conditions', 'Privacy Policy', 'Log out']) expect(links).toContain(label);
    page.accountWallet = 42; page.profileLoaded = true; page.driverApproved = true; f.detectChanges();
    expect(overview.textContent).toContain('42'); expect(overview.querySelector('.account-vehicle')).toBeNull();
  });
  it('keeps edit, documents, vehicle and wallet destinations available', () => {
    const f = TestBed.createComponent(ProfilePage); const page = f.componentInstance; f.detectChanges();
    page.editAccountProfile(); f.detectChanges(); expect(f.nativeElement.querySelector('.pf-form')).toBeTruthy();
    page.backToAccount(); expect(page.showAccountOverview).toBeTrue();
    page.switchSegment('documents'); expect(page.activeSegment).toBe('documents'); expect(page.showAccountOverview).toBeFalse();
    page.switchSegment('vehicle'); expect(page.activeSegment).toBe('vehicle');
    page.switchSegment('profile'); expect(page.showAccountOverview).toBeTrue();
    page.openAccountPage('/tabs/wallet'); expect(router.navigateByUrl).toHaveBeenCalledWith('/tabs/wallet');
    page.onboarding = true; page.backToAccount(); expect(page.showAccountOverview).toBeFalse();
    expect(api.post).not.toHaveBeenCalled();
  });
});
