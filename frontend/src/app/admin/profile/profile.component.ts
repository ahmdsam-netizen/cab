import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { AuthService, ManagerProfile } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import {
  AvatarComponent,
  ButtonComponent,
  CardComponent,
  IconComponent,
  IconName,
  InputComponent,
  StatusPillComponent,
} from '../../ui';

interface TabItem {
  id: 'general' | 'security' | 'role' | 'preferences';
  label: string;
  icon: IconName;
}

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    AvatarComponent,
    ButtonComponent,
    CardComponent,
    IconComponent,
    InputComponent,
    StatusPillComponent,
  ],
  template: `
    <div class="pf-page">
      <!-- ================= HERO HEADER ================= -->
      <section class="pf-hero">
        <div class="pf-hero__content">
          <div class="pf-hero__avatar-wrap">
            <tm-avatar
              [src]="currentDisplayPhoto"
              [initials]="userInitials"
              size="xl"
              [online]="true"
            />
          </div>
          <div class="pf-hero__meta">
            <div class="pf-hero__title-row">
              <h1 class="pf-hero__name">{{ profile?.name || 'Administrator' }}</h1>
              <tm-status-pill [tone]="profile?.is_super_admin ? 'success' : 'info'">
                {{ profile?.manager_role?.name || (profile?.is_super_admin ? 'Super Admin' : 'Manager') }}
              </tm-status-pill>
            </div>
            <p class="pf-hero__email">
              <tm-icon name="envelope" [size]="14" />
              <span>{{ profile?.email || 'admin@dreamcabs.local' }}</span>
              <span class="pf-hero__dot" *ngIf="profile?.phone">·</span>
              <span *ngIf="profile?.phone" class="pf-hero__phone">
                <tm-icon name="phone" [size]="14" />
                <span>{{ profile?.phone }}</span>
              </span>
            </p>
            <div class="pf-hero__tags">
              <span class="pf-hero__tag">
                <tm-icon name="map-marker" [size]="13" />
                <span>{{ scopeLabel }}</span>
              </span>
              <span class="pf-hero__tag" *ngIf="profile?.manager_fleet_name">
                <tm-icon name="car" [size]="13" />
                <span>{{ profile?.manager_fleet_name }}</span>
              </span>
              <span class="pf-hero__tag" *ngIf="profile?.created_at">
                <tm-icon name="calendar" [size]="13" />
                <span>Member since {{ formatDate(profile?.created_at) }}</span>
              </span>
            </div>
          </div>
        </div>

        <!-- Tab bar -->
        <nav class="pf-tabs" role="tablist">
          <button
            *ngFor="let tab of tabs"
            type="button"
            role="tab"
            class="pf-tab"
            [class.is-active]="activeTab === tab.id"
            [attr.aria-selected]="activeTab === tab.id"
            (click)="activeTab = tab.id"
          >
            <tm-icon [name]="tab.icon" [size]="16" />
            <span>{{ tab.label }}</span>
          </button>
        </nav>
      </section>

      <!-- ================= CONTENT PANELS ================= -->
      <main class="pf-body">
        <!-- 1. GENERAL PROFILE TAB -->
        <div class="pf-panel" *ngIf="activeTab === 'general'">
          <div class="pf-grid">
            <!-- Left: Avatar management card -->
            <tm-card elevation="card" padding="loose" class="pf-card pf-card--avatar">
              <div class="pf-card__header">
                <h2 class="pf-card__title">Profile Picture</h2>
                <p class="pf-card__sub">This avatar appears in the top navigation bar and audit trails.</p>
              </div>

              <div class="pf-avatar-editor">
                <div class="pf-avatar-editor__preview">
                  <tm-avatar
                    [src]="avatarPreviewUrl || profile?.avatar_url"
                    [initials]="userInitials"
                    size="xl"
                    [online]="true"
                  />
                  <span class="pf-avatar-editor__badge" *ngIf="selectedFile">New</span>
                </div>

                <div class="pf-avatar-editor__actions">
                  <input
                    type="file"
                    #fileInput
                    class="pf-file-input"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    (change)="onFileSelected($event)"
                  />
                  <tm-button
                    variant="outline"
                    size="sm"
                    icon="camera"
                    (clicked)="fileInput.click()"
                  >
                    Upload picture
                  </tm-button>

                  <tm-button
                    *ngIf="hasPhoto"
                    variant="ghost"
                    size="sm"
                    icon="trash"
                    (clicked)="onRemovePhoto()"
                  >
                    Remove
                  </tm-button>
                </div>
                <p class="pf-avatar-editor__hint">
                  Supports JPG, PNG or WEBP up to 4MB.
                </p>
              </div>
            </tm-card>

            <!-- Right: Personal Info Form -->
            <tm-card elevation="card" padding="loose" class="pf-card pf-card--form">
              <div class="pf-card__header">
                <h2 class="pf-card__title">Personal Information</h2>
                <p class="pf-card__sub">Update your personal account credentials and contact details.</p>
              </div>

              <form (ngSubmit)="onSaveProfile()" class="pf-form">
                <div class="pf-form__row">
                  <tm-input
                    label="Full Name"
                    placeholder="Enter your name"
                    icon="user"
                    [(ngModel)]="name"
                    name="name"
                    [error]="nameError"
                  />
                </div>

                <div class="pf-form__row">
                  <tm-input
                    label="Email Address"
                    type="email"
                    placeholder="admin@dreamcabs.local"
                    icon="envelope"
                    [(ngModel)]="email"
                    name="email"
                    [error]="emailError"
                  />
                </div>

                <div class="pf-form__row">
                  <tm-input
                    label="Phone Number"
                    type="tel"
                    placeholder="+91 98765 43210"
                    icon="phone"
                    [(ngModel)]="phone"
                    name="phone"
                    hint="Optional contact phone number for administrative alerts."
                  />
                </div>

                <div class="pf-form__row pf-form__row--readonly">
                  <div class="pf-readonly-box">
                    <span class="pf-readonly-box__label">Operating Scope</span>
                    <span class="pf-readonly-box__value">{{ scopeLabel }}</span>
                  </div>
                  <div class="pf-readonly-box" *ngIf="profile?.manager_role">
                    <span class="pf-readonly-box__label">Designated Role</span>
                    <span class="pf-readonly-box__value">{{ profile?.manager_role?.name }}</span>
                  </div>
                </div>

                <div class="pf-form__actions">
                  <tm-button
                    variant="green"
                    type="submit"
                    [loading]="savingProfile"
                    [disabled]="!isProfileDirty && !selectedFile && !removePhotoFlag"
                    icon="check"
                  >
                    Save Changes
                  </tm-button>

                  <tm-button
                    *ngIf="isProfileDirty || selectedFile || removePhotoFlag"
                    variant="ghost"
                    type="button"
                    (clicked)="resetProfileForm()"
                  >
                    Discard Changes
                  </tm-button>
                </div>
              </form>
            </tm-card>
          </div>
        </div>

        <!-- 2. SECURITY & PASSWORD TAB -->
        <div class="pf-panel" *ngIf="activeTab === 'security'">
          <div class="pf-grid pf-grid--security">
            <tm-card elevation="card" padding="loose" class="pf-card">
              <div class="pf-card__header">
                <h2 class="pf-card__title">Change Password</h2>
                <p class="pf-card__sub">Protect your administrative account with a strong, distinct password.</p>
              </div>

              <form (ngSubmit)="onUpdatePassword()" class="pf-form">
                <div class="pf-form__row">
                  <div class="pf-pw-field">
                    <tm-input
                      label="Current Password"
                      [type]="showCurrentPw ? 'text' : 'password'"
                      placeholder="••••••••••••"
                      icon="lock"
                      [(ngModel)]="currentPassword"
                      name="currentPassword"
                      [error]="currentPasswordError"
                    />
                    <button
                      type="button"
                      class="pf-pw-toggle"
                      (click)="showCurrentPw = !showCurrentPw"
                      [attr.aria-label]="showCurrentPw ? 'Hide password' : 'Show password'"
                    >
                      <tm-icon [name]="showCurrentPw ? 'eye' : 'lock'" [size]="15" />
                    </button>
                  </div>
                </div>

                <div class="pf-form__row">
                  <div class="pf-pw-field">
                    <tm-input
                      label="New Password"
                      [type]="showNewPw ? 'text' : 'password'"
                      placeholder="At least 6 characters"
                      icon="key"
                      [(ngModel)]="newPassword"
                      name="newPassword"
                      [error]="newPasswordError"
                    />
                    <button
                      type="button"
                      class="pf-pw-toggle"
                      (click)="showNewPw = !showNewPw"
                      [attr.aria-label]="showNewPw ? 'Hide password' : 'Show password'"
                    >
                      <tm-icon [name]="showNewPw ? 'eye' : 'key'" [size]="15" />
                    </button>
                  </div>
                </div>

                <div class="pf-form__row">
                  <div class="pf-pw-field">
                    <tm-input
                      label="Confirm New Password"
                      [type]="showConfirmPw ? 'text' : 'password'"
                      placeholder="Re-enter new password"
                      icon="key"
                      [(ngModel)]="confirmPassword"
                      name="confirmPassword"
                      [error]="confirmPasswordError"
                    />
                    <button
                      type="button"
                      class="pf-pw-toggle"
                      (click)="showConfirmPw = !showConfirmPw"
                      [attr.aria-label]="showConfirmPw ? 'Hide password' : 'Show password'"
                    >
                      <tm-icon [name]="showConfirmPw ? 'eye' : 'key'" [size]="15" />
                    </button>
                  </div>
                </div>

                <!-- Password criteria checklist -->
                <div class="pf-checklist">
                  <div class="pf-checklist__item" [class.is-met]="newPassword.length >= 6">
                    <tm-icon [name]="newPassword.length >= 6 ? 'check' : 'x'" [size]="14" />
                    <span>Minimum 6 characters in length</span>
                  </div>
                  <div class="pf-checklist__item" [class.is-met]="newPassword && newPassword === confirmPassword">
                    <tm-icon [name]="newPassword && newPassword === confirmPassword ? 'check' : 'x'" [size]="14" />
                    <span>Passwords match</span>
                  </div>
                </div>

                <div class="pf-form__actions">
                  <tm-button
                    variant="green"
                    type="submit"
                    [loading]="savingPassword"
                    [disabled]="!currentPassword || !newPassword || !confirmPassword"
                    icon="shield"
                  >
                    Update Password
                  </tm-button>
                </div>
              </form>
            </tm-card>

            <!-- Security tips card -->
            <tm-card elevation="card" padding="loose" class="pf-card pf-card--info">
              <div class="pf-security-box">
                <div class="pf-security-box__icon">
                  <tm-icon name="shield" [size]="28" />
                </div>
                <h3 class="pf-security-box__title">Account Security Best Practices</h3>
                <ul class="pf-security-box__list">
                  <li>Use a passphrase that you do not use on other web services.</li>
                  <li>Never share your admin portal login credentials with dispatch staff or external parties.</li>
                  <li>Log out when stepping away from an open workstation or public terminal.</li>
                  <li>City managers should consult the Super Admin if elevated module access is required.</li>
                </ul>
              </div>
            </tm-card>
          </div>
        </div>

        <!-- 3. ROLE & PERMISSIONS TAB -->
        <div class="pf-panel" *ngIf="activeTab === 'role'">
          <tm-card elevation="card" padding="loose" class="pf-card">
            <div class="pf-card__header">
              <div class="pf-card__header-row">
                <div>
                  <h2 class="pf-card__title">Access & System Permissions</h2>
                  <p class="pf-card__sub">
                    Your account is assigned to the
                    <strong>{{ profile?.manager_role?.name || 'Super Admin' }}</strong>
                    role.
                  </p>
                </div>
                <tm-status-pill [tone]="profile?.is_super_admin ? 'success' : 'info'">
                  {{ profile?.is_super_admin ? 'Full Super Admin Access' : 'Scoped Manager' }}
                </tm-status-pill>
              </div>
            </div>

            <!-- Role facts grid -->
            <div class="pf-role-facts">
              <div class="pf-role-fact">
                <span class="pf-role-fact__label">Role Identifier</span>
                <span class="pf-role-fact__val"><code>{{ profile?.manager_role?.slug || 'super_admin' }}</code></span>
              </div>
              <div class="pf-role-fact">
                <span class="pf-role-fact__label">Territory Scope</span>
                <span class="pf-role-fact__val">{{ scopeLabel }}</span>
              </div>
              <div class="pf-role-fact">
                <span class="pf-role-fact__label">Fleet Assignment</span>
                <span class="pf-role-fact__val">{{ profile?.manager_fleet_name || 'All Fleets (Platform-wide)' }}</span>
              </div>
              <div class="pf-role-fact">
                <span class="pf-role-fact__label">System Protected</span>
                <span class="pf-role-fact__val">{{ profile?.manager_role?.is_system ? 'Yes' : 'No' }}</span>
              </div>
            </div>

            <!-- Permission listing -->
            <div class="pf-permissions">
              <h3 class="pf-permissions__title">Granted Module Access</h3>

              <div *ngIf="profile?.is_super_admin" class="pf-super-admin-banner">
                <tm-icon name="shield" [size]="20" />
                <div>
                  <h4>Unrestricted Global Authority</h4>
                  <p>As a Super Admin, your account has root permissions across every operational module, financial ledger, city configuration, and system setting.</p>
                </div>
              </div>

              <div *ngIf="!profile?.is_super_admin" class="pf-permission-chips">
                <span
                  class="pf-permission-chip"
                  *ngFor="let perm of profile?.permissions"
                >
                  <tm-icon name="check" [size]="12" />
                  <span>{{ formatPermission(perm) }}</span>
                </span>
                <span *ngIf="!profile?.permissions?.length" class="pf-permission-empty">
                  No individual module permissions granted.
                </span>
              </div>
            </div>
          </tm-card>
        </div>

        <!-- 4. SYSTEM & PREFERENCES TAB -->
        <div class="pf-panel" *ngIf="activeTab === 'preferences'">
          <div class="pf-grid pf-grid--security">
            <tm-card elevation="card" padding="loose" class="pf-card">
              <div class="pf-card__header">
                <h2 class="pf-card__title">Display & Appearance</h2>
                <p class="pf-card__sub">Customize your workstation viewing experience.</p>
              </div>

              <div class="pf-pref-list">
                <!-- Theme mode toggle -->
                <div class="pf-pref-row">
                  <div class="pf-pref-row__meta">
                    <span class="pf-pref-row__title">Dark Theme</span>
                    <span class="pf-pref-row__desc">Switch between light and high-contrast dark interfaces.</span>
                  </div>
                  <label class="pf-switch">
                    <input
                      type="checkbox"
                      [checked]="isDarkMode"
                      (change)="toggleTheme($event)"
                    />
                    <span class="pf-switch__track"><span class="pf-switch__thumb"></span></span>
                  </label>
                </div>

                <!-- Sound alerts toggle -->
                <div class="pf-pref-row">
                  <div class="pf-pref-row__meta">
                    <span class="pf-pref-row__title">Audible Live Alerts</span>
                    <span class="pf-pref-row__desc">Play notification chimes when new bookings or urgent ride events arrive.</span>
                  </div>
                  <label class="pf-switch">
                    <input
                      type="checkbox"
                      [checked]="soundAlertsEnabled"
                      (change)="toggleSoundAlerts($event)"
                    />
                    <span class="pf-switch__track"><span class="pf-switch__thumb"></span></span>
                  </label>
                </div>
              </div>
            </tm-card>

            <tm-card elevation="card" padding="loose" class="pf-card">
              <div class="pf-card__header">
                <h2 class="pf-card__title">Environment & Session Details</h2>
                <p class="pf-card__sub">Runtime environment and connection diagnostics.</p>
              </div>

              <div class="pf-role-facts">
                <div class="pf-role-fact">
                  <span class="pf-role-fact__label">Account ID</span>
                  <span class="pf-role-fact__val">#{{ profile?.id }}</span>
                </div>
                <div class="pf-role-fact">
                  <span class="pf-role-fact__label">API Endpoint</span>
                  <span class="pf-role-fact__val"><code>{{ currentApiBase }}</code></span>
                </div>
                <div class="pf-role-fact">
                  <span class="pf-role-fact__label">Application Version</span>
                  <span class="pf-role-fact__val">DreamCabs Portal v1.0.0</span>
                </div>
              </div>
            </tm-card>
          </div>
        </div>
      </main>
    </div>
  `,
  styles: [`
    .pf-page {
      display: flex;
      flex-direction: column;
      gap: 24px;
      padding-bottom: 48px;
    }

    /* Hero section */
    .pf-hero {
      background: var(--tm-surface);
      border-radius: var(--tm-radius-lg);
      box-shadow: var(--tm-shadow-card);
      overflow: hidden;
      border: 1px solid var(--tm-line);
    }
    .pf-hero__content {
      display: flex;
      align-items: center;
      gap: 24px;
      padding: 28px 32px 20px;
    }
    .pf-hero__avatar-wrap {
      flex-shrink: 0;
    }
    .pf-hero__meta {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .pf-hero__title-row {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .pf-hero__name {
      margin: 0;
      font-size: 24px;
      font-weight: 800;
      color: var(--tm-text);
      letter-spacing: -0.02em;
    }
    .pf-hero__email {
      margin: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: var(--tm-text-muted);
      font-weight: 500;
    }
    .pf-hero__dot {
      color: var(--tm-text-soft);
    }
    .pf-hero__phone {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .pf-hero__tags {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    .pf-hero__tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      color: var(--tm-text-muted);
      background: var(--tm-canvas);
      padding: 4px 10px;
      border-radius: var(--tm-radius-pill);
    }

    /* Tabs */
    .pf-tabs {
      display: flex;
      gap: 4px;
      padding: 0 24px;
      border-top: 1px solid var(--tm-line);
      background: var(--tm-surface);
      overflow-x: auto;
    }
    .pf-tab {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 14px 18px;
      background: transparent;
      border: 0;
      border-bottom: 3px solid transparent;
      margin-bottom: -1px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 700;
      color: var(--tm-text-muted);
      white-space: nowrap;
      transition: color var(--tm-duration-fast) var(--tm-ease),
                  border-color var(--tm-duration-fast) var(--tm-ease);
    }
    .pf-tab:hover {
      color: var(--tm-text);
    }
    .pf-tab.is-active {
      color: var(--tm-green-deep);
      border-bottom-color: var(--tm-green);
    }

    /* Body & grids */
    .pf-body {
      min-width: 0;
    }
    .pf-grid {
      display: grid;
      grid-template-columns: 340px 1fr;
      gap: 24px;
      align-items: start;
    }
    .pf-grid--security {
      grid-template-columns: 1fr 380px;
    }
    @media (max-width: 960px) {
      .pf-hero__content {
        flex-direction: column;
        align-items: flex-start;
      }
      .pf-grid,
      .pf-grid--security {
        grid-template-columns: 1fr;
      }
    }

    /* Cards */
    .pf-card {
      display: block;
      border: 1px solid var(--tm-line);
    }
    .pf-card__header {
      margin-bottom: 24px;
    }
    .pf-card__header-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
    }
    .pf-card__title {
      margin: 0 0 6px;
      font-size: 18px;
      font-weight: 800;
      color: var(--tm-text);
    }
    .pf-card__sub {
      margin: 0;
      font-size: 13px;
      color: var(--tm-text-muted);
    }

    /* Avatar editor */
    .pf-avatar-editor {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      text-align: center;
      padding: 12px 0 6px;
    }
    .pf-avatar-editor__preview {
      position: relative;
    }
    .pf-avatar-editor__badge {
      position: absolute;
      top: -4px;
      right: -4px;
      background: var(--tm-green);
      color: #fff;
      font-size: 10px;
      font-weight: 800;
      padding: 2px 7px;
      border-radius: var(--tm-radius-pill);
      text-transform: uppercase;
    }
    .pf-avatar-editor__actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .pf-avatar-editor__hint {
      margin: 0;
      font-size: 12px;
      color: var(--tm-text-soft);
    }
    .pf-file-input {
      display: none;
    }

    /* Form styling */
    .pf-form {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .pf-form__row {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .pf-form__row--readonly {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      padding: 12px 0;
    }
    .pf-readonly-box {
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: var(--tm-canvas);
      padding: 12px 14px;
      border-radius: var(--tm-radius-md);
      border: 1px solid var(--tm-line);
    }
    .pf-readonly-box__label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--tm-text-muted);
    }
    .pf-readonly-box__value {
      font-size: 14px;
      font-weight: 700;
      color: var(--tm-text);
    }
    .pf-form__actions {
      display: flex;
      align-items: center;
      gap: 12px;
      padding-top: 10px;
    }

    /* Password inputs with toggle */
    .pf-pw-field {
      position: relative;
    }
    .pf-pw-toggle {
      position: absolute;
      right: 12px;
      top: 36px;
      background: transparent;
      border: 0;
      color: var(--tm-text-soft);
      cursor: pointer;
      padding: 4px;
      border-radius: var(--tm-radius-xs);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: color var(--tm-duration-fast) var(--tm-ease);
    }
    .pf-pw-toggle:hover {
      color: var(--tm-text);
    }

    /* Password checklist */
    .pf-checklist {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px 16px;
      background: var(--tm-canvas);
      border-radius: var(--tm-radius-md);
      border: 1px solid var(--tm-line);
    }
    .pf-checklist__item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--tm-text-muted);
      transition: color var(--tm-duration-fast) var(--tm-ease);
    }
    .pf-checklist__item.is-met {
      color: var(--tm-success-fg);
    }

    /* Security advisory box */
    .pf-security-box {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .pf-security-box__icon {
      width: 48px;
      height: 48px;
      border-radius: var(--tm-radius-md);
      background: var(--tm-green-soft);
      color: var(--tm-green-deep);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .pf-security-box__title {
      margin: 0;
      font-size: 16px;
      font-weight: 800;
      color: var(--tm-text);
    }
    .pf-security-box__list {
      margin: 0;
      padding-left: 20px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 13px;
      line-height: 1.5;
      color: var(--tm-text-muted);
    }

    /* Role facts & permissions */
    .pf-role-facts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 14px;
      margin-bottom: 28px;
    }
    .pf-role-fact {
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: var(--tm-canvas);
      padding: 14px 16px;
      border-radius: var(--tm-radius-md);
      border: 1px solid var(--tm-line);
    }
    .pf-role-fact__label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--tm-text-muted);
    }
    .pf-role-fact__val {
      font-size: 14px;
      font-weight: 700;
      color: var(--tm-text);
    }
    .pf-role-fact__val code {
      font-family: var(--tm-font-mono);
      background: var(--tm-surface);
      padding: 2px 6px;
      border-radius: var(--tm-radius-xs);
      font-size: 12px;
    }

    .pf-permissions__title {
      font-size: 15px;
      font-weight: 800;
      color: var(--tm-text);
      margin: 0 0 14px;
    }
    .pf-super-admin-banner {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      background: var(--tm-green-tint);
      border: 1px solid var(--tm-green-soft);
      padding: 18px 20px;
      border-radius: var(--tm-radius-md);
      color: var(--tm-green-deep);
    }
    .pf-super-admin-banner h4 {
      margin: 0 0 4px;
      font-size: 15px;
      font-weight: 800;
    }
    .pf-super-admin-banner p {
      margin: 0;
      font-size: 13px;
      line-height: 1.5;
      color: var(--tm-ink-2);
    }
    .pf-permission-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .pf-permission-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: var(--tm-canvas);
      border: 1px solid var(--tm-line);
      border-radius: var(--tm-radius-pill);
      font-size: 12px;
      font-weight: 700;
      color: var(--tm-text);
    }
    .pf-permission-chip tm-icon {
      color: var(--tm-green-deep);
    }
    .pf-permission-empty {
      font-size: 13px;
      color: var(--tm-text-soft);
    }

    /* Preferences list */
    .pf-pref-list {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .pf-pref-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--tm-line);
    }
    .pf-pref-row:last-child {
      border-bottom: 0;
      padding-bottom: 0;
    }
    .pf-pref-row__meta {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .pf-pref-row__title {
      font-size: 14px;
      font-weight: 800;
      color: var(--tm-text);
    }
    .pf-pref-row__desc {
      font-size: 12px;
      color: var(--tm-text-muted);
    }

    /* Switch primitive */
    .pf-switch {
      position: relative;
      display: inline-flex;
      cursor: pointer;
      user-select: none;
    }
    .pf-switch input {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
    }
    .pf-switch__track {
      width: 44px;
      height: 24px;
      background: var(--tm-line-2);
      border-radius: var(--tm-radius-pill);
      display: inline-flex;
      align-items: center;
      padding: 2px;
      transition: background var(--tm-duration-fast) var(--tm-ease);
    }
    .pf-switch__thumb {
      width: 20px;
      height: 20px;
      background: #fff;
      border-radius: 50%;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      transition: transform var(--tm-duration-fast) var(--tm-ease);
    }
    .pf-switch input:checked + .pf-switch__track {
      background: var(--tm-green);
    }
    .pf-switch input:checked + .pf-switch__track .pf-switch__thumb {
      transform: translateX(20px);
    }
  `],
})
export class ProfileComponent implements OnInit, OnDestroy {
  tabs: TabItem[] = [
    { id: 'general', label: 'General Profile', icon: 'user' },
    { id: 'security', label: 'Security & Password', icon: 'shield' },
    { id: 'role', label: 'Role & Permissions', icon: 'id-card' },
    { id: 'preferences', label: 'Preferences', icon: 'sliders' },
  ];
  activeTab: 'general' | 'security' | 'role' | 'preferences' = 'general';

  profile: ManagerProfile | null = null;
  private sub = new Subscription();

  // General profile form fields
  name = '';
  email = '';
  phone = '';
  nameError = '';
  emailError = '';

  selectedFile: File | null = null;
  avatarPreviewUrl: string | null = null;
  removePhotoFlag = false;
  savingProfile = false;

  // Password fields
  currentPassword = '';
  newPassword = '';
  confirmPassword = '';
  currentPasswordError = '';
  newPasswordError = '';
  confirmPasswordError = '';
  showCurrentPw = false;
  showNewPw = false;
  showConfirmPw = false;
  savingPassword = false;

  // Preferences
  isDarkMode = false;
  soundAlertsEnabled = true;

  constructor(
    private auth: AuthService,
    private toast: ToastService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.sub.add(
      this.auth.profile$.subscribe((p) => {
        this.profile = p;
        if (p) {
          this.initForm(p);
        }
        this.cdr.markForCheck();
      }),
    );

    // Refresh profile to have the latest values
    this.auth.ensureLoaded(true).subscribe({
      next: (p) => {
        if (p) {
          this.initForm(p);
          this.cdr.markForCheck();
        }
      },
    });

    this.checkPreferences();
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
    if (this.avatarPreviewUrl) {
      URL.revokeObjectURL(this.avatarPreviewUrl);
    }
  }

  private initForm(p: ManagerProfile): void {
    this.name = p.name || '';
    this.email = p.email || '';
    this.phone = p.phone || '';
    this.selectedFile = null;
    this.removePhotoFlag = false;
  }

  private checkPreferences(): void {
    if (typeof window !== 'undefined') {
      const theme = localStorage.getItem('dreamcabs_theme');
      this.isDarkMode = theme === 'dark' || document.documentElement.getAttribute('data-theme') === 'dark';
      this.soundAlertsEnabled = localStorage.getItem('dreamcabs_sound_alerts') !== '0';
    }
  }

  get currentDisplayPhoto(): string | null {
    if (this.removePhotoFlag) return null;
    return this.avatarPreviewUrl || this.profile?.avatar_url || null;
  }

  get userInitials(): string {
    const n = (this.name || this.profile?.name || '').trim();
    if (!n) return 'DC';
    return n
      .split(/\s+/)
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase();
  }

  get scopeLabel(): string {
    if (!this.profile) return 'All Cities (Global)';
    if (this.profile.is_super_admin || this.profile.manager_all_cities) {
      return 'All Cities (Global)';
    }
    return this.profile.manager_city_name || 'Assigned City';
  }

  get hasPhoto(): boolean {
    return !!this.currentDisplayPhoto;
  }

  get isProfileDirty(): boolean {
    if (!this.profile) return false;
    return (
      this.name.trim() !== (this.profile.name || '').trim() ||
      this.email.trim() !== (this.profile.email || '').trim() ||
      (this.phone || '').trim() !== (this.profile.phone || '').trim()
    );
  }

  get currentApiBase(): string {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('dreamcabs_api_url') || `${window.location.origin}/api`;
    }
    return 'https://dreamcabs.in/api';
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];
    if (file.size > 4 * 1024 * 1024) {
      this.toast.error('Avatar image must not exceed 4MB.');
      return;
    }

    this.selectedFile = file;
    this.removePhotoFlag = false;

    if (this.avatarPreviewUrl) {
      URL.revokeObjectURL(this.avatarPreviewUrl);
    }
    this.avatarPreviewUrl = URL.createObjectURL(file);
    this.cdr.markForCheck();
  }

  onRemovePhoto(): void {
    this.selectedFile = null;
    if (this.avatarPreviewUrl) {
      URL.revokeObjectURL(this.avatarPreviewUrl);
      this.avatarPreviewUrl = null;
    }
    this.removePhotoFlag = true;
    this.cdr.markForCheck();
  }

  resetProfileForm(): void {
    if (this.profile) {
      this.initForm(this.profile);
    }
    if (this.avatarPreviewUrl) {
      URL.revokeObjectURL(this.avatarPreviewUrl);
      this.avatarPreviewUrl = null;
    }
    this.nameError = '';
    this.emailError = '';
    this.cdr.markForCheck();
  }

  onSaveProfile(): void {
    this.nameError = '';
    this.emailError = '';

    const cleanName = this.name.trim();
    const cleanEmail = this.email.trim();

    if (!cleanName) {
      this.nameError = 'Name is required.';
      return;
    }
    if (!cleanEmail || !cleanEmail.includes('@')) {
      this.emailError = 'Please enter a valid email address.';
      return;
    }

    this.savingProfile = true;
    const formData = new FormData();
    formData.append('name', cleanName);
    formData.append('email', cleanEmail);
    formData.append('phone', (this.phone || '').trim());

    if (this.removePhotoFlag) {
      formData.append('remove_photo', '1');
    } else if (this.selectedFile) {
      formData.append('photo', this.selectedFile);
    }

    this.auth.updateProfile(formData).subscribe({
      next: (res) => {
        this.savingProfile = false;
        this.toast.success(res.message || 'Profile updated successfully.');
        this.selectedFile = null;
        this.removePhotoFlag = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.savingProfile = false;
        const msg = err?.error?.message || 'Failed to update profile.';
        if (err?.error?.errors?.email) {
          this.emailError = err.error.errors.email[0];
        }
        if (err?.error?.errors?.name) {
          this.nameError = err.error.errors.name[0];
        }
        this.toast.error(msg);
        this.cdr.markForCheck();
      },
    });
  }

  onUpdatePassword(): void {
    this.currentPasswordError = '';
    this.newPasswordError = '';
    this.confirmPasswordError = '';

    if (!this.currentPassword) {
      this.currentPasswordError = 'Please enter your current password.';
      return;
    }
    if (this.newPassword.length < 6) {
      this.newPasswordError = 'Password must be at least 6 characters.';
      return;
    }
    if (this.newPassword !== this.confirmPassword) {
      this.confirmPasswordError = 'Passwords do not match.';
      return;
    }

    this.savingPassword = true;
    this.auth
      .updatePassword({
        current_password: this.currentPassword,
        password: this.newPassword,
        password_confirmation: this.confirmPassword,
      })
      .subscribe({
        next: (res) => {
          this.savingPassword = false;
          this.toast.success(res.message || 'Password changed successfully.');
          this.currentPassword = '';
          this.newPassword = '';
          this.confirmPassword = '';
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.savingPassword = false;
          const msg = err?.error?.message || 'Failed to change password.';
          if (err?.error?.errors?.current_password) {
            this.currentPasswordError = err.error.errors.current_password[0];
          }
          if (err?.error?.errors?.password) {
            this.newPasswordError = err.error.errors.password[0];
          }
          this.toast.error(msg);
          this.cdr.markForCheck();
        },
      });
  }

  toggleTheme(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.isDarkMode = input.checked;
    const theme = this.isDarkMode ? 'dark' : 'light';
    localStorage.setItem('dreamcabs_theme', theme);
    if (this.isDarkMode) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    this.toast.info(`Theme set to ${this.isDarkMode ? 'Dark' : 'Light'} mode.`);
  }

  toggleSoundAlerts(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.soundAlertsEnabled = input.checked;
    localStorage.setItem('dreamcabs_sound_alerts', this.soundAlertsEnabled ? '1' : '0');
    this.toast.info(this.soundAlertsEnabled ? 'Sound alerts enabled.' : 'Sound alerts muted.');
  }

  formatDate(isoString?: string | null): string {
    if (!isoString) return '';
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return '';
    }
  }

  formatPermission(slug: string): string {
    const map: Record<string, string> = {
      dashboard: 'Dashboard Overview',
      rides: 'Rides & Departures',
      drivers: 'Driver Records & Approvals',
      customers: 'Customer Accounts',
      manual_dispatch: 'Manual Dispatch Desk',
      finance: 'Money Ledger & Finance',
      analytics: 'Real-Time Analytics',
      reports: 'Performance Reports',
      live_operations: 'Live Operations Map',
      vehicles: 'Fleet & Vehicle Master',
      pricing: 'Pricing Rules & Dynamic Fares',
      city_settings: 'City Configurations',
      coupons: 'Promotions & Coupons',
      subscriptions: 'Driver Subscriptions',
      app_assets: 'App Marker Assets',
      fleets: 'Franchise Fleet Fleets',
      safety: 'Safety Incidents & SOS',
      contact_drivers: 'Driver Communication',
      operator_settings: 'Operator Platform Rules',
      managers: 'Admin Manager Accounts',
      roles_permissions: 'Roles & Access Control',
    };
    return map[slug] || slug.replace(/_/g, ' ');
  }
}
