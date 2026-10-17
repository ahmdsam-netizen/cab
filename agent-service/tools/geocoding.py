import math
from typing import Dict, List, Optional, Tuple, Any


def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate the great circle distance between two points in kilometers."""
    r = 6371.0  # Earth's radius in kilometers
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return r * c


# Known landmark coordinate dictionary for instant offline resolution
LANDMARKS: Dict[str, Tuple[float, float]] = {
    "srinagar": (34.0837, 74.7973),
    "lal chowk": (34.0722, 74.8105),
    "batamaloo": (34.0718, 74.7925),
    "sopore": (34.2988, 74.4716),
    "baramulla": (34.2088, 74.3436),
    "kupwara": (34.5262, 74.2546),
    "srinagar airport": (33.9872, 74.7741),
    "airport": (33.9872, 74.7741),
    "dal lake": (34.1167, 74.8667),
    "dargah": (34.1293, 74.8398),
    "pattan": (34.1610, 74.5539),
    "handwara": (34.4000, 74.2800),
}


def geocode_location(text: str, fallback_lat: Optional[float] = None, fallback_lng: Optional[float] = None) -> Dict[str, float]:
    """
    Resolve natural language location name to latitude and longitude.
    Uses known regional landmarks or fallback.
    """
    if not text:
        return {"lat": fallback_lat or 34.0837, "lng": fallback_lng or 74.7973}

    normalized = text.lower().strip()
    # Sort by key length descending so "srinagar airport" matches before "srinagar"
    sorted_landmarks = sorted(LANDMARKS.items(), key=lambda item: len(item[0]), reverse=True)
    for name, coords in sorted_landmarks:
        if name in normalized:
            return {"lat": coords[0], "lng": coords[1]}

    # If already formatted as lat,lng
    if "," in normalized:
        parts = normalized.split(",")
        try:
            return {"lat": float(parts[0].strip()), "lng": float(parts[1].strip())}
        except ValueError:
            pass

    return {"lat": fallback_lat or 34.0837, "lng": fallback_lng or 74.7973}


def snap_to_route_stops(
    pickup_lat: float,
    pickup_lng: float,
    drop_lat: float,
    drop_lng: float,
    stops: List[Dict[str, Any]]
) -> Optional[Tuple[Dict[str, Any], Dict[str, Any]]]:
    """
    Given pickup & drop coordinates and a list of route stops (ordered by sequence_number),
    find the optimal (board_stop, drop_stop) pair where sequence(board) < sequence(drop).
    Returns (board_stop, drop_stop) or None if not viable.
    """
    if len(stops) < 2:
        return None

    # Sort stops by sequence
    sorted_stops = sorted(stops, key=lambda s: int(s.get("sequence_number") or s.get("sequence") or 0))

    best_pair = None
    min_combined_dist = float("inf")

    for i in range(len(sorted_stops)):
        board_candidate = sorted_stops[i]
        b_lat = float(board_candidate.get("latitude") or board_candidate.get("lat") or 0.0)
        b_lng = float(board_candidate.get("longitude") or board_candidate.get("lng") or 0.0)
        dist_pickup_to_board = haversine_distance(pickup_lat, pickup_lng, b_lat, b_lng)

        for j in range(i + 1, len(sorted_stops)):
            drop_candidate = sorted_stops[j]
            d_lat = float(drop_candidate.get("latitude") or drop_candidate.get("lat") or 0.0)
            d_lng = float(drop_candidate.get("longitude") or drop_candidate.get("lng") or 0.0)
            dist_drop_to_dest = haversine_distance(drop_lat, drop_lng, d_lat, d_lng)

            combined_dist = dist_pickup_to_board + dist_drop_to_dest
            if combined_dist < min_combined_dist:
                min_combined_dist = combined_dist
                b_with_dist = dict(board_candidate)
                b_with_dist["distance_from_pickup_km"] = round(dist_pickup_to_board, 2)
                d_with_dist = dict(drop_candidate)
                d_with_dist["distance_from_drop_km"] = round(dist_drop_to_dest, 2)
                best_pair = (b_with_dist, d_with_dist)

    return best_pair
