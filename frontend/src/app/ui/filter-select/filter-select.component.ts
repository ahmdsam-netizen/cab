import {
  Component,
  ChangeDetectorRef,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnDestroy,
  Output,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../icon/icon.component';
import { IconName } from '../icon/icon-registry';

export interface FilterOption {
  label: string;
  value: string;
}

/**
 * Shared filter dropdown used in data-table toolbars across the admin.
 *
 *   <tm-filter-select
 *     icon="shield"
 *     ariaLabel="Status filter"
 *     allLabel="All statuses"
 *     [options]="statusOptions"
 *     [(value)]="status"
 *     (valueChange)="fetch()" />
 *
 * Self-manages its open/close state: clicking the trigger closes any other
 * open instance, document-click and Escape close it. A green "has-value"
 * treatment signals an active (non-"all") selection.
 */
@Component({
  selector: 'tm-filter-select',
  standalone: true,
  imports: [CommonModule, IconComponent],
  template: `
    <div class="fs" [class.has-value]="hasValue" [class.is-open]="open" (keydown)="onMenuKey($event)">
      <button
        #trigger
        type="button"
        class="fs__trigger"
        (click)="toggle($event)"
        [attr.aria-expanded]="open"
        aria-haspopup="listbox"
        [attr.aria-label]="ariaLabel || allLabel"
        [disabled]="disabled"
      >
        <span class="fs__icon" aria-hidden="true"><tm-icon [name]="icon" [size]="14" /></span>
        <span class="fs__value">{{ currentLabel }}</span>
        <tm-icon name="chevron-down" [size]="12" class="fs__caret" />
      </button>

      <div class="fs__popup" *ngIf="open && !disabled" (click)="$event.stopPropagation()">
        <input *ngIf="searchPlaceholder" #searchInput type="search" class="fs__search"
               [placeholder]="searchPlaceholder" [attr.aria-label]="searchPlaceholder"
               [value]="query" (input)="query = searchInput.value" />
        <p class="fs__empty" *ngIf="!showAllOption && !visibleOptions.length" role="status">No matching options</p>
        <ul #menu class="fs__menu" role="listbox" [attr.aria-label]="ariaLabel || allLabel">
        <li
          *ngIf="showAllOption"
          class="fs__option"
          [class.is-selected]="value === allValue"
          role="option"
          tabindex="-1"
          [attr.aria-selected]="value === allValue"
          (mousedown)="$event.preventDefault()"
          (click)="select(allValue)"
        >
          <tm-icon *ngIf="value === allValue" name="check" [size]="12" class="fs__check" />
          <span class="fs__option-label">{{ allLabel }}</span>
        </li>
        <li
          *ngFor="let opt of visibleOptions; trackBy: trackOption"
          class="fs__option"
          [class.is-selected]="value === opt.value"
          role="option"
          tabindex="-1"
          [attr.aria-selected]="value === opt.value"
          (mousedown)="$event.preventDefault()"
          (click)="select(opt.value)"
        >
          <tm-icon *ngIf="value === opt.value" name="check" [size]="12" class="fs__check" />
          <span class="fs__option-label">{{ opt.label }}</span>
        </li>
        </ul>
      </div>
    </div>
  `,
  styles: [`
    .fs { position: relative; display: inline-block; }
    .fs__trigger {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 9px 14px;
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-md);
      background: transparent;
      font-family: var(--tm-font-body);
      font-size: 13px; font-weight: 700;
      color: var(--tm-text);
      cursor: pointer; line-height: 1.2;
      transition: border-color var(--tm-duration-fast) var(--tm-ease),
                  background var(--tm-duration-fast) var(--tm-ease);
    }
    .fs__trigger:not(:disabled):hover { border-color: var(--tm-ink); }
    .fs__trigger:disabled { opacity: .55; cursor: default; }
    .fs.is-open .fs__trigger { border-color: var(--tm-ink); }
    .fs.has-value .fs__trigger {
      background: var(--tm-green-tint);
      border-color: var(--tm-green-deep);
    }
    .fs__icon { color: var(--tm-text-muted); display: inline-flex; }
    .fs.has-value .fs__icon { color: var(--tm-green-deep); }
    .fs__value { min-width: 96px; text-align: left; }
    .fs__caret {
      color: var(--tm-text-soft);
      transition: transform var(--tm-duration-fast) var(--tm-ease);
    }
    .fs.is-open .fs__caret { transform: rotate(180deg); }
    .fs.has-value .fs__caret { color: var(--tm-green-deep); }

    .fs__popup {
      position: absolute; top: calc(100% + 6px); left: 0; right: 0;
      min-width: min(180px, 100%); padding: 6px;
      background: var(--tm-surface);
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-md);
      box-shadow: var(--tm-shadow-pop);
      z-index: 1100;
      animation: fs-in 140ms var(--tm-ease) both;
    }
    .fs__menu { max-height: min(240px, 38dvh); overflow-y: auto; list-style: none; margin: 0; padding: 0; }
    .fs__search {
      box-sizing: border-box; width: 100%; margin-bottom: 4px; padding: 7px 9px;
      font: inherit; font-size: 12px; color: var(--tm-text); background: var(--tm-surface);
      border: 1px solid var(--tm-line-2); border-radius: var(--tm-radius-sm);
    }
    .fs__empty { margin: 4px 8px; color: var(--tm-text-muted); font-size: 12px; }
    @keyframes fs-in {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .fs__option {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; border-radius: var(--tm-radius-sm);
      font-size: 12px; font-weight: 600; color: var(--tm-text);
      cursor: pointer;
      transition: background var(--tm-duration-fast) var(--tm-ease),
                  color var(--tm-duration-fast) var(--tm-ease);
    }
    .fs__option:hover, .fs__option:focus-visible { background: var(--tm-canvas-2); }
    .fs__option.is-selected {
      background: var(--tm-green-tint);
      color: var(--tm-green-deep);
      font-weight: 700;
    }
    .fs__check { color: var(--tm-green-deep); flex-shrink: 0; }
    .fs__option-label { flex: 1; }
  `],
})
export class FilterSelectComponent implements OnDestroy {
  private static openInstances = new Set<FilterSelectComponent>();

  @Input() icon: IconName = 'filter';
  @Input() options: FilterOption[] = [];
  @Input() value = 'all';
  @Input() allLabel = 'All';
  @Input() allValue = 'all';
  @Input() includeAll = true;
  @Input() ariaLabel = '';
  @Input() disabled = false;
  @Input() searchPlaceholder = '';

  @Output() valueChange = new EventEmitter<string>();
  @ViewChild('trigger', { static: true }) private trigger!: ElementRef<HTMLButtonElement>;
  @ViewChild('menu') private menu?: ElementRef<HTMLUListElement>;
  @ViewChild('searchInput') private searchInput?: ElementRef<HTMLInputElement>;

  open = false;
  query = '';

  constructor(private readonly cdr: ChangeDetectorRef, private readonly host: ElementRef<HTMLElement>) {}

  get hasValue(): boolean {
    return this.value !== this.allValue;
  }

  get currentLabel(): string {
    if (this.value === this.allValue) return this.allLabel;
    return this.options.find((o) => o.value === this.value)?.label ?? this.allLabel;
  }

  get showAllOption(): boolean {
    return this.includeAll && !this.query.trim();
  }

  get visibleOptions(): FilterOption[] {
    const query = this.query.trim().toLocaleLowerCase();
    return query ? this.options.filter(option => option.label.toLocaleLowerCase().includes(query)) : this.options;
  }

  trackOption(_: number, option: FilterOption): string {
    return option.value;
  }

  toggle(e: MouseEvent): void {
    e.stopPropagation();
    if (this.open) {
      this.close();
      return;
    }
    this.openMenu();
    if (this.searchPlaceholder) {
      this.cdr.detectChanges();
      this.searchInput?.nativeElement.focus({ preventScroll: true });
    }
  }

  private openMenu(): void {
    FilterSelectComponent.openInstances.forEach((i) => i.close());
    this.open = true;
    FilterSelectComponent.openInstances.add(this);
  }

  select(v: string): void {
    this.trigger.nativeElement.focus();
    this.close();
    if (v === this.value) return;
    this.value = v;
    this.valueChange.emit(v);
  }

  close(): void {
    this.open = false;
    this.query = '';
    FilterSelectComponent.openInstances.delete(this);
  }

  onMenuKey(event: KeyboardEvent): void {
    if (this.disabled || !['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    const target = event.target as HTMLElement;
    if (target === this.searchInput?.nativeElement) {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (this.visibleOptions.length === 1) this.select(this.visibleOptions[0].value);
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    }
    const isActivation = event.key === 'Enter' || event.key === ' ';
    if (isActivation) {
      if (target.getAttribute('role') === 'option') {
        event.preventDefault();
        target.click();
      }
      return;
    }

    event.preventDefault();
    if (!this.open) {
      this.openMenu();
      this.cdr.detectChanges();
    }
    const options = Array.from(this.menu?.nativeElement.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    const current = options.findIndex(option => option === event.target);
    const last = options.length - 1;
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? last :
      event.key === 'ArrowDown' ? Math.min(current + 1, last) : current < 0 ? last : Math.max(current - 1, 0);
    options[index]?.focus();
  }

  ngOnDestroy(): void {
    this.close();
  }

  @HostListener('document:click') onDocClick(): void {
    this.close();
  }

  @HostListener('focusout', ['$event']) onFocusOut(event: FocusEvent): void {
    if (!this.host.nativeElement.contains(event.relatedTarget as Node | null)) this.close();
  }

  @HostListener('document:keydown.escape') onEsc(): void {
    if (this.open && this.host.nativeElement.contains(this.host.nativeElement.ownerDocument.activeElement)) {
      this.trigger.nativeElement.focus();
    }
    this.close();
  }
}
