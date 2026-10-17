from langgraph.graph import StateGraph, END
from langgraph.checkpoint.memory import MemorySaver
from models.state import BookingAgentState
from graph.nodes import (
    node_collect_input,
    node_match_route_and_stations,
    node_fetch_departures,
    node_present_options,
    node_create_hold,
    node_handle_driver_rejection,
    node_handle_driver_acceptance,
)


def route_after_input(state: BookingAgentState) -> str:
    if state.get("stage") == "COLLECTING":
        return END
    return "match_route"


def route_after_matching(state: BookingAgentState) -> str:
    if state.get("stage") == "EXHAUSTED":
        return END
    return "fetch_departures"


def route_after_departures(state: BookingAgentState) -> str:
    if state.get("stage") == "EXHAUSTED":
        return END
    return "present_options"


def build_booking_graph(checkpointer=None):
    workflow = StateGraph(BookingAgentState)

    # Add all nodes
    workflow.add_node("collect_input", node_collect_input)
    workflow.add_node("match_route", node_match_route_and_stations)
    workflow.add_node("fetch_departures", node_fetch_departures)
    workflow.add_node("present_options", node_present_options)
    workflow.add_node("create_hold", node_create_hold)
    workflow.add_node("driver_rejection", node_handle_driver_rejection)
    workflow.add_node("driver_acceptance", node_handle_driver_acceptance)

    # Set entry point
    workflow.set_entry_point("collect_input")

    # Connect edges
    workflow.add_conditional_edges("collect_input", route_after_input, {
        "match_route": "match_route",
        END: END,
    })
    workflow.add_conditional_edges("match_route", route_after_matching, {
        "fetch_departures": "fetch_departures",
        END: END,
    })
    workflow.add_conditional_edges("fetch_departures", route_after_departures, {
        "present_options": "present_options",
        END: END,
    })

    workflow.add_edge("present_options", END)
    workflow.add_edge("create_hold", END)
    workflow.add_edge("driver_rejection", END)
    workflow.add_edge("driver_acceptance", END)

    saver = checkpointer or MemorySaver()
    return workflow.compile(checkpointer=saver)


booking_graph = build_booking_graph()
