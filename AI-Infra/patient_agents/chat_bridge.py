"""JSON stdin/stdout bridge for the patient chatbot (chatbot.py), used by the web app.

Request:  {"plan": "<Going-Home Plan Markdown>", "question": "...", "history": [["question", "answer"], ...]}
Response: {"text": "...", "route": "...", "quotes": [...]}

The plan comes from the stored summary, never from a path in the request. Each request is
stateless: the browser sends the recent conversation back, and the bot keeps it only for this answer.
"""
from __future__ import annotations

import json
import sys

from .chatbot import HISTORY_TURNS, PatientChatbot
from .plan_reader import Plan, parse_medicines


def main() -> int:
    request = json.load(sys.stdin)
    if not isinstance(request, dict) or not isinstance(request.get("plan"), str) or not isinstance(request.get("question"), str):
        raise ValueError("plan and question are required")
    text = request["plan"]
    bot = PatientChatbot(Plan(text=text, medicines=parse_medicines(text)))
    history = request.get("history") or []
    bot.history = [(str(q), str(a)) for q, a in history if isinstance(q, str) and isinstance(a, str)][-HISTORY_TURNS:]
    reply = bot.ask(request["question"])
    json.dump({"text": reply.text, "route": reply.route, "quotes": reply.quotes}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    sys.exit(main())
