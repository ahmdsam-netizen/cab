import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  HostListener,
  Input,
  OnDestroy,
  OnChanges,
  Output,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../icon/icon.component';
import { acquireDocumentScrollLock } from '../document-scroll-lock';

/**
 * Reusable modal dialog.
 *
 *   <tm-modal [open]="isOpen" title="Send OTP" (closed)="isOpen = false">
 *     <ng-container slot="body">…form…</ng-container>
 *     <ng-container slot="footer">
 *       <tm-button variant="ghost" (clicked)="isOpen = false">Cancel</tm-button>
 *       <tm-button variant="green" (clicked)="submit()">Confirm</tm-button>
 *     </ng-container>
 *   </tm-modal>
 *
 * Behavior:
 *   - Backdrop is blurred (`backdrop-filter`).
 *   - On large screens the panel is centered.
 *   - On small screens (≤ 640px) the panel slides up from the bottom as a sheet
 *     with rounded top corners.
 *   - Open/close are animated; the close animation runs before unmount.
 *   - Escape and backdrop click both close (overridable via `dismissible`).
 *   - Page scroll is locked while open.
 */
@Component({
  selector: 'tm-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, IconComponent],
  template: `
    <div
      *ngIf="mounted"
      class="tm-modal"
      [class.is-closing]="closing"
      role="dialog"
      aria-modal="true"
      [attr.aria-labelledby]="title ? labelId : null"
      (click)="onBackdropClick($event)"
    >
      <div class="tm-modal__panel" (click)="$event.stopPropagation()">
        <header class="tm-modal__head" *ngIf="title || showClose">
          <h2 *ngIf="title" class="tm-modal__title" [id]="labelId">{{ title }}</h2>
          <button
            *ngIf="showClose"
            type="button"
            class="tm-modal__close"
            (click)="close()"
            aria-label="Close"
          >
            <tm-icon name="x" [size]="16" />
          </button>
        </header>

        <div class="tm-modal__body">
          <ng-content select="[slot=body]"></ng-content>
        </div>

        <footer class="tm-modal__foot">
          <ng-content select="[slot=footer]"></ng-content>
        </footer>
      </div>
    </div>
  `,
  styles: [`
    :host { display: contents; }

    .tm-modal {
      position: fixed;
      inset: 0;
      z-index: 1100;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--tm-space-4);
      background: rgba(15, 20, 25, 0.45);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      animation: tm-modal-fade-in var(--tm-duration-base) var(--tm-ease) both;
    }
    .tm-modal.is-closing {
      animation: tm-modal-fade-out var(--tm-duration-base) var(--tm-ease) both;
    }
    @keyframes tm-modal-fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @keyframes tm-modal-fade-out {
      from { opacity: 1; }
      to   { opacity: 0; }
    }

    .tm-modal__panel {
      position: relative;
      width: min(480px, 100%);
      max-height: calc(100vh - 4 * var(--tm-space-4));
      display: flex;
      flex-direction: column;
      background: var(--tm-surface);
      border-radius: var(--tm-radius-lg);
      box-shadow: var(--tm-shadow-pop);
      overflow: hidden;
      animation: tm-modal-pop-in var(--tm-duration-slow) var(--tm-ease) both;
    }
    .tm-modal.is-closing .tm-modal__panel {
      animation: tm-modal-pop-out var(--tm-duration-base) var(--tm-ease) both;
    }
    @keyframes tm-modal-pop-in {
      from { opacity: 0; transform: translateY(12px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0)    scale(1); }
    }
    @keyframes tm-modal-pop-out {
      from { opacity: 1; transform: translateY(0)    scale(1); }
      to   { opacity: 0; transform: translateY(8px)  scale(0.98); }
    }

    .tm-modal__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--tm-space-3);
      padding: var(--tm-space-5) var(--tm-space-5) var(--tm-space-3);
    }
    .tm-modal__title {
      margin: 0;
      font-size: 18px;
      font-weight: 800;
      letter-spacing: -0.01em;
      color: var(--tm-text);
    }
    .tm-modal__close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px; height: 32px;
      border-radius: 50%;
      background: var(--tm-canvas-2);
      color: var(--tm-text-muted);
      transition: background var(--tm-duration-fast) var(--tm-ease),
                  color var(--tm-duration-fast) var(--tm-ease);
    }
    .tm-modal__close:hover {
      background: var(--tm-ink);
      color: #fff;
    }

    .tm-modal__body {
      padding: 0 var(--tm-space-5) var(--tm-space-5);
      overflow-y: auto;
      font-size: 14px;
      color: var(--tm-text);
    }

    .tm-modal__foot {
      display: flex;
      justify-content: flex-end;
      gap: var(--tm-space-2);
      padding: var(--tm-space-3) var(--tm-space-5) var(--tm-space-5);
      border-top: 1px solid var(--tm-line);
    }
    .tm-modal__foot:empty {
      display: none;
    }

    /* Mobile — slide-up sheet at the bottom */
    @media (max-width: 640px) {
      .tm-modal {
        align-items: flex-end;
        padding: 0;
      }
      .tm-modal__panel {
        width: 100%;
        max-height: 90vh;
        border-radius: var(--tm-radius-xl) var(--tm-radius-xl) 0 0;
        animation: tm-modal-slide-up var(--tm-duration-slow) var(--tm-ease) both;
      }
      .tm-modal.is-closing .tm-modal__panel {
        animation: tm-modal-slide-down var(--tm-duration-base) var(--tm-ease) both;
      }
      @keyframes tm-modal-slide-up {
        from { transform: translateY(100%); }
        to   { transform: translateY(0); }
      }
      @keyframes tm-modal-slide-down {
        from { transform: translateY(0); }
        to   { transform: translateY(100%); }
      }
    }
  `],
})
export class ModalComponent implements OnChanges, OnDestroy {
  @Input() open = false;
  @Input() title?: string;
  /** Show the × close button in the header. */
  @Input() showClose = true;
  /** Click on the backdrop closes the modal. */
  @Input() dismissible = true;
  /** Lock document scroll while open. */
  @Input() lockScroll = true;

  @Output() closed = new EventEmitter<void>();

  /** DOM-mounted (true during open AND closing animation). */
  mounted = false;
  /** Currently running the closing animation. */
  closing = false;

  private static idCounter = 0;
  readonly labelId = `tm-modal-${++ModalComponent.idCounter}`;
  private releaseScrollLock?: () => void;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private cdr: ChangeDetectorRef) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['lockScroll'] && this.mounted) {
      if (this.lockScroll) this.acquireScrollLock();
      else this.unlockScroll();
    }
    if (!changes['open']) return;
    if (this.open) {
      if (this.closeTimer) clearTimeout(this.closeTimer);
      this.closeTimer = null;
      this.mounted = true;
      this.closing = false;
      if (this.lockScroll) this.acquireScrollLock();
    } else if (this.mounted) {
      this.closing = true;
      // Allow the close animation to play before unmounting.
      this.closeTimer = setTimeout(() => {
        if (this.open) return;
        this.mounted = false;
        this.closing = false;
        this.closeTimer = null;
        this.unlockScroll();
        this.cdr.markForCheck();
      }, 220);
    }
  }

  ngOnDestroy(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.unlockScroll();
  }

  private acquireScrollLock(): void {
    if (!this.releaseScrollLock) this.releaseScrollLock = acquireDocumentScrollLock();
  }

  private unlockScroll(): void {
    this.releaseScrollLock?.();
    this.releaseScrollLock = undefined;
  }

  close(): void {
    this.closed.emit();
  }

  onBackdropClick(_: MouseEvent): void {
    if (this.dismissible) this.close();
  }

  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.mounted && this.dismissible) this.close();
  }
}
