import pytest
from tools.geocoding import haversine_distance, geocode_location, snap_to_route_stops


def test_haversine_distance():
    # Srinagar to Sopore distance is approx 40-50 km
    dist = haversine_distance(34.0837, 74.7973, 34.2988, 74.4716)
    assert 35.0 < dist < 55.0


def test_geocode_known_landmarks():
    coords = geocode_location("Take me to Sopore")
    assert coords["lat"] == 34.2988
    assert coords["lng"] == 74.4716

    coords_airport = geocode_location("I want to reach Srinagar Airport")
    assert coords_airport["lat"] == 33.9872
    assert coords_airport["lng"] == 74.7741


def test_snap_to_route_stops_ordered():
    stops = [
        {"id": 1, "name": "Batamaloo Stop", "latitude": 34.0718, "longitude": 74.7925, "sequence_number": 1},
        {"id": 2, "name": "HMT Junction", "latitude": 34.1100, "longitude": 74.7200, "sequence_number": 2},
        {"id": 3, "name": "Pattan Bus Stop", "latitude": 34.1610, "longitude": 74.5539, "sequence_number": 3},
        {"id": 4, "name": "Sopore Bus Stand", "latitude": 34.2988, "longitude": 74.4716, "sequence_number": 4},
    ]

    # User in Lal Chowk (near Batamaloo) going to Sopore
    pickup_lat, pickup_lng = 34.0722, 74.8105  # Lal Chowk
    drop_lat, drop_lng = 34.2988, 74.4716      # Sopore

    snapped = snap_to_route_stops(pickup_lat, pickup_lng, drop_lat, drop_lng, stops)
    assert snapped is not None
    board_stop, drop_stop = snapped

    # Board stop must be Batamaloo (seq 1), Drop stop must be Sopore (seq 4)
    assert board_stop["id"] == 1
    assert drop_stop["id"] == 4
    assert board_stop["sequence_number"] < drop_stop["sequence_number"]
    assert "distance_from_pickup_km" in board_stop
    assert "distance_from_drop_km" in drop_stop
