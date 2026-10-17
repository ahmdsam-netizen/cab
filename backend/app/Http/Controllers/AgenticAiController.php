<?php

namespace App\Http\Controllers;

use App\Services\AgenticAiService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class AgenticAiController extends Controller
{
    public function __construct(
        private readonly AgenticAiService $aiService,
    ) {}

    /**
     * Check Agentic AI service status and connectivity.
     */
    public function health(): JsonResponse
    {
        $health = $this->aiService->health();
        $status = $health['online'] ? 200 : 503;

        return response()->json($health, $status);
    }

    /**
     * Conversational ride booking chat endpoint.
     */
    public function chat(Request $request): JsonResponse
    {
        $data = $request->validate([
            'message' => ['required', 'string', 'max:1000'],
            'thread_id' => ['nullable', 'string', 'max:100'],
            'user_current_lat' => ['nullable', 'numeric', 'between:-90,90'],
            'user_current_lng' => ['nullable', 'numeric', 'between:-180,180'],
            'action' => ['nullable', 'string', 'max:50'],
            'selected_departure_id' => ['nullable', 'integer'],
            'has_extra_luggage' => ['nullable', 'boolean'],
            'extra_luggage_count' => ['nullable', 'integer', 'min:0', 'max:20'],
            'selected_seat_labels' => ['nullable', 'array'],
            'selected_seat_labels.*' => ['string', 'max:10'],
        ]);

        $bearerToken = $request->bearerToken();
        $response = $this->aiService->chat($request->user(), $data, $bearerToken);

        $httpCode = 200;
        if (isset($response['stage']) && in_array($response['stage'], ['ERROR', 'SERVICE_UNAVAILABLE'], true)) {
            $httpCode = $response['stage'] === 'SERVICE_UNAVAILABLE' ? 503 : 500;
        }

        return response()->json($response, $httpCode);
    }
}
