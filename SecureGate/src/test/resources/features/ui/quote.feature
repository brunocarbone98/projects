@ui @public
Feature: Quote calculator through the web UI
  A visitor can price a parcel from the public quote calculator.

  Scenario: Calculating a quote shows a price
    Given Quincy is on the quote page
    When he calculates a quote with the default values
    Then he sees a price
