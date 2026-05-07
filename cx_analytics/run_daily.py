#!/usr/bin/env python3
"""Daily BPO metrics runner for CXC Performance Analytics.

Usage:
    python -m cx_analytics.run_daily [--date YYYY-MM-DD]
"""
import argparse
import sys
from datetime import date, timedelta

from cx_analytics.database import init_schema, seed_sample_data
from cx_analytics.metrics import run_daily_metrics, get_metrics_for_date


def main() -> int:
    parser = argparse.ArgumentParser(description="Calculate daily BPO metrics")
    parser.add_argument(
        "--date",
        type=str,
        default=date.today().isoformat(),
        help="Date to calculate metrics for (YYYY-MM-DD)",
    )
    parser.add_argument(
        "--seed",
        action="store_true",
        help="Seed sample data before calculating",
    )
    parser.add_argument(
        "--init",
        action="store_true",
        help="Initialize database schema",
    )
    args = parser.parse_args()

    if args.init:
        print("Initializing schema...")
        init_schema()

    if args.seed:
        print("Seeding sample data...")
        seed_sample_data()

    target_date = date.fromisoformat(args.date)
    # Default to yesterday if no data exists for today
    if not args.seed and target_date == date.today():
        target_date = date.today() - timedelta(days=1)

    print(f"Calculating metrics for {target_date} ...")
    results = run_daily_metrics(target_date)

    print(f"\n--- Daily Metrics Report: {target_date} ---")
    for m in results["metrics"]:
        print(f"  {m['name']:35s}: {m['value']}")

    print("\nMetrics stored successfully.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
