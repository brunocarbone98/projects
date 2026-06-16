@public
Feature: Public parcel tracking
  Anyone can track a parcel by its tracking number, with no account.

  Scenario: Track the seeded demo parcel
    When I track the seeded demo parcel
    Then the response status should be 200
    And the parcel timeline should not be empty

  Scenario: A malformed tracking code is rejected
    When I track a malformed code
    Then the response status should be 400
    And the error code should be "VALIDATION_ERROR"

  Scenario: An unknown tracking code is not found
    When I track the code "PTY-2026-987654-1"
    Then the response status should be 404
    And the error code should be "NOT_FOUND"
