import { CommonModule } from '@angular/common';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AlertController, ModalController } from '@ionic/angular';
import { of, throwError } from 'rxjs';
import { DashboardPage } from './dashboard.page';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { DriverPresenceService } from '../../core/driver-presence.service';
import { LocationConsentService } from '../../core/location-consent.service';
import { GeolocationService } from '../../core/geolocation.service';
import { MapsLoaderService } from '../../core/maps-loader.service';
import { PushService } from '../../core/push.service';
import { RealtimeService } from '../../core/realtime.service';

describe('Driver reference Home safeguards', () => {
  let api: any;
  let router: any;
  beforeEach(async () => {
    jasmine.clock().install();
    spyOn(DashboardPage.prototype, 'ngAfterViewInit').and.stub();
    spyOn(DashboardPage.prototype, 'ngOnDestroy').and.stub();
    api = { get: jasmine.createSpy().and.returnValue(of({ ride_earnings: 125, currency: 'INR' })) };
    router = { navigateByUrl: jasmine.createSpy().and.resolveTo(true) };
    await TestBed.configureTestingModule({
      declarations: [DashboardPage], imports: [CommonModule], schemas: [NO_ERRORS_SCHEMA],
      providers: [
        { provide: ApiService, useValue: api }, { provide: Router, useValue: router },
        { provide: AuthService, useValue: { getUser: () => ({ name: 'Test Driver' }), resolveAvatarUrl: () => null } },
        { provide: DriverPresenceService, useValue: { onError: () => {}, onLocated: () => {} } },
        ...[LocationConsentService, GeolocationService, MapsLoaderService, PushService, RealtimeService, AlertController, ModalController].map(provide => ({ provide, useValue: {} })),
      ],
    }).compileComponents();
  });
  afterEach(() => jasmine.clock().uninstall());
  function setup(driver: any) {
    const fixture = TestBed.createComponent(DashboardPage);
    fixture.componentInstance.driver = { approval_status: 'approved', service_mode: 'fixed', service_scope: 'local', ...driver };
    fixture.componentInstance.homeLoading = false;
    fixture.detectChanges();
    return fixture;
  }

  it('holds loaded offers until the opening prompts have finished', async () => {
    const f = setup({ is_online: false });
    const page: any = f.componentInstance;
    page.halfBanner = { id: 1, title: 'Offer' };
    let finishMode!: () => void;
    let finishSubscription!: () => void;
    spyOn(page, 'maybeShowModePrompt').and.returnValue(new Promise<void>(resolve => finishMode = resolve));
    const subscription = spyOn(page, 'maybeShowSubscriptionPrompt').and.returnValue(new Promise<void>(resolve => finishSubscription = resolve));
    const greeting = page.greetOnAppOpen();
    f.detectChanges();
    expect(page.showHalfBanner).toBeFalse();
    expect(page.showOfferPill).toBeFalse();
    expect(f.nativeElement.querySelector('.home-workspace.is-banner-open')).toBeNull();
    expect(subscription).not.toHaveBeenCalled();
    page.fullScreenBanner = { id: 2, title: 'Full offer' };
    f.detectChanges();
    expect(page.showFullScreenBanner).toBeFalse();
    expect(f.nativeElement.querySelector('.dc-banner-fullscreen-modal')).toBeNull();
    finishMode();
    await Promise.resolve();
    expect(subscription).toHaveBeenCalled();
    expect(page.showFullScreenBanner).toBeFalse();
    finishSubscription();
    await greeting;
    expect(page.showFullScreenBanner).toBeTrue();
    expect(page.showHalfBanner).toBeFalse();
    page.dismissFullScreenBanner();
    expect(page.showHalfBanner).toBeTrue();
    page.collapseHalfBanner();
    expect(page.showOfferPill).toBeTrue();
  });

  it('retains closed offers and the launch loader state across Home recreation', () => {
    const first: any = setup({ is_online: false }).componentInstance;
    const banner = { id: 81, position: 'half', title: 'Same offer', image_url: '/offer.png' };
    api.get.and.returnValue(of({ data: [banner] }));
    first.loadBanners();
    first.collapseHalfBanner();
    const second = TestBed.createComponent(DashboardPage).componentInstance;
    expect(second.homeLoading).toBeFalse();
    second.loadBanners();
    expect(second.isHalfBannerCollapsed).toBeTrue();
    second.reopenOfferBanner();
    second.loadBanners();
    expect(second.isHalfBannerCollapsed).toBeFalse();
    second.collapseHalfBanner();
    api.get.and.returnValue(of({ data: [{ ...banner, image_url: '/new-offer.png' }] }));
    second.loadBanners();
    expect(second.isHalfBannerCollapsed).toBeFalse();
  });

  it('refreshes GPS quietly on foreground return without reopening the loader', async () => {
    const page: any = setup({ is_online: false }).componentInstance;
    page.dashboardActive = true;
    const tracking = spyOn(page, 'startLiveTracking').and.resolveTo();
    spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    page.onAppVisibilityChange();
    await Promise.resolve();
    expect(tracking).toHaveBeenCalledTimes(1);
    expect(page.homeLoading).toBeFalse();
    page.dashboardActive = false;
    page.onAppVisibilityChange();
    expect(tracking).toHaveBeenCalledTimes(1);
  });

  it('waits for the welcome modal closing animation before releasing offers', async () => {
    const page: any = setup({ is_online: false }).componentInstance;
    let dismiss!: (value: any) => void;
    const modal = {
      present: jasmine.createSpy().and.resolveTo(),
      onDidDismiss: jasmine.createSpy().and.returnValue(new Promise(resolve => dismiss = resolve)),
    };
    const modalCtrl: any = TestBed.inject(ModalController);
    modalCtrl.create = jasmine.createSpy().and.resolveTo(modal);
    spyOn(sessionStorage, 'getItem').and.returnValue(null);
    spyOn(sessionStorage, 'setItem');
    spyOn(localStorage, 'setItem');
    let finished = false;
    const prompt = page.maybeShowModePrompt().then(() => finished = true);
    await Promise.resolve();
    await Promise.resolve();
    expect(modal.onDidDismiss).toHaveBeenCalled();
    expect(finished).toBeFalse();
    dismiss({ data: { mode: 'self' } });
    await prompt;
    expect(localStorage.setItem).toHaveBeenCalledWith('dc_driver_mode', 'self');
  });

  it('does not allow route access while offline or show a fake active route', () => {
    const f = setup({ is_online: false });
    expect(f.nativeElement.querySelector('.home-plan-action').disabled).toBeTrue();
    expect(f.nativeElement.querySelector('.dash-active-fixed-card')).toBeNull();
    expect(f.nativeElement.querySelector('.sheet__go')).toBeTruthy();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('keeps GPS fixes without a Home map and does not wait for a missing map', async () => {
    const f = setup({ is_online: false });
    const page: any = f.componentInstance;
    page.applyFix(34.3, 74.4, 5, null);
    expect(page.hasFix).toBeTrue();
    expect(page.lastPos).toEqual({ lat: 34.3, lng: 74.4 });
    expect(await page.waitForMap()).toBeFalse();
    expect(f.nativeElement.querySelector('.home-map-card')).toBeNull();
  });

  it('retains the low-wallet and pending-approval gates', () => {
    const f = setup({ is_online: false });
    f.componentInstance.minWalletLimit = 100;
    f.componentInstance.walletBalance = 25;
    f.detectChanges();
    expect(f.nativeElement.querySelector('.sheet__go:not(.sheet__go--recharge)')).toBeNull();
    expect(f.nativeElement.querySelector('.sheet__go--recharge').textContent).toContain('75');
    f.componentInstance.driver = { approval_status: 'pending', is_online: false };
    f.detectChanges();
    expect(f.nativeElement.querySelector('.review-card')).toBeTruthy();
    expect(f.nativeElement.querySelector('.home-plan-action').disabled).toBeTrue();
    expect(f.nativeElement.querySelector('.sheet__go')).toBeNull();
  });

  it('preserves active-ride management and hides offline/route-change controls', () => {
    const f = setup({ is_online: true });
    f.componentInstance.activeFixedVehicle = { id: 9, status: 'BOARDING', route_name: 'Assigned route' };
    f.detectChanges();
    expect(f.nativeElement.querySelector('.home-plan')).toBeNull();
    expect(f.nativeElement.querySelector('.sheet__stop')).toBeNull();
    expect(f.nativeElement.querySelector('.home-duty-switch--on').disabled).toBeTrue();
    f.nativeElement.querySelector('.dash-active-fixed-cta').click();
    expect(router.navigateByUrl).toHaveBeenCalledOnceWith('/tabs/fixed');
  });

  it('shows real weekly earnings and keeps missing/error summaries distinct from zero', () => {
    const f = setup({ is_online: false });
    const page: any = f.componentInstance;
    page.refreshHomeEarnings(); f.detectChanges();
    expect(api.get).toHaveBeenCalledWith('/drivers/me/earnings?period=week');
    expect(f.nativeElement.querySelector('.home-earnings-amount').textContent).toContain('125');
    expect(f.nativeElement.querySelector('.home-earnings').textContent).toContain("This week's earnings");
    api.get.and.returnValue(throwError(() => new Error('offline')));
    page.refreshHomeEarnings(); f.detectChanges();
    expect(page.homeEarnings).toBeNull();
    expect(page.earningsLoading).toBeFalse();
    expect(f.nativeElement.querySelector('.home-earnings-amount').textContent).toContain('View earnings');
    f.nativeElement.querySelector('.home-earnings').click();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/tabs/earnings');
  });

  it('shows wallet summary only from a real response and preserves the gate balance on read failure', () => {
    const f = setup({ is_online: false });
    const page: any = f.componentInstance;
    expect(f.nativeElement.querySelector('.home-wallet .home-earnings-amount').textContent).toContain('View wallet');
    api.get.and.returnValue(of({ balance: 42, minimum_wallet_limit: 100 }));
    page.refreshWalletBalance(); f.detectChanges();
    expect(f.nativeElement.querySelector('.home-wallet .home-earnings-amount').textContent).toContain('42');
    expect(page.homeNotice.title).toBe('Your wallet needs attention');
    expect(page.homeNotice.text).toContain('58');
    api.get.and.returnValue(throwError(() => new Error('unavailable')));
    page.refreshWalletBalance(); f.detectChanges();
    expect(page.walletBalance).toBe(42);
    expect(page.homeWalletBalance).toBeNull();
    expect(f.nativeElement.querySelector('.home-wallet .home-earnings-amount').textContent).toContain('View wallet');
  });

  it('opens existing destinations from quick access without operational calls', () => {
    const f = setup({ is_online: false });
    const buttons = f.nativeElement.querySelectorAll('.home-quick-access button');
    ['/tabs/scheduled', '/tabs/history', '/profile?tab=documents', '/support'].forEach((path, i) => {
      buttons[i].click();
      expect(router.navigateByUrl.calls.mostRecent().args[0]).toBe(path);
    });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('uses registered city context and prioritizes pending approval over a generic readiness note', () => {
    const f = setup({ approval_status: 'pending', cities: [{ name: 'Sopore' }], vehicle_reg_no: 'JK01TEST', city_vehicle_type: { display_name: 'SUMO' } });
    expect(f.nativeElement.querySelector('.home-greeting').textContent).toContain('JK01TEST · SUMO');
    expect(f.nativeElement.querySelector('.home-greeting').textContent).not.toContain('Sopore');
    expect(f.nativeElement.querySelector('.home-greeting').textContent).toContain('Test');
    expect(f.nativeElement.querySelector('.home-greeting time')).toBeNull();
    expect(f.nativeElement.querySelector('.home-greeting h1').textContent.trim()).toBe('Test');
    expect(f.nativeElement.querySelector('.home-greeting [aria-label="Open profile"]')).toBeTruthy();
    expect(f.nativeElement.querySelector('.drawer')).toBeNull();
    f.nativeElement.querySelector('[aria-label="Open profile"]').click();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/profile');
    expect(f.nativeElement.querySelector('.home-readiness').textContent).toContain('Account under review');
  });
});
