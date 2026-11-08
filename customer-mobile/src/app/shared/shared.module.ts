import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { RouterModule } from '@angular/router';
import { SideMenuComponent } from './side-menu/side-menu.component';
import { AiBookingAssistantModule } from './ai-booking-assistant/ai-booking-assistant.module';

@NgModule({
  declarations: [SideMenuComponent],
  imports: [CommonModule, IonicModule, RouterModule, AiBookingAssistantModule],
  exports: [SideMenuComponent],
})
export class SharedModule {}
