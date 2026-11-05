<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

#[Fillable([
    'private_service_name',
    'fixed_service_name',
    'shuttle_service_name',

    // Tipping
    'customer_tip_value_1',
    'customer_tip_value_2',
    'customer_tip_value_3',
    'corporate_tip_value_1',
    'corporate_tip_value_2',
    'corporate_tip_value_3',
    'tip_in_percentage',
    'tips_enabled',

    // Geofence / driver
    'check_destination_outside_geofence',
    'check_driver_debt',
    'update_driver_payment_modes_enabled',

    // Payment methods (global — replaces per-city allowed_driver_payment_modes)
    'payment_online_enabled',
    'payment_gpay_enabled',
    'payment_cash_enabled',
    'cash_deposit_percent',

    // Wallet
    'wallet_cash_min_capping',
    'wallet_cash_max_capping',

    // Notifications
    'notifications_sms_enabled',
    'notifications_email_enabled',
    'fixed_customer_sms_enabled',
    'fixed_customer_email_enabled',
    'fixed_driver_sms_enabled',
    'fixed_driver_email_enabled',
    'fixed_admin_sms_enabled',
    'fixed_admin_email_enabled',

    // Subscriptions
    'subscription_popup_enabled',
    'subscription_popup_title',
    'subscription_popup_desc',
    'subscription_popup_button1',
    'subscription_popup_button2',

    // Templates
    'customer_ride_accept_msg',
    'ride_cancellation_msg',
])]
class OperatorSetting extends Model
{
    use HasFactory;

    protected $casts = [
        'tip_in_percentage' => 'boolean',
        'tips_enabled' => 'boolean',
        'subscription_popup_enabled' => 'boolean',
        'check_destination_outside_geofence' => 'boolean',
        'check_driver_debt' => 'boolean',
        'update_driver_payment_modes_enabled' => 'boolean',
        'payment_online_enabled' => 'boolean',
        'payment_gpay_enabled' => 'boolean',
        'payment_cash_enabled' => 'boolean',
        'cash_deposit_percent' => 'decimal:2',
        'notifications_sms_enabled' => 'boolean',
        'notifications_email_enabled' => 'boolean',
        'fixed_customer_sms_enabled' => 'boolean',
        'fixed_customer_email_enabled' => 'boolean',
        'fixed_driver_sms_enabled' => 'boolean',
        'fixed_driver_email_enabled' => 'boolean',
        'fixed_admin_sms_enabled' => 'boolean',
        'fixed_admin_email_enabled' => 'boolean',

        'customer_tip_value_1' => 'integer',
        'customer_tip_value_2' => 'integer',
        'customer_tip_value_3' => 'integer',
        'corporate_tip_value_1' => 'integer',
        'corporate_tip_value_2' => 'integer',
        'corporate_tip_value_3' => 'integer',
        'wallet_cash_min_capping' => 'integer',
        'wallet_cash_max_capping' => 'integer',
    ];

    /**
     * Always returns the single global row, creating it if missing.
     */
    public static function instance(): self
    {
        return static::query()->firstOrCreate(['id' => 1]);
    }
}
