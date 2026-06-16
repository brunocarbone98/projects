@public
Feature: Shipping quotes
  A visitor can price a parcel before creating a shipment.

  Scenario: Quote a 2 kg parcel from Panama to the US
    When I request a quote for a 2 kg parcel to the US
    Then the response status should be 200
    And the quote price should be positive
