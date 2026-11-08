<?php

namespace App\Http\Controllers;

use App\Models\SavedLocation;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Local place-search endpoint.
 *
 * Returns place suggestions by fuzzy-matching the query against the global
 * pool of saved_locations rows (label + address).  This powers the autocomplete
 * in the booking flow when the Google Places API is unavailable, restricted, or
 * returns no results for a query.
 *
 * The endpoint is **public** (no auth required) so the booking screen can call it
 * before the user logs in, and so it can be used as a lightweight offline fallback
 * during local development.
 *
 * Response shape mirrors the PlaceSuggestion type in the frontend:
 *   {
 *     data: [
 *       {
 *         place_id: "local:123",
 *         description: "Hazratbal Shrine, Hazratbal, Srinagar, J&K 190006",
 *         main_text: "Hazratbal Shrine",
 *         secondary_text: "Hazratbal, Srinagar, J&K 190006",
 *         lat: 34.1211,
 *         lng: 74.8323
 *       }
 *     ]
 *   }
 *
 * GET /api/places/search?q=hazratbal&lat=34.0837&lng=74.7973&limit=8
 */
class PlacesSearchController extends Controller
{
    private const DEFAULT_LIMIT = 8;
    private const MAX_LIMIT     = 20;

    public function search(Request $request): JsonResponse
    {
        $q     = trim((string) $request->query('q', ''));
        $limit = min((int) $request->query('limit', self::DEFAULT_LIMIT), self::MAX_LIMIT);

        // Need at least 2 chars to search.
        if (mb_strlen($q) < 2) {
            return response()->json(['data' => []]);
        }

        // Fuzzy match on label OR address (case-insensitive via LIKE).
        // We deliberately search ALL saved_locations (not scoped to a user) so
        // operator-seeded landmarks are always discoverable.
        $rows = SavedLocation::query()
            ->where(function ($query) use ($q) {
                $query->where('label',   'like', "%{$q}%")
                      ->orWhere('address', 'like', "%{$q}%");
            })
            ->orderByRaw('
                CASE
                    WHEN LOWER(label)   LIKE LOWER(?) THEN 0
                    WHEN LOWER(address) LIKE LOWER(?) THEN 1
                    ELSE 2
                END
            ', ["{$q}%", "{$q}%"])
            ->limit(self::MAX_LIMIT)
            ->get(['id', 'label', 'address', 'lat', 'lng']);

        $seen = [];
        $unique = [];
        foreach ($rows as $row) {
            $key = strtolower(trim($row->address));
            if (!isset($seen[$key])) {
                $seen[$key] = true;
                $unique[] = $row;
            }
            if (count($unique) >= $limit) {
                break;
            }
        }

        $data = collect($unique)->map(function (SavedLocation $row) {
            // The address field holds the full readable address
            // (e.g. "Hazratbal Shrine, Hazratbal, Srinagar, J&K 190006").
            // Split at the first comma: everything before is the place name,
            // everything after is the secondary context line.
            $parts     = explode(',', $row->address, 2);
            $mainText  = trim($parts[0]);
            $secondary = isset($parts[1]) ? trim($parts[1]) : '';

            return [
                'place_id'       => 'local:' . $row->id,
                'description'    => $row->address,
                'main_text'      => $mainText,
                'secondary_text' => $secondary,
                'lat'            => (float) $row->lat,
                'lng'            => (float) $row->lng,
            ];
        });

        return response()->json(['data' => $data]);
    }
}
