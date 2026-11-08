import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ApiService } from '../../../core/api.service';
import { ToastService } from '../../../core/toast.service';
import { ButtonComponent, FileDropComponent, IconComponent, ModalComponent } from '../../../ui';
import { DriverApprovalActionsPaneComponent } from './driver-approval-actions.pane';
import { DriverProfilePaneComponent } from './driver-profile.pane';
import { DriverDocumentsPaneComponent } from './driver-documents.pane';
import { acquireDocumentScrollLock } from '../../../ui/document-scroll-lock';
import {
  CatalogDoc,
  DocumentRequirement,
  DriverDocumentRow,
  DriverProfile,
  VehicleForm,
} from './driver-detail.types';

interface FullProfileResponse {
  document_requirements?: DocumentRequirement[];
  driver: DriverProfile;
  documents: DriverDocumentRow[];
}

/**
 * Slide-in drawer that hosts the driver profile, document review, and
 * approve/reject actions. Opens whenever `[driverId]` becomes non-null;
 * closing emits `(closed)` and the parent strips the URL param.
 */
@Component({
  selector: 'app-driver-detail-drawer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    ButtonComponent,
    FileDropComponent,
    IconComponent,
    ModalComponent,
    DriverApprovalActionsPaneComponent,
    DriverProfilePaneComponent,
    DriverDocumentsPaneComponent,
  ],
  template: `
    <div
      *ngIf="mounted"
      class="drawer"
      [class.is-closing]="closing"
      role="dialog"
      aria-modal="true"
      aria-label="Driver detail"
      (click)="close()"
    >
      <aside
        class="drawer__panel"
        [class.is-closing]="closing"
        (click)="$event.stopPropagation()"
      >
        <header class="drawer__head">
          <h2 class="drawer__title">Driver Detail</h2>
          <button
            type="button"
            class="drawer__close"
            (click)="close()"
            aria-label="Close"
          >
            <tm-icon name="x" [size]="16" />
          </button>
        </header>

        <div class="drawer__body">
          <div *ngIf="loading" class="empty">Loading…</div>

          <ng-container *ngIf="!loading && driver">
            <app-driver-profile-pane
              [driver]="driver"
              [vehicleForm]="vehicleForm"
              [savingVehicle]="savingVehicle"
              (vehicleFormChange)="vehicleForm = $event"
              (save)="saveVehicle()"
              (changePhone)="openAdminPhoneModal()"
            />

            <app-driver-documents-pane
              [requirements]="requirements"
              [documents]="documents"
              (openUpload)="openAdminUpload()"
              (viewFile)="viewFile($event)"
              (downloadFile)="downloadFile($event)"
              (approveDocument)="setStatus($event, 'approved')"
              (rejectDocument)="openReject($event)"
            />
          </ng-container>
        </div>

        <app-driver-approval-actions-pane
          *ngIf="!loading && driver"
          [approvalStatus]="driver.approval_status"
          [payoutStatus]="driver.payout_account_status ?? 'none'"
          [busy]="busyApproval"
          (approve)="setApproval('approved')"
          (reject)="setApproval('rejected')"
        />
      </aside>
    </div>

    <!-- Reject-document modal -->
    <tm-modal
      [open]="rejectOpen"
      title="Reject document"
      [dismissible]="!rejectSaving"
      (closed)="rejectOpen = false"
    >
      <ng-container slot="body">
        <p class="muted small">A reason is required so the driver knows why and can re-upload.</p>
        <label class="lbl">Reason *</label>
        <textarea
          class="textarea"
          rows="3"
          [(ngModel)]="rejectReason"
          [disabled]="rejectSaving"
          placeholder="e.g. Image is blurry — please re-upload."
        ></textarea>
      </ng-container>
      <ng-container slot="footer">
        <tm-button variant="ghost" (clicked)="rejectOpen = false" [disabled]="rejectSaving">Cancel</tm-button>
        <tm-button variant="danger" icon="x" (clicked)="submitReject()" [loading]="rejectSaving">Reject</tm-button>
      </ng-container>
    </tm-modal>

    <!-- Upload-on-behalf modal (drag-drop with per-file progress) -->
    <tm-modal
      [open]="uploadOpen"
      title="Upload documents on behalf"
      [dismissible]="!uploadBusy"
      (closed)="closeUploadModal()"
    >
      <ng-container slot="body">
        <p class="muted small">
          Drop one or more files, then pick which catalog document each one represents.
        </p>

        <div *ngIf="!hasAnyAvailableDocSlots() && !uploads.length" class="doc-fulfilled-banner">
          <tm-icon name="check" [size]="14" />
          <span>All required catalog documents have already been uploaded for this driver.</span>
        </div>

        <tm-file-drop
          accept="image/*,application/pdf"
          [multiple]="true"
          [maxSizeMb]="10"
          [disabled]="uploadBusy"
          title="Drop documents here, or click to browse"
          hint="Images or PDFs up to 10 MB each"
          (filesAdded)="onFilesAdded($event)"
          (rejected)="onFilesRejected($event)"
        />

        <ng-container *ngIf="uploads.length">
          <ul class="uploads">
            <li *ngFor="let u of uploads; trackBy: trackUpload" class="upload">
              <div class="upload__row">
                <div class="upload__file">
                  <tm-icon name="upload" [size]="14" />
                  <div class="upload__file-meta">
                    <strong>{{ u.file.name }}</strong>
                    <span class="muted small">{{ formatBytes(u.file.size) }}</span>
                  </div>
                </div>

                <select
                  class="upload__select"
                  [ngModel]="u.docId"
                  (ngModelChange)="assignDoc(u, $event)"
                  [disabled]="u.status !== 'queued'"
                >
                  <option [ngValue]="null" disabled>
                    {{ getAvailableDocsForUpload(u).length ? 'Choose document type…' : 'No document slots available' }}
                  </option>
                  <option *ngFor="let d of getAvailableDocsForUpload(u)" [ngValue]="d.id">
                    {{ getDocDropdownLabel(d, u) }}
                  </option>
                </select>

                <span class="upload__status"
                      [class.is-done]="u.status === 'done'"
                      [class.is-failed]="u.status === 'failed'"
                      [class.is-uploading]="u.status === 'uploading'">
                  {{ u.status }}
                </span>

                <button
                  type="button"
                  class="upload__remove"
                  (click)="removeUpload(u)"
                  [disabled]="u.status === 'uploading'"
                  aria-label="Remove"
                  title="Remove"
                >
                  <tm-icon name="x" [size]="12" />
                </button>
              </div>

              <div class="upload__progress" *ngIf="u.status === 'uploading' || u.status === 'done'">
                <div class="upload__progress-fill"
                     [class.is-done]="u.status === 'done'"
                     [style.width.%]="u.percent"></div>
              </div>

              <p class="upload__error" *ngIf="u.status === 'failed' && u.error">
                <tm-icon name="x" [size]="11" /> {{ u.error }}
              </p>
            </li>
          </ul>
        </ng-container>

        <div *ngIf="!catalogDocs.length && uploads.length" class="empty">
          No catalog documents to assign yet. Create some under
          <strong>Drivers → Documents Catalog</strong>.
        </div>
      </ng-container>

      <ng-container slot="footer">
        <tm-button variant="ghost" (clicked)="closeUploadModal()" [disabled]="uploadBusy">
          {{ uploadAllDone ? 'Close' : 'Cancel' }}
        </tm-button>
        <tm-button variant="ink"
                   icon="upload"
                   [loading]="uploadBusy"
                   [disabled]="!canSubmitUpload()"
                   (clicked)="submitUploads()">{{ uploadButtonLabel() }}</tm-button>
      </ng-container>
    </tm-modal>

    <!-- ============= Admin Phone Change Modal ============= -->
    <tm-modal
      [open]="adminPhoneModalOpen"
      title="Change Driver Phone"
      (closed)="closeAdminPhoneModal()"
    >
      <div slot="body" class="modal-form-body admin-phone-modal">
        <div *ngIf="adminPhoneStep === 'input'">
          <p class="form-hint">
            To change this driver's phone number, an SMS OTP will be sent to the new number for verification.
          </p>
          <div class="form-group">
            <label class="lbl"><span class="req">*</span> New Phone Number</label>
            <input
              class="input mono"
              type="tel"
              [(ngModel)]="adminNewPhone"
              [disabled]="adminPhoneBusy"
              placeholder="e.g. +919876543210"
            />
          </div>
        </div>

        <div *ngIf="adminPhoneStep === 'otp'">
          <p class="form-hint">
            Enter the 6-digit verification code sent to <strong>{{ adminNewPhone }}</strong>.
          </p>
          <div class="form-group">
            <label class="lbl"><span class="req">*</span> Verification Code (OTP)</label>
            <input
              class="input mono"
              type="text"
              inputmode="numeric"
              maxlength="6"
              [(ngModel)]="adminOtpCode"
              [disabled]="adminPhoneBusy"
              placeholder="6-digit OTP"
            />
          </div>
          <div class="modal-resend-row">
            <button
              type="button"
              class="btn-link"
              (click)="sendAdminPhoneOtp()"
              [disabled]="adminPhoneBusy || adminResendCountdown > 0"
            >
              {{ adminResendCountdown > 0 ? 'Resend in ' + adminResendCountdown + 's' : 'Resend Code' }}
            </button>
            <button
              type="button"
              class="btn-link text-muted"
              (click)="adminPhoneStep = 'input'"
              [disabled]="adminPhoneBusy"
            >
              Edit number
            </button>
          </div>
        </div>

        <div class="form-error-notice" *ngIf="adminPhoneError">
          <tm-icon name="alert-triangle" [size]="14" />
          <span>{{ adminPhoneError }}</span>
        </div>
      </div>

      <ng-container slot="footer">
        <tm-button variant="ghost" (clicked)="closeAdminPhoneModal()" [disabled]="adminPhoneBusy">
          Cancel
        </tm-button>
        <tm-button
          *ngIf="adminPhoneStep === 'input'"
          variant="green"
          icon="send"
          [loading]="adminPhoneBusy"
          [disabled]="!adminNewPhone.trim()"
          (clicked)="sendAdminPhoneOtp()"
        >
          Send OTP
        </tm-button>
        <tm-button
          *ngIf="adminPhoneStep === 'otp'"
          variant="green"
          icon="check"
          [loading]="adminPhoneBusy"
          [disabled]="!adminOtpCode.trim()"
          (clicked)="verifyAdminPhoneOtp()"
        >
          Verify &amp; Update
        </tm-button>
      </ng-container>
    </tm-modal>

  `,
  styles: [`
    :host { display: contents; }

    /* ----- Drawer shell ----- */
    .drawer {
      position: fixed;
      inset: 0;
      z-index: 1100;
      background: rgba(15, 20, 25, 0.42);
      backdrop-filter: blur(2px);
      display: flex;
      justify-content: flex-end;
      animation: drawer-fade-in 180ms var(--tm-ease) both;
    }
    .drawer.is-closing { animation: drawer-fade-out 180ms var(--tm-ease) both; }
    @keyframes drawer-fade-in {
      from { opacity: 0; } to { opacity: 1; }
    }
    @keyframes drawer-fade-out {
      from { opacity: 1; } to { opacity: 0; }
    }

    .drawer__panel {
      width: min(1180px, 98vw);
      max-width: 98vw;
      height: 100%;
      background: var(--tm-canvas);
      border-left: 1px solid var(--tm-line);
      box-shadow: -20px 0 50px rgba(15, 20, 25, 0.18);
      display: flex;
      flex-direction: column;
      animation: drawer-slide-in 220ms var(--tm-ease) both;
    }
    .drawer__panel.is-closing { animation: drawer-slide-out 200ms var(--tm-ease) both; }
    @keyframes drawer-slide-in {
      from { transform: translateX(40px); opacity: 0; }
      to   { transform: translateX(0);    opacity: 1; }
    }
    @keyframes drawer-slide-out {
      from { transform: translateX(0);    opacity: 1; }
      to   { transform: translateX(40px); opacity: 0; }
    }

    .drawer__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--tm-space-4) var(--tm-space-5);
      background: var(--tm-surface);
      border-bottom: 1px solid var(--tm-line);
    }
    .drawer__title {
      margin: 0;
      font-size: 16px;
      font-weight: 800;
      color: var(--tm-text);
      letter-spacing: -0.01em;
    }
    .drawer__close {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--tm-canvas-2);
      color: var(--tm-text-muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      border: 0;
      cursor: pointer;
      transition: background var(--tm-duration-fast) var(--tm-ease),
                  color var(--tm-duration-fast) var(--tm-ease);
    }
    .drawer__close:hover { background: var(--tm-ink); color: #fff; }

    .drawer__body {
      flex: 1;
      overflow: auto;
      padding: var(--tm-space-5) var(--tm-space-6);
    }

    .empty { padding: 30px; text-align: center; color: var(--tm-text-muted); }

    /* Reject + upload modals shared bits */
    .lbl {
      margin-top: 10px;
      display: block;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--tm-text-muted);
    }
    .textarea {
      width: 100%;
      margin-top: 6px;
      padding: 10px 12px;
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-sm);
      background: var(--tm-surface);
      font-family: var(--tm-font-body);
      font-size: 13px;
      color: var(--tm-text);
      resize: vertical;
      min-height: 80px;
      outline: 0;
      transition: border-color var(--tm-duration-fast) var(--tm-ease);
    }
    .textarea:focus { border-color: var(--tm-ink); }
    .textarea:disabled { background: var(--tm-canvas-2); cursor: not-allowed; }

    .muted { color: var(--tm-text-muted); }
    .small { font-size: 12px; }

    .doc-fulfilled-banner {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      margin-bottom: 12px;
      border-radius: var(--tm-radius-sm);
      background: var(--tm-green-tint);
      color: var(--tm-green-deep);
      border: 1px solid var(--tm-green-soft);
      font-size: 12px;
      font-weight: 600;
    }

    /* Upload list */
    .uploads {
      list-style: none;
      margin: var(--tm-space-3) 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 360px;
      overflow: auto;
    }
    .upload {
      border: 1px solid var(--tm-line);
      border-radius: var(--tm-radius-sm);
      padding: 10px 12px;
      background: var(--tm-canvas);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .upload__row {
      display: grid;
      grid-template-columns: 1fr 240px 80px 28px;
      align-items: center;
      gap: 10px;
    }
    .upload__file {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      color: var(--tm-text-muted);
    }
    .upload__file-meta { display: flex; flex-direction: column; min-width: 0; }
    .upload__file-meta strong {
      font-size: 13px;
      color: var(--tm-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .upload__select {
      width: 100%;
      padding: 7px 10px;
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-sm);
      background: var(--tm-surface);
      font-size: 12px;
      color: var(--tm-text);
      outline: 0;
    }
    .upload__select:focus { border-color: var(--tm-ink); }
    .upload__select:disabled {
      background: var(--tm-canvas-2);
      color: var(--tm-text-soft);
      cursor: not-allowed;
    }
    .upload__status {
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--tm-text-muted);
      text-align: center;
      padding: 3px 8px;
      border-radius: var(--tm-radius-pill);
      background: var(--tm-canvas-2);
    }
    .upload__status.is-uploading { background: #eff6ff; color: #1d4ed8; }
    .upload__status.is-done      { background: var(--tm-green-tint); color: var(--tm-green-deep); }
    .upload__status.is-failed    { background: #fef2f2; color: #dc2626; }
    .upload__remove {
      width: 24px; height: 24px;
      border: 0;
      background: var(--tm-canvas-2);
      color: var(--tm-text-muted);
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .upload__remove:hover:not(:disabled) { background: var(--tm-ink); color: #fff; }
    .upload__remove:disabled { opacity: 0.4; cursor: not-allowed; }

    .upload__progress {
      width: 100%;
      height: 4px;
      background: var(--tm-canvas-2);
      border-radius: 2px;
      overflow: hidden;
    }
    .upload__progress-fill {
      height: 100%;
      background: var(--tm-ink);
      transition: width 100ms linear;
    }
    .upload__progress-fill.is-done { background: var(--tm-green-deep); }

    .upload__error {
      margin: 0;
      font-size: 11px;
      color: #dc2626;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    @media (max-width: 540px) {
      .upload__row {
        grid-template-columns: 1fr 28px;
        grid-template-areas:
          "file  remove"
          "select select"
          "status status";
      }
      .upload__file   { grid-area: file; }
      .upload__select { grid-area: select; }
      .upload__status { grid-area: status; justify-self: start; }
      .upload__remove { grid-area: remove; }
    }

    @media (max-width: 640px) {
      .drawer__panel { width: 100vw; }
      .drawer__head { padding: var(--tm-space-3) var(--tm-space-4); }
      .drawer__body { padding: var(--tm-space-4); }

    .admin-phone-modal { display: flex; flex-direction: column; gap: 12px; }
    .admin-phone-modal .modal-resend-row { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
    .admin-phone-modal .btn-link { background: none; border: none; color: var(--tm-green-deep, #0e8f49); font-size: 12px; font-weight: 600; cursor: pointer; padding: 2px 0; }
    .admin-phone-modal .btn-link.text-muted { color: var(--tm-text-muted); text-decoration: underline; }
    .admin-phone-modal .btn-link:disabled { opacity: 0.5; cursor: not-allowed; }
    .admin-phone-modal .form-hint { font-size: 13px; color: var(--tm-text-muted); margin: 0 0 10px; line-height: 1.4; }
    .admin-phone-modal .form-error-notice { display: flex; align-items: center; gap: 6px; color: var(--tm-danger); font-size: 12px; font-weight: 600; margin-top: 8px; }
    .mono { font-family: var(--tm-font-mono) !important; }

    }
  `],
})
export class DriverDetailDrawerComponent implements OnChanges, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly cdr = inject(ChangeDetectorRef);

  /** Source of truth: the parent toggles this via URL state. */
  @Input() driverId: number | null = null;
  @Output() closed = new EventEmitter<void>();

  /** Mount lifecycle (see comment above on the race guard). */
  mounted = false;
  closing = false;
  private generation = 0;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseScrollLock?: () => void;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight = false;

  loading = false;
  driver: DriverProfile | null = null;
  documents: DriverDocumentRow[] = [];
  requirements: DocumentRequirement[] = [];

  vehicleForm: VehicleForm = { vehicle_reg_no: '' };
  savingVehicle = false;
  busyApproval = false;

  rejectOpen = false;
  rejectSaving = false;
  rejectTarget: DriverDocumentRow | null = null;
  rejectReason = '';

  uploadOpen = false;
  uploadBusy = false;
  catalogDocs: CatalogDoc[] = [];
  uploads: PendingUpload[] = [];
  private uploadIdSeq = 0;

  adminPhoneModalOpen = false;
  adminPhoneStep: 'input' | 'otp' = 'input';
  adminNewPhone = '';
  adminOtpCode = '';
  adminPhoneBusy = false;
  adminPhoneError: string | null = null;
  adminResendCountdown = 0;
  private adminResendTimer: any = null;


  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['driverId']) return;
    if (this.driverId == null) {
      // Parent cleared the param — only animate if we were actually open.
      if (this.mounted && !this.closing) this.runCloseAnimation();
      return;
    }
    // Open or switch driver
    this.openFor(this.driverId);
  }

  ngOnDestroy(): void {
    if (this.adminResendTimer) { clearInterval(this.adminResendTimer); this.adminResendTimer = null; }
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.stopLiveRefresh();
    this.releaseScrollLock?.();
    this.releaseScrollLock = undefined;
  }

  // ------------------------------------------------------------------------
  // Open / close
  // ------------------------------------------------------------------------

  private openFor(id: number): void {
    this.generation++;
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
    this.mounted = true;
    this.closing = false;
    if (!this.releaseScrollLock) this.releaseScrollLock = acquireDocumentScrollLock();
    this.driver = null;
    this.documents = [];
    this.requirements = [];
    this.fetch(id);
    this.fetchCatalog();
    this.startLiveRefresh();
  }

  close(): void {
    if (!this.mounted || this.closing) return;
    this.runCloseAnimation();
    this.closed.emit();
  }

  private runCloseAnimation(): void {
    this.stopLiveRefresh();
    this.closing = true;
    const gen = this.generation;
    this.closeTimer = setTimeout(() => {
      if (gen !== this.generation) return;
      this.mounted = false;
      this.closing = false;
      this.closeTimer = null;
      this.releaseScrollLock?.();
      this.releaseScrollLock = undefined;
      this.cdr.markForCheck();
    }, 200);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.mounted && !this.closing) this.close();
  }

  // ------------------------------------------------------------------------
  // Fetch
  // ------------------------------------------------------------------------

  private startLiveRefresh(): void {
    this.stopLiveRefresh();
    this.refreshTimer = setInterval(() => {
      if (this.driverId == null || this.refreshInFlight || this.rejectOpen || this.uploadOpen || this.busyApproval || this.savingVehicle) return;
      this.fetch(this.driverId, true);
      this.fetchCatalog();
    }, 5000);
  }

  private stopLiveRefresh(): void {
    if (!this.refreshTimer) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private fetch(id: number, silent = false): void {
    if (this.refreshInFlight) return;
    this.refreshInFlight = true;
    if (!silent) this.loading = true;
    this.api.get<FullProfileResponse>(`/admin/drivers/${id}/full`).subscribe({
      next: (res) => {
        this.driver = res.driver;
        this.documents = res.documents || [];
        this.requirements = res.document_requirements || [];
        if (!this.savingVehicle) this.vehicleForm = { vehicle_reg_no: res.driver.vehicle_reg_no || '' };
        this.loading = false;
        this.refreshInFlight = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loading = false;
        this.refreshInFlight = false;
        if (!silent) this.toast.error(err?.error?.message || 'Failed to load driver', { title: 'Load failed' });
        this.cdr.markForCheck();
      },
    });
  }

  private fetchCatalog(): void {
    this.api.get<{ data: CatalogDoc[] }>('/admin/documents').subscribe({
      next: (res) => {
        const list = (res as { data?: CatalogDoc[] }).data ?? [];
        this.catalogDocs = list.map((d) => ({
          id: d.id,
          name: d.name,
          no_of_images: d.no_of_images,
        }));
        this.cdr.markForCheck();
      },
    });
  }

  // ------------------------------------------------------------------------
  // Vehicle (Reg No) save
  // ------------------------------------------------------------------------

  saveVehicle(): void {
    if (this.driverId == null) return;
    this.savingVehicle = true;
    this.api
      .patch<{ driver: Record<string, unknown> }>(`/admin/drivers/${this.driverId}`, {
        vehicle_reg_no: this.vehicleForm.vehicle_reg_no.trim() || null,
      })
      .subscribe({
        next: () => {
          this.savingVehicle = false;
          this.toast.success('Reg No saved');
          if (this.driver) {
            this.driver = {
              ...this.driver,
              vehicle_reg_no: this.vehicleForm.vehicle_reg_no || null,
            };
          }
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.savingVehicle = false;
          this.toast.error(err?.error?.message || 'Failed to save', { title: 'Save failed' });
          this.cdr.markForCheck();
        },
      });
  }

  // ------------------------------------------------------------------------
  // Document file fetch (view / download)
  // ------------------------------------------------------------------------

  viewFile(d: DriverDocumentRow): void {
    this.fetchAndOpen(d, false, d.document_name || `doc-${d.id}`);
  }
  downloadFile(d: DriverDocumentRow): void {
    this.fetchAndOpen(d, true, d.document_name || `doc-${d.id}`);
  }

  private fetchAndOpen(d: DriverDocumentRow, asDownload: boolean, displayName: string): void {
    let apiPath = this.toApiPath(d.file_url);
    if (!apiPath) {
      this.toast.error('Could not resolve file URL');
      return;
    }
    if (asDownload) apiPath += apiPath.includes('?') ? '&download=1' : '?download=1';
    this.api.getBlob(apiPath).subscribe({
      next: (blob) => {
        const objectUrl = URL.createObjectURL(blob);
        if (asDownload) {
          const a = document.createElement('a');
          a.href = objectUrl;
          a.download = this.suggestFilename(displayName, blob.type);
          document.body.appendChild(a);
          a.click();
          a.remove();
        } else {
          window.open(objectUrl, '_blank');
        }
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      },
      error: (err) => {
        this.toast.error(
          err?.status === 401
            ? 'Session expired — sign in again.'
            : (err?.error?.message || `Couldn't fetch the file (HTTP ${err?.status ?? '?'})`),
        );
      },
    });
  }

  private toApiPath(absoluteUrl: string): string | null {
    try {
      const parsed = new URL(absoluteUrl);
      let p = parsed.pathname + parsed.search;
      while (p === '/api' || p.startsWith('/api/')) p = p.slice(4) || '/';
      return p || null;
    } catch {
      return null;
    }
  }

  private suggestFilename(name: string, mime: string): string {
    const safe = (name || 'document').replace(/[^a-z0-9._-]+/gi, '_');
    if (safe.includes('.')) return safe;
    const ext = mime?.split('/')?.[1] ?? 'bin';
    return `${safe}.${ext}`;
  }

  // ------------------------------------------------------------------------
  // Per-document approve / reject
  // ------------------------------------------------------------------------

  setStatus(d: DriverDocumentRow, status: 'approved' | 'rejected'): void {
    if (status === 'approved' && !this.driver?.vehicle_reg_no?.trim()) {
      this.toast.error(
        'Please register vehicle number first.',
        { title: 'Cannot approve document' },
      );
      return;
    }
    this.api
      .patch<{ document: DriverDocumentRow }>(`/admin/drivers/documents/${d.id}/status`, { status })
      .subscribe({
        next: () => {
          this.toast.success(`Document ${status}`);
          if (this.driverId != null) this.fetch(this.driverId, true);
          else this.cdr.markForCheck();
        },
        error: (err) => this.toast.error(err?.error?.message || 'Update failed'),
      });
  }

  openReject(d: DriverDocumentRow): void {
    this.rejectTarget = d;
    this.rejectReason = d.rejection_reason || '';
    this.rejectOpen = true;
  }

  submitReject(): void {
    if (!this.rejectTarget) return;
    if (!this.rejectReason.trim()) {
      this.toast.warning('A rejection reason is required.');
      return;
    }
    this.rejectSaving = true;
    const target = this.rejectTarget;
    this.api
      .patch<{ document: DriverDocumentRow }>(`/admin/drivers/documents/${target.id}/status`, {
        status: 'rejected',
        rejection_reason: this.rejectReason.trim(),
      })
      .subscribe({
        next: () => {
          this.rejectSaving = false;
          this.rejectOpen = false;
          this.toast.success('Document rejected');
          if (this.driverId != null) this.fetch(this.driverId, true);
          else this.cdr.markForCheck();
        },
        error: (err) => {
          this.rejectSaving = false;
          this.toast.error(err?.error?.message || 'Failed to reject');
          this.cdr.markForCheck();
        },
      });
  }

  // ------------------------------------------------------------------------
  // Driver-level approval
  // ------------------------------------------------------------------------

  setApproval(status: 'approved' | 'rejected'): void {
    if (this.driverId == null || !this.driver) return;
    this.busyApproval = true;
    this.api
      .patch<{ driver: { approval_status: string } }>(
        `/admin/drivers/${this.driverId}/approval`,
        { approval_status: status },
      )
      .subscribe({
        next: (res) => {
          this.busyApproval = false;
          if (this.driver) {
            this.driver = {
              ...this.driver,
              approval_status: res.driver.approval_status as DriverProfile['approval_status'],
            };
          }
          this.toast.success(`Driver ${status}`);
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.busyApproval = false;
          const missing: string[] = Array.isArray(err?.error?.missing)
            ? err.error.missing.filter((item: unknown): item is string => typeof item === 'string')
            : [];
          const message = err?.error?.message || 'Approval update failed';
          this.toast.error(missing.length ? `${message} Missing approvals: ${missing.join(', ')}.` : message);
          this.cdr.markForCheck();
        },
      });
  }

  // ------------------------------------------------------------------------
  // Admin upload-on-behalf slot calculation & helpers
  // ------------------------------------------------------------------------

  getExistingDocCount(docId: number): number {
    return this.documents.filter(
      (d) => d.document_id === docId && d.status !== 'rejected',
    ).length;
  }

  getTotalRequiredCount(doc: CatalogDoc): number {
    return Math.max(1, doc.no_of_images || 1);
  }

  getServerRemainingSlots(doc: CatalogDoc): number {
    const existing = this.getExistingDocCount(doc.id);
    const total = this.getTotalRequiredCount(doc);
    return Math.max(0, total - existing);
  }

  getOtherAssignedCount(docId: number, currentUploadId: string): number {
    return this.uploads.filter(
      (x) => x.id !== currentUploadId && x.docId === docId && x.status !== 'failed',
    ).length;
  }

  getRemainingSlotsForUpload(doc: CatalogDoc, currentUpload: PendingUpload): number {
    const serverRemaining = this.getServerRemainingSlots(doc);
    const otherAssigned = this.getOtherAssignedCount(doc.id, currentUpload.id);
    return Math.max(0, serverRemaining - otherAssigned);
  }

  getAvailableDocsForUpload(currentUpload: PendingUpload): CatalogDoc[] {
    return this.catalogDocs.filter((d) => {
      if (currentUpload.docId === d.id) return true;
      return this.getRemainingSlotsForUpload(d, currentUpload) > 0;
    });
  }

  getDocDropdownLabel(doc: CatalogDoc, currentUpload: PendingUpload): string {
    const uploaded = this.getExistingDocCount(doc.id);
    const total = this.getTotalRequiredCount(doc);
    const remaining = this.getRemainingSlotsForUpload(doc, currentUpload);
    return `${doc.name} (${uploaded}/${total} uploaded · ${remaining} needed)`;
  }

  hasAnyAvailableDocSlots(): boolean {
    return this.catalogDocs.some((d) => this.getServerRemainingSlots(d) > 0);
  }

  // ------------------------------------------------------------------------
  // Admin upload-on-behalf (drag-drop with per-file progress)
  // ------------------------------------------------------------------------

  openAdminUpload(): void {
    this.uploads = [];
    this.uploadIdSeq = 0;
    this.uploadOpen = true;
    if (!this.catalogDocs.length) this.fetchCatalog();
  }

  closeUploadModal(): void {
    if (this.uploadBusy) return;
    this.uploadOpen = false;
    // If any uploads succeeded, refresh the document list.
    if (this.uploads.some((u) => u.status === 'done') && this.driverId != null) {
      this.fetch(this.driverId);
    }
    this.uploads = [];
  }

  onFilesAdded(files: File[]): void {
    const next: PendingUpload[] = [];
    for (const f of files) {
      const uId = `u-${++this.uploadIdSeq}`;
      const tempUpload: PendingUpload = {
        id: uId,
        file: f,
        docId: null,
        status: 'queued',
        percent: 0,
      };

      // Auto-assign if only 1 document type in the entire catalog currently needs slots
      const docsWithSlots = this.catalogDocs.filter((d) => {
        const serverRemaining = this.getServerRemainingSlots(d);
        const alreadyAssignedInQueue = [...this.uploads, ...next].filter(
          (x) => x.docId === d.id && x.status !== 'failed',
        ).length;
        return serverRemaining - alreadyAssignedInQueue > 0;
      });

      if (docsWithSlots.length === 1) {
        tempUpload.docId = docsWithSlots[0].id;
      }
      next.push(tempUpload);
    }
    this.uploads = [...this.uploads, ...next];
    this.cdr.markForCheck();
  }

  onFilesRejected(items: { file: File; reason: string }[]): void {
    for (const r of items) {
      this.toast.error(`${r.file.name}: ${r.reason}`, { title: 'File rejected' });
    }
  }

  assignDoc(u: PendingUpload, docId: number | null): void {
    this.uploads = this.uploads.map((x) => (x.id === u.id ? { ...x, docId } : x));
    this.cdr.markForCheck();
  }

  removeUpload(u: PendingUpload): void {
    if (u.status === 'uploading') return;
    this.uploads = this.uploads.filter((x) => x.id !== u.id);
    this.cdr.markForCheck();
  }

  trackUpload = (_: number, u: PendingUpload) => u.id;

  formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  /** True when there's at least one queued upload with a valid doc-type chosen. */
  canSubmitUpload(): boolean {
    return !this.uploadBusy
      && this.uploads.length > 0
      && this.uploads.some((u) => u.status === 'queued' && u.docId != null);
  }

  get uploadAllDone(): boolean {
    return this.uploads.length > 0
      && this.uploads.every((u) => u.status === 'done');
  }

  uploadButtonLabel(): string {
    const queued = this.uploads.filter((u) => u.status === 'queued' && u.docId != null).length;
    if (queued === 0) return this.uploadAllDone ? 'All uploaded' : 'Upload';
    return queued === 1 ? 'Upload 1 file' : `Upload ${queued} files`;
  }

  submitUploads(): void {
    if (this.driverId == null || !this.canSubmitUpload()) return;
    const targets = this.uploads.filter((u) => u.status === 'queued' && u.docId != null);
    if (!targets.length) return;
    this.uploadBusy = true;
    const inheritedVehicleTypeId = this.driver?.vehicle_type_id ?? null;
    let pending = targets.length;

    // Group target uploads by docId so we can allocate exact slot indexes
    const targetsByDoc = new Map<number, PendingUpload[]>();
    for (const target of targets) {
      if (target.docId == null) continue;
      const list = targetsByDoc.get(target.docId) ?? [];
      list.push(target);
      targetsByDoc.set(target.docId, list);
    }

    for (const [docId, docTargets] of targetsByDoc.entries()) {
      const catDoc = this.catalogDocs.find((d) => d.id === docId);
      const totalSlots = catDoc ? this.getTotalRequiredCount(catDoc) : 1;
      const existingRows = this.documents.filter(
        (d) => d.document_id === docId && (inheritedVehicleTypeId == null || d.vehicle_type_id == null || d.vehicle_type_id === inheritedVehicleTypeId),
      );

      // Find missing or rejected slots in 1..totalSlots
      const availableSlots: number[] = [];
      for (let s = 1; s <= totalSlots; s++) {
        const row = existingRows.find((r) => r.image_index === s);
        if (!row || row.status === 'rejected') {
          availableSlots.push(s);
        }
      }

      for (let i = 0; i < docTargets.length; i++) {
        const target = docTargets[i];
        const assignedSlot = availableSlots[i] ?? (i + 1);

        this.markUpload(target.id, { status: 'uploading', percent: 0 });
        const fd = new FormData();
        fd.append('document_id', String(target.docId));
        fd.append('image_index', String(assignedSlot));
        if (inheritedVehicleTypeId) fd.append('vehicle_type_id', String(inheritedVehicleTypeId));
        fd.append('file', target.file);

        this.api
          .postMultipartWithProgress<{ document: unknown }>(
            `/admin/drivers/${this.driverId}/documents`,
            fd,
          )
          .subscribe({
            next: (ev) => {
              if (ev.kind === 'progress') {
                this.markUpload(target.id, { percent: ev.percent });
              } else {
                this.markUpload(target.id, { status: 'done', percent: 100 });
                this.toast.success(`${target.file.name} uploaded`);
              }
            },
            error: (err) => {
              this.markUpload(target.id, {
                status: 'failed',
                error: err?.error?.message || `HTTP ${err?.status ?? '?'}`,
              });
              this.toast.error(`${target.file.name} failed`);
              if (--pending === 0) this.finishBatch();
            },
            complete: () => {
              if (--pending === 0) this.finishBatch();
            },
          });
      }
    }
  }

  private markUpload(id: string, patch: Partial<PendingUpload>): void {
    this.uploads = this.uploads.map((u) => (u.id === id ? { ...u, ...patch } : u));
    this.cdr.markForCheck();
  }

  private finishBatch(): void {
    this.uploadBusy = false;
    // Refresh documents in the background so the table reflects new uploads.
    if (this.driverId != null) this.fetch(this.driverId);
    this.cdr.markForCheck();
  }

  openAdminPhoneModal(): void {
    this.adminPhoneModalOpen = true;
    this.adminPhoneStep = 'input';
    this.adminNewPhone = '';
    this.adminOtpCode = '';
    this.adminPhoneBusy = false;
    this.adminPhoneError = null;
    this.adminResendCountdown = 0;
    if (this.adminResendTimer) {
      clearInterval(this.adminResendTimer);
      this.adminResendTimer = null;
    }
    this.cdr.markForCheck();
  }

  closeAdminPhoneModal(): void {
    if (this.adminPhoneBusy) return;
    this.adminPhoneModalOpen = false;
    if (this.adminResendTimer) {
      clearInterval(this.adminResendTimer);
      this.adminResendTimer = null;
    }
    this.cdr.markForCheck();
  }

  sendAdminPhoneOtp(): void {
    if (!this.driver?.id || !this.adminNewPhone.trim() || this.adminPhoneBusy) return;
    this.adminPhoneBusy = true;
    this.adminPhoneError = null;
    this.cdr.markForCheck();
    this.api
      .post<{ message?: string; debug_code?: string }>(
        `/admin/drivers/${this.driver.id}/phone/start`,
        { phone: this.adminNewPhone.trim() }
      )
      .subscribe({
        next: (res) => {
          this.adminPhoneBusy = false;
          this.adminPhoneStep = 'otp';
          this.startAdminResendTimer();
          this.toast.success(res.message || 'OTP sent successfully');
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.adminPhoneBusy = false;
          this.adminPhoneError =
            err?.error?.message ||
            err?.error?.errors?.phone?.[0] ||
            'Could not send OTP. Please check the phone number.';
          this.cdr.markForCheck();
        },
      });
  }

  verifyAdminPhoneOtp(): void {
    if (!this.driver?.id || !this.adminOtpCode.trim() || this.adminPhoneBusy) return;
    this.adminPhoneBusy = true;
    this.adminPhoneError = null;
    this.cdr.markForCheck();
    this.api
      .post<{ message?: string; phone: string }>(
        `/admin/drivers/${this.driver.id}/phone/verify`,
        {
          phone: this.adminNewPhone.trim(),
          code: this.adminOtpCode.trim(),
        }
      )
      .subscribe({
        next: (res) => {
          this.adminPhoneBusy = false;
          this.adminPhoneModalOpen = false;
          this.toast.success(res.message || 'Phone number updated successfully');
          if (this.driver) {
            this.driver = {
              ...this.driver,
              phone: res.phone || this.adminNewPhone.trim(),
            };
          }
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.adminPhoneBusy = false;
          this.adminPhoneError =
            err?.error?.message ||
            err?.error?.errors?.code?.[0] ||
            'Verification failed. Please check the code and try again.';
          this.cdr.markForCheck();
        },
      });
  }

  private startAdminResendTimer(): void {
    this.adminResendCountdown = 60;
    if (this.adminResendTimer) {
      clearInterval(this.adminResendTimer);
    }
    this.adminResendTimer = setInterval(() => {
      this.adminResendCountdown--;
      if (this.adminResendCountdown <= 0) {
        clearInterval(this.adminResendTimer);
        this.adminResendTimer = null;
      }
      this.cdr.markForCheck();
    }, 1000);
  }

}

export interface PendingUpload {
  id: string;
  file: File;
  /** Catalog document_id this file represents. Null until the user assigns it. */
  docId: number | null;
  status: 'queued' | 'uploading' | 'done' | 'failed';
  percent: number;
  error?: string;
}
