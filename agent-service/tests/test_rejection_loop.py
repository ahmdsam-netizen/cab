import pytest
from langchain_core.messages import HumanMessage
from graph.workflow import build_booking_graph
from graph.nodes import node_create_hold, node_handle_driver_rejection, node_handle_driver_acceptance
from langgraph.checkpoint.memory import MemorySaver


@pytest.mark.asyncio
async def test_full_rejection_and_acceptance_loop():
    # Setup graph with fresh memory checkpointer
    memory = MemorySaver()
    graph = build_booking_graph(checkpointer=memory)
    thread_id = "test-session-user-123"
    config = {"configurable": {"thread_id": thread_id}}

    # 1. User sends message wanting to travel from Batamaloo to Sopore with 2 bags
    init_state = {
        "messages": [HumanMessage(content="I want to book a fixed ride to Sopore from Batamaloo with 2 bags")],
        "auth_token": "mock-sanctum-token",
        "user_current_lat": 34.0718,
        "user_current_lng": 74.7925,
    }

    res = await graph.ainvoke(init_state, config=config)
    
    # Assert route was found, luggage captured, and available seats presented
    assert res["stage"] == "CONFIRMING_DEPARTURE"
    assert res["matched_route"] is not None
    assert res["has_extra_luggage"] is True
    assert res["extra_luggage_count"] == 2
    assert len(res["available_seat_labels"]) >= 1
    assert "1A" in res["available_seat_labels"][0]
    assert len(res["remaining_departures"]) == 3
    first_departure = res["current_departure"]
    assert first_departure["id"] == 501

    # 2. User confirms the first departure (501) with explicit seat preference 2A
    state = graph.get_state(config).values
    state["selected_seat_labels"] = ["2A"]
    hold_result = await node_create_hold(state)
    assert hold_result["stage"] == "AWAITING_DRIVER"
    assert hold_result["seat_hold_id"] is not None
    assert hold_result["selected_seat_labels"] == ["2A"]
    assert "Seat 2A" in hold_result["messages"][-1].content
    assert "2 extra bag(s)" in hold_result["messages"][-1].content
    assert hold_result["driver_status"] == "PENDING_APPROVAL"
    graph.update_state(config, hold_result)

    # 3. Driver of 501 REJECTS the request
    state_after_hold = graph.get_state(config).values
    reject_result = await node_handle_driver_rejection(state_after_hold)

    # Assert 501 is removed and 502 is now presented with its available seats
    assert reject_result["stage"] == "CONFIRMING_DEPARTURE"
    remaining_ids = [d["id"] for d in reject_result["remaining_departures"]]
    assert 501 not in remaining_ids
    assert 502 in remaining_ids
    assert reject_result["current_departure"]["id"] == 502
    assert len(reject_result["available_seat_labels"]) >= 1
    graph.update_state(config, reject_result)

    # 4. User confirms the second departure (502)
    state_after_reject = graph.get_state(config).values
    hold_result_2 = await node_create_hold(state_after_reject)
    assert hold_result_2["stage"] == "AWAITING_DRIVER"
    graph.update_state(config, hold_result_2)

    # 5. Driver of 502 ACCEPTS the request
    state_after_hold_2 = graph.get_state(config).values
    accept_result = await node_handle_driver_acceptance(state_after_hold_2)

    # Assert booking is confirmed and payment order generated
    assert accept_result["stage"] == "ACCEPTED_PAYMENT"
    assert accept_result["driver_status"] == "ACCEPTED"
    assert accept_result["payment_order"] is not None
    assert "order_id" in accept_result["payment_order"]
    assert "JK01-CD-5678" in accept_result["messages"][-1].content  # Confirms vehicle 502 (Bolero)
