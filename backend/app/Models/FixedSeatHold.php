<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

#[Fillable([
    'route_departure_id',
    'customer_id',
    'board_stop_id',
    'drop_stop_id',
    'seats',
    'payment_method',
    'amount',
    'original_amount',
    'discount_amount',
    'tip_amount',
    'coupon_assignment_id',
    'has_extra_luggage',
    'extra_luggage_count',
    'luggage_surcharge_amount',
    'status',
    'approved_driver_id',
    'expires_at',
    'payment_reference',
    'razorpay_order_id',
    'razorpay_payment_id',
    'razorpay_signature',
])]
class FixedSeatHold extends Model
{
    use HasFactory;

    protected $casts = [
        'board_stop_id' => 'integer',
        'drop_stop_id' => 'integer',
        'seats' => 'integer',
        'amount' => 'float',
        'original_amount' => 'float',
        'discount_amount' => 'float',
        'tip_amount' => 'float',
        'coupon_assignment_id' => 'integer',
        'has_extra_luggage' => 'boolean',
        'extra_luggage_count' => 'integer',
        'luggage_surcharge_amount' => 'float',
        'expires_at' => 'datetime',
    ];

    public function routeDeparture(): BelongsTo
    {
        return $this->belongsTo(RouteDeparture::class, 'route_departure_id');
    }

    public function customer(): BelongsTo
    {
        return $this->belongsTo(User::class, 'customer_id');
    }

    public function couponAssignment(): BelongsTo
    {
        return $this->belongsTo(CouponAssignment::class, 'coupon_assignment_id');
    }

    /** The specific departure_seats this hold locks (link table rows). */
    public function heldSeats(): HasMany
    {
        return $this->hasMany(FixedSeatHoldSeat::class, 'fixed_seat_hold_id');
    }

    public function boardStop(): BelongsTo
    {
        return $this->belongsTo(RouteStop::class, 'board_stop_id');
    }

    public function dropStop(): BelongsTo
    {
        return $this->belongsTo(RouteStop::class, 'drop_stop_id');
    }
}
