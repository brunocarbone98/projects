"""Unit tests for the holiday calendar and business-day arithmetic."""

from datetime import date, datetime, timezone

from holidays import (
    add_business_days,
    is_business_day,
    is_holiday,
    panama_holidays,
    us_holidays,
)


def test_panama_holidays_fixed_dates() -> None:
    holidays = panama_holidays(2026)
    for expected in [
        date(2026, 1, 1),
        date(2026, 1, 9),
        date(2026, 11, 3),
        date(2026, 11, 4),
        date(2026, 11, 5),
        date(2026, 11, 10),
        date(2026, 11, 28),
        date(2026, 12, 8),
        date(2026, 12, 25),
    ]:
        assert expected in holidays


def test_us_holidays_include_thanksgiving_4th_thursday() -> None:
    holidays = us_holidays(2026)
    # Thanksgiving 2026 is Thursday, November 26.
    assert date(2026, 11, 26) in holidays
    assert date(2026, 1, 1) in holidays
    assert date(2026, 7, 4) in holidays
    assert date(2026, 12, 25) in holidays


def test_us_holidays_only_apply_to_us_destination() -> None:
    independence_day = date(2026, 7, 4)
    assert is_holiday(independence_day, destination_country="US") is True
    # Jul 4 is not a Panama holiday, so a LATAM destination treats it normally.
    assert is_holiday(independence_day, destination_country="CO") is False


def test_panama_holidays_always_apply() -> None:
    martyrs_day = date(2026, 1, 9)
    assert is_holiday(martyrs_day, destination_country="US") is True
    assert is_holiday(martyrs_day, destination_country="CO") is True


def test_is_business_day_excludes_weekends() -> None:
    assert is_business_day(date(2026, 6, 13), destination_country="US") is False  # Saturday
    assert is_business_day(date(2026, 6, 14), destination_country="US") is False  # Sunday
    assert is_business_day(date(2026, 6, 15), destination_country="US") is True  # Monday


def test_add_business_days_skips_weekend() -> None:
    # Friday Jun 12 + 1 business day -> Monday Jun 15 (skips Sat/Sun).
    friday = datetime(2026, 6, 12, 0, 0, 0, tzinfo=timezone.utc)
    assert add_business_days(friday, 1, destination_country="CO") == datetime(
        2026, 6, 15, 0, 0, 0, tzinfo=timezone.utc
    )


def test_add_business_days_skips_us_holiday() -> None:
    # Independence Day 2026 is Saturday Jul 4, so it is already a weekend; use
    # Christmas instead. Christmas 2026 is Friday Dec 25.
    # Start Thursday Dec 24 + 1 business day for a US shipment must skip
    # Fri Dec 25 (holiday) and the weekend, landing on Monday Dec 28.
    thursday = datetime(2026, 12, 24, 0, 0, 0, tzinfo=timezone.utc)
    assert add_business_days(thursday, 1, destination_country="US") == datetime(
        2026, 12, 28, 0, 0, 0, tzinfo=timezone.utc
    )
    # A non-US destination only skips the weekend after Christmas (Panama also
    # observes Dec 25), so it also lands on Monday Dec 28.
    assert add_business_days(thursday, 1, destination_country="CO") == datetime(
        2026, 12, 28, 0, 0, 0, tzinfo=timezone.utc
    )


def test_add_business_days_zero_is_noop() -> None:
    start = datetime(2026, 6, 15, 9, 30, 0, tzinfo=timezone.utc)
    assert add_business_days(start, 0, destination_country="US") == start


def test_add_business_days_preserves_time_of_day() -> None:
    start = datetime(2026, 6, 15, 14, 45, 30, tzinfo=timezone.utc)  # Monday
    result = add_business_days(start, 1, destination_country="CO")  # Tuesday
    assert result == datetime(2026, 6, 16, 14, 45, 30, tzinfo=timezone.utc)
