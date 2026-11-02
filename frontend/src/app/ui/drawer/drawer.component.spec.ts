import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { DrawerComponent } from './drawer.component';

@Component({
  standalone: true,
  imports: [CommonModule, DrawerComponent],
  template: `
    <tm-drawer *ngIf="first" [open]="true" title="First"><div slot="body">First</div></tm-drawer>
    <tm-drawer *ngIf="second" [open]="true" title="Second"><div slot="body">Second</div></tm-drawer>
  `,
})
class DrawerHostComponent {
  first = true;
  second = false;
}

describe('Drawer document scroll lock', () => {
  let originalOverflow: string;

  beforeEach(() => {
    originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'auto';
  });

  afterEach(() => {
    document.body.style.overflow = originalOverflow;
  });

  it('restores page scrolling when an open drawer is destroyed without closing', () => {
    const fixture = TestBed.createComponent(DrawerHostComponent);
    fixture.detectChanges();
    expect(document.body.style.overflow).toBe('hidden');

    fixture.componentInstance.first = false;
    fixture.detectChanges();

    expect(document.body.style.overflow).toBe('auto');
    fixture.destroy();
  });

  it('keeps scrolling locked until every open drawer is destroyed', () => {
    const fixture = TestBed.createComponent(DrawerHostComponent);
    fixture.detectChanges();
    fixture.componentInstance.second = true;
    fixture.detectChanges();

    fixture.componentInstance.first = false;
    fixture.detectChanges();
    expect(document.body.style.overflow).toBe('hidden');

    fixture.componentInstance.second = false;
    fixture.detectChanges();
    expect(document.body.style.overflow).toBe('auto');
    fixture.destroy();
  });
});
