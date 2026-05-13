"""Database connection and seed utilities for CXC Analytics."""
import sqlite3
import os
from datetime import datetime, timedelta
import random

DB_PATH = os.environ.get("CX_ANALYTICS_DB", os.path.join(os.path.dirname(__file__), "cx_analytics.db"))


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_schema() -> None:
    conn = get_connection()
    with open(os.path.join(os.path.dirname(__file__), "schema.sql"), "r") as f:
        conn.executescript(f.read())
    conn.commit()
    conn.close()


def seed_sample_data(days: int = 30, agents: int = 15, queues: int = 4, append: bool = False) -> None:
    """Generate realistic sample interaction data for the past N days."""
    conn = get_connection()
    cursor = conn.cursor()

    # Check if data already exists
    cursor.execute("SELECT COUNT(*) FROM interactions")
    if cursor.fetchone()[0] > 0 and not append:
        conn.close()
        return

    now = datetime.now()
    channels = ["voice", "email", "chat", "sms"]
    channel_weights = [0.50, 0.20, 0.25, 0.05]

    for day_offset in range(days, 0, -1):
        day = now - timedelta(days=day_offset)
        day_date = day.date()

        # Skip dates that already have interactions when appending
        if append:
            cursor.execute("SELECT COUNT(*) FROM interactions WHERE date(start_time) = ?", (day_date,))
            if cursor.fetchone()[0] > 0:
                continue

        daily_volume = random.randint(800, 1200)

        for _ in range(daily_volume):
            agent_id = random.randint(1, agents)
            queue_id = random.randint(1, queues)
            channel = random.choices(channels, weights=channel_weights)[0]

            start_hour = random.randint(8, 21)
            start_minute = random.randint(0, 59)
            start_second = random.randint(0, 59)
            start_time = day.replace(hour=start_hour, minute=start_minute, second=start_second)

            # Voice has higher abandon rate, email never abandons
            if channel == "voice":
                abandoned = 1 if random.random() < 0.06 else 0
                answer_delay = random.randint(5, 45) if not abandoned else None
            elif channel == "chat":
                abandoned = 1 if random.random() < 0.04 else 0
                answer_delay = random.randint(10, 60) if not abandoned else None
            else:
                abandoned = 0
                answer_delay = random.randint(30, 300)

            if abandoned:
                end_time = start_time + timedelta(seconds=random.randint(20, 120))
                handle_time = None
                acw = 0
                transfer_count = 0
                resolved = 0
                first_contact = 0
            else:
                answer_time = start_time + timedelta(seconds=answer_delay)
                if channel == "voice":
                    handle_time = random.randint(120, 900)
                elif channel == "chat":
                    handle_time = random.randint(300, 1800)
                elif channel == "email":
                    handle_time = random.randint(600, 3600)
                else:
                    handle_time = random.randint(180, 600)

                end_time = answer_time + timedelta(seconds=handle_time)
                acw = random.randint(30, 120) if channel == "voice" else random.randint(10, 60)
                transfer_count = 1 if random.random() < 0.12 else 0
                resolved = 1 if random.random() < 0.82 else 0
                first_contact = 1 if (resolved and transfer_count == 0 and random.random() < 0.75) else 0

            # Realistic service-level targets per channel (seconds)
            sl_target = {"voice": 20, "chat": 60, "email": 14400, "sms": 300}[channel]

            cursor.execute(
                """
                INSERT INTO interactions
                (agent_id, queue_id, channel, start_time, answer_time, end_time,
                 handle_time_seconds, acw_time_seconds, hold_time_seconds,
                 transfer_count, abandoned, resolved, first_contact, service_level_target)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    agent_id, queue_id, channel, start_time,
                    answer_time if not abandoned else None,
                    end_time,
                    handle_time if not abandoned else None,
                    acw,
                    random.randint(0, 60),
                    transfer_count,
                    abandoned,
                    resolved,
                    first_contact,
                    sl_target,
                ),
            )

        # Seed agent shifts
        for agent_id in range(1, agents + 1):
            login = day.replace(hour=8, minute=0, second=0)
            logout = day.replace(hour=17, minute=0, second=0)
            scheduled = 8.0
            available = random.randint(25200, 28800)  # 7-8 hours in seconds
            occupied = int(available * random.uniform(0.72, 0.88))
            breaks = random.randint(1800, 3600)
            cursor.execute(
                """
                INSERT INTO agent_shifts
                (agent_id, shift_date, login_time, logout_time, scheduled_hours,
                 available_time_seconds, occupied_time_seconds, break_time_seconds)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT DO NOTHING
                """,
                (agent_id, day_date, login, logout, scheduled, available, occupied, breaks),
            )

    conn.commit()
    conn.close()
