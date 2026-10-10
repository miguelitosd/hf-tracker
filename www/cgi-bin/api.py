#!/usr/bin/env python3
"""JSON API for the Healthy Foundations tracker (CGI, run by fcgiwrap).

GET  api.py?from=YYYY-MM-DD&to=YYYY-MM-DD
     -> {"metrics": [...], "settings": {...}, "entries": {"YYYY-MM-DD": {metric: value}}}
     ("prev_weight" is the latest weight recorded before "from", or null)
POST {"action": "set_entry", "day": "YYYY-MM-DD", "metric": "...", "value": number|null}
POST {"action": "set_settings", "start_day": "thursday", "goals": {"activity": 150, ...}}
     (either field may be omitted; a goal of 0 means no goal)
"""
import datetime
import json
import os
import sqlite3
import sys

DB = os.environ.get("HF_DB", "/var/hf/data/tracker.db")

# Daily rows of the tracker.  Add/rename rows here; the page builds itself from this list.
# weekly_goal is the default weekly goal (editable on the page, stored in settings as
# goal_<key>); per_day also shows it as a daily amount; note is appended to the goal text.
METRICS = [
    {"key": "activity", "label": "Physical Activity Minutes", "color": "blue",
     "weekly_goal": 150, "per_day": False, "note": ""},
    {"key": "produce", "label": "Vegetable/Fruit Servings", "color": "orange",
     "weekly_goal": 35, "per_day": True, "note": ""},
    {"key": "meal_replacements", "label": "Meal Replacements", "color": "pink",
     "weekly_goal": 7, "per_day": True, "note": "if using"},
]
DAILY_KEYS = {m["key"] for m in METRICS}
MAX_GOAL = 100000
# Once-a-week row, entered under the first day of the week.
WEIGHT = {"key": "weight", "label": "Weekly Weight", "unit": "lb"}
METRIC_KEYS = DAILY_KEYS | {WEIGHT["key"]}
DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
DEFAULT_SETTINGS = {"start_day": "thursday"}


class BadRequest(Exception):
    pass


def connect():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    db = sqlite3.connect(DB, timeout=10)
    db.execute("""CREATE TABLE IF NOT EXISTS entries (
                      day     TEXT NOT NULL,
                      metric  TEXT NOT NULL,
                      value   REAL NOT NULL,
                      updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                      PRIMARY KEY (day, metric))""")
    db.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    return db


def parse_day(s):
    try:
        return datetime.date.fromisoformat(s).isoformat()
    except (TypeError, ValueError):
        raise BadRequest(f"invalid date: {s!r}")


def get_settings(db):
    settings = dict(DEFAULT_SETTINGS)
    settings.update(db.execute("SELECT key, value FROM settings").fetchall())
    return settings


def metrics_with_goals(settings):
    """METRICS with weekly_goal replaced by the configured goal, where one is set."""
    return [dict(m, weekly_goal=float(settings.get(f"goal_{m['key']}", m["weekly_goal"])))
            for m in METRICS]


def handle_get(db, query):
    today = datetime.date.today()
    start = parse_day(query.get("from", (today - datetime.timedelta(days=6)).isoformat()))
    end = parse_day(query.get("to", today.isoformat()))
    entries = {}
    for day, metric, value in db.execute(
            "SELECT day, metric, value FROM entries WHERE day BETWEEN ? AND ?", (start, end)):
        entries.setdefault(day, {})[metric] = value
    prev = db.execute("SELECT value FROM entries WHERE metric = ? AND day < ? ORDER BY day DESC LIMIT 1",
                      (WEIGHT["key"], start)).fetchone()
    settings = get_settings(db)
    return {"metrics": metrics_with_goals(settings), "weight": WEIGHT, "days": DAYS,
            "settings": settings, "entries": entries, "prev_weight": prev[0] if prev else None}


def handle_post(db, body):
    action = body.get("action")
    if action == "set_entry":
        day = parse_day(body.get("day"))
        metric = body.get("metric")
        if metric not in METRIC_KEYS:
            raise BadRequest(f"unknown metric: {metric!r}")
        value = body.get("value")
        if value is None or value == "":
            db.execute("DELETE FROM entries WHERE day = ? AND metric = ?", (day, metric))
        else:
            try:
                value = float(value)
            except (TypeError, ValueError):
                raise BadRequest(f"invalid value: {value!r}")
            if value < 0:
                raise BadRequest("value must not be negative")
            db.execute("""INSERT INTO entries (day, metric, value) VALUES (?, ?, ?)
                          ON CONFLICT (day, metric) DO UPDATE
                          SET value = excluded.value, updated = CURRENT_TIMESTAMP""",
                       (day, metric, value))
        db.commit()
        return {"ok": True, "day": day, "metric": metric, "value": value}
    if action == "set_settings":
        updates = {}
        if "start_day" in body:
            if body["start_day"] not in DAYS:
                raise BadRequest(f"invalid start_day: {body['start_day']!r}")
            updates["start_day"] = body["start_day"]
        goals = body.get("goals")
        if goals is not None:
            if not isinstance(goals, dict):
                raise BadRequest("goals must be an object")
            for key, value in goals.items():
                if key not in DAILY_KEYS:
                    raise BadRequest(f"unknown goal: {key!r}")
                try:
                    value = float(value)
                except (TypeError, ValueError):
                    raise BadRequest(f"invalid goal for {key}: {value!r}")
                if not 0 <= value <= MAX_GOAL:
                    raise BadRequest(f"goal for {key} must be between 0 and {MAX_GOAL}")
                updates[f"goal_{key}"] = str(value)
        if not updates:
            raise BadRequest("nothing to set")
        db.executemany("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", updates.items())
        db.commit()
        settings = get_settings(db)
        return {"ok": True, "settings": settings, "metrics": metrics_with_goals(settings)}
    raise BadRequest(f"unknown action: {action!r}")


def respond(status, payload):
    sys.stdout.write(f"Status: {status}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n\r\n")
    sys.stdout.write(json.dumps(payload))


def main():
    from urllib.parse import parse_qsl
    method = os.environ.get("REQUEST_METHOD", "GET")
    try:
        db = connect()
        if method == "GET":
            respond("200 OK", handle_get(db, dict(parse_qsl(os.environ.get("QUERY_STRING", "")))))
        elif method == "POST":
            length = int(os.environ.get("CONTENT_LENGTH") or 0)
            try:
                body = json.loads(sys.stdin.read(length) or "{}")
            except json.JSONDecodeError:
                raise BadRequest("body is not valid JSON")
            respond("200 OK", handle_post(db, body))
        else:
            respond("405 Method Not Allowed", {"error": "method not allowed"})
    except BadRequest as e:
        respond("400 Bad Request", {"error": str(e)})
    except Exception as e:  # logged to var/log/fcgiwrap.log via stderr
        print(f"api.py error: {e!r}", file=sys.stderr)
        respond("500 Internal Server Error", {"error": "internal error"})


if __name__ == "__main__":
    main()
