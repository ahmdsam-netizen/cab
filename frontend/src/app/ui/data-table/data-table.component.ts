import {
  AfterContentInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ContentChildren,
  EventEmitter,
  Input,
  Output,
  QueryList,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../icon/icon.component';
import { ColumnComponent } from './column.component';

/**
 * Reusable data table.
 *
 *   <tm-data-table
 *     [rows]="rows"
 *     [total]="total"
 *     [page]="page"
 *     [pageSize]="pageSize"
 *     [loading]="loading"
 *     (pageChange)="onPage($event)"
 *     (pageSizeChange)="onPageSize($event)">
 *
 *     <tm-input slot="search" icon="search" placeholder="..." [(ngModel)]="q" />
 *
 *     <ng-container slot="filters">
 *       <tm-button variant="outline" size="sm">All</tm-button>
 *       <tm-button variant="ink" size="sm">With Docs</tm-button>
 *     </ng-container>
 *
 *     <tm-column key="id" label="ID" width="100">
 *       <ng-template let-row>#{{ row.id }}</ng-template>
 *     </tm-column>
 *
 *     ...
 *
 *     <ng-container slot="empty">
 *       <tm-icon name="users" [size]="28" /> No customers
 *     </ng-container>
 *   </tm-data-table>
 *
 * Toolbar layout: search on the left, filters on the right.
 * Footer: page-size selector on the left, paginator on the right.
 * Loading + empty state are handled internally with sensible defaults.
 */
@Component({
  selector: 'tm-data-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, IconComponent],
  template: `
    <div class="tm-dt">
      <!-- ============ Toolbar ============ -->
      <div class="tm-dt__toolbar" *ngIf="showToolbar">
        <div class="tm-dt__toolbar-left">
          <ng-content select="[slot=search]"></ng-content>
        </div>
        <div class="tm-dt__toolbar-right">
          <ng-content select="[slot=filters]"></ng-content>
        </div>
      </div>

      <!-- ============ Banner (active filters, etc.) ============ -->
      <div class="tm-dt__banner">
        <ng-content select="[slot=banner]"></ng-content>
      </div>

      <!-- ============ Table ============ -->
      <div class="tm-dt__wrap">
        <table class="tm-dt__table" [attr.aria-busy]="loading ? 'true' : null">
          <thead>
            <tr>
              <th
                *ngFor="let c of columns; trackBy: trackByKey"
                [style.width]="c.width"
                [style.text-align]="c.align"
              >
                {{ c.label }}
              </th>
            </tr>
          </thead>

          <tbody>
            <!-- Skeleton rows during loading -->
            <ng-container *ngIf="loading">
              <tr class="tm-dt__skeleton-row" *ngFor="let _ of skeletonRows">
                <td *ngFor="let c of columns">
                  <span class="tm-dt__skeleton"></span>
                </td>
              </tr>
            </ng-container>

            <!-- Data rows -->
            <ng-container *ngIf="!loading">
              <tr
                *ngFor="let row of rows; let i = index; trackBy: trackRow"
                class="tm-dt__row"
                [class.is-clickable]="rowClick.observed"
                (click)="onRowClick(row)"
              >
                <td
                  *ngFor="let c of columns; trackBy: trackByKey"
                  [style.text-align]="c.align"
                  [class.is-wrap]="c.wrap"
                >
                  <ng-container *ngIf="c.template; else fallback">
                    <ng-container
                      *ngTemplateOutlet="c.template; context: { $implicit: row, col: c, index: i }"
                    ></ng-container>
                  </ng-container>
                  <ng-template #fallback>
                    {{ row[c.key] !== undefined && row[c.key] !== null && row[c.key] !== '' ? row[c.key] : '—' }}
                  </ng-template>
                </td>
              </tr>

              <!-- Empty state -->
              <tr *ngIf="!rows?.length">
                <td [attr.colspan]="columns.length" class="tm-dt__empty-cell">
                  <div class="tm-dt__empty">
                    <!-- Custom slot — the CSS rule .tm-dt__empty-custom:not(:empty) + .tm-dt__empty-default hides this fallback when content is projected. -->
                    <div class="tm-dt__empty-custom">
                      <ng-content select="[slot=empty]"></ng-content>
                    </div>
                    <div class="tm-dt__empty-default">
                      <div class="tm-dt__empty-icon">
                        <tm-icon name="search" [size]="22" />
                      </div>
                      <div class="tm-dt__empty-title">{{ emptyTitle }}</div>
                      <div class="tm-dt__empty-hint">{{ emptyHint }}</div>
                    </div>
                  </div>
                </td>
              </tr>
            </ng-container>
          </tbody>
        </table>
      </div>

      <!-- ============ Footer ============ -->
      <div class="tm-dt__footer">
        <!-- Left: page size + total -->
        <div class="tm-dt__footer-left">
          <label class="tm-dt__size">
            <span class="tm-dt__size-lbl">Rows per page</span>
            <span class="tm-dt__size-control">
              <select
                class="tm-dt__select"
                [ngModel]="pageSize"
                (ngModelChange)="onPageSizeChange($event)"
                [disabled]="loading"
                aria-label="Rows per page"
              >
                <option *ngFor="let s of pageSizes" [ngValue]="s">{{ s }}</option>
              </select>
              <tm-icon name="chevron-down" [size]="12" class="tm-dt__size-caret" />
            </span>
          </label>
          <span class="tm-dt__range">
            <strong>{{ rangeStart }}</strong>–<strong>{{ rangeEnd }}</strong>
            of <strong>{{ total | number }}</strong>
          </span>
        </div>

        <!-- Right: paginator -->
        <div class="tm-dt__footer-right">
          <button
            type="button"
            class="tm-dt__pg-btn"
            (click)="goto(1)"
            [disabled]="page <= 1 || loading"
            aria-label="First page"
            title="First page"
          >
            <tm-icon name="chevron-left" [size]="14" />
            <tm-icon name="chevron-left" [size]="14" />
          </button>
          <button
            type="button"
            class="tm-dt__pg-btn"
            (click)="goto(page - 1)"
            [disabled]="page <= 1 || loading"
            aria-label="Previous page"
          >
            <tm-icon name="chevron-left" [size]="14" />
          </button>

          <span class="tm-dt__pg-pages">
            <button
              *ngFor="let p of pageWindow; trackBy: trackByPage"
              type="button"
              class="tm-dt__pg-num"
              [class.is-active]="p === page"
              [class.is-ellipsis]="p === -1"
              [disabled]="p === -1 || loading"
              (click)="p !== -1 && goto(p)"
            >
              {{ p === -1 ? '…' : p }}
            </button>
          </span>

          <button
            type="button"
            class="tm-dt__pg-btn"
            (click)="goto(page + 1)"
            [disabled]="page >= totalPages || loading"
            aria-label="Next page"
          >
            <tm-icon name="chevron-right" [size]="14" />
          </button>
          <button
            type="button"
            class="tm-dt__pg-btn"
            (click)="goto(totalPages)"
            [disabled]="page >= totalPages || loading"
            aria-label="Last page"
            title="Last page"
          >
            <tm-icon name="chevron-right" [size]="14" />
            <tm-icon name="chevron-right" [size]="14" />
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }

    /* ============ Surface ============ */
    .tm-dt {
      background: var(--tm-surface);
      border: 1px solid var(--tm-line);
      border-radius: var(--tm-radius-lg);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .tm-dt:has(.tm-dt__toolbar tm-filter-select button[aria-expanded="true"]) {
      overflow: visible;
    }

    /* ============ Toolbar ============ */
    .tm-dt__toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--tm-space-4);
      padding: var(--tm-space-4) var(--tm-space-5);
      border-bottom: 1px solid var(--tm-line);
      flex-wrap: wrap;
    }
    .tm-dt__toolbar-left {
      flex: 1 1 280px;
      min-width: 240px;
      max-width: 380px;
      display: flex;
      align-items: center;
    }
    .tm-dt__toolbar-right {
      display: flex;
      gap: var(--tm-space-2);
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    /* ============ Banner ============ */
    .tm-dt__banner:empty { display: none; }
    .tm-dt__banner {
      padding: var(--tm-space-3) var(--tm-space-5);
      border-bottom: 1px solid var(--tm-line);
      display: flex;
      align-items: center;
      gap: var(--tm-space-2);
      flex-wrap: wrap;
      background: var(--tm-canvas);
    }

    /* ============ Table ============ */
    .tm-dt__wrap {
      overflow-x: auto;
      flex: 1;
      min-height: 0;
    }
    .tm-dt__table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 13px;
    }
    .tm-dt__table th,
    .tm-dt__table td {
      padding: var(--tm-dt-cell-padding, 12px 16px);
      vertical-align: middle;
      text-align: left;
    }
    .tm-dt__table thead th {
      font-family: var(--tm-font-body);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--tm-text-muted);
      background: var(--tm-canvas);
      border-bottom: 1px solid var(--tm-line);
      white-space: nowrap;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .tm-dt__row {
      transition: background var(--tm-duration-fast) var(--tm-ease);
    }
    .tm-dt__row td {
      border-bottom: 1px solid var(--tm-line);
      color: var(--tm-text);
      font-weight: 500;
    }
    .tm-dt__row:last-child td {
      border-bottom: 0;
    }
    .tm-dt__row:hover {
      background: var(--tm-canvas);
    }
    .tm-dt__row.is-clickable { cursor: pointer; }

    .tm-dt__table td:not(.is-wrap) {
      max-width: 320px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tm-dt__table td.is-wrap { white-space: normal; }

    /* ============ Skeleton ============ */
    .tm-dt__skeleton-row td { border-bottom: 1px solid var(--tm-line); }
    .tm-dt__skeleton {
      display: block;
      height: 12px;
      width: 70%;
      background: linear-gradient(
        90deg,
        var(--tm-canvas) 0%,
        var(--tm-canvas-2) 50%,
        var(--tm-canvas) 100%
      );
      background-size: 200% 100%;
      border-radius: 6px;
      animation: tm-dt-shimmer 1.2s linear infinite;
    }
    @keyframes tm-dt-shimmer {
      0% { background-position: 100% 0; }
      100% { background-position: -100% 0; }
    }

    /* ============ Empty state ============ */
    .tm-dt__empty-cell {
      padding: var(--tm-space-10) var(--tm-space-4) !important;
      border-bottom: 0 !important;
    }
    .tm-dt__empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--tm-space-2);
      text-align: center;
    }
    .tm-dt__empty-default {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--tm-space-2);
    }
    /* Hide the default fallback when the consumer provided custom empty content. */
    .tm-dt__empty-custom:not(:empty) + .tm-dt__empty-default { display: none; }
    .tm-dt__empty-icon {
      width: 56px; height: 56px;
      border-radius: var(--tm-radius-lg);
      background: var(--tm-canvas-2);
      color: var(--tm-text-muted);
      display: grid; place-items: center;
      margin-bottom: var(--tm-space-1);
    }
    .tm-dt__empty-title {
      font-size: 15px;
      font-weight: 800;
      letter-spacing: -0.01em;
      color: var(--tm-text);
    }
    .tm-dt__empty-hint {
      font-size: 12px;
      font-weight: 500;
      color: var(--tm-text-muted);
      max-width: 36ch;
    }

    /* ============ Footer ============ */
    .tm-dt__footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--tm-space-3);
      padding: var(--tm-space-3) var(--tm-space-5);
      border-top: 1px solid var(--tm-line);
      background: var(--tm-surface);
      flex-wrap: wrap;
    }
    .tm-dt__footer-left,
    .tm-dt__footer-right {
      display: flex;
      align-items: center;
      gap: var(--tm-space-3);
      flex-wrap: wrap;
    }

    .tm-dt__size {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .tm-dt__size-lbl {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--tm-text-muted);
    }
    .tm-dt__size-control {
      position: relative;
      display: inline-flex;
      align-items: center;
    }
    .tm-dt__select {
      appearance: none;
      -webkit-appearance: none;
      padding: 6px 26px 6px 10px;
      border-radius: var(--tm-radius-sm);
      border: 1px solid var(--tm-line-2);
      background: var(--tm-surface);
      font-family: inherit;
      font-size: 12px;
      font-weight: 700;
      font-family: var(--tm-font-mono);
      color: var(--tm-text);
      cursor: pointer;
      transition: border-color var(--tm-duration-fast) var(--tm-ease);
    }
    .tm-dt__select:hover:not(:disabled) { border-color: var(--tm-text-soft); }
    .tm-dt__select:focus { outline: none; border-color: var(--tm-ink); }
    .tm-dt__select:disabled { opacity: 0.6; cursor: not-allowed; }
    .tm-dt__size-caret {
      position: absolute;
      right: 8px;
      pointer-events: none;
      color: var(--tm-text-soft);
    }

    .tm-dt__range {
      font-size: 12px;
      font-weight: 600;
      color: var(--tm-text-muted);
      font-family: var(--tm-font-mono);
    }
    .tm-dt__range strong {
      color: var(--tm-text);
      font-weight: 700;
    }

    /* ============ Paginator ============ */
    .tm-dt__pg-btn,
    .tm-dt__pg-num {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 32px;
      height: 32px;
      padding: 0 8px;
      border-radius: var(--tm-radius-sm);
      background: var(--tm-surface);
      border: 1px solid var(--tm-line-2);
      color: var(--tm-text);
      font-family: var(--tm-font-mono);
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      transition: background var(--tm-duration-fast) var(--tm-ease),
                  color var(--tm-duration-fast) var(--tm-ease),
                  border-color var(--tm-duration-fast) var(--tm-ease);
    }
    .tm-dt__pg-btn { gap: 2px; padding: 0 6px; }
    .tm-dt__pg-btn:hover:not(:disabled),
    .tm-dt__pg-num:hover:not(:disabled):not(.is-active) {
      background: var(--tm-canvas-2);
      border-color: var(--tm-text-soft);
    }
    .tm-dt__pg-btn:disabled,
    .tm-dt__pg-num:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .tm-dt__pg-pages {
      display: inline-flex;
      gap: 4px;
      margin: 0 4px;
    }
    .tm-dt__pg-num.is-active {
      background: var(--tm-ink);
      color: #fff;
      border-color: var(--tm-ink);
    }
    .tm-dt__pg-num.is-ellipsis {
      border-color: transparent;
      background: transparent;
      cursor: default;
      opacity: 0.6;
    }

    /* ============ Responsive ============ */
    @media (max-width: 720px) {
      .tm-dt__toolbar {
        padding: var(--tm-space-3);
      }
      .tm-dt__toolbar-left {
        flex: 1 1 100%;
        max-width: 100%;
      }
      .tm-dt__toolbar-right {
        flex: 1 1 100%;
        justify-content: flex-start;
      }
      .tm-dt__table th,
      .tm-dt__table td {
        padding: var(--tm-dt-cell-padding, 10px 12px);
      }
      .tm-dt__footer {
        padding: var(--tm-space-3);
        flex-direction: column;
        align-items: stretch;
      }
      .tm-dt__footer-left,
      .tm-dt__footer-right {
        justify-content: space-between;
        width: 100%;
      }
      .tm-dt__pg-pages { flex: 1; justify-content: center; }
    }
  `],
})
export class DataTableComponent implements AfterContentInit {
  @Input() rows: any[] = [];
  @Input() total = 0;
  @Input() page = 1;
  @Input() pageSize = 25;
  @Input() pageSizes: number[] = [10, 25, 50, 100];
  @Input() loading = false;
  @Input() showToolbar = true;
  @Input() emptyTitle = 'No results';
  @Input() emptyHint = 'Try adjusting your search or filters.';
  @Input() rowTrackBy?: (row: any, i: number) => any;

  @Output() pageChange = new EventEmitter<number>();
  @Output() pageSizeChange = new EventEmitter<number>();
  @Output() rowClick = new EventEmitter<any>();

  @ContentChildren(ColumnComponent) columnList!: QueryList<ColumnComponent>;

  columns: ColumnComponent[] = [];

  constructor(private cdr: ChangeDetectorRef) {}

  ngAfterContentInit(): void {
    this.columns = this.columnList?.toArray() ?? [];
    this.columnList?.changes.subscribe(() => {
      this.columns = this.columnList.toArray();
      this.cdr.markForCheck();
    });
  }

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.total / Math.max(1, this.pageSize)));
  }

  get rangeStart(): number {
    if (!this.total) return 0;
    return (this.page - 1) * this.pageSize + 1;
  }

  get rangeEnd(): number {
    return Math.min(this.total, this.page * this.pageSize);
  }

  /**
   * Build the page-number window: always show first + last, the current
   * page, two neighbors, and gaps with -1 sentinels (rendered as "…").
   */
  get pageWindow(): number[] {
    const total = this.totalPages;
    const cur = this.page;
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

    const pages = new Set<number>([1, total, cur, cur - 1, cur + 1]);
    if (cur <= 3) [2, 3, 4].forEach((n) => pages.add(n));
    if (cur >= total - 2) [total - 1, total - 2, total - 3].forEach((n) => pages.add(n));

    const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
    const result: number[] = [];
    sorted.forEach((p, idx) => {
      if (idx > 0 && p - sorted[idx - 1] > 1) result.push(-1);
      result.push(p);
    });
    return result;
  }

  get skeletonRows(): number[] {
    const count = Math.min(this.pageSize, 6);
    return Array.from({ length: count }, (_, i) => i);
  }

  goto(p: number): void {
    const clamped = Math.max(1, Math.min(this.totalPages, p));
    if (clamped !== this.page) {
      this.pageChange.emit(clamped);
    }
  }

  onPageSizeChange(size: number): void {
    if (size !== this.pageSize) {
      this.pageSizeChange.emit(size);
    }
  }

  onRowClick(row: any): void {
    if (this.rowClick.observed) this.rowClick.emit(row);
  }

  trackByKey = (_: number, c: ColumnComponent) => c.key;
  trackByPage = (_: number, p: number) => p;
  trackRow = (i: number, row: any) => (this.rowTrackBy ? this.rowTrackBy(row, i) : (row?.id ?? i));
}
