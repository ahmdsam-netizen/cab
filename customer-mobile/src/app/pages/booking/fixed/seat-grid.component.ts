import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';

/**
 * The seat map, drawn as a top-view of the vehicle — a rounded hood with
 * headlights, the driver (🚗) in front, then the passenger seats.
 *
 * This is a port of the admin's `app-seat-grid` (frontend), on purpose: an
 * operator designs a layout there and the passenger should see the SAME car,
 * seat for seat. The only thing added for the passenger is booking status —
 * a seat someone already took reads as taken, a free one is tappable, and the
 * rider's own choice turns green.
 */
export interface SeatCell {
  row: number;
  col: number;
  kind: 'seat' | 'blocked' | 'aisle';
  label: string | null;
  category?: string | null;
  price_delta: number;
  status?: 'AVAILABLE' | 'HELD' | 'BOOKED' | 'BLOCKED' | 'AISLE';
}

@Component({
  selector: 'app-seat-grid',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, IonicModule],
  template: `
    <!-- Car body (top view): rounded hood + headlights, like the admin designer. -->
    <div class="body body--frame" [class.body--compact]="compact">
      <div class="hood" *ngIf="!compact">
        <span class="hood__light"></span>
        <span class="hood__glass"></span>
        <span class="hood__light"></span>
      </div>

      <div class="grid" [style.grid-template-columns]="'repeat(' + cols + ', minmax(42px, 1fr))'">
        <ng-container *ngFor="let r of rowRange">
          <ng-container *ngFor="let c of colRange">
            <ng-container *ngIf="cellAt(r, c) as cell; else empty">
              <button
                type="button"
                class="cell"
                [class.cell--seat]="cell.kind === 'seat' && !isTaken(cell)"
                [class.cell--taken]="cell.kind === 'seat' && isTaken(cell)"
                [class.cell--held]="cell.status === 'HELD' && !isSelected(cell.label)"
                [class.cell--blocked]="cell.kind === 'blocked' && !isDriver(cell)"
                [class.cell--driver]="isDriver(cell)"
                [class.cell--aisle]="cell.kind === 'aisle'"
                [class.cell--selected]="cell.kind === 'seat' && isSelected(cell.label)"
                [attr.data-cat]="cell.category || null"
                [attr.aria-label]="ariaFor(cell)"
                [disabled]="!isPickable(cell)"
                (click)="pickCell(cell)"
              >
                <span class="cell__lbl" *ngIf="cell.kind === 'seat'">{{ cell.label || '?' }}</span>
                <ion-icon class="cell__wheel" *ngIf="isDriver(cell)" name="person-outline" aria-hidden="true"></ion-icon>
                <span class="cell__delta" *ngIf="cell.kind === 'seat' && cell.price_delta">
                  {{ (cell.price_delta > 0 ? '+' : '') }}₹{{ cell.price_delta }}
                </span>
              </button>
            </ng-container>
            <ng-template #empty>
              <span class="cell cell--empty"></span>
            </ng-template>
          </ng-container>
        </ng-container>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }

    /* Vehicle body (top view) — rounded hood at the front + headlights. */
    .body--frame {
      display: inline-block;
      padding: 16px 18px 20px;
      border: 2px solid var(--dc-hairline-strong);
      border-radius: 54px 54px 22px 22px;
      background: linear-gradient(var(--dc-surface-2), var(--dc-canvas));
      box-shadow: inset 0 2px 10px rgba(13, 27, 42, 0.05);
    }
    .hood { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; padding: 0 4px; }
    .hood__light { width: 15px; height: 9px; border-radius: 7px; background: #fde68a; border: 1px solid #f2c94c; box-shadow: 0 0 7px rgba(250, 204, 21, .7); flex: none; }
    .hood__glass { flex: 1; height: 11px; border-radius: 9px; background: linear-gradient(#dbeafe, #bfdbfe); border: 1px solid #bcd3f2; }

    .grid { display: grid; gap: 7px; }
    .cell {
      position: relative; border: 1px solid #d7dde3; background: #fff; border-radius: 10px;
      aspect-ratio: 1 / 1; min-height: 46px;
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 13px; color: var(--dc-ink);
      cursor: default;
    }

    /* Available seat — coloured by category, exactly like the admin preview. */
    .cell--seat { background: #eefaf2; border-color: #b7e8ca; color: #0e7a3d; cursor: pointer; }
    .cell--seat[data-cat="premium"] { background: #fff4e1; border-color: #f4c876; color: #a05a00; }
    .cell--seat[data-cat="front"]   { background: #eaf2ff; border-color: #b6cff5; color: #244d99; }
    .cell--seat[data-cat="window"]  { background: #e6f8f5; border-color: #a7dfd3; color: #0f6d5a; }
    .cell--seat[data-cat="rear"]    { background: #f2eaf8; border-color: #ccb1e2; color: #593591; }
    .cell--seat:active { transform: translateY(1px); }

    /* Already taken by someone — hatched, muted, not tappable. This is the
       passenger-facing addition the admin grid doesn't need. */
    .cell--taken {
      background: repeating-linear-gradient(45deg, #eef1f4, #eef1f4 5px, #e2e7ec 5px, #e2e7ec 10px);
      border-color: #d3d8de; color: #9099a1;
    }

    .cell--blocked { background: repeating-linear-gradient(45deg, #f3f5f7, #f3f5f7 6px, #e7ebef 6px, #e7ebef 12px); border-color: #d3d8de; color: #9099a1; }
    .cell--driver { background: var(--dc-surface-2); border-color: #c3ccd6; color: #47536a; }
    .cell--driver .cell__wheel { font-size: 19px; }
    .cell--aisle { background: transparent; border: none; }
    .cell--empty { background: transparent; border: none; box-shadow: none; }

    /* The rider's own pick. */
    .cell--selected { background: var(--dc-green) !important; border-color: #0e7a3d !important; color: #fff !important; box-shadow: 0 4px 12px rgba(18, 179, 91, .35); }

    .cell__delta { position: absolute; bottom: 3px; right: 4px; font-size: 9px; font-weight: 700; opacity: .8; }
    .body--compact { border: 1px solid #e0e5ed; border-radius: 22px; padding: 14px; background: #fff; box-shadow: none; }
    .body--compact .cell--seat:not(.cell--selected) { background: #f6f8fa; border-color: #e0e5ed; color: #172033; }
    .body--compact .cell--driver { background: transparent; border-color: transparent; color: #64748b; }
    .body--compact .cell--selected { background: #087f50 !important; box-shadow: none; }
    .cell--held { background: repeating-linear-gradient(45deg, #fff8e7, #fff8e7 5px, #faedcc 5px, #faedcc 10px); border-color: #d7b45b; border-style: dashed; color: #896a22; }
    .cell:focus-visible { outline: 2px solid #087f50; outline-offset: 2px; }
  `],
})
export class SeatGridComponent {
  @Input() compact = false;
  @Input() cols = 1;
  @Input() rows = 1;
  @Input() cells: SeatCell[] = [];
  @Input() selectedLabels: string[] = [];

  /** Emits the seat label when a free seat is tapped. */
  @Output() pick = new EventEmitter<string>();

  get rowRange(): number[] {
    return Array.from({ length: Math.max(1, this.rows) }, (_, i) => i + 1);
  }
  get colRange(): number[] {
    return Array.from({ length: Math.max(1, this.cols) }, (_, i) => i + 1);
  }

  cellAt(row: number, col: number): SeatCell | undefined {
    return this.cells.find((c) => c.row === row && c.col === col);
  }

  isSelected(label?: string | null): boolean {
    return !!label && this.selectedLabels.includes(label);
  }

  /** A blocked cell labelled "D" is the driver, drawn with a 🚗. */
  isDriver(cell: SeatCell): boolean {
    return cell.kind === 'blocked' && (cell.label || '').trim().toUpperCase() === 'D';
  }

  isTaken(cell: SeatCell): boolean {
    return cell.kind === 'seat' && cell.status !== 'AVAILABLE' && !this.isSelected(cell.label);
  }

  /** Only a free seat can be tapped. */
  isPickable(cell: SeatCell): boolean {
    return cell.kind === 'seat' && (cell.status === 'AVAILABLE' || this.isSelected(cell.label));
  }

  pickCell(cell: SeatCell): void {
    if (cell.kind === 'seat' && cell.label && this.isPickable(cell)) {
      this.pick.emit(cell.label);
    }
  }

  ariaFor(cell: SeatCell): string | null {
    if (this.isDriver(cell)) return 'Driver';
    if (cell.kind !== 'seat') return null;
    if (this.isSelected(cell.label)) return `Seat ${cell.label}, selected`;
    if (cell.status === 'HELD') return `Seat ${cell.label}, held`;
    if (this.isTaken(cell)) return `Seat ${cell.label}, taken`;
    return `Seat ${cell.label}, free`;
  }
}
