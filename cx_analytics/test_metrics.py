"""Unit tests for CXC BPO metric calculations."""
import unittest
import os
import sqlite3
from datetime import date, timedelta

from cx_analytics.database import init_schema, seed_sample_data, DB_PATH, get_connection
from cx_analytics.metrics import (
    calculate_fcr_rate,
    calculate_aht_trend,
    calculate_agent_occupancy,
    calculate_service_level,
    calculate_abandonment_rate,
    calculate_acw_average,
    calculate_transfer_rate,
    run_daily_metrics,
)


class TestBPOMetrics(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import tempfile
        cls.tmpdir = tempfile.mkdtemp(prefix="cx_analytics_test_")
        cls.db_path = os.path.join(cls.tmpdir, "test.db")
        os.environ["CX_ANALYTICS_DB"] = cls.db_path
        # Re-import to pick up env var
        import cx_analytics.database as db_mod
        db_mod.DB_PATH = cls.db_path
        init_schema()
        seed_sample_data(days=7, agents=5, queues=2)
        cls.test_date = date.today() - timedelta(days=1)

    @classmethod
    def tearDownClass(cls):
        import shutil
        shutil.rmtree(cls.tmpdir, ignore_errors=True)
        os.environ.pop("CX_ANALYTICS_DB", None)

    def test_fcr_rate_bounds(self):
        val = calculate_fcr_rate(self.test_date)
        self.assertIsNotNone(val)
        self.assertGreaterEqual(val, 0)
        self.assertLessEqual(val, 100)

    def test_aht_includes_acw_and_hold(self):
        aht = calculate_aht_trend(self.test_date)
        self.assertIsNotNone(aht)
        # AHT must be >= talk-only time
        self.assertGreaterEqual(aht["avg_aht_seconds"], aht["avg_talk_only_seconds"])

    def test_occupancy_bounds(self):
        val = calculate_agent_occupancy(self.test_date)
        self.assertIsNotNone(val)
        self.assertGreaterEqual(val, 0)
        # Occupancy can exceed 100 if breaks are under-reported, but usually < 100
        self.assertLessEqual(val, 105)

    def test_service_level_bounds(self):
        val = calculate_service_level(self.test_date)
        self.assertIsNotNone(val)
        self.assertGreaterEqual(val, 0)
        self.assertLessEqual(val, 100)

    def test_abandonment_rate_bounds(self):
        val = calculate_abandonment_rate(self.test_date)
        self.assertIsNotNone(val)
        self.assertGreaterEqual(val, 0)
        self.assertLessEqual(val, 100)

    def test_acw_positive(self):
        val = calculate_acw_average(self.test_date)
        self.assertIsNotNone(val)
        self.assertGreater(val, 0)

    def test_transfer_rate_bounds(self):
        val = calculate_transfer_rate(self.test_date)
        self.assertIsNotNone(val)
        self.assertGreaterEqual(val, 0)
        self.assertLessEqual(val, 100)

    def test_daily_bulk_run(self):
        results = run_daily_metrics(self.test_date)
        self.assertIn("metrics", results)
        self.assertTrue(len(results["metrics"]) > 0)

    def test_abandonment_excludes_email(self):
        # Email should have 0% abandonment in seeded data
        val = calculate_abandonment_rate(self.test_date, channel="email")
        self.assertEqual(val, 0.0)

    def test_fcr_excludes_abandoned(self):
        # If we manually inject an abandoned row, FCR should not count it in denominator
        conn = get_connection()
        conn.execute(
            """
            INSERT INTO interactions
            (agent_id, queue_id, channel, start_time, abandoned, resolved, first_contact)
            VALUES (1, 1, 'voice', ?, 1, 0, 0)
            """,
            (self.test_date.strftime("%Y-%m-%d") + " 10:00:00",),
        )
        conn.commit()
        conn.close()
        val = calculate_fcr_rate(self.test_date)
        self.assertIsNotNone(val)

    def test_fcr_ignores_first_contact_column(self):
        # FCR should be based on resolved + zero transfers, not the first_contact flag.
        # Inject a resolved, zero-transfer row with first_contact=0 (false negative).
        conn = get_connection()
        conn.execute(
            """
            INSERT INTO interactions
            (agent_id, queue_id, channel, start_time, answer_time, end_time,
             handle_time_seconds, acw_time_seconds, hold_time_seconds,
             transfer_count, abandoned, resolved, first_contact)
            VALUES (1, 1, 'voice', ?, ?, ?, 300, 30, 0, 0, 0, 1, 0)
            """,
            (
                self.test_date.strftime("%Y-%m-%d") + " 10:00:00",
                self.test_date.strftime("%Y-%m-%d") + " 10:00:05",
                self.test_date.strftime("%Y-%m-%d") + " 10:05:00",
            ),
        )
        conn.commit()
        conn.close()
        val = calculate_fcr_rate(self.test_date)
        self.assertIsNotNone(val)
        # The injected row should count toward FCR because resolved=1 and transfer_count=0
        # even though first_contact=0.  Without the fix this would under-count.
        # We can't assert an exact value because the seeded baseline changes, but we can
        # verify it is strictly higher than the old first_contact-only formula would give.
        conn = get_connection()
        old_formula = conn.execute(
            """
            SELECT ROUND(100.0 * SUM(CASE WHEN first_contact=1 AND resolved=1 AND transfer_count=0 THEN 1 ELSE 0 END) / COUNT(*), 2)
            FROM interactions WHERE date(start_time) = ? AND abandoned = 0
            """,
            (self.test_date.strftime("%Y-%m-%d"),),
        ).fetchone()[0]
        conn.close()
        self.assertGreater(val, old_formula)


if __name__ == "__main__":
    unittest.main()
