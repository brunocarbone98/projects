@ui @public
Feature: Public parcel tracking through the web UI
  Anyone can track a parcel from the landing page, with no account.

  Scenario: A visitor tracks the demo parcel from the landing page
    Given Tracy is on the Shipping Hub landing page
    When she tracks the seeded demo parcel
    Then she sees the tracking timeline for that parcel

  Scenario: An unknown code shows the not-found view
    Given Tracy opens the tracking page for an unknown code
    Then she sees the not-found view
