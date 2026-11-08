import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ProfileComponent } from './profile.component';
import { AuthService, ManagerProfile } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';

describe('ProfileComponent', () => {
  let mockAuth: jasmine.SpyObj<AuthService>;
  let mockToast: jasmine.SpyObj<ToastService>;

  const sampleProfile: ManagerProfile = {
    id: 42,
    name: 'Mubashir Admin',
    email: 'mubashir@dreamcabs.local',
    phone: '+919900112233',
    avatar_path: 'avatars/mubashir.png',
    avatar_url: 'https://dreamcabs.in/storage/avatars/mubashir.png',
    manager_role: {
      id: 1,
      slug: 'super_admin',
      name: 'Super Admin',
      is_super_admin: true,
      is_system: true,
      requires_fleet: false,
    },
    permissions: ['*'],
    manager_city_id: null,
    manager_city_name: null,
    manager_fleet_id: null,
    manager_fleet_name: null,
    is_super_admin: true,
  };

  beforeEach(() => {
    mockAuth = jasmine.createSpyObj<AuthService>('AuthService', [
      'ensureLoaded',
      'updateProfile',
      'updatePassword',
    ], {
      profile: sampleProfile,
      profile$: of(sampleProfile),
    });
    mockAuth.ensureLoaded.and.returnValue(of(sampleProfile));

    mockToast = jasmine.createSpyObj<ToastService>('ToastService', [
      'success',
      'error',
      'info',
      'warning',
    ]);

    TestBed.configureTestingModule({
      imports: [ProfileComponent],
      providers: [
        { provide: AuthService, useValue: mockAuth },
        { provide: ToastService, useValue: mockToast },
      ],
    });
  });

  it('initializes with current manager profile data', () => {
    const fixture = TestBed.createComponent(ProfileComponent);
    fixture.detectChanges();
    const comp = fixture.componentInstance;

    expect(comp.name).toBe('Mubashir Admin');
    expect(comp.email).toBe('mubashir@dreamcabs.local');
    expect(comp.phone).toBe('+919900112233');
    expect(comp.userInitials).toBe('MA');
    expect(comp.scopeLabel).toBe('All Cities (Global)');
  });

  it('switches between profile tabs', () => {
    const fixture = TestBed.createComponent(ProfileComponent);
    fixture.detectChanges();
    const comp = fixture.componentInstance;

    expect(comp.activeTab).toBe('general');
    comp.activeTab = 'security';
    fixture.detectChanges();
    expect(comp.activeTab).toBe('security');

    comp.activeTab = 'role';
    fixture.detectChanges();
    expect(comp.activeTab).toBe('role');
  });

  it('validates password matching before submitting update', () => {
    const fixture = TestBed.createComponent(ProfileComponent);
    fixture.detectChanges();
    const comp = fixture.componentInstance;

    comp.currentPassword = 'oldPassword';
    comp.newPassword = 'password123';
    comp.confirmPassword = 'mismatchPassword';

    comp.onUpdatePassword();

    expect(comp.confirmPasswordError).toBe('Passwords do not match.');
    expect(mockAuth.updatePassword).not.toHaveBeenCalled();
  });

  it('calls auth.updatePassword when passwords match and meet requirements', () => {
    const fixture = TestBed.createComponent(ProfileComponent);
    fixture.detectChanges();
    const comp = fixture.componentInstance;

    mockAuth.updatePassword.and.returnValue(of({ message: 'Password updated successfully.' }));

    comp.currentPassword = 'oldPassword';
    comp.newPassword = 'newPassword123';
    comp.confirmPassword = 'newPassword123';

    comp.onUpdatePassword();

    expect(mockAuth.updatePassword).toHaveBeenCalledWith({
      current_password: 'oldPassword',
      password: 'newPassword123',
      password_confirmation: 'newPassword123',
    });
    expect(mockToast.success).toHaveBeenCalledWith('Password updated successfully.');
  });
});
