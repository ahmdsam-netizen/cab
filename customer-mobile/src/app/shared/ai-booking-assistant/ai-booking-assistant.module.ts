import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule } from '@ionic/angular';
import { AiBookingAssistantModalComponent } from './ai-booking-assistant.component';

@NgModule({
  imports: [CommonModule, FormsModule, IonicModule],
  declarations: [AiBookingAssistantModalComponent],
  exports: [AiBookingAssistantModalComponent],
})
export class AiBookingAssistantModule {}
