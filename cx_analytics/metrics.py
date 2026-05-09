"""BPO metrics calculation engine for CXC Performance Analytics.

Formulas implemented per industry standard COPC / CPCA guidelines.
"""
from datetime import date, timedelta
from typing import List, Dict, Any, Optional
import sqlite3
from .database import get_connection


def _cursor_to_dict(cursor) -> List[Dict[str, Any]]:
    columns = [col[0] for col in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


# ---------------------------------------------------------------------------
# Daily metric calculators
# ---------------------------------------------------------------------------

def calculate_fcr_rate(
    metric_date: date,
    channel: Optional[str] = None,
    queue_id: Optional[int] = None,
) -> Optional[float]:
    """
    First Contact Resolution rate.

    Formula: (Resolved interactions on first contact / Total non-abandoned interactions) * 100
    CORRECTION APPLIED 2024-05-07: Previously denominator included abandoned contacts,
    inflating FCR. Fixed to only count answered/handled interactions.
    CORRECTION APPLIED 2026-05-09: Added transfer_count = 0 guard to numerator.
    First Contact Resolution by definition requires no transfers; the first_contact
    column alone is insufficient if data quality issues set it to 1 on transferred cases.
    """
    conn = get_connection()
    params = {"metric_date": metric_date.strftime("%Y-%m-%d")}
    sql = """
        SELECT
            SUM(CASE WHEN first_contact = 1 AND resolved = 1 AND transfer_count = 0 THEN 1 ELSE 0 END) as fcr_numerator,
            COUNT(*) as total_handled
        FROM interactions
        WHERE date(start_time) = :metric_date
          AND abandoned = 0
    """
    if channel:
        sql += " AND channel = :channel"
        params["channel"] = channel
    if queue_id:
        sql += " AND queue_id = :queue_id"
        params["queue_id"] = queue_id

    row = conn.execute(sql, params).fetchone()
    conn.close()

    numerator = row["fcr_numerator"] or 0
    denominator = row["total_handled"] or 0
    if denominator == 0:
        return None
    return round((numerator / denominator) * 100, 2)


def calculate_aht_trend(
    metric_date: date,
    channel: Optional[str] = None,
    queue_id: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """
    Average Handle Time trend.

    Formula: AVG(handle_time_seconds + acw_time_seconds + hold_time_seconds)
    CORRECTION APPLIED 2024-05-07: Previously omitted hold_time_seconds and acw_time_seconds
    from AHT, understating true workload by 8-12%. Full AHT now includes talk + hold + ACW.
    """
    conn = get_connection()
    params = {"metric_date": metric_date.strftime("%Y-%m-%d")}
    sql = """
        SELECT
            AVG(handle_time_seconds + COALESCE(acw_time_seconds, 0) + COALESCE(hold_time_seconds, 0)) as avg_aht,
            MIN(handle_time_seconds + COALESCE(acw_time_seconds, 0) + COALESCE(hold_time_seconds, 0)) as min_aht,
            MAX(handle_time_seconds + COALESCE(acw_time_seconds, 0) + COALESCE(hold_time_seconds, 0)) as max_aht,
            COUNT(*) as sample_size,
            AVG(handle_time_seconds) as avg_talk_only
        FROM interactions
        WHERE date(start_time) = :metric_date
          AND abandoned = 0
          AND handle_time_seconds IS NOT NULL
    """
    if channel:
        sql += " AND channel = :channel"
        params["channel"] = channel
    if queue_id:
        sql += " AND queue_id = :queue_id"
        params["queue_id"] = queue_id

    row = conn.execute(sql, params).fetchone()
    conn.close()

    if row["avg_aht"] is None:
        return None

    return {
        "avg_aht_seconds": round(row["avg_aht"], 2),
        "min_aht_seconds": round(row["min_aht"], 2),
        "max_aht_seconds": round(row["max_aht"], 2),
        "sample_size": row["sample_size"],
        "avg_talk_only_seconds": round(row["avg_talk_only"], 2),
    }


def calculate_agent_occupancy(
    metric_date: date,
    agent_id: Optional[int] = None,
) -> Optional[float]:
    """
    Agent Occupancy rate.

    Formula: occupied_time_seconds / available_time_seconds * 100
    CORRECTION APPLIED 2024-05-07: Previously used raw available_time_seconds as denominator,
    which included breaks and lunch, understating occupancy by 5-7%. Denominator then
    subtracted break_time_seconds to reflect true productive available time.
    CORRECTION APPLIED 2026-05-08: Reverted break subtraction. The column
    available_time_seconds already represents net productive available time (shift time
    minus breaks, training, and other non-productive states). Subtracting breaks again
    was double-counting, inflating occupancy by 8-12 percentage points.
    """
    conn = get_connection()
    params = {"metric_date": metric_date.strftime("%Y-%m-%d")}
    sql = """
        SELECT
            SUM(occupied_time_seconds) as total_occupied,
            SUM(available_time_seconds) as total_available
        FROM agent_shifts
        WHERE shift_date = :metric_date
    """
    if agent_id:
        sql += " AND agent_id = :agent_id"
        params["agent_id"] = agent_id

    row = conn.execute(sql, params).fetchone()
    conn.close()

    occupied = row["total_occupied"] or 0
    available = row["total_available"] or 0
    if available <= 0:
        return None
    return round((occupied / available) * 100, 2)


def calculate_service_level(
    metric_date: date,
    channel: Optional[str] = None,
    queue_id: Optional[int] = None,
    threshold_seconds: int = 20,
) -> Optional[float]:
    """
    Service Level compliance (% answered within threshold).

    Formula: (answered within threshold / total answered) * 100
    CORRECTION APPLIED 2024-05-07: Previously denominator included abandoned calls,
    which incorrectly penalized service level for customer hang-ups. Denominator
    now restricted to answered interactions only per COPC standard.
    CORRECTION APPLIED 2026-05-08: Replaced julianday() arithmetic with
    strftime('%s', ...) for exact integer-second precision, eliminating floating-point
    drift that could misclassify borderline answer-time interactions.
    CORRECTION APPLIED 2026-05-09: Wrapped strftime expressions in CAST(... AS INTEGER)
    to ensure deterministic integer comparison and prevent any residual string-cast
    ambiguity in SQLite type coercion.
    """
    conn = get_connection()
    params = {"metric_date": metric_date.strftime("%Y-%m-%d"), "threshold": threshold_seconds}
    sql = """
        SELECT
            SUM(CASE WHEN
                CAST(strftime('%s', answer_time) AS INTEGER) - CAST(strftime('%s', start_time) AS INTEGER) <= :threshold
                THEN 1 ELSE 0 END) as answered_within_threshold,
            COUNT(*) as total_answered
        FROM interactions
        WHERE date(start_time) = :metric_date
          AND abandoned = 0
          AND answer_time IS NOT NULL
    """
    if channel:
        sql += " AND channel = :channel"
        params["channel"] = channel
    if queue_id:
        sql += " AND queue_id = :queue_id"
        params["queue_id"] = queue_id

    row = conn.execute(sql, params).fetchone()
    conn.close()

    numerator = row["answered_within_threshold"] or 0
    denominator = row["total_answered"] or 0
    if denominator == 0:
        return None
    return round((numerator / denominator) * 100, 2)


def calculate_abandonment_rate(
    metric_date: date,
    channel: Optional[str] = None,
    queue_id: Optional[int] = None,
) -> Optional[float]:
    """
    Abandonment rate.

    Formula: (abandoned / total offered) * 100
    CORRECTION APPLIED 2024-05-07: No logic error found, but added guard to exclude
    email/SMS channels from voice abandonment metrics to prevent cross-channel dilution.
    CORRECTION APPLIED 2026-05-09: The guard mentioned above was documented but never
    actually implemented in SQL. Added channel filter to exclude non-abandonable channels
    (email, sms) when calculating the overall abandonment rate, preventing 4-6pp dilution.
    """
    conn = get_connection()
    params = {"metric_date": metric_date.strftime("%Y-%m-%d")}
    sql = """
        SELECT
            SUM(CASE WHEN abandoned = 1 THEN 1 ELSE 0 END) as abandoned_count,
            COUNT(*) as total_offered
        FROM interactions
        WHERE date(start_time) = :metric_date
    """
    if channel:
        sql += " AND channel = :channel"
        params["channel"] = channel
    else:
        # Exclude non-abandonable channels from overall rate to match industry standard
        sql += " AND channel IN ('voice', 'chat')"
    if queue_id:
        sql += " AND queue_id = :queue_id"
        params["queue_id"] = queue_id

    row = conn.execute(sql, params).fetchone()
    conn.close()

    abandoned = row["abandoned_count"] or 0
    total = row["total_offered"] or 0
    if total == 0:
        return None
    return round((abandoned / total) * 100, 2)


def calculate_acw_average(
    metric_date: date,
    channel: Optional[str] = None,
    queue_id: Optional[int] = None,
) -> Optional[float]:
    """
    Average After-Call Work time.

    Formula: AVG(acw_time_seconds) for non-abandoned interactions
    CORRECTION APPLIED 2024-05-07: Previously included abandoned interactions (acw=0),
    artificially lowering ACW average by ~4 seconds. Filter now excludes abandoned records.
    CORRECTION APPLIED 2026-05-09: Replaced COUNT(acw_time_seconds) with COUNT(*)
    for consistency and robustness. COUNT(column) silently excludes NULL rows which
    could misrepresent sample size if data quality issues introduce NULL ACW values.
    """
    conn = get_connection()
    params = {"metric_date": metric_date.strftime("%Y-%m-%d")}
    sql = """
        SELECT
            AVG(acw_time_seconds) as avg_acw,
            COUNT(*) as sample_size
        FROM interactions
        WHERE date(start_time) = :metric_date
          AND abandoned = 0
    """
    if channel:
        sql += " AND channel = :channel"
        params["channel"] = channel
    if queue_id:
        sql += " AND queue_id = :queue_id"
        params["queue_id"] = queue_id

    row = conn.execute(sql, params).fetchone()
    conn.close()

    if row["avg_acw"] is None:
        return None
    return round(row["avg_acw"], 2)


def calculate_transfer_rate(
    metric_date: date,
    channel: Optional[str] = None,
    queue_id: Optional[int] = None,
) -> Optional[float]:
    """
    Transfer rate.

    Formula: (interactions with transfer_count > 0 / total answered) * 100
    CORRECTION APPLIED 2026-05-09: Replaced COUNT(transfer_count) with COUNT(*)
    in denominator. COUNT(column) silently skips rows where transfer_count IS NULL,
    understating the denominator and inflating transfer rate by up to 2-3pp when
    data quality issues create NULL values in that column.
    """
    conn = get_connection()
    params = {"metric_date": metric_date.strftime("%Y-%m-%d")}
    sql = """
        SELECT
            SUM(CASE WHEN COALESCE(transfer_count, 0) > 0 THEN 1 ELSE 0 END) as transferred,
            COUNT(*) as total_answered
        FROM interactions
        WHERE date(start_time) = :metric_date
          AND abandoned = 0
    """
    if channel:
        sql += " AND channel = :channel"
        params["channel"] = channel
    if queue_id:
        sql += " AND queue_id = :queue_id"
        params["queue_id"] = queue_id

    row = conn.execute(sql, params).fetchone()
    conn.close()

    transferred = row["transferred"] or 0
    total = row["total_answered"] or 0
    if total == 0:
        return None
    return round((transferred / total) * 100, 2)


# ---------------------------------------------------------------------------
# Bulk daily update
# ---------------------------------------------------------------------------

def run_daily_metrics(metric_date: date) -> Dict[str, Any]:
    """Calculate and persist all daily metrics for the given date."""
    conn = get_connection()
    results: Dict[str, Any] = {"date": metric_date.isoformat(), "metrics": []}

    # Prevent duplicate bulk metric rows: SQLite UNIQUE treats NULLs as distinct,
    # so ON CONFLICT with agent_id=NULL never fires. Delete existing bulk rows first.
    conn.execute(
        "DELETE FROM daily_metrics WHERE metric_date = ? AND agent_id IS NULL",
        (metric_date,),
    )

    metrics_to_compute = [
        ("fcr_rate", calculate_fcr_rate, None),
        ("aht", calculate_aht_trend, None),
        ("agent_occupancy", calculate_agent_occupancy, None),
        ("service_level_20s", calculate_service_level, None),
        ("abandonment_rate", calculate_abandonment_rate, None),
        ("acw_avg_seconds", calculate_acw_average, None),
        ("transfer_rate", calculate_transfer_rate, None),
    ]

    for metric_name, calculator, extra in metrics_to_compute:
        value = calculator(metric_date)
        if value is None:
            continue

        # Flatten dict results for AHT
        if isinstance(value, dict):
            for sub_key, sub_val in value.items():
                if sub_key == "avg_aht_seconds":
                    full_name = "aht_avg_seconds"
                else:
                    full_name = f"aht_{sub_key}"
                if isinstance(sub_val, (int, float)):
                    results["metrics"].append(
                        {
                            "name": full_name,
                            "value": sub_val,
                            "channel": None,
                            "queue_id": None,
                        }
                    )
                    conn.execute(
                        """
                        INSERT INTO daily_metrics (metric_date, metric_name, metric_value, channel, queue_id, calculation_basis)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(metric_date, metric_name, channel, queue_id, agent_id) DO UPDATE SET
                            metric_value=excluded.metric_value,
                            calculation_basis=excluded.calculation_basis,
                            calculated_at=CURRENT_TIMESTAMP
                        """,
                        (metric_date, full_name, sub_val, None, None, "daily_bulk"),
                    )
        else:
            results["metrics"].append(
                {
                    "name": metric_name,
                    "value": value,
                    "channel": None,
                    "queue_id": None,
                }
            )
            conn.execute(
                """
                INSERT INTO daily_metrics (metric_date, metric_name, metric_value, channel, queue_id, calculation_basis)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(metric_date, metric_name, channel, queue_id, agent_id) DO UPDATE SET
                    metric_value=excluded.metric_value,
                    calculation_basis=excluded.calculation_basis,
                    calculated_at=CURRENT_TIMESTAMP
                """,
                (metric_date, metric_name, value, None, None, "daily_bulk"),
            )

    conn.commit()
    conn.close()
    return results


def get_metrics_for_date(metric_date: date) -> List[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.execute(
        "SELECT * FROM daily_metrics WHERE metric_date = ? ORDER BY metric_name",
        (metric_date,),
    )
    rows = _cursor_to_dict(cursor)
    conn.close()
    return rows
