import { Component, DestroyRef, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { ButtonComponent, ModalComponent } from '../../ui';
import { MasterGroup } from './master-explorer.component';

@Component({
  selector: 'app-stand-rename', standalone: true,
  imports: [CommonModule, FormsModule, ButtonComponent, ModalComponent],
  template: `
    <tm-modal [open]="true" title="Rename stand" [dismissible]="!saving" [showClose]="!saving" (closed)="close()">
      <form slot="body" id="rename-stand-form" (ngSubmit)="save()">
        <label for="rename-stand-name">Stand name</label>
        <input id="rename-stand-name" name="standName" [(ngModel)]="name" maxlength="120" required
          [disabled]="saving" [attr.aria-invalid]="error ? true : null" aria-describedby="rename-stand-error" />
        <p id="rename-stand-error" role="alert" *ngIf="error">{{ error }}</p>
      </form>
      <div slot="footer" class="actions">
        <tm-button variant="ghost" [disabled]="saving" (clicked)="close()">Cancel</tm-button>
        <tm-button variant="green" [disabled]="saving || !changed" (clicked)="save()">{{ saving ? 'Saving…' : 'Save' }}</tm-button>
      </div>
    </tm-modal>
  `,
  styles: [`
    label { display: block; margin-bottom: 8px; font-weight: 700; }
    input { box-sizing: border-box; width: 100%; padding: 11px 13px; border: 1px solid var(--tm-line); border-radius: 8px; background: var(--tm-surface); color: var(--tm-text); font: inherit; }
    p { margin-bottom: 0; color: var(--tm-danger-fg); }
    .actions { display: flex; justify-content: flex-end; gap: 8px; width: 100%; }
  `],
})
export class StandRenameComponent implements OnInit {
  @Input() cityId!: number;
  @Input() group!: MasterGroup;
  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<{ id: number; name: string }>();
  name = '';
  saving = false;
  error = '';
  constructor(private api: ApiService, private toast: ToastService, private destroyRef: DestroyRef) {}
  ngOnInit(): void { this.name = this.group.name; }
  get changed(): boolean { return this.name.trim() !== this.group.name; }
  close(): void { if (!this.saving) this.closed.emit(); }
  save(): void {
    if (this.saving) return;
    const name = this.name.trim();
    if (!name) { this.error = 'Enter a stand name.'; return; }
    if (name.length > 120) { this.error = 'Stand name must be 120 characters or fewer.'; return; }
    if (!this.changed) return;
    this.saving = true; this.error = '';
    this.api.patch<{ route_group: { name: string } }>(`/admin/cities/${this.cityId}/route-groups/${this.group.id}`, { name }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: result => {
        this.saving = false;
        this.saved.emit({ id: this.group.id, name: result.route_group.name });
        this.toast.success('Stand renamed'); this.closed.emit();
      },
      error: err => {
        this.saving = false;
        this.error = err?.status === 422 && err?.error?.errors?.name
          ? 'Enter a unique stand name, up to 120 characters, for this city.'
          : err?.error?.message || 'Could not rename stand. Try again.';
      },
    });
  }
}
