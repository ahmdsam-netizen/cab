import { CommonModule } from '@angular/common';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AlertController, MenuController, NavController } from '@ionic/angular';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { PushService } from '../../core/push.service';
import { SideMenuComponent } from './side-menu.component';

describe('Account reference sidebar', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [SideMenuComponent], imports: [CommonModule], schemas: [NO_ERRORS_SCHEMA],
      providers: [AuthService, ApiService, Router, AlertController, MenuController, NavController, PushService]
        .map(provide => ({ provide, useValue: provide === AuthService
          ? { getUser: () => ({ id: 1, name: 'Actual customer', phone: '+919876543210' }), resolveAvatarUrl: () => null }
          : {} })),
    }).compileComponents();
  });
  it('renders real profile identity and grouped links without fictional financial features', () => {
    const view = TestBed.createComponent(SideMenuComponent); view.detectChanges();
    const root = view.nativeElement as HTMLElement;
    expect(root.querySelector('.account-identity')?.textContent).toContain('Actual customer');
    expect(root.querySelector('.account-identity')?.textContent).toContain('••••••3210');
    expect(root.querySelector('.account-avatar')?.textContent?.trim()).toBe('A');
    expect(root.querySelectorAll('.menu-card').length).toBe(5);
    expect(root.textContent).not.toContain('Wallet balance');
    expect(root.textContent).not.toContain('Refer and earn');
  });
  it('shows all prior service and legal entries directly without an accordion', () => {
    const view = TestBed.createComponent(SideMenuComponent); view.detectChanges();
    expect(view.nativeElement.querySelectorAll('.service-bookings button').length).toBe(4);
    const root = view.nativeElement as HTMLElement;
    for (const label of ['Private Booking', 'Fixed Booking', 'Shuttle Booking', 'Scheduled rides', 'Saved places', 'Notifications', 'Coupons and offers', 'My refunds', 'Contacts', 'Terms and conditions', 'Privacy policy', 'Sign out', 'Delete account']) {
      expect(root.textContent).toContain(label);
    }
  });
  it('closes the drawer before navigating and opens the unified My trips page', async () => {
    const view = TestBed.createComponent(SideMenuComponent); view.detectChanges();
    const menu = TestBed.inject(MenuController);
    menu.close = jasmine.createSpy().and.resolveTo(true);
    const router = TestBed.inject(Router);
    router.navigateByUrl = jasmine.createSpy().and.resolveTo(true);
    await view.componentInstance.go('/customer-tabs/trips');
    expect(menu.close).toHaveBeenCalledWith('customer-menu');
    expect(router.navigateByUrl).toHaveBeenCalledWith('/customer-tabs/trips');
  });
  it('retains sign-out confirmation without signing the user out during review', async () => {
    const view = TestBed.createComponent(SideMenuComponent);
    TestBed.inject(MenuController).close = jasmine.createSpy().and.resolveTo(true);
    const present = jasmine.createSpy().and.resolveTo();
    const alerts = TestBed.inject(AlertController);
    alerts.create = jasmine.createSpy().and.resolveTo({ present } as any);
    const api = TestBed.inject(ApiService); api.post = jasmine.createSpy();
    await view.componentInstance.signOut();
    expect(alerts.create).toHaveBeenCalledWith(jasmine.objectContaining({ header: 'Sign out?' }));
    expect(present).toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });
  it('highlights only the exact current tab and leaves other pages unselected', () => {
    const view = TestBed.createComponent(SideMenuComponent);
    const router = TestBed.inject(Router);
    for (const path of ['/customer-tabs/go', '/customer-tabs/trips', '/customer-tabs/go/voice', '/customer-tabs/support', '/customer-tabs/profile']) {
      Object.defineProperty(router, 'url', { value: path + '?from=menu', configurable: true });
      view.detectChanges();
      expect(view.componentInstance.isTabActive(path)).toBeTrue();
      expect(view.nativeElement.querySelectorAll('.account-bottom-nav .is-selected').length).toBe(1);
      expect(view.nativeElement.querySelectorAll('.account-bottom-nav [aria-current="page"]').length).toBe(1);
    }
    for (const path of ['/customer-tabs/coupons', '/customer-tabs/go/fixed?routeId=5', '/customer-tabs/my-trips', '/customer-tabs/fixed-rides/28']) {
      Object.defineProperty(router, 'url', { value: path, configurable: true });
      view.detectChanges();
      expect(view.nativeElement.querySelectorAll('.account-bottom-nav .is-selected').length).toBe(0);
    }
  });
});
