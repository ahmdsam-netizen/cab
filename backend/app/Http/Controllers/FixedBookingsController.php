<?php

namespace App\Http\Controllers;

use App\Models\FixedSeatHold;
use App\Models\OperatorSetting;
use App\Models\SeatReservation;
use App\Services\FixedAvailabilityService;
use App\Services\FixedBookingService;
use App\Services\FixedRefundService;
use App\Services\FixedSeatHoldService;
use App\Services\RazorpayService;
use Illuminate\Http\Request;

class FixedBookingsController extends Controller
{
    public function __construct(
        private readonly FixedBookingService $bookings,
        private readonly FixedSeatHoldService $seatHolds,
        private readonly FixedRefundService $refunds,
        private readonly FixedAvailabilityService $availability,
    ) {}

    public function index(Request $request)
    {
        $data = $request->validate([
            'page' => ['nullable', 'integer', 'min:1'],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:50'],
        ]);

        return response()->json($this->bookings->myBookings(
            $request->user(),
            (int) ($data['page'] ?? 1),
            (int) ($data['per_page'] ?? 50),
        ));
    }

    public function show(Request $request, SeatReservation $reservation)
    {
        return response()->json([
            'booking' => $this->bookings->booking($request->user(), $reservation),
        ]);
    }

    public function couponPreview(Request $request)
    {
        $data = $request->validate([
            'route_departure_id' => ['required', 'integer', 'exists:route_departures,id'],
            'board_stop_id' => ['required', 'integer', 'exists:route_stops,id'],
            'drop_stop_id' => ['required', 'integer', 'exists:route_stops,id'],
            'seats' => ['nullable', 'integer', 'min:1'],
            'has_extra_luggage' => ['nullable', 'boolean'],
            'extra_luggage_count' => ['nullable', 'integer', 'min:0', 'max:200'],
            'coupon_title' => ['required', 'string', 'max:128'],
        ]);

        return response()->json($this->seatHolds->previewCoupon($request->user(), $data));
    }

    public function storeSeatHold(Request $request)
    {
        $data = $request->validate([
            'route_departure_id' => ['required', 'integer', 'exists:route_departures,id'],
            'board_stop_id' => ['required', 'integer', 'exists:route_stops,id'],
            'drop_stop_id' => ['required', 'integer', 'exists:route_stops,id'],
            // The picker (M5) sends explicit labels; older clients still pass `seats: N`
            // and the service auto-picks (transition helper — removed in M5).
            'seats' => ['nullable', 'integer', 'min:1'],
            'seat_labels' => ['nullable', 'array', 'min:1', 'max:20'],
            'seat_labels.*' => ['string', 'max:32'],
            'has_extra_luggage' => ['nullable', 'boolean'],
            'extra_luggage_count' => ['nullable', 'integer', 'min:0', 'max:200'],
            'coupon_title' => ['nullable', 'string', 'max:128'],
            'tip_amount' => ['nullable', 'numeric', 'min:0', 'max:10000'],
            // 'cash' collects only the upfront deposit online; anything else is a
            // full online prepayment.
            'payment_method' => ['nullable', 'in:cash,razorpay'],
        ]);

        // Tipping globally off (Operator Settings → Tips): ignore any tip the
        // client sent so a stale app can't slip a tip through.
        if (! OperatorSetting::instance()->tips_enabled) {
            $data['tip_amount'] = 0;
        }

        $hold = $this->seatHolds->createHold($request->user(), $data);

        return response()->json([
            'hold' => $this->bookings->shapeSeatHold($hold->fresh('routeDeparture.route')),
            'message' => $hold->status === 'PENDING_DRIVER_APPROVAL'
                ? 'Seat request sent to driver.'
                : 'Seat hold created.',
        ], 201);
    }

    public function showSeatHold(Request $request, FixedSeatHold $fixedSeatHold)
    {
        if ($fixedSeatHold->customer_id !== $request->user()->id) {
            abort(404);
        }

        $this->availability->expireHoldIfNeeded($fixedSeatHold);

        return response()->json([
            'hold' => $this->bookings->shapeSeatHold($fixedSeatHold->fresh('routeDeparture.route')),
        ]);
    }

    public function activeHold(Request $request)
    {
        $hold = $this->seatHolds->activeHoldForCustomer($request->user());

        return response()->json([
            'hold' => $hold ? $this->bookings->shapeSeatHold($hold->fresh('routeDeparture.route')) : null,
        ]);
    }

    public function confirmSeatHoldPayment(Request $request, FixedSeatHold $fixedSeatHold, RazorpayService $razorpayService)
    {
        if ($fixedSeatHold->customer_id !== $request->user()->id) {
            abort(404);
        }

        $data = $request->validate([
            'board_stop_id' => ['required', 'integer', 'exists:route_stops,id'],
            'drop_stop_id' => ['required', 'integer', 'exists:route_stops,id'],
            'booking_channel' => ['required', 'in:advance,on_spot'],
            'razorpay_payment_id' => ['required', 'string', 'max:191'],
            'razorpay_order_id' => ['required', 'string', 'max:191'],
            'razorpay_signature' => ['required', 'string', 'max:255'],
        ]);

        $reservation = $this->seatHolds->confirmHold($request->user(), $fixedSeatHold, $data, $razorpayService);

        return response()->json([
            'reservation' => $this->bookings->shapeBooking($reservation->fresh([
                'route:id,name,scope,mode',
                'routeDeparture:id,route_id,service_date,depart_at,announced_depart_at,status',
                'boardStop:id,name,lat,lng',
                'dropStop:id,name,lat,lng',
            ])),
            'message' => 'Fixed booking confirmed.',
        ], 201);
    }


    public function createSeatHoldRazorpayOrder(Request $request, FixedSeatHold $fixedSeatHold, RazorpayService $razorpayService)
    {
        if ($fixedSeatHold->customer_id !== $request->user()->id) {
            abort(404);
        }

        $data = $request->validate(['payment_method' => ['nullable', 'in:cash,razorpay']]);
        $order = $this->seatHolds->createRazorpayOrder($request->user(), $fixedSeatHold, $razorpayService, $data['payment_method'] ?? null);

        if (($order['payment_required'] ?? true) === false) {
            return response()->json([
                'payment_required' => false,
                'reservation' => $this->bookings->shapeBooking(SeatReservation::query()->findOrFail($order['reservation_id'])),
            ]);
        }

        return response()->json([
            'hold' => $this->bookings->shapeSeatHold($fixedSeatHold->fresh('routeDeparture.route')),
            'razorpay' => $order,
        ]);
    }

    public function updateSeatHoldCoupon(Request $request, FixedSeatHold $fixedSeatHold)
    {
        $data = $request->validate(['coupon_title' => ['present', 'nullable', 'string', 'max:128']]);
        $hold = $this->seatHolds->updateCoupon($request->user(), $fixedSeatHold, $data['coupon_title']);
        return response()->json(['hold' => $this->bookings->shapeSeatHold($hold->load('routeDeparture.route'))]);
    }

    public function releaseSeatHold(Request $request, FixedSeatHold $fixedSeatHold)
    {
        if ($fixedSeatHold->customer_id !== $request->user()->id) {
            abort(404);
        }

        $this->availability->releaseHold($fixedSeatHold);

        return response()->json([
            'hold' => $this->bookings->shapeSeatHold($fixedSeatHold->fresh('routeDeparture.route')),
            'message' => 'Seat hold released.',
        ]);
    }

    public function cancel(Request $request, SeatReservation $reservation)
    {
        if ($reservation->customer_id !== $request->user()->id || $reservation->route?->mode !== 'fixed') {
            abort(404);
        }

        $result = $this->refunds->cancelByCustomer($reservation);
        $message = $result['refund_pending']
            ? 'Booking cancelled. Refund approved and pending processing.'
            : ($result['refunded'] ? 'Booking cancelled and refunded.' : 'Booking cancelled. No refund applies for this cancellation window.');

        return response()->json([
            'reservation' => $this->bookings->shapeBooking($result['reservation']),
            'message' => $message,
            'refund_status' => $result['refund_status'],
        ]);
    }

    public function rate(Request $request, SeatReservation $reservation)
    {
        if ($reservation->customer_id !== $request->user()->id) {
            abort(404);
        }

        if (!in_array(strtoupper((string) $reservation->status), ['DROPPED', 'COMPLETED'], true)) {
            return response()->json(['message' => 'You can only rate a finished ride.'], 409);
        }

        if ($reservation->rating_score !== null) {
            return response()->json(['message' => 'You have already rated this ride.'], 409);
        }

        $data = $request->validate([
            'score' => ['required', 'integer', 'min:1', 'max:5'],
            'comment' => ['nullable', 'string', 'max:2000'],
        ]);

        $score = (int) $data['score'];
        $comment = $data['comment'] ?? null;

        $reservation->loadMissing('routeDeparture');
        $driverId = $reservation->routeDeparture?->driver_id;
        if (!$driverId && $reservation->trip_id) {
            $driverId = \App\Models\Trip::query()->where('id', $reservation->trip_id)->value('driver_id');
        }

        \DB::transaction(function () use ($reservation, $score, $comment, $driverId) {
            $reservation->update([
                'rating_score' => $score,
                'rating_comment' => $comment,
            ]);

            if ($driverId) {
                \App\Models\Rating::query()->updateOrCreate(
                    [
                        'trip_id' => $reservation->trip_id,
                        'customer_id' => $reservation->customer_id,
                    ],
                    [
                        'driver_id' => $driverId,
                        'score' => $score,
                        'comment' => $comment,
                    ]
                );

                $avg = \App\Models\Rating::query()->where('driver_id', $driverId)->avg('score');
                $count = \App\Models\Rating::query()->where('driver_id', $driverId)->count();

                \App\Models\Driver::query()->where('user_id', $driverId)->update([
                    'rating_avg' => $avg ? (float) $avg : 0.0,
                    'rating_count' => (int) $count,
                ]);
            }
        });

        return response()->json([
            'booking' => $this->bookings->shapeBooking($reservation->fresh()),
            'message' => 'Thank you for your rating!',
        ]);
    }
}
