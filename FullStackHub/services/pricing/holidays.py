"""Public-holiday calendar and business-day arithmetic.

Pure helpers with no FastAPI or I/O dependencies so they can be unit-tested in
isolation. All dates are handled in UTC.

The platform always observes Panama public holidays (the origin is Panama). When
the destination is the United States, US federal holidays are observed as well,
because the parcel is cleared and delivered there.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone


def _nth_weekday_of_month(year: int, month: int, weekday: int, n: int) -> date:
    """Return the date of the ``n``-th ``weekday`` in ``month``/``year``.

    ``weekday`` follows :meth:`date.weekday` (Monday=0 ... Sunday=6).
    """
    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    day = 1 + offset + (n - 1) * 7
    return date(year, month, day)


def panama_holidays(year: int) -> set[date]:
    """Panama public holidays observed by the hub for the given year.

    Fixed-date national holidays: New Year (Jan 1), Martyrs' Day (Jan 9),
    the November patriotic season (Nov 3, 4, 5, 10, 28), Mother's Day (Dec 8)
    and Christmas (Dec 25).
    """
    return {
        date(year, 1, 1),
        date(year, 1, 9),
        date(year, 11, 3),
        date(year, 11, 4),
        date(year, 11, 5),
        date(year, 11, 10),
        date(year, 11, 28),
        date(year, 12, 8),
        date(year, 12, 25),
    }


def us_holidays(year: int) -> set[date]:
    """US federal holidays relevant to delivery for the given year.

    A pragmatic subset: New Year (Jan 1), Independence Day (Jul 4),
    Thanksgiving (4th Thursday of November) and Christmas (Dec 25).
    """
    return {
        date(year, 1, 1),
        date(year, 7, 4),
        _nth_weekday_of_month(year, 11, weekday=3, n=4),  # Thursday = 3
        date(year, 12, 25),
    }


def is_holiday(day: date, *, destination_country: str) -> bool:
    """Whether ``day`` is a non-working public holiday for this shipment.

    Panama holidays always apply; US holidays apply only when the destination
    country is the United States. Holidays are resolved using the year of the
    candidate date so multi-year ETA windows stay correct.
    """
    if day in panama_holidays(day.year):
        return True
    if destination_country.upper() == "US" and day in us_holidays(day.year):
        return True
    return False


def is_business_day(day: date, *, destination_country: str) -> bool:
    """A business day is a weekday that is not a public holiday."""
    if day.weekday() >= 5:  # Saturday (5) or Sunday (6)
        return False
    return not is_holiday(day, destination_country=destination_country)


def add_business_days(start: datetime, days: int, *, destination_country: str) -> datetime:
    """Add ``days`` business days to ``start``, skipping weekends and holidays.

    The time-of-day component of ``start`` is preserved; only the calendar date
    advances. ``days`` is expected to be non-negative; a value of ``0`` returns
    ``start`` unchanged.
    """
    result = start
    remaining = days
    while remaining > 0:
        result = result + timedelta(days=1)
        if is_business_day(result.date(), destination_country=destination_country):
            remaining -= 1
    return result


def utc_now() -> datetime:
    """Current time as a timezone-aware UTC datetime (injectable for tests)."""
    return datetime.now(timezone.utc)
